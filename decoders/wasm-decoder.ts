/**
 * WASM H264 Decoder
 * 
 * Uses a Web Worker with Broadway.js H264 decoder for software decoding.
 * Outputs YUV frames that need to be converted to RGB for display.
 */

// @ts-ignore - Worker import with inline for library bundling
import H264Worker from './wasm-worker/H264NALDecoder.worker?worker&inline';
import { rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE } from '../protocol/codec-utils';
import type { YUVFrame } from '../types';
import type { IVideoDecoder } from './decoder-interface';
import { ParsedFrame } from '@stinkycomputing/sesame-api-client';

// Re-export for backwards compatibility
export type { YUVFrame } from '../types';

export interface WasmDecoderConfig {
  onFrameDecoded?: (frame: YUVFrame) => void;
  onError?: (error: Error) => void;
  onQueueOverflow?: (queueSize: number) => void;
  maxQueueSize?: number;
}

/**
 * The worker copies each NAL into a fixed 1 MB scratch buffer, so anything larger
 * cannot be submitted.
 */
const MAX_NAL_SIZE = 1024 * 1024;

export class WasmDecoder implements IVideoDecoder {
  private worker?: Worker;
  private _queueSize: number = 0;
  /** Access units submitted, used to discard pictures decoded before a flush */
  private seq: number = 0;
  private flushSeq: number = 0;

  private onFrameDecoded?: (frame: YUVFrame) => void;
  private onError?: (error: Error) => void;
  private onQueueOverflow?: (queueSize: number) => void;
  private maxQueueSize: number;

  public configured: boolean = false;

  constructor(config: WasmDecoderConfig = {}) {
    this.onFrameDecoded = config.onFrameDecoded;
    this.onError = config.onError;
    this.onQueueOverflow = config.onQueueOverflow;
    this.maxQueueSize = config.maxQueueSize ?? 10;
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
  async configure(_codecData: any): Promise<void> {
    // Dispose any existing worker first
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
    }
    
    this.worker = new H264Worker();
    this.configured = false;
    this._queueSize = 0;
    this.seq = 0;
    this.flushSeq = 0;

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
   *
   * @param timestampUs - Optional pre-rescaled PTS in microseconds (skips the rescale)
   */
  decodeBinary(data: ParsedFrame, timestampUs?: number): void {
    if (!this.worker || !this.configured || !data.header || !data.payload) {
      return;
    }

    // Back-pressure: drop the access unit rather than growing the worker's queue
    if (this._queueSize > this.maxQueueSize) {
      this.onQueueOverflow?.(this._queueSize);
      return;
    }

    // Convert timestamp to microseconds (unless the caller already did)
    const pts = timestampUs ?? rescaleTime(
      data.header.media?.pts ?? 0,
      timebaseFromCodecData(data.header.media?.codecData),
      MICROSECOND_TIMEBASE
    );

    const seq = this.seq++;
    let expectsPicture = false;

    // The worker decodes one NAL per message, so split the access unit
    forEachNAL(data.payload, (nal) => {
      if (nal.byteLength > MAX_NAL_SIZE) {
        this.onError?.(new Error(`NAL of ${nal.byteLength} bytes exceeds the decoder's ${MAX_NAL_SIZE} byte limit`));
        return;
      }
      if (carriesPicture(nal)) {
        expectsPicture = true;
      }
      this.decode(nal, pts, seq);
    });

    // Only slices produce a picture; counting parameter sets would stall the queue
    if (expectsPicture) {
      this._queueSize++;
    }
  }

  /**
   * Send a single NAL to the worker for decoding
   */
  private decode(nal: Uint8Array, pts: number, seq: number): void {
    if (!this.worker || !this.configured) {
      return;
    }

    // Copy into its own buffer so it can be transferred without detaching the payload
    const owned = new Uint8Array(nal.byteLength);
    owned.set(nal);

    this.worker.postMessage({
      type: 'decode',
      data: owned.buffer,
      offset: 0,
      length: owned.byteLength,
      renderStateId: 1,
      pts,
      seq,
    }, [owned.buffer]);
  }

  /**
   * Handle decoded picture from worker
   */
  private handlePictureReady(message: { width: number; height: number; data: ArrayBuffer; pts?: number; seq?: number }): void {
    // Discard pictures that were decoded before the last flush
    if ((message.seq ?? 0) < this.flushSeq) {
      return;
    }

    if (this._queueSize > 0) {
      this._queueSize--;
    }

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
    
    const timestamp = message.pts ?? 0;

    const frame: YUVFrame = {
      y: yBuffer,
      u: uBuffer,
      v: vBuffer,
      width,
      height,
      chromaStride,
      chromaHeight,
      timestamp,
      // The worker hands back one buffer laid out as Y|U|V with stride === width,
      // which is exactly I420 - expose it so consumers can skip repacking.
      data: buffer.subarray(0, lumaSize + 2 * chromaSize),
      close: () => {
        // No-op for YUV frames (they're just typed arrays)
      }
    };
    
    this.onFrameDecoded?.(frame);
  }
  
  /**
   * Flush the decoder - pictures already in flight are discarded on arrival
   */
  flush(): void {
    this._queueSize = 0;
    this.flushSeq = this.seq;
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
    this.seq = 0;
    this.flushSeq = 0;
  }
}

/**
 * Walk the NAL units of an Annex B byte stream, keeping each start code prefix.
 *
 * Calls `visit` with a view per NAL - the views alias `stream` and are only valid
 * for the duration of the callback.
 */
export function forEachNAL(stream: Uint8Array, visit: (nal: Uint8Array) => void): void {
  const length = stream.byteLength;
  let start = findStartCode(stream, 0);

  if (start < 0) {
    // Not Annex B - hand the buffer over unchanged
    if (length > 0) {
      visit(stream);
    }
    return;
  }

  while (start < length) {
    const next = findStartCode(stream, start + 3);
    const end = next < 0 ? length : next;
    if (end > start) {
      visit(stream.subarray(start, end));
    }
    if (next < 0) {
      return;
    }
    start = next;
  }
}

/**
 * Whether a NAL is a coded slice, i.e. the decoder should emit a picture for it.
 * NAL types 1 (non-IDR slice) and 5 (IDR slice) carry picture data.
 */
export function carriesPicture(nal: Uint8Array): boolean {
  const prefix = startCodeLength(nal);
  if (prefix === 0) {
    // Framing is not Annex B - assume the buffer carries a picture
    return true;
  }
  const nalType = nal[prefix] & 0x1f;
  return nalType === 1 || nalType === 5;
}

/** Length of the Annex B start code at the head of `nal` (0 if there is none) */
function startCodeLength(nal: Uint8Array): number {
  if (nal.byteLength >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) {
    return 4;
  }
  if (nal.byteLength >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) {
    return 3;
  }
  return 0;
}

/** Index of the next 3- or 4-byte Annex B start code at or after `from`, or -1 */
function findStartCode(stream: Uint8Array, from: number): number {
  const limit = stream.byteLength - 3;
  for (let i = Math.max(0, from); i <= limit; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0) {
      if (stream[i + 2] === 1) {
        return i;
      }
      if (stream[i + 2] === 0 && stream[i + 3] === 1) {
        return i;
      }
    }
  }
  return -1;
}
