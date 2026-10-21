import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { framesFromLastKeyframe, LiveVideoPlayer } from './live-player';
import { LiveClock } from '../sync/live-clock';
import { WebCodecsDecoder } from '../decoders/webcodecs-decoder';

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

describe('LiveVideoPlayer playout', () => {
  const PTS0 = 7_000_000_000;
  const decoded = (timestamp: number) => ({ timestamp, close: vi.fn() } as any);
  let clock: LiveClock;
  let player: LiveVideoPlayer;
  let p: any;

  /** Packets of a 50 fps stream sent from `fromMs` to `toMs`, arriving 10 ms after they are sent */
  function arrive(fromMs: number, toMs: number) {
    for (let t = fromMs; t <= toMs; t += 20) {
      clock.onPacket('video:video', PTS0 + t * 1000, t + 10);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    clock = new LiveClock({ bufferDelayMs: 100 });
    player = new LiveVideoPlayer({ enableAudio: false, clock, displayLatencyMs: 0 });
    p = player as any;
  });

  afterEach(() => {
    player.dispose();
    vi.useRealTimers();
  });

  it('plays on the clock it is given', () => {
    expect(player.getClock()).toBe(clock);
    player.setBufferDelay(250);
    expect(clock.getBufferDelay()).toBe(250);
  });

  it('shows the frame the clock says is due, whatever time it is passed', () => {
    vi.advanceTimersByTime(1000);
    const now = performance.now();
    arrive(now - 1000, now - 10);
    for (let t = now - 400; t <= now - 10; t += 20) p.handleDecodedFrame(decoded(PTS0 + t * 1000));
    player.play();

    const frame = player.getVideoFrame(123);   // a render loop on its own timeline
    // due: now - 10 ms (earliest arrival) - 100 ms (delay); the frame showing then is the one from 120 ms ago
    expect(frame?.timestamp).toBe(PTS0 + (now - 120) * 1000);
  });

  it('by default picks the frame for the middle of the refresh it will be on screen', () => {
    const ahead = new LiveVideoPlayer({ enableAudio: false, clock });
    vi.advanceTimersByTime(1000);
    const now = performance.now();
    arrive(now - 1000, now - 10);
    for (let t = now - 400; t <= now + 100; t += 20) (ahead as any).handleDecodedFrame(decoded(PTS0 + t * 1000));
    ahead.play();
    // due at the call: 110 ms ago; 1.5 refreshes of 60 Hz later: 85 ms ago - the frame from 100 ms ago
    expect(ahead.getVideoFrame()?.timestamp).toBe(PTS0 + (now - 100) * 1000);
    ahead.dispose();
  });

  it('lets go of a backlog that is already behind the clock as it decodes', () => {
    vi.advanceTimersByTime(2000);
    const now = performance.now();
    // a subscription opens with a second of old frames, decoded all at once
    arrive(now - 1000, now - 10);
    for (let t = now - 1000; t <= now - 10; t += 20) p.handleDecodedFrame(decoded(PTS0 + t * 1000));

    // only the newest frame already due and those still to come are kept
    const stats = player.getStats();
    expect(stats.bufferSize).toBe(6);
    expect(stats.droppedFrames).toBe(44);
  });

  it('holds the last frame while paused', () => {
    vi.advanceTimersByTime(1000);
    const now = performance.now();
    arrive(now - 1000, now - 10);
    p.handleDecodedFrame(decoded(PTS0 + (now - 200) * 1000));
    player.play();
    const shown = player.getVideoFrame();
    player.pause();
    p.handleDecodedFrame(decoded(PTS0 + (now - 120) * 1000));
    expect(player.getVideoFrame()).toBe(shown);
  });
});

describe('LiveVideoPlayer with a decoder that falls behind', () => {
  /**
   * A VideoDecoder that decodes one chunk per step(), in order - no faster than a stream it
   * keeps pace with - and has to start up again after a reset
   */
  class PacedDecoder {
    static last: PacedDecoder;
    state = 'unconfigured';
    held: { timestamp: number }[] = [];
    ondequeue: (() => void) | null = null;
    constructor(public init: any) { PacedDecoder.last = this; }
    get decodeQueueSize() { return this.held.length; }
    configure = vi.fn(() => { this.state = 'configured'; });
    decode(chunk: { timestamp: number }) { this.held.push(chunk); }
    reset = vi.fn(() => { this.held = []; this.state = 'unconfigured'; });
    close() { this.state = 'closed'; }
    async flush() {}
    step() {
      const chunk = this.held.shift();
      if (!chunk) return;
      this.ondequeue?.();
      this.init.output({ timestamp: chunk.timestamp, close() {} });
    }
  }
  class Chunk {
    timestamp: number;
    type: string;
    constructor(init: any) { this.timestamp = init.timestamp; this.type = init.type; }
  }

  // 50 fps, a keyframe every 2 s
  const FRAME_MS = 20;
  const GOP = 100;
  const packet = (n: number) => ({
    valid: true,
    header: { media: { pts: n * FRAME_MS * 1000, keyframe: n % GOP === 0 } },
    payload: new Uint8Array(1),
  } as any);

  let player: LiveVideoPlayer;
  let p: any;
  let inner: PacedDecoder;
  let skips: number;
  let requestKeyframe: ReturnType<typeof vi.fn>;
  let lastOut: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    vi.stubGlobal('VideoDecoder', PacedDecoder);
    vi.stubGlobal('EncodedVideoChunk', Chunk);
    player = new LiveVideoPlayer({ enableAudio: false, clock: new LiveClock({ bufferDelayMs: 100 }), displayLatencyMs: 0 });
    p = player as any;
    p.decoder = new WebCodecsDecoder({
      logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
      onFrameDecoded: (frame) => { lastOut = frame.timestamp; p.handleDecodedFrame(frame); },
      maxQueueSize: 512,
      maxInDecoder: 4,
    });
    inner = PacedDecoder.last;
    p.decoder.config = { codec: 'av01.0.08M.08' };
    inner.configure();
    p.decoder.outputSinceConfigure = true;
    requestKeyframe = vi.fn();
    p.streamSource = { requestKeyframe };
    skips = 0;
    vi.spyOn(p.logger, 'warn').mockImplementation((msg: unknown) => { if (String(msg).includes('skipping')) skips++; });
    lastOut = NaN;
  });

  afterEach(() => {
    player.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Packets `from` to `to` arrive one a frame apart, the decoder taking one each time unless stalled */
  function play(from: number, to: number, stalled = (_n: number) => false) {
    for (let n = from; n <= to; n++) {
      vi.advanceTimersByTime(FRAME_MS);
      p.decodeVideoFrame(packet(n));
      if (!stalled(n)) inner.step();
    }
  }

  it('skips a stall\'s backlog at the next keyframe once, without restarting the decoder', () => {
    // stopped for 0.8 s (a hidden tab), then only keeping pace: 40 frames behind for good
    play(0, 99, (n) => n >= 50 && n < 90);
    expect(skips).toBe(0);
    expect(requestKeyframe).toHaveBeenCalledOnce();

    play(100, 1000);
    expect(skips).toBe(1);
    expect(inner.reset).not.toHaveBeenCalled();
    // back to the few chunks the decoder holds
    expect(1000 * FRAME_MS * 1000 - lastOut).toBeLessThanOrEqual(5 * FRAME_MS * 1000);
    expect(requestKeyframe).toHaveBeenCalledOnce();
  });

  it('skips the rest of a subscription\'s opening group at the next keyframe', () => {
    // the relay hands over the group so far, 1.2 s of it, at once
    for (let n = 0; n < 60; n++) p.decodeVideoFrame(packet(n));
    play(60, 99);
    expect(skips).toBe(0);

    play(100, 400);
    expect(skips).toBe(1);
    expect(inner.reset).not.toHaveBeenCalled();
    expect(400 * FRAME_MS * 1000 - lastOut).toBeLessThanOrEqual(5 * FRAME_MS * 1000);
  });

  it('leaves a decoder that keeps up alone', () => {
    play(0, 1000);
    expect(skips).toBe(0);
    expect(requestKeyframe).not.toHaveBeenCalled();
    expect(1000 * FRAME_MS * 1000 - lastOut).toBeLessThanOrEqual(FRAME_MS * 1000);
  });
});
