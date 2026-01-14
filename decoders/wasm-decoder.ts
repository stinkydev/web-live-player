/**
 * WASM H264 Decoder
 * 
 * Uses a Web Worker with Broadway.js H264 decoder for software decoding.
 * Outputs YUV frames that need to be converted to RGB for display.
 */

// @ts-ignore - Worker import with inline for library bundling
import H264Worker from './wasm-worker/H264NALDecoder.worker?worker&inline';
import { ParsedData } from '../protocol/sesame-binary-protocol';
import { rescaleTime } from '../protocol/codec-utils';
import type { YUVFrame } from '../types';
import type { IVideoDecoder } from './decoder-interface';

// Re-export for backwards compatibility
export type { YUVFrame } from '../types';

export interface WasmDecoderConfig {
  onFrameDecoded?: (frame: YUVFrame) => void;
  onError?: (error: Error) => void;
  onQueueOverflow?: (queueSize: number) => void;
  maxQueueSize?: number;
}

export class WasmDecoder implements IVideoDecoder {
  private worker?: Worker;
  private _queueSize: number = 0;
  private pendingTimestamps: number[] = [];
  private pendingFrames: Uint8Array[] = [];
  
  private onFrameDecoded?: (frame: YUVFrame) => void;
  private onError?: (error: Error) => void;
  // @ts-ignore - kept for future use
  private onQueueOverflow?: (queueSize: number) => void;
  
  public configured: boolean = false;
  
  constructor(config: WasmDecoderConfig = {}) {
    this.onFrameDecoded = config.onFrameDecoded;
    this.onError = config.onError;
    this.onQueueOverflow = config.onQueueOverflow;
  }
  
  get queueSize(): number {
    return this._queueSize;
  }
  
  /**
   * Get decoder state (for compatibility with WebCodecsDecoder)
   */
  get state(): string {
    if (!this.worker) return 'unconfigured';
    if (!this.configured) return 'configuring';
    return 'configured';
  }
  
  /**
   * Configure the decoder (initializes the worker)
   */
  async configure(_codecData: { codec_type: number; width: number; height: number }): Promise<void> {
    // Dispose any existing worker first
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
    
    this.worker = new H264Worker();
    this.configured = false;
    this._queueSize = 0;
    this.pendingTimestamps = [];
    
    return new Promise((resolve, reject) => {
      this.worker!.addEventListener('message', (e: MessageEvent) => {
        const message = e.data;
        
        switch (message.type) {
          case 'pictureReady':
            this.handlePictureReady(message);
            break;
          case 'decoderReady':
            console.log('[WasmDecoder] Worker ready');
            this.configured = true;
            resolve();
            break;
          case 'error':
            const error = new Error(message.error || 'WASM decoder error');
            this.onError?.(error);
            reject(error);
            break;
        }
      });
      
      this.worker!.addEventListener('error', (e) => {
        const error = new Error(`Worker error: ${e.message}`);
        this.onError?.(error);
        reject(error);
      });
    });
  }
  
  /**
   * Decode a binary packet (same interface as WebCodecsDecoder)
   */
  decodeBinary(data: ParsedData): void {
    if (!this.worker || !this.configured || !data.header || !data.payload) {
      return;
    }
    
    // IMPORTANT: Create a NEW Uint8Array copy - the payload is a slice of a larger buffer
    // that would be detached if we transfer it directly
    const arr = new Uint8Array(data.payload);
    
    // Convert timestamp to microseconds
    const sourceTimebase = data.codec_data?.timebase_den && data.codec_data?.timebase_num
      ? { num: data.codec_data.timebase_num, den: data.codec_data.timebase_den }
      : { num: 1, den: 1000000 };
    const microsecondTimebase = { num: 1, den: 1000000 };
    const pts = rescaleTime(data.header.pts, sourceTimebase, microsecondTimebase);
    
    // Queue the frame (matching Elmo's working implementation)
    this.pendingFrames.push(arr);
    this.pendingTimestamps.push(pts);
    this.decodeNext();
  }
  
  /**
   * Process next frame from queue
   */
  private decodeNext(): void {
    const nextFrame = this.pendingFrames.shift();
    if (nextFrame != null) {
      this.decode(nextFrame);
    }
  }
  
  /**
   * Send frame to worker for decoding
   */
  private decode(data: Uint8Array): void {
    if (!this.worker || !this.configured) {
      return;
    }
    
    this._queueSize++;
    
    // Send to worker - transfer the buffer
    this.worker.postMessage({
      type: 'decode',
      data: data.buffer,
      offset: data.byteOffset,
      length: data.byteLength,
      renderStateId: 1
    }, [data.buffer]);
  }
  
  /**
   * Handle decoded picture from worker
   */
  private handlePictureReady(message: { width: number; height: number; data: ArrayBuffer }): void {
    this._queueSize--;
    
    const { width, height, data } = message;
    const buffer = new Uint8Array(data);
    
    const stride = width;
    const lumaSize = stride * height;
    const chromaSize = lumaSize >> 2;
    
    const yBuffer = buffer.subarray(0, lumaSize);
    const uBuffer = buffer.subarray(lumaSize, lumaSize + chromaSize);
    const vBuffer = buffer.subarray(lumaSize + chromaSize, lumaSize + (2 * chromaSize));
    
    const chromaHeight = height >> 1;
    const chromaStride = stride >> 1;
    
    const timestamp = this.pendingTimestamps.shift() ?? 0;
    
    const frame: YUVFrame = {
      y: yBuffer,
      u: uBuffer,
      v: vBuffer,
      width,
      height,
      chromaStride,
      chromaHeight,
      timestamp,
      close: () => {
        // No-op for YUV frames (they're just typed arrays)
      }
    };
    
    this.onFrameDecoded?.(frame);
  }
  
  /**
   * Flush the decoder (clear pending frames)
   */
  flush(): void {
    this._queueSize = 0;
    this.pendingTimestamps = [];
    this.pendingFrames = [];
  }
  
  /**
   * Synchronous flush
   */
  flushSync(): void {
    this.flush();
  }
  
  /**
   * Reset the decoder (same as flush for WASM decoder)
   */
  reset(): void {
    this.flush();
  }
  
  /**
   * Dispose of the decoder
   */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
    this.configured = false;
    this._queueSize = 0;
    this.pendingTimestamps = [];
    this.pendingFrames = [];
  }
}
