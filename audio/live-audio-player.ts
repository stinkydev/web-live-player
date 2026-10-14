/**
 * Live Audio Player
 *
 * Plays a live audio track (Opus or AAC) on a LiveClock. Each decoded chunk is placed in the
 * worklet's ring by its timestamp and heard when the clock says it is due, so the audio stays
 * in sync with every video player on the same clock. Given no clock, it makes its own.
 *
 * Keeping to the clock: every ~20 ms the worklet reports its read position; with the context's
 * output timestamp that says which stream sample is being heard right now. The player compares
 * it with the clock and nudges the read speed (at most half a percent on top of the clock's own
 * rate), or jumps - with fades - when the gap is too large to nudge away. Sample-rate conversion
 * happens in the same read, so a 48 kHz stream on a 44.1 kHz context loses nothing.
 */

import { CodecType, IMediaCodecData, ParsedFrame } from '@stinkycomputing/sesame-api-client';
import { registerWorklet } from './worklet-registry';
import { LiveClock, DEFAULT_BUFFER_DELAY_MS } from '../sync/live-clock';
import { rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase, PtsValue } from '../protocol/codec-utils';
import WORKLET_SOURCE from './live-audio.worklet.ts?worklet-source';

const PROCESSOR_NAME = 'live-audio-playout';

/**
 * Below this buffer delay the audio plays this far behind the clock instead: audio arrives in
 * 20 ms chunks and needs some slack to be there in time. Video keeps the clock's delay.
 */
export const AUDIO_MIN_DELAY_MS = 50;
/** Further off the clock than this, the audio jumps rather than catching up by speed */
const JUMP_THRESHOLD_MS = 20;
/** Time constant of the speed correction: 1 ms off asks for 0.2% */
const FOLLOW_TIME_S = 0.5;
/** Largest speed correction on top of the clock's rate */
const MAX_FOLLOW_ADJUST = 0.005;
/** How slowly the audio device's drift is learned: 1 ms off moves the estimate 0.02% a second */
const DRIFT_TIME_S = 5;
/** Largest device drift compensated */
const MAX_DRIFT = 0.02;
/** Smoothing of the measured error (the output timestamp jitters by a few ms) */
const ERROR_SMOOTHING = 0.3;

export interface LiveAudioConfig {
  /** Buffer delay of the clock the player makes when none is given (default: 150) */
  bufferDelayMs?: number;
  /** Clock to play on. Share one with LiveVideoPlayers to keep them in sync. */
  clock?: LiveClock;
  /** Node the audio goes to (default: the context's destination) */
  destination?: AudioNode;
  /** Name the player's packets are reported under on the clock (default: 'audio') */
  trackKey?: string;
  /** Time source in milliseconds, on the performance.now() timeline (default: performance.now) */
  now?: () => number;
}

export type LiveAudioState = 'idle' | 'waiting' | 'playing' | 'muted';

export interface LiveAudioStats {
  /** idle: not initialized; waiting: no clock or audio yet; playing; muted: stopped */
  state: LiveAudioState;
  /** Audio being heard minus where the clock is, in ms (positive = audio ahead) */
  syncErrorMs: number | null;
  /** Audio buffered ahead of the read position, in ms */
  bufferedMs: number;
  /** Read speed relative to the stream, 1 = real time */
  rate: number;
  /** Learned drift of the audio device against performance.now(), in percent */
  deviceDriftPercent: number;
  /** Total time played as silence for want of audio, in ms */
  underrunMs: number;
  /** Total audio dropped for arriving after its turn, in ms */
  lateMs: number;
  /** Times the audio jumped to get back on the clock */
  jumps: number;
  /** Times the decoder restarted at a gap in the input */
  gaps: number;
  /** Stream sample rate, 0 until the first chunk decodes */
  sampleRate: number;
}

/** A position report from the worklet */
export interface PlayoutReport {
  contextTime: number;
  pos: number;
  step: number;
}

/** A context time and the performance time at which it is heard */
export interface OutputTime {
  contextTime: number;
  performanceTime: number;
}

/**
 * Stream position being heard at `out`: the read position reported at `report.contextTime`,
 * carried on at the reported speed to the context time being output.
 */
export function audiblePosition(report: PlayoutReport, out: OutputTime, contextRate: number): number {
  return report.pos + (out.contextTime - report.contextTime) * contextRate * report.step;
}

/**
 * Keeps the audio's read speed on the clock, from how far ahead of it the audio is heard.
 *
 * - Drift: how fast the audio device runs against performance.now(), learned slowly and
 *   applied in full. It keeps the audio at real-time speed, so it is no audible change of
 *   speed however large (sound cards are often off by a few hundredths of a percent, and
 *   some by far more).
 * - Correction: proportional to what error remains, capped at half a percent.
 */
export class AudioFollower {
  /** Learned device drift: the read speed needed to keep real time, minus 1 */
  drift = 0;
  private smoothedErrorS: number | null = null;

  /**
   * Speed factor on top of the clock's rate, given the error now (seconds, positive = audio
   * ahead) and the time since the last update.
   */
  update(errorS: number, dtS: number): number {
    const e = this.smoothedErrorS === null ? errorS : this.smoothedErrorS + ERROR_SMOOTHING * (errorS - this.smoothedErrorS);
    this.smoothedErrorS = e;
    if (dtS > 0 && dtS < 1) {
      this.drift = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, this.drift - (e * dtS) / DRIFT_TIME_S));
    }
    const adjust = Math.max(-MAX_FOLLOW_ADJUST, Math.min(MAX_FOLLOW_ADJUST, e / FOLLOW_TIME_S));
    return (1 + this.drift) * (1 - adjust);
  }

  /** Speed factor right after a jump: the learned drift alone */
  restart(): number {
    this.smoothedErrorS = null;
    return 1 + this.drift;
  }

  /** Smoothed error, seconds; null right after a jump */
  get errorS(): number | null {
    return this.smoothedErrorS;
  }
}

export class LiveAudioPlayer {
  private ctx: AudioContext;
  private readonly clock: LiveClock;
  private readonly trackKey: string;
  private readonly now: () => number;
  private decoder: AudioDecoder | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode;
  private initialized = false;
  private playing = false;
  private timebase: Timebase = MICROSECOND_TIMEBASE;

  // Stream layout, from the first decoded chunk
  private streamRate = 0;
  private baseStep = 1;
  private nextPos = NaN;
  private lastPtsUs = NaN;
  /** Duration of the last decoded chunk, to tell a gap in the input from the next chunk */
  private chunkDurationUs = 20_000;
  private decoderConfig: AudioDecoderConfig | null = null;
  private decoderResets = 0;

  // Following the clock
  private lastReport: PlayoutReport | null = null;
  private started = false;
  private sentStep = NaN;
  private follower = new AudioFollower();
  private lastReportContextTime = NaN;
  private jumps = 0;
  private bufferedSamples = 0;
  private underrunSamples = 0;
  private lateSamples = 0;
  private warnedCopy = false;

  constructor(context: AudioContext, config: LiveAudioConfig = {}) {
    this.ctx = context;
    this.clock = config.clock ?? new LiveClock({ bufferDelayMs: config.bufferDelayMs ?? DEFAULT_BUFFER_DELAY_MS });
    this.trackKey = config.trackKey ?? 'audio';
    this.now = config.now ?? (() => performance.now());
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(config.destination ?? this.ctx.destination);
  }

  /** The clock the player follows */
  getClock(): LiveClock {
    return this.clock;
  }

  /**
   * Initialize with codec info from the stream header
   */
  async init(codecData?: IMediaCodecData): Promise<void> {
    if (this.ctx.audioWorklet === undefined) {
      throw new Error('AudioWorklet not supported - need localhost or HTTPS');
    }

    const decoderConfig = this.buildDecoderConfig(codecData);
    const support = await AudioDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`Audio codec not supported: ${decoderConfig.codec}`);
    }

    this.timebase = timebaseFromCodecData(codecData);
    this.decoder = new AudioDecoder({
      output: (frame) => this.handleDecodedFrame(frame),
      error: (err) => {
        console.error('LiveAudioPlayer decoder error:', err);
      },
    });
    this.decoder.configure(decoderConfig);
    this.decoderConfig = decoderConfig;

    await registerWorklet(this.ctx, PROCESSOR_NAME, WORKLET_SOURCE);

    this.workletNode = new AudioWorkletNode(this.ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.workletNode.port.onmessage = (event) => this.handleReport(event.data);
    this.workletNode.connect(this.gainNode);
    this.workletNode.port.postMessage({ type: 'playing', value: this.playing });

    this.initialized = true;
  }

  private buildDecoderConfig(codecData?: IMediaCodecData): AudioDecoderConfig {
    const codecType = codecData?.codecType ?? CodecType.CODEC_TYPE_AUDIO_OPUS;
    const sampleRate = codecData?.sampleRate || 48000;
    const channels = codecData?.channels || 2;

    switch (codecType) {
      case CodecType.CODEC_TYPE_AUDIO_OPUS:
        // Opus always decodes at 48 kHz
        return { codec: 'opus', sampleRate: 48000, numberOfChannels: channels };
      case CodecType.CODEC_TYPE_AUDIO_AAC:
        return { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels };
      case CodecType.CODEC_TYPE_AUDIO_PCM:
        throw new Error('PCM audio not yet supported');
      default:
        return { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    }
  }

  /**
   * Queue an encoded audio packet.
   *
   * @param ptsUs - Presentation timestamp in microseconds (number, bigint or Long)
   * @param arrivalMs - When the packet arrived, on the performance.now() timeline (default: now)
   */
  decode(data: Uint8Array, ptsUs?: PtsValue, arrivalMs?: number): void {
    if (!this.initialized || !this.decoder || this.decoder.state !== 'configured' || data.length < 1) {
      return;
    }

    let timestamp: number;
    if (ptsUs === undefined || ptsUs === null) {
      // No timestamp: carry on from the previous packet without telling the clock
      if (this.lastPtsUs !== this.lastPtsUs) return;
      timestamp = this.lastPtsUs + 20_000;
    } else {
      timestamp = rescaleTime(ptsUs, MICROSECOND_TIMEBASE, MICROSECOND_TIMEBASE);
      this.clock.onPacket(this.trackKey, timestamp, arrivalMs ?? this.now());

      // The decoder stamps its output by counting samples from the first chunk it was given,
      // whatever the timestamps of the chunks after it: across a gap in the input (packets lost
      // or skipped) every later chunk would come out early. Restarting the decoder makes it
      // take the next timestamp as given.
      if (this.lastPtsUs === this.lastPtsUs) {
        const step = timestamp - this.lastPtsUs;
        if (step < this.chunkDurationUs / 2 || step > this.chunkDurationUs * 1.5) {
          this.restartDecoder();
        }
      }
    }
    this.lastPtsUs = timestamp;

    try {
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data }));
    } catch (error) {
      console.error('Error decoding live audio:', error);
    }
  }

  /**
   * Queue a parsed stream packet, taking its timestamp in the timebase of the codec data the
   * player was initialized with.
   */
  decodeFrame(frame: ParsedFrame, arrivalMs?: number): void {
    if (!frame.payload || !frame.header) return;
    const pts = frame.header.media?.pts;
    const ptsUs = pts === undefined || pts === null ? undefined : rescaleTime(pts, this.timebase, MICROSECOND_TIMEBASE);
    this.decode(frame.payload, ptsUs, arrivalMs);
  }

  private restartDecoder(): void {
    if (!this.decoder || !this.decoderConfig || this.decoder.state !== 'configured') return;
    this.decoder.reset();
    this.decoder.configure(this.decoderConfig);
    this.decoderResets++;
  }

  private handleDecodedFrame(frame: AudioData): void {
    const node = this.workletNode;
    if (!node) {
      frame.close();
      return;
    }

    try {
      const rate = frame.sampleRate;
      if (rate !== this.streamRate) {
        // A new rate puts positions on a new scale: start the ring over
        this.streamRate = rate;
        this.baseStep = rate / this.ctx.sampleRate;
        this.nextPos = NaN;
        this.started = false;
        this.sentStep = NaN;
        this.follower = new AudioFollower();
        node.port.postMessage({ type: 'reset' });
        this.postStep(this.baseStep * this.clock.rate);
      }

      const frames = frame.numberOfFrames;
      if (frames > 0) this.chunkDurationUs = (frames * 1_000_000) / rate;
      let pos = Math.round((frame.timestamp * rate) / 1_000_000);
      // Chunks that follow on within rounding are kept contiguous
      if (Math.abs(pos - this.nextPos) <= 2) pos = this.nextPos;
      this.nextPos = pos + frames;

      const left = new Float32Array(frames);
      frame.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
      let right: Float32Array | null = null;
      if (frame.numberOfChannels > 1) {
        right = new Float32Array(frames);
        frame.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
      }

      const transfer = right ? [left.buffer, right.buffer] : [left.buffer];
      node.port.postMessage({ type: 'write', pos, left: left.buffer, right: right?.buffer ?? null }, transfer);
    } catch (error) {
      if (!this.warnedCopy) {
        this.warnedCopy = true;
        console.error('Error processing live audio frame:', error);
      }
    } finally {
      frame.close();
    }
  }

  /** The context time being heard and when, from the output timestamp where available */
  private outputTime(): OutputTime {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime && ts.performanceTime) {
      return { contextTime: ts.contextTime, performanceTime: ts.performanceTime };
    }
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return { contextTime: this.ctx.currentTime - latency, performanceTime: this.now() };
  }

  /** Where the audio should be at `perfMs`, in stream samples, or null while the clock has not started */
  private targetPosition(perfMs: number): number | null {
    const pts = this.clock.ptsAt(perfMs);
    if (pts === null) return null;
    const lagUs = Math.max(0, AUDIO_MIN_DELAY_MS - this.clock.getBufferDelay()) * 1000;
    return ((pts - lagUs) * this.streamRate) / 1_000_000;
  }

  private handleReport(msg: any): void {
    if (msg?.type !== 'position') return;
    const dtS = msg.contextTime - this.lastReportContextTime;
    this.lastReportContextTime = msg.contextTime;
    this.lastReport = msg;
    this.bufferedSamples = msg.buffered;
    this.underrunSamples = msg.underrun;
    this.lateSamples = msg.late;

    if (!this.streamRate || this.ctx.state !== 'running') return;

    const out = this.outputTime();
    const target = this.targetPosition(out.performanceTime);
    if (target === null) return;

    if (!this.started || msg.pos !== msg.pos) {
      this.seek(target, out.contextTime);
      this.started = true;
      return;
    }

    const errorS = (audiblePosition(msg, out, this.ctx.sampleRate) - target) / this.streamRate;
    if (Math.abs(errorS) * 1000 > JUMP_THRESHOLD_MS) {
      this.jumps++;
      this.seek(target, out.contextTime);
      return;
    }

    this.postStep(this.baseStep * this.clock.rate * this.follower.update(errorS, dtS));
  }

  private seek(pos: number, contextTime: number): void {
    this.postStep(this.baseStep * this.clock.rate * this.follower.restart());
    this.workletNode?.port.postMessage({ type: 'seek', pos, contextTime });
  }

  private postStep(step: number): void {
    if (Math.abs(step - this.sentStep) < 1e-7) return;
    this.sentStep = step;
    this.workletNode?.port.postMessage({ type: 'step', step });
  }

  /**
   * Stream timestamp being heard at `perfMs` (default: now), in microseconds, or null while
   * nothing is playing.
   */
  audiblePtsAt(perfMs: number = this.now()): number | null {
    const report = this.lastReport;
    if (!this.started || !report || report.pos !== report.pos || !this.streamRate) return null;
    const out = this.outputTime();
    const pos = audiblePosition(report, out, this.ctx.sampleRate)
      + ((perfMs - out.performanceTime) / 1000) * this.ctx.sampleRate * report.step;
    return (pos * 1_000_000) / this.streamRate;
  }

  getStats(): LiveAudioStats {
    const rate = this.streamRate || 48000;
    let syncErrorMs: number | null = null;
    const now = this.now();
    const heard = this.audiblePtsAt(now);
    const due = this.clock.ptsAt(now);
    if (heard !== null && due !== null) {
      const lagUs = Math.max(0, AUDIO_MIN_DELAY_MS - this.clock.getBufferDelay()) * 1000;
      syncErrorMs = Math.round((heard - (due - lagUs)) / 100) / 10;
    }
    let state: LiveAudioState = 'idle';
    if (this.initialized) state = !this.started ? 'waiting' : this.playing ? 'playing' : 'muted';
    return {
      state,
      syncErrorMs,
      bufferedMs: Math.round((this.bufferedSamples / rate) * 1000),
      rate: this.sentStep === this.sentStep ? this.sentStep / this.baseStep : 1,
      deviceDriftPercent: Math.round(this.follower.drift * 1e5) / 1e3,
      underrunMs: Math.round((this.underrunSamples / this.ctx.sampleRate) * 1000),
      lateMs: Math.round((this.lateSamples / rate) * 1000),
      jumps: this.jumps,
      gaps: this.decoderResets,
      sampleRate: this.streamRate,
    };
  }

  /**
   * Set the buffer delay. This is the clock's delay, so on a shared clock it applies to every
   * player on it.
   */
  setBufferDelay(delayMs: number): void {
    this.clock.setBufferDelay(delayMs);
  }

  /**
   * Make the audio heard. Playback keeps to the clock either way, so starting picks up at
   * whatever is due.
   */
  start(): void {
    this.playing = true;
    this.workletNode?.port.postMessage({ type: 'playing', value: true });
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Mute the audio; it keeps to the clock so start() resumes in sync. */
  stop(): void {
    this.playing = false;
    this.workletNode?.port.postMessage({ type: 'playing', value: false });
  }

  /** Drop the buffered audio (for a reset or a reconnect). */
  clear(): void {
    this.nextPos = NaN;
    this.workletNode?.port.postMessage({ type: 'clear' });
  }

  /** Set volume (0-1) */
  setVolume(volume: number): void {
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }

  dispose(): void {
    this.initialized = false;
    this.started = false;

    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') this.decoder.close();
      } catch {
        // Ignore disposal errors
      }
      this.decoder = null;
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore
      }
      this.workletNode = null;
    }

    try {
      this.gainNode.disconnect();
    } catch {
      // Ignore
    }
  }
}
