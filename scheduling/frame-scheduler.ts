/**
 * Frame Scheduler
 *
 * Manages frame buffering and synchronization between stream framerate
 * and display refresh rate.
 */

/**
 * Frame timing information for latency tracking
 */
export interface FrameTiming {
  /** When encoded data arrived (performance.now()) */
  arrivalTime: number;
  /** When decode completed (performance.now()) */
  decodeTime: number;
  /** When frame was displayed (performance.now()) */
  displayTime?: number;
}

/**
 * Latency statistics
 */
export interface LatencyStats {
  /** Time from arrival to decode completion (ms) */
  decodeLatency: number;
  /** Time from decode to display (ms) */
  bufferLatency: number;
  /** Total time from arrival to display (ms) */
  totalLatency: number;
  /** Average latencies over recent frames */
  avgDecodeLatency: number;
  avgBufferLatency: number;
  avgTotalLatency: number;
}

export interface SchedulerStatus {
  currentBufferSize: number;
  currentBufferMs: number;
  avgBufferMs: number;
  targetBufferMs: number;
  streamFrameDurationUs: number | null;
  droppedFrames: number;
  totalEnqueuedFrames: number;
  totalDequeuedFrames: number;
  driftCorrections: number;
  latency: LatencyStats | null;
}

/**
 * Packet timing entry for visualization
 */
export interface PacketTimingEntry {
  /** Time packet arrived (performance.now()) */
  arrivalTime: number;
  /** Time since previous packet (ms) */
  intervalMs: number;
  /** Stream timestamp (us) */
  streamTimestampUs: number;
  /** Whether this was a keyframe */
  isKeyframe: boolean;
  /** Decode latency (ms) */
  decodeLatencyMs: number;
  /** Whether frame was dropped */
  wasDropped: boolean;
}

/**
 * A buffered frame. Slots are preallocated and reused, so the fields are
 * written in place rather than replaced with a fresh object per frame.
 */
interface QueuedFrame<T> {
  frame: T | null;
  timestamp: number; // stream timestamp in microseconds
  arrivalTime: number;
  decodeTime: number;
  isKeyframe: boolean;
  /** Slot index in the packet timing ring, for O(1) drop marking */
  packetIndex: number;
  /** Sequence of the packet timing entry, guards against ring reuse */
  packetSeq: number;
}

export interface SchedulerConfig<T> {
  /** Target buffer delay in milliseconds (0 = bypass mode, always return latest) */
  bufferDelayMs?: number;
  /** Maximum buffer size in frames before overflow */
  maxBufferSize?: number;
  /** How often to check drift (every N dequeues) */
  driftCheckInterval?: number;
  /** Drift threshold in milliseconds before correction */
  driftCorrectionThresholdMs?: number;
  /** Logger function */
  logger?: (message: string) => void;
  /** Callback when frame is dropped */
  onFrameDropped?: (frame: T, reason: 'overflow' | 'skip') => void;
}

const PACKET_HISTORY_SIZE = 300;   // ~5 seconds at 60fps
const LATENCY_HISTORY_SIZE = 60;   // ~1 second at 60fps
const BUFFER_HISTORY_SIZE = 100;

/**
 * FrameScheduler - Simplified implementation
 *
 * Core algorithm:
 * 1. On first dequeue with frames, record (realTime, streamTime) as start point
 * 2. On each dequeue:
 *    - Calculate expected stream time = startStreamTime + (currentRealTime - startRealTime) - bufferDelay
 *    - Find frame with timestamp <= expectedStreamTime
 *    - Drop old frames, return best match
 * 3. Periodically adjust start point to correct drift
 *
 * All per-frame state lives in preallocated ring buffers so the steady-state
 * enqueue/dequeue path allocates nothing.
 */
export class FrameScheduler<T> {
  // Frame ring buffer
  private ring: QueuedFrame<T>[];
  private capacity: number;
  private head: number = 0;
  private size: number = 0;

  private bufferDelayMs: number;
  private maxBufferSize: number;

  // Timing synchronization
  private startRealTimeUs: number | null = null;
  private startStreamTimeUs: number | null = null;
  private frameDurationUs: number = 20000; // Default 50fps
  private lastFrameTimestamp: number | null = null;

  // Drift correction
  private bufferSizes = new Int32Array(BUFFER_HISTORY_SIZE);
  private bufferSizeWrite: number = 0;
  private bufferSizeCount: number = 0;
  private bufferSizeSum: number = 0;
  private driftCheckInterval: number;
  private driftThresholdMs: number;
  private dequeueCount: number = 0;

  // Latency tracking (parallel rings + running sums)
  private latencyDecode = new Float64Array(LATENCY_HISTORY_SIZE);
  private latencyBuffer = new Float64Array(LATENCY_HISTORY_SIZE);
  private latencyTotal = new Float64Array(LATENCY_HISTORY_SIZE);
  private latencyWrite: number = 0;
  private latencyCount: number = 0;
  private latencyDecodeSum: number = 0;
  private latencyBufferSum: number = 0;
  private latencyTotalSum: number = 0;

  // Packet timing history for visualization
  private packetRing: PacketTimingEntry[];
  private packetSeqs = new Float64Array(PACKET_HISTORY_SIZE);
  private packetWrite: number = 0;
  private packetCount: number = 0;
  private packetSeq: number = 0;
  private lastPacketArrivalTime: number | null = null;

  // Statistics
  private stats = {
    dropped: 0,
    enqueued: 0,
    dequeued: 0,
    driftCorrections: 0,
  };

  private logger: (msg: string) => void;
  private onFrameDropped?: (frame: T, reason: 'overflow' | 'skip') => void;

  constructor(config: SchedulerConfig<T> = {}) {
    this.bufferDelayMs = config.bufferDelayMs ?? 100; // Default 100ms buffer
    // Auto-calculate maxBufferSize: at least 2x the buffer delay worth of frames at 60fps, min 30 frames
    const minFramesForBuffer = Math.ceil((this.bufferDelayMs / 1000) * 60 * 2);
    this.maxBufferSize = config.maxBufferSize ?? Math.max(30, minFramesForBuffer);
    this.driftCheckInterval = config.driftCheckInterval ?? 150;
    this.driftThresholdMs = config.driftCorrectionThresholdMs ?? 30; // Default 30ms threshold
    this.logger = config.logger ?? (() => {});
    this.onFrameDropped = config.onFrameDropped;

    this.capacity = Math.max(1, this.maxBufferSize);
    this.ring = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.ring[i] = {
        frame: null,
        timestamp: 0,
        arrivalTime: 0,
        decodeTime: 0,
        isKeyframe: false,
        packetIndex: -1,
        packetSeq: -1,
      };
    }

    this.packetRing = new Array(PACKET_HISTORY_SIZE);
    for (let i = 0; i < PACKET_HISTORY_SIZE; i++) {
      this.packetRing[i] = {
        arrivalTime: 0,
        intervalMs: 0,
        streamTimestampUs: 0,
        isKeyframe: false,
        decodeLatencyMs: 0,
        wasDropped: false,
      };
    }
  }

  /** Buffer delay in microseconds */
  private get bufferDelayUs(): number {
    return this.bufferDelayMs * 1000;
  }

  /** Effective drift threshold - scales with buffer target for low-latency mode */
  private get effectiveDriftThresholdMs(): number {
    // For very low targets, use half the target as threshold
    // For normal targets, use configured threshold
    return Math.min(this.driftThresholdMs, this.bufferDelayMs * 0.5);
  }

  /** Slot at logical position i (0 = oldest) */
  private slotAt(i: number): QueuedFrame<T> {
    return this.ring[(this.head + i) % this.capacity];
  }

  /** Enqueue a decoded frame with timing information */
  enqueue(frame: T, timestampUs: number, timing: FrameTiming, isKeyframe: boolean = false): void {
    this.enqueueFrame(frame, timestampUs, timing.arrivalTime, timing.decodeTime, isKeyframe);
  }

  /**
   * Enqueue a decoded frame with timing passed as primitives.
   * Allocation-free variant of {@link enqueue} for the live decode path.
   */
  enqueueFrame(
    frame: T,
    timestampUs: number,
    arrivalTime: number,
    decodeTime: number,
    isKeyframe: boolean = false
  ): void {
    this.stats.enqueued++;

    // Record packet timing for visualization
    const intervalMs = this.lastPacketArrivalTime !== null
      ? arrivalTime - this.lastPacketArrivalTime
      : 0;
    this.lastPacketArrivalTime = arrivalTime;

    const decodeLatencyMs = decodeTime - arrivalTime;

    const packetIndex = this.packetWrite;
    const packetSeq = this.packetSeq++;
    const entry = this.packetRing[packetIndex];
    entry.arrivalTime = arrivalTime;
    entry.intervalMs = intervalMs;
    entry.streamTimestampUs = timestampUs;
    entry.isKeyframe = isKeyframe;
    entry.decodeLatencyMs = decodeLatencyMs;
    entry.wasDropped = false;
    this.packetSeqs[packetIndex] = packetSeq;
    this.packetWrite = (packetIndex + 1) % PACKET_HISTORY_SIZE;
    if (this.packetCount < PACKET_HISTORY_SIZE) {
      this.packetCount++;
    }

    // Update frame duration estimate
    if (this.lastFrameTimestamp !== null) {
      const delta = timestampUs - this.lastFrameTimestamp;
      if (delta > 0 && delta < 100_000) { // Sanity check: 10fps-1000fps
        this.frameDurationUs = delta;
      }
    }
    this.lastFrameTimestamp = timestampUs;

    // Handle overflow - reset sync point since we're losing frames
    while (this.size >= this.maxBufferSize) {
      const dropped = this.shiftSlot();
      if (dropped) {
        this.stats.dropped++;
        this.onFrameDropped?.(dropped, 'overflow');
        // Reset sync point so we resync with new frames
        this.startRealTimeUs = null;
        this.startStreamTimeUs = null;
      }
    }

    const slot = this.ring[(this.head + this.size) % this.capacity];
    slot.frame = frame;
    slot.timestamp = timestampUs;
    slot.arrivalTime = arrivalTime;
    slot.decodeTime = decodeTime;
    slot.isKeyframe = isKeyframe;
    slot.packetIndex = packetIndex;
    slot.packetSeq = packetSeq;
    this.size++;
  }

  /** Remove the oldest slot and return its frame, releasing the slot's reference */
  private shiftSlot(): T | null {
    if (this.size === 0) {
      return null;
    }
    const slot = this.ring[this.head];
    const frame = slot.frame;
    slot.frame = null;
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    return frame;
  }

  /** Dequeue frame for rendering at given real time (milliseconds) */
  dequeue(realTimeMs: number): T | null {
    const realTimeUs = realTimeMs * 1000;
    const displayTime = performance.now();

    // Nothing to return
    if (this.size === 0) {
      return null;
    }

    // Bypass mode: always return latest frame
    if (this.bufferDelayMs === 0) {
      this.trackBufferSize();
      return this.dequeueLatest(displayTime);
    }

    // Wait for buffer to fill before starting playback
    // For low buffer targets, require at least 1 frame; for higher targets, wait for half
    const currentBufferMs = this.size * this.frameDurationUs / 1000;
    const minBufferMs = Math.min(this.bufferDelayMs * 0.5, this.frameDurationUs / 1000);
    if (currentBufferMs < minBufferMs) {
      return null;
    }

    // Initialize sync point on first frame
    if (this.startRealTimeUs === null) {
      // Set sync point so that after bufferDelay passes, we'll be looking for the first frame
      // This means: startStream + bufferDelay - bufferDelay = startStream (when elapsed = bufferDelay)
      this.startRealTimeUs = realTimeUs;
      this.startStreamTimeUs = this.slotAt(0).timestamp + this.bufferDelayUs; // Offset by buffer delay
      this.logger(`Playback started: buffer=${Math.round(currentBufferMs)}ms, delay=${this.bufferDelayMs}ms`);
    }

    // Track buffer size for drift detection
    this.trackBufferSize();

    // Calculate expected stream time
    const elapsedUs = realTimeUs - this.startRealTimeUs;
    const expectedStreamTimeUs = this.startStreamTimeUs! + elapsedUs - this.bufferDelayUs;

    // Find best matching frame (last one not in the future)
    let bestIdx = this.findBestFrameIndex(expectedStreamTimeUs);

    // No frame ready yet - shouldn't happen if buffer is full, but handle gracefully
    if (bestIdx === -1) {
      return null;
    }

    // Drop frames that are too far behind (tolerance of 1 frame)
    if (bestIdx > 1) {
      this.dropFrames(bestIdx - 1, 'skip');
      bestIdx = 0;
    }

    // Periodically correct drift
    this.dequeueCount++;
    if (this.dequeueCount % this.driftCheckInterval === 0) {
      this.correctDrift();
    }

    // Return the frame and record latency
    const head = this.ring[this.head];
    const arrivalTime = head.arrivalTime;
    const decodeTime = head.decodeTime;
    const frame = this.shiftSlot();
    this.stats.dequeued++;
    this.recordLatency(arrivalTime, decodeTime, displayTime);
    return frame;
  }

  /** Bypass mode: return latest frame, drop rest */
  private dequeueLatest(displayTime: number): T {
    // Detach the newest slot from the tail, then drop everything older
    const tail = this.ring[(this.head + this.size - 1) % this.capacity];
    const frame = tail.frame as T;
    const arrivalTime = tail.arrivalTime;
    const decodeTime = tail.decodeTime;
    tail.frame = null;
    this.size--;

    this.stats.dequeued++;
    this.recordLatency(arrivalTime, decodeTime, displayTime);
    this.dropFrames(this.size, 'skip');

    return frame;
  }

  /** Record latency for a frame */
  private recordLatency(arrivalTime: number, decodeTime: number, displayTime: number): void {
    const decodeLatency = decodeTime - arrivalTime;
    const bufferLatency = displayTime - decodeTime;
    const totalLatency = displayTime - arrivalTime;

    const i = this.latencyWrite;
    if (this.latencyCount === LATENCY_HISTORY_SIZE) {
      this.latencyDecodeSum -= this.latencyDecode[i];
      this.latencyBufferSum -= this.latencyBuffer[i];
      this.latencyTotalSum -= this.latencyTotal[i];
    } else {
      this.latencyCount++;
    }

    this.latencyDecode[i] = decodeLatency;
    this.latencyBuffer[i] = bufferLatency;
    this.latencyTotal[i] = totalLatency;
    this.latencyDecodeSum += decodeLatency;
    this.latencyBufferSum += bufferLatency;
    this.latencyTotalSum += totalLatency;
    this.latencyWrite = (i + 1) % LATENCY_HISTORY_SIZE;
  }

  /** Get current latency stats */
  getLatencyStats(): LatencyStats | null {
    if (this.latencyCount === 0) {
      return null;
    }

    const lastIdx = (this.latencyWrite - 1 + LATENCY_HISTORY_SIZE) % LATENCY_HISTORY_SIZE;
    const n = this.latencyCount;

    return {
      decodeLatency: Math.round(this.latencyDecode[lastIdx] * 10) / 10,
      bufferLatency: Math.round(this.latencyBuffer[lastIdx] * 10) / 10,
      totalLatency: Math.round(this.latencyTotal[lastIdx] * 10) / 10,
      avgDecodeLatency: Math.round((this.latencyDecodeSum / n) * 10) / 10,
      avgBufferLatency: Math.round((this.latencyBufferSum / n) * 10) / 10,
      avgTotalLatency: Math.round((this.latencyTotalSum / n) * 10) / 10,
    };
  }

  /** Find index of last frame with timestamp <= target */
  private findBestFrameIndex(targetUs: number): number {
    let bestIdx = -1;
    for (let i = 0; i < this.size; i++) {
      if (this.slotAt(i).timestamp <= targetUs) {
        bestIdx = i;
      } else {
        break; // Buffer is sorted
      }
    }
    return bestIdx;
  }

  /** Drop N frames from front of buffer */
  private dropFrames(count: number, reason: 'overflow' | 'skip'): void {
    for (let i = 0; i < count && this.size > 0; i++) {
      const slot = this.ring[this.head];
      const packetIndex = slot.packetIndex;
      const packetSeq = slot.packetSeq;
      const dropped = this.shiftSlot()!;
      this.stats.dropped++;
      this.onFrameDropped?.(dropped, reason);

      // Mark corresponding packet timing entry as dropped
      if (packetIndex >= 0 && this.packetSeqs[packetIndex] === packetSeq) {
        this.packetRing[packetIndex].wasDropped = true;
      }
    }
  }

  /** Track buffer size for drift detection */
  private trackBufferSize(): void {
    const i = this.bufferSizeWrite;
    if (this.bufferSizeCount === BUFFER_HISTORY_SIZE) {
      this.bufferSizeSum -= this.bufferSizes[i];
    } else {
      this.bufferSizeCount++;
    }
    this.bufferSizes[i] = this.size;
    this.bufferSizeSum += this.size;
    this.bufferSizeWrite = (i + 1) % BUFFER_HISTORY_SIZE;
  }

  /** Reset the drift detection window */
  private resetBufferSizeHistory(): void {
    this.bufferSizeWrite = 0;
    this.bufferSizeCount = 0;
    this.bufferSizeSum = 0;
  }

  /** Correct timing drift by adjusting start point */
  private correctDrift(): void {
    if (this.bufferSizeCount < 10 || !this.startStreamTimeUs) {
      return;
    }

    // Calculate average buffer in ms
    const avgFrames = this.bufferSizeSum / this.bufferSizeCount;
    const avgBufferMs = avgFrames * this.frameDurationUs / 1000;
    const driftMs = avgBufferMs - this.bufferDelayMs;

    const threshold = this.effectiveDriftThresholdMs;

    if (Math.abs(driftMs) > threshold) {
      // Adjust stream time: positive drift means buffer growing, need to consume faster
      const correctionUs = driftMs * 1000;
      this.startStreamTimeUs += correctionUs;
      this.stats.driftCorrections++;
      this.resetBufferSizeHistory();
      this.logger(`Drift correction: ${driftMs.toFixed(1)}ms`);
    }
  }

  /** Clear buffer */
  clear(): void {
    while (this.size > 0) {
      const frame = this.shiftSlot();
      if (frame !== null) {
        this.onFrameDropped?.(frame, 'overflow');
      }
    }
    this.head = 0;
    this.size = 0;
    this.startRealTimeUs = null;
    this.startStreamTimeUs = null;
    this.resetBufferSizeHistory();
  }

  /** Set buffer delay in milliseconds */
  setBufferDelay(delayMs: number): void {
    const wasNonZero = this.bufferDelayMs > 0;
    this.bufferDelayMs = delayMs;

    // Clear history when switching to/from bypass mode
    if ((wasNonZero && delayMs === 0) || (!wasNonZero && delayMs > 0)) {
      this.resetBufferSizeHistory();
      this.startRealTimeUs = null;
      this.startStreamTimeUs = null;
    }
  }

  /** Get current buffer delay in milliseconds */
  getBufferDelay(): number {
    return this.bufferDelayMs;
  }

  /** Get status */
  getStatus(): SchedulerStatus {
    const currentBufferMs = this.size * this.frameDurationUs / 1000;

    // Calculate average buffer from drift history
    let avgBufferMs = currentBufferMs;
    if (this.bufferSizeCount > 0) {
      const avgFrames = this.bufferSizeSum / this.bufferSizeCount;
      avgBufferMs = avgFrames * this.frameDurationUs / 1000;
    }

    return {
      currentBufferSize: this.size,
      currentBufferMs: Math.round(currentBufferMs),
      avgBufferMs: Math.round(avgBufferMs),
      targetBufferMs: this.bufferDelayMs,
      streamFrameDurationUs: this.frameDurationUs,
      droppedFrames: this.stats.dropped,
      totalEnqueuedFrames: this.stats.enqueued,
      totalDequeuedFrames: this.stats.dequeued,
      driftCorrections: this.stats.driftCorrections,
      latency: this.getLatencyStats(),
    };
  }

  /** Log status */
  logStatus(): void {
    const s = this.getStatus();
    const fps = (1_000_000 / this.frameDurationUs).toFixed(1);
    this.logger(`buffer=${s.currentBufferMs}ms/${s.targetBufferMs}ms (${s.currentBufferSize} frames), dropped=${s.droppedFrames}, fps=${fps}`);
  }

  /** Reset statistics */
  resetStats(): void {
    this.stats = { dropped: 0, enqueued: 0, dequeued: 0, driftCorrections: 0 };
    this.resetBufferSizeHistory();
  }

  /**
   * Get packet timing history for visualization, oldest first.
   * Entries are copies - the internal ring reuses its entry objects.
   */
  getPacketTimingHistory(): PacketTimingEntry[] {
    const out: PacketTimingEntry[] = new Array(this.packetCount);
    const start = (this.packetWrite - this.packetCount + PACKET_HISTORY_SIZE) % PACKET_HISTORY_SIZE;
    for (let i = 0; i < this.packetCount; i++) {
      const e = this.packetRing[(start + i) % PACKET_HISTORY_SIZE];
      out[i] = {
        arrivalTime: e.arrivalTime,
        intervalMs: e.intervalMs,
        streamTimestampUs: e.streamTimestampUs,
        isKeyframe: e.isKeyframe,
        decodeLatencyMs: e.decodeLatencyMs,
        wasDropped: e.wasDropped,
      };
    }
    return out;
  }
}
