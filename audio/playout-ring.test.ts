import { describe, it, expect } from 'vitest';
import { PlayoutRing } from './playout-ring';

const RATE = 48000;

function ramp(start: number, n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (start + i) / 1e6;
  return a;
}

function sine(startSample: number, n: number, freq: number, rate = RATE): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * freq * (startSample + i)) / rate);
  return a;
}

/** Render `quanta` blocks of 128 and return the left channel */
function renderQuanta(ring: PlayoutRing, quanta: number): Float32Array {
  const out = new Float32Array(quanta * 128);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  for (let q = 0; q < quanta; q++) {
    ring.render(l, r);
    out.set(l, q * 128);
  }
  return out;
}

describe('PlayoutRing', () => {
  it('is silent until a read position is set', () => {
    const ring = new PlayoutRing({ outputRate: RATE });
    ring.write(1000, ramp(1000, 960), null);
    ring.playing = true;
    expect(renderQuanta(ring, 2).every((v) => v === 0)).toBe(true);
  });

  it('plays samples back unchanged at step 1 once faded in', () => {
    const ring = new PlayoutRing({ outputRate: RATE, fadeMs: 1 });
    ring.write(5_000_000, ramp(0, 9600), null);
    ring.seek(5_000_000);
    ring.playing = true;
    const out = renderQuanta(ring, 60);
    // the first 48 samples fade in; after that the input comes through exactly
    for (let i = 100; i < 7000; i++) expect(out[i]).toBeCloseTo(i / 1e6, 9);
    expect(out[0]).toBe(0);
  });

  it('places chunks by position whatever order they arrive in', () => {
    const ring = new PlayoutRing({ outputRate: RATE, fadeMs: 1 });
    ring.write(960, ramp(960, 960), null);
    ring.write(0, ramp(0, 960), null);
    ring.seek(0);
    ring.playing = true;
    const out = renderQuanta(ring, 15);
    // up to where it starts fading out ahead of the end of the data
    for (let i = 100; i < 1850; i++) expect(out[i]).toBeCloseTo(i / 1e6, 9);
  });

  it('plays a missing chunk as silence without shifting what follows', () => {
    const ring = new PlayoutRing({ outputRate: RATE, fadeMs: 1 });
    ring.write(0, ramp(0, 960), null);
    ring.write(1920, ramp(1920, 960), null);   // 960-1919 never arrives
    ring.seek(0);
    ring.playing = true;
    const out = renderQuanta(ring, 23);
    for (let i = 960; i < 1920; i++) expect(out[i]).toBe(0);
    for (let i = 1920 + 60; i < 2880 - 60; i++) expect(out[i]).toBeCloseTo(i / 1e6, 9);
    // faded out ahead of the gap rather than cut
    expect(Math.abs(out[959])).toBeLessThan(1e-6);
    expect(ring.underrunSamples).toBeGreaterThanOrEqual(960);
  });

  it('drops audio that arrives after its turn', () => {
    const ring = new PlayoutRing({ outputRate: RATE });
    ring.seek(10_000);
    ring.playing = true;
    expect(ring.write(9_000, ramp(9_000, 960), null)).toBe(0);
    expect(ring.lateSamples).toBe(960);
    expect(ring.write(9_500, ramp(9_500, 960), null)).toBe(460 + 2);
  });

  it('never plays a slot left over from an earlier lap', () => {
    const ring = new PlayoutRing({ outputRate: RATE, capacityLog2: 12, fadeMs: 1 });
    ring.write(100, sine(100, 960, 440), null);
    ring.seek(100 + ring.capacity);   // the same slots, one lap later
    ring.playing = true;
    expect(renderQuanta(ring, 6).every((v) => v === 0)).toBe(true);
  });

  it('resamples 48 kHz to 44.1 kHz without losing samples at chunk boundaries', () => {
    const out = 44100;
    const ring = new PlayoutRing({ outputRate: out });
    ring.step = RATE / out;
    ring.seek(0);
    ring.playing = true;

    const quanta = Math.round((60 * out) / 128);   // one minute
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let written = 0;
    let prev = 0;
    let maxDelta = 0;
    for (let q = 0; q < quanta; q++) {
      // keep ~100 ms written ahead, in 20 ms chunks like Opus
      while (written < ring.readPos + 4800) {
        ring.write(written, sine(written, 960, 1000), null);
        written += 960;
      }
      ring.render(l, r);
      for (let i = 0; i < 128; i++) {
        if (q > 0 || i > 400) maxDelta = Math.max(maxDelta, Math.abs(l[i] - prev));
        prev = l[i];
      }
    }
    // exactly one stream sample per 1/48000 s consumed - no truncation drift
    expect(ring.readPos).toBeCloseTo((quanta * 128 * RATE) / out, 3);
    // a 1 kHz sine at amplitude 0.5 moves at most 0.5 * 2pi * 1000 / 44100 per sample
    expect(maxDelta).toBeLessThan(0.5 * 2 * Math.PI * 1000 / out * 1.02);
    expect(ring.underrunSamples).toBe(0);
  });

  it('fades out, jumps and fades back in on a shift while playing', () => {
    const ring = new PlayoutRing({ outputRate: RATE, fadeMs: 1 });
    ring.write(0, ramp(0, 20_000), null);
    ring.seek(0);
    ring.playing = true;
    renderQuanta(ring, 10);   // 1280 samples in
    ring.shift(5000);
    renderQuanta(ring, 10);
    // 2560 output samples at step 1, plus the 5000 jumped
    expect(ring.readPos).toBe(2560 + 5000);
  });

  it('keeps the read position moving while muted', () => {
    const ring = new PlayoutRing({ outputRate: RATE });
    ring.write(0, ramp(0, 9600), null);
    ring.seek(0);
    renderQuanta(ring, 10);
    expect(ring.readPos).toBe(1280);
    expect(ring.underrunSamples).toBe(0);
  });

  it('reports how much is buffered ahead of the read position', () => {
    const ring = new PlayoutRing({ outputRate: RATE });
    ring.write(0, ramp(0, 960), null);
    ring.write(960, ramp(960, 960), null);
    ring.seek(100);
    expect(ring.bufferedAhead()).toBe(1820);
    ring.clear();
    expect(ring.bufferedAhead()).toBe(0);
  });
});
