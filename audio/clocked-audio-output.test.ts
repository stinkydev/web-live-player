import { describe, it, expect } from 'vitest';
import { AudioFollower, audiblePosition } from './clocked-audio-output';

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
