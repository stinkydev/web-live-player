import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebCodecsDecoder } from './webcodecs-decoder';

// A VideoDecoder whose queue length the test controls.
class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state = 'unconfigured';
  decodeQueueSize = 0;
  configure = vi.fn((_config?: unknown) => { this.state = 'configured'; });
  decode = vi.fn();
  reset = vi.fn(() => { this.state = 'unconfigured'; this.decodeQueueSize = 0; });
  flush = vi.fn(async () => {});
  close = vi.fn(() => { this.state = 'closed'; });
  constructor(public init: any) { FakeVideoDecoder.instances.push(this); }
}
class FakeChunk {
  timestamp: number;
  type: string;
  constructor(public init: any) { this.timestamp = init.timestamp; this.type = init.type; }
}

const frame = (keyframe: boolean, pts = 40) => ({
  valid: true,
  header: { type: 1, media: { pts, keyframe, codecData: { timebaseNum: 1, timebaseDen: 50 } } },
  payload: new Uint8Array([1, 2, 3]),
} as any);

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as any;

describe('WebCodecsDecoder back-pressure', () => {
  let overflow: ReturnType<typeof vi.fn>;
  let decoder: WebCodecsDecoder;
  let inner: FakeVideoDecoder;

  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeChunk);
    overflow = vi.fn();
    decoder = new WebCodecsDecoder({ onQueueOverflow: overflow, maxQueueSize: 4, logger: { info() {}, warn() {}, error() {}, debug() {} } as any });
    inner = FakeVideoDecoder.instances[0];
    (decoder as any).config = { codec: 'avc1.42001f' };
    inner.configure((decoder as any).config);
    (decoder as any).outputSinceConfigure = true;
  });

  it('decodes while the queue is within the limit', () => {
    inner.decodeQueueSize = 4;
    decoder.decodeBinary(frame(false));
    expect(inner.decode).toHaveBeenCalledOnce();
    expect(overflow).not.toHaveBeenCalled();
  });

  it('drops a delta frame on a full queue and reports it, without resetting', () => {
    inner.decodeQueueSize = 5;
    decoder.decodeBinary(frame(false));
    expect(inner.decode).not.toHaveBeenCalled();
    expect(inner.reset).not.toHaveBeenCalled();
    expect(overflow).toHaveBeenCalledWith(5);
  });

  it('accepts anything while the decoder has not produced its first frame', () => {
    inner.decodeQueueSize = 5;
    (decoder as any).outputSinceConfigure = false;
    decoder.decodeBinary(frame(false));
    expect(inner.decode).toHaveBeenCalledOnce();
    expect(inner.reset).not.toHaveBeenCalled();
    expect(overflow).not.toHaveBeenCalled();
  });

  it('restarts from a keyframe that finds the queue full', () => {
    inner.decodeQueueSize = 5;
    decoder.decodeBinary(frame(true));
    expect(inner.reset).toHaveBeenCalledOnce();
    expect(inner.configure).toHaveBeenCalledTimes(2);
    expect(inner.decode).toHaveBeenCalledOnce();
    expect((inner.decode.mock.calls[0][0] as FakeChunk).init.type).toBe('key');
    expect(overflow).not.toHaveBeenCalled();
  });
});

describe('WebCodecsDecoder with chunks waiting their turn', () => {
  let overflow: ReturnType<typeof vi.fn>;
  let decoder: WebCodecsDecoder;
  let inner: FakeVideoDecoder;
  /** The decoder takes the oldest chunk it holds */
  const take = () => { inner.decodeQueueSize--; (inner as any).ondequeue?.(); };

  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeChunk);
    overflow = vi.fn();
    decoder = new WebCodecsDecoder({ onQueueOverflow: overflow, maxQueueSize: 6, maxInDecoder: 2, logger: quiet });
    inner = FakeVideoDecoder.instances[0];
    inner.decode.mockImplementation(() => { inner.decodeQueueSize++; });
    (decoder as any).config = { codec: 'av01.0.08M.08' };
    inner.configure((decoder as any).config);
    (decoder as any).outputSinceConfigure = true;
  });

  it('gives the decoder only so many chunks at once, the rest as it takes them', () => {
    for (let i = 1; i <= 4; i++) decoder.decodeBinary(frame(i === 1, i));
    expect(inner.decode).toHaveBeenCalledTimes(2);
    expect(decoder.decodeQueueSize).toBe(4);
    expect(decoder.oldestQueuedTimestamp).toBe(60_000);

    take();
    expect(inner.decode).toHaveBeenCalledTimes(3);
    expect((inner.decode.mock.calls[2][0] as FakeChunk).timestamp).toBe(60_000);
    take();
    take();
    expect(inner.decode).toHaveBeenCalledTimes(4);
    expect(decoder.oldestQueuedTimestamp).toBeNaN();
  });

  it('lets the waiting chunks go without restarting the decoder', () => {
    for (let i = 1; i <= 5; i++) decoder.decodeBinary(frame(i === 1, i));
    expect(decoder.discardQueued()).toBe(3);
    expect(inner.reset).not.toHaveBeenCalled();
    expect(decoder.decodeQueueSize).toBe(2);

    // The chunks the decoder holds still come out; the keyframe given next follows them
    decoder.decodeBinary(frame(true, 6));
    take();
    expect(inner.decode).toHaveBeenCalledTimes(3);
    expect((inner.decode.mock.calls[2][0] as FakeChunk).type).toBe('key');
  });

  it('carries on from a keyframe that finds the queue full, without restarting', () => {
    for (let i = 1; i <= 7; i++) decoder.decodeBinary(frame(i === 1, i));
    decoder.decodeBinary(frame(false, 8));
    expect(overflow).toHaveBeenCalledWith(7);

    decoder.decodeBinary(frame(true, 9));
    expect(inner.reset).not.toHaveBeenCalled();
    expect(decoder.decodeQueueSize).toBe(3);
    expect(decoder.oldestQueuedTimestamp).toBe(180_000);
  });

  it('decodes the waiting chunks too when flushed', async () => {
    for (let i = 1; i <= 4; i++) decoder.decodeBinary(frame(i === 1, i));
    await decoder.flush();
    expect(inner.decode).toHaveBeenCalledTimes(4);
    expect(inner.flush).toHaveBeenCalledOnce();
  });

  it('drops the waiting chunks on reset', () => {
    for (let i = 1; i <= 4; i++) decoder.decodeBinary(frame(i === 1, i));
    decoder.reset();
    expect(decoder.decodeQueueSize).toBe(0);
  });
});
