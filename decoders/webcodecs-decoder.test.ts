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
class FakeChunk { constructor(public init: any) {} }

const frame = (keyframe: boolean) => ({
  valid: true,
  header: { type: 1, media: { pts: 40, keyframe, codecData: { timebaseNum: 1, timebaseDen: 50 } } },
  payload: new Uint8Array([1, 2, 3]),
} as any);

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
