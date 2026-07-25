/**
 * Codec utility functions
 */

import type { IMediaCodecData } from '@stinkycomputing/sesame-api-client';

/**
 * Timebase structure for timestamp conversion
 */
export interface Timebase {
  num: number;
  den: number;
}

/**
 * Microsecond timebase - the player's internal timestamp unit.
 * Shared constant so hot paths don't allocate a literal per frame.
 */
export const MICROSECOND_TIMEBASE: Timebase = { num: 1, den: 1_000_000 };

/**
 * PTS value accepted by rescaleTime: plain number, bigint, or a protobufjs Long
 */
export type PtsValue = number | bigint | null | undefined | { toString(): string };

/**
 * Convert a pts value (number, Long, or bigint) to bigint
 */
function toBigInt(value: PtsValue): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.floor(value));
  // Long type from protobufjs or any object with toString (duck-typed)
  return BigInt(value.toString());
}

/**
 * Try to get a safe-integer number from a pts value without allocating.
 * Returns null if the value isn't representable exactly as a Number.
 */
function toSafeNumber(value: PtsValue): number | null {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    const floored = Math.floor(value);
    return Number.isSafeInteger(floored) ? floored : null;
  }
  if (typeof value === 'bigint') {
    return value <= 9007199254740991n && value >= -9007199254740991n ? Number(value) : null;
  }
  // Long from protobufjs: toNumber() is exact below 2^53
  const toNumber = (value as { toNumber?: () => number }).toNumber;
  if (typeof toNumber === 'function') {
    const n = toNumber.call(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Rescale a timestamp from one timebase to another.
 *
 * Uses plain Number arithmetic while every intermediate stays exact
 * (which is the case for all real stream timestamps) and falls back to
 * BigInt only on overflow - BigInt math allocates, and this runs per frame.
 */
export function rescaleTime(pts: PtsValue, source: Timebase, target: Timebase): number {
  const ptsNum = toSafeNumber(pts);
  if (ptsNum !== null) {
    const numerator = ptsNum * source.num * target.den;
    const denominator = source.den * target.num;
    if (Number.isSafeInteger(numerator) && denominator !== 0) {
      // Truncate toward zero to match BigInt division semantics
      return Math.trunc(numerator / denominator);
    }
  }

  const ptsBigInt = toBigInt(pts);
  // Convert to target timebase: pts * (source.num / source.den) * (target.den / target.num)
  const scaledPts = (ptsBigInt * BigInt(source.num) * BigInt(target.den)) / (BigInt(source.den) * BigInt(target.num));
  return Number(scaledPts);
}

/**
 * Get the source timebase declared by codec data, defaulting to microseconds.
 *
 * Callers should cache the result alongside the codec data rather than calling
 * this per frame - it allocates.
 */
export function timebaseFromCodecData(codecData: IMediaCodecData | undefined | null): Timebase {
  if (codecData?.timebaseDen && codecData?.timebaseNum) {
    return { num: codecData.timebaseNum, den: codecData.timebaseDen };
  }
  return MICROSECOND_TIMEBASE;
}

/**
 * Check if codec data has changed
 */
export function codecDataChanged(
  current: IMediaCodecData | undefined,
  newData: IMediaCodecData | undefined
): boolean {
  if (!current && !newData) return false;
  if (!current || !newData) return true;
  
  return (
    current.codecType !== newData.codecType ||
    current.width !== newData.width ||
    current.height !== newData.height ||
    current.codecProfile !== newData.codecProfile ||
    current.codecLevel !== newData.codecLevel
  );
}

/**
 * Get human-readable codec name
 */
export function getCodecName(codecType: number): string {
  switch (codecType) {
    case 1: return 'VP8';
    case 2: return 'VP9';
    case 3: return 'H.264/AVC';
    case 4: return 'H.265/HEVC';
    case 5: return 'AV1';
    case 64: return 'Opus';
    case 65: return 'AAC';
    case 66: return 'PCM';
    default: return 'Unknown';
  }
}

/**
 * Get WebCodecs codec string for a given codec data
 */
export function getCodecString(codecData: IMediaCodecData): string | null {
  switch (codecData.codecType) {
    case 3: // VIDEO_AVC (H.264)
      // H.264/AVC codec string: avc1.PPCCLL
      const profile = codecData.codecProfile && codecData.codecProfile > 0 
        ? codecData.codecProfile.toString(16).padStart(2, '0')
        : '42'; // Default to Baseline profile
      const constraint = '00';
      const level = codecData.codecLevel && codecData.codecLevel > 0
        ? codecData.codecLevel.toString(16).padStart(2, '0')
        : '1f'; // Default to level 3.1
      return `avc1.${profile}${constraint}${level}`;
    case 4: // VIDEO_HEVC (H.265)
      return 'hev1.1.6.L93.B0';
    case 2: // VIDEO_VP9
      return 'vp09.00.10.08';
    case 1: // VIDEO_VP8
      return 'vp8';
    case 5: // VIDEO_AV1
      return 'av01.0.00M.08';
    default:
      return null;
  }
}
