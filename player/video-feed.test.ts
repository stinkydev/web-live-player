import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VideoFeed } from './video-feed';
import { sesame } from '@stinkycomputing/sesame-api-client';

// A VideoDecoder the test drives: configure() succeeds, decode() records, and the test
// delivers output frames through the init's callback.
class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  static isConfigSupported = async (config: unknown) => ({ supported: true, config });
  state = 'unconfigured';
  decodeQueueSize = 0;
  configure = vi.fn((_config?: unknown) => { this.state = 'configured'; });
  decode = vi.fn();
  reset = vi.fn(() => { this.state = 'unconfigured'; });
  flush = vi.fn(async () => {});
  close = vi.fn(() => { this.state = 'closed'; });
  constructor(public init: { output: (frame: any) => void; error: (e: Error) => void }) { FakeVideoDecoder.instances.push(this); }
}
class FakeChunk { constructor(public init: any) {} }

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const codecData = { codecType: sesame.v1.common.CodecType.CODEC_TYPE_VIDEO_AVC, width: 640, height: 360, timebaseNum: 1, timebaseDen: 50 };
const packet = (pts: number, keyframe: boolean) => ({
  valid: true,
  header: { type: 1, media: { pts, keyframe, codecData } },
  payload: new Uint8Array([1, 2, 3]),
} as any);
const decoded = (timestamp: number) => ({ timestamp, close: vi.fn() });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('VideoFeed', () => {
  let frames: any[];
  let requests: number;
  let feed: VideoFeed;

  beforeEach(() => {
    FakeVideoDecoder.instances = [];
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeChunk);
    frames = [];
    requests = 0;
    feed = new VideoFeed({ logger: silent, preferredDecoder: 'webcodecs-sw' }, {
      onFrame: (frame, timestampUs, arrivalTime, decodeTime, isKeyframe) => frames.push({ frame, timestampUs, arrivalTime, decodeTime, isKeyframe }),
      requestKeyframe: () => { requests++; },
    });
  });

  it('configures on the first keyframe, replays it, and times the decoded frame', async () => {
    const metadata: any[] = [];
    (feed as any).callbacks.onMetadata = (m: any) => metadata.push(m);
    feed.push(packet(0, true));
    expect(feed.decoderState).toBe('unconfigured');
    await flush();
    const decoder = FakeVideoDecoder.instances[0];
    expect(decoder.configure).toHaveBeenCalledOnce();
    expect(decoder.decode).toHaveBeenCalledOnce();
    expect(metadata[0]).toEqual({ width: 640, height: 360, codec: 'H.264' });
    expect(feed.streamWidth).toBe(640);

    // pts 0 at 1/50 is 0 us; the output carries the packet's arrival and keyframe flag
    const out = decoded(0);
    decoder.init.output(out);
    expect(frames).toHaveLength(1);
    expect(frames[0].frame).toBe(out);
    expect(frames[0].isKeyframe).toBe(true);
    expect(frames[0].decodeTime).toBeGreaterThanOrEqual(frames[0].arrivalTime);
    expect(feed.framesDecoded).toBe(1);
  });

  it('waits for a keyframe before decoding again after a flush, and asks for one', async () => {
    feed.push(packet(0, true));
    await flush();
    const decoder = FakeVideoDecoder.instances[0];
    feed.push(packet(1, false));
    expect(decoder.decode).toHaveBeenCalledTimes(2);
    feed.flush();
    expect(decoder.reset).toHaveBeenCalledOnce();
    expect(requests).toBe(1);
    feed.push(packet(2, false));
    expect(decoder.decode).toHaveBeenCalledTimes(2);
    feed.push(packet(3, true));
    expect(decoder.decode).toHaveBeenCalledTimes(3);
  });

  it('shows nothing older than the newest frame replayed after configuration', () => {
    const f = feed as any;
    f.showFromUs = 3_000_000;
    const old = decoded(1_000_000);
    f.handleDecodedFrame(old);
    expect(old.close).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);
    const edge = decoded(3_000_000);
    f.handleDecodedFrame(edge);
    expect(edge.close).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    // once at the edge, nothing is skipped any more
    const later = decoded(2_000_000);
    f.handleDecodedFrame(later);
    expect(later.close).not.toHaveBeenCalled();
    expect(frames).toHaveLength(2);
  });

  it('drops the decoder on a preference change and reports the buffered frames stale', async () => {
    expect(feed.setPreferredDecoder('webcodecs-hw')).toBe(false); // nothing running yet
    feed.push(packet(0, true));
    await flush();
    const decoder = FakeVideoDecoder.instances[0];
    expect(feed.setPreferredDecoder('webcodecs-sw')).toBe(true);
    expect(decoder.close).toHaveBeenCalledOnce();
    expect(feed.decoderState).toBe('none');
    expect(requests).toBe(1);
    // the next keyframe configures a new decoder with the new preference
    feed.push(packet(10, true));
    await flush();
    expect(FakeVideoDecoder.instances).toHaveLength(2);
    expect(FakeVideoDecoder.instances[1].configure.mock.calls[0][0]).toMatchObject({ hardwareAcceleration: 'prefer-software' });
  });

  it('closes its decoder on dispose', async () => {
    feed.push(packet(0, true));
    await flush();
    feed.dispose();
    expect(FakeVideoDecoder.instances[0].close).toHaveBeenCalledOnce();
    expect(feed.decoderState).toBe('none');
  });
});
