/**
 * Playback Stats
 *
 * Latency of shown frames and a history of packet timing, for statistics and jitter
 * visualization. Fixed rings with running sums, so recording allocates nothing.
 */

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
  /** How much later than the earliest-arriving packets this one arrived (ms); NaN if not known */
  latenessMs: number;
  /** Whether frame was dropped */
  wasDropped: boolean;
}

const PACKET_HISTORY_SIZE = 600;   // 10 seconds at 60fps
const LATENCY_HISTORY_SIZE = 60;   // ~1 second at 60fps

export class PlaybackStats {
  // Latency (parallel rings + running sums)
  private latencyDecode = new Float64Array(LATENCY_HISTORY_SIZE);
  private latencyBuffer = new Float64Array(LATENCY_HISTORY_SIZE);
  private latencyTotal = new Float64Array(LATENCY_HISTORY_SIZE);
  private latencyWrite = 0;
  private latencyCount = 0;
  private latencyDecodeSum = 0;
  private latencyBufferSum = 0;
  private latencyTotalSum = 0;

  // Packet timing history
  private packetRing: PacketTimingEntry[];
  private packetSeqs = new Float64Array(PACKET_HISTORY_SIZE);
  private packetWrite = 0;
  private packetCount = 0;
  private packetSeq = 0;
  private lastPacketArrivalTime: number | null = null;

  /** Ring index of the packet last recorded, for markDropped() */
  lastPacketIndex = -1;
  /** Sequence of the packet last recorded; guards against the slot being reused */
  lastPacketSeq = -1;

  constructor() {
    this.packetRing = new Array(PACKET_HISTORY_SIZE);
    for (let i = 0; i < PACKET_HISTORY_SIZE; i++) {
      this.packetRing[i] = {
        arrivalTime: 0,
        intervalMs: 0,
        streamTimestampUs: 0,
        isKeyframe: false,
        decodeLatencyMs: 0,
        latenessMs: NaN,
        wasDropped: false,
      };
    }
  }

  /** Record a decoded frame's packet. Its slot is in lastPacketIndex/lastPacketSeq. */
  recordPacket(arrivalTime: number, timestampUs: number, isKeyframe: boolean, decodeTime: number, latenessMs = NaN): void {
    const intervalMs = this.lastPacketArrivalTime !== null ? arrivalTime - this.lastPacketArrivalTime : 0;
    this.lastPacketArrivalTime = arrivalTime;

    const index = this.packetWrite;
    const seq = this.packetSeq++;
    const entry = this.packetRing[index];
    entry.arrivalTime = arrivalTime;
    entry.intervalMs = intervalMs;
    entry.streamTimestampUs = timestampUs;
    entry.isKeyframe = isKeyframe;
    entry.decodeLatencyMs = decodeTime - arrivalTime;
    entry.latenessMs = latenessMs;
    entry.wasDropped = false;
    this.packetSeqs[index] = seq;
    this.packetWrite = (index + 1) % PACKET_HISTORY_SIZE;
    if (this.packetCount < PACKET_HISTORY_SIZE) this.packetCount++;
    this.lastPacketIndex = index;
    this.lastPacketSeq = seq;
  }

  /** Mark a recorded packet's frame as dropped, if its entry is still in the history */
  markDropped(index: number, seq: number): void {
    if (index >= 0 && this.packetSeqs[index] === seq) {
      this.packetRing[index].wasDropped = true;
    }
  }

  /** Record the latency of a shown frame */
  recordLatency(arrivalTime: number, decodeTime: number, displayTime: number): void {
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

  getLatencyStats(): LatencyStats | null {
    if (this.latencyCount === 0) return null;
    const last = (this.latencyWrite - 1 + LATENCY_HISTORY_SIZE) % LATENCY_HISTORY_SIZE;
    const n = this.latencyCount;
    const round = (v: number) => Math.round(v * 10) / 10;
    return {
      decodeLatency: round(this.latencyDecode[last]),
      bufferLatency: round(this.latencyBuffer[last]),
      totalLatency: round(this.latencyTotal[last]),
      avgDecodeLatency: round(this.latencyDecodeSum / n),
      avgBufferLatency: round(this.latencyBufferSum / n),
      avgTotalLatency: round(this.latencyTotalSum / n),
    };
  }

  /**
   * Packet timing history, oldest first. Entries are copies - the ring reuses its entries.
   */
  getPacketTimingHistory(): PacketTimingEntry[] {
    const out: PacketTimingEntry[] = new Array(this.packetCount);
    const start = (this.packetWrite - this.packetCount + PACKET_HISTORY_SIZE) % PACKET_HISTORY_SIZE;
    for (let i = 0; i < this.packetCount; i++) {
      const e = this.packetRing[(start + i) % PACKET_HISTORY_SIZE];
      out[i] = { ...e };
    }
    return out;
  }

  reset(): void {
    this.latencyWrite = 0;
    this.latencyCount = 0;
    this.latencyDecodeSum = 0;
    this.latencyBufferSum = 0;
    this.latencyTotalSum = 0;
    this.packetWrite = 0;
    this.packetCount = 0;
    this.lastPacketArrivalTime = null;
  }
}
