import { describe, it, expect, beforeEach } from 'vitest';
import { VideoFrameQueue, FrameDropReason } from './video-frame-queue';
import { PlaybackStats } from './playback-stats';

interface MockFrame { id: number }

describe('VideoFrameQueue', () => {
  let drops: { id: number; reason: FrameDropReason }[];
  let queue: VideoFrameQueue<MockFrame>;
  const push = (id: number, ts: number, due: number | null = null) => queue.push({ id }, ts, 0, 0, due);

  beforeEach(() => {
    drops = [];
    queue = new VideoFrameQueue<MockFrame>({ capacity: 8, onDrop: (frame, reason) => drops.push({ id: frame.id, reason }) });
  });

  it('returns nothing until a frame is due', () => {
    push(1, 100_000);
    expect(queue.take(99_999)).toBeNull();
    expect(queue.take(100_000)?.id).toBe(1);
  });

  it('returns the newest due frame and skips the older ones', () => {
    for (let i = 0; i < 5; i++) push(i, i * 20_000);
    expect(queue.take(65_000)?.id).toBe(3);
    expect(drops).toEqual([{ id: 0, reason: 'skip' }, { id: 1, reason: 'skip' }, { id: 2, reason: 'skip' }]);
    expect(queue.size).toBe(1);
    expect(queue.takenTimestamp).toBe(60_000);
  });

  it('keeps only the newest of the frames already due when they are pushed', () => {
    // A burst of backlog decoded at once, with the clock already at 70 ms
    for (let i = 0; i < 6; i++) push(i, i * 20_000, 70_000);
    expect(queue.size).toBe(3);   // 60 ms (due) plus 80 and 100 ms
    expect(drops.every((d) => d.reason === 'late')).toBe(true);
    expect(queue.take(70_000)?.id).toBe(3);
  });

  it('never goes back past the frame last shown', () => {
    push(1, 40_000);
    queue.take(40_000);
    push(2, 20_000);
    expect(drops).toEqual([{ id: 2, reason: 'late' }]);
  });

  it('inserts out-of-order frames in timestamp order', () => {
    push(1, 0);
    push(3, 40_000);
    push(2, 20_000);
    expect(queue.take(20_000)?.id).toBe(2);
    expect(queue.take(40_000)?.id).toBe(3);
  });

  it('drops the oldest frame when full', () => {
    for (let i = 0; i < 9; i++) push(i, i * 20_000);
    expect(drops).toEqual([{ id: 0, reason: 'overflow' }]);
    expect(queue.size).toBe(8);
  });

  it('starts over when the timestamps jump to a new timeline', () => {
    push(1, 5_000_000_000);
    push(2, 5_000_020_000);
    push(3, 0);
    expect(drops.map((d) => d.reason)).toEqual(['discontinuity', 'discontinuity']);
    expect(queue.take(0)?.id).toBe(3);
  });

  it('accepts a restarted timeline after the last frame was shown', () => {
    push(1, 5_000_000_000);
    queue.take(5_000_000_000);
    push(2, 1000);
    expect(drops).toEqual([]);
    expect(queue.take(1000)?.id).toBe(2);
  });

  it('takeNewest() drops everything older', () => {
    for (let i = 0; i < 4; i++) push(i, i * 20_000);
    expect(queue.takeNewest()?.id).toBe(3);
    expect(drops.length).toBe(3);
    expect(queue.size).toBe(0);
  });

  it('keeps returning frames in order as the ring wraps', () => {
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) {
      push(i, i * 20_000);
      ids.push(queue.take(i * 20_000)!.id);
    }
    expect(ids).toEqual([...Array(50).keys()]);
  });

  it('clear() reports every frame', () => {
    push(1, 0);
    push(2, 20_000);
    queue.clear();
    expect(drops).toEqual([{ id: 1, reason: 'clear' }, { id: 2, reason: 'clear' }]);
    expect(queue.size).toBe(0);
  });
});

describe('PlaybackStats', () => {
  it('has no latency before a frame is shown', () => {
    expect(new PlaybackStats().getLatencyStats()).toBeNull();
  });

  it('records latency of shown frames', () => {
    const stats = new PlaybackStats();
    stats.recordLatency(100, 110, 150);
    expect(stats.getLatencyStats()).toMatchObject({ decodeLatency: 10, bufferLatency: 40, totalLatency: 50 });
  });

  it('returns packet history oldest first, capped to the most recent', () => {
    const stats = new PlaybackStats();
    for (let i = 0; i < 350; i++) stats.recordPacket(i * 20, i * 20_000, i % 50 === 0, i * 20 + 5);
    const history = stats.getPacketTimingHistory();
    expect(history.length).toBe(300);
    expect(history[0].streamTimestampUs).toBe(50 * 20_000);
    expect(history[299].streamTimestampUs).toBe(349 * 20_000);
    expect(history[1].intervalMs).toBe(20);
    expect(history[0].decodeLatencyMs).toBe(5);
  });

  it('marks dropped packets, unless the entry has been reused', () => {
    const stats = new PlaybackStats();
    stats.recordPacket(0, 0, true, 1);
    const index = stats.lastPacketIndex;
    const seq = stats.lastPacketSeq;
    stats.markDropped(index, seq);
    expect(stats.getPacketTimingHistory()[0].wasDropped).toBe(true);
    for (let i = 1; i <= 300; i++) stats.recordPacket(i, i, false, i);
    stats.markDropped(index, seq);
    expect(stats.getPacketTimingHistory().some((e) => e.wasDropped)).toBe(false);
  });

  it('returns copies rather than live entries', () => {
    const stats = new PlaybackStats();
    stats.recordPacket(0, 0, true, 1);
    stats.getPacketTimingHistory()[0].streamTimestampUs = 999;
    expect(stats.getPacketTimingHistory()[0].streamTimestampUs).toBe(0);
  });
});
