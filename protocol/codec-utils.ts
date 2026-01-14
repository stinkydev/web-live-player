/**
 * Codec utility functions
 */

import type { HeaderCodecData } from './sesame-binary-protocol';

/**
 * Timebase structure for timestamp conversion
 */
export interface Timebase {
  num: number;
  den: number;
}

/**
 * Rescale a timestamp from one timebase to another
 */
export function rescaleTime(pts: bigint, source: Timebase, target: Timebase): number {
  // Convert to target timebase: pts * (source.num / source.den) * (target.den / target.num)
  const scaledPts = (pts * BigInt(source.num) * BigInt(target.den)) / (BigInt(source.den) * BigInt(target.num));
  return Number(scaledPts);
}

/**
 * Check if codec data has changed
 */
export function codecDataChanged(
  current: HeaderCodecData | undefined,
  newData: HeaderCodecData | undefined
): boolean {
  if (!current && !newData) return false;
  if (!current || !newData) return true;
  
  return (
    current.codec_type !== newData.codec_type ||
    current.width !== newData.width ||
    current.height !== newData.height ||
    current.codec_profile !== newData.codec_profile ||
    current.codec_level !== newData.codec_level
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
export function getCodecString(codecData: HeaderCodecData): string | null {
  switch (codecData.codec_type) {
    case 3: // VIDEO_AVC (H.264)
      // H.264/AVC codec string: avc1.PPCCLL
      const profile = codecData.codec_profile > 0 
        ? codecData.codec_profile.toString(16).padStart(2, '0')
        : '42'; // Default to Baseline profile
      const constraint = '00';
      const level = codecData.codec_level > 0
        ? codecData.codec_level.toString(16).padStart(2, '0')
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
