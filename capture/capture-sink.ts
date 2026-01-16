/**
 * Capture Sink Interface
 * 
 * Defines the interface for sending captured media data to various transports.
 * Implementations can send data over WebSocket, MoQ, or other protocols.
 */

import { CodecType } from './capture-types';

/**
 * Serialized packet ready for transmission
 */
export interface SerializedPacket {
  data: ArrayBuffer;
  isKeyframe: boolean;
  timestamp: number;
  type: 'video' | 'audio';
}

/**
 * Interface for capture sinks that handle outgoing media data
 */
export interface ICaptureSink {
  /**
   * Whether the sink is currently connected
   */
  readonly connected: boolean;

  /**
   * Connect to the transport
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the transport
   */
  disconnect(): Promise<void>;

  /**
   * Reconnect to the transport
   */
  reconnect(): Promise<void>;

  /**
   * Send encoded media data
   * @param packet The serialized packet to send
   */
  send(packet: SerializedPacket): void;

  /**
   * Set callback for keyframe requests from receiver
   */
  onKeyframeRequest(callback: () => void): void;

  /**
   * Dispose of all resources
   */
  dispose(): void;
}

/**
 * Configuration for video stream in a capture sink
 */
export interface VideoStreamConfig {
  /** Video codec type */
  codec: CodecType;
  /** Video width */
  width: number;
  /** Video height */
  height: number;
  /** Timebase numerator */
  timebaseNum?: number;
  /** Timebase denominator */
  timebaseDen?: number;
}

/**
 * Configuration for audio stream in a capture sink
 */
export interface AudioStreamConfig {
  /** Audio codec type */
  codec: CodecType;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels */
  channels: number;
  /** Timebase numerator */
  timebaseNum?: number;
  /** Timebase denominator */
  timebaseDen?: number;
}

/**
 * Base configuration for capture sinks
 */
export interface CaptureSinkConfig {
  /** Video stream configuration (optional if not sending video) */
  video?: VideoStreamConfig;
  /** Audio stream configuration (optional if not sending audio) */
  audio?: AudioStreamConfig;
  /** Topic/channel identifier for routing */
  topic?: string;
  /** Audio timestamp offset to align audio and video (in microseconds) */
  audioTimestampOffset?: number;
}

/**
 * Base class for capture sink implementations
 */
export abstract class BaseCaptureSink implements ICaptureSink {
  protected config: CaptureSinkConfig;
  protected keyframeCallback?: () => void;
  protected _connected: boolean = false;
  
  constructor(config: CaptureSinkConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(packet: SerializedPacket): void;

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  onKeyframeRequest(callback: () => void): void {
    this.keyframeCallback = callback;
  }

  protected requestKeyframe(): void {
    if (this.keyframeCallback) {
      this.keyframeCallback();
    }
  }

  dispose(): void {
    this.disconnect();
    this.keyframeCallback = undefined;
  }
}
