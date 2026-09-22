/**
 * Live Video Player
 *
 * Main player class that orchestrates stream sources, decoders, and frame scheduling.
 */

import type { IStreamSource, StreamDataEvent } from '../sources/stream-source';
import type { PreferredDecoder } from '../types';
import { FrameScheduler, LatencyStats } from '../scheduling/frame-scheduler';
import { codecDataChanged, rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase } from '../protocol/codec-utils';
import { LiveAudioPlayer } from '../audio/live-audio-player';
import { BasePlayer } from './base-player';
import { IVideoFeed, VideoFeed, VideoFeedCallbacks } from './video-feed';
import { RemoteVideoFeed } from './remote-video-feed';
import type { PipelineClient } from '../worker/pipeline-client';
import { FrameType, IMediaCodecData, ParsedFrame } from '@stinkycomputing/sesame-api-client';

export { framesFromLastKeyframe, MAX_DECODE_QUEUE } from './video-feed';

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
  /**
   * Decode in a pipeline worker: the worker holds the MoQ session and decodes the named
   * track, and the player takes its frames. The pipeline's source becomes the player's
   * stream source, so audio still plays here. setStreamSource is not needed.
   */
  pipeline?: { client: PipelineClient; trackName: string };
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
  /**
   * A frame finished decoding.
   *
   * The player owns the frame and may close it once the handler returns - do not
   * close it, and do not retain it. Call `frame.clone()` if you need to keep it,
   * and close the clone yourself.
   */
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
  /** True when the player created the source and must dispose it */
  private ownsStreamSource: boolean = false;
  private trackFilter: string | null = null;
  /** Track names already reported as filtered out, so the warning is logged once each */
  private warnedVideoTracks: Set<string> = new Set();
  private boundDataHandler: ((event: StreamDataEvent) => void) | null = null;

  // Video: decoded here, or by the pipeline worker on the player's behalf
  private feed: IVideoFeed;
  private statusLogCounter: number = 0;

  // Frame scheduling
  private frameScheduler: FrameScheduler<VideoFrame>;
  private lastVideoFrame: VideoFrame | null = null;
  private consecutiveDrops: number = 0;
  private totalDrops: number = 0;
  private lastDropLogTime: number = 0;

  // Audio
  private audioContext: AudioContext | null = null;
  private audioPlayer: LiveAudioPlayer | null = null;
  private ownsAudioContext: boolean = false;
  private audioCodecData: IMediaCodecData | null = null;
  /** Timebase of the current audio codec data, cached like the video one */
  private audioTimebase: Timebase = MICROSECOND_TIMEBASE;
  private volume: number = 1;
  private audioInitializing: boolean = false;
  private pendingAudioDuringInit: ParsedFrame[] = [];
  private static readonly MAX_PENDING_AUDIO = 32;

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
      pipeline: config.pipeline,
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

    const callbacks: VideoFeedCallbacks = {
      onFrame: (frame, timestampUs, arrivalTime, decodeTime, isKeyframe) => {
        this.frameScheduler.enqueueFrame(frame, timestampUs, arrivalTime, decodeTime, isKeyframe);
        this.emit1('frame', frame);
      },
      onMetadata: (metadata) => this.emit('metadata', metadata),
      onError: (error, fatal) => {
        if (fatal) this.setState('error');
        this.emit('error', error);
      },
      requestKeyframe: () => this.streamSource?.requestKeyframe?.(),
    };
    if (config.pipeline) {
      this.feed = new RemoteVideoFeed(config.pipeline.client, config.pipeline.trackName, this.config.preferredDecoder, callbacks);
      this.setStreamSource(config.pipeline.client.source);
      this.setTrackFilter(config.pipeline.trackName);
    } else {
      this.feed = new VideoFeed({
        preferredDecoder: this.config.preferredDecoder,
        logger: this.logger,
        debugLogging: this.config.debugLogging,
      }, callbacks);
    }
  }

  /**
   * Enable or disable debug logging at runtime
   */
  override setDebugLogging(enabled: boolean): void {
    this.config.debugLogging = enabled;
    super.setDebugLogging(enabled);
    this.feed.setDebugLogging(enabled);
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
   *
   * The caller keeps ownership: `dispose()` unsubscribes from the source but does
   * not dispose it. A source the player created itself (see
   * {@link connectToMoQRelay}) is disposed here before being replaced.
   */
  setStreamSource(source: IStreamSource): void {
    // Disconnect from previous source
    if (this.streamSource && this.boundDataHandler) {
      this.streamSource.off('data', this.boundDataHandler);
    }
    if (this.ownsStreamSource) {
      this.streamSource?.dispose?.();
    }
    this.ownsStreamSource = false;

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
   * The player owns the source it creates here and disposes it on `dispose()`.
   * The source is returned so it can be inspected or torn down early.
   *
   * @param relayUrl - URL of the MoQ relay (e.g., 'https://relay.example.com/moq')
   * @param namespace - MoQ namespace/broadcast name
   * @param options - Optional configuration for track names
   */
  async connectToMoQRelay(
    relayUrl: string,
    namespace: string,
    options?: { videoTrack?: string; audioTrack?: string | false }
  ): Promise<IStreamSource> {
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
    this.ownsStreamSource = true;
    await source.connect();

    return source;
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
   *
   * The player owns the returned frame and closes it when the next frame is due,
   * so it is valid until the following call. Do not close it - draw from it, or
   * `clone()` it if you need to hold on to it.
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

    if (!this.feed.setPreferredDecoder(type)) {
      return;
    }
    // The decoder was dropped: what it produced is stale
    this.frameScheduler.clear();

    // Across decoder families the picture restarts; a preference change within one holds
    // the last frame until the new decoder delivers
    if ((oldType === 'wasm') !== (type === 'wasm') && this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }
    this.logger.info('Keyframe requested for decoder switch');
  }

  /**
   * Flush the player pipeline (decoder, frame buffer)
   * Used to recover from queue overflow or when seeking
   */
  flush(): void {
    this.logger.info('Flushing player pipeline');

    // Flush decoder; it asks the source for a keyframe
    this.feed.flush();

    // Clear frame buffer
    this.frameScheduler.clear();

    // Close last frame
    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }
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
      droppedFrames: schedulerStatus.droppedFrames + this.feed.framesDropped,
      totalFrames: schedulerStatus.totalEnqueuedFrames,
      decoderState: this.feed.decoderState,
      streamWidth: this.feed.streamWidth,
      streamHeight: this.feed.streamHeight,
      frameRate: this.feed.frameRate,
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
   * Synchronous on the steady-state path; the video feed and the audio-init
   * branch hand off to async helpers.
   */
  private handleStreamData(event: StreamDataEvent): void {
    const data = event.data;

    if (!data.valid || !data.header) {
      return;
    }

    // Track bandwidth - count what came over the wire
    const payloadBytes = event.wireBytes ?? (data.payload?.byteLength || 0);

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
      // A transport that names tracks after the stream (e.g. WebSocketSource) will
      // never match the default 'video', which otherwise looks like a dead stream
      if (event.streamType === 'video' && !this.warnedVideoTracks.has(event.trackName)) {
        this.warnedVideoTracks.add(event.trackName);
        this.logger.warn(
          `Ignoring video on track "${event.trackName}" - expecting "${videoTrack}". ` +
          `Call setTrackFilter("${event.trackName}"), or set videoTrackName to null to accept any track.`
        );
      }
      return;
    }

    // Handle video frames
    if (event.streamType !== 'video') {
      return;
    }

    this.feed.push(data);
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
      // initAudioPlayer handles its own failures, but guard the promise so an
      // unexpected throw can't surface as an unhandled rejection
      this.initAudioPlayer(codecData, data)
        .catch((error) => {
          this.audioInitializing = false;
          this.pendingAudioDuringInit = [];
          this.logger.error(`Audio initialization failed: ${error}`);
        });
      return;
    }

    // Queue frames that arrive while the audio player is initializing
    if (this.audioInitializing) {
      if (this.pendingAudioDuringInit.length < LiveVideoPlayer.MAX_PENDING_AUDIO) {
        this.pendingAudioDuringInit.push(data);
      }
      return;
    }

    this.decodeAudioFrame(data);
  }

  /** Hand an audio frame to the audio player */
  private decodeAudioFrame(data: ParsedFrame): void {
    if (this.audioPlayer && data.payload && data.header) {
      // Rescale to microseconds, the unit the audio player expects
      const timestampUs = rescaleTime(
        data.header.media?.pts ?? 0,
        this.audioTimebase,
        MICROSECOND_TIMEBASE
      );
      this.audioPlayer.decode(data.payload, timestampUs);
    }
  }

  /**
   * Create and initialize the audio player for new codec data, then decode the
   * frame that carried it along with anything that arrived while initializing.
   */
  private async initAudioPlayer(codecData: IMediaCodecData, firstFrame: ParsedFrame): Promise<void> {
    // Set before awaiting so frames arriving during init don't trigger a second init
    this.audioCodecData = codecData;
    this.audioTimebase = timebaseFromCodecData(codecData);
    this.audioInitializing = true;
    this.pendingAudioDuringInit = [firstFrame];

    // Dispose old player if exists
    if (this.audioPlayer) {
      this.audioPlayer.dispose();
      this.audioPlayer = null;
    }

    // Everything below can throw - creating an AudioContext fails once the browser's
    // context limit is reached, and the player constructor fails on a closed context -
    // so it all runs under the try that clears the initializing flag
    let player: LiveAudioPlayer | null = null;

    try {
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
      player = new LiveAudioPlayer(this.audioContext, {
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
    } catch (error) {
      this.logger.error(`Failed to start audio player: ${error}`);
      if (player && this.audioPlayer === player) {
        player.dispose();
        this.audioPlayer = null;
      }
      player = null;

      // Forget the codec data so the next packet retries instead of assuming
      // audio is already configured
      this.audioCodecData = null;
      this.audioTimebase = MICROSECOND_TIMEBASE;
    } finally {
      this.audioInitializing = false;
      const pending = this.pendingAudioDuringInit;
      this.pendingAudioDuringInit = [];

      // Drain the frames buffered during init, oldest first
      if (player && this.audioPlayer === player) {
        for (const pendingFrame of pending) {
          this.decodeAudioFrame(pendingFrame);
        }
      }
    }
  }

  /**
   * Dispose the player and release resources
   */
  dispose(): void {
    // Disconnect from source, and dispose it if the player created it
    if (this.streamSource && this.boundDataHandler) {
      this.streamSource.off('data', this.boundDataHandler);
    }
    if (this.ownsStreamSource) {
      this.streamSource?.dispose?.();
    }
    this.ownsStreamSource = false;
    this.streamSource = null;
    this.boundDataHandler = null;

    // Dispose the video feed (the decoder, or the worker's decode of the track)
    this.feed.dispose();

    // Dispose audio player
    if (this.audioPlayer) {
      this.audioPlayer.dispose();
      this.audioPlayer = null;
    }
    this.audioInitializing = false;
    this.pendingAudioDuringInit = [];

    // Close audio context if we own it
    if (this.ownsAudioContext && this.audioContext) {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.audioCodecData = null;
    this.audioTimebase = MICROSECOND_TIMEBASE;

    // Clear frame buffer
    this.frameScheduler.clear();

    // Close last frame
    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }

    this.totalDrops = 0;
    this.consecutiveDrops = 0;

    this.warnedVideoTracks.clear();

    // Deliver the final statechange before dropping the handlers
    this.setState('idle');
    this.clearEventHandlers();

    this.logger.info('Player disposed');
  }
}
