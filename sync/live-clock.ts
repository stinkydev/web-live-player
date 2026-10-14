/**
 * Live Clock
 *
 * The playout timeline of a live stream: which stream timestamp is due at a given moment.
 * Video and audio players present whatever the clock says is due, so every consumer that
 * shares a clock plays in sync with the others, whoever owns them.
 *
 * The clock runs a fixed `bufferDelayMs` behind the earliest-arriving packets. Each packet
 * gives `arrival - pts`: the offset between the stream's timeline and the local one, plus
 * however long that packet was held up on the way. The smallest offset over the last few
 * seconds is the packet that was held up least, so the clock puts the stream's timestamps
 * at `now - minOffset - bufferDelay`. A packet that arrives later than that is late and its
 * consumer drops it: latency never grows to wait for one.
 *
 * Small corrections (the publisher's clock drifting against the local one, a change in
 * network delay) are made by running the clock up to `maxRateAdjust` fast or slow; large
 * ones (a new buffer delay, a much faster path) by jumping.
 *
 * Players also have latency of their own that the delay has to cover before any network
 * jitter: a video decoder takes time to turn a packet into a picture, and an audio output
 * renders ahead of what is heard. Each reports what it needs with setMinimumDelay(), and the
 * clock runs at the larger of the buffer delay and the largest of those, so a small buffer
 * delay gives the lowest latency at which every player keeps up - in sync, and without
 * dropping audio - rather than broken playback. Network lateness never raises it.
 */

export interface LiveClockConfig {
  /** Delay behind the earliest-arriving packets, in milliseconds (default: 150) */
  bufferDelayMs?: number;
  /** Largest speed change used to correct the clock, as a fraction (default: 0.01 = 1%) */
  maxRateAdjust?: number;
  /** Time source in milliseconds (default: performance.now) */
  now?: () => number;
  /** Logger for jumps and discontinuities */
  logger?: (message: string) => void;
}

export interface LiveClockStats {
  /** Whether the clock has started */
  running: boolean;
  /** The delay asked for */
  bufferDelayMs: number;
  /** The delay the clock runs at: the buffer delay, or the players' minimum if that is larger */
  effectiveDelayMs: number;
  /** The largest delay a player on the clock needs to keep up, in ms */
  minimumDelayMs: number;
  /** Current speed, 1 = real time */
  rate: number;
  /** How far the clock is from where it should be, in ms (positive = ahead) */
  errorMs: number;
  /** Times the clock jumped instead of slewing */
  jumps: number;
  /** Timestamp discontinuities seen (publisher restarts) */
  discontinuities: number;
  /** How late the newest packet arrived compared with the earliest-arriving ones, in ms */
  lastPacketLatenessMs: number;
}

export const DEFAULT_BUFFER_DELAY_MS = 150;

/** The earliest-arrival window is kept in buckets of this length... */
const BUCKET_MS = 1000;
/** ...this many of them, so the minimum covers the last 4-5 seconds. */
const BUCKETS = 5;
/** After the first packet, the burst a subscription starts with settles before the clock runs. */
const STARTUP_MS = 150;
/** Errors larger than this are fixed by a jump, smaller ones by running fast or slow. */
const JUMP_THRESHOLD_US = 100_000;
/** Time constant of rate corrections: an error of 1 ms asks for 0.1% */
const SLEW_TIME_US = 1_000_000;
/** Updates closer together than this reuse the current rate */
const UPDATE_INTERVAL_MS = 10;
/** Players' minimum delays are rounded up to this step... */
const MINIMUM_STEP_MS = 5;
/** ...and the floor comes down only when they have fallen this far below it */
const MINIMUM_HYSTERESIS_MS = 10;
/**
 * A track whose `arrival - pts` moves by more than this between two packets is on a new
 * timeline (the publisher restarted). A plain gap moves both by the same amount.
 */
const DISCONTINUITY_MS = 2000;
/**
 * When every packet has arrived after its turn for this long, the earliest arrivals in the
 * window came over a faster path that is gone (a reconnect, a new route): start over from the
 * packets arriving now rather than drop everything until they leave the window.
 */
const LATE_RESET_MS = 1000;

export class LiveClock {
  private bufferDelayMs: number;
  private maxRateAdjust: number;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;

  // Earliest-arrival window: per-bucket minimum of arrival - pts (ms)
  private bucketIds = new Float64Array(BUCKETS).fill(-1);
  private bucketMins = new Float64Array(BUCKETS);
  private offsetMs: number | null = null;
  private firstPacketMs: number | null = null;

  // The timeline: pts(t) = anchorPtsUs + (t - anchorMs) * 1000 * rate
  private running = false;
  private anchorMs = 0;
  private anchorPtsUs = 0;
  private _rate = 1;
  private lastUpdateMs = -Infinity;
  private lastErrorUs = 0;

  // Per-track arrival - pts of the previous packet, for discontinuity detection
  private lastRelative = new Map<string, number>();
  private lastLatenessMs = 0;
  // Start and earliest arrival of the current run of late packets
  private lateSinceMs: number | null = null;
  private lateMinRelative = Infinity;

  private jumps = 0;
  private discontinuities = 0;

  // What the players on the clock need, and the floor that makes
  private minimumDelays = new Map<string, number>();
  private floorMs = 0;

  constructor(config: LiveClockConfig = {}) {
    this.bufferDelayMs = Math.max(0, config.bufferDelayMs ?? DEFAULT_BUFFER_DELAY_MS);
    this.maxRateAdjust = Math.max(0, config.maxRateAdjust ?? 0.01);
    this.now = config.now ?? (() => performance.now());
    this.logger = config.logger ?? (() => {});
  }

  /** Whether the clock has started: before that, nothing is due. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Current speed, 1 = real time. */
  get rate(): number {
    return this._rate;
  }

  /** How late the last packet reported arrived compared with the earliest-arriving ones, in ms */
  get packetLatenessMs(): number {
    return this.lastLatenessMs;
  }

  /** The delay the clock runs at: the buffer delay, or the players' minimum if that is larger */
  getEffectiveDelay(): number {
    return Math.max(this.bufferDelayMs, this.floorMs);
  }

  /**
   * Set the least delay a player needs to keep up, under a key of its own: a video decoder's
   * latency, an audio output's. The clock never runs closer to the arrivals than the largest.
   */
  setMinimumDelay(key: string, delayMs: number): void {
    this.minimumDelays.set(key, Math.max(0, delayMs));
    this.refreshFloor();
  }

  /** Drop a player's minimum (it has gone). */
  clearMinimumDelay(key: string): void {
    if (this.minimumDelays.delete(key)) this.refreshFloor();
  }

  private refreshFloor(): void {
    let max = 0;
    for (const value of this.minimumDelays.values()) max = Math.max(max, value);
    const stepped = Math.ceil(max / MINIMUM_STEP_MS) * MINIMUM_STEP_MS;
    const before = this.getEffectiveDelay();
    if (stepped > this.floorMs) {
      this.floorMs = stepped;
    } else if (stepped < this.floorMs - MINIMUM_HYSTERESIS_MS) {
      // Lower: the clock runs a little fast to get there
      this.floorMs = stepped;
      return;
    } else {
      return;
    }
    // Higher: a player is missing its turn now, so jump rather than slew
    if (this.getEffectiveDelay() > before) this.jumpToTarget(this.now());
  }

  /** Re-anchor the timeline on the target at `timeMs` */
  private jumpToTarget(timeMs: number): void {
    if (!this.running || this.offsetMs === null) return;
    this.anchorMs = timeMs;
    this.anchorPtsUs = (timeMs - this.offsetMs - this.getEffectiveDelay()) * 1000;
    this._rate = 1;
    this.lastErrorUs = 0;
    this.lastUpdateMs = timeMs;
    this.jumps++;
  }

  /**
   * Report a packet as it arrives (before decoding). Every consumer reports the packets of
   * its own track under its own key; the key only matters for spotting discontinuities.
   */
  onPacket(track: string, ptsUs: number, arrivalMs: number = this.now()): void {
    const relative = arrivalMs - ptsUs / 1000;

    const previous = this.lastRelative.get(track);
    this.lastRelative.set(track, relative);
    if (previous !== undefined && Math.abs(relative - previous) > DISCONTINUITY_MS) {
      this.discontinuities++;
      this.logger(`Clock: timestamp discontinuity on '${track}' (${Math.round(relative - previous)}ms), re-syncing`);
      this.restart();
      this.lastRelative.set(track, relative);
    }

    if (this.firstPacketMs === null) {
      this.firstPacketMs = arrivalMs;
    }

    const bucket = Math.floor(arrivalMs / BUCKET_MS);
    const slot = ((bucket % BUCKETS) + BUCKETS) % BUCKETS;
    if (this.bucketIds[slot] !== bucket) {
      this.bucketIds[slot] = bucket;
      this.bucketMins[slot] = relative;
    } else if (relative < this.bucketMins[slot]) {
      this.bucketMins[slot] = relative;
    }
    this.refreshOffset(bucket);
    this.lastLatenessMs = this.offsetMs === null ? 0 : relative - this.offsetMs;

    if (this.running && this.lastLatenessMs > this.getEffectiveDelay() + 10) {
      if (this.lateSinceMs === null) {
        this.lateSinceMs = arrivalMs;
        this.lateMinRelative = relative;
      } else {
        this.lateMinRelative = Math.min(this.lateMinRelative, relative);
        if (arrivalMs - this.lateSinceMs > LATE_RESET_MS) {
          this.reseed(bucket, arrivalMs);
          return;
        }
      }
    } else {
      this.lateSinceMs = null;
    }

    this.update(arrivalMs, true);
  }

  /** Start the window over from the run of late packets, and jump to it */
  private reseed(bucket: number, timeMs: number): void {
    this.logger(`Clock: every packet late for ${LATE_RESET_MS}ms, re-syncing ${Math.round(this.lateMinRelative - (this.offsetMs ?? 0))}ms later`);
    this.bucketIds.fill(-1);
    const slot = ((bucket % BUCKETS) + BUCKETS) % BUCKETS;
    this.bucketIds[slot] = bucket;
    this.bucketMins[slot] = this.lateMinRelative;
    this.offsetMs = this.lateMinRelative;
    this.lateSinceMs = null;
    this.anchorMs = timeMs;
    this.anchorPtsUs = (timeMs - this.offsetMs - this.getEffectiveDelay()) * 1000;
    this._rate = 1;
    this.lastErrorUs = 0;
    this.lastUpdateMs = timeMs;
    this.jumps++;
  }

  /**
   * The stream timestamp due at `timeMs` (default: now), in microseconds, or null while the
   * clock has not started.
   */
  ptsAt(timeMs: number = this.now()): number | null {
    if (!this.running) {
      this.update(timeMs, false);
      if (!this.running) return null;
    } else {
      this.update(timeMs, false);
    }
    return this.anchorPtsUs + (timeMs - this.anchorMs) * 1000 * this._rate;
  }

  /**
   * Where the clock is heading at `timeMs`, available from the first packet on - before the
   * clock starts too. Consumers use it to discard what is already too old to be shown.
   */
  targetAt(timeMs: number = this.now()): number | null {
    if (this.offsetMs === null) return null;
    return (timeMs - this.offsetMs - this.getEffectiveDelay()) * 1000;
  }

  /** Change the delay. A running clock jumps to it rather than drifting there. */
  setBufferDelay(delayMs: number): void {
    const delay = Math.max(0, delayMs);
    if (delay === this.bufferDelayMs) return;
    const before = this.getEffectiveDelay();
    this.bufferDelayMs = delay;
    if (this.getEffectiveDelay() !== before) this.jumpToTarget(this.now());
  }

  getBufferDelay(): number {
    return this.bufferDelayMs;
  }

  /** Forget the timeline: the next packets start the clock afresh. */
  reset(): void {
    this.restart();
    this.lastRelative.clear();
  }

  getStats(): LiveClockStats {
    return {
      running: this.running,
      bufferDelayMs: this.bufferDelayMs,
      effectiveDelayMs: this.getEffectiveDelay(),
      minimumDelayMs: this.floorMs,
      rate: this._rate,
      errorMs: Math.round(this.lastErrorUs / 100) / 10,
      jumps: this.jumps,
      discontinuities: this.discontinuities,
      lastPacketLatenessMs: Math.round(this.lastLatenessMs * 10) / 10,
    };
  }

  private restart(): void {
    this.bucketIds.fill(-1);
    this.offsetMs = null;
    this.lateSinceMs = null;
    this.firstPacketMs = null;
    this.running = false;
    this._rate = 1;
    this.lastErrorUs = 0;
    this.lastUpdateMs = -Infinity;
  }

  /** Minimum over the buckets still inside the window; kept as is when none are. */
  private refreshOffset(currentBucket: number): void {
    let min = Infinity;
    for (let i = 0; i < BUCKETS; i++) {
      const id = this.bucketIds[i];
      if (id > currentBucket - BUCKETS && id <= currentBucket && this.bucketMins[i] < min) {
        min = this.bucketMins[i];
      }
    }
    if (min !== Infinity) this.offsetMs = min;
  }

  /** Steer the timeline towards the target, by rate for small errors and by jumping for large ones. */
  private update(timeMs: number, force: boolean): void {
    if (this.offsetMs === null || this.firstPacketMs === null) return;
    if (!force && timeMs - this.lastUpdateMs < UPDATE_INTERVAL_MS) return;
    this.lastUpdateMs = timeMs;

    const targetUs = (timeMs - this.offsetMs - this.getEffectiveDelay()) * 1000;

    if (!this.running) {
      if (timeMs - this.firstPacketMs < STARTUP_MS) return;
      this.running = true;
      this.anchorMs = timeMs;
      this.anchorPtsUs = targetUs;
      this._rate = 1;
      this.lastErrorUs = 0;
      return;
    }

    // Re-anchor at the current position so a rate change never moves it
    const currentUs = this.anchorPtsUs + (timeMs - this.anchorMs) * 1000 * this._rate;
    this.anchorMs = timeMs;
    this.anchorPtsUs = currentUs;

    const errorUs = currentUs - targetUs;
    this.lastErrorUs = errorUs;

    if (Math.abs(errorUs) > JUMP_THRESHOLD_US) {
      this.jumps++;
      this.logger(`Clock: jumping ${Math.round(-errorUs / 1000)}ms`);
      this.anchorPtsUs = targetUs;
      this._rate = 1;
      this.lastErrorUs = 0;
      return;
    }

    const adjust = Math.max(-this.maxRateAdjust, Math.min(this.maxRateAdjust, errorUs / SLEW_TIME_US));
    this._rate = 1 - adjust;
  }
}
