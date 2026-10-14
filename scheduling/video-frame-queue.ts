/**
 * Video Frame Queue
 *
 * Decoded frames waiting to be shown, in timestamp order. The player takes whichever frame its
 * clock says is due; the queue keeps no time of its own. Slots are preallocated and reused, so
 * pushing and taking allocate nothing.
 */

/** Why a queued frame was dropped instead of shown */
export type FrameDropReason =
  /** Already behind the clock when it was decoded, with a newer frame also due */
  | 'late'
  /** Passed over because a newer frame was due by the time it was taken */
  | 'skip'
  /** The queue was full */
  | 'overflow'
  /** The stream's timestamps jumped to a new timeline */
  | 'discontinuity'
  /** clear() */
  | 'clear';

export interface VideoFrameQueueConfig<T> {
  /** Most frames held (default: 30). Decoded frames hold decoder memory. */
  capacity?: number;
  /** Called with every frame dropped; the queue never closes frames itself */
  onDrop?: (frame: T, reason: FrameDropReason, packetIndex: number, packetSeq: number) => void;
}

interface Slot<T> {
  frame: T | null;
  timestamp: number;
  arrivalTime: number;
  decodeTime: number;
  packetIndex: number;
  packetSeq: number;
}

/** A timestamp this far from the queued ones is a new timeline, not a late or early frame */
const DISCONTINUITY_US = 2_000_000;

export class VideoFrameQueue<T> {
  private ring: Slot<T>[];
  private capacity: number;
  private head = 0;
  private count = 0;
  private lastTakenTs = -Infinity;
  private onDrop?: (frame: T, reason: FrameDropReason, packetIndex: number, packetSeq: number) => void;

  /** Arrival time of the frame last returned by take() */
  takenArrivalTime = 0;
  /** Decode time of the frame last returned by take() */
  takenDecodeTime = 0;
  /** Timestamp of the frame last returned by take() */
  takenTimestamp = NaN;

  dropped = 0;
  pushed = 0;

  constructor(config: VideoFrameQueueConfig<T> = {}) {
    this.capacity = Math.max(2, config.capacity ?? 30);
    this.onDrop = config.onDrop;
    this.ring = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.ring[i] = { frame: null, timestamp: 0, arrivalTime: 0, decodeTime: 0, packetIndex: -1, packetSeq: -1 };
    }
  }

  get size(): number {
    return this.count;
  }

  /** Frames the queue holds before it drops the oldest */
  get maxSize(): number {
    return this.capacity;
  }

  /** Hold up to `capacity` frames, keeping those queued. The queue never shrinks. */
  setCapacity(capacity: number): void {
    if (capacity <= this.capacity) return;
    const ring: Slot<T>[] = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      ring[i] = i < this.count
        ? { ...this.slot(i) }
        : { frame: null, timestamp: 0, arrivalTime: 0, decodeTime: 0, packetIndex: -1, packetSeq: -1 };
    }
    this.ring = ring;
    this.capacity = capacity;
    this.head = 0;
  }

  /** Timestamp of the oldest queued frame, NaN when empty */
  get oldestTimestamp(): number {
    return this.count === 0 ? NaN : this.slot(0).timestamp;
  }

  /** Timestamp of the newest queued frame, NaN when empty */
  get newestTimestamp(): number {
    return this.count === 0 ? NaN : this.slot(this.count - 1).timestamp;
  }

  /**
   * Add a decoded frame. `dueUs`, the timestamp the clock is at (null before it starts), lets
   * the queue let go of frames that can no longer be shown: of the frames already due, only the
   * newest is kept.
   */
  push(frame: T, timestampUs: number, arrivalTime: number, decodeTime: number,
    dueUs: number | null, packetIndex = -1, packetSeq = -1): void {
    this.pushed++;

    const reference = this.count > 0 ? this.newestTimestamp : this.lastTakenTs;
    if (reference !== -Infinity && Math.abs(timestampUs - reference) > DISCONTINUITY_US) {
      this.dropAll('discontinuity');
      this.lastTakenTs = -Infinity;
    }

    // Never go back past what has been shown
    if (timestampUs <= this.lastTakenTs) {
      this.dropped++;
      this.onDrop?.(frame, 'late', packetIndex, packetSeq);
      return;
    }

    if (this.count === this.capacity) {
      this.dropHead('overflow');
    }

    // Decoders output in presentation order, so this is nearly always an append
    let at = this.count;
    while (at > 0 && this.slot(at - 1).timestamp > timestampUs) at--;
    for (let i = this.count; i > at; i--) {
      const to = this.slot(i);
      const from = this.slot(i - 1);
      to.frame = from.frame;
      to.timestamp = from.timestamp;
      to.arrivalTime = from.arrivalTime;
      to.decodeTime = from.decodeTime;
      to.packetIndex = from.packetIndex;
      to.packetSeq = from.packetSeq;
    }
    const s = this.slot(at);
    s.frame = frame;
    s.timestamp = timestampUs;
    s.arrivalTime = arrivalTime;
    s.decodeTime = decodeTime;
    s.packetIndex = packetIndex;
    s.packetSeq = packetSeq;
    this.count++;

    if (dueUs !== null) {
      while (this.count >= 2 && this.slot(1).timestamp <= dueUs) {
        this.dropHead('late');
      }
    }
  }

  /**
   * The newest frame due at `dueUs`, or null if none is due yet. Older frames are dropped.
   * Its timing is in takenArrivalTime/takenDecodeTime/takenTimestamp.
   */
  take(dueUs: number): T | null {
    let idx = -1;
    for (let i = 0; i < this.count; i++) {
      if (this.slot(i).timestamp <= dueUs) idx = i;
      else break;
    }
    if (idx < 0) return null;
    for (let i = 0; i < idx; i++) this.dropHead('skip');
    return this.shiftHead();
  }

  /** The newest frame, dropping everything older (no buffering). */
  takeNewest(): T | null {
    if (this.count === 0) return null;
    while (this.count > 1) this.dropHead('skip');
    return this.shiftHead();
  }

  /** Drop every queued frame. The next frame may have any timestamp. */
  clear(): void {
    this.dropAll('clear');
    this.lastTakenTs = -Infinity;
  }

  private slot(i: number): Slot<T> {
    return this.ring[(this.head + i) % this.capacity];
  }

  private shiftHead(): T {
    const s = this.ring[this.head];
    const frame = s.frame as T;
    this.takenArrivalTime = s.arrivalTime;
    this.takenDecodeTime = s.decodeTime;
    this.takenTimestamp = s.timestamp;
    this.lastTakenTs = s.timestamp;
    s.frame = null;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return frame;
  }

  private dropHead(reason: FrameDropReason): void {
    const s = this.ring[this.head];
    const frame = s.frame as T;
    const packetIndex = s.packetIndex;
    const packetSeq = s.packetSeq;
    s.frame = null;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    this.dropped++;
    this.onDrop?.(frame, reason, packetIndex, packetSeq);
  }

  private dropAll(reason: FrameDropReason): void {
    while (this.count > 0) this.dropHead(reason);
  }
}
