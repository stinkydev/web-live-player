/**
 * Live Video Player
 * 
 * Main player class that orchestrates stream sources, decoders, and frame scheduling.
 */

import type { IStreamSource, StreamDataEvent } from '../sources/stream-source';
import type { PreferredDecoder } from '../types';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';
import { WasmDecoder, YUVFrame } from '../decoders/wasm-decoder';
import { FrameScheduler, LatencyStats } from '../scheduling/frame-scheduler';
import { codecDataChanged, rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase } from '../protocol/codec-utils';
import { LiveAudioPlayer } from '../audio/live-audio-player';
import { BasePlayer } from './base-player';
import { FrameType, IMediaCodecData, ParsedFrame, sesame } from '@stinkycomputing/sesame-api-client';

/**
 * Player configuration
 */
export interface PlayerConfig {
  preferredDecoder?: PreferredDecoder;
  /** Buffer delay in milliseconds (default: 100ms) */
  bufferDelayMs?: number;
  enableAudio?: boolean;
  /** External AudioContext to use for audio playback. If provided, the player will not create or close it. */
  audioContext?: AudioContext;
  /** Video track name for MoQ streams (default: 'video'). Set to null to accept video from any track. */
  videoTrackName?: string | null;
  /** Audio track name for MoQ streams (default: 'audio'). Set to null to accept audio from any track. */
  audioTrackName?: string | null;
  debugLogging?: boolean;
}

/**
 * Player state
 */
export type PlayerState = 'idle' | 'playing' | 'paused' | 'error';

/**
 * Bandwidth statistics
 */
export interface BandwidthStats {
  videoBytesPerSecond: number;
  audioBytesPerSecond: number;
  totalBytesPerSecond: number;
}

/**
 * Player statistics
 */
export interface PlayerStats {
  bufferSize: number;
  bufferMs: number;
  avgBufferMs: number;
  targetBufferMs: number;
  droppedFrames: number;
  totalFrames: number;
  decoderState: string;
  streamWidth: number;
  streamHeight: number;
  frameRate: number;
  latency: LatencyStats | null;
  bandwidth: BandwidthStats | null;
}

/**
 * Player event types
 */
type PlayerEventMap = {
  'frame': (frame: VideoFrame) => void;
  'statechange': (state: PlayerState) => void;
  'error': (error: Error) => void;
  'metadata': (metadata: { width: number; height: number; codec: string }) => void;
};

/**
 * Factory function to create a player instance
 */
export function createPlayer(config: PlayerConfig = {}): LiveVideoPlayer {
  return new LiveVideoPlayer(config);
}

/**
 * Live Video Player - Main class
 */
export class LiveVideoPlayer extends BasePlayer<PlayerState> {
  private config: PlayerConfig;
  
  // Stream source
  private streamSource: IStreamSource | null = null;
  private trackFilter: string | null = null;
  private boundDataHandler: ((event: StreamDataEvent) => void) | null = null;
  
  // Decoder
  private decoder: WebCodecsDecoder | WasmDecoder | null = null;
  private currentCodecData: IMediaCodecData | undefined;
  /** Timebase of the current codec data, cached to keep the decode path allocation-free */
  private currentTimebase: Timebase = MICROSECOND_TIMEBASE;
  private useWasmDecoder: boolean = false;
  private waitingForKeyframe: boolean = true;
  private lastWaitingForKeyframeLog: number = 0;
  private lastKeyframeRequest: number = 0;
  private statusLogCounter: number = 0;
  private isConfiguring: boolean = false;
  private pendingDuringConfig: ParsedFrame[] = [];  // Queue frames during configuration
  
  // Frame scheduling
  private frameScheduler: FrameScheduler<VideoFrame>;
  private lastVideoFrame: VideoFrame | null = null;
  /** Reused I420 staging buffer for the WASM decoder path */
  private yuvScratch: Uint8Array | null = null;
  private consecutiveDrops: number = 0;
  private totalDrops: number = 0;
  private lastDropLogTime: number = 0;
  
  // Metadata
  private streamWidth: number = 0;
  private streamHeight: number = 0;
  private estimatedFrameRate: number = 30; // Default, will be estimated from timestamps
  
  // FPS estimation from video timestamps
  private lastVideoTimestampUs: number = -1;
  private static readonly FPS_SAMPLE_COUNT = 10;  // Number of samples for averaging
  private fpsSamples = new Float64Array(LiveVideoPlayer.FPS_SAMPLE_COUNT);  // Recent frame duration samples
  private fpsSampleWrite: number = 0;
  private fpsSampleCount: number = 0;
  private fpsSampleSum: number = 0;
  
  // Audio
  private audioContext: AudioContext | null = null;
  private audioPlayer: LiveAudioPlayer | null = null;
  private ownsAudioContext: boolean = false;
  private audioCodecData: IMediaCodecData | null = null;
  private volume: number = 1;
  
  // Timing tracking: fixed ring of recent packets, keyed by frame timestamp.
  // Parallel typed arrays so recording a packet allocates nothing.
  private static readonly TIMING_RING_SIZE = 128;
  private timingTimestamps = new Float64Array(LiveVideoPlayer.TIMING_RING_SIZE);
  private timingArrivals = new Float64Array(LiveVideoPlayer.TIMING_RING_SIZE);
  private timingKeyframes = new Uint8Array(LiveVideoPlayer.TIMING_RING_SIZE);
  private timingWrite: number = 0;
  private timingCount: number = 0;
  
  // Bandwidth tracking
  private videoBytesReceived: number = 0;
  private audioBytesReceived: number = 0;
  private lastBandwidthUpdateTime: number = 0;
  private lastVideoBytesReceived: number = 0;
  private lastAudioBytesReceived: number = 0;
  private currentBandwidth: BandwidthStats = {
    videoBytesPerSecond: 0,
    audioBytesPerSecond: 0,
    totalBytesPerSecond: 0,
  };
  
  constructor(config: PlayerConfig = {}) {
    super('idle', config.debugLogging ?? false);
    
    this.config = {
      preferredDecoder: config.preferredDecoder ?? 'webcodecs-sw',
      bufferDelayMs: config.bufferDelayMs ?? 100,
      enableAudio: config.enableAudio ?? true,
      videoTrackName: config.videoTrackName === undefined ? 'video' : config.videoTrackName,
      audioTrackName: config.audioTrackName === undefined ? 'audio' : config.audioTrackName,
      debugLogging: config.debugLogging ?? false,
    };
    
    // Initialize audio context if enabled
    if (this.config.enableAudio) {
      if (config.audioContext) {
        this.audioContext = config.audioContext;
        this.ownsAudioContext = false;
      } else {
        this.audioContext = new AudioContext();
        this.ownsAudioContext = true;
      }
    }
    
    // Initialize frame scheduler
    this.frameScheduler = new FrameScheduler<VideoFrame>({
      bufferDelayMs: this.config.bufferDelayMs,
      logger: (msg) => {
        // Check debugLogging dynamically so it respects runtime changes
        if (this.config.debugLogging) {
          this.logger.info(msg);
        }
      },
      onFrameDropped: (frame, reason) => {
        this.totalDrops++;
        this.consecutiveDrops++;
        
        // Only log drops if debug logging is enabled
        if (this.config.debugLogging) {
          const now = Date.now();
          // Log every drop or batch them if many in quick succession
          if (now - this.lastDropLogTime > 500 || this.consecutiveDrops === 1) {
            if (this.consecutiveDrops > 1) {
              this.logger.warn(`Dropped ${this.consecutiveDrops} frames (${reason}), total=${this.totalDrops}`);
            } else {
              this.logger.warn(`Frame dropped (${reason}), total=${this.totalDrops}`);
            }
            this.lastDropLogTime = now;
            this.consecutiveDrops = 0;
          }
        }
        
        frame.close();
      },
    });
  }
  
  /**
   * Enable or disable debug logging at runtime
   */
  override setDebugLogging(enabled: boolean): void {
    this.config.debugLogging = enabled;
    super.setDebugLogging(enabled);
  }

  /**
   * Set audio volume (0-1)
   *
   * The value is remembered and re-applied whenever a new audio player is
   * created, so calls made before audio arrives (or across codec changes)
   * are not lost.
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.audioPlayer?.setVolume(this.volume);
  }

  /**
   * Get current audio volume (0-1)
   */
  getVolume(): number {
    return this.volume;
  }
  
  /**
   * Set the stream source (dependency injection)
   */
  setStreamSource(source: IStreamSource): void {
    // Disconnect from previous source
    if (this.streamSource && this.boundDataHandler) {
      this.streamSource.off('data', this.boundDataHandler);
    }
    
    this.streamSource = source;
    this.boundDataHandler = this.handleStreamData.bind(this);
    this.streamSource.on('data', this.boundDataHandler);
    
    this.logger.info('Stream source connected');
  }
  
  /**
   * Set the track name to filter for
   */
  setTrackFilter(trackName: string): void {
    this.trackFilter = trackName;
    this.logger.info(`Track filter set: ${trackName}`);
  }
  
  /**
   * Convenience method to connect to a MoQ-like session
   * 
   * Note: For audio support, the MoQ session must also be subscribed to the audio track.
   * When using MoQSource, include both 'video' and 'audio' in subscriptions.
   * When using Elmo's MoQSessionNode, add an audio track to the session config.
   * 
   * @param session - MoQ session implementing IStreamSource (e.g., Elmo's MoQSessionNode)
   * @param videoTrackName - Video track name (defaults to config.videoTrackName or 'video')
   */
  connectToMoQSession(session: IStreamSource, videoTrackName?: string): void {
    // MoQSessionNode implements IStreamSource directly - no adapter needed
    this.setStreamSource(session);
    if (videoTrackName) {
      this.setTrackFilter(videoTrackName);
    }
  }
  
  /**
   * Connect to a MoQ relay directly with video and optional audio tracks
   * 
   * @param relayUrl - URL of the MoQ relay (e.g., 'https://relay.example.com/moq')
   * @param namespace - MoQ namespace/broadcast name
   * @param options - Optional configuration for track names
   */
  async connectToMoQRelay(
    relayUrl: string, 
    namespace: string, 
    options?: { videoTrack?: string; audioTrack?: string | false }
  ): Promise<void> {
    const { createMoQSource } = await import('../sources/moq-source');
    
    const videoTrack = options?.videoTrack ?? this.config.videoTrackName ?? 'video';
    const audioTrack = options?.audioTrack === false 
      ? null 
      : (options?.audioTrack ?? this.config.audioTrackName ?? 'audio');
    
    const subscriptions: any[] = [
      { trackName: videoTrack, streamType: 'video', priority: 0 },
    ];
    
    if (audioTrack && this.config.enableAudio) {
      subscriptions.push({ trackName: audioTrack, streamType: 'audio', priority: 0 });
    }
    
    this.logger.info(`MoQ subscriptions: ${JSON.stringify(subscriptions)}`);
    
    const source = createMoQSource({
      relayUrl,
      namespace,
      subscriptions,
    });
    
    this.setStreamSource(source);
    await source.connect();
  }
  
  /**
   * Start playback
   */
  play(): void {
    if (this._state === 'error') {
      return;
    }
    
    this.setState('playing');
    this.logger.info('Playback started');
  }
  
  /**
   * Pause playback
   */
  pause(): void {
    if (this._state === 'playing') {
      this.setState('paused');
      this.logger.info('Playback paused');
    }
  }
  
  /**
   * Get a video frame for rendering
   * 
   * Call this in your render loop with the current timestamp.
   * The returned VideoFrame should be closed after use if you're done with it.
   */
  getVideoFrame(timestampMs: number): VideoFrame | null {
    if (this._state !== 'playing') {
      if (this.config.debugLogging) {
        this.logger.debug(`getVideoFrame: state=${this._state}, returning lastFrame=${!!this.lastVideoFrame}`);
      }
      return this.lastVideoFrame;
    }
    
    // Periodic status logging when debug is enabled
    if (this.config.debugLogging) {
      this.statusLogCounter++;
      if (this.statusLogCounter >= 300) { // ~5 seconds at 60fps
        this.frameScheduler.logStatus();
        this.statusLogCounter = 0;
      }
    }
    
    const frame = this.frameScheduler.dequeue(timestampMs);
    
    if (frame) {
      // Reset consecutive drop counter when we successfully get a frame
      this.consecutiveDrops = 0;
      
      // Close the previous frame
      if (this.lastVideoFrame && this.lastVideoFrame !== frame) {
        this.lastVideoFrame.close();
      }
      this.lastVideoFrame = frame;
    }
    
    return this.lastVideoFrame;
  }
  
  /**
   * Set buffer delay in milliseconds (syncs both video and audio)
   */
  setBufferDelay(delayMs: number): void {
    this.config.bufferDelayMs = delayMs;
    this.frameScheduler.setBufferDelay(delayMs);
    this.audioPlayer?.setBufferDelay(delayMs);
  }
  
  /**
   * Get current buffer delay in milliseconds
   */
  getBufferDelay(): number {
    return this.frameScheduler.getBufferDelay();
  }
  
  /**
   * Set preferred decoder type
   * If decoder type changes while playing, dispose old decoder and request keyframe
   */
  setPreferredDecoder(type: PreferredDecoder): void {
    const oldType = this.config.preferredDecoder;
    this.config.preferredDecoder = type;
    
    // Check if decoder type category changed (webcodecs vs wasm)
    const wasWasm = oldType === 'wasm';
    const isWasm = type === 'wasm';
    
    if (wasWasm !== isWasm && this.decoder) {
      this.logger.info(`Decoder type changed from ${oldType} to ${type}, switching decoder...`);
      
      // Dispose old decoder
      this.decoder.dispose();
      this.decoder = null;
      
      // Clear frame buffer
      this.frameScheduler.clear();
      
      // Close last video frame
      if (this.lastVideoFrame) {
        this.lastVideoFrame.close();
        this.lastVideoFrame = null;
      }
      
      // Wait for keyframe and reconfigure
      this.waitingForKeyframe = true;
      this.currentCodecData = undefined;
      
      // Request keyframe to restart
      this.streamSource?.requestKeyframe?.();
      this.logger.info('Keyframe requested for decoder switch');
    } else if (oldType !== type && this.decoder) {
      // Same decoder family but different preference (hw vs sw)
      // Just reconfigure on next keyframe
      this.logger.info(`Decoder preference changed from ${oldType} to ${type}`);
      this.waitingForKeyframe = true;
      this.currentCodecData = undefined;
      this.decoder.dispose();
      this.decoder = null;
      this.frameScheduler.clear();
      this.streamSource?.requestKeyframe?.();
    }
  }
  
  /**
   * Flush the player pipeline (decoder, frame buffer)
   * Used to recover from queue overflow or when seeking
   */
  flush(): void {
    this.logger.info('Flushing player pipeline');
    this.waitingForKeyframe = true;
    
    // Flush decoder
    this.decoder?.flushSync();
    
    // Clear frame buffer
    this.frameScheduler.clear();
    
    // Close last frame
    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }
    
    // Request new keyframe from source
    this.streamSource?.requestKeyframe?.();
  }
  
  /**
   * Get player statistics
   */
  getStats(): PlayerStats {
    const schedulerStatus = this.frameScheduler.getStatus();
    
    // Update bandwidth calculation
    this.updateBandwidthStats();
    
    return {
      bufferSize: schedulerStatus.currentBufferSize,
      bufferMs: schedulerStatus.currentBufferMs,
      avgBufferMs: schedulerStatus.avgBufferMs,
      targetBufferMs: schedulerStatus.targetBufferMs,
      droppedFrames: schedulerStatus.droppedFrames,
      totalFrames: schedulerStatus.totalEnqueuedFrames,
      decoderState: this.decoder?.state ?? 'none',
      streamWidth: this.streamWidth,
      streamHeight: this.streamHeight,
      frameRate: this.estimatedFrameRate,
      latency: schedulerStatus.latency,
      bandwidth: this.currentBandwidth,
    };
  }
  
  /**
   * Update bandwidth statistics
   */
  private updateBandwidthStats(): void {
    const now = performance.now();
    const elapsed = now - this.lastBandwidthUpdateTime;
    
    // Update every 500ms minimum to avoid jittery stats
    if (elapsed < 500) {
      return;
    }
    
    const elapsedSeconds = elapsed / 1000;
    const videoBytesDelta = this.videoBytesReceived - this.lastVideoBytesReceived;
    const audioBytesDelta = this.audioBytesReceived - this.lastAudioBytesReceived;
    
    this.currentBandwidth = {
      videoBytesPerSecond: videoBytesDelta / elapsedSeconds,
      audioBytesPerSecond: audioBytesDelta / elapsedSeconds,
      totalBytesPerSecond: (videoBytesDelta + audioBytesDelta) / elapsedSeconds,
    };
    
    this.lastBandwidthUpdateTime = now;
    this.lastVideoBytesReceived = this.videoBytesReceived;
    this.lastAudioBytesReceived = this.audioBytesReceived;
  }
  
  /**
   * Get packet timing history for visualization/debugging
   */
  getPacketTimingHistory() {
    return this.frameScheduler.getPacketTimingHistory();
  }
  
  /**
   * Subscribe to player events (typed overload)
   */
  override on<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]): void {
    super.on(event, handler);
  }
  
  /**
   * Unsubscribe from player events (typed overload)
   */
  override off<K extends keyof PlayerEventMap>(event: K, handler: PlayerEventMap[K]): void {
    super.off(event, handler);
  }
  
  /**
   * Handle incoming stream data
   *
   * Synchronous on the steady-state path; the codec-change and audio-init
   * branches hand off to async helpers.
   */
  private handleStreamData(event: StreamDataEvent): void {
    const data = event.data;

    if (!data.valid || !data.header) {
      return;
    }
    
    // Track bandwidth - count payload bytes
    const payloadBytes = data.payload?.byteLength || 0;
    
    // Route audio to handler - audio may come on separate "audio" track (MoQ)
    // or on the same connection as video (WebSocket)
    const isAudioPacket = data.header.type === FrameType.FRAME_TYPE_AUDIO || event.streamType === 'audio';
    if (isAudioPacket) {
      // Track audio bandwidth
      this.audioBytesReceived += payloadBytes;
      
      // For MoQ: audio comes on a separate track (e.g., "audio")
      // For WebSocket: audio comes on the same track as video (e.g., "default")
      // Only filter by audioTrackName if it's explicitly set AND matches a track-based pattern
      const audioTrack = this.config.audioTrackName;
      if (audioTrack !== null && audioTrack !== undefined) {
        // Accept audio if track matches audioTrackName OR if streamType is 'audio'
        // This allows WebSocket (where trackName might be 'default') to work
        if (event.trackName !== audioTrack && event.streamType !== 'audio') {
          return;
        }
      }
      this.handleAudioData(data);
      return;
    }
    
    // Track video bandwidth
    this.videoBytesReceived += payloadBytes;
    
    // Filter by track name for video if set (trackFilter overrides config)
    const videoTrack = this.trackFilter ?? this.config.videoTrackName;
    if (videoTrack !== null && videoTrack !== undefined && event.trackName !== videoTrack) {
      return;
    }
    
    // Handle video frames
    if (event.streamType !== 'video') {
      return;
    }
    
    if (!data.header.media?.codecData) {
      return;
    }
    
    const isKeyframe = !!(data.header.media?.keyframe);
    
    // Check for codec changes
    if (codecDataChanged(this.currentCodecData, data.header.media?.codecData)) {
      // Need keyframe to reconfigure
      if (!isKeyframe) {
        this.logger.debug('Waiting for keyframe (codec change)');
        return;
      }

      void this.reconfigureAndReplay(event, data, data.header.media?.codecData);
      return; // The keyframe is replayed once the decoder is ready
    }

    // Queue frames that arrive during configuration
    if (this.isConfiguring) {
      if (this.config.debugLogging) {
        this.logger.debug(`Queueing frame pts=${data.header.media?.pts} during configuration`);
      }
      this.pendingDuringConfig.push(data);
      return;
    }

    // Ensure decoder is ready
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.logger.warn(`Dropping frame pts=${data.header.media?.pts}: decoder not ready (state=${this.decoder?.state ?? 'null'})`);
      return;
    }

    // Wait for keyframe after configuration or flush
    if (this.waitingForKeyframe) {
      if (!isKeyframe) {
        if (this.config.debugLogging) {
          this.logger.debug(`Dropping frame pts=${data.header.media?.pts}: waiting for keyframe`);
        }
        const now = Date.now();
        // Log occasionally to avoid spam
        if (!this.lastWaitingForKeyframeLog || now - this.lastWaitingForKeyframeLog > 1000) {
          this.logger.info('Waiting for keyframe to resume playback...');
          this.lastWaitingForKeyframeLog = now;
          
          // Request keyframe periodically while waiting
          if (!this.lastKeyframeRequest || now - this.lastKeyframeRequest > 1000) {
            this.logger.info('Requesting keyframe...');
            this.streamSource?.requestKeyframe?.();
            this.lastKeyframeRequest = now;
          }
        }
        return;
      }
      this.logger.debug('Keyframe received, resuming decode');
      this.waitingForKeyframe = false;
      this.lastWaitingForKeyframeLog = 0;
    }
    
    // Decode the frame
    try {
      // Record arrival time for latency tracking
      // Use rescaled PTS (microseconds) as key to match what decoder outputs
      const arrivalTime = performance.now();
      const timestampUs = rescaleTime(data.header.media?.pts ?? 0, this.currentTimebase, MICROSECOND_TIMEBASE);
      this.recordPacketTiming(timestampUs, arrivalTime, isKeyframe);

      // Estimate FPS from timestamp difference between consecutive frames
      if (this.lastVideoTimestampUs >= 0 && timestampUs > this.lastVideoTimestampUs) {
        const frameDurationUs = timestampUs - this.lastVideoTimestampUs;
        // Only accept reasonable frame durations (1-200 fps range)
        if (frameDurationUs > 5000 && frameDurationUs < 1000000) {
          this.addFpsSample(frameDurationUs);
        }
      }
      this.lastVideoTimestampUs = timestampUs;

      this.decoder.decodeBinary(data, timestampUs);
    } catch (error) {
      this.logger.error(`Decode error: ${error}`);
    }
  }

  /**
   * Reconfigure the decoder for new codec data, then replay the keyframe and
   * anything that arrived while configuring.
   */
  private async reconfigureAndReplay(
    event: StreamDataEvent,
    keyframeData: ParsedFrame,
    codecData: IMediaCodecData
  ): Promise<void> {
    this.currentCodecData = codecData;
    this.currentTimebase = timebaseFromCodecData(codecData);
    this.isConfiguring = true;
    this.pendingDuringConfig = [keyframeData]; // Queue the keyframe itself

    await this.configureDecoder(codecData);

    this.isConfiguring = false;
    this.waitingForKeyframe = true;

    // Process all queued frames now that decoder is ready
    const pending = this.pendingDuringConfig;
    this.pendingDuringConfig = [];
    this.logger.info(`Processing ${pending.length} frames queued during configuration`);
    for (const pendingData of pending) {
      this.handleStreamData({
        trackName: event.trackName,
        streamType: event.streamType,
        data: pendingData,
      });
    }
  }

  /** Record a packet's arrival time and keyframe flag in the timing ring */
  private recordPacketTiming(timestampUs: number, arrivalTime: number, isKeyframe: boolean): void {
    const i = this.timingWrite;
    this.timingTimestamps[i] = timestampUs;
    this.timingArrivals[i] = arrivalTime;
    this.timingKeyframes[i] = isKeyframe ? 1 : 0;
    this.timingWrite = (i + 1) % LiveVideoPlayer.TIMING_RING_SIZE;
    if (this.timingCount < LiveVideoPlayer.TIMING_RING_SIZE) {
      this.timingCount++;
    }
  }

  /** Find a recorded packet by stream timestamp, newest first. Returns -1 if unknown. */
  private findPacketTiming(timestampUs: number): number {
    const size = LiveVideoPlayer.TIMING_RING_SIZE;
    for (let n = 1; n <= this.timingCount; n++) {
      const i = (this.timingWrite - n + size) % size;
      if (this.timingTimestamps[i] === timestampUs) {
        return i;
      }
    }
    return -1;
  }

  /** Add a frame duration sample and update the frame rate estimate */
  private addFpsSample(frameDurationUs: number): void {
    const i = this.fpsSampleWrite;
    if (this.fpsSampleCount === LiveVideoPlayer.FPS_SAMPLE_COUNT) {
      this.fpsSampleSum -= this.fpsSamples[i];
    } else {
      this.fpsSampleCount++;
    }
    this.fpsSamples[i] = frameDurationUs;
    this.fpsSampleSum += frameDurationUs;
    this.fpsSampleWrite = (i + 1) % LiveVideoPlayer.FPS_SAMPLE_COUNT;

    if (this.fpsSampleCount >= 3) {
      const avgDurationUs = this.fpsSampleSum / this.fpsSampleCount;
      this.estimatedFrameRate = Math.round(1000000 / avgDurationUs);
    }
  }

  /** Reset the frame rate estimate to its default */
  private resetFpsEstimate(): void {
    this.lastVideoTimestampUs = -1;
    this.fpsSampleWrite = 0;
    this.fpsSampleCount = 0;
    this.fpsSampleSum = 0;
    this.estimatedFrameRate = 30;
  }

  /**
   * Handle incoming audio frame data
   */
  private handleAudioData(data: ParsedFrame): void {
    if (!this.config.enableAudio) {
      return;
    }

    // Check for codec changes
    const codecData = data.header?.media?.codecData;
    if (codecData && codecDataChanged(this.audioCodecData ?? undefined, codecData)) {
      void this.initAudioPlayer(codecData, data);
      return;
    }

    // Decode the audio frame
    if (this.audioPlayer && data.payload && data.header) {
      // Pass PTS directly as bigint (microseconds)
      this.audioPlayer.decode(data.payload, data.header.media?.pts);
    }
  }

  /**
   * Create and initialize the audio player for new codec data, then decode the
   * frame that carried it.
   */
  private async initAudioPlayer(codecData: IMediaCodecData, firstFrame: ParsedFrame): Promise<void> {
    // Set before awaiting so frames arriving during init don't trigger a second init
    this.audioCodecData = codecData;

    // Dispose old player if exists
    if (this.audioPlayer) {
      this.audioPlayer.dispose();
      this.audioPlayer = null;
    }

    // Create audio context if needed
    if (!this.audioContext) {
      if (this.config.audioContext) {
        this.audioContext = this.config.audioContext;
        this.ownsAudioContext = false;
      } else {
        this.audioContext = new AudioContext();
        this.ownsAudioContext = true;
      }
    }

    // Create audio player with buffer delay config
    const player = new LiveAudioPlayer(this.audioContext, {
      bufferDelayMs: this.config.bufferDelayMs ?? 100
    });
    this.audioPlayer = player;

    // Initialize with codec data
    await player.init(codecData);

    // Re-apply the caller's desired volume to the fresh audio player
    player.setVolume(this.volume);

    // Start playback
    player.start();
    this.logger.info(`Audio player started: ${codecData.codecType}, ${codecData.sampleRate}Hz, ${codecData.channels}ch`);

    // Decode the frame that carried the new codec data
    if (this.audioPlayer === player && firstFrame.payload && firstFrame.header) {
      player.decode(firstFrame.payload, firstFrame.header.media?.pts);
    }
  }
  
  /**
   * Configure the decoder for a specific codec
   */
  private async configureDecoder(codecData: IMediaCodecData): Promise<void> {
    this.useWasmDecoder = this.config.preferredDecoder === 'wasm';
    
    // Create decoder if needed
    if (!this.decoder || (this.useWasmDecoder && this.decoder instanceof WebCodecsDecoder) || 
        (!this.useWasmDecoder && this.decoder instanceof WasmDecoder)) {
      // Dispose old decoder if switching types
      if (this.decoder) {
        this.decoder.dispose();
      }
      
      if (this.useWasmDecoder) {
        this.logger.info('Using WASM decoder');
        this.decoder = new WasmDecoder({
          onFrameDecoded: (frame) => this.handleDecodedYUVFrame(frame),
          onError: (error) => this.handleDecoderError(error),
          onQueueOverflow: (queueSize) => this.handleQueueOverflow(queueSize),
          maxQueueSize: 10,
        });
      } else {
        this.logger.info(`Using WebCodecs decoder (${this.config.preferredDecoder})`);
        this.decoder = new WebCodecsDecoder({
          logger: this.logger,
          onFrameDecoded: (frame) => this.handleDecodedFrame(frame),
          onError: (error) => this.handleDecoderError(error),
          onQueueOverflow: (queueSize) => this.handleQueueOverflow(queueSize),
          maxQueueSize: 10,
        });
      }
    }
    
    const preferHardware = this.config.preferredDecoder === 'webcodecs-hw';
    
    try {
      if (this.useWasmDecoder) {
        await (this.decoder as WasmDecoder).configure(codecData);
      } else {
        await (this.decoder as WebCodecsDecoder).configure(codecData, preferHardware);
      }
      
      // Update metadata
      this.streamWidth = codecData.width || 0;
      this.streamHeight = codecData.height || 0;
      
      // Reset FPS estimation for new stream (keep default of 30 until estimated)
      this.resetFpsEstimate();

      this.emit('metadata', {
        width: codecData.width,
        height: codecData.height,
        codec: this.getCodecName(codecData.codecType || sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AVC),
      });
      
    } catch (error) {
      this.logger.error(`Failed to configure decoder: ${error}`);
      this.setState('error');
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
  
  private getCodecName(codecType: sesame.v1.common.CodecType): string {
    switch (codecType) {
      case sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AVC: return 'H.264';
      case sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_HEVC: return 'HEVC';
      case sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AV1: return 'AV1';
      default: return 'Unknown';
    }
  }
  
  /**
   * Handle decoded video frame (from WebCodecs)
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    const decodeTime = performance.now();
    const i = this.findPacketTiming(frame.timestamp);
    const arrivalTime = i >= 0 ? this.timingArrivals[i] : decodeTime;
    const isKeyframe = i >= 0 ? this.timingKeyframes[i] === 1 : false;

    this.frameScheduler.enqueueFrame(frame, frame.timestamp, arrivalTime, decodeTime, isKeyframe);
    this.emit1('frame', frame);
  }
  
  /**
   * Handle decoded YUV frame (from WASM decoder)
   * Converts YUV to VideoFrame using canvas
   */
  private handleDecodedYUVFrame(yuvFrame: YUVFrame): void {
    const decodeTime = performance.now();
    const i = this.findPacketTiming(yuvFrame.timestamp);
    const arrivalTime = i >= 0 ? this.timingArrivals[i] : decodeTime;
    const isKeyframe = i >= 0 ? this.timingKeyframes[i] === 1 : false;

    // Pass actual video dimensions for visible rect (decoder may output padded dimensions)
    const videoFrame = this.convertYUVToVideoFrame(yuvFrame, this.streamWidth, this.streamHeight);
    if (videoFrame) {
      this.frameScheduler.enqueueFrame(videoFrame, yuvFrame.timestamp, arrivalTime, decodeTime, isKeyframe);
      this.emit1('frame', videoFrame);
    }
  }
  
  /**
   * Get a scratch buffer of at least `size` bytes for I420 repacking.
   *
   * The VideoFrame constructor copies the data it is given, so one buffer can
   * be reused for every frame.
   */
  private getYUVScratch(size: number): Uint8Array {
    if (!this.yuvScratch || this.yuvScratch.byteLength < size) {
      this.yuvScratch = new Uint8Array(size);
    }
    return this.yuvScratch;
  }

  /**
   * Convert YUV frame to VideoFrame using native I420 support
   * Much faster than manual pixel-by-pixel conversion
   * 
   * @param yuv - YUV frame data from decoder (may have padded dimensions)
   * @param visibleWidth - Actual video width (unpadded)
   * @param visibleHeight - Actual video height (unpadded)
   */
  private convertYUVToVideoFrame(yuv: YUVFrame, visibleWidth: number, visibleHeight: number): VideoFrame | null {
    try {
      const { y, u, v, width, height, chromaStride, chromaHeight } = yuv;

      // Use actual video dimensions if available, otherwise use decoded dimensions
      const actualWidth = visibleWidth > 0 ? visibleWidth : width;
      const actualHeight = visibleHeight > 0 ? visibleHeight : height;

      // VideoFrame supports I420 format directly - GPU handles YUV→RGB
      // Broadway decoder outputs Y with stride=width, UV with chromaStride
      const yStride = width;
      const ySize = yStride * height;
      const chromaWidth = width >> 1;
      const uvSize = chromaStride * chromaHeight;
      const totalSize = ySize + uvSize * 2;

      let data: Uint8Array;

      if (yuv.data && chromaStride === chromaWidth && yuv.data.byteLength >= totalSize) {
        // Planes are already contiguous in I420 order - hand the buffer over as is
        data = yuv.data;
      } else {
        data = this.getYUVScratch(ySize + chromaWidth * chromaHeight * 2);

        // Copy Y plane (stride matches width for Broadway)
        data.set(y.subarray(0, ySize), 0);

        // Copy U plane
        const uOffset = ySize;
        if (chromaStride === chromaWidth) {
          // Contiguous - fast copy
          data.set(u.subarray(0, uvSize), uOffset);
        } else {
          // Strided - copy row by row
          for (let row = 0; row < chromaHeight; row++) {
            data.set(u.subarray(row * chromaStride, row * chromaStride + chromaWidth), uOffset + row * chromaWidth);
          }
        }

        // Copy V plane
        const vOffset = uOffset + chromaWidth * chromaHeight;
        if (chromaStride === chromaWidth) {
          data.set(v.subarray(0, uvSize), vOffset);
        } else {
          for (let row = 0; row < chromaHeight; row++) {
            data.set(v.subarray(row * chromaStride, row * chromaStride + chromaWidth), vOffset + row * chromaWidth);
          }
        }
      }

      // Create VideoFrame with I420 format - browser handles YUV→RGB on GPU
      // Use visibleRect to crop padding from H.264 macroblock alignment
      return new VideoFrame(data, {
        format: 'I420',
        codedWidth: width,
        codedHeight: height,
        visibleRect: {
          x: 0,
          y: 0,
          width: actualWidth,
          height: actualHeight,
        },
        timestamp: yuv.timestamp,
        duration: this.estimatedFrameRate > 0 ? 1_000_000 / this.estimatedFrameRate : 33333,
      });
    } catch (error) {
      this.logger.error(`YUV conversion error: ${error}`);
      return null;
    }
  }
  
  /**
   * Handle decoder error
   */
  private handleDecoderError(error: Error): void {
    this.logger.error(`Decoder error: ${error.message}`);
    this.emit('error', error);
  }
  
  /**
   * Handle decoder queue overflow - flush and request keyframe
   */
  private handleQueueOverflow(queueSize: number): void {
    this.logger.warn(`Decoder queue overflow: ${queueSize} frames, flushing...`);
    this.flush();
  }
  
  /**
   * Dispose the player and release resources
   */
  dispose(): void {
    // Disconnect from source
    if (this.streamSource && this.boundDataHandler) {
      this.streamSource.off('data', this.boundDataHandler);
    }
    this.streamSource = null;
    this.boundDataHandler = null;
    
    // Dispose video decoder
    if (this.decoder) {
      this.decoder.dispose();
      this.decoder = null;
    }
    
    // Dispose audio player
    if (this.audioPlayer) {
      this.audioPlayer.dispose();
      this.audioPlayer = null;
    }
    
    // Close audio context if we own it
    if (this.ownsAudioContext && this.audioContext) {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.audioCodecData = null;
    
    // Clear frame buffer
    this.frameScheduler.clear();
    
    // Close last frame
    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }
    
    // Clear timing tracking
    this.timingWrite = 0;
    this.timingCount = 0;
    this.yuvScratch = null;

    // Reset state
    this.currentCodecData = undefined;
    this.currentTimebase = MICROSECOND_TIMEBASE;
    this.waitingForKeyframe = true;
    this.totalDrops = 0;
    this.consecutiveDrops = 0;
    
    // Clear event handlers (from BasePlayer)
    this.clearEventHandlers();
    
    this.setState('idle');
    this.logger.info('Player disposed');
  }
}
