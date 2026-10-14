/**
 * File Video Player
 *
 * Plays MP4 files with seeking, play/pause and looping. mp4box demuxes, WebCodecs decodes.
 *
 * Timing: a MediaClock holds the playback position - running while playing, held while paused.
 * getVideoFrame() hands out the frame due at it, and the audio keeps to it the way live audio
 * keeps to a LiveClock: placed by its timestamps and heard when due, the audio device's drift
 * taken out. Looping carries the timeline on (the next pass's samples are fed with the file's
 * duration added), so a loop is as seamless as the middle of the file.
 */

import { MP4FileSource, MP4FileInfo, DecodableSample } from '../sources/mp4-file-source';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';
import { FileAudioPlayer, FileAudioStats } from '../audio/file-audio-player';
import { MediaClock } from '../sync/media-clock';
import { VideoFrameQueue } from '../scheduling/video-frame-queue';
import type { PreferredDecoder } from '../types';
import { BasePlayer } from './base-player';

/**
 * Play mode for file playback
 */
export type FilePlayMode = 'once' | 'loop';

/**
 * File player configuration
 */
export interface FilePlayerConfig {
  preferredDecoder?: PreferredDecoder;
  /** Enable audio playback */
  enableAudio?: boolean;
  /** Audio context to use (creates one if not provided) */
  audioContext?: AudioContext;
  /** Node the audio goes to (default: the context's destination) */
  audioDestination?: AudioNode;
  /** Enable debug logging */
  debugLogging?: boolean;
  /** Play mode: 'once' plays to end, 'loop' seamlessly loops (default: 'once') */
  playMode?: FilePlayMode;
  /**
   * Maximum number of decoded frames to hold ahead of the playback position
   * (default: 60). Each buffered frame holds full decoded video memory, so this
   * bounds how much the decoder may run ahead.
   */
  maxBufferedFrames?: number;
  /**
   * How far ahead of the getVideoFrame() call to pick the frame, in ms. By default 1.5 render
   * intervals, measured from how often getVideoFrame() is called: a frame drawn now is on screen
   * from the next refresh, for one refresh. Set a number for a display pipeline with more
   * latency, or 0 to pick for the moment of the call.
   */
  displayLatencyMs?: number;
  /** @deprecated Use playMode instead */
  loop?: boolean;
}

/**
 * File player state
 */
export type FilePlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * File player statistics
 */
export interface FilePlayerStats {
  duration: number;
  position: number;
  bufferSize: number;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  state: FilePlayerState;
  /** The audio player's statistics; null without audio */
  audio: FileAudioStats | null;
}

/**
 * Coerce a thrown value into an Error, so 'error' handlers always receive one
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Audio is decoded this far ahead of the playback position (the worklet's ring holds 2.7 s) */
const AUDIO_AHEAD_US = 1_500_000;
/** Chunks the video decoder may hold; WebCodecsDecoder drops delta frames beyond 10 */
const MAX_DECODER_QUEUE = 8;
/** Feeding runs this often besides render calls, so audio keeps going in a background tab */
const PUMP_INTERVAL_MS = 100;
/** Video this far behind the position is skipped to the keyframe before the position */
const CATCH_UP_US = 1_000_000;
/** Weight of the newest sample in the render interval average */
const RENDER_SMOOTHING = 0.1;

/**
 * File Video Player
 */
export class FileVideoPlayer extends BasePlayer<FilePlayerState> {
  private config: FilePlayerConfig;

  // Source and decoder
  private fileSource: MP4FileSource | null = null;
  private decoder: WebCodecsDecoder | null = null;
  private fileInfo: MP4FileInfo | null = null;

  // Audio
  private audioContext: AudioContext | null = null;
  private audioPlayer: FileAudioPlayer | null = null;
  private ownsAudioContext: boolean = false;
  private volume: number = 1;

  // Timeline
  private readonly clock = new MediaClock();
  private durationUs = 0;
  private lastLoop = 0;

  // Encoded samples of the whole file, kept for seeking and looping
  private videoSamples: DecodableSample[] = [];
  private audioSamples: DecodableSample[] = [];
  // Next sample to feed, and the pass of the file it belongs to (its timestamps move on by a duration a pass)
  private nextVideo = 0;
  private videoPass = 0;
  private nextAudio = 0;
  private audioPass = 0;

  // Decoded frames
  private frameQueue: VideoFrameQueue<VideoFrame>;
  private maxFrameBuffer: number;
  private lastVideoFrame: VideoFrame | null = null;
  private renderIntervalMs = 1000 / 60;
  private lastRenderCall = -1;

  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private firstFrameResolve: (() => void) | null = null;

  constructor(config: FilePlayerConfig = {}) {
    super('idle', config.debugLogging ?? false);

    // Handle deprecated loop option
    const playMode = config.playMode ?? (config.loop ? 'loop' : 'once');

    this.config = {
      preferredDecoder: config.preferredDecoder ?? 'webcodecs-sw',
      enableAudio: config.enableAudio ?? true, // Audio on by default
      audioDestination: config.audioDestination,
      displayLatencyMs: config.displayLatencyMs,
      debugLogging: config.debugLogging ?? false,
      playMode,
      maxBufferedFrames: config.maxBufferedFrames ?? 60,
    };

    this.maxFrameBuffer = Math.max(3, this.config.maxBufferedFrames!);
    this.frameQueue = new VideoFrameQueue<VideoFrame>({
      capacity: this.maxFrameBuffer + MAX_DECODER_QUEUE,
      onDrop: (frame) => frame.close(),
    });

    if (config.audioContext) {
      this.audioContext = config.audioContext;
      this.ownsAudioContext = false;
    }
  }

  /**
   * Get file info
   */
  getFileInfo(): MP4FileInfo | null {
    return this.fileInfo;
  }

  /**
   * Get current position in seconds
   */
  getPosition(): number {
    return this.mediaPositionUs(this.clock.ptsAt()) / 1_000_000;
  }

  /**
   * Get duration in seconds
   */
  getDuration(): number {
    return this.fileInfo?.duration ?? 0;
  }

  /**
   * Get player statistics
   */
  getStats(): FilePlayerStats {
    return {
      duration: this.getDuration(),
      position: this.getPosition(),
      bufferSize: this.frameQueue.size,
      width: this.fileInfo?.width ?? 0,
      height: this.fileInfo?.height ?? 0,
      frameRate: this.fileInfo?.frameRate ?? 0,
      codec: this.fileInfo?.videoCodec ?? '',
      state: this._state,
      audio: this.audioPlayer?.getStats() ?? null,
    };
  }

  /**
   * Set play mode ('once' or 'loop')
   */
  setPlayMode(mode: FilePlayMode): void {
    this.config.playMode = mode;
    this.logger.debug(`Play mode set to: ${mode}`);
  }

  /**
   * Get current play mode
   */
  getPlayMode(): FilePlayMode {
    return this.config.playMode ?? 'once';
  }

  /**
   * Set looping (convenience method, equivalent to setPlayMode)
   * @deprecated Use setPlayMode instead
   */
  setLoop(loop: boolean): void {
    this.config.playMode = loop ? 'loop' : 'once';
  }

  /**
   * Enable/disable debug logging
   */
  override setDebugLogging(enabled: boolean): void {
    this.config.debugLogging = enabled;
    super.setDebugLogging(enabled);
  }

  /**
   * Set audio volume (0-1)
   *
   * The value is remembered and re-applied whenever the audio decoder is
   * (re)initialized, so calls made before the decoder is ready are not lost.
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
   * Load a video file from URL
   */
  async loadFromUrl(url: string): Promise<MP4FileInfo> {
    return this.load((source) => source.loadFromUrl(url));
  }

  /**
   * Load a video file from File object
   */
  async loadFromFile(file: File): Promise<MP4FileInfo> {
    return this.load((source) => source.loadFromFile(file));
  }

  private async load(open: (source: MP4FileSource) => Promise<MP4FileInfo>): Promise<MP4FileInfo> {
    this.setState('loading');

    try {
      this.dispose();
      this.setState('loading');

      this.fileSource = new MP4FileSource({
        onReady: (info) => {
          this.logger.info(`File loaded: ${info.width}x${info.height} @ ${info.frameRate?.toFixed(1)}fps, codec: ${info.videoCodec}`);
        },
        onSamples: (samples) => this.handleSamples(samples),
        onError: (error) => {
          this.logger.error(`File source error: ${error.message}`);
          this.setState('error');
          this.emit('error', error);
        },
        onProgress: (loaded, total) => {
          this.emit('progress', loaded, total);
        },
      });

      this.fileInfo = await open(this.fileSource);
      this.durationUs = this.fileInfo.duration * 1_000_000;

      await this.initDecoders();
      this.startPump();

      // Ready once the first picture has decoded
      await this.waitForFirstFrame();

      this.setState('ready');
      this.emit('ready', this.fileInfo);

      return this.fileInfo;
    } catch (error) {
      this.setState('error');
      this.emit('error', toError(error));
      throw error;
    }
  }

  /**
   * Initialize the video decoder, and the audio player if the file has audio
   */
  private async initDecoders(): Promise<void> {
    if (!this.fileInfo || !this.fileSource) {
      throw new Error('File not loaded');
    }

    this.decoder = new WebCodecsDecoder({
      preferHardware: this.config.preferredDecoder === 'webcodecs-hw',
      onFrame: (frame) => this.handleDecodedFrame(frame),
      onError: (error) => {
        this.logger.error(`Decoder error: ${error.message}`);
        this.emit('error', error);
      },
    });

    const description = this.fileSource.getVideoDescription();
    await this.decoder.configure({
      codec: this.fileInfo.videoCodec,
      codedWidth: this.fileInfo.width,
      codedHeight: this.fileInfo.height,
      description: description ?? undefined,
    });
    this.logger.info(`Decoder configured: ${this.fileInfo.videoCodec}`);

    if (this.config.enableAudio && this.fileInfo.audioCodec) {
      await this.initAudio();
    }

    this.feed();
  }

  private async initAudio(): Promise<void> {
    if (!this.fileInfo || !this.fileSource) return;

    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        this.ownsAudioContext = true;
      }
      const player = new FileAudioPlayer(this.audioContext, {
        clock: this.clock,
        destination: this.config.audioDestination,
      });
      await player.init(
        this.fileInfo.audioCodec!,
        this.fileInfo.audioSampleRate ?? 48000,
        this.fileInfo.audioChannels ?? 2,
        this.fileSource.getAudioDescription() ?? undefined
      );
      player.setVolume(this.volume);
      this.audioPlayer = player;
      this.logger.info(`Audio decoder configured: ${this.fileInfo.audioCodec}`);
    } catch (error) {
      this.logger.warn(`Failed to initialize audio: ${error}`);
      this.audioPlayer = null;
    }
  }

  /**
   * Resolve once the first frame has decoded. Times out after 5 seconds - with a hint when the
   * moov atom sits at the end of the file - unless something decoded by then.
   */
  private waitForFirstFrame(): Promise<void> {
    if (this.frameQueue.size > 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.firstFrameResolve = null;
        if (this.frameQueue.size > 0) {
          resolve();
          return;
        }
        const moovWarning = this.fileInfo?.isMoovAtStart === false
          ? ' The moov atom is not at the start of the file - please re-encode with "faststart" option (e.g., ffmpeg -movflags +faststart).'
          : '';
        reject(new Error(`Timeout waiting for frames to decode.${moovWarning}`));
      }, 5000);

      this.firstFrameResolve = () => {
        clearTimeout(timeout);
        this.firstFrameResolve = null;
        resolve();
      };
    });
  }

  /**
   * Keep the samples the source extracts: all of them are kept, for seeking and looping
   */
  private handleSamples(samples: DecodableSample[]): void {
    for (const sample of samples) {
      if (sample.type === 'video') {
        this.videoSamples.push(sample);
      } else {
        this.audioSamples.push(sample);
      }
    }
    this.feed();
  }

  /** Feeding runs on a timer too, so audio keeps coming in a background tab without renders */
  private startPump(): void {
    this.stopPump();
    this.pumpTimer = setInterval(() => this.feed(), PUMP_INTERVAL_MS);
  }

  private stopPump(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
  }

  /** Whether all of a track's samples are in hand, so its next pass can start */
  private trackComplete(type: 'video' | 'audio'): boolean {
    const counts = this.fileSource?.getSampleCounts();
    if (!counts) return false;
    return type === 'video'
      ? this.videoSamples.length >= counts.video
      : this.audioSamples.length >= counts.audio;
  }

  /**
   * Hand the decoders what comes next: video while the frames held stay within bounds, audio
   * up to AUDIO_AHEAD_US past the position. Advances the end of the file and the loop.
   */
  private feed(): void {
    if (!this.fileInfo) return;
    const position = this.clock.ptsAt();
    this.feedVideo(position);
    this.feedAudio(position);
    this.checkEnd(position);
  }

  private feedVideo(position: number): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    // Nothing is drawn in a background tab; it catches up from a keyframe on return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    this.skipVideoTo(position);

    while (decoder.decodeQueueSize < MAX_DECODER_QUEUE &&
           this.frameQueue.size + decoder.decodeQueueSize < this.maxFrameBuffer) {
      if (this.nextVideo >= this.videoSamples.length) {
        if (this.config.playMode !== 'loop' || !this.trackComplete('video') || this.videoSamples.length === 0) break;
        this.nextVideo = 0;
        this.videoPass++;
      }
      const sample = this.videoSamples[this.nextVideo++];
      decoder.decode({
        data: sample.data,
        timestamp: sample.timestamp + this.videoPass * this.durationUs,
        duration: sample.duration,
        isKeyframe: sample.isKeyframe,
      });
    }
  }

  /**
   * When the next video sample is far behind the position (back from a background tab, say),
   * skip to the last keyframe at or before it rather than decode the way there
   */
  private skipVideoTo(position: number): void {
    const offset = this.videoPass * this.durationUs;
    const next = this.videoSamples[this.nextVideo];
    if (!next || next.timestamp + offset >= position - CATCH_UP_US) return;

    let keyframe = -1;
    for (let i = this.nextVideo; i < this.videoSamples.length; i++) {
      const s = this.videoSamples[i];
      if (s.timestamp + offset > position) break;
      if (s.isKeyframe) keyframe = i;
    }
    if (keyframe > this.nextVideo) {
      this.nextVideo = keyframe;
    }
  }

  private feedAudio(position: number): void {
    const audio = this.audioPlayer;
    if (!audio) return;

    for (;;) {
      if (this.nextAudio >= this.audioSamples.length) {
        if (this.config.playMode !== 'loop' || !this.trackComplete('audio') || this.audioSamples.length === 0) break;
        this.nextAudio = 0;
        this.audioPass++;
      }
      const sample = this.audioSamples[this.nextAudio];
      const timestamp = sample.timestamp + this.audioPass * this.durationUs;
      if (timestamp > position + AUDIO_AHEAD_US) break;
      this.nextAudio++;
      // Audio already behind the position would only be dropped
      if (timestamp + sample.duration < position) continue;
      audio.decode(sample.data, timestamp, sample.duration);
    }
  }

  /** The end of the file: stop there, or report the loop */
  private checkEnd(position: number): void {
    if (this._state !== 'playing' || this.durationUs <= 0) return;

    if (this.config.playMode === 'loop') {
      const loop = Math.floor(position / this.durationUs);
      if (loop > this.lastLoop) {
        this.lastLoop = loop;
        this.emit('loop');
      }
      return;
    }

    if (position >= this.durationUs) {
      this.clock.pause();
      this.clock.seek(this.durationUs);
      this.audioPlayer?.stop();
      this.setState('ended');
      this.emit('ended');
    }
  }

  /** Position within the file for a position on the timeline, which runs on across loops */
  private mediaPositionUs(timelineUs: number): number {
    if (this.durationUs <= 0) return 0;
    if (this.config.playMode === 'loop') {
      return timelineUs - Math.floor(timelineUs / this.durationUs) * this.durationUs;
    }
    return Math.max(0, Math.min(timelineUs, this.durationUs));
  }

  /**
   * Queue a decoded frame; frames the position has passed are let go, but for the newest of them
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    const now = performance.now();
    this.frameQueue.push(frame, frame.timestamp, now, now, this.clock.ptsAt(now));
    this.firstFrameResolve?.();
    this.feed();
  }

  /**
   * Start playback
   */
  play(): void {
    if (this._state === 'error' || this._state === 'loading' || this._state === 'idle' || this._state === 'playing') {
      return;
    }

    // Playing after the end restarts from the beginning
    if (this._state === 'ended') {
      this.seekTo(0);
    }

    this.fileSource?.start();
    this.audioPlayer?.start();
    this.clock.play();

    this.setState('playing');
    this.logger.info(`Play from position ${this.getPosition().toFixed(3)}s`);
    this.feed();
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this._state !== 'playing') {
      return;
    }

    this.clock.pause();
    this.audioPlayer?.stop();

    this.setState('paused');
    this.logger.info(`Paused at position ${this.getPosition().toFixed(3)}s`);
  }

  /**
   * Seek to a time in seconds. Lands on that frame: decoding starts at the keyframe before it
   * and the frames in between are not shown.
   */
  async seek(timeSeconds: number): Promise<void> {
    if (!this.fileInfo) {
      return;
    }

    const time = Math.max(0, Math.min(timeSeconds, this.fileInfo.duration));
    this.logger.info(`Seeking to ${time.toFixed(3)}s`);
    this.seekTo(time * 1_000_000);

    // A seek from the end leaves the file playable again
    if (this._state === 'ended') {
      this.setState('paused');
    }

    this.emit('seeked', time);
  }

  private seekTo(targetUs: number): void {
    // The timeline starts over at the target: the passes count from it
    this.clock.seek(targetUs);
    this.videoPass = 0;
    this.audioPass = 0;
    this.lastLoop = 0;

    // Video from the last keyframe at or before the target, in decode order
    this.frameQueue.clear();
    this.decoder?.reset();
    let keyframe = 0;
    for (let i = 0; i < this.videoSamples.length; i++) {
      const sample = this.videoSamples[i];
      if (sample.isKeyframe && sample.timestamp <= targetUs) keyframe = i;
      if (sample.timestamp > targetUs && sample.isKeyframe) break;
    }
    this.nextVideo = keyframe;

    // Audio from the sample playing at the target, the output moved there first so what is fed
    // is not taken as late
    this.audioPlayer?.clear();
    this.audioPlayer?.resync();
    this.nextAudio = 0;
    while (this.nextAudio < this.audioSamples.length) {
      const sample = this.audioSamples[this.nextAudio];
      if (sample.timestamp + sample.duration > targetUs) break;
      this.nextAudio++;
    }

    this.feed();
  }

  /**
   * Get a video frame for rendering
   *
   * Call this in your render loop: it returns the frame due while it will be on screen.
   *
   * The player owns the returned frame and closes it when the next frame is due,
   * so it is valid until the following call. Do not close it - draw from it, or
   * `clone()` it if you need to hold on to it.
   */
  getVideoFrame(): VideoFrame | null {
    if (this._state === 'idle' || this._state === 'loading' || this._state === 'error') {
      return null;
    }

    const now = performance.now();
    const interval = now - this.lastRenderCall;
    if (this.lastRenderCall >= 0 && interval >= 4 && interval <= 100) {
      this.renderIntervalMs += RENDER_SMOOTHING * (interval - this.renderIntervalMs);
    }
    this.lastRenderCall = now;

    this.feed();

    let due = this.clock.ptsAt(now + (this.config.displayLatencyMs ?? 1.5 * this.renderIntervalMs));
    // Before anything has been shown, show the first frame there is (a file whose first frame
    // starts a little after zero still shows a picture while paused)
    if (!this.lastVideoFrame && this.frameQueue.size > 0) {
      due = Math.max(due, this.frameQueue.oldestTimestamp);
    }

    const frame = this.frameQueue.take(due);
    if (frame) {
      if (this.lastVideoFrame && this.lastVideoFrame !== frame) {
        this.lastVideoFrame.close();
      }
      this.lastVideoFrame = frame;
    }

    return this.lastVideoFrame;
  }

  /**
   * Subscribe to events (typed overloads)
   */
  override on(event: 'statechange', handler: (state: FilePlayerState) => void): void;
  override on(event: 'ready', handler: (info: MP4FileInfo) => void): void;
  override on(event: 'progress', handler: (loaded: number, total: number) => void): void;
  override on(event: 'error', handler: (error: Error) => void): void;
  override on(event: 'ended', handler: () => void): void;
  override on(event: 'loop', handler: () => void): void;
  override on(event: 'seeked', handler: (time: number) => void): void;
  override on(event: string, handler: Function): void {
    super.on(event, handler);
  }

  /**
   * Unsubscribe from events
   */
  override off(event: string, handler: Function): void {
    super.off(event, handler);
  }

  /**
   * Dispose and clean up resources
   * @param full - If true, also disposes the AudioContext (default: false for reload)
   */
  override dispose(full: boolean = false): void {
    this.stopPump();
    this.fileSource?.stop();

    // Release anyone waiting on the first frame so a reload can't strand them
    this.firstFrameResolve?.();
    this.firstFrameResolve = null;

    this.frameQueue.clear();
    this.videoSamples = [];
    this.audioSamples = [];
    this.nextVideo = 0;
    this.videoPass = 0;
    this.nextAudio = 0;
    this.audioPass = 0;
    this.lastLoop = 0;

    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }

    this.decoder?.dispose();
    this.decoder = null;

    this.audioPlayer?.dispose();
    this.audioPlayer = null;

    // Only close audio context on full dispose (not on reload)
    if (full && this.ownsAudioContext && this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.fileSource?.dispose();
    this.fileSource = null;

    this.fileInfo = null;
    this.durationUs = 0;
    this.clock.pause();
    this.clock.seek(0);

    // Don't clear event handlers here - let caller manage them
    // or call dispose() explicitly when done
    this.setState('idle');
  }
}

/**
 * Factory function to create a file player
 */
export function createFilePlayer(config: FilePlayerConfig = {}): FileVideoPlayer {
  return new FileVideoPlayer(config);
}
