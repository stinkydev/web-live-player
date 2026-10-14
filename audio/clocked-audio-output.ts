/**
 * Clocked Audio Output
 *
 * Decodes audio and plays it on a clock. Each decoded chunk is placed in the worklet's ring by
 * its timestamp and heard when the clock says it is due, so the audio stays in sync with every
 * video player on the same clock. LiveAudioPlayer (a live stream on a LiveClock) and
 * FileAudioPlayer (a file on a MediaClock) are this with their own clock and decoder setup.
 *
 * Keeping to the clock: every ~20 ms the worklet reports its read position; with the context's
 * output timestamp that says which stream sample is being heard right now. The output compares
 * it with the clock and nudges the read speed (at most half a percent on top of the clock's own
 * rate, plus the audio device's learned drift), or jumps - with fades - when the gap is too large
 * to nudge away. Sample-rate conversion happens in the same read, so a 48 kHz stream on a
 * 44.1 kHz context loses nothing.
 */

import { registerWorklet } from './worklet-registry';
import WORKLET_SOURCE from './live-audio.worklet.ts?worklet-source';

const PROCESSOR_NAME = 'live-audio-playout';

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
/** Decoding a chunk and handing it to the worklet, and the fade looking ahead of the read, in ms */
const PIPELINE_MARGIN_MS = 8;
/** Position reports the output's lead is the largest over (about a second) */
const LEAD_WINDOW = 48;

/** What the audio keeps to */
export interface AudioClock {
  /** Timestamp due at `perfMs` (performance.now() timeline), in µs; null while nothing is due */
  ptsAt(perfMs: number): number | null;
  /** Speed, 1 = real time */
  readonly rate: number;
}

export interface ClockedAudioOutputConfig {
  clock: AudioClock;
  /** Node the audio goes to (default: the context's destination) */
  destination?: AudioNode;
  /**
   * Called with the least delay behind the arrivals the output needs - how far ahead of what is
   * heard it renders, plus decoding - when that changes. A LiveClock takes it as a minimum.
   */
  onMinimumDelay?: (delayMs: number) => void;
  /**
   * Hold the read position while muted (a paused file) rather than keep it moving (a live
   * stream, which runs on regardless)
   */
  holdWhileMuted?: boolean;
  /** Time source in milliseconds, on the performance.now() timeline (default: performance.now) */
  now?: () => number;
  /** Name in log messages */
  name?: string;
}

export type AudioOutputState = 'idle' | 'waiting' | 'playing' | 'muted';

export interface AudioOutputStats {
  /** idle: not configured; waiting: no clock or audio yet; playing; muted: stopped */
  state: AudioOutputState;
  /** Audio being heard minus where the clock is, in ms (positive = audio ahead) */
  syncErrorMs: number | null;
  /** Audio buffered ahead of the read position, in ms */
  bufferedMs: number;
  /** Read speed relative to the stream, 1 = real time */
  rate: number;
  /** Learned drift of the audio device against performance.now(), in percent */
  deviceDriftPercent: number;
  /** How far ahead of what is heard the output renders, in ms (the device's output latency) */
  outputLeadMs: number;
  /** Least delay behind the arrivals the audio needs to play every chunk, in ms */
  minimumDelayMs: number;
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

export class ClockedAudioOutput {
  private ctx: AudioContext;
  private readonly clockSource: AudioClock;
  private readonly onMinimumDelay?: (delayMs: number) => void;
  private readonly holdWhileMuted: boolean;
  private readonly now: () => number;
  private readonly name: string;
  private decoder: AudioDecoder | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode;
  private configured = false;
  private playing = false;

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

  // How far ahead of what is heard the output renders, over the last second
  private leads = new Float64Array(LEAD_WINDOW);
  private leadWrite = 0;
  private outputLeadMs = 0;
  private minimumDelayMs = 0;

  constructor(context: AudioContext, config: ClockedAudioOutputConfig) {
    this.ctx = context;
    this.clockSource = config.clock;
    this.onMinimumDelay = config.onMinimumDelay;
    this.holdWhileMuted = config.holdWhileMuted ?? false;
    this.now = config.now ?? (() => performance.now());
    this.name = config.name ?? 'ClockedAudioOutput';
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(config.destination ?? this.ctx.destination);
  }

  /** Whether configure() has completed */
  get isConfigured(): boolean {
    return this.configured;
  }

  /** Timestamp of the last chunk decoded, in µs; NaN before the first */
  get lastTimestampUs(): number {
    return this.lastPtsUs;
  }

  /** Set up the decoder and the worklet. */
  async configure(decoderConfig: AudioDecoderConfig): Promise<void> {
    if (this.ctx.audioWorklet === undefined) {
      throw new Error('AudioWorklet not supported - need localhost or HTTPS');
    }

    const support = await AudioDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`Audio codec not supported: ${decoderConfig.codec}`);
    }

    this.decoder = new AudioDecoder({
      output: (frame) => this.handleDecodedFrame(frame),
      error: (err) => {
        console.error(`${this.name} decoder error:`, err);
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
    this.workletNode.port.postMessage({ type: 'hold', value: this.holdWhileMuted });

    this.configured = true;
  }

  /** Queue an encoded chunk with its timestamp (and duration, if known) in microseconds. */
  decode(data: Uint8Array, timestampUs: number, durationUs?: number): void {
    if (!this.configured || !this.decoder || this.decoder.state !== 'configured' || data.length < 1) {
      return;
    }

    // The decoder stamps its output by counting samples from the first chunk it was given,
    // whatever the timestamps of the chunks after it: across a gap in the input (packets lost
    // or skipped, a seek) every later chunk would come out early. Restarting the decoder makes it
    // take the next timestamp as given.
    if (this.lastPtsUs === this.lastPtsUs) {
      const step = timestampUs - this.lastPtsUs;
      if (step < this.chunkDurationUs / 2 || step > this.chunkDurationUs * 1.5) {
        this.restartDecoder();
      }
    }
    this.lastPtsUs = timestampUs;

    try {
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: timestampUs, duration: durationUs, data }));
    } catch (error) {
      console.error(`${this.name}: error decoding audio:`, error);
    }
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
        this.postStep(this.baseStep * this.clockSource.rate);
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
        console.error(`${this.name}: error processing audio frame:`, error);
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

  /** Where the audio should be at `perfMs`, in stream samples, or null while nothing is due */
  private targetPosition(perfMs: number): number | null {
    const pts = this.clockSource.ptsAt(perfMs);
    if (pts === null) return null;
    return (pts * this.streamRate) / 1_000_000;
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
    this.measureLead(out);
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

    // Only audible playback says anything about speed: muted, a file holds still and a live
    // stream runs on unchecked, and neither should teach the drift estimate
    if (this.playing) {
      this.postStep(this.baseStep * this.clockSource.rate * this.follower.update(errorS, dtS));
    }
  }

  /**
   * Move to where the clock is now, before anything is written for it - after the clock jumps
   * (a seek in a file), so the audio fed for the new position is not taken as late.
   */
  resync(): void {
    if (!this.streamRate || !this.workletNode) return;
    const out = this.outputTime();
    const target = this.targetPosition(out.performanceTime);
    if (target === null) return;
    this.seek(target, out.contextTime);
    this.started = true;
  }

  /**
   * The worklet renders ahead of what is heard by the output latency, so a chunk has to be in
   * the ring that much before its turn, plus a render quantum and the time to decode it
   */
  private measureLead(out: OutputTime): void {
    this.leads[this.leadWrite] = Math.max(0, (this.ctx.currentTime - out.contextTime) * 1000);
    this.leadWrite = (this.leadWrite + 1) % LEAD_WINDOW;
    let lead = 0;
    for (let i = 0; i < LEAD_WINDOW; i++) lead = Math.max(lead, this.leads[i]);
    this.outputLeadMs = lead;
    const minimum = Math.ceil(lead + (128 / this.ctx.sampleRate) * 1000 + PIPELINE_MARGIN_MS);
    if (minimum !== this.minimumDelayMs) {
      this.minimumDelayMs = minimum;
      this.onMinimumDelay?.(minimum);
    }
  }

  private seek(pos: number, contextTime: number): void {
    // What was heard before the jump says nothing about after it
    this.lastReport = null;
    this.postStep(this.baseStep * this.clockSource.rate * this.follower.restart());
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

  getStats(): AudioOutputStats {
    const rate = this.streamRate || 48000;
    let syncErrorMs: number | null = null;
    const now = this.now();
    const heard = this.audiblePtsAt(now);
    const due = this.clockSource.ptsAt(now);
    if (heard !== null && due !== null) {
      syncErrorMs = Math.round((heard - due) / 100) / 10;
    }
    let state: AudioOutputState = 'idle';
    if (this.configured) state = !this.started ? 'waiting' : this.playing ? 'playing' : 'muted';
    return {
      state,
      syncErrorMs,
      bufferedMs: Math.round((this.bufferedSamples / rate) * 1000),
      rate: this.sentStep === this.sentStep ? this.sentStep / this.baseStep : 1,
      deviceDriftPercent: Math.round(this.follower.drift * 1e5) / 1e3,
      outputLeadMs: Math.round(this.outputLeadMs * 10) / 10,
      minimumDelayMs: this.minimumDelayMs,
      underrunMs: Math.round((this.underrunSamples / this.ctx.sampleRate) * 1000),
      lateMs: Math.round((this.lateSamples / rate) * 1000),
      jumps: this.jumps,
      gaps: this.decoderResets,
      sampleRate: this.streamRate,
    };
  }

  /** Make the audio heard. It keeps to the clock either way, so starting picks up at what is due. */
  start(): void {
    this.playing = true;
    this.workletNode?.port.postMessage({ type: 'playing', value: true });
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Mute the audio. */
  stop(): void {
    this.playing = false;
    this.workletNode?.port.postMessage({ type: 'playing', value: false });
  }

  /** Drop the buffered audio (for a reset, a reconnect or a seek). */
  clear(): void {
    this.nextPos = NaN;
    this.workletNode?.port.postMessage({ type: 'clear' });
  }

  /** Set volume (0-1) */
  setVolume(volume: number): void {
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }

  dispose(): void {
    this.configured = false;
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
