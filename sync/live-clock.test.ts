import { describe, it, expect } from 'vitest';
import { LiveClock } from './live-clock';

/** A fake time source the tests move by hand */
function fakeTime(start = 10_000) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; } };
}

interface Packet { track: string; ptsUs: number; arrivalMs: number }

/**
 * Packets every `intervalMs` on one track, arriving `baseDelayMs + delay(i)` after their
 * timestamp. Timestamps run on the publisher's clock, which may be `ppm` fast.
 */
function stream(opts: {
  track?: string; count: number; intervalMs?: number; ptsStartUs?: number; epochMs?: number;
  baseDelayMs?: number; delay?: (i: number) => number; ppm?: number;
}): Packet[] {
  const interval = opts.intervalMs ?? 20;
  const ptsStart = opts.ptsStartUs ?? 5_000_000_000;
  const epoch = opts.epochMs ?? 10_000;
  const out: Packet[] = [];
  for (let i = 0; i < opts.count; i++) {
    const sentMs = epoch + i * interval;
    const ptsUs = ptsStart + i * interval * 1000 * (1 + (opts.ppm ?? 0) / 1e6);
    out.push({ track: opts.track ?? 'video', ptsUs, arrivalMs: sentMs + (opts.baseDelayMs ?? 30) + (opts.delay?.(i) ?? 0) });
  }
  return out;
}

/** Deliver packets in arrival order, calling `check` every `stepMs` of fake time in between. */
function run(clock: LiveClock, time: ReturnType<typeof fakeTime>, packets: Packet[], check?: (t: number) => void, stepMs = 10) {
  const sorted = [...packets].sort((a, b) => a.arrivalMs - b.arrivalMs);
  let t = sorted[0].arrivalMs;
  for (const p of sorted) {
    while (t + stepMs <= p.arrivalMs) {
      t += stepMs;
      time.set(t);
      check?.(t);
    }
    time.set(p.arrivalMs);
    clock.onPacket(p.track, p.ptsUs, p.arrivalMs);
  }
}

/** pts the clock should show at local time t for a stream sent at epoch with base delay d */
const ideal = (t: number, epochMs: number, baseDelayMs: number, delayMs: number, ptsStartUs = 5_000_000_000) =>
  ptsStartUs + (t - epochMs - baseDelayMs - delayMs) * 1000;

describe('LiveClock', () => {
  it('has no time before the first packet', () => {
    const time = fakeTime();
    const clock = new LiveClock({ now: time.now });
    expect(clock.ptsAt()).toBeNull();
    expect(clock.targetAt()).toBeNull();
    expect(clock.isRunning).toBe(false);
  });

  it('starts once the first packets have settled, at the delay behind them', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    run(clock, time, stream({ count: 5 }));       // 80 ms of packets
    expect(clock.ptsAt()).toBeNull();
    expect(clock.targetAt()).not.toBeNull();
    run(clock, time, stream({ count: 20 }).slice(5));
    const t = time.now();
    expect(clock.isRunning).toBe(true);
    expect(clock.ptsAt(t)).toBeCloseTo(ideal(t, 10_000, 30, 150), -2);
  });

  it('holds the delay behind the earliest arrivals through jitter, without jumping', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    // Lateness like the test stream: mostly a few ms, now and then a stall of up to 400 ms
    const delay = (i: number) => (i % 97 === 0 ? 400 - (i % 5) * 20 : (i * 7919) % 11);
    let worst = 0;
    run(clock, time, stream({ count: 1500, delay }), (t) => {
      const pts = clock.ptsAt(t);
      // the first seconds settle on the earliest arrivals
      if (pts !== null && t > 13_000) worst = Math.max(worst, Math.abs(pts - ideal(t, 10_000, 30, 150)));
    });
    expect(clock.getStats().jumps).toBe(0);
    expect(worst).toBeLessThan(1000);   // within 1 ms of the ideal line
  });

  it('starts at the live edge rather than at the backlog a subscription opens with', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    // One second of old packets lands within 50 ms, then the stream runs live
    const live = stream({ count: 300, epochMs: 11_000, ptsStartUs: 5_001_000_000 });
    const backlog = stream({ count: 50, epochMs: 10_000 }).map((p, i) => ({ ...p, arrivalMs: 11_030 + i }));
    run(clock, time, [...backlog, ...live]);
    const t = time.now();
    expect(clock.ptsAt(t)).toBeCloseTo(ideal(t, 10_000, 30, 150), -3);
    expect(clock.getStats().jumps).toBe(0);
  });

  it('follows a publisher clock that runs fast, by rate and without jumping', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    const packets = stream({ count: 6000, ppm: 200, delay: (i) => (i * 31) % 7 });   // two minutes
    run(clock, time, packets);
    // The earliest packets arrive 30 ms after they were sent, on a timeline 200 ppm fast
    const t = time.now();
    const expected = 5_000_000_000 + (t - 10_000 - 30 - 150) * 1000 * (1 + 200 / 1e6);
    expect(Math.abs(clock.ptsAt(t)! - expected)).toBeLessThan(2000);
    expect(clock.getStats().jumps).toBe(0);
    expect(clock.rate).toBeGreaterThan(1);
    expect(clock.rate).toBeLessThan(1.01);
  });

  it('slews within the rate limit when the path gets faster', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, maxRateAdjust: 0.01, now: time.now });
    // 30 ms faster from packet 500 on
    const packets = stream({ count: 1500, delay: (i) => (i < 500 ? 30 : 0) });
    let minRate = 1, maxRate = 1;
    run(clock, time, packets, () => {
      clock.ptsAt();
      minRate = Math.min(minRate, clock.rate);
      maxRate = Math.max(maxRate, clock.rate);
    });
    const t = time.now();
    expect(clock.getStats().jumps).toBe(0);
    expect(maxRate).toBeLessThanOrEqual(1.01 + 1e-9);
    expect(minRate).toBeGreaterThanOrEqual(0.99 - 1e-9);
    expect(Math.abs(clock.ptsAt(t)! - ideal(t, 10_000, 30, 150))).toBeLessThan(1000);
  });

  it('moves back once a slower path has filled the window', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    const packets = stream({ count: 1500, delay: (i) => (i < 500 ? 0 : 40) });
    run(clock, time, packets);
    const t = time.now();
    expect(Math.abs(clock.ptsAt(t)! - ideal(t, 10_000, 70, 150))).toBeLessThan(1000);
  });

  it('re-syncs within a second when the path gets much slower, instead of waiting out the window', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    // 400 ms slower from packet 500 on (a reconnect over a worse route)
    const packets = stream({ count: 1000, delay: (i) => (i < 500 ? 0 : 400) });
    let late = 0;
    run(clock, time, packets.filter((_, i) => i < 500));
    for (const p of packets.slice(500)) {
      time.set(p.arrivalMs);
      clock.onPacket(p.track, p.ptsUs, p.arrivalMs);
      if (p.ptsUs < clock.ptsAt(p.arrivalMs)!) late++;
    }
    expect(late * 20).toBeLessThanOrEqual(1100);   // about a second's worth, not five
    const t = time.now();
    expect(Math.abs(clock.ptsAt(t)! - ideal(t, 10_000, 430, 150))).toBeLessThan(1000);
  });

  it('jumps when the error is too large to slew', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    run(clock, time, stream({ count: 1000, delay: (i) => (i < 500 ? 400 : 0) }));
    const t = time.now();
    expect(clock.getStats().jumps).toBe(1);
    expect(Math.abs(clock.ptsAt(t)! - ideal(t, 10_000, 30, 150))).toBeLessThan(1000);
  });

  it('applies a new buffer delay at once', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    run(clock, time, stream({ count: 100 }));
    clock.setBufferDelay(300);
    const t = time.now();
    expect(clock.ptsAt(t)).toBeCloseTo(ideal(t, 10_000, 30, 300), -2);
    expect(clock.getBufferDelay()).toBe(300);
  });

  it('re-syncs when the publisher restarts its timestamps', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    const before = stream({ count: 200 });
    const after = stream({ count: 200, epochMs: 14_000, ptsStartUs: 0 });
    run(clock, time, [...before, ...after]);
    const t = time.now();
    expect(clock.getStats().discontinuities).toBe(1);
    expect(clock.ptsAt(t)).toBeCloseTo(ideal(t, 14_000, 30, 150, 0), -2);
  });

  it('carries on across a gap in a continuous timeline', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    const packets = stream({ count: 600 }).filter((_, i) => i < 200 || i >= 350);   // 3 s gap
    run(clock, time, packets);
    const t = time.now();
    expect(clock.getStats().discontinuities).toBe(0);
    expect(clock.getStats().jumps).toBe(0);
    expect(clock.ptsAt(t)).toBeCloseTo(ideal(t, 10_000, 30, 150), -2);
  });

  it('puts audio and video of one stream on one timeline', () => {
    const time = fakeTime();
    const clock = new LiveClock({ bufferDelayMs: 150, now: time.now });
    const video = stream({ track: 'video', count: 300, delay: (i) => (i % 13) * 3 });
    const audio = stream({ track: 'audio', count: 300, ptsStartUs: 5_000_000_000 + 5000, epochMs: 10_005, delay: (i) => (i % 7) * 4 });
    run(clock, time, [...video, ...audio]);
    const t = time.now();
    expect(clock.ptsAt(t)).toBeCloseTo(ideal(t, 10_000, 30, 150), -2);
  });
});
