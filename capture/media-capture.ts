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
  CodecType,
  PacketType,
  DEFAULT_CAPTURE_CONFIG,
} from './capture-types';
import { MediaStreamEncoder } from './media-encoder';
import { ICaptureSink, SerializedPacket } from './capture-sink';
import {
  SesameBinaryProtocol,
  FLAG_HAS_CODEC_DATA,
  FLAG_HAS_METADATA,
  FLAG_IS_KEYFRAME,
  HeaderCodecData,
} from '../protocol/sesame-binary-protocol';

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
  private config: MediaCaptureConfig;
  private sink: ICaptureSink;
  private encoder?: MediaStreamEncoder;
  private mediaStream?: MediaStream;
  private state: CaptureState = 'idle';
  private disposed = false;

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

      // Wait for encoder to be ready
      await new Promise<void>((resolve) => {
        this.encoder!.on('ready', () => resolve());
        // Also resolve after timeout in case ready already fired
        setTimeout(resolve, 100);
      });

      this.stats.startTime = Date.now();
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

  private handleEncodedChunk(event: EncodedChunkEvent): void {
    if (!this.sink.connected) {
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

      // Update stats
      if (event.type === 'video') {
        this.stats.videoFramesEncoded++;
      } else {
        this.stats.audioFramesEncoded++;
      }
      this.stats.bytesSent += chunkData.byteLength;
      this.stats.packetsSent++;

    } catch (err) {
      console.error('Error handling encoded chunk:', err);
    }
  }

  private createPacket(event: EncodedChunkEvent, chunkData: Uint8Array): ArrayBuffer {
    const isVideo = event.type === 'video';
    const packetType = isVideo ? PacketType.VIDEO_FRAME : PacketType.AUDIO_FRAME;
    const codecType = isVideo 
      ? (this.config.videoEncoder?.codec ?? CodecType.VIDEO_VP9)
      : (this.config.audioEncoder?.codec ?? CodecType.AUDIO_OPUS);

    // Apply audio timestamp offset
    let timestamp = event.timestamp;
    if (!isVideo && this.config.audioTimestampOffset) {
      timestamp += this.config.audioTimestampOffset;
    }

    // Build codec data
    const codecData: HeaderCodecData = {
      sample_rate: this.audioMetadata?.sampleRate || 0,
      codec_profile: 0,
      codec_level: 0,
      width: this.videoMetadata?.width || 0,
      height: this.videoMetadata?.height || 0,
      codec_type: codecType,
      channels: this.audioMetadata?.channels || 0,
      bit_depth: 8,
      timebase_num: 1,
      timebase_den: 1000000,
      reserved: 0,
    };

    // Set flags
    let flags = FLAG_HAS_CODEC_DATA;
    if (this.config.topic) {
      flags |= FLAG_HAS_METADATA;
    }
    if (event.keyframe) {
      flags |= FLAG_IS_KEYFRAME;
    }

    // Create header
    const header = SesameBinaryProtocol.initHeader(
      packetType,
      flags,
      BigInt(timestamp),
      BigInt(0)
    );

    // Create metadata
    const metadata = this.config.topic ? { metadata: this.config.topic } : null;

    // Serialize
    const serializedData = SesameBinaryProtocol.serialize(header, metadata, codecData, chunkData);

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
