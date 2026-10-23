/**
 * Live Video Player
 *
 * Main player class that orchestrates stream sources, decoders, and playout.
 *
 * Timing: every packet that arrives is reported to a LiveClock, which runs a fixed buffer
 * delay behind the earliest-arriving packets. Decoded frames wait in a queue and
 * getVideoFrame() hands out the one the clock says is due; the audio player follows the same
 * clock. A clock passed in the config can be shared with other players (say a separately
 * owned LiveAudioPlayer for the same stream) to keep all of them in sync.
 */

import type { IStreamSource, StreamDataEvent } from '../sources/stream-source';
import type { PreferredDecoder } from '../types';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';
import { WasmDecoder, YUVFrame } from '../decoders/wasm-decoder';
import { VideoFrameQueue, FrameDropReason } from '../scheduling/video-frame-queue';
import { PlaybackStats, LatencyStats } from '../scheduling/playback-stats';
import { LiveClock, DEFAULT_BUFFER_DELAY_MS, type ClockAudio } from '../sync/live-clock';
import { codecDataChanged, rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase } from '../protocol/codec-utils';
import { LiveAudioPlayer, LiveAudioStats } from '../audio/live-audio-player';
import { BasePlayer } from './base-player';
import { FrameType, IMediaCodecData, ParsedFrame, sesame } from '@stinkycomputing/sesame-api-client';

/**
 * Chunks the decoder may hold before a delta frame is dropped: ten seconds at 50 fps. A
 * subscription starts with the current group from its first frame, up to a whole GOP at
 * once, and a decoder takes that in its stride; the limit only guards against a decoder
 * that cannot keep up at all. Encoded chunks are small, so the queue costs little.
 */
const MAX_DECODE_QUEUE = 512;

/**
 * Chunks the VideoDecoder holds at once: enough to keep a hardware decoder busy. The rest wait in
 * the player, where a backlog can be let go at a keyframe without restarting the decoder - a
 * hardware decoder takes long enough to start up again that a restart only builds a new backlog.
 */
const MAX_IN_DECODER = 4;

/**
 * Decoded frames held for display: at least this many, and enough for the clock's delay at the
 * stream's frame rate (with room for a burst), up to the most. They hold decoder memory.
 */
const FRAME_QUEUE_CAPACITY = 30;
const FRAME_QUEUE_MAX = 240;

/** Weight of the newest sample in the averaged statistics */
const STATS_SMOOTHING = 0.1;
/** Decode latencies the video's minimum delay is taken over */
const DECODE_WINDOW = 60;
/** Packets later than this (the backlog a subscription opens with) say nothing about decoding */
const ON_TIME_MS = 20;

/** The frames from the last keyframe on; all of them when none is a keyframe. */
export function framesFromLastKeyframe(frames: ParsedFrame[]): ParsedFrame[] {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].header?.media?.keyframe) return frames.slice(i);
  }
  return frames;
}

/**
 * Player configuration
 */
export interface PlayerConfig {
  preferredDecoder?: PreferredDecoder;
  /**
   * Buffer delay in milliseconds (default: 150): how far playback runs behind the
   * earliest-arriving packets. Packets later than that are dropped rather than waited for.
   * 0 shows the newest frame as soon as it decodes (audio then plays 50 ms behind, unsynced).
   * Ignored when a shared `clock` is given - the clock's delay applies.
   */
  bufferDelayMs?: number;
  /**
   * Clock to play on. Share one with other players of the same stream to keep them in sync. The
   * player reports its decoder's latency to it as the least delay the picture can be on time at.
   */
  clock?: LiveClock;
  enableAudio?: boolean;
  /** External AudioContext to use for audio playback. If provided, the player will not create or close it. */
  audioContext?: AudioContext;
  /** Node the audio goes to (default: the context's destination) */
  audioDestination?: AudioNode;
  /**
   * How far ahead of the getVideoFrame() call to pick the frame, in ms. A frame drawn now
   * reaches the screen at the next refresh and stays up for one refresh interval, so by default
   * frames are picked for the middle of that interval: 1.5 refresh intervals ahead, with the
   * interval measured from how often getVideoFrame() is called (25 ms at 60 Hz). Set a number
   * for a display pipeline with more latency, or 0 to pick for the moment of the call.
   */
  displayLatencyMs?: number;
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
 * Audio/video synchronization statistics
 */
export interface SyncStats {
  /** Whether the clock has started */
  clockRunning: boolean;
  /** Clock speed, 1 = real time */
  clockRate: number;
  /** How far the clock is from where it is heading, in ms */
  clockErrorMs: number;
  /** Times the clock jumped instead of slewing */
  clockJumps: number;
  /**
   * The middle of the frame on screen minus the audio being heard, in ms, averaged. About 0
   * when in sync (each sample within half a frame); null without audio.
   */
  avSyncMs: number | null;
  /** Frames that finished decoding after their time had come */
  lateFrames: number;
  /** The delay the clock runs at: the buffer delay, or what the players need if that is larger */
  effectiveDelayMs: number;
  /** The least delay the players on the clock need, in ms */
  minimumDelayMs: number;
  /** The least delay this player's video needs: decoding, and showing ahead of the screen, in ms */
  videoMinimumDelayMs: number;
  /** How far ahead of the getVideoFrame() call frames are picked, in ms */
  displayLeadMs: number;
  /**
   * The statistics of the player's audio - or, without audio of its own, of a LiveAudioPlayer on
   * its clock; null without either
   */
  audio: LiveAudioStats | null;
}

/**
 * Player statistics
 */
export interface PlayerStats {
  /** Decoded frames waiting */
  bufferSize: number;
  /** How far ahead of the clock the decoded frames reach, in ms */
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
  sync: SyncStats;
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

  // Decoder
  private decoder: WebCodecsDecoder | WasmDecoder | null = null;
  private currentCodecData: IMediaCodecData | undefined;
  /** Timebase of the current codec data, cached to keep the decode path allocation-free */
  private currentTimebase: Timebase = MICROSECOND_TIMEBASE;
  private useWasmDecoder: boolean = false;
  private waitingForKeyframe: boolean = true;
  private lastOverflowLog: number = 0;
  private lastWaitingForKeyframeLog: number = 0;
  private lastKeyframeRequest: number = 0;
  private isConfiguring: boolean = false;
  private pendingDuringConfig: ParsedFrame[] = [];  // Queue frames during configuration

  // Playout
  private readonly clock: LiveClock;
  /** Key the video packets are reported to the clock under, cached per track name */
  private clockTrackName: string | null = null;
  private clockTrackKey = 'video';
  /** Lateness of the packet being handled; NaN for packets replayed after configuration */
  private packetLatenessMs = NaN;
  private frameQueue: VideoFrameQueue<VideoFrame>;
  private playbackStats = new PlaybackStats();
  private lastVideoFrame: VideoFrame | null = null;
  /** Reused I420 staging buffer for the WASM decoder path */
  private yuvScratch: Uint8Array | null = null;
  private consecutiveDrops: number = 0;
  private lastDropLogTime: number = 0;
  private lateFrames: number = 0;
  private avgBufferMs: number = 0;
  private avSyncMs: number | null = null;
  private statusLogTime: number = 0;
  /** Time between getVideoFrame() calls, ms, averaged: the render loop's refresh interval */
  private renderIntervalMs: number = 1000 / 60;
  private lastRenderCall: number = -1;

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
  /** Timebase of the current audio codec data, cached like the video one */
  private audioTimebase: Timebase = MICROSECOND_TIMEBASE;
  private volume: number = 1;
  private audioInitializing: boolean = false;
  private pendingAudioDuringInit: { frame: ParsedFrame; arrivalMs: number }[] = [];
  private static readonly MAX_PENDING_AUDIO = 32;

  // Timing tracking: fixed ring of recent packets, keyed by frame timestamp.
  // Parallel typed arrays so recording a packet allocates nothing.
  private static readonly TIMING_RING_SIZE = 128;
  private timingTimestamps = new Float64Array(LiveVideoPlayer.TIMING_RING_SIZE);
  private timingArrivals = new Float64Array(LiveVideoPlayer.TIMING_RING_SIZE);
  private timingKeyframes = new Uint8Array(LiveVideoPlayer.TIMING_RING_SIZE);
  private timingLateness = new Float64Array(LiveVideoPlayer.TIMING_RING_SIZE);
  // Decode latency of on-time packets, for the least delay the picture needs
  private decodeLatencies = new Float64Array(DECODE_WINDOW);
  private decodeLatencyCount = 0;
  // A keyframe was asked for since the decoder last fell behind
  private backlogKeyframeRequested = false;
  private decodeLatencyWrite = 0;
  private decodeSorted = new Float64Array(DECODE_WINDOW);
  private videoMinimumDelayMs = 0;
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
      bufferDelayMs: config.bufferDelayMs ?? DEFAULT_BUFFER_DELAY_MS,
      enableAudio: config.enableAudio ?? true,
      audioDestination: config.audioDestination,
      displayLatencyMs: config.displayLatencyMs,
      videoTrackName: config.videoTrackName === undefined ? 'video' : config.videoTrackName,
      audioTrackName: config.audioTrackName === undefined ? 'audio' : config.audioTrackName,
      debugLogging: config.debugLogging ?? false,
    };

    this.clock = config.clock ?? new LiveClock({
      bufferDelayMs: this.config.bufferDelayMs,
      logger: (msg) => {
        if (this.config.debugLogging) this.logger.info(msg);
      },
    });

    // The context is created when audio first arrives, so a stream without audio never makes one
    if (config.audioContext) {
      this.audioContext = config.audioContext;
      this.ownsAudioContext = false;
    }

    this.frameQueue = new VideoFrameQueue<VideoFrame>({
      capacity: FRAME_QUEUE_CAPACITY,
      onDrop: (frame, reason, packetIndex, packetSeq) => this.handleFrameDropped(frame, reason, packetIndex, packetSeq),
    });
  }

  private handleFrameDropped(frame: VideoFrame, reason: FrameDropReason, packetIndex: number, packetSeq: number): void {
    this.playbackStats.markDropped(packetIndex, packetSeq);
    frame.close();
    if (reason === 'clear') return;

    this.consecutiveDrops++;
    // Only log drops if debug logging is enabled, batching quick successions
    if (this.config.debugLogging) {
      const now = Date.now();
      if (now - this.lastDropLogTime > 500 || this.consecutiveDrops === 1) {
        const total = this.frameQueue.dropped;
        if (this.consecutiveDrops > 1) {
          this.logger.warn(`Dropped ${this.consecutiveDrops} frames (${reason}), total=${total}`);
        } else {
          this.logger.warn(`Frame dropped (${reason}), total=${total}`);
        }
        this.lastDropLogTime = now;
        this.consecutiveDrops = 0;
      }
    }
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

  /** The clock the player plays on */
  getClock(): LiveClock {
    return this.clock;
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
   * Start playback. Audio becomes audible; it plays whatever the clock says is due, so on a
   * live stream playback picks up at the live edge.
   */
  play(): void {
    if (this._state === 'error') {
      return;
    }

    this.setState('playing');
    this.audioPlayer?.start();
    this.logger.info('Playback started');
  }

  /**
   * Pause playback: the picture holds and the audio mutes. The stream keeps arriving, so
   * play() resumes at the live edge.
   */
  pause(): void {
    if (this._state === 'playing') {
      this.setState('paused');
      this.audioPlayer?.stop();
      this.logger.info('Playback paused');
    }
  }

  /**
   * Get the video frame to show now
   *
   * Call this in your render loop. The frame is the one the clock says will be due while it is
   * on screen (see `displayLatencyMs`); the argument is accepted for compatibility and not
   * used, so render loops on their own timeline (a fixed frame rate, say) get the same frame.
   *
   * The player owns the returned frame and closes it when the next frame is due,
   * so it is valid until the following call. Do not close it - draw from it, or
   * `clone()` it if you need to hold on to it.
   */
  getVideoFrame(_timestampMs?: number): VideoFrame | null {
    if (this._state !== 'playing') {
      return this.lastVideoFrame;
    }

    const now = performance.now();
    const interval = now - this.lastRenderCall;
    if (this.lastRenderCall >= 0 && interval >= 4 && interval <= 100) {
      this.renderIntervalMs += STATS_SMOOTHING * (interval - this.renderIntervalMs);
    }
    this.lastRenderCall = now;
    const at = now + this.displayLeadMs();
    const bypass = this.clock.getBufferDelay() === 0;
    const due = bypass ? null : this.clock.ptsAt(at);

    if (this.config.debugLogging && now - this.statusLogTime > 5000) {
      this.statusLogTime = now;
      this.logStatus();
    }

    const frame = bypass
      ? this.frameQueue.takeNewest()
      : due === null ? null : this.frameQueue.take(due);

    if (due !== null && this.frameQueue.size > 0) {
      const aheadMs = Math.max(0, (this.frameQueue.newestTimestamp - due) / 1000);
      this.avgBufferMs += STATS_SMOOTHING * (aheadMs - this.avgBufferMs);
    }

    if (frame) {
      this.consecutiveDrops = 0;
      // Up to when it will be on screen, the moment it was picked for
      this.playbackStats.recordLatency(this.frameQueue.takenArrivalTime, this.frameQueue.takenDecodeTime, at);
      this.measureSync(this.frameQueue.takenTimestamp, at);

      // Close the previous frame
      if (this.lastVideoFrame && this.lastVideoFrame !== frame) {
        this.lastVideoFrame.close();
      }
      this.lastVideoFrame = frame;
    }

    return this.lastVideoFrame;
  }

  /** How far ahead of the getVideoFrame() call frames are picked: until they are on screen */
  private displayLeadMs(): number {
    return this.config.displayLatencyMs ?? 1.5 * this.renderIntervalMs;
  }

  /** The audio to keep sync with: the player's own, or what else plays on its clock (elmo's way) */
  private syncAudio(): ClockAudio | null {
    return this.audioPlayer ?? this.clock.getAudio();
  }

  /** Compare a frame going on screen at `atMs` with the audio heard then. */
  private measureSync(frameTimestampUs: number, atMs: number): void {
    const heard = this.syncAudio()?.audiblePtsAt(atMs) ?? null;
    if (heard === null) return;
    const halfFrameUs = 500_000 / (this.estimatedFrameRate || 30);
    const offsetMs = (frameTimestampUs + halfFrameUs - heard) / 1000;
    // A stale reading across a jump says nothing about sync
    if (Math.abs(offsetMs) > 1000) return;
    this.avSyncMs = this.avSyncMs === null ? offsetMs : this.avSyncMs + STATS_SMOOTHING * (offsetMs - this.avSyncMs);
  }

  /**
   * Set buffer delay in milliseconds. This is the clock's delay: on a shared clock it applies
   * to every player on it.
   */
  setBufferDelay(delayMs: number): void {
    this.config.bufferDelayMs = delayMs;
    this.clock.setBufferDelay(delayMs);
  }

  /**
   * Get current buffer delay in milliseconds
   */
  getBufferDelay(): number {
    return this.clock.getBufferDelay();
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
      this.frameQueue.clear();

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
      this.frameQueue.clear();
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
    this.frameQueue.clear();

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
    // Update bandwidth calculation
    this.updateBandwidthStats();

    const due = this.clock.ptsAt();
    const newest = this.frameQueue.newestTimestamp;
    const bufferMs = due !== null && newest === newest ? Math.max(0, Math.round((newest - due) / 1000)) : 0;
    const clockStats = this.clock.getStats();

    return {
      bufferSize: this.frameQueue.size,
      bufferMs,
      avgBufferMs: Math.round(this.avgBufferMs),
      targetBufferMs: this.clock.getBufferDelay(),
      droppedFrames: this.frameQueue.dropped,
      totalFrames: this.frameQueue.pushed,
      decoderState: this.decoder?.state ?? 'none',
      streamWidth: this.streamWidth,
      streamHeight: this.streamHeight,
      frameRate: this.estimatedFrameRate,
      latency: this.playbackStats.getLatencyStats(),
      bandwidth: this.currentBandwidth,
      sync: {
        clockRunning: clockStats.running,
        clockRate: clockStats.rate,
        clockErrorMs: clockStats.errorMs,
        clockJumps: clockStats.jumps,
        avSyncMs: this.avSyncMs === null ? null : Math.round(this.avSyncMs * 10) / 10,
        lateFrames: this.lateFrames,
        effectiveDelayMs: clockStats.effectiveDelayMs,
        minimumDelayMs: clockStats.minimumDelayMs,
        videoMinimumDelayMs: this.videoMinimumDelayMs,
        displayLeadMs: Math.round(this.displayLeadMs() * 10) / 10,
        audio: this.syncAudio()?.getStats() ?? null,
      },
    };
  }

  private logStatus(): void {
    const s = this.getStats();
    const sync = s.sync;
    this.logger.info(
      `buffer=${s.bufferMs}ms/${s.targetBufferMs}ms (${s.bufferSize} frames), dropped=${s.droppedFrames}, ` +
      `late=${sync.lateFrames}, clock rate=${sync.clockRate.toFixed(4)} err=${sync.clockErrorMs}ms, ` +
      `av=${sync.avSyncMs ?? '-'}ms, fps=${s.frameRate}`
    );
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
    return this.playbackStats.getPacketTimingHistory();
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

    const arrivalMs = performance.now();

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
      this.handleAudioData(data, arrivalMs);
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

    const codecData = data.header.media?.codecData;
    if (!codecData) {
      return;
    }

    const isKeyframe = !!(data.header.media?.keyframe);
    const codecChanged = codecDataChanged(this.currentCodecData, codecData);

    // The clock learns from every packet as it arrives, whatever becomes of it
    if (event.trackName !== this.clockTrackName) {
      this.clockTrackName = event.trackName;
      this.clockTrackKey = `video:${event.trackName}`;
    }
    const timebase = codecChanged ? timebaseFromCodecData(codecData) : this.currentTimebase;
    this.clock.onPacket(this.clockTrackKey, rescaleTime(data.header.media?.pts ?? 0, timebase, MICROSECOND_TIMEBASE), arrivalMs);
    this.packetLatenessMs = this.clock.packetLatenessMs;

    // Check for codec changes
    if (codecChanged) {
      // Need keyframe to reconfigure
      if (!isKeyframe) {
        this.logger.debug('Waiting for keyframe (codec change)');
        return;
      }

      // Decoder construction happens outside configureDecoder's own try, so this can
      // reject - handle it here rather than as an unhandled rejection
      this.reconfigureAndReplay(data, codecData)
        .catch((error) => {
          this.isConfiguring = false;
          this.pendingDuringConfig = [];
          this.logger.error(`Decoder reconfiguration failed: ${error}`);
          this.emit1('error', error instanceof Error ? error : new Error(String(error)));
        });
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

    this.decodeVideoFrame(data);
  }

  /** Decode one video frame: dropped while waiting for a keyframe, else timed and sent on. */
  private decodeVideoFrame(data: ParsedFrame): void {
    if (!this.decoder || !data.header?.media) return;
    const isKeyframe = !!data.header.media.keyframe;

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

      // A decoder that has fallen behind - stopped while the tab was hidden, or given a group at
      // once by a new subscription - only keeps pace afterwards, so its backlog would stay for
      // good. What waits longer than the delay is late anyway: at a keyframe the waiting chunks
      // are let go and decoding carries on from it. The decoder is not restarted, so nothing
      // stalls while it starts up again.
      const backlogMs = (timestampUs - this.decoder.oldestQueuedTimestamp) / 1000;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const behind = backlogMs > this.decodeBacklogLimitMs();
      let waits = backlogMs === backlogMs;
      if (behind && isKeyframe) {
        const skipped = this.decoder.discardQueued();
        this.logger.warn(`Decoder ${Math.round(backlogMs)} ms behind, skipping ${skipped} frames to a keyframe`);
        this.backlogKeyframeRequested = false;
        waits = false;
      } else if (behind && !hidden && !this.backlogKeyframeRequested) {
        // Rather than wait up to a group for the next one
        this.backlogKeyframeRequested = true;
        this.streamSource?.requestKeyframe?.();
      }
      // A frame waiting behind others, or in a hidden tab, says nothing about how long decoding
      // takes: keep it out of the latency the picture is given (as a replayed one). Counted, a
      // backlog would raise the delay, the delay the backlog allowed, and so on for good.
      this.recordPacketTiming(timestampUs, arrivalTime, isKeyframe, waits || hidden ? NaN : this.packetLatenessMs);

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
    keyframeData: ParsedFrame,
    codecData: IMediaCodecData
  ): Promise<void> {
    this.currentCodecData = codecData;
    this.currentTimebase = timebaseFromCodecData(codecData);
    this.isConfiguring = true;
    this.pendingDuringConfig = [keyframeData]; // Queue the keyframe itself

    // Stream timestamps often restart across a codec change, so drop the timing
    // history rather than risk matching a new frame against a stale entry
    this.timingWrite = 0;
    this.timingCount = 0;

    try {
      await this.configureDecoder(codecData);
    } finally {
      // Always clear the flag, otherwise every later frame would be queued
      this.isConfiguring = false;
    }

    this.waitingForKeyframe = true;

    // Replay what arrived while configuring, from the newest keyframe: anything older
    // would only be decoded to be dropped. Frames older than the clock are decoded (the
    // chain needs them) and then dropped by the queue.
    const queued = this.pendingDuringConfig;
    this.pendingDuringConfig = [];
    const pending = framesFromLastKeyframe(queued);
    this.logger.info(`Processing ${pending.length} of ${queued.length} frames queued during configuration`);
    // Replayed now, not as they arrived: their decode latency means nothing
    this.packetLatenessMs = NaN;
    for (const pendingData of pending) {
      this.decodeVideoFrame(pendingData);
    }
  }

  /** Record a packet's arrival time, keyframe flag and lateness in the timing ring */
  private recordPacketTiming(timestampUs: number, arrivalTime: number, isKeyframe: boolean, latenessMs: number): void {
    const i = this.timingWrite;
    this.timingTimestamps[i] = timestampUs;
    this.timingArrivals[i] = arrivalTime;
    this.timingKeyframes[i] = isKeyframe ? 1 : 0;
    this.timingLateness[i] = latenessMs;
    this.timingWrite = (i + 1) % LiveVideoPlayer.TIMING_RING_SIZE;
    if (this.timingCount < LiveVideoPlayer.TIMING_RING_SIZE) {
      this.timingCount++;
    }
  }

  /**
   * How far behind the newest packet the decoder may be before it counts as behind: the delay,
   * past which its frames come out late. The backlog is kept out of the delay, so the two never
   * raise each other.
   */
  private decodeBacklogLimitMs(): number {
    return this.clock.getEffectiveDelay();
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
  private handleAudioData(data: ParsedFrame, arrivalMs: number): void {
    if (!this.config.enableAudio) {
      return;
    }

    // Check for codec changes
    const codecData = data.header?.media?.codecData;
    if (codecData && codecDataChanged(this.audioCodecData ?? undefined, codecData)) {
      // initAudioPlayer handles its own failures, but guard the promise so an
      // unexpected throw can't surface as an unhandled rejection
      this.initAudioPlayer(codecData, data, arrivalMs)
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
        this.pendingAudioDuringInit.push({ frame: data, arrivalMs });
      }
      return;
    }

    this.decodeAudioFrame(data, arrivalMs);
  }

  /** Hand an audio frame to the audio player */
  private decodeAudioFrame(data: ParsedFrame, arrivalMs: number): void {
    if (this.audioPlayer && data.payload && data.header) {
      // Rescale to microseconds, the unit the audio player expects
      const timestampUs = rescaleTime(
        data.header.media?.pts ?? 0,
        this.audioTimebase,
        MICROSECOND_TIMEBASE
      );
      this.audioPlayer.decode(data.payload, timestampUs, arrivalMs);
    }
  }

  /**
   * Create and initialize the audio player for new codec data, then decode the
   * frame that carried it along with anything that arrived while initializing.
   */
  private async initAudioPlayer(codecData: IMediaCodecData, firstFrame: ParsedFrame, arrivalMs: number): Promise<void> {
    // Set before awaiting so frames arriving during init don't trigger a second init
    this.audioCodecData = codecData;
    this.audioTimebase = timebaseFromCodecData(codecData);
    this.audioInitializing = true;
    this.pendingAudioDuringInit = [{ frame: firstFrame, arrivalMs }];

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
        this.audioContext = new AudioContext();
        this.ownsAudioContext = true;
      }

      player = new LiveAudioPlayer(this.audioContext, {
        clock: this.clock,
        destination: this.config.audioDestination,
      });
      this.audioPlayer = player;

      // Initialize with codec data
      await player.init(codecData);

      // Re-apply the caller's desired volume to the fresh audio player
      player.setVolume(this.volume);

      // Audible only while playing; it keeps to the clock either way
      if (this._state === 'playing') {
        player.start();
      }
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
        for (const p of pending) {
          this.decodeAudioFrame(p.frame, p.arrivalMs);
        }
      }
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
          maxQueueSize: MAX_DECODE_QUEUE,
        });
      } else {
        this.logger.info(`Using WebCodecs decoder (${this.config.preferredDecoder})`);
        this.decoder = new WebCodecsDecoder({
          logger: this.logger,
          onFrameDecoded: (frame) => this.handleDecodedFrame(frame),
          onError: (error) => this.handleDecoderError(error),
          onQueueOverflow: (queueSize) => this.handleQueueOverflow(queueSize),
          maxQueueSize: MAX_DECODE_QUEUE,
          maxInDecoder: MAX_IN_DECODER,
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
   * Queue a decoded frame for display. Frames the clock has already passed are counted late;
   * the queue keeps the newest of them and lets the rest go.
   */
  private queueDecodedFrame(frame: VideoFrame, timestampUs: number): void {
    const decodeTime = performance.now();
    const i = this.findPacketTiming(timestampUs);
    const arrivalTime = i >= 0 ? this.timingArrivals[i] : decodeTime;
    const isKeyframe = i >= 0 ? this.timingKeyframes[i] === 1 : false;
    this.playbackStats.recordPacket(arrivalTime, timestampUs, isKeyframe, decodeTime, i >= 0 ? this.timingLateness[i] : NaN);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (i >= 0 && this.timingLateness[i] <= ON_TIME_MS && !hidden) {
      this.recordDecodeLatency(decodeTime - arrivalTime);
    }

    let due: number | null = null;
    if (this.clock.getBufferDelay() > 0) {
      due = this.clock.ptsAt(decodeTime);
      // Late if it was due on screen before it could get there
      const dueOnScreen = this.clock.ptsAt(decodeTime + this.displayLeadMs());
      if (dueOnScreen !== null && timestampUs < dueOnScreen) this.lateFrames++;
      // Before the clock starts, the backlog a subscription opens with is already behind it
      if (due === null) due = this.clock.targetAt(decodeTime);
    }

    // Hold every frame the delay spans, or frames are dropped before their turn (1 s at 50 fps is 50)
    const needed = Math.min(FRAME_QUEUE_MAX, Math.ceil(((this.clock.getEffectiveDelay() + 200) / 1000) * this.estimatedFrameRate) + 4);
    if (needed > this.frameQueue.maxSize) this.frameQueue.setCapacity(needed);

    this.frameQueue.push(frame, timestampUs, arrivalTime, decodeTime, due,
      this.playbackStats.lastPacketIndex, this.playbackStats.lastPacketSeq);
  }

  /**
   * Track how long decoding takes, and tell the clock the least delay at which the picture is on
   * time: the decode latency of nine packets in ten, plus how far ahead of the screen frames are
   * picked.
   */
  private recordDecodeLatency(latencyMs: number): void {
    this.decodeLatencies[this.decodeLatencyWrite] = latencyMs;
    this.decodeLatencyWrite = (this.decodeLatencyWrite + 1) % DECODE_WINDOW;
    if (this.decodeLatencyCount < DECODE_WINDOW) this.decodeLatencyCount++;
    if (this.decodeLatencyCount < 15 || this.decodeLatencyWrite % 15 !== 0) return;

    const n = this.decodeLatencyCount;
    const sorted = this.decodeSorted.subarray(0, n);
    sorted.set(this.decodeLatencies.subarray(0, n));
    sorted.sort();
    const p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))];
    const minimum = Math.ceil(p90 + this.displayLeadMs() + 2);
    if (minimum !== this.videoMinimumDelayMs) {
      this.videoMinimumDelayMs = minimum;
      this.clock.setMinimumDelay(this.clockTrackKey, minimum);
    }
  }

  /**
   * Handle decoded video frame (from WebCodecs)
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    // Listeners see the frame before the queue can let it go
    this.emit1('frame', frame);
    this.queueDecodedFrame(frame, frame.timestamp);
  }

  /**
   * Handle decoded YUV frame (from WASM decoder)
   * Converts YUV to VideoFrame using canvas
   */
  private handleDecodedYUVFrame(yuvFrame: YUVFrame): void {
    // Pass actual video dimensions for visible rect (decoder may output padded dimensions)
    const videoFrame = this.convertYUVToVideoFrame(yuvFrame, this.streamWidth, this.streamHeight);
    if (videoFrame) {
      this.emit1('frame', videoFrame);
      this.queueDecodedFrame(videoFrame, yuvFrame.timestamp);
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

      // Create VideoFrame with I420 format - browser handles YUV→RGB
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
   * The decoder dropped a delta frame because its queue is full. What is queued keeps
   * decoding and showing; decoding resumes at the next keyframe, which the decoder
   * accepts even with a full queue (it carries on from it). Resetting here would throw the
   * queued frames away and black out until that keyframe for no gain.
   */
  private handleQueueOverflow(queueSize: number): void {
    const now = Date.now();
    if (!this.lastOverflowLog || now - this.lastOverflowLog > 1000) {
      this.logger.warn(`Decoder queue full (${queueSize} frames), dropping until the next keyframe`);
      this.lastOverflowLog = now;
    }
    this.waitingForKeyframe = true;
  }

  /**
   * Dispose the player and release resources
   */
  dispose(): void {
    // The clock may live on with other players: this one no longer needs anything of it
    this.clock.clearMinimumDelay(this.clockTrackKey);
    this.videoMinimumDelayMs = 0;
    this.decodeLatencyCount = 0;

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
    this.frameQueue.clear();

    // Close last frame
    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }

    // Clear timing tracking
    this.timingWrite = 0;
    this.timingCount = 0;
    this.yuvScratch = null;
    this.playbackStats.reset();

    // Reset state
    this.currentCodecData = undefined;
    this.currentTimebase = MICROSECOND_TIMEBASE;
    this.waitingForKeyframe = true;
    this.consecutiveDrops = 0;
    this.lateFrames = 0;
    this.avSyncMs = null;

    this.warnedVideoTracks.clear();

    // Deliver the final statechange before dropping the handlers
    this.setState('idle');
    this.clearEventHandlers();

    this.logger.info('Player disposed');
  }
}
