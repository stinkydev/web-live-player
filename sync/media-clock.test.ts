import { describe, it, expect } from 'vitest';
import { MediaClock } from './media-clock';

describe('MediaClock', () => {
  let t = 1000;
  const clock = () => new MediaClock(() => t);

  it('holds at zero until played', () => {
    const c = clock();
    t += 500;
    expect(c.ptsAt()).toBe(0);
    expect(c.isPlaying).toBe(false);
  });

  it('runs with real time while playing and holds while paused', () => {
    const c = clock();
    c.play();
    t += 250;
    expect(c.ptsAt()).toBe(250_000);
    c.pause();
    t += 1000;
    expect(c.ptsAt()).toBe(250_000);
    c.play();
    t += 100;
    expect(c.ptsAt()).toBe(350_000);
    expect(c.ptsAt(t + 20)).toBe(370_000);
  });

  it('seeks while playing or paused', () => {
    const c = clock();
    c.seek(5_000_000);
    expect(c.ptsAt()).toBe(5_000_000);
    c.play();
    t += 40;
    c.seek(1_000_000);
    t += 10;
    expect(c.ptsAt()).toBe(1_010_000);
  });
});
