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

