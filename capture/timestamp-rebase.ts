/**
 * Timestamp Rebase
 *
 * Puts a captured track's timestamps on the wall clock that every track of a capture shares.
 *
 * The browser stamps captured frames on clocks of its own, and an audio and a video track do
 * not share one: in Chrome one counts from system start and the other from elsewhere, hours
 * apart. A player that keeps audio and video to their timestamps then cannot play them together.
 *
 * Each frame is matched with when it was delivered. The track's offset is the smallest
 * (delivered - timestamp) seen - the frame held up least on its way - so timestamps land on the
 * wall clock as capture times, give or take the shortest delivery delay. The offset settles over
 * the first second, then follows slow changes (a capture clock drifting against the system's) by
 * at most 1 ms a second, so timestamps never jump. A track whose timestamps jump (a device
 * restarted) settles afresh.
 */

/** The offset settles on the least-delayed frame over this long, in µs... */
const LOCK_US = 1_000_000;
/** ...then follows the least-delayed frame of the last few seconds, kept in buckets this long... */
const BUCKET_US = 1_000_000;
const BUCKETS = 5;
/** ...at most this fast (1 ms a second) */
const MAX_SLEW = 0.001;
/** A frame this far off the offset belongs to a new timeline */
const DISCONTINUITY_US = 1_000_000;

export class TimestampRebaser {
  /** Wall-clock time minus timestamp, in µs; NaN before the first frame */
  offset = NaN;
  private lockedFrom = NaN;
  private lastDelivered = NaN;
  private bucketIds = new Float64Array(BUCKETS).fill(-1);
  private bucketMins = new Float64Array(BUCKETS);

  /** Record a frame as it is delivered. Both in µs; `deliveredUs` on the wall clock. */
  observe(timestampUs: number, deliveredUs: number): void {
    const delta = deliveredUs - timestampUs;

    if (this.offset !== this.offset || Math.abs(delta - this.offset) > DISCONTINUITY_US) {
      this.offset = delta;
      this.lockedFrom = deliveredUs;
      this.lastDelivered = deliveredUs;
      this.bucketIds.fill(-1);
    }

    const bucket = Math.floor(deliveredUs / BUCKET_US);
    const slot = bucket % BUCKETS;
    if (this.bucketIds[slot] !== bucket) {
      this.bucketIds[slot] = bucket;
      this.bucketMins[slot] = delta;
    } else if (delta < this.bucketMins[slot]) {
      this.bucketMins[slot] = delta;
    }

    if (deliveredUs - this.lockedFrom < LOCK_US) {
      this.offset = Math.min(this.offset, delta);
    } else {
      let target = Infinity;
      for (let i = 0; i < BUCKETS; i++) {
        const id = this.bucketIds[i];
        if (id > bucket - BUCKETS && id <= bucket && this.bucketMins[i] < target) target = this.bucketMins[i];
      }
      const step = MAX_SLEW * Math.max(0, deliveredUs - this.lastDelivered);
      this.offset += Math.max(-step, Math.min(step, target - this.offset));
    }
    this.lastDelivered = deliveredUs;
  }

  /** A timestamp of this track on the shared wall clock, in whole µs */
  map(timestampUs: number): number {
    return Math.round(this.offset === this.offset ? timestampUs + this.offset : timestampUs);
  }
}

/** The wall clock in µs, the same in every worker and window (performance.now() is not) */
export function wallClockUs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}
