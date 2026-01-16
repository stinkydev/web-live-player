/**
 * Web Live Player - A framework-agnostic video streaming library
 * 
 * Supports multiple stream sources through dependency injection:
 * - MoQSession (from Elmo or standalone)
 * - WebSocket connections
 * - Custom stream sources
 * - MP4 file playback (client-side demuxing with mp4box)
 */

// Core types and interfaces
export * from './types';
export * from './sources/stream-source';

// Players
export { BasePlayer } from './player/base-player';
export type { BasePlayerConfig } from './player/base-player';

export { LiveVideoPlayer, createPlayer } from './player/live-player';
export type { PlayerConfig, PlayerStats, PlayerState, BandwidthStats } from './player/live-player';

export { FileVideoPlayer, createFilePlayer } from './player/file-player';
export type { FilePlayerConfig, FilePlayerState, FilePlayerStats, FilePlayMode } from './player/file-player';

// Stream sources
export { createStandaloneMoQSource, StandaloneMoQSource } from './sources/standalone-moq-source';
export { WebSocketSource, createWebSocketSource } from './sources/websocket-source';
export type { WebSocketSourceConfig, VideoMetadata } from './sources/websocket-source';

// File sources
export { MP4FileSource } from './sources/mp4-file-source';
export type { MP4FileInfo, DecodableSample, MP4FileSourceEvents } from './sources/mp4-file-source';

// Decoders
export { WebCodecsDecoder } from './decoders/webcodecs-decoder';
export type { SampleData } from './decoders/webcodecs-decoder';
export { WasmDecoder } from './decoders/wasm-decoder';
export type { YUVFrame, WasmDecoderConfig } from './decoders/wasm-decoder';
export type { IVideoDecoder, DecoderState, DecodedFrame, VideoDecoderOptions } from './decoders/decoder-interface';
export { isVideoFrame, isYUVFrame } from './decoders/decoder-interface';

// Audio
export { FileAudioPlayer } from './audio/file-audio-player';
export { LiveAudioPlayer } from './audio/live-audio-player';
export type { LiveAudioConfig } from './audio/live-audio-player';

// Utilities
export { FrameScheduler } from './scheduling/frame-scheduler';
export type { FrameTiming, LatencyStats, SchedulerStatus, SchedulerConfig, PacketTimingEntry } from './scheduling/frame-scheduler';

// Protocol
export { SesameBinaryProtocol } from './protocol/sesame-binary-protocol';
export type { ParsedData, HeaderData, HeaderCodecData } from './protocol/sesame-binary-protocol';
