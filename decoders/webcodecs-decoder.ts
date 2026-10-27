/**
 * WebCodecs-based video decoder
 */

import { ParsedFrame, IMediaCodecData } from '@stinkycomputing/sesame-api-client';
import { rescaleTime, getCodecString, timebaseFromCodecData, MICROSECOND_TIMEBASE } from '../protocol/codec-utils';
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
  /**
   * Chunks the VideoDecoder is given at a time (default: no limit). The rest wait here, in
   * order, where discardQueued() can let them go without restarting the decoder.
   */
  maxInDecoder?: number;
  /**
   * Frames the VideoDecoder may hold at once, counting from the chunk going in to its frame
   * coming out (default: no limit). A decoder can take chunks in faster than it puts frames out,
   * so maxInDecoder alone does not keep a backlog here. Leave room for the frames it keeps back
   * to reorder (up to 16 for H.264), or it waits for chunks it is never given.
   */
  maxFramesInDecoder?: number;
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
  private maxInDecoder: number;
  // Chunks given and not yet passed to the VideoDecoder, oldest first from waitingHead
  private waiting: (EncodedVideoChunk | undefined)[] = [];
  private waitingHead = 0;
  private maxFramesInDecoder: number;
  // Timestamps of the chunks passed to the VideoDecoder whose frames have not come out yet, and
  // when each was passed to it
  private inDecoder: number[] = [];
  private inDecoderSince: number[] = [];
  
  public onFrameDecoded?: (frame: VideoFrame) => void;
  public onError?: (error: Error) => void;
  public onQueueOverflow?: (queueSize: number) => void;
  
  // Statistics
  public chunksSentToDecoder = 0;
  public framesDecoded = 0;
  // Whether a frame has come out since the decoder was last configured or reset: until
  // then it is still initialising, and a growing queue says nothing about its speed.
  private outputSinceConfigure = false;
  
  constructor(options: DecoderConfig = {}) {
    this.logger = options.logger ?? consoleLogger;
    this.onFrameDecoded = options.onFrameDecoded ?? options.onFrame;
    this.onError = options.onError;
    this.onQueueOverflow = options.onQueueOverflow;
    this.maxQueueSize = options.maxQueueSize ?? 10;
    this.maxInDecoder = Math.max(1, options.maxInDecoder ?? Infinity);
    this.maxFramesInDecoder = Math.max(1, options.maxFramesInDecoder ?? Infinity);
    this.createDecoder();
  }
  
  /** Chunks given and not yet taken by the decoder, those waiting to be passed to it included */
  get decodeQueueSize(): number {
    return (this.decoder?.decodeQueueSize ?? 0) + this.waitingCount;
  }

  /** Timestamp of the oldest chunk waiting to be passed to the decoder, µs; NaN when none waits */
  get oldestQueuedTimestamp(): number {
    return this.waitingHead < this.waiting.length ? this.waiting[this.waitingHead]!.timestamp : NaN;
  }

  /**
   * Chunks passed to the VideoDecoder whose frames have not come out yet. Unlike decodeQueueSize,
   * this counts those it has taken in too: a decoder can take chunks in as they come and still
   * hold them up, beyond the reach of discardQueued().
   */
  get framesInDecoder(): number {
    return this.inDecoder.length;
  }

  /**
   * When the chunk of the frame being put out was passed to the VideoDecoder (performance.now()),
   * NaN if not known: read it in onFrameDecoded.
   */
  outputStartedAt = NaN;

  /** Whether the decoder has yet to put out a frame since it was configured or reset */
  get starting(): boolean {
    return !this.outputSinceConfigure;
  }

  private get waitingCount(): number {
    return this.waiting.length - this.waitingHead;
  }

  /**
   * Let go of the chunks waiting to be passed to the decoder, without restarting it: the few it
   * already holds still come out. The next chunk given must be a keyframe. Returns how many.
   */
  discardQueued(): number {
    const count = this.waitingCount;
    this.waiting.length = 0;
    this.waitingHead = 0;
    return count;
  }
  
  get state(): string {
    return this.decoder?.state ?? 'closed';
  }
  
  private createDecoder(): void {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.framesDecoded++;
        this.cameOut(frame.timestamp);
        this.outputSinceConfigure = true;
        if (this.onFrameDecoded) {
          this.onFrameDecoded(frame);
        } else {
          // No handler - must close frame to prevent memory leak
          frame.close();
        }
        this.feed();
      },
      error: (e) => {
        this.logger.error(`Decoder error: ${e.message}`);
        if (this.onError) {
          this.onError(e);
        }
      }
    });
    // Passed on as the decoder takes chunks (on output too, for browsers without the event)
    this.decoder.ondequeue = () => this.feed();
  }

  /**
   * A frame came out. Frames come out in timestamp order, so the chunks of earlier ones still
   * counted in never will (the decoder dropped them): they go too, or they would hold room
   * for good.
   */
  private cameOut(timestamp: number): void {
    const held = this.inDecoder;
    const since = this.inDecoderSince;
    this.outputStartedAt = NaN;
    let kept = 0;
    for (let i = 0; i < held.length; i++) {
      if (held[i] === timestamp) this.outputStartedAt = since[i];
      if (held[i] > timestamp) {
        since[kept] = since[i];
        held[kept++] = held[i];
      }
    }
    held.length = kept;
    since.length = kept;
  }

  /** Whether the decoder has room for another chunk */
  private hasRoom(): boolean {
    return (this.decoder?.decodeQueueSize ?? 0) < this.maxInDecoder &&
      this.inDecoder.length < this.maxFramesInDecoder;
  }

  /** Pass waiting chunks to the decoder while it has room */
  private feed(): void {
    const decoder = this.decoder;
    while (this.waitingHead < this.waiting.length && decoder && decoder.state === 'configured' &&
      this.hasRoom()) {
      const chunk = this.waiting[this.waitingHead]!;
      this.waiting[this.waitingHead++] = undefined;
      this.submit(chunk);
    }
    if (this.waitingHead === this.waiting.length) {
      this.waiting.length = 0;
      this.waitingHead = 0;
    }
  }

  /** Give a chunk to the decoder, or have it wait its turn */
  private enqueue(chunk: EncodedVideoChunk): void {
    if (this.waitingCount === 0 && this.hasRoom()) {
      this.submit(chunk);
      return;
    }
    this.waiting.push(chunk);
    this.feed();
  }

  private submit(chunk: EncodedVideoChunk): void {
    try {
      this.chunksSentToDecoder++;
      this.decoder?.decode(chunk);
      this.inDecoder.push(chunk.timestamp);
      this.inDecoderSince.push(performance.now());
    } catch (e) {
      this.logger.error(`Decode error: ${e}`);
    }
  }

  /**
   * Configure the decoder for a specific codec (from IMediaCodecData)
   */
  async configure(codecData: IMediaCodecData, preferHardware?: boolean): Promise<void>;
  /**
   * Configure the decoder with VideoDecoderConfig directly
   */
  async configure(config: VideoDecoderConfig): Promise<void>;
  async configure(codecDataOrConfig: IMediaCodecData | VideoDecoderConfig, preferHardware: boolean = true): Promise<void> {
    // Check if it's a VideoDecoderConfig (has 'codec' string property)
    if ('codec' in codecDataOrConfig && typeof codecDataOrConfig.codec === 'string') {
      return this.configureWithConfig(codecDataOrConfig as VideoDecoderConfig);
    }
    
    // It's IMediaCodecData
    return this.configureWithCodecData(codecDataOrConfig as IMediaCodecData, preferHardware);
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
   * Configure with IMediaCodecData (from binary protocol)
   */
  private async configureWithCodecData(codecData: IMediaCodecData, preferHardware: boolean = true): Promise<void> {
    const codecString = getCodecString(codecData);
    
    if (!codecString) {
      throw new Error(`Unsupported codec type: ${codecData.codecType}`);
    }
    
    const width = codecData.width ?? 0;
    const height = codecData.height ?? 0;
    
    // Try multiple configurations for fallback
    const configs: VideoDecoderConfig[] = [
      {
        codec: codecString,
        codedWidth: width,
        codedHeight: height,
        hardwareAcceleration: preferHardware ? 'prefer-hardware' : 'prefer-software',
        optimizeForLatency: true,
      },
      {
        codec: codecString,
        codedWidth: width,
        codedHeight: height,
        hardwareAcceleration: preferHardware ? 'prefer-software' : 'prefer-hardware',
        optimizeForLatency: true,
      },
    ];
    
    // Try each config until one works
    for (const config of configs) {
      const support = await VideoDecoder.isConfigSupported(config);
      if (support.supported) {
        this.config = config;
        this.decoder?.configure(config);
        this.logger.info(`Decoder configured: ${codecString} ${width}x${height} (${config.hardwareAcceleration})`);
        return;
      }
    }
    
    throw new Error(`Codec configuration not supported: ${codecString}`);
  }
  
  /**
   * Decode a binary packet
   *
   * @param timestampUs - Optional pre-rescaled PTS in microseconds (skips the rescale)
   */
  decodeBinary(data: ParsedFrame, timestampUs?: number): void {
    if (this.flushing) {
      this.logger.warn('Received packet while flushing');
      return;
    }

    if (!data.header || !data.payload || !this.decoder || this.decoder.state !== 'configured') {
      return;
    }

    if (!this.admit(!!data.header.media?.keyframe)) {
      return;
    }

    // Convert timestamp to microseconds (unless the caller already did)
    const pts = timestampUs ?? rescaleTime(
      data.header.media?.pts ?? 0,
      timebaseFromCodecData(data.header.media?.codecData),
      MICROSECOND_TIMEBASE
    );

    const chunk = new EncodedVideoChunk({
      timestamp: pts,
      type: data.header.media?.keyframe ? 'key' : 'delta',
      data: data.payload ?? new Uint8Array(0),
    });
    this.enqueue(chunk);
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
    
    if (!this.admit(sample.isKeyframe)) {
      return;
    }
    
    const chunk = new EncodedVideoChunk({
      timestamp: sample.timestamp,
      duration: sample.duration,
      type: sample.isKeyframe ? 'key' : 'delta',
      data: sample.data,
    });
    this.enqueue(chunk);
  }
  
  /**
   * Back-pressure. The queue grows when the decoder cannot keep up, or when its output
   * is not being drained (a busy main thread delays the output callbacks). A delta frame
   * that finds the queue full is dropped and reported, so the player waits for the next
   * keyframe; the queued frames still decode and show. A keyframe that finds the queue
   * full throws the backlog away and playback resumes from this frame instead of a group
   * later: the chunks waiting their turn are let go, or - when the decoder holds them all -
   * the decoder restarts on the spot.
   */
  private admit(isKeyframe: boolean): boolean {
    if (!this.decoder || this.decodeQueueSize <= this.maxQueueSize) {
      return true;
    }
    // still initialising: the queue drains once it starts, and a restart would only
    // start the initialisation over
    if (!this.outputSinceConfigure) {
      return true;
    }
    if (!isKeyframe) {
      this.onQueueOverflow?.(this.decodeQueueSize);
      return false;
    }
    if (this.waitingCount > 0) {
      this.logger.warn(`Decoder queue full (${this.decodeQueueSize} frames) at a keyframe, carrying on from it`);
      this.discardQueued();
      return true;
    }
    this.logger.warn(`Decoder queue full (${this.decodeQueueSize} frames) at a keyframe, restarting from it`);
    this.reset();
    return this.decoder.state === 'configured';
  }

  /**
   * Flush the decoder (async - waits for pending frames)
   */
  async flush(): Promise<void> {
    if (!this.decoder || this.decoder.state === 'closed') {
      return;
    }
    
    this.flushing = true;

    // Everything given is decoded, the chunks still waiting too
    for (let i = this.waitingHead; i < this.waiting.length; i++) this.submit(this.waiting[i]!);
    this.discardQueued();

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
    this.discardQueued();
    this.inDecoder.length = 0;
    this.inDecoderSince.length = 0;
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
      
      if (this.config) {
        this.decoder.configure(this.config);
      this.outputSinceConfigure = false;
      }
    }
    this.flushing = false;
  }
  
  /**
   * Reset the decoder
   */
  reset(): void {
    this.discardQueued();
    this.inDecoder.length = 0;
    this.inDecoderSince.length = 0;
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
      
      if (this.config) {
        this.decoder.configure(this.config);
      this.outputSinceConfigure = false;
      }
    }
  }
  
  /**
   * Dispose the decoder
   */
  dispose(): void {
    this.discardQueued();
    this.inDecoder.length = 0;
    this.inDecoderSince.length = 0;
    if (this.decoder) {
      if (this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
    }
    this.config = undefined;
  }
}
