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
 *   It is kept as a whole sample and a fraction: positions on a wall-clock timeline run to
 *   1e14, where a double could not hold the fraction of a step.
 * - The ring grows when audio is written further ahead of the read position than it holds.
 * - Gain fades in and out over a few milliseconds around starts, stops, gaps and jumps.
 *
 * No Web Audio or DOM references: it runs inside the AudioWorkletGlobalScope and in tests.
 */

const EMPTY = 0xffffffff;
/** The ring grows up to this many samples (43 s at 48 kHz) */
const MAX_CAPACITY_LOG2 = 21;

export interface PlayoutRingOptions {
  /** Output sample rate (the AudioContext's), for the fade length */
  outputRate: number;
  /** Starting ring length as a power of two (default: 2^17 samples, 2.7 s at 48 kHz) */
  capacityLog2?: number;
  /** Fade length in milliseconds (default: 4) */
  fadeMs?: number;
}

export class PlayoutRing {
  private _capacity: number;
  private mask: number;
  private left: Float32Array;
  private right: Float32Array;
  private tags: Uint32Array;
  private readonly fadeSamples: number;
  private readonly fadeDelta: number;

  // Read position: a whole stream sample and the fraction past it (0 <= frac < 1); NaN until set
  private readInt = NaN;
  private readFrac = 0;

  /** Stream samples per output sample */
  step = 1;
  /** Whether output is audible */
  playing = false;
  /**
   * Whether the read position keeps moving while muted: a live stream runs on regardless; a paused
   * file holds its place once faded out.
   */
  advanceWhileMuted = true;

  private gain = 0;
  private shiftPending = false;
  private pendingShift = 0;

  /** Output samples that had no data while playing */
  underrunSamples = 0;
  /** Samples dropped because they arrived after their turn */
  lateSamples = 0;
  /** Samples dropped because they were further ahead than the ring can hold */
  overflowSamples = 0;

  constructor(options: PlayoutRingOptions) {
    this._capacity = 1 << (options.capacityLog2 ?? 17);
    this.mask = this._capacity - 1;
    this.left = new Float32Array(this._capacity);
    this.right = new Float32Array(this._capacity);
    this.tags = new Uint32Array(this._capacity).fill(EMPTY);
    this.fadeSamples = Math.max(1, Math.round(((options.fadeMs ?? 4) / 1000) * options.outputRate));
    this.fadeDelta = 1 / this.fadeSamples;
  }

  /** Samples the ring holds */
  get capacity(): number {
    return this._capacity;
  }

  /** Absolute stream position of the next output sample; NaN until the first seek */
  get readPos(): number {
    return this.readInt + this.readFrac;
  }

  /**
   * Write samples starting at absolute stream position `pos` (an integer). Mono input
   * passes `right` as null. Returns how many samples were stored.
   */
  write(pos: number, left: Float32Array, right: Float32Array | null): number {
    const n = left.length;
    let from = 0;
    let to = n;
    if (this.readInt === this.readInt) {   // not NaN: drop what is behind the read position or out of reach
      // During a jump's fade-out, what counts is where the read position is going
      const base = this.shiftPending ? Math.floor(this.readInt + this.readFrac + this.pendingShift) : this.readInt;
      const earliest = base - 2;
      if (pos + n > base + this._capacity - 8) this.grow(pos + n - base + 16, base);
      const latest = base + this._capacity - 8;
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

  /**
   * Make room for `span` samples from `base` on, up to the largest ring, keeping what is stored
   * around the read position.
   */
  private grow(span: number, base: number): void {
    let log2 = Math.log2(this._capacity);
    while ((1 << log2) < span && log2 < MAX_CAPACITY_LOG2) log2++;
    const capacity = 1 << log2;
    if (capacity <= this._capacity) return;

    const left = new Float32Array(capacity);
    const right = new Float32Array(capacity);
    const tags = new Uint32Array(capacity).fill(EMPTY);
    const mask = capacity - 1;
    const start = Math.min(base, this.readInt) - 4;
    for (let p = start; p < start + this._capacity; p++) {
      if (!this.has(p)) continue;
      const from = p & this.mask;
      const to = p & mask;
      tags[to] = p >>> 0;
      left[to] = this.left[from];
      right[to] = this.right[from];
    }
    this._capacity = capacity;
    this.mask = mask;
    this.left = left;
    this.right = right;
    this.tags = tags;
  }

  /**
   * Move the read position to `pos`; while audible it fades out, jumps, and fades back in. A seek
   * made during another's fade-out replaces it.
   */
  seek(pos: number): void {
    if (this.readInt !== this.readInt || this.gain === 0) {
      this.setPosition(pos);
      this.shiftPending = false;
      return;
    }
    this.pendingShift = pos - this.readPos;
    this.shiftPending = true;
  }

  /** Move the read position by `delta` samples, with the same fades as seek(). Shifts add up. */
  shift(delta: number): void {
    if (this.readInt !== this.readInt) return;
    if (this.gain === 0) {
      this.advance(delta);
      this.shiftPending = false;
      return;
    }
    this.pendingShift = this.shiftPending ? this.pendingShift + delta : delta;
    this.shiftPending = true;
  }

  private setPosition(pos: number): void {
    this.readInt = Math.floor(pos);
    this.readFrac = pos - this.readInt;
  }

  /** Move the read position on by `delta` samples, the whole part exactly */
  private advance(delta: number): void {
    const whole = Math.floor(delta);
    this.readFrac += delta - whole;
    const carry = Math.floor(this.readFrac);
    this.readFrac -= carry;
    this.readInt += whole + carry;
  }

  /** Forget all stored audio (the read position stays). */
  clear(): void {
    this.tags.fill(EMPTY);
  }

  /** Forget the stored audio and the read position. */
  reset(): void {
    this.clear();
    this.readInt = NaN;
    this.readFrac = 0;
    this.gain = 0;
    this.shiftPending = false;
  }

  /** Samples of contiguous audio from the read position on, scanning at most `limit`. */
  bufferedAhead(limit: number = this._capacity): number {
    if (this.readInt !== this.readInt) return 0;
    let n = 0;
    while (n < limit && this.has(this.readInt + n)) n++;
    return n;
  }

  /** Render `outL.length` output samples. */
  render(outL: Float32Array, outR: Float32Array): void {
    const n = outL.length;
    if (this.readInt !== this.readInt) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    const lookahead = this.fadeSamples * this.step;
    for (let i = 0; i < n; i++) {
      if (this.shiftPending && this.gain === 0) {
        this.advance(this.pendingShift);
        this.shiftPending = false;
      }

      const ip = this.readInt;
      const f = this.readFrac;
      const have = this.has(ip) && this.has(ip + 1);
      const want = this.playing && !this.shiftPending && have && this.has(ip + Math.floor(f + lookahead)) ? 1 : 0;
      if (this.gain < want) this.gain = Math.min(1, this.gain + this.fadeDelta);
      else if (this.gain > want) this.gain = Math.max(0, this.gain - this.fadeDelta);

      if (this.gain > 0 && have) {
        outL[i] = this.interpolate(this.left, ip, f) * this.gain;
        outR[i] = this.interpolate(this.right, ip, f) * this.gain;
      } else {
        outL[i] = 0;
        outR[i] = 0;
        if (this.playing && !have) this.underrunSamples++;
      }
      if (this.playing || this.gain > 0 || this.advanceWhileMuted) {
        this.readFrac += this.step;
        if (this.readFrac >= 1) {
          const carry = Math.floor(this.readFrac);
          this.readInt += carry;
          this.readFrac -= carry;
        }
      }
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
