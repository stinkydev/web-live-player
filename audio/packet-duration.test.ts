import { describe, it, expect } from 'vitest';
import { opusPacketDurationUs, packetDurationUs } from './packet-duration';

const toc = (config: number, code: number) => (config << 3) | code;

describe('opusPacketDurationUs', () => {
  it('reads the frame length and count from the TOC byte', () => {
    expect(opusPacketDurationUs(new Uint8Array([toc(31, 0)]))).toBe(20_000);            // CELT FB 20 ms, 1 frame
    expect(opusPacketDurationUs(new Uint8Array([toc(31, 1)]))).toBe(40_000);            // 2 frames
    expect(opusPacketDurationUs(new Uint8Array([toc(3, 0)]))).toBe(60_000);             // SILK NB 60 ms
    expect(opusPacketDurationUs(new Uint8Array([toc(13, 2)]))).toBe(40_000);            // Hybrid FB 20 ms, 2 frames
    expect(opusPacketDurationUs(new Uint8Array([toc(16, 3), 0x03]))).toBe(7_500);       // CELT NB 2.5 ms, 3 frames
  });

  it('gives up on a malformed packet', () => {
    expect(opusPacketDurationUs(new Uint8Array([]))).toBeUndefined();
    expect(opusPacketDurationUs(new Uint8Array([toc(31, 3)]))).toBeUndefined();
    expect(opusPacketDurationUs(new Uint8Array([toc(31, 3), 0]))).toBeUndefined();
  });
});

describe('packetDurationUs', () => {
  it('knows Opus from the packet and AAC from its frame size', () => {
    expect(packetDurationUs('opus', new Uint8Array([toc(31, 0)]), 48000)).toBe(20_000);
    expect(packetDurationUs('mp4a.40.2', new Uint8Array([1]), 48000)).toBeCloseTo(21_333.3, 0);
    expect(packetDurationUs('flac', new Uint8Array([1]), 48000)).toBeUndefined();
  });
});
