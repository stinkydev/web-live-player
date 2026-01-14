/**
 * WebCodecs-based video decoder
 */

import { FLAG_IS_KEYFRAME, ParsedData, HeaderCodecData } from '../protocol/sesame-binary-protocol';
import { rescaleTime, getCodecString } from '../protocol/codec-utils';
import type { Logger } from '../types';
import { consoleLogger } from '../types';
import type { IVideoDecoder } from './decoder-interface';

export interface DecoderConfig {
  preferHardware?: boolean;
  logger?: Logger;
  onFrameDecoded?: (frame: VideoFrame) => void;
  /** Alias for onFrameDecoded */
  onFrame?: (frame: VideoFrame) => void;
  onError?: (error: Error) => void;
  onQueueOverflow?: (queueSize: number) => void;
  maxQueueSize?: number;
}

/**
 * Sample data for decoding (from file demuxer)
 */
export interface SampleData {
  data: Uint8Array;
  timestamp: number;    // In microseconds
  duration?: number;    // In microseconds
  isKeyframe: boolean;
}

/**
 * WebCodecs-based video decoder
 */
export class WebCodecsDecoder implements IVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | undefined;
  private flushing = false;
  private logger: Logger;
  private maxQueueSize: number;
  
  public onFrameDecoded?: (frame: VideoFrame) => void;
  public onError?: (error: Error) => void;
  public onQueueOverflow?: (queueSize: number) => void;
  
  // Statistics
  public chunksSentToDecoder = 0;
  public framesDecoded = 0;
  
  constructor(options: DecoderConfig = {}) {
    this.logger = options.logger ?? consoleLogger;
    this.onFrameDecoded = options.onFrameDecoded ?? options.onFrame;
    this.onError = options.onError;
    this.onQueueOverflow = options.onQueueOverflow;
    this.maxQueueSize = options.maxQueueSize ?? 10;
    this.createDecoder();
  }
  
  get decodeQueueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }
  
  get state(): string {
    return this.decoder?.state ?? 'closed';
  }
  
  private createDecoder(): void {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.framesDecoded++;
        if (this.onFrameDecoded) {
          this.onFrameDecoded(frame);
        } else {
          // No handler - must close frame to prevent memory leak
          frame.close();
        }
      },
      error: (e) => {
        this.logger.error(`Decoder error: ${e.message}`);
        if (this.onError) {
          this.onError(e);
        }
      }
    });
  }
  
  /**
   * Configure the decoder for a specific codec (from HeaderCodecData)
   */
  async configure(codecData: HeaderCodecData, preferHardware?: boolean): Promise<void>;
  /**
   * Configure the decoder with VideoDecoderConfig directly
   */
  async configure(config: VideoDecoderConfig): Promise<void>;
  async configure(codecDataOrConfig: HeaderCodecData | VideoDecoderConfig, preferHardware: boolean = true): Promise<void> {
    // Check if it's a VideoDecoderConfig (has 'codec' string property)
    if ('codec' in codecDataOrConfig && typeof codecDataOrConfig.codec === 'string') {
      return this.configureWithConfig(codecDataOrConfig as VideoDecoderConfig);
    }
    
    // It's HeaderCodecData
    return this.configureWithCodecData(codecDataOrConfig as HeaderCodecData, preferHardware);
  }
  
  /**
   * Configure with VideoDecoderConfig
   */
  private async configureWithConfig(baseConfig: VideoDecoderConfig): Promise<void> {
    // Try the provided config first, then fallback with different hardware preference
    const configs: VideoDecoderConfig[] = [
      baseConfig,
      {
        ...baseConfig,
        hardwareAcceleration: baseConfig.hardwareAcceleration === 'prefer-hardware' 
          ? 'prefer-software' 
          : 'prefer-hardware',
      },
    ];
    
    for (const config of configs) {
      const support = await VideoDecoder.isConfigSupported(config);
      if (support.supported) {
        this.config = config;
        this.decoder?.configure(config);
        this.logger.info(`Decoder configured: ${config.codec} ${config.codedWidth}x${config.codedHeight} (${config.hardwareAcceleration ?? 'default'})`);
        return;
      }
    }
    
    throw new Error(`Codec configuration not supported: ${baseConfig.codec}`);
  }
  
  /**
   * Configure with HeaderCodecData (from binary protocol)
   */
  private async configureWithCodecData(codecData: HeaderCodecData, preferHardware: boolean = true): Promise<void> {
    const codecString = getCodecString(codecData);
    
    if (!codecString) {
      throw new Error(`Unsupported codec type: ${codecData.codec_type}`);
    }
    
    // Try multiple configurations for fallback
    const configs: VideoDecoderConfig[] = [
      {
        codec: codecString,
        codedWidth: codecData.width,
        codedHeight: codecData.height,
        hardwareAcceleration: preferHardware ? 'prefer-hardware' : 'prefer-software',
        latencyMode: 'realtime',
      },
      {
        codec: codecString,
        codedWidth: codecData.width,
        codedHeight: codecData.height,
        hardwareAcceleration: preferHardware ? 'prefer-software' : 'prefer-hardware',
        latencyMode: 'realtime',
      },
    ];
    
    // Try each config until one works
    for (const config of configs) {
      const support = await VideoDecoder.isConfigSupported(config);
      if (support.supported) {
        this.config = config;
        this.decoder?.configure(config);
        this.logger.info(`Decoder configured: ${codecString} ${codecData.width}x${codecData.height} (${config.hardwareAcceleration})`);
        return;
      }
    }
    
    throw new Error(`Codec configuration not supported: ${codecString}`);
  }
  
  /**
   * Decode a binary packet
   */
  decodeBinary(data: ParsedData): void {
    if (this.flushing) {
      this.logger.warn('Received packet while flushing');
      return;
    }
    
    if (!data.header || !data.payload || !this.decoder || this.decoder.state !== 'configured') {
      return;
    }
    
    // Check for queue overflow
    if (this.decoder.decodeQueueSize > this.maxQueueSize) {
      if (this.onQueueOverflow) {
        this.onQueueOverflow(this.decoder.decodeQueueSize);
      }
      return;
    }
    
    // Convert timestamp to microseconds
    const sourceTimebase = data.codec_data?.timebase_den && data.codec_data?.timebase_num
      ? { num: data.codec_data.timebase_num, den: data.codec_data.timebase_den }
      : { num: 1, den: 1000000 };
    const microsecondTimebase = { num: 1, den: 1000000 };
    const pts = rescaleTime(data.header.pts, sourceTimebase, microsecondTimebase);
    
    const chunk = new EncodedVideoChunk({
      timestamp: pts,
      type: (data.header.flags & FLAG_IS_KEYFRAME) ? 'key' : 'delta',
      data: data.payload ?? new Uint8Array(0),
    });
    
    try {
      this.chunksSentToDecoder++;
      this.decoder.decode(chunk);
    } catch (e) {
      this.logger.error(`Decode error: ${e}`);
    }
  }
  
  /**
   * Decode a sample (from file demuxer)
   */
  decode(sample: SampleData): void {
    if (this.flushing) {
      this.logger.warn('Received sample while flushing');
      return;
    }
    
    if (!this.decoder || this.decoder.state !== 'configured') {
      return;
    }
    
    // Check for queue overflow
    if (this.decoder.decodeQueueSize > this.maxQueueSize) {
      if (this.onQueueOverflow) {
        this.onQueueOverflow(this.decoder.decodeQueueSize);
      }
      return;
    }
    
    const chunk = new EncodedVideoChunk({
      timestamp: sample.timestamp,
      duration: sample.duration,
      type: sample.isKeyframe ? 'key' : 'delta',
      data: sample.data,
    });
    
    try {
      this.chunksSentToDecoder++;
      this.decoder.decode(chunk);
    } catch (e) {
      this.logger.error(`Decode error: ${e}`);
    }
  }
  
  /**
   * Flush the decoder (async - waits for pending frames)
   */
  async flush(): Promise<void> {
    if (!this.decoder || this.decoder.state === 'closed') {
      return;
    }
    
    this.flushing = true;
    
    try {
      await this.decoder.flush();
    } catch (e) {
      // Flush can fail if decoder was reset
    }
    
    this.flushing = false;
  }
  
  /**
   * Synchronous flush - resets decoder immediately (used for overflow recovery)
   */
  flushSync(): void {
    this.flushing = true;
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
      
      if (this.config) {
        this.decoder.configure(this.config);
      }
    }
    this.flushing = false;
  }
  
  /**
   * Reset the decoder
   */
  reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
      
      if (this.config) {
        this.decoder.configure(this.config);
      }
    }
  }
  
  /**
   * Dispose the decoder
   */
  dispose(): void {
    if (this.decoder) {
      if (this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
    }
    this.config = undefined;
  }
}
