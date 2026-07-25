import { describe, it, expect } from 'vitest';
import { rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase } from './codec-utils';

/** Reference implementation: exact BigInt math */
function rescaleExact(pts: number | bigint, source: Timebase, target: Timebase): number {
  const p = typeof pts === 'bigint' ? pts : BigInt(Math.floor(pts));
  return Number((p * BigInt(source.num) * BigInt(target.den)) / (BigInt(source.den) * BigInt(target.num)));
}

describe('rescaleTime', () => {
  const timebases: Timebase[] = [
    { num: 1, den: 1_000_000 },
    { num: 1, den: 90_000 },
    { num: 1, den: 1000 },
    { num: 1001, den: 30_000 },
    { num: 1, den: 48_000 },
  ];

  it('matches exact BigInt math across timebases', () => {
    const values = [0, 1, 33_366, 90_000, 1_234_567, 8_999_999_999];

    for (const source of timebases) {
      for (const target of timebases) {
        for (const pts of values) {
          expect(rescaleTime(pts, source, target)).toBe(rescaleExact(pts, source, target));
        }
      }
    }
  });

  it('handles bigint input', () => {
    expect(rescaleTime(90_000n, { num: 1, den: 90_000 }, MICROSECOND_TIMEBASE)).toBe(1_000_000);
  });

  it('handles Long-like input', () => {
    const long = { low: 0, high: 0, toNumber: () => 90_000, toString: () => '90000' };
    expect(rescaleTime(long, { num: 1, den: 90_000 }, MICROSECOND_TIMEBASE)).toBe(1_000_000);
  });

  it('handles null and undefined as zero', () => {
    expect(rescaleTime(null, MICROSECOND_TIMEBASE, MICROSECOND_TIMEBASE)).toBe(0);
    expect(rescaleTime(undefined, MICROSECOND_TIMEBASE, MICROSECOND_TIMEBASE)).toBe(0);
  });

  it('falls back to BigInt math when intermediates exceed safe integers', () => {
    const source = { num: 1, den: 90_000 };
    const pts = 9_000_000_000_000n; // pts * target.den overflows 2^53
    expect(rescaleTime(pts, source, MICROSECOND_TIMEBASE)).toBe(rescaleExact(pts, source, MICROSECOND_TIMEBASE));
  });

  it('truncates toward zero like BigInt division', () => {
    // 7 ticks at 1/3s = 2.333...s -> 2333333us
    expect(rescaleTime(7, { num: 1, den: 3 }, MICROSECOND_TIMEBASE)).toBe(2_333_333);
  });
});

describe('timebaseFromCodecData', () => {
  it('uses the declared timebase', () => {
    expect(timebaseFromCodecData({ timebaseNum: 1, timebaseDen: 90_000 })).toEqual({ num: 1, den: 90_000 });
  });

  it('defaults to microseconds when absent or zero', () => {
    expect(timebaseFromCodecData(undefined)).toBe(MICROSECOND_TIMEBASE);
    expect(timebaseFromCodecData({})).toBe(MICROSECOND_TIMEBASE);
    expect(timebaseFromCodecData({ timebaseNum: 0, timebaseDen: 0 })).toBe(MICROSECOND_TIMEBASE);
  });
});
