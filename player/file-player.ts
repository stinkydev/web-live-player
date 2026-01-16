/**
 * File Video Player
 * 
 * Handles playback of MP4 files with seeking, play/pause, and frame timing.
 * Uses mp4box for demuxing and WebCodecs for decoding.
 */

import { MP4FileSource, MP4FileInfo, DecodableSample } from '../sources/mp4-file-source';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';
import { FileAudioPlayer } from '../audio/file-audio-player';
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
  /** Enable debug logging */
  debugLogging?: boolean;
  /** Play mode: 'once' plays to end, 'loop' seamlessly loops (default: 'once') */
  playMode?: FilePlayMode;
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
}

/**
 * Decoded frame with timing info
 */
interface TimedFrame {
  frame: VideoFrame;
  timestampMs: number;  // Presentation time in milliseconds
  durationMs: number;   // Frame duration in milliseconds
}

/**
 * File Video Player
 */
export class FileVideoPlayer extends BasePlayer<FilePlayerState> {
  private config: FilePlayerConfig;
  
  // Source and decoder
  private fileSource: MP4FileSource | null = null;
  private decoder: WebCodecsDecoder | null = null;
  
  // Audio
  private audioContext: AudioContext | null = null;
  private audioPlayer: FileAudioPlayer | null = null;
  private ownsAudioContext: boolean = false;
  private audioInitialized: boolean = false;
  
  // File info
  private fileInfo: MP4FileInfo | null = null;
  
  // Frame buffer - sorted by timestamp
  private frameBuffer: TimedFrame[] = [];
  private minBufferSize: number = 3; // Minimum frames before starting playback (100ms at 30fps)
  
  // Sample queues - video and audio samples waiting to be decoded
  private sampleQueue: DecodableSample[] = [];
  private audioSampleQueue: DecodableSample[] = [];
  private nextSampleIndex: number = 0;
  private nextAudioSampleIndex: number = 0;
  private maxDecoderQueue: number = 10; // Max chunks to keep in decoder queue
  
  // Buffer ready promise - resolves when enough frames are buffered
  private bufferReadyResolve: (() => void) | null = null;
  
  // Playback state
  private playStartTime: number = 0;      // performance.now() when play started
  private playStartPosition: number = 0;  // Video position when play started (ms)
  private currentPosition: number = 0;    // Current position in video (ms)
  private lastVideoFrame: VideoFrame | null = null;
  
  // Seeking state
  private isSeeking: boolean = false;
  
  constructor(config: FilePlayerConfig = {}) {
    super('idle', config.debugLogging ?? false);
    
    // Handle deprecated loop option
    const playMode = config.playMode ?? (config.loop ? 'loop' : 'once');
    
    this.config = {
      preferredDecoder: config.preferredDecoder ?? 'webcodecs-sw',
      enableAudio: config.enableAudio ?? true, // Audio on by default
      debugLogging: config.debugLogging ?? false,
      playMode,
    };
    
    // Handle audio context
    if (config.audioContext) {
      this.audioContext = config.audioContext;
      this.ownsAudioContext = false;
    } else if (this.config.enableAudio) {
      this.audioContext = new AudioContext();
      this.ownsAudioContext = true;
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
    return this.currentPosition / 1000;
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
      bufferSize: this.frameBuffer.length,
      width: this.fileInfo?.width ?? 0,
      height: this.fileInfo?.height ?? 0,
      frameRate: this.fileInfo?.frameRate ?? 0,
      codec: this.fileInfo?.videoCodec ?? '',
      state: this._state,
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
    // Note: We don't have a way to read current volume from FileAudioPlayer,
    // so we track it here if needed. For now, return 1 as default.
    return 1;
  }
  
  /**
   * Load a video file from URL
   */
  async loadFromUrl(url: string): Promise<MP4FileInfo> {
    this.setState('loading');
    
    try {
      this.dispose();
      
      this.fileSource = new MP4FileSource({
        onReady: (info) => {
          this.logger.info(`File loaded: ${info.width}x${info.height} @ ${info.frameRate?.toFixed(1)}fps, codec: ${info.videoCodec}`);
        },
        onSamples: (samples) => {
          this.handleSamples(samples);
        },
        onError: (error) => {
          this.logger.error(`File source error: ${error.message}`);
          this.setState('error');
          this.emit('error', error);
        },
        onProgress: (loaded, total) => {
          this.emit('progress', loaded, total);
        },
        onEnded: () => {
          this.handleSourceEnded();
        },
      });
      
      this.fileInfo = await this.fileSource.loadFromUrl(url);
      
      // Initialize decoder
      await this.initDecoder();
      
      // Wait for initial buffer to fill
      await this.waitForBuffer();
      
      this.setState('ready');
      this.emit('ready', this.fileInfo);
      
      return this.fileInfo;
    } catch (error) {
      this.setState('error');
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Load a video file from File object
   */
  async loadFromFile(file: File): Promise<MP4FileInfo> {
    this.setState('loading');
    
    try {
      this.dispose();
      
      this.fileSource = new MP4FileSource({
        onReady: (info) => {
          this.logger.info(`File loaded: ${info.width}x${info.height} @ ${info.frameRate?.toFixed(1)}fps, codec: ${info.videoCodec}`);
        },
        onSamples: (samples) => {
          this.handleSamples(samples);
        },
        onError: (error) => {
          this.logger.error(`File source error: ${error.message}`);
          this.setState('error');
          this.emit('error', error);
        },
        onEnded: () => {
          this.handleSourceEnded();
        },
      });
      
      this.fileInfo = await this.fileSource.loadFromFile(file);
      
      this.logger.debug(`File info loaded: ${this.fileInfo.width}x${this.fileInfo.height}, ${this.fileInfo.videoCodec}`);
      
      // Initialize decoder
      await this.initDecoder();
      
      this.logger.debug(`Decoder initialized, sample queue: ${this.sampleQueue.length}`);
      
      // Wait for initial buffer to fill
      await this.waitForBuffer();
      
      this.setState('ready');
      this.emit('ready', this.fileInfo);
      
      return this.fileInfo;
    } catch (error) {
      this.setState('error');
      this.emit('error', error);
      throw error;
    }
  }
  
  /**
   * Initialize the video decoder
   */
  private async initDecoder(): Promise<void> {
    if (!this.fileInfo || !this.fileSource) {
      throw new Error('File not loaded');
    }
    
    this.decoder = new WebCodecsDecoder({
      preferHardware: this.config.preferredDecoder === 'webcodecs-hw',
      onFrame: (frame) => {
        this.handleDecodedFrame(frame);
      },
      onError: (error) => {
        this.logger.error(`Decoder error: ${error.message}`);
        this.emit('error', error);
      },
    });
    
    const description = this.fileSource.getVideoDescription();
    
    this.logger.debug(`Video description: ${description?.length ?? 0} bytes`);
    
    await this.decoder.configure({
      codec: this.fileInfo.videoCodec,
      codedWidth: this.fileInfo.width,
      codedHeight: this.fileInfo.height,
      description: description ?? undefined,
    });
    
    this.logger.info(`Decoder configured: ${this.fileInfo.videoCodec}`);
    
    // Initialize audio decoder if enabled and audio track exists
    if (this.config.enableAudio && this.audioContext && this.fileInfo.audioCodec) {
      await this.initAudioDecoder();
    }
    
    // Start feeding samples to decoders (samples may have arrived during config)
    this.feedDecoder();
    this.feedAudioDecoder();
  }
  
  /**
   * Initialize the audio decoder
   */
  private async initAudioDecoder(): Promise<void> {
    if (!this.fileInfo || !this.fileSource || !this.audioContext) {
      return;
    }
    
    try {
      this.audioPlayer = new FileAudioPlayer(this.audioContext);
      
      const audioDescription = this.fileSource.getAudioDescription();
      
      await this.audioPlayer.init(
        this.fileInfo.audioCodec!,
        this.fileInfo.audioSampleRate ?? 48000,
        this.fileInfo.audioChannels ?? 2,
        audioDescription ?? undefined
      );
      
      this.audioInitialized = true;
      this.logger.info(`Audio decoder configured: ${this.fileInfo.audioCodec}`);
      
      // Feed any samples that arrived during initialization
      this.feedAudioDecoder();
    } catch (error) {
      this.logger.warn(`Failed to initialize audio: ${error}`);
      this.audioPlayer = null;
    }
  }
  
  /**
   * Wait for the frame buffer to have enough frames for smooth playback
   */
  private waitForBuffer(): Promise<void> {
    // If buffer already has enough frames, resolve immediately
    if (this.frameBuffer.length >= this.minBufferSize) {
      return Promise.resolve();
    }
    
    this.logger.debug(`Waiting for buffer (need ${this.minBufferSize} frames, have ${this.frameBuffer.length})`);
    
    // Otherwise, wait for frames to be decoded
    return new Promise((resolve, reject) => {
      this.bufferReadyResolve = resolve;
      
      // Timeout after 5 seconds
      const timeout = setTimeout(() => {
        if (this.bufferReadyResolve) {
          this.logger.warn(`Buffer timeout - have ${this.frameBuffer.length}/${this.minBufferSize} frames, ${this.sampleQueue.length} samples queued`);
          // Resolve anyway if we have at least 1 frame
          if (this.frameBuffer.length > 0) {
            this.bufferReadyResolve = null;
            resolve();
          } else {
            this.bufferReadyResolve = null;
            // Check if moov atom is not at the start of the file
            const moovWarning = this.fileInfo?.isMoovAtStart === false 
              ? ' The moov atom is not at the start of the file - please re-encode with "faststart" option (e.g., ffmpeg -movflags +faststart).'
              : '';
            reject(new Error(`Timeout waiting for frames to decode.${moovWarning}`));
          }
        }
      }, 5000);
      
      // Clear timeout if resolved normally
      const originalResolve = this.bufferReadyResolve;
      this.bufferReadyResolve = () => {
        clearTimeout(timeout);
        originalResolve();
      };
    });
  }
  
  /**
   * Handle samples from mp4box - queue them for gradual decoding
   */
  private handleSamples(samples: DecodableSample[]): void {
    const videoCount = samples.filter(s => s.type === 'video').length;
    const audioCount = samples.filter(s => s.type === 'audio').length;
    this.logger.debug(`Received ${videoCount} video + ${audioCount} audio samples`);
    
    // Queue video and audio samples separately
    for (const sample of samples) {
      if (sample.type === 'video') {
        this.sampleQueue.push(sample);
      } else if (sample.type === 'audio') {
        this.audioSampleQueue.push(sample);
      }
    }
    
    // Start feeding samples to decoders
    this.feedDecoder();
    this.feedAudioDecoder();
  }
  
  /**
   * Feed video samples to decoder gradually (don't overflow the queue)
   */
  private feedDecoder(): void {
    if (!this.decoder) return;
    
    // Feed samples while decoder queue has room
    while (this.nextSampleIndex < this.sampleQueue.length && 
           this.decoder.decodeQueueSize < this.maxDecoderQueue) {
      const sample = this.sampleQueue[this.nextSampleIndex];
      this.decoder.decode({
        data: sample.data,
        timestamp: sample.timestamp,
        duration: sample.duration,
        isKeyframe: sample.isKeyframe,
      });
      this.nextSampleIndex++;
    }
  }
  
  private maxAudioBufferMs = 2000; // Buffer 2 seconds of audio ahead
  
  /**
   * Feed audio samples to decoder - gradually based on playback position
   */
  private feedAudioDecoder(): void {
    // Don't feed audio until the player is initialized
    if (!this.audioPlayer || !this.audioInitialized) {
      return;
    }
    
    // Calculate target audio timestamp (current position + buffer)
    const targetTimestampUs = (this.currentPosition + this.maxAudioBufferMs) * 1000;
    
    // Feed audio samples up to target timestamp
    while (this.nextAudioSampleIndex < this.audioSampleQueue.length) {
      const sample = this.audioSampleQueue[this.nextAudioSampleIndex];
      
      // Stop if we've buffered enough ahead
      if (sample.timestamp > targetTimestampUs) {
        break;
      }
      
      this.audioPlayer.decode(sample.data, sample.timestamp, sample.duration);
      this.nextAudioSampleIndex++;
    }
  }
  
  /**
   * Handle decoded frame from decoder
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    const timestampMs = (frame.timestamp ?? 0) / 1000;
    const durationMs = (frame.duration ?? 0) / 1000;
    
    // Insert in sorted order by timestamp
    const timedFrame: TimedFrame = { frame, timestampMs, durationMs };
    
    let inserted = false;
    for (let i = 0; i < this.frameBuffer.length; i++) {
      if (this.frameBuffer[i].timestampMs > timestampMs) {
        this.frameBuffer.splice(i, 0, timedFrame);
        inserted = true;
        break;
      }
    }
    
    if (!inserted) {
      this.frameBuffer.push(timedFrame);
    }
    
    // Check if buffer is ready (resolve waitForBuffer promise)
    if (this.bufferReadyResolve && this.frameBuffer.length >= this.minBufferSize) {
      this.bufferReadyResolve();
      this.bufferReadyResolve = null;
    }
    
    // Feed more samples to keep the pipeline flowing
    this.feedDecoder();
    this.feedAudioDecoder();
  }
  
  /**
   * Handle source ended (all samples extracted)
   */
  private handleSourceEnded(): void {
    this.logger.debug('Source ended - all samples extracted');
    // Don't change state yet - wait until all frames are displayed
  }
  
  /**
   * Perform a seamless loop back to the start
   * This resets timing and decoder state for looping
   */
  private async performSeamlessLoop(): Promise<void> {
    this.logger.debug('Performing seamless loop');
    
    // Reset position to start
    this.currentPosition = 0;
    
    // Reset playback timing
    this.playStartTime = performance.now();
    this.playStartPosition = 0;
    
    // Clear existing frame buffer
    for (const timedFrame of this.frameBuffer) {
      timedFrame.frame.close();
    }
    this.frameBuffer = [];
    
    // Reset sample indices to start (samples are already in queue from initial load)
    this.nextSampleIndex = 0;
    this.nextAudioSampleIndex = 0;
    
    // No need to reset decoder - first frame is a keyframe so decoder can
    // seamlessly continue decoding from the start without reconfiguration
    
    // Reset audio player
    if (this.audioPlayer) {
      this.audioPlayer.clear();
      this.audioPlayer.resetTiming();
    }
    
    // Feed decoders with samples from the start
    this.feedDecoder();
    this.feedAudioDecoder();
    
    // Emit loop event
    this.emit('loop');
  }
  
  /**
   * Start playback
   */
  play(): void {
    if (this._state === 'error' || this._state === 'loading' || this._state === 'idle') {
      return;
    }
    
    // Resume extraction if needed
    this.fileSource?.start();
    
    // Start audio playback
    this.audioPlayer?.start();
    
    this.playStartTime = performance.now();
    this.playStartPosition = this.currentPosition;
    
    this.setState('playing');
    this.logger.info(`Play from position ${this.currentPosition.toFixed(1)}ms`);
  }
  
  /**
   * Pause playback
   */
  pause(): void {
    if (this._state !== 'playing') {
      return;
    }
    
    // Stop audio playback
    this.audioPlayer?.stop();
    
    this.setState('paused');
    this.logger.info(`Paused at position ${this.currentPosition.toFixed(1)}ms`);
  }
  
  /**
   * Seek to a specific time in seconds
   */
  async seek(timeSeconds: number): Promise<void> {
    if (!this.fileInfo) {
      return;
    }
    
    // Clamp to valid range
    timeSeconds = Math.max(0, Math.min(timeSeconds, this.fileInfo.duration));
    
    const targetTimestampUs = timeSeconds * 1_000_000;
    this.logger.info(`Seeking to ${timeSeconds.toFixed(2)}s`);
    this.isSeeking = true;
    
    // Clear buffer
    this.clearFrameBuffer();
    
    // Reset decoder (sync) - we need to reset for seek since we're jumping to new position
    this.decoder?.reset();
    
    // Clear and reset audio
    if (this.audioPlayer) {
      this.audioPlayer.clear();
      this.audioPlayer.resetTiming();
    }
    
    // Find the nearest keyframe at or before the target time in our sample queue
    let seekSampleIndex = 0;
    let actualTimestampUs = 0;
    
    for (let i = 0; i < this.sampleQueue.length; i++) {
      const sample = this.sampleQueue[i];
      if (sample.timestamp <= targetTimestampUs && sample.isKeyframe) {
        seekSampleIndex = i;
        actualTimestampUs = sample.timestamp;
      }
      if (sample.timestamp > targetTimestampUs) {
        break;
      }
    }
    
    this.nextSampleIndex = seekSampleIndex;
    this.currentPosition = actualTimestampUs / 1000; // Convert to ms
    
    // Find corresponding audio sample index
    this.nextAudioSampleIndex = 0;
    for (let i = 0; i < this.audioSampleQueue.length; i++) {
      if (this.audioSampleQueue[i].timestamp >= actualTimestampUs) {
        this.nextAudioSampleIndex = i;
        break;
      }
    }
    
    // Update play start reference if playing
    if (this._state === 'playing') {
      this.playStartTime = performance.now();
      this.playStartPosition = this.currentPosition;
    }
    
    this.isSeeking = false;
    
    // Feed decoders with samples from the new position
    this.feedDecoder();
    this.feedAudioDecoder();
    
    this.emit('seeked', this.currentPosition / 1000);
  }
  
  /**
   * Clear the frame buffer
   */
  private clearFrameBuffer(): void {
    for (const { frame } of this.frameBuffer) {
      frame.close();
    }
    this.frameBuffer = [];
  }
  
  /**
   * Get a video frame for rendering
   * 
   * Call this in your render loop. Returns the appropriate frame for the current time.
   */
  getVideoFrame(): VideoFrame | null {
    if (this._state === 'idle' || this._state === 'loading' || this._state === 'error') {
      return null;
    }
    
    // If seeking, return last frame
    if (this.isSeeking) {
      return this.lastVideoFrame;
    }
    
    // Calculate current position
    if (this._state === 'playing') {
      const elapsed = performance.now() - this.playStartTime;
      this.currentPosition = this.playStartPosition + elapsed;
      
      // Feed audio decoder based on current position
      this.feedAudioDecoder();
      
      // Check for end of file
      if (this.fileInfo && this.currentPosition >= this.fileInfo.duration * 1000) {
        if (this.config.playMode === 'loop') {
          // Seamless loop - reset position to start without seeking
          this.performSeamlessLoop();
          return this.lastVideoFrame;
        } else {
          this.setState('ended');
          this.emit('ended');
          return this.lastVideoFrame;
        }
      }
    }
    
    // Request more frames if buffer is low
    if (this.frameBuffer.length < this.minBufferSize) {
      this.fileSource?.start();
    }
    
    // Find the frame closest to current position (without going past it)
    let frameIndex = -1;
    for (let i = 0; i < this.frameBuffer.length; i++) {
      const frame = this.frameBuffer[i];
      if (frame.timestampMs <= this.currentPosition) {
        frameIndex = i;
      } else {
        break;
      }
    }
    
    // If we found a suitable frame, use it
    if (frameIndex >= 0) {
      // Remove all frames before this one (they're in the past)
      const removedFrames = this.frameBuffer.splice(0, frameIndex);
      for (const { frame } of removedFrames) {
        frame.close();
      }
      
      // Get the current frame (now at index 0)
      const timedFrame = this.frameBuffer.shift();
      if (timedFrame) {
        // Close previous frame
        if (this.lastVideoFrame && this.lastVideoFrame !== timedFrame.frame) {
          this.lastVideoFrame.close();
        }
        this.lastVideoFrame = timedFrame.frame;
      }
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
    // Stop extraction
    this.fileSource?.stop();
    
    // Clear buffer
    this.clearFrameBuffer();
    
    // Clear pending samples
    this.sampleQueue = [];
    this.audioSampleQueue = [];
    this.nextSampleIndex = 0;
    this.nextAudioSampleIndex = 0;
    this.audioInitialized = false;
    
    // Close last frame
    if (this.lastVideoFrame) {
      this.lastVideoFrame.close();
      this.lastVideoFrame = null;
    }
    
    // Dispose video decoder
    this.decoder?.dispose();
    this.decoder = null;
    
    // Dispose audio player
    this.audioPlayer?.dispose();
    this.audioPlayer = null;
    
    // Only close audio context on full dispose (not on reload)
    if (full && this.ownsAudioContext && this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    // Dispose source
    this.fileSource?.dispose();
    this.fileSource = null;
    
    // Reset state
    this.fileInfo = null;
    this.currentPosition = 0;
    this.playStartTime = 0;
    this.playStartPosition = 0;

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
