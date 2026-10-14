/**
 * Packet Duration
 *
 * How much audio an encoded packet holds, read from the packet itself where the codec allows,
 * so a gap in the input can be told from the next packet before anything has decoded.
 */

/** Frame length in µs for each Opus TOC configuration (RFC 6716, section 3.1) */
const OPUS_FRAME_US = [
  // SILK-only: 10, 20, 40, 60 ms for each of NB, MB, WB
  10_000, 20_000, 40_000, 60_000, 10_000, 20_000, 40_000, 60_000, 10_000, 20_000, 40_000, 60_000,
  // Hybrid: 10, 20 ms for SWB, FB
  10_000, 20_000, 10_000, 20_000,
  // CELT-only: 2.5, 5, 10, 20 ms for NB, WB, SWB, FB
  2_500, 5_000, 10_000, 20_000, 2_500, 5_000, 10_000, 20_000, 2_500, 5_000, 10_000, 20_000, 2_500, 5_000, 10_000, 20_000,
];

/** Duration of an Opus packet in µs, from its TOC byte; undefined if the packet is malformed */
export function opusPacketDurationUs(data: Uint8Array): number | undefined {
  if (data.length < 1) return undefined;
  const toc = data[0];
  const frameUs = OPUS_FRAME_US[toc >> 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (data.length < 2) return undefined;
    frames = data[1] & 0x3f;
  }
  return frames > 0 ? frames * frameUs : undefined;
}

/**
 * Duration of a packet in µs for a WebCodecs audio codec string: read from an Opus packet, a
 * frame of 1024 samples for AAC. Undefined when it cannot be told.
 */
export function packetDurationUs(codec: string, data: Uint8Array, sampleRate: number): number | undefined {
  if (codec === 'opus') return opusPacketDurationUs(data);
  if (codec.startsWith('mp4a') && sampleRate > 0) return (1024 / sampleRate) * 1_000_000;
  return undefined;
}
