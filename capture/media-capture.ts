/**
 * Media Capture
 * 
 * Main capture class that coordinates capturing from browser media devices,
 * encoding with WebCodecs, and sending to a transport sink.
 */

import {
  CaptureConfig,
  CaptureState,
  CaptureStats,
  EncodedChunkEvent,
  AudioLevelEvent,
  DEFAULT_CAPTURE_CONFIG,
  codecTypeToString,
  parseProfileLevel,
} from './capture-types';
import { MediaStreamEncoder } from './media-encoder';
import { ICaptureSink, SerializedPacket } from './capture-sink';
import { CodecType, sesame, WireProtocol } from '@stinkycomputing/sesame-api-client';

/**
 * Full media capture configuration
 */
export interface MediaCaptureConfig extends CaptureConfig {
  /** Capture sink for sending encoded data */
  sink: ICaptureSink;
  /** Topic/channel identifier for routing packets */
  topic?: string;
  /** Audio timestamp offset to align with video (microseconds) */
  audioTimestampOffset?: number;
}

/**
 * Event handler types
 */
export type CaptureEventHandler<T> = (event: T) => void;

/**
 * Media Capture - captures and encodes media from browser devices
 */
export class MediaCapture {
  /** How long start() waits for the encoders to configure */
  private static readonly ENCODER_READY_TIMEOUT_MS = 5000;

  private config: MediaCaptureConfig;
  private sink: ICaptureSink;
  private encoder?: MediaStreamEncoder;
  private mediaStream?: MediaStream;
  private state: CaptureState = 'idle';
  private disposed = false;
  private paused = false;

  // Bitrate measurement over a sliding stats interval
  private statsTimer?: ReturnType<typeof setInterval>;
  private videoBytesSent = 0;
  private audioBytesSent = 0;
  private lastStatsSampleTime = 0;
  private lastVideoBytesSent = 0;
  private lastAudioBytesSent = 0;

  // Stats tracking
  private stats: CaptureStats = {
    videoFramesEncoded: 0,
    audioFramesEncoded: 0,
    bytesSent: 0,
    packetsSent: 0,
    videoBitrate: 0,
    audioBitrate: 0,
    startTime: 0,
    duration: 0,
  };

  // Captured stream metadata
  private videoMetadata?: { width: number; height: number };
  private audioMetadata?: { channels: number; sampleRate: number };

  // Codec identity advertised in the wire header, resolved when encoding starts
  private videoCodec: { type: sesame.v1.common.CodecType; profile: number; level: number } = {
    type: CodecType.CODEC_TYPE_VIDEO_VP9,
    profile: 0,
    level: 0,
  };
  private audioCodec: sesame.v1.common.CodecType = CodecType.CODEC_TYPE_AUDIO_OPUS;

  // Event handlers
  private handlers = {
    'state-change': new Set<CaptureEventHandler<CaptureState>>(),
    'audio-levels': new Set<CaptureEventHandler<AudioLevelEvent>>(),
    'stats': new Set<CaptureEventHandler<CaptureStats>>(),
    'error': new Set<CaptureEventHandler<Error>>(),
  };

  constructor(config: MediaCaptureConfig) {
    this.config = {
      ...DEFAULT_CAPTURE_CONFIG,
      ...config,
    };
    this.sink = config.sink;

    // Set up keyframe request handling
    this.sink.onKeyframeRequest(() => {
      this.requestKeyframe();
    });
  }

  /**
   * Register event handler
   */
  on(event: 'state-change', handler: CaptureEventHandler<CaptureState>): this;
  on(event: 'audio-levels', handler: CaptureEventHandler<AudioLevelEvent>): this;
  on(event: 'stats', handler: CaptureEventHandler<CaptureStats>): this;
  on(event: 'error', handler: CaptureEventHandler<Error>): this;
  on(event: string, handler: CaptureEventHandler<any>): this {
    const handlers = this.handlers[event as keyof typeof this.handlers];
    if (handlers) {
      handlers.add(handler);
    }
    return this;
  }

  /**
   * Unregister event handler
   */
  off(event: string, handler: CaptureEventHandler<any>): this {
    const handlers = this.handlers[event as keyof typeof this.handlers];
    if (handlers) {
      handlers.delete(handler);
    }
    return this;
  }

  private emit<T>(event: string, data: T): void {
    const handlers = this.handlers[event as keyof typeof this.handlers] as Set<CaptureEventHandler<T>> | undefined;
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
  }

  private setState(newState: CaptureState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('state-change', newState);
    }
  }

  /**
   * Recompute bitrates from the bytes sent since the previous sample
   */
  private sampleBitrates(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastStatsSampleTime;

    if (elapsedMs <= 0) {
      return;
    }

    const videoDelta = this.videoBytesSent - this.lastVideoBytesSent;
    const audioDelta = this.audioBytesSent - this.lastAudioBytesSent;
    const perSecond = 8000 / elapsedMs; // bytes -> bits per second

    this.stats.videoBitrate = Math.round(videoDelta * perSecond);
    this.stats.audioBitrate = Math.round(audioDelta * perSecond);

    this.lastStatsSampleTime = now;
    this.lastVideoBytesSent = this.videoBytesSent;
    this.lastAudioBytesSent = this.audioBytesSent;
  }

  private startStatsTimer(): void {
    this.stopStatsTimer();

    const interval = this.config.statsInterval ?? DEFAULT_CAPTURE_CONFIG.statsInterval;

    // Baseline against the current totals so a restart doesn't report a spike
    this.lastStatsSampleTime = Date.now();
    this.lastVideoBytesSent = this.videoBytesSent;
    this.lastAudioBytesSent = this.audioBytesSent;

    this.statsTimer = setInterval(() => {
      this.sampleBitrates();
      this.emit('stats', this.getStats());
    }, interval);
  }

  private stopStatsTimer(): void {
    if (this.statsTimer !== undefined) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  /**
   * Get current capture state
   */
  getState(): CaptureState {
    return this.state;
  }

  /**
   * Get current capture statistics
   */
  getStats(): CaptureStats {
    if (this.stats.startTime > 0) {
      this.stats.duration = Date.now() - this.stats.startTime;
    }
    return { ...this.stats };
  }

  /**
   * Check if media devices are available
   */
  static hasMediaDevices(): boolean {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Get list of available media devices
   */
  static async getDevices(): Promise<MediaDeviceInfo[]> {
    if (!MediaCapture.hasMediaDevices()) {
      return [];
    }
    return navigator.mediaDevices.enumerateDevices();
  }

  /**
   * Start capturing and encoding media
   */
  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('MediaCapture has been disposed');
    }

    if (this.state === 'capturing') {
      return;
    }

    if (!MediaCapture.hasMediaDevices()) {
      throw new Error('Media devices not available. Make sure you are using HTTPS.');
    }

    this.setState('initializing');

    try {
      // Get media stream
      const constraints: MediaStreamConstraints = {};

      if (this.config.video) {
        constraints.video = typeof this.config.video === 'boolean' 
          ? DEFAULT_CAPTURE_CONFIG.video 
          : this.config.video;
      }

      if (this.config.audio) {
        constraints.audio = typeof this.config.audio === 'boolean'
          ? DEFAULT_CAPTURE_CONFIG.audio
          : this.config.audio;
      }

      if (!constraints.video && !constraints.audio) {
        throw new Error('Must enable at least video or audio capture');
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Extract metadata from tracks
      const videoTracks = this.mediaStream.getVideoTracks();
      const audioTracks = this.mediaStream.getAudioTracks();

      if (videoTracks.length > 0) {
        const settings = videoTracks[0].getSettings();
        this.videoMetadata = {
          width: settings.width || 1280,
          height: settings.height || 720,
        };
      }

      if (audioTracks.length > 0) {
        const settings = audioTracks[0].getSettings();
        this.audioMetadata = {
          channels: settings.channelCount || 2,
          sampleRate: settings.sampleRate || 48000,
        };
      }

      // Connect to sink
      if (!this.sink.connected) {
        await this.sink.connect();
      }

      // Create encoder
      const videoEncoderOptions = this.config.video ? {
        ...DEFAULT_CAPTURE_CONFIG.videoEncoder,
        ...this.config.videoEncoder,
        width: this.videoMetadata?.width,
        height: this.videoMetadata?.height,
      } : undefined;

      const audioEncoderOptions = this.config.audio ? {
        ...DEFAULT_CAPTURE_CONFIG.audioEncoder,
        ...this.config.audioEncoder,
        channels: this.audioMetadata?.channels,
        sampleRate: this.audioMetadata?.sampleRate,
      } : undefined;

      // The wire header must describe what the encoder actually produces
      if (videoEncoderOptions) {
        const { profile, level } = parseProfileLevel(codecTypeToString(videoEncoderOptions.codec));
        this.videoCodec = { type: videoEncoderOptions.codec, profile, level };
      }
      if (audioEncoderOptions) {
        this.audioCodec = audioEncoderOptions.codec;
      }

      this.encoder = new MediaStreamEncoder(
        this.mediaStream,
        videoEncoderOptions,
        audioEncoderOptions,
        {
          enabled: this.config.audioLevelMonitoring ?? false,
          interval: this.config.audioLevelInterval,
        }
      );

      // Set up encoder event handling
      this.encoder.on('chunk', (event) => this.handleEncodedChunk(event));
      this.encoder.on('audio-levels', (event) => this.emit('audio-levels', event));
      this.encoder.on('error', (error) => {
        this.emit('error', error);
        this.setState('error');
      });

      // Wait for the encoders to configure - a configuration failure arrives as an
      // error event and must not be reported as a successful start
      await this.waitForEncoderReady(this.encoder);

      this.stats.startTime = Date.now();
      this.paused = false;
      this.startStatsTimer();
      this.setState('capturing');

    } catch (err) {
      this.setState('error');
      throw err;
    }
  }

  /**
   * Stop capturing
   */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') {
      return;
    }

    this.stopStatsTimer();
    this.paused = false;

    // Stop encoder
    if (this.encoder) {
      this.encoder.dispose();
      this.encoder = undefined;
    }

    // Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = undefined;
    }

    this.setState('stopped');
  }

  /**
   * Pause publishing.
   *
   * Encoding continues so timestamps stay continuous and the media stream and
   * permissions stay alive; encoded chunks are simply not handed to the sink.
   */
  pause(): void {
    if (this.state !== 'capturing') {
      return;
    }

    this.paused = true;
    this.setState('paused');
  }

  /**
   * Resume publishing after {@link pause}.
   *
   * Requests a keyframe so the receiver can start decoding again immediately
   * rather than waiting for the next scheduled one.
   */
  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    this.paused = false;
    this.setState('capturing');
    this.requestKeyframe();
  }

  /**
   * Request immediate keyframe
   */
  requestKeyframe(): void {
    if (this.encoder) {
      this.encoder.requestKeyframe();
    }
  }

  /**
   * Get the underlying MediaStream (for preview purposes)
   */
  getMediaStream(): MediaStream | undefined {
    return this.mediaStream;
  }
  
  /**
   * Set an external MoQ session on the sink (if it's a MoQCaptureSink)
   * Allows injecting an existing MoqSessionBroadcaster instance.
   * @param session - MoqSessionBroadcaster instance to use for broadcasting
   */
  setMoQSession(session: any): void {
    // Check if sink has setMoQSession method (i.e., it's a MoQCaptureSink)
    if ('setMoQSession' in this.sink && typeof (this.sink as any).setMoQSession === 'function') {
      (this.sink as any).setMoQSession(session);
    } else {
      throw new Error('Sink does not support MoQ session injection');
    }
  }

  /**
   * Resolve when the encoders report ready, reject if one reports an error first.
   *
   * Resolves after ENCODER_READY_TIMEOUT_MS if neither arrives, so a browser that
   * never reports readiness doesn't hang the caller.
   */
  private waitForEncoderReady(encoder: MediaStreamEncoder): Promise<void> {
    if (!encoder.hasEncoders) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        encoder.off('ready', onReady);
        encoder.off('error', onError);
      };

      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        console.warn('MediaCapture: encoder did not report ready, continuing anyway');
        resolve();
      }, MediaCapture.ENCODER_READY_TIMEOUT_MS);

      encoder.on('ready', onReady);
      encoder.on('error', onError);
    });
  }

  private handleEncodedChunk(event: EncodedChunkEvent): void {
    if (this.paused || !this.sink.connected) {
      return;
    }

    try {
      // Copy chunk data to Uint8Array
      const chunkData = new Uint8Array(event.chunk.byteLength);
      event.chunk.copyTo(chunkData.buffer);

      // Create Sesame protocol packet
      const packet = this.createPacket(event, chunkData);

      // Create serialized packet for sink
      const serializedPacket: SerializedPacket = {
        data: packet,
        isKeyframe: event.keyframe,
        timestamp: event.timestamp,
        type: event.type,
      };

      // Send through sink
      this.sink.send(serializedPacket);

      // Update stats - all byte counters track encoded payload, excluding wire framing
      if (event.type === 'video') {
        this.stats.videoFramesEncoded++;
        this.videoBytesSent += chunkData.byteLength;
      } else {
        this.stats.audioFramesEncoded++;
        this.audioBytesSent += chunkData.byteLength;
      }
      this.stats.bytesSent += chunkData.byteLength;
      this.stats.packetsSent++;

    } catch (err) {
      console.error('Error handling encoded chunk:', err);
    }
  }

  private createPacket(event: EncodedChunkEvent, chunkData: Uint8Array): ArrayBuffer {
    const isVideo = event.type === 'video';
    const hdr: sesame.v1.wire.IFrameHeader = {
      type: isVideo ? sesame.v1.wire.FrameType.FRAME_TYPE_VIDEO : sesame.v1.wire.FrameType.FRAME_TYPE_AUDIO,
      media: {
        pts: BigInt(event.timestamp),
        keyframe: event.keyframe,
        codecData: {
          codecType: isVideo ? this.videoCodec.type : this.audioCodec,
          codecProfile: isVideo ? this.videoCodec.profile : 0,
          codecLevel: isVideo ? this.videoCodec.level : 0,
          width: this.videoMetadata?.width || 0,
          height: this.videoMetadata?.height || 0,
          channels: this.audioMetadata?.channels || 0,
          sampleRate: this.audioMetadata?.sampleRate || 0,
          bitDepth: 8,
          timebaseNum: 1,
          timebaseDen: 1000000,
        }
      },
      routingMetadata: this.config.topic ? JSON.stringify({ metadata: this.config.topic }) : '',
    };

    // Apply audio timestamp offset
    if (!isVideo && this.config.audioTimestampOffset) {
      hdr.media!.pts += BigInt(this.config.audioTimestampOffset);
    }

    if (this.config.topic) {
      hdr.routingMetadata = JSON.stringify({ metadata: this.config.topic });
    }
    // Serialize
    const serializedData = WireProtocol.serialize(hdr, chunkData);

    if (!serializedData) {
      throw new Error('Failed to serialize packet');
    }

    return serializedData.buffer.slice(
      serializedData.byteOffset,
      serializedData.byteOffset + serializedData.byteLength
    ) as ArrayBuffer;
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stopStatsTimer();
    this.stop();
    this.sink.dispose();

    // Clear handlers
    Object.values(this.handlers).forEach(set => set.clear());
  }
}

/**
 * Factory function to create a media capture instance
 */
export function createMediaCapture(config: MediaCaptureConfig): MediaCapture {
  return new MediaCapture(config);
}
