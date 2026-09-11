import { describe, it, expect } from 'vitest';
import { framesFromLastKeyframe } from './live-player';

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

import { vi } from 'vitest';
import { LiveVideoPlayer } from './live-player';

describe('catching up to the live edge', () => {
  const decoded = (timestamp: number) => ({ timestamp, close: vi.fn() } as any);

  it('shows nothing older than the newest frame replayed after configuration', () => {
    const player = new LiveVideoPlayer({ enableAudio: false, videoTrackName: 'video' } as any);
    const p = player as any;
    p.showFromUs = 3_000_000;
    const old = decoded(1_000_000);
    p.handleDecodedFrame(old);
    expect(old.close).toHaveBeenCalledOnce();
    expect(player.getStats().totalFrames).toBe(0);
    const edge = decoded(3_000_000);
    p.handleDecodedFrame(edge);
    expect(edge.close).not.toHaveBeenCalled();
    expect(player.getStats().totalFrames).toBe(1);
    // once at the edge, nothing is skipped any more
    const later = decoded(2_000_000);
    p.handleDecodedFrame(later);
    expect(later.close).not.toHaveBeenCalled();
    player.dispose();
  });
});
