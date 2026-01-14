/**
 * Unified Video Decoder Interface
 * 
 * Provides a common interface for different decoder implementations
 * (WebCodecs and WASM).
 */

import type { ParsedData, HeaderCodecData } from '../protocol/sesame-binary-protocol';
import type { YUVFrame } from '../types';

/**
 * Decoder state (matches WebCodecs VideoDecoder states)
 */
export type DecoderState = 'unconfigured' | 'configuring' | 'configured' | 'closed';

/**
 * Frame output from a decoder - can be VideoFrame or YUVFrame
 */
export type DecodedFrame = VideoFrame | YUVFrame;

/**
 * Configuration options for decoder initialization
 */
export interface VideoDecoderOptions {
  /** Callback for decoded frames */
  onFrameDecoded?: (frame: DecodedFrame) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
  /** Callback when decoder queue overflows */
  onQueueOverflow?: (queueSize: number) => void;
  /** Maximum decoder queue size before overflow callback */
  maxQueueSize?: number;
}

/**
 * Common interface for video decoders
 */
export interface IVideoDecoder {
  /**
   * Current decoder state
   */
  readonly state: DecoderState | string;
  
  /**
   * Configure the decoder for a specific codec
   * @param codecData - Codec configuration from stream header
   */
  configure(codecData: HeaderCodecData): Promise<void>;
  
  /**
   * Decode a binary packet from the stream
   * @param data - Parsed stream data containing header and payload
   */
  decodeBinary(data: ParsedData): void;
  
  /**
   * Flush pending frames (synchronous reset)
   */
  flush(): void;
  
  /**
   * Reset the decoder to configured state (ready for new keyframe)
   */
  reset(): void;
  
  /**
   * Dispose the decoder and release resources
   */
  dispose(): void;
}

/**
 * Type guard to check if a frame is a VideoFrame
 */
export function isVideoFrame(frame: DecodedFrame): frame is VideoFrame {
  return frame instanceof VideoFrame;
}

/**
 * Type guard to check if a frame is a YUVFrame
 */
export function isYUVFrame(frame: DecodedFrame): frame is YUVFrame {
  return !isVideoFrame(frame) && 'y' in frame && 'u' in frame && 'v' in frame;
}
