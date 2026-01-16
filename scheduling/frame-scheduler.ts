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

interface QueuedFrame<T> {
  frame: T;
  timestamp: number; // stream timestamp in microseconds
  timing: FrameTiming;
  isKeyframe?: boolean;
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
 */
export class FrameScheduler<T> {
  private buffer: QueuedFrame<T>[] = [];
  private bufferDelayMs: number;
  private maxBufferSize: number;
  
  // Timing synchronization
  private startRealTimeUs: number | null = null;
  private startStreamTimeUs: number | null = null;
  private frameDurationUs: number = 20000; // Default 50fps
  private lastFrameTimestamp: number | null = null;
  
  // Drift correction
  private bufferSizeHistory: number[] = [];
  private driftCheckInterval: number;
  private driftThresholdMs: number;
  private dequeueCount: number = 0;
  
  // Latency tracking
  private latencyHistory: { decode: number; buffer: number; total: number }[] = [];
  private latencyHistorySize: number = 60; // About 1 second at 60fps
  
  // Packet timing history for visualization
  private packetTimingHistory: PacketTimingEntry[] = [];
  private packetTimingHistorySize: number = 300; // ~5 seconds at 60fps
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
  
  /** Enqueue a decoded frame with timing information */
  enqueue(frame: T, timestampUs: number, timing: FrameTiming, isKeyframe: boolean = false): void {
    this.stats.enqueued++;
    
    // Record packet timing for visualization
    const intervalMs = this.lastPacketArrivalTime !== null
      ? timing.arrivalTime - this.lastPacketArrivalTime
      : 0;
    this.lastPacketArrivalTime = timing.arrivalTime;
    
    const decodeLatencyMs = timing.decodeTime - timing.arrivalTime;
    
    this.packetTimingHistory.push({
      arrivalTime: timing.arrivalTime,
      intervalMs,
      streamTimestampUs: timestampUs,
      isKeyframe,
      decodeLatencyMs,
      wasDropped: false,
    });
    
    // Trim history
    while (this.packetTimingHistory.length > this.packetTimingHistorySize) {
      this.packetTimingHistory.shift();
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
    while (this.buffer.length >= this.maxBufferSize) {
      const dropped = this.buffer.shift();
      if (dropped) {
        this.stats.dropped++;
        this.onFrameDropped?.(dropped.frame, 'overflow');
        // Reset sync point so we resync with new frames
        this.startRealTimeUs = null;
        this.startStreamTimeUs = null;
      }
    }
    
    this.buffer.push({ frame, timestamp: timestampUs, timing });
  }
  
  /** Dequeue frame for rendering at given real time (milliseconds) */
  dequeue(realTimeMs: number): T | null {
    const realTimeUs = realTimeMs * 1000;
    const displayTime = performance.now();
    
    // Nothing to return
    if (this.buffer.length === 0) {
      return null;
    }
    
    // Bypass mode: always return latest frame
    if (this.bufferDelayMs === 0) {
      this.trackBufferSize();
      return this.dequeueLatest(displayTime);
    }
    
    // Wait for buffer to fill before starting playback
    // For low buffer targets, require at least 1 frame; for higher targets, wait for half
    const currentBufferMs = this.buffer.length * this.frameDurationUs / 1000;
    const minBufferMs = Math.min(this.bufferDelayMs * 0.5, this.frameDurationUs / 1000);
    if (currentBufferMs < minBufferMs) {
      return null;
    }
    
    // Initialize sync point on first frame
    if (this.startRealTimeUs === null) {
      // Set sync point so that after bufferDelay passes, we'll be looking for the first frame
      // This means: startStream + bufferDelay - bufferDelay = startStream (when elapsed = bufferDelay)
      this.startRealTimeUs = realTimeUs;
      this.startStreamTimeUs = this.buffer[0].timestamp + this.bufferDelayUs; // Offset by buffer delay
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
    const entry = this.buffer.shift()!;
    this.stats.dequeued++;
    this.recordLatency(entry.timing, displayTime);
    return entry.frame;
  }
  
  /** Bypass mode: return latest frame, drop rest */
  private dequeueLatest(displayTime: number): T {
    const latest = this.buffer.pop()!;
    this.stats.dequeued++;
    this.recordLatency(latest.timing, displayTime);
    this.dropFrames(this.buffer.length, 'skip');
    
    return latest.frame;
  }
  
  /** Record latency for a frame */
  private recordLatency(timing: FrameTiming, displayTime: number): void {
    const decodeLatency = timing.decodeTime - timing.arrivalTime;
    const bufferLatency = displayTime - timing.decodeTime;
    const totalLatency = displayTime - timing.arrivalTime;
    
    this.latencyHistory.push({ decode: decodeLatency, buffer: bufferLatency, total: totalLatency });
    if (this.latencyHistory.length > this.latencyHistorySize) {
      this.latencyHistory.shift();
    }
  }
  
  /** Get current latency stats */
  getLatencyStats(): LatencyStats | null {
    if (this.latencyHistory.length === 0) {
      return null;
    }
    
    const last = this.latencyHistory[this.latencyHistory.length - 1];
    
    const avgDecode = this.latencyHistory.reduce((a, b) => a + b.decode, 0) / this.latencyHistory.length;
    const avgBuffer = this.latencyHistory.reduce((a, b) => a + b.buffer, 0) / this.latencyHistory.length;
    const avgTotal = this.latencyHistory.reduce((a, b) => a + b.total, 0) / this.latencyHistory.length;
    
    return {
      decodeLatency: Math.round(last.decode * 10) / 10,
      bufferLatency: Math.round(last.buffer * 10) / 10,
      totalLatency: Math.round(last.total * 10) / 10,
      avgDecodeLatency: Math.round(avgDecode * 10) / 10,
      avgBufferLatency: Math.round(avgBuffer * 10) / 10,
      avgTotalLatency: Math.round(avgTotal * 10) / 10,
    };
  }
  
  /** Find index of last frame with timestamp <= target */
  private findBestFrameIndex(targetUs: number): number {
    let bestIdx = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].timestamp <= targetUs) {
        bestIdx = i;
      } else {
        break; // Buffer is sorted
      }
    }
    return bestIdx;
  }
  
  /** Drop N frames from front of buffer */
  private dropFrames(count: number, reason: 'overflow' | 'skip'): void {
    for (let i = 0; i < count && this.buffer.length > 0; i++) {
      const dropped = this.buffer.shift()!;
      this.stats.dropped++;
      this.onFrameDropped?.(dropped.frame, reason);
      
      // Mark corresponding packet timing entry as dropped
      const timingEntry = this.packetTimingHistory.find(
        e => e.streamTimestampUs === dropped.timestamp
      );
      if (timingEntry) {
        timingEntry.wasDropped = true;
      }
    }
  }
  
  /** Track buffer size for drift detection */
  private trackBufferSize(): void {
    this.bufferSizeHistory.push(this.buffer.length);
    if (this.bufferSizeHistory.length > 100) {
      this.bufferSizeHistory.shift();
    }
  }
  
  /** Correct timing drift by adjusting start point */
  private correctDrift(): void {
    if (this.bufferSizeHistory.length < 10 || !this.startStreamTimeUs) {
      return;
    }
    
    // Calculate average buffer in ms
    const avgFrames = this.bufferSizeHistory.reduce((a, b) => a + b, 0) / this.bufferSizeHistory.length;
    const avgBufferMs = avgFrames * this.frameDurationUs / 1000;
    const driftMs = avgBufferMs - this.bufferDelayMs;
    
    const threshold = this.effectiveDriftThresholdMs;
    
    if (Math.abs(driftMs) > threshold) {
      // Adjust stream time: positive drift means buffer growing, need to consume faster
      const correctionUs = driftMs * 1000;
      this.startStreamTimeUs += correctionUs;
      this.stats.driftCorrections++;
      this.bufferSizeHistory = [];
      this.logger(`Drift correction: ${driftMs.toFixed(1)}ms`);
    }
  }
  
  /** Clear buffer */
  clear(): void {
    for (const entry of this.buffer) {
      this.onFrameDropped?.(entry.frame, 'overflow');
    }
    this.buffer = [];
    this.startRealTimeUs = null;
    this.startStreamTimeUs = null;
    this.bufferSizeHistory = [];
  }
  
  /** Set buffer delay in milliseconds */
  setBufferDelay(delayMs: number): void {
    const wasNonZero = this.bufferDelayMs > 0;
    this.bufferDelayMs = delayMs;
    
    // Clear history when switching to/from bypass mode
    if ((wasNonZero && delayMs === 0) || (!wasNonZero && delayMs > 0)) {
      this.bufferSizeHistory = [];
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
    const currentBufferMs = this.buffer.length * this.frameDurationUs / 1000;
    
    // Calculate average buffer from drift history
    let avgBufferMs = currentBufferMs;
    if (this.bufferSizeHistory.length > 0) {
      const avgFrames = this.bufferSizeHistory.reduce((a, b) => a + b, 0) / this.bufferSizeHistory.length;
      avgBufferMs = avgFrames * this.frameDurationUs / 1000;
    }
    
    return {
      currentBufferSize: this.buffer.length,
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
    this.bufferSizeHistory = [];
  }
  
  /** Get packet timing history for visualization */
  getPacketTimingHistory(): PacketTimingEntry[] {
    return [...this.packetTimingHistory];
  }
}
