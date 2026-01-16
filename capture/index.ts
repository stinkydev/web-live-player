/**
 * Capture Module
 * 
 * Provides media capture capabilities for video and audio streaming.
 * Supports encoding with WebCodecs and transport over MoQ or WebSocket.
 */

// Types
export * from './capture-types';

// Encoder
export { MediaStreamEncoder } from './media-encoder';
export type { EncoderEventHandler } from './media-encoder';

// Sinks
export { BaseCaptureSink } from './capture-sink';
export type {
  ICaptureSink,
  CaptureSinkConfig,
  SerializedPacket,
  VideoStreamConfig,
  AudioStreamConfig,
} from './capture-sink';

export { WebSocketCaptureSink, createWebSocketSink } from './websocket-sink';
export type { WebSocketSinkConfig } from './websocket-sink';

export { MoQCaptureSink, createMoQSink } from './moq-sink';
export type { MoQSinkConfig, MoQTrackConfig } from './moq-sink';

// Main Capture class
export { MediaCapture, createMediaCapture } from './media-capture';
export type { MediaCaptureConfig, CaptureEventHandler } from './media-capture';
