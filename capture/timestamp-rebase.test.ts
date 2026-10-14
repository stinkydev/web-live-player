import { describe, it, expect } from 'vitest';
import { TimestampRebaser } from './timestamp-rebase';

const WALL = 1_791_000_000_000_000;   // µs since the epoch

/** Feed frames every `intervalUs` from a capture clock at `baseUs`, delivered `delay(i)` late */
function feed(r: TimestampRebaser, opts: { count: number; intervalUs: number; baseUs: number; startWallUs?: number;
  delay?: (i: number) => number; ppm?: number; from?: number }) {
  for (let i = opts.from ?? 0; i < (opts.from ?? 0) + opts.count; i++) {
    const wall = (opts.startWallUs ?? WALL) + i * opts.intervalUs;
    const ts = opts.baseUs + i * opts.intervalUs * (1 + (opts.ppm ?? 0) / 1e6);
    r.observe(ts, wall + (opts.delay?.(i) ?? 0));
  }
}

describe('TimestampRebaser', () => {
  it('puts tracks from different clocks on one wall clock', () => {
    // video counted from system start (3 h), audio from zero; both captured at the same moments
    const video = new TimestampRebaser();
    const audio = new TimestampRebaser();
    feed(video, { count: 100, intervalUs: 33_333, baseUs: 10_800_000_000, delay: (i) => 5000 + (i % 7) * 1000 });
    feed(audio, { count: 300, intervalUs: 10_000, baseUs: 0, delay: (i) => 2000 + (i % 5) * 1000 });
    // the frames captured at WALL + 1 s map to within the difference of their shortest delays
    const v = video.map(10_800_000_000 + 30 * 33_333) - (WALL + 30 * 33_333);
    const a = audio.map(100 * 10_000) - (WALL + 100 * 10_000);
    expect(v).toBeGreaterThanOrEqual(5000);
    expect(v).toBeLessThanOrEqual(5001);
    expect(a).toBeGreaterThanOrEqual(2000);
    expect(a).toBeLessThanOrEqual(2001);
  });

  it('settles on the least-delayed frame rather than the first', () => {
    const r = new TimestampRebaser();
    feed(r, { count: 20, intervalUs: 20_000, baseUs: 0, delay: (i) => (i === 0 ? 80_000 : 3000) });
    expect(r.offset).toBe(WALL + 3000);
  });

  it('follows a drifting capture clock at most 1 ms a second, without jumps', () => {
    const r = new TimestampRebaser();
    let last = -Infinity;
    let maxStep = 0;
    // a capture clock 200 ppm slow, for two minutes
    for (let i = 0; i < 6000; i++) {
      const wall = WALL + i * 20_000;
      const ts = i * 20_000 * (1 - 200 / 1e6);
      r.observe(ts, wall + 2000);
      const mapped = r.map(ts);
      if (i > 0) maxStep = Math.max(maxStep, Math.abs(mapped - last - 20_000));
      last = mapped;
    }
    // mapped timestamps stay on the wall clock (within a millisecond) and step smoothly
    expect(Math.abs(r.map((5999 * 20_000) * (1 - 200 / 1e6)) - (WALL + 5999 * 20_000 + 2000))).toBeLessThan(1000);
    expect(maxStep).toBeLessThan(25);
  });

  it('settles afresh when a track restarts its timestamps', () => {
    const r = new TimestampRebaser();
    feed(r, { count: 100, intervalUs: 20_000, baseUs: 5_000_000_000, delay: () => 3000 });
    feed(r, { count: 100, intervalUs: 20_000, baseUs: 0, delay: () => 3000, from: 100, startWallUs: WALL });
    expect(r.map(150 * 20_000)).toBe(WALL + 150 * 20_000 + 3000);
  });

  it('leaves timestamps alone before the first frame', () => {
    expect(new TimestampRebaser().map(1234.4)).toBe(1234);
  });
});
