import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { framesFromLastKeyframe, LiveVideoPlayer } from './live-player';
import { LiveClock } from '../sync/live-clock';

const f = (keyframe: boolean, pts: number) => ({ valid: true, header: { media: { keyframe, pts } }, payload: new Uint8Array(1) } as any);

describe('framesFromLastKeyframe', () => {
  it('replays from the newest keyframe onwards', () => {
    const frames = [f(true, 1), f(false, 2), f(false, 3), f(true, 4), f(false, 5)];
    expect(framesFromLastKeyframe(frames).map((x: any) => x.header.media.pts)).toEqual([4, 5]);
  });

  it('keeps everything when the only keyframe is first', () => {
    const frames = [f(true, 1), f(false, 2)];
    expect(framesFromLastKeyframe(frames)).toHaveLength(2);
  });

  it('keeps everything when there is no keyframe at all', () => {
    const frames = [f(false, 1), f(false, 2)];
    expect(framesFromLastKeyframe(frames)).toHaveLength(2);
  });
});

describe('LiveVideoPlayer playout', () => {
  const PTS0 = 7_000_000_000;
  const decoded = (timestamp: number) => ({ timestamp, close: vi.fn() } as any);
  let clock: LiveClock;
  let player: LiveVideoPlayer;
  let p: any;

  /** Packets of a 50 fps stream sent from `fromMs` to `toMs`, arriving 10 ms after they are sent */
  function arrive(fromMs: number, toMs: number) {
    for (let t = fromMs; t <= toMs; t += 20) {
      clock.onPacket('video:video', PTS0 + t * 1000, t + 10);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    clock = new LiveClock({ bufferDelayMs: 100 });
    player = new LiveVideoPlayer({ enableAudio: false, clock, displayLatencyMs: 0 });
    p = player as any;
  });

  afterEach(() => {
    player.dispose();
    vi.useRealTimers();
  });

  it('plays on the clock it is given', () => {
    expect(player.getClock()).toBe(clock);
    player.setBufferDelay(250);
    expect(clock.getBufferDelay()).toBe(250);
  });

  it('shows the frame the clock says is due, whatever time it is passed', () => {
    vi.advanceTimersByTime(1000);
    const now = performance.now();
    arrive(now - 1000, now - 10);
    for (let t = now - 400; t <= now - 10; t += 20) p.handleDecodedFrame(decoded(PTS0 + t * 1000));
    player.play();

    const frame = player.getVideoFrame(123);   // a render loop on its own timeline
    // due: now - 10 ms (earliest arrival) - 100 ms (delay); the frame showing then is the one from 120 ms ago
    expect(frame?.timestamp).toBe(PTS0 + (now - 120) * 1000);
  });

  it('by default picks the frame for the middle of the refresh it will be on screen', () => {
    const ahead = new LiveVideoPlayer({ enableAudio: false, clock });
    vi.advanceTimersByTime(1000);
    const now = performance.now();
    arrive(now - 1000, now - 10);
    for (let t = now - 400; t <= now + 100; t += 20) (ahead as any).handleDecodedFrame(decoded(PTS0 + t * 1000));
    ahead.play();
    // due at the call: 110 ms ago; 1.5 refreshes of 60 Hz later: 85 ms ago - the frame from 100 ms ago
    expect(ahead.getVideoFrame()?.timestamp).toBe(PTS0 + (now - 100) * 1000);
    ahead.dispose();
  });

  it('lets go of a backlog that is already behind the clock as it decodes', () => {
    vi.advanceTimersByTime(2000);
    const now = performance.now();
    // a subscription opens with a second of old frames, decoded all at once
    arrive(now - 1000, now - 10);
    for (let t = now - 1000; t <= now - 10; t += 20) p.handleDecodedFrame(decoded(PTS0 + t * 1000));

    // only the newest frame already due and those still to come are kept
    const stats = player.getStats();
    expect(stats.bufferSize).toBe(6);
    expect(stats.droppedFrames).toBe(44);
  });

  it('holds the last frame while paused', () => {
    vi.advanceTimersByTime(1000);
    const now = performance.now();
    arrive(now - 1000, now - 10);
    p.handleDecodedFrame(decoded(PTS0 + (now - 200) * 1000));
    player.play();
    const shown = player.getVideoFrame();
    player.pause();
    p.handleDecodedFrame(decoded(PTS0 + (now - 120) * 1000));
    expect(player.getVideoFrame()).toBe(shown);
  });
});
