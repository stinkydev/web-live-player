/**
 * Media Stream Encoder
 * 
 * Encodes MediaStream audio and video tracks using WebCodecs API.
 * Runs encoding in web workers for better performance.
 */

import {
  AudioEncoderOptions,
  VideoEncoderOptions,
  EncodedChunkEvent,
  AudioLevelEvent,
  codecTypeToString,
  CodecType,
} from './capture-types';

/**
 * Event handler types
 */
export type EncoderEventHandler<T> = (event: T) => void;

/**
 * Media stream encoder that handles both audio and video encoding
 */
export class MediaStreamEncoder {
  private audioWorker: Worker | undefined;
  private videoWorker: Worker | undefined;
  private audioProcessor: MediaStreamTrackProcessor<AudioData> | undefined;
  private videoProcessor: MediaStreamTrackProcessor<VideoFrame> | undefined;
  private disposed: boolean = false;
  
  private handlers = {
    chunk: new Set<EncoderEventHandler<EncodedChunkEvent>>(),
    'audio-levels': new Set<EncoderEventHandler<AudioLevelEvent>>(),
    error: new Set<EncoderEventHandler<Error>>(),
    ready: new Set<EncoderEventHandler<void>>(),
  };
  
  private audioReady = false;
  private videoReady = false;
  private hasAudio = false;
  private hasVideo = false;
  
  private audioMetadata?: { channels: number; sampleRate: number };
  private videoMetadata?: { width: number; height: number };

  constructor(
    stream: MediaStream,
    videoOptions?: VideoEncoderOptions,
    audioOptions?: AudioEncoderOptions,
    audioLevelConfig?: { enabled: boolean; interval?: number }
  ) {
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();

    this.hasAudio = audioTracks.length > 0 && !!audioOptions;
    this.hasVideo = videoTracks.length > 0 && !!videoOptions;

    if (this.hasAudio && audioOptions) {
      this.createAudioEncoder(audioTracks[0], audioOptions, audioLevelConfig);
    }
    
    if (this.hasVideo && videoOptions) {
      this.createVideoEncoder(videoTracks[0], videoOptions);
    }
  }

  /**
   * Register event handler
   */
  on(event: 'chunk', handler: EncoderEventHandler<EncodedChunkEvent>): this;
  on(event: 'audio-levels', handler: EncoderEventHandler<AudioLevelEvent>): this;
  on(event: 'error', handler: EncoderEventHandler<Error>): this;
  on(event: 'ready', handler: EncoderEventHandler<void>): this;
  on(event: string, handler: EncoderEventHandler<any>): this {
    const handlers = this.handlers[event as keyof typeof this.handlers];
    if (handlers) {
      handlers.add(handler);
    }
    return this;
  }

  /**
   * Unregister event handler
   */
  off(event: 'chunk', handler: EncoderEventHandler<EncodedChunkEvent>): this;
  off(event: 'audio-levels', handler: EncoderEventHandler<AudioLevelEvent>): this;
  off(event: 'error', handler: EncoderEventHandler<Error>): this;
  off(event: 'ready', handler: EncoderEventHandler<void>): this;
  off(event: string, handler: EncoderEventHandler<any>): this {
    const handlers = this.handlers[event as keyof typeof this.handlers];
    if (handlers) {
      handlers.delete(handler);
    }
    return this;
  }

  private emit<T>(event: string, data?: T): void {
    const handlers = this.handlers[event as keyof typeof this.handlers] as Set<EncoderEventHandler<T>> | undefined;
    if (handlers) {
      handlers.forEach(handler => handler(data as T));
    }
  }

  private checkReady(): void {
    const audioReady = !this.hasAudio || this.audioReady;
    const videoReady = !this.hasVideo || this.videoReady;
    
    if (audioReady && videoReady) {
      this.emit('ready');
    }
  }

  private createAudioEncoder(
    track: MediaStreamTrack,
    options: AudioEncoderOptions,
    audioLevelConfig?: { enabled: boolean; interval?: number }
  ): void {
    const settings = track.getSettings();
    const channels = settings.channelCount || options.channels || 2;
    const sampleRate = settings.sampleRate || options.sampleRate || 48000;

    this.audioMetadata = { channels, sampleRate };

    const codecString = codecTypeToString(options.codec);
    
    // Build encoder config
    const audioConfig: AudioEncoderConfig = {
      codec: codecString,
      sampleRate,
      numberOfChannels: channels,
      bitrate: options.bitrate || 128_000,
    };

    // Add Opus-specific config if using Opus
    if (options.codec === CodecType.AUDIO_OPUS) {
      // @ts-ignore - opus config not in standard types
      audioConfig.opus = {
        frameDuration: 20000,
        complexity: 5,
        format: 'opus',
      };
    }

    // Create the audio worker
    this.audioWorker = new Worker(
      new URL('./audio-encoder.worker.ts', import.meta.url),
      { type: 'module' }
    );

    // Set up worker message handling
    this.audioWorker.onmessage = (event) => {
      const { type, data, metadata } = event.data;
      
      switch (type) {
        case 'chunk':
          this.emit<EncodedChunkEvent>('chunk', {
            type: 'audio',
            chunk: data,
            keyframe: false, // Audio doesn't have keyframes
            timestamp: data.timestamp,
            metadata: {
              ...this.audioMetadata,
              decoderConfig: metadata?.decoderConfig,
            },
          });
          break;
          
        case 'error':
          this.emit<Error>('error', new Error(`Audio encoding error: ${data}`));
          break;
          
        case 'ready':
          this.audioReady = true;
          this.startProcessingAudio(track);
          this.checkReady();
          break;
          
        case 'audio-levels':
          this.emit<AudioLevelEvent>('audio-levels', data);
          break;
      }
    };

    this.audioWorker.onerror = (error) => {
      this.emit<Error>('error', new Error(`Audio worker error: ${error.message}`));
    };

    // Initialize the worker with config
    this.audioWorker.postMessage({ 
      type: 'init',
      data: {
        config: audioConfig,
        audioLevels: audioLevelConfig?.enabled ? {
          interval: audioLevelConfig.interval || 50,
        } : undefined,
      },
    });
  }

  private createVideoEncoder(track: MediaStreamTrack, options: VideoEncoderOptions): void {
    const settings = track.getSettings();
    const width = settings.width || options.width || 1280;
    const height = settings.height || options.height || 720;
    const frameRate = settings.frameRate || options.frameRate || 30;

    this.videoMetadata = { width, height };

    const codecString = codecTypeToString(options.codec);
    
    const videoConfig: VideoEncoderConfig = {
      codec: codecString,
      width,
      height,
      bitrate: options.bitrate || 2_000_000,
      framerate: frameRate,
      latencyMode: options.latencyMode || 'realtime',
    };
    
    // For H.264/AVC, use Annex B format which includes start codes
    // This makes the bitstream self-describing and doesn't require separate
    // decoder configuration (SPS/PPS) to be transmitted out-of-band
    if (codecString.startsWith('avc1')) {
      // @ts-ignore - avc option is not in standard types yet
      videoConfig.avc = { format: 'annexb' };
    }
    
    // For HEVC, also use Annex B format if supported
    if (codecString.startsWith('hvc1') || codecString.startsWith('hev1')) {
      // @ts-ignore - hevc option is not in standard types yet
      videoConfig.hevc = { format: 'annexb' };
    }

    // Create the video worker
    this.videoWorker = new Worker(
      new URL('./video-encoder.worker.ts', import.meta.url),
      { type: 'module' }
    );

    // Set up worker message handling
    this.videoWorker.onmessage = (event) => {
      const { type, data, metadata } = event.data;
      
      switch (type) {
        case 'chunk':
          this.emit<EncodedChunkEvent>('chunk', {
            type: 'video',
            chunk: data,
            keyframe: data.type === 'key',
            timestamp: data.timestamp,
            metadata: {
              ...this.videoMetadata,
              decoderConfig: metadata?.decoderConfig,
            },
          });
          break;
          
        case 'error':
          this.emit<Error>('error', new Error(`Video encoding error: ${data}`));
          break;
          
        case 'ready':
          this.videoReady = true;
          this.startProcessingVideo(track);
          this.checkReady();
          break;
      }
    };

    this.videoWorker.onerror = (error) => {
      this.emit<Error>('error', new Error(`Video worker error: ${error.message}`));
    };

    // Initialize the worker with config
    this.videoWorker.postMessage({ 
      type: 'init',
      data: { 
        config: videoConfig,
        gopSize: options.keyFrameInterval || 60,
      },
    });
  }

  private startProcessingAudio(track: MediaStreamTrack): void {
    try {
      // @ts-ignore - MediaStreamTrackProcessor not in standard types
      this.audioProcessor = new MediaStreamTrackProcessor({ track });
      const readableStream = this.audioProcessor.readable;
      
      if (this.audioWorker) {
        this.audioWorker.postMessage({ 
          type: 'stream',
          data: { readable: readableStream },
        }, [readableStream as any]);
      }
    } catch (err) {
      this.emit<Error>('error', new Error(`Failed to set up audio processing: ${err}`));
    }
  }

  private startProcessingVideo(track: MediaStreamTrack): void {
    try {
      // @ts-ignore - MediaStreamTrackProcessor not in standard types
      this.videoProcessor = new MediaStreamTrackProcessor({ track });
      const readableStream = this.videoProcessor.readable;
      
      if (this.videoWorker) {
        this.videoWorker.postMessage({ 
          type: 'stream',
          data: { readable: readableStream },
        }, [readableStream as any]);
      }
    } catch (err) {
      this.emit<Error>('error', new Error(`Failed to set up video processing: ${err}`));
    }
  }

  /**
   * Request an immediate keyframe from the video encoder
   */
  requestKeyframe(): void {
    if (this.videoWorker) {
      this.videoWorker.postMessage({ type: 'request-keyframe' });
    }
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Clear all handlers
    Object.values(this.handlers).forEach(set => set.clear());

    // Close workers
    if (this.audioWorker) {
      this.audioWorker.postMessage({ type: 'close' });
      this.audioWorker.terminate();
      this.audioWorker = undefined;
    }
    
    if (this.videoWorker) {
      this.videoWorker.postMessage({ type: 'close' });
      this.videoWorker.terminate();
      this.videoWorker = undefined;
    }
    
    this.audioProcessor = undefined;
    this.videoProcessor = undefined;
  }
}

// Augment global types for MediaStreamTrackProcessor
declare global {
  interface MediaStreamTrackProcessor<T> {
    readable: ReadableStream<T>;
  }
  
  const MediaStreamTrackProcessor: {
    new <T>(options: { track: MediaStreamTrack }): MediaStreamTrackProcessor<T>;
  };
}
