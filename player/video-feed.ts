/**
 * Video feed: the stream's video packets in, decoded frames out.
 *
 * Owns the decoder and everything around it: codec changes and the reconfigure that replays
 * what arrived meanwhile, the wait for a keyframe, the catch-up to the live edge, the queue
 * guard, and the arrival time of every packet so a decoded frame carries its latency. The
 * player runs one on the main thread; the pipeline worker runs one per video track.
 */

import { IMediaCodecData, ParsedFrame, sesame } from '@stinkycomputing/sesame-api-client';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';
import { WasmDecoder, YUVFrame } from '../decoders/wasm-decoder';
import { codecDataChanged, rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase } from '../protocol/codec-utils';
import type { Logger, PreferredDecoder } from '../types';

/**
 * Chunks the decoder may hold before a delta frame is dropped: ten seconds at 50 fps. A
 * subscription starts with the current group from its first frame, up to a whole GOP at
 * once, and a decoder takes that in its stride; the limit only guards against a decoder
 * that cannot keep up at all. Encoded chunks are small, so the queue costs little.
 */
export const MAX_DECODE_QUEUE = 512;

/** The frames from the last keyframe on; all of them when none is a keyframe. */
export function framesFromLastKeyframe(frames: ParsedFrame[]): ParsedFrame[] {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].header?.media?.keyframe) return frames.slice(i);
  }
  return frames;
}

export interface VideoMetadata {
  width: number;
  height: number;
  codec: string;
}

export interface VideoFeedCallbacks {
  /**
   * A decoded frame, in stream order; the callee owns it. arrivalTime and decodeTime are
   * performance.now() values on the feed's thread.
   */
  onFrame(frame: VideoFrame, timestampUs: number, arrivalTime: number, decodeTime: number, isKeyframe: boolean): void;
  onMetadata?(metadata: VideoMetadata): void;
  /** fatal: the decoder could not be configured, so nothing will decode until the stream changes. */
  onError?(error: Error, fatal: boolean): void;
  /** Decoding needs a keyframe to resume: after a flush, a decoder switch or a lost group. */
  requestKeyframe?(): void;
}

export interface VideoFeedConfig {
  preferredDecoder?: PreferredDecoder;
  logger: Logger;
  debugLogging?: boolean;
}

/** What the player asks of a feed, whether it decodes here or in a pipeline worker. */
export interface IVideoFeed {
  /** A video packet of the stream. */
  push(data: ParsedFrame): void;
  /** Drops what is queued and resumes at the next keyframe. */
  flush(): void;
  /** Returns true when the running decoder was dropped for the change, so buffered frames are stale. */
  setPreferredDecoder(type: PreferredDecoder): boolean;
  setDebugLogging(enabled: boolean): void;
  readonly decoderState: string;
  readonly streamWidth: number;
  readonly streamHeight: number;
  readonly frameRate: number;
  dispose(): void;
}

export class VideoFeed implements IVideoFeed {
  private logger: Logger;
  private debugLogging: boolean;
  private preferred: PreferredDecoder;
  private callbacks: VideoFeedCallbacks;

  private decoder: WebCodecsDecoder | WasmDecoder | null = null;
  private currentCodecData: IMediaCodecData | undefined;
  /** Timebase of the current codec data, cached to keep the decode path allocation-free */
  private currentTimebase: Timebase = MICROSECOND_TIMEBASE;
  private useWasmDecoder = false;
  private waitingForKeyframe = true;
  private lastOverflowLog = 0;
  private lastWaitingForKeyframeLog = 0;
  private lastKeyframeRequest = 0;
  private isConfiguring = false;
  private pendingDuringConfig: ParsedFrame[] = [];
  // While the decoder works through what arrived before it was ready, frames older than the
  // newest of them are decoded (the chain needs them) but not shown: the first picture on
  // screen is the live edge, not a fast-forward of the group.
  private showFromUs = -1;
  /** Reused I420 staging buffer for the WASM decoder path */
  private yuvScratch: Uint8Array | null = null;
  private _framesDecoded = 0;

  // Metadata
  private _streamWidth = 0;
  private _streamHeight = 0;
  private estimatedFrameRate = 30;

  // FPS estimation from video timestamps
  private lastVideoTimestampUs = -1;
  private static readonly FPS_SAMPLE_COUNT = 10;
  private fpsSamples = new Float64Array(VideoFeed.FPS_SAMPLE_COUNT);
  private fpsSampleWrite = 0;
  private fpsSampleCount = 0;
  private fpsSampleSum = 0;

  // Timing tracking: fixed ring of recent packets, keyed by frame timestamp.
  // Parallel typed arrays so recording a packet allocates nothing.
  private static readonly TIMING_RING_SIZE = 128;
  private timingTimestamps = new Float64Array(VideoFeed.TIMING_RING_SIZE);
  private timingArrivals = new Float64Array(VideoFeed.TIMING_RING_SIZE);
  private timingKeyframes = new Uint8Array(VideoFeed.TIMING_RING_SIZE);
  private timingWrite = 0;
  private timingCount = 0;

  constructor(config: VideoFeedConfig, callbacks: VideoFeedCallbacks) {
    this.logger = config.logger;
    this.debugLogging = config.debugLogging ?? false;
    this.preferred = config.preferredDecoder ?? 'webcodecs-sw';
    this.callbacks = callbacks;
  }

  public get decoderState(): string { return this.decoder?.state ?? 'none'; }
  public get decodeQueueSize(): number { return this.decoder?.decodeQueueSize ?? 0; }
  public get streamWidth(): number { return this._streamWidth; }
  public get streamHeight(): number { return this._streamHeight; }
  public get frameRate(): number { return this.estimatedFrameRate; }
  public get framesDecoded(): number { return this._framesDecoded; }
  public get preferredDecoder(): PreferredDecoder { return this.preferred; }

  public setDebugLogging(enabled: boolean): void {
    this.debugLogging = enabled;
  }

  public push(data: ParsedFrame): void {
    if (!data.header?.media?.codecData) {
      return;
    }

    const isKeyframe = !!data.header.media.keyframe;

    if (codecDataChanged(this.currentCodecData, data.header.media.codecData)) {
      // Need keyframe to reconfigure
      if (!isKeyframe) {
        this.logger.debug('Waiting for keyframe (codec change)');
        return;
      }

      // Decoder construction happens outside configureDecoder's own try, so this can
      // reject - handle it here rather than as an unhandled rejection
      this.reconfigureAndReplay(data, data.header.media.codecData)
        .catch((error) => {
          this.isConfiguring = false;
          this.pendingDuringConfig = [];
          this.logger.error(`Decoder reconfiguration failed: ${error}`);
          this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)), true);
        });
      return; // The keyframe is replayed once the decoder is ready
    }

    // Queue frames that arrive during configuration
    if (this.isConfiguring) {
      if (this.debugLogging) {
        this.logger.debug(`Queueing frame pts=${data.header.media?.pts} during configuration`);
      }
      this.pendingDuringConfig.push(data);
      return;
    }

    if (!this.decoder || this.decoder.state !== 'configured') {
      this.logger.warn(`Dropping frame pts=${data.header.media?.pts}: decoder not ready (state=${this.decoder?.state ?? 'null'})`);
      return;
    }

    this.decodeVideoFrame(data);
  }

  public flush(): void {
    this.waitingForKeyframe = true;
    this.showFromUs = -1;
    this.decoder?.flushSync();
    this.callbacks.requestKeyframe?.();
  }

  public setPreferredDecoder(type: PreferredDecoder): boolean {
    const oldType = this.preferred;
    this.preferred = type;
    if (oldType === type || !this.decoder) {
      return false;
    }
    if ((oldType === 'wasm') !== (type === 'wasm')) {
      this.logger.info(`Decoder type changed from ${oldType} to ${type}, switching decoder...`);
    } else {
      this.logger.info(`Decoder preference changed from ${oldType} to ${type}`);
    }
    this.decoder.dispose();
    this.decoder = null;
    this.waitingForKeyframe = true;
    this.currentCodecData = undefined;
    this.callbacks.requestKeyframe?.();
    return true;
  }

  public dispose(): void {
    if (this.decoder) {
      this.decoder.dispose();
      this.decoder = null;
    }
    this.pendingDuringConfig = [];
    this.isConfiguring = false;
    this.timingWrite = 0;
    this.timingCount = 0;
    this.yuvScratch = null;
    this.currentCodecData = undefined;
    this.currentTimebase = MICROSECOND_TIMEBASE;
    this.waitingForKeyframe = true;
    this.showFromUs = -1;
  }

  /** Decode one video frame: dropped while waiting for a keyframe, else timed and sent on. */
  private decodeVideoFrame(data: ParsedFrame): void {
    if (!this.decoder || !data.header?.media) return;
    const isKeyframe = !!data.header.media.keyframe;

    // Wait for keyframe after configuration or flush
    if (this.waitingForKeyframe) {
      if (!isKeyframe) {
        if (this.debugLogging) {
          this.logger.debug(`Dropping frame pts=${data.header.media?.pts}: waiting for keyframe`);
        }
        const now = Date.now();
        // Log occasionally to avoid spam
        if (!this.lastWaitingForKeyframeLog || now - this.lastWaitingForKeyframeLog > 1000) {
          this.logger.info('Waiting for keyframe to resume playback...');
          this.lastWaitingForKeyframeLog = now;

          // Request keyframe periodically while waiting
          if (!this.lastKeyframeRequest || now - this.lastKeyframeRequest > 1000) {
            this.logger.info('Requesting keyframe...');
            this.callbacks.requestKeyframe?.();
            this.lastKeyframeRequest = now;
          }
        }
        return;
      }
      this.logger.debug('Keyframe received, resuming decode');
      this.waitingForKeyframe = false;
      this.lastWaitingForKeyframeLog = 0;
    }

    try {
      // Record arrival time for latency tracking
      // Use rescaled PTS (microseconds) as key to match what decoder outputs
      const arrivalTime = performance.now();
      const timestampUs = rescaleTime(data.header.media?.pts ?? 0, this.currentTimebase, MICROSECOND_TIMEBASE);
      this.recordPacketTiming(timestampUs, arrivalTime, isKeyframe);

      // Estimate FPS from timestamp difference between consecutive frames
      if (this.lastVideoTimestampUs >= 0 && timestampUs > this.lastVideoTimestampUs) {
        const frameDurationUs = timestampUs - this.lastVideoTimestampUs;
        // Only accept reasonable frame durations (1-200 fps range)
        if (frameDurationUs > 5000 && frameDurationUs < 1000000) {
          this.addFpsSample(frameDurationUs);
        }
      }
      this.lastVideoTimestampUs = timestampUs;

      this.decoder.decodeBinary(data, timestampUs);
    } catch (error) {
      this.logger.error(`Decode error: ${error}`);
    }
  }

  /**
   * Reconfigure the decoder for new codec data, then replay the keyframe and
   * anything that arrived while configuring.
   */
  private async reconfigureAndReplay(keyframeData: ParsedFrame, codecData: IMediaCodecData): Promise<void> {
    this.currentCodecData = codecData;
    this.currentTimebase = timebaseFromCodecData(codecData);
    this.isConfiguring = true;
    this.pendingDuringConfig = [keyframeData]; // Queue the keyframe itself

    // Stream timestamps often restart across a codec change, so drop the timing
    // history rather than risk matching a new frame against a stale entry
    this.timingWrite = 0;
    this.timingCount = 0;

    try {
      await this.configureDecoder(codecData);
    } finally {
      // Always clear the flag, otherwise every later frame would be queued
      this.isConfiguring = false;
    }

    this.waitingForKeyframe = true;

    // Replay what arrived while configuring, from the newest keyframe: anything older
    // would only be decoded to be dropped by the scheduler
    const queued = this.pendingDuringConfig;
    this.pendingDuringConfig = [];
    const pending = framesFromLastKeyframe(queued);
    this.logger.info(`Processing ${pending.length} of ${queued.length} frames queued during configuration`);
    const newest = pending[pending.length - 1]?.header?.media;
    this.showFromUs = pending.length > 1 && newest ? rescaleTime(newest.pts ?? 0, this.currentTimebase, MICROSECOND_TIMEBASE) : -1;
    for (const pendingData of pending) {
      this.decodeVideoFrame(pendingData);
    }
  }

  /** Whether a decoded frame is older than the live edge the feed is catching up to. */
  private behindLiveEdge(timestampUs: number): boolean {
    if (this.showFromUs < 0) return false;
    if (timestampUs < this.showFromUs) return true;
    this.showFromUs = -1;
    return false;
  }

  /** Record a packet's arrival time and keyframe flag in the timing ring */
  private recordPacketTiming(timestampUs: number, arrivalTime: number, isKeyframe: boolean): void {
    const i = this.timingWrite;
    this.timingTimestamps[i] = timestampUs;
    this.timingArrivals[i] = arrivalTime;
    this.timingKeyframes[i] = isKeyframe ? 1 : 0;
    this.timingWrite = (i + 1) % VideoFeed.TIMING_RING_SIZE;
    if (this.timingCount < VideoFeed.TIMING_RING_SIZE) {
      this.timingCount++;
    }
  }

  /** Find a recorded packet by stream timestamp, newest first. Returns -1 if unknown. */
  private findPacketTiming(timestampUs: number): number {
    const size = VideoFeed.TIMING_RING_SIZE;
    for (let n = 1; n <= this.timingCount; n++) {
      const i = (this.timingWrite - n + size) % size;
      if (this.timingTimestamps[i] === timestampUs) {
        return i;
      }
    }
    return -1;
  }

  /** Add a frame duration sample and update the frame rate estimate */
  private addFpsSample(frameDurationUs: number): void {
    const i = this.fpsSampleWrite;
    if (this.fpsSampleCount === VideoFeed.FPS_SAMPLE_COUNT) {
      this.fpsSampleSum -= this.fpsSamples[i];
    } else {
      this.fpsSampleCount++;
    }
    this.fpsSamples[i] = frameDurationUs;
    this.fpsSampleSum += frameDurationUs;
    this.fpsSampleWrite = (i + 1) % VideoFeed.FPS_SAMPLE_COUNT;

    if (this.fpsSampleCount >= 3) {
      const avgDurationUs = this.fpsSampleSum / this.fpsSampleCount;
      this.estimatedFrameRate = Math.round(1000000 / avgDurationUs);
    }
  }

  /** Reset the frame rate estimate to its default */
  private resetFpsEstimate(): void {
    this.lastVideoTimestampUs = -1;
    this.fpsSampleWrite = 0;
    this.fpsSampleCount = 0;
    this.fpsSampleSum = 0;
    this.estimatedFrameRate = 30;
  }

  /**
   * Configure the decoder for a specific codec
   */
  private async configureDecoder(codecData: IMediaCodecData): Promise<void> {
    this.useWasmDecoder = this.preferred === 'wasm';

    // Create decoder if needed
    if (!this.decoder || (this.useWasmDecoder && this.decoder instanceof WebCodecsDecoder) ||
        (!this.useWasmDecoder && this.decoder instanceof WasmDecoder)) {
      // Dispose old decoder if switching types
      if (this.decoder) {
        this.decoder.dispose();
      }

      if (this.useWasmDecoder) {
        this.logger.info('Using WASM decoder');
        this.decoder = new WasmDecoder({
          onFrameDecoded: (frame) => this.handleDecodedYUVFrame(frame),
          onError: (error) => this.handleDecoderError(error),
          onQueueOverflow: (queueSize) => this.handleQueueOverflow(queueSize),
          maxQueueSize: MAX_DECODE_QUEUE,
        });
      } else {
        this.logger.info(`Using WebCodecs decoder (${this.preferred})`);
        this.decoder = new WebCodecsDecoder({
          logger: this.logger,
          onFrameDecoded: (frame) => this.handleDecodedFrame(frame),
          onError: (error) => this.handleDecoderError(error),
          onQueueOverflow: (queueSize) => this.handleQueueOverflow(queueSize),
          maxQueueSize: MAX_DECODE_QUEUE,
        });
      }
    }

    const preferHardware = this.preferred === 'webcodecs-hw';

    try {
      if (this.useWasmDecoder) {
        await (this.decoder as WasmDecoder).configure(codecData);
      } else {
        await (this.decoder as WebCodecsDecoder).configure(codecData, preferHardware);
      }

      // Update metadata
      this._streamWidth = codecData.width || 0;
      this._streamHeight = codecData.height || 0;

      // Reset FPS estimation for new stream (keep default of 30 until estimated)
      this.resetFpsEstimate();

      this.callbacks.onMetadata?.({
        width: codecData.width || 0,
        height: codecData.height || 0,
        codec: getCodecName(codecData.codecType || sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AVC),
      });
    } catch (error) {
      this.logger.error(`Failed to configure decoder: ${error}`);
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)), true);
    }
  }

  /**
   * Handle decoded video frame (from WebCodecs)
   */
  private handleDecodedFrame(frame: VideoFrame): void {
    if (this.behindLiveEdge(frame.timestamp)) {
      frame.close();
      return;
    }
    const decodeTime = performance.now();
    const i = this.findPacketTiming(frame.timestamp);
    const arrivalTime = i >= 0 ? this.timingArrivals[i] : decodeTime;
    const isKeyframe = i >= 0 ? this.timingKeyframes[i] === 1 : false;

    this._framesDecoded++;
    this.callbacks.onFrame(frame, frame.timestamp, arrivalTime, decodeTime, isKeyframe);
  }

  /**
   * Handle decoded YUV frame (from WASM decoder)
   * Converts YUV to VideoFrame using canvas
   */
  private handleDecodedYUVFrame(yuvFrame: YUVFrame): void {
    if (this.behindLiveEdge(yuvFrame.timestamp)) return;
    const decodeTime = performance.now();
    const i = this.findPacketTiming(yuvFrame.timestamp);
    const arrivalTime = i >= 0 ? this.timingArrivals[i] : decodeTime;
    const isKeyframe = i >= 0 ? this.timingKeyframes[i] === 1 : false;

    // Pass actual video dimensions for visible rect (decoder may output padded dimensions)
    const videoFrame = this.convertYUVToVideoFrame(yuvFrame, this._streamWidth, this._streamHeight);
    if (videoFrame) {
      this._framesDecoded++;
      this.callbacks.onFrame(videoFrame, yuvFrame.timestamp, arrivalTime, decodeTime, isKeyframe);
    }
  }

  /**
   * Get a scratch buffer of at least `size` bytes for I420 repacking.
   *
   * The VideoFrame constructor copies the data it is given, so one buffer can
   * be reused for every frame.
   */
  private getYUVScratch(size: number): Uint8Array {
    if (!this.yuvScratch || this.yuvScratch.byteLength < size) {
      this.yuvScratch = new Uint8Array(size);
    }
    return this.yuvScratch;
  }

  /**
   * Convert YUV frame to VideoFrame using native I420 support
   * Much faster than manual pixel-by-pixel conversion
   *
   * @param yuv - YUV frame data from decoder (may have padded dimensions)
   * @param visibleWidth - Actual video width (unpadded)
   * @param visibleHeight - Actual video height (unpadded)
   */
  private convertYUVToVideoFrame(yuv: YUVFrame, visibleWidth: number, visibleHeight: number): VideoFrame | null {
    try {
      const { y, u, v, width, height, chromaStride, chromaHeight } = yuv;

      // Use actual video dimensions if available, otherwise use decoded dimensions
      const actualWidth = visibleWidth > 0 ? visibleWidth : width;
      const actualHeight = visibleHeight > 0 ? visibleHeight : height;

      // VideoFrame supports I420 format directly - GPU handles YUV→RGB
      // Broadway decoder outputs Y with stride=width, UV with chromaStride
      const yStride = width;
      const ySize = yStride * height;
      const chromaWidth = width >> 1;
      const uvSize = chromaStride * chromaHeight;
      const totalSize = ySize + uvSize * 2;

      let data: Uint8Array;

      if (yuv.data && chromaStride === chromaWidth && yuv.data.byteLength >= totalSize) {
        // Planes are already contiguous in I420 order - hand the buffer over as is
        data = yuv.data;
      } else {
        data = this.getYUVScratch(ySize + chromaWidth * chromaHeight * 2);

        // Copy Y plane (stride matches width for Broadway)
        data.set(y.subarray(0, ySize), 0);

        // Copy U plane
        const uOffset = ySize;
        if (chromaStride === chromaWidth) {
          // Contiguous - fast copy
          data.set(u.subarray(0, uvSize), uOffset);
        } else {
          // Strided - copy row by row
          for (let row = 0; row < chromaHeight; row++) {
            data.set(u.subarray(row * chromaStride, row * chromaStride + chromaWidth), uOffset + row * chromaWidth);
          }
        }

        // Copy V plane
        const vOffset = uOffset + chromaWidth * chromaHeight;
        if (chromaStride === chromaWidth) {
          data.set(v.subarray(0, uvSize), vOffset);
        } else {
          for (let row = 0; row < chromaHeight; row++) {
            data.set(v.subarray(row * chromaStride, row * chromaStride + chromaWidth), vOffset + row * chromaWidth);
          }
        }
      }

      // Create VideoFrame with I420 format - browser handles YUV→RGB on GPU
      // Use visibleRect to crop padding from H.264 macroblock alignment
      return new VideoFrame(data, {
        format: 'I420',
        codedWidth: width,
        codedHeight: height,
        visibleRect: {
          x: 0,
          y: 0,
          width: actualWidth,
          height: actualHeight,
        },
        timestamp: yuv.timestamp,
        duration: this.estimatedFrameRate > 0 ? 1_000_000 / this.estimatedFrameRate : 33333,
      });
    } catch (error) {
      this.logger.error(`YUV conversion error: ${error}`);
      return null;
    }
  }

  private handleDecoderError(error: Error): void {
    this.logger.error(`Decoder error: ${error.message}`);
    this.callbacks.onError?.(error, false);
  }

  /**
   * The decoder dropped a delta frame because its queue is full. What is queued keeps
   * decoding and showing; decoding resumes at the next keyframe, which the decoder
   * accepts even with a full queue (it restarts from it). Resetting here would throw the
   * queued frames away and black out until that keyframe for no gain.
   */
  private handleQueueOverflow(queueSize: number): void {
    const now = Date.now();
    if (!this.lastOverflowLog || now - this.lastOverflowLog > 1000) {
      this.logger.warn(`Decoder queue full (${queueSize} frames), dropping until the next keyframe`);
      this.lastOverflowLog = now;
    }
    this.waitingForKeyframe = true;
  }
}

function getCodecName(codecType: sesame.v1.common.CodecType): string {
  switch (codecType) {
    case sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AVC: return 'H.264';
    case sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_HEVC: return 'HEVC';
    case sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AV1: return 'AV1';
    default: return 'Unknown';
  }
}
