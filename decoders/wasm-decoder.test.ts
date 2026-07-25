import { describe, it, expect } from 'vitest';
import { forEachNAL, carriesPicture } from './wasm-decoder';

/** Collect the NALs of a stream as plain arrays (views are only valid during the visit) */
function splitNALs(stream: number[]): number[][] {
  const out: number[][] = [];
  forEachNAL(new Uint8Array(stream), nal => out.push(Array.from(nal)));
  return out;
}

const START4 = [0, 0, 0, 1];
const START3 = [0, 0, 1];

describe('forEachNAL', () => {
  it('splits an access unit into NALs, keeping start codes', () => {
    // SPS (type 7), PPS (type 8), IDR slice (type 5)
    const stream = [...START4, 0x67, 0xaa, ...START4, 0x68, 0xbb, ...START4, 0x65, 0xcc, 0xdd];

    expect(splitNALs(stream)).toEqual([
      [...START4, 0x67, 0xaa],
      [...START4, 0x68, 0xbb],
      [...START4, 0x65, 0xcc, 0xdd],
    ]);
  });

  it('handles 3-byte start codes and a mix of both', () => {
    const stream = [...START3, 0x67, 0x01, ...START4, 0x65, 0x02];

    expect(splitNALs(stream)).toEqual([
      [...START3, 0x67, 0x01],
      [...START4, 0x65, 0x02],
    ]);
  });

  it('emits a single NAL when there is only one', () => {
    const stream = [...START4, 0x41, 0x11, 0x22];
    expect(splitNALs(stream)).toEqual([stream]);
  });

  it('passes the buffer through unchanged when framing is not Annex B', () => {
    const stream = [0x00, 0x00, 0x0a, 0x41, 0x11];
    expect(splitNALs(stream)).toEqual([stream]);
  });

  it('ignores an empty stream', () => {
    expect(splitNALs([])).toEqual([]);
  });

  it('does not split on the zero bytes of its own start code', () => {
    // A stream of just one 4-byte-prefixed NAL must not yield a second empty NAL
    expect(splitNALs([...START4, 0x65]).length).toBe(1);
  });

  it('keeps emulation-prevention-free payload zeros inside the NAL', () => {
    // 00 00 02 is not a start code and must stay in the payload
    const stream = [...START4, 0x65, 0x00, 0x00, 0x02, 0x33];
    expect(splitNALs(stream)).toEqual([stream]);
  });

  it('covers every payload byte exactly once', () => {
    const stream = [...START4, 0x67, 1, 2, ...START3, 0x68, 3, ...START4, 0x65, 4, 5, 6];
    const flattened = splitNALs(stream).flat();
    expect(flattened).toEqual(stream);
  });
});

describe('carriesPicture', () => {
  it('is true for slice NALs', () => {
    expect(carriesPicture(new Uint8Array([...START4, 0x65]))).toBe(true); // IDR slice, type 5
    expect(carriesPicture(new Uint8Array([...START4, 0x41]))).toBe(true); // non-IDR slice, type 1
    expect(carriesPicture(new Uint8Array([...START3, 0x65]))).toBe(true);
  });

  it('is false for parameter sets and other non-slice NALs', () => {
    expect(carriesPicture(new Uint8Array([...START4, 0x67]))).toBe(false); // SPS, type 7
    expect(carriesPicture(new Uint8Array([...START4, 0x68]))).toBe(false); // PPS, type 8
    expect(carriesPicture(new Uint8Array([...START4, 0x06]))).toBe(false); // SEI, type 6
    expect(carriesPicture(new Uint8Array([...START4, 0x09]))).toBe(false); // AUD, type 9
  });

  it('assumes a picture when framing is not Annex B', () => {
    expect(carriesPicture(new Uint8Array([0x41, 0x11]))).toBe(true);
  });
});
