/**
 * Playout Ring
 *
 * The audio worklet's buffer: decoded audio is written at the sample position its timestamp
 * gives, and played from a read position that the player steers to follow a LiveClock.
 *
 * - Positions are absolute stream samples (timestamp * sample rate), so a chunk lands where it
 *   belongs whatever arrived before it: a missing chunk plays as silence without shifting
 *   what follows, and a chunk that arrives after its turn is dropped.
 * - Each slot is tagged with the position it holds, so a slot left over from an earlier lap
 *   (or from before a timestamp discontinuity) never plays in place of a missing one.
 * - The read position advances by `step` stream samples per output sample. One stateful
 *   read does both the sample-rate conversion (step = stream rate / output rate) and the
 *   small speed changes that keep it on the clock, so nothing is lost at chunk boundaries.
 * - Gain fades in and out over a few milliseconds around starts, stops, gaps and jumps.
 *
 * No Web Audio or DOM references: it runs inside the AudioWorkletGlobalScope and in tests.
 */

const EMPTY = 0xffffffff;

export interface PlayoutRingOptions {
  /** Output sample rate (the AudioContext's), for the fade length */
  outputRate: number;
  /** Ring length as a power of two (default: 2^17 samples, 2.7 s at 48 kHz) */
  capacityLog2?: number;
  /** Fade length in milliseconds (default: 4) */
  fadeMs?: number;
}

export class PlayoutRing {
  readonly capacity: number;
  private readonly mask: number;
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly tags: Uint32Array;
  private readonly fadeSamples: number;
  private readonly fadeDelta: number;

  /** Absolute stream position of the next output sample; NaN until the first seek */
  readPos = NaN;
  /** Stream samples per output sample */
  step = 1;
  /** Whether output is audible (the read position advances either way) */
  playing = false;

  private gain = 0;
  private shiftPending = false;
  private pendingShift = 0;

  /** Output samples that had no data while playing */
  underrunSamples = 0;
  /** Samples dropped because they arrived after their turn */
  lateSamples = 0;
  /** Samples dropped because they were further ahead than the ring holds */
  overflowSamples = 0;

  constructor(options: PlayoutRingOptions) {
    const log2 = options.capacityLog2 ?? 17;
    this.capacity = 1 << log2;
    this.mask = this.capacity - 1;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.tags = new Uint32Array(this.capacity).fill(EMPTY);
    this.fadeSamples = Math.max(1, Math.round(((options.fadeMs ?? 4) / 1000) * options.outputRate));
    this.fadeDelta = 1 / this.fadeSamples;
  }

  /**
   * Write samples starting at absolute stream position `pos` (an integer). Mono input
   * passes `right` as null. Returns how many samples were stored.
   */
  write(pos: number, left: Float32Array, right: Float32Array | null): number {
    const n = left.length;
    let from = 0;
    let to = n;
    if (this.readPos === this.readPos) {   // not NaN: drop what is behind the read position or out of reach
      const earliest = Math.floor(this.readPos) - 2;
      const latest = Math.floor(this.readPos) + this.capacity - 8;
      if (pos < earliest) from = Math.min(n, earliest - pos);
      if (pos + n > latest) to = Math.max(from, latest - pos);
      this.lateSamples += from;
      this.overflowSamples += n - to;
    }
    const r = right ?? left;
    for (let k = from; k < to; k++) {
      const p = pos + k;
      const i = p & this.mask;
      this.tags[i] = p >>> 0;
      this.left[i] = left[k];
      this.right[i] = r[k];
    }
    return to - from;
  }

  /** Move the read position to `pos`; while audible it fades out, jumps, and fades back in. */
  seek(pos: number): void {
    if (this.readPos !== this.readPos || this.gain === 0) {
      this.readPos = pos;
      this.shiftPending = false;
    } else {
      this.shift(pos - this.readPos);
    }
  }

  /** Move the read position by `delta` samples, with the same fades as seek(). */
  shift(delta: number): void {
    if (this.readPos !== this.readPos) return;
    if (this.gain === 0) {
      this.readPos += delta;
      this.shiftPending = false;
      return;
    }
    this.pendingShift = this.shiftPending ? this.pendingShift + delta : delta;
    this.shiftPending = true;
  }

  /** Forget all stored audio (the read position stays). */
  clear(): void {
    this.tags.fill(EMPTY);
  }

  /** Forget the stored audio and the read position. */
  reset(): void {
    this.clear();
    this.readPos = NaN;
    this.gain = 0;
    this.shiftPending = false;
  }

  /** Samples of contiguous audio from the read position on, scanning at most `limit`. */
  bufferedAhead(limit: number = this.capacity): number {
    if (this.readPos !== this.readPos) return 0;
    const start = Math.floor(this.readPos);
    let n = 0;
    while (n < limit && this.has(start + n)) n++;
    return n;
  }

  /** Render `outL.length` output samples. */
  render(outL: Float32Array, outR: Float32Array): void {
    const n = outL.length;
    if (this.readPos !== this.readPos) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    const lookahead = this.fadeSamples * this.step;
    for (let i = 0; i < n; i++) {
      if (this.shiftPending && this.gain === 0) {
        this.readPos += this.pendingShift;
        this.shiftPending = false;
      }

      const pos = this.readPos;
      const ip = Math.floor(pos);
      const have = this.has(ip) && this.has(ip + 1);
      const want = this.playing && !this.shiftPending && have && this.has(Math.floor(pos + lookahead)) ? 1 : 0;
      if (this.gain < want) this.gain = Math.min(1, this.gain + this.fadeDelta);
      else if (this.gain > want) this.gain = Math.max(0, this.gain - this.fadeDelta);

      if (this.gain > 0 && have) {
        const f = pos - ip;
        outL[i] = this.interpolate(this.left, ip, f) * this.gain;
        outR[i] = this.interpolate(this.right, ip, f) * this.gain;
      } else {
        outL[i] = 0;
        outR[i] = 0;
        if (this.playing && !have) this.underrunSamples++;
      }
      this.readPos = pos + this.step;
    }
  }

  private has(p: number): boolean {
    return this.tags[p & this.mask] === p >>> 0;
  }

  /** Catmull-Rom between ip and ip + 1; a missing outer neighbour repeats the inner one. */
  private interpolate(data: Float32Array, ip: number, f: number): number {
    const x0 = data[ip & this.mask];
    const x1 = data[(ip + 1) & this.mask];
    if (f === 0) return x0;
    const xm = this.has(ip - 1) ? data[(ip - 1) & this.mask] : x0;
    const x2 = this.has(ip + 2) ? data[(ip + 2) & this.mask] : x1;
    const c1 = 0.5 * (x1 - xm);
    const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
}
