/**
 * Live Video Player
 * 
 * Main player class that orchestrates stream sources, decoders, and frame scheduling.
 */

import type { IStreamSource, StreamDataEvent } from '../sources/stream-source';
import type { PreferredDecoder } from '../types';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';
import { WasmDecoder, YUVFrame } from '../decoders/wasm-decoder';
import { FrameScheduler, FrameTiming, LatencyStats } from '../scheduling/frame-scheduler';
import { FLAG_IS_KEYFRAME, HeaderCodecData, ParsedData, PacketType } from '../protocol/sesame-binary-protocol';
import { codecDataChanged, rescaleTime } from '../protocol/codec-utils';
import { LiveAudioPlayer } from '../audio/live-audio-player';
import { BasePlayer } from './base-player';

/**
 * Player configuration
 */
export interface PlayerConfig {
  preferredDecoder?: PreferredDecoder;
  /** Buffer delay in milliseconds (default: 100ms) */
  bufferDelayMs?: number;
  enableAudio?: boolean;
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
  private currentCodecData: HeaderCodecData | undefined;
  private useWasmDecoder: boolean = false;
  private waitingForKeyframe: boolean = true;
  private lastWaitingForKeyframeLog: number = 0;
  private lastKeyframeRequest: number = 0;
  private statusLogCounter: number = 0;
  private isConfiguring: boolean = false;
  private pendingDuringConfig: ParsedData[] = [];  // Queue frames during configuration
  
  // Frame scheduling
  private frameScheduler: FrameScheduler<VideoFrame>;
  private lastVideoFrame: VideoFrame | null = null;
  private consecutiveDrops: number = 0;
  private totalDrops: number = 0;
  private lastDropLogTime: number = 0;
  
  // Metadata
  private streamWidth: number = 0;
  private streamHeight: number = 0;
  private estimatedFrameRate: number = 0;
  
  // Audio
  private audioContext: AudioContext | null = null;
  private audioPlayer: LiveAudioPlayer | null = null;
  private ownsAudioContext: boolean = false;
  private audioCodecData: HeaderCodecData | null = null;
  
  // Timing tracking: maps frame timestamp to arrival time
  private arrivalTimes: Map<number, number> = new Map();
  
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
      this.audioContext = new AudioContext();
      this.ownsAudioContext = true;
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
   */
  setVolume(volume: number): void {
    if (this.audioPlayer) {
      this.audioPlayer.setVolume(volume);
    }
  }

  /**
   * Get current audio volume (0-1)
   */
  getVolume(): number {
    return 1; // Default, we don't track volume state
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
   * When using StandaloneMoQSource, include both 'video' and 'audio' in subscriptions.
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
    const { createStandaloneMoQSource } = await import('../sources/standalone-moq-source');
    
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
    
    const source = createStandaloneMoQSource({
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
    };
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
   */
  private async handleStreamData(event: StreamDataEvent): Promise<void> {
    const data = event.data;
    
    if (!data.valid || !data.header) {
      return;
    }
    
    // Route audio to handler - audio may come on separate "audio" track (MoQ)
    // or on the same connection as video (WebSocket)
    const isAudioPacket = data.header.type === PacketType.AUDIO_FRAME || event.streamType === 'audio';
    if (isAudioPacket) {
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
      await this.handleAudioData(data);
      return;
    }
    
    // Filter by track name for video if set (trackFilter overrides config)
    const videoTrack = this.trackFilter ?? this.config.videoTrackName;
    if (videoTrack !== null && videoTrack !== undefined && event.trackName !== videoTrack) {
      return;
    }
    
    // Handle video frames
    if (event.streamType !== 'video') {
      return;
    }
    
    if (!data.codec_data) {
      return;
    }
    
    const isKeyframe = !!(data.header.flags & FLAG_IS_KEYFRAME);
    if (isKeyframe) {
      this.logger.info(`Keyframe received: ${data.codec_data.width}x${data.codec_data.height}`);
    }
    
    // Check for codec changes
    if (codecDataChanged(this.currentCodecData, data.codec_data)) {
      // Need keyframe to reconfigure
      if (!isKeyframe) {
        this.logger.debug('Waiting for keyframe (codec change)');
        return;
      }
      
      this.currentCodecData = data.codec_data;
      this.isConfiguring = true;
      this.pendingDuringConfig = [data]; // Queue the keyframe itself
      await this.configureDecoder(data.codec_data);
      this.isConfiguring = false;
      this.waitingForKeyframe = true;
      
      // Process all queued frames now that decoder is ready
      const pending = this.pendingDuringConfig;
      this.pendingDuringConfig = [];
      this.logger.info(`Processing ${pending.length} frames queued during configuration`);
      for (const pendingData of pending) {
        await this.handleStreamData({ 
          trackName: event.trackName, 
          streamType: event.streamType, 
          data: pendingData 
        });
      }
      return; // Already processed the keyframe in the loop above
    }
    
    // Queue frames that arrive during configuration
    if (this.isConfiguring) {
      this.logger.debug(`Queueing frame pts=${data.header.pts} during configuration`);
      this.pendingDuringConfig.push(data);
      return;
    }
    
    // Ensure decoder is ready
    if (!this.decoder || this.decoder.state !== 'configured') {
      this.logger.warn(`Dropping frame pts=${data.header.pts}: decoder not ready (state=${this.decoder?.state ?? 'null'})`);
      return;
    }
    
    // Wait for keyframe after configuration or flush
    if (this.waitingForKeyframe) {
      if (!isKeyframe) {
        this.logger.debug(`Dropping frame pts=${data.header.pts}: waiting for keyframe`);
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
      this.logger.info('Keyframe received, resuming decode');
      this.waitingForKeyframe = false;
      this.lastWaitingForKeyframeLog = 0;
    }
    
    // Decode the frame
    try {
      // Record arrival time for latency tracking
      // Use rescaled PTS (microseconds) as key to match what decoder outputs
      const arrivalTime = performance.now();
      const sourceTimebase = data.codec_data?.timebase_den && data.codec_data?.timebase_num
        ? { num: data.codec_data.timebase_num, den: data.codec_data.timebase_den }
        : { num: 1, den: 1000000 };
      const microsecondTimebase = { num: 1, den: 1000000 };
      const timestampUs = rescaleTime(data.header!.pts, sourceTimebase, microsecondTimebase);
      this.arrivalTimes.set(timestampUs, arrivalTime);
      
      // Clean up old entries (keep last 100)
      if (this.arrivalTimes.size > 100) {
        const entries = [...this.arrivalTimes.entries()];
        for (let i = 0; i < entries.length - 100; i++) {
          this.arrivalTimes.delete(entries[i][0]);
        }
      }
      
      this.decoder.decodeBinary(data);
    } catch (error) {
      this.logger.error(`Decode error: ${error}`);
    }
  }
  
  /**
   * Handle incoming audio frame data
   */
  private async handleAudioData(data: ParsedData): Promise<void> {
    if (!this.config.enableAudio) {
      return;
    }
    
    // Check for codec changes
    const currentCodecData = this.audioCodecData ?? undefined;
    if (data.codec_data && codecDataChanged(currentCodecData, data.codec_data)) {
      this.audioCodecData = data.codec_data;
      
      // Dispose old player if exists
      if (this.audioPlayer) {
        this.audioPlayer.dispose();
        this.audioPlayer = null;
      }
      
      // Create audio context if needed
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        this.ownsAudioContext = true;
      }
      
      // Create audio player with buffer delay config
      this.audioPlayer = new LiveAudioPlayer(this.audioContext, {
        bufferDelayMs: this.config.bufferDelayMs ?? 100
      });
      
      // Initialize with codec data
      await this.audioPlayer.init(data.codec_data);
      
      // Start playback
      this.audioPlayer.start();
      this.logger.info(`Audio player started: ${data.codec_data.codec_type}, ${data.codec_data.sample_rate}Hz, ${data.codec_data.channels}ch`);
    }
    
    // Decode the audio frame
    if (this.audioPlayer && data.payload && data.header) {
      // Pass PTS directly as bigint (microseconds)
      this.audioPlayer.decode(data.payload, data.header.pts);
    }
  }
  
  /**
   * Configure the decoder for a specific codec
   */
  private async configureDecoder(codecData: HeaderCodecData): Promise<void> {
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
      this.streamWidth = codecData.width;
      this.streamHeight = codecData.height;
      
      // Estimate frame rate from timebase
      if (codecData.timebase_num && codecData.timebase_den) {
        this.estimatedFrameRate = codecData.timebase_den / codecData.timebase_num;
      }
      
      this.emit('metadata', {
        width: codecData.width,
        height: codecData.height,
        codec: this.getCodecName(codecData.codec_type),
      });
      
    } catch (error) {
      this.logger.error(`Failed to configure decoder: ${error}`);
      this.setState('error');
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
  
  private getCodecName(codecType: number): string {
    switch (codecType) {
      case 3: return 'H.264';
      case 4: return 'HEVC';
      case 5: return 'AV1';
      default: return 'Unknown';
    }
  }
  
  /**
   * Handle decoded video frame (from WebCodecs)
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    const decodeTime = performance.now();
    const arrivalTime = this.arrivalTimes.get(frame.timestamp) ?? decodeTime;
    
    const timing: FrameTiming = {
      arrivalTime,
      decodeTime,
    };
    
    this.frameScheduler.enqueue(frame, frame.timestamp, timing);
    this.emit('frame', frame);
  }
  
  /**
   * Handle decoded YUV frame (from WASM decoder)
   * Converts YUV to VideoFrame using canvas
   */
  private handleDecodedYUVFrame(yuvFrame: YUVFrame): void {
    const decodeTime = performance.now();
    const arrivalTime = this.arrivalTimes.get(yuvFrame.timestamp) ?? decodeTime;
    
    // Pass actual video dimensions for visible rect (decoder may output padded dimensions)
    const videoFrame = this.convertYUVToVideoFrame(yuvFrame, this.streamWidth, this.streamHeight);
    if (videoFrame) {
      const timing: FrameTiming = {
        arrivalTime,
        decodeTime,
      };
      
      this.frameScheduler.enqueue(videoFrame, yuvFrame.timestamp, timing);
      this.emit('frame', videoFrame);
    }
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
      const uvSize = chromaStride * chromaHeight;
      const totalSize = ySize + uvSize * 2;
      
      const data = new Uint8Array(totalSize);
      
      // Copy Y plane (stride matches width for Broadway)
      data.set(y.subarray(0, ySize), 0);
      
      // Copy U plane
      const chromaWidth = width / 2;
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
    this.arrivalTimes.clear();
    
    // Reset state
    this.currentCodecData = undefined;
    this.waitingForKeyframe = true;
    this.totalDrops = 0;
    this.consecutiveDrops = 0;
    
    // Clear event handlers (from BasePlayer)
    this.clearEventHandlers();
    
    this.setState('idle');
    this.logger.info('Player disposed');
  }
}
