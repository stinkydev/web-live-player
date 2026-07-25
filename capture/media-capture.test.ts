import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaCapture } from './media-capture';
import { BaseCaptureSink, SerializedPacket } from './capture-sink';
import { CaptureStats, EncodedChunkEvent } from './capture-types';

class FakeSink extends BaseCaptureSink {
  sent: SerializedPacket[] = [];

  constructor() {
    super({});
    this._connected = true;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  send(packet: SerializedPacket): void {
    this.sent.push(packet);
  }

  /** Trigger the keyframe callback the capture registered */
  askForKeyframe(): void {
    this.requestKeyframe();
  }
}

/** A chunk that behaves like an EncodedVideoChunk for handleEncodedChunk */
function fakeChunk(type: 'video' | 'audio', bytes: number, timestamp = 0): EncodedChunkEvent {
  return {
    type,
    keyframe: type === 'video',
    timestamp,
    chunk: {
      byteLength: bytes,
      copyTo: () => {},
    } as unknown as EncodedVideoChunk,
  };
}

describe('MediaCapture', () => {
  let sink: FakeSink;
  let capture: MediaCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    sink = new FakeSink();
    capture = new MediaCapture({ sink, statsInterval: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive the private chunk handler the encoder would call */
  const feed = (event: EncodedChunkEvent) => (capture as any).handleEncodedChunk(event);
  const startStats = () => (capture as any).startStatsTimer();

  describe('statistics', () => {
    it('counts frames and bytes per media type', () => {
      feed(fakeChunk('video', 1000));
      feed(fakeChunk('audio', 100));
      feed(fakeChunk('video', 1000));

      const stats = capture.getStats();
      expect(stats.videoFramesEncoded).toBe(2);
      expect(stats.audioFramesEncoded).toBe(1);
      expect(stats.bytesSent).toBe(2100);
      expect(stats.packetsSent).toBe(3);
      expect(sink.sent.length).toBe(3);
    });

    it('measures bitrate in bits per second over the stats interval', () => {
      startStats();

      // 25 kB of video and 2.5 kB of audio within one second
      feed(fakeChunk('video', 25_000));
      feed(fakeChunk('audio', 2_500));

      vi.advanceTimersByTime(1000);

      const stats = capture.getStats();
      expect(stats.videoBitrate).toBe(200_000); // 25 kB -> 200 kbit/s
      expect(stats.audioBitrate).toBe(20_000);
    });

    it('emits stats on the configured interval', () => {
      const onStats = vi.fn();
      capture.on('stats', onStats);
      startStats();

      feed(fakeChunk('video', 1000));
      vi.advanceTimersByTime(3000);

      expect(onStats).toHaveBeenCalledTimes(3);
      const reported = onStats.mock.calls[0][0] as CaptureStats;
      expect(reported.videoFramesEncoded).toBe(1);
    });

    it('reports zero bitrate once data stops flowing', () => {
      startStats();
      feed(fakeChunk('video', 10_000));
      vi.advanceTimersByTime(1000);
      expect(capture.getStats().videoBitrate).toBeGreaterThan(0);

      vi.advanceTimersByTime(1000);
      expect(capture.getStats().videoBitrate).toBe(0);
    });
  });

  describe('pause and resume', () => {
    it('ignores pause unless capturing', () => {
      capture.pause();
      expect(capture.getState()).toBe('idle');
    });

    it('stops publishing while paused and resumes with a keyframe', () => {
      const keyframeRequested = vi.fn();
      (capture as any).encoder = { requestKeyframe: keyframeRequested };
      (capture as any).setState('capturing');

      feed(fakeChunk('video', 1000));
      expect(sink.sent.length).toBe(1);

      capture.pause();
      expect(capture.getState()).toBe('paused');

      feed(fakeChunk('video', 1000));
      feed(fakeChunk('audio', 100));
      expect(sink.sent.length).toBe(1); // nothing published while paused

      capture.resume();
      expect(capture.getState()).toBe('capturing');
      expect(keyframeRequested).toHaveBeenCalledTimes(1);

      feed(fakeChunk('video', 1000));
      expect(sink.sent.length).toBe(2);
    });

    it('does not count paused chunks in stats', () => {
      (capture as any).setState('capturing');
      capture.pause();

      feed(fakeChunk('video', 5000));

      expect(capture.getStats().videoFramesEncoded).toBe(0);
      expect(capture.getStats().bytesSent).toBe(0);
    });
  });
});
