/**
 * Shared type definitions for the video player library
 */

/**
 * YUV frame data from WASM decoder
 */
export interface YUVFrame {
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  width: number;
  height: number;
  chromaStride: number;
  chromaHeight: number;
  timestamp: number;
  /** Compatibility with VideoFrame interface */
  close: () => void;
}

/**
 * Stream metadata received from the source
 */
export interface StreamMetadata {
  width: number;
  height: number;
  frameRate?: number;
  codec?: string;
  bitDepth?: number;
}

/**
 * Decoder type preference
 */
export type PreferredDecoder = 'webcodecs-hw' | 'webcodecs-sw' | 'wasm';

/**
 * Logger interface for customizable logging
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Default console logger
 */
export const consoleLogger: Logger = {
  debug: (msg) => console.debug(`[VideoPlayer] ${msg}`),
  info: (msg) => console.info(`[VideoPlayer] ${msg}`),
  warn: (msg) => console.warn(`[VideoPlayer] ${msg}`),
  error: (msg) => console.error(`[VideoPlayer] ${msg}`),
};

/**
 * Silent logger (no output)
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Augment WebCodecs VideoDecoderConfig with latencyMode
 * (not yet in standard TypeScript DOM types)
 */
declare global {
  interface VideoDecoderConfig {
    latencyMode?: 'quality' | 'realtime';
  }
}
