import { describe, it, expect, vi } from 'vitest';
import { AudioFollower, audiblePosition, ClockedAudioOutput } from './clocked-audio-output';

/**
 * Error of audio following a clock through `seconds` of reports every ~21 ms, on a device that
 * renders `deviceRate` seconds of audio per real second. Returns the error at the end (s).
 */
function follow(follower: AudioFollower, startErrorS: number, deviceRate: number, seconds: number, onStep?: (factor: number) => void): number {
  const dt = 1024 / 48000;
  let error = startErrorS;
  for (let t = 0; t < seconds; t += dt) {
    const factor = follower.update(error, dt);
    onStep?.(factor);
    // stream advance per real second at this speed, against the clock's one second
    error += (factor * deviceRate - 1) * dt;
  }
  return error;
}

describe('AudioFollower', () => {
  it('holds still when the audio is on the clock', () => {
    const follower = new AudioFollower();
    expect(follow(follower, 0, 1, 10)).toBeCloseTo(0, 6);
    expect(follower.drift).toBeCloseTo(0, 6);
  });

  it('removes a small error with a small speed change, and learns no drift from it', () => {
    const follower = new AudioFollower();
    let maxAdjust = 0;
    const end = follow(follower, 0.008, 1, 60, (f) => { maxAdjust = Math.max(maxAdjust, Math.abs(f - 1)); });
    expect(Math.abs(end)).toBeLessThan(0.0005);
    // the half-percent correction plus what the drift estimate picks up on the way
    expect(maxAdjust).toBeLessThan(0.01);
    expect(Math.abs(follower.drift)).toBeLessThan(0.0005);
  });

  it('learns a sound card running half a percent slow and gets back on the clock', () => {
    const follower = new AudioFollower();
    const end = follow(follower, 0, 0.995, 60);
    expect(Math.abs(end)).toBeLessThan(0.001);
    expect(follower.drift).toBeCloseTo(1 / 0.995 - 1, 3);
  });

  it('keeps the learned drift across a jump', () => {
    const follower = new AudioFollower();
    follow(follower, 0, 0.998, 60);
    const drift = follower.drift;
    expect(follower.restart()).toBeCloseTo(1 + drift, 9);
  });
});

describe('audiblePosition', () => {
  it('carries a reported read position on to the context time being heard', () => {
    // 4800 samples in at context time 1.0, reading at 1.02 per output sample (44.1 kHz context)
    const pos = audiblePosition({ contextTime: 1.0, pos: 4800, step: 1.02 }, { contextTime: 0.95, performanceTime: 0 }, 44100);
    expect(pos).toBeCloseTo(4800 - 0.05 * 44100 * 1.02, 6);
  });
});

describe('ClockedAudioOutput gap handling', () => {
  /** A decoder that records what it is asked to do; flush() resolves when the test says so */
  function fakeDecoder() {
    const calls: string[] = [];
    let finishFlush: () => void = () => {};
    const decoder = {
      state: 'configured',
      decode: (chunk: { timestamp: number }) => calls.push(`decode ${chunk.timestamp}`),
      reset: () => calls.push('reset'),
      configure: () => calls.push('configure'),
      flush: () => { calls.push('flush'); return new Promise<void>((resolve) => { finishFlush = resolve; }); },
      close: () => {},
    };
    return { decoder, calls, finishFlush: () => finishFlush() };
  }

  function output() {
    vi.stubGlobal('EncodedAudioChunk', class { constructor(init: object) { Object.assign(this, init); } });
    const ctx = { createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1 } }), destination: {} } as any;
    const out = new ClockedAudioOutput(ctx, { clock: { ptsAt: () => 0, rate: 1 } });
    const fake = fakeDecoder();
    Object.assign(out as any, { configured: true, decoder: fake.decoder, decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } });
    return { out, ...fake };
  }

  // Opus TOC: CELT fullband 20 ms frames, two of them - a 40 ms packet
  const opus40 = new Uint8Array([(31 << 3) | 1, 0]);

  it('reads packet lengths from the packets, so 40 ms packets are no gap', () => {
    const { out, calls } = output();
    for (let i = 0; i < 4; i++) out.decode(opus40, i * 40_000);
    expect(calls).toEqual(['decode 0', 'decode 40000', 'decode 80000', 'decode 120000']);
  });

  it('at a gap lets the decoder finish what it holds before restarting it, holding what follows', async () => {
    const { out, calls, finishFlush } = output();
    out.decode(opus40, 0);
    out.decode(opus40, 40_000);
    out.decode(opus40, 120_000);   // 80 000 is missing
    out.decode(opus40, 160_000);
    expect(calls).toEqual(['decode 0', 'decode 40000', 'flush']);
    finishFlush();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['decode 0', 'decode 40000', 'flush', 'reset', 'configure', 'decode 120000', 'decode 160000']);
  });

  it('on clear() throws away what is decoding at once (a seek)', () => {
    const { out, calls } = output();
    (out as any).workletNode = { port: { postMessage() {} } };
    out.decode(opus40, 0);
    out.clear();
    out.decode(opus40, 5_000_000);
    expect(calls).toEqual(['decode 0', 'reset', 'configure', 'decode 5000000']);
  });
});
