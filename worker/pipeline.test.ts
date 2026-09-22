import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WireProtocol, FrameType } from '@stinkycomputing/sesame-api-client';
import type { ParsedFrame } from '@stinkycomputing/sesame-api-client';
import { PipelineCore, PipelineFeed, PipelineSession } from './pipeline-core';
import { PipelineClient } from './pipeline-client';
import { ACK_BATCH, IN_FLIGHT_LIMIT, PipelinePort } from './pipeline-protocol';
import type { VideoFeedCallbacks, VideoFeedConfig } from '../player/video-feed';
import type { StreamDataEvent } from '../sources/stream-source';

// The core and the client, joined by an in-process port pair: messages are handed over as
// they are (no structured clone), delivered on a microtask like a real port would.

class FakePort implements PipelinePort {
  other!: FakePort;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
    queueMicrotask(() => this.other.onmessage?.({ data: message }));
  }
}

function portPair(): [FakePort, FakePort] {
  const a = new FakePort();
  const b = new FakePort();
  a.other = b;
  b.other = a;
  return [a, b];
}

class FakeSession implements PipelineSession {
  handlers = new Map<string, (...args: any[]) => void>();
  connect = vi.fn(async () => {});
  dispose = vi.fn();
  constructor(public config: any, public subscriptions: any[]) {}
  on(event: string, handler: (...args: any[]) => void): void { this.handlers.set(event, handler); }
  emit(event: string, ...args: any[]): void { this.handlers.get(event)?.(...args); }
}

class FakeFeed implements PipelineFeed {
  pushed: ParsedFrame[] = [];
  flush = vi.fn();
  dispose = vi.fn();
  setPreferredDecoder = vi.fn(() => true);
  setDebugLogging = vi.fn();
  decoderState = 'configured';
  decodeQueueSize = 2;
  framesDecoded = 0;
  streamWidth = 1920;
  streamHeight = 1080;
  frameRate = 50;
  constructor(public config: VideoFeedConfig, public callbacks: VideoFeedCallbacks) {}
  push(data: ParsedFrame): void { this.pushed.push(data); }
  /** A decoded frame, as the decoder would deliver it. */
  decoded(timestampUs: number, isKeyframe = false): FakeFrame {
    const frame = new FakeFrame(timestampUs);
    this.framesDecoded++;
    this.callbacks.onFrame(frame as unknown as VideoFrame, timestampUs, 100, 110, isKeyframe);
    return frame;
  }
}

class FakeFrame {
  closed = false;
  constructor(public timestamp: number) {}
  close(): void { this.closed = true; }
}

const codecData = { codecType: 1, width: 1920, height: 1080, timebaseNum: 1, timebaseDen: 50 };

function videoFrame(pts: number, keyframe: boolean, payload = new Uint8Array([1, 2, 3, 4])): Uint8Array {
  return WireProtocol.serialize({ type: FrameType.FRAME_TYPE_VIDEO, media: { pts, keyframe, codecData } }, payload);
}

function dataFrame(payload: Uint8Array): Uint8Array {
  return WireProtocol.serialize({ type: FrameType.FRAME_TYPE_DATA }, payload);
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup() {
  const [workerPort, mainPort] = portPair();
  const sessions: FakeSession[] = [];
  const feeds: FakeFeed[] = [];
  const core = new PipelineCore(workerPort, {
    createSession: (config, subscriptions) => { const s = new FakeSession(config, subscriptions); sessions.push(s); return s; },
    createFeed: (config, callbacks) => { const f = new FakeFeed(config, callbacks); feeds.push(f); return f; },
    epochNow: () => 1_000_000 + performance.now(),
    statsIntervalMs: 0,
  });
  const client = new PipelineClient(mainPort, { logger: silent });
  return { core, client, sessions, feeds, workerPort, mainPort };
}

describe('pipeline core and client', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('connects a session with the configured tracks and resolves once the relay is reached', async () => {
    const connected = t.client.connect({ relayUrl: 'https://relay.invalid', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }, { name: 'audio', streamType: 'audio' }] });
    await flush();
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0].config).toMatchObject({ relayUrl: 'https://relay.invalid', namespace: 'ns', subscribeAll: false });
    expect(t.sessions[0].subscriptions.map((s: any) => s.trackName)).toEqual(['video', 'audio']);
    await expect(connected).resolves.toBeUndefined();
  });

  it('subscribes to nothing by name when subscribing to all', async () => {
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [], subscribeAll: true });
    await flush();
    expect(t.sessions[0].config.subscribeAll).toBe(true);
    expect(t.sessions[0].subscriptions).toEqual([]);
  });

  it('forwards audio and data frames whole, parsed on the main thread with their wire size', async () => {
    const events: StreamDataEvent[] = [];
    t.client.source.on('data', (e) => events.push(e));
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'data', streamType: 'data' }] });
    await flush();
    const wire = dataFrame(new Uint8Array([9, 8, 7]));
    t.sessions[0].emit('data', 'data', wire);
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].trackName).toBe('data');
    expect(events[0].streamType).toBe('data');
    expect(Array.from(events[0].data.payload!)).toEqual([9, 8, 7]);
    expect(events[0].wireBytes).toBe(wire.byteLength);
    // a copy went over, not a view of the transport's buffer
    expect(events[0].data.payload!.buffer).not.toBe(wire.buffer);
  });

  it('classifies a track it was not told about by its first frame', async () => {
    const events: StreamDataEvent[] = [];
    t.client.source.on('data', (e) => events.push(e));
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [], subscribeAll: true });
    await flush();
    t.sessions[0].emit('data', 'extra', dataFrame(new Uint8Array([1])));
    await flush();
    expect(events[0].streamType).toBe('data');
  });

  it('decodes an enabled video track in the worker and forwards keyframe headers only', async () => {
    const events: StreamDataEvent[] = [];
    t.client.source.on('data', (e) => events.push(e));
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }] });
    t.client.setVideo('video', { enabled: true, preferredDecoder: 'webcodecs-hw' });
    await flush();
    expect(t.feeds).toHaveLength(1);
    expect(t.feeds[0].config.preferredDecoder).toBe('webcodecs-hw');

    const key = videoFrame(0, true);
    const delta = videoFrame(20000, false);
    t.sessions[0].emit('data', 'video', key);
    t.sessions[0].emit('data', 'video', delta);
    await flush();

    expect(t.feeds[0].pushed).toHaveLength(2);
    // pts decodes as a protobuf Long
    expect(String(t.feeds[0].pushed[1].header?.media?.pts)).toBe('20000');
    // the keyframe's header reached the main thread without its payload; the delta did not
    expect(events).toHaveLength(1);
    expect(events[0].streamType).toBe('video');
    expect(events[0].data.header?.media?.keyframe).toBe(true);
    expect(events[0].data.payload?.byteLength).toBe(0);
    expect(events[0].wireBytes).toBe(key.byteLength);
  });

  it('delivers decoded frames to the track consumer with times on this thread\'s clock', async () => {
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }] });
    const received: any[] = [];
    t.client.subscribeVideo('video', { onFrame: (frame, timestampUs, arrivalTime, decodeTime, isKeyframe) => received.push({ frame, timestampUs, arrivalTime, decodeTime, isKeyframe }) });
    t.client.setVideo('video', { enabled: true });
    await flush();

    const frame = t.feeds[0].decoded(40000, true);
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0].frame).toBe(frame);
    expect(received[0].timestampUs).toBe(40000);
    expect(received[0].isKeyframe).toBe(true);
    // the feed's 100 and 110 were moved to the epoch in the worker and back here
    const offset = 1_000_000 - performance.timeOrigin;
    expect(received[0].arrivalTime).toBeCloseTo(100 + offset, 0);
    expect(received[0].decodeTime).toBeCloseTo(110 + offset, 0);
    expect(frame.closed).toBe(false);
  });

  it('closes frames of a track nobody consumes', async () => {
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }] });
    t.client.setVideo('video', { enabled: true });
    await flush();
    const frame = t.feeds[0].decoded(0);
    await flush();
    expect(frame.closed).toBe(true);
  });

  it('acknowledges taken frames in batches and drops past the in-flight window', async () => {
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }] });
    t.client.subscribeVideo('video', { onFrame: () => {} });
    t.client.setVideo('video', { enabled: true });
    await flush();

    // frames posted but not yet taken: the port has not delivered them
    const frames = Array.from({ length: IN_FLIGHT_LIMIT + 2 }, (_, i) => t.feeds[0].decoded(i * 1000));
    expect(frames.slice(0, IN_FLIGHT_LIMIT).every(f => !f.closed)).toBe(true);
    expect(frames.slice(IN_FLIGHT_LIMIT).every(f => f.closed)).toBe(true);
    await flush();
    // the main thread took them and acked in batches of ACK_BATCH
    const acks = t.mainPort.posted.filter((m: any) => m.type === 'ack') as any[];
    expect(acks.length).toBe(Math.floor(IN_FLIGHT_LIMIT / ACK_BATCH));
    expect(acks.every(a => a.frames === ACK_BATCH)).toBe(true);
    t.core.postStats();
    await flush();
    expect(t.client.trackStats('video')?.framesDropped).toBe(2);
    // the window reopened
    const more = t.feeds[0].decoded(99000);
    expect(more.closed).toBe(false);
  });

  it('reports stats per track and bytes received since the last report', async () => {
    const stats: any[] = [];
    t.client.on('stats', (tracks, bytes) => stats.push({ tracks, bytes }));
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }, { name: 'data', streamType: 'data' }] });
    t.client.setVideo('video', { enabled: true });
    await flush();
    const wire = videoFrame(0, true);
    t.sessions[0].emit('data', 'video', wire);
    t.sessions[0].emit('data', 'data', dataFrame(new Uint8Array(10)));
    t.core.postStats();
    await flush();
    expect(stats).toHaveLength(1);
    expect(stats[0].tracks.video).toMatchObject({ decoderState: 'configured', width: 1920, height: 1080, frameRate: 50 });
    expect(stats[0].bytes.video).toBe(wire.byteLength);
    expect(stats[0].bytes.data).toBeGreaterThan(10);
    expect(t.client.trackStats('video')?.decoderState).toBe('configured');
    t.core.postStats();
    await flush();
    expect(stats[1].bytes).toEqual({});
  });

  it('mirrors session state and catalog, and learns track types from the catalog', async () => {
    const states: string[] = [];
    const catalogs: any[] = [];
    const events: StreamDataEvent[] = [];
    t.client.on('state', (state) => states.push(state));
    t.client.on('catalog', (c) => catalogs.push(c));
    t.client.source.on('data', (e) => events.push(e));
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [], subscribeAll: true });
    await flush();
    t.sessions[0].emit('stateChange', { state: 'connected', reconnectAttempts: 0 });
    t.sessions[0].emit('catalog', { tracks: [{ trackName: 'cam', type: 'video', priority: 0 }] });
    await flush();
    expect(states).toEqual(['connected']);
    expect(t.client.source.connected).toBe(true);
    expect(catalogs[0].tracks[0].trackName).toBe('cam');
    // a keyframe on the catalog's video track is parsed as video: header only
    t.sessions[0].emit('data', 'cam', videoFrame(0, true));
    await flush();
    expect(events[0].streamType).toBe('video');
    expect(events[0].data.payload?.byteLength).toBe(0);
    t.sessions[0].emit('stateChange', { state: 'reconnecting', reconnectAttempts: 1 });
    await flush();
    expect(t.client.source.connected).toBe(false);
  });

  it('switches the decoder of a running track and disposes it when disabled', async () => {
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }] });
    t.client.setVideo('video', { enabled: true, preferredDecoder: 'webcodecs-sw' });
    await flush();
    t.client.setVideo('video', { enabled: true, preferredDecoder: 'webcodecs-hw' });
    t.client.flush('video');
    await flush();
    expect(t.feeds).toHaveLength(1);
    expect(t.feeds[0].setPreferredDecoder).toHaveBeenCalledWith('webcodecs-hw');
    expect(t.feeds[0].flush).toHaveBeenCalledOnce();
    t.client.setVideo('video', { enabled: false });
    await flush();
    expect(t.feeds[0].dispose).toHaveBeenCalledOnce();
  });

  it('disposes the session and the feeds with the client', async () => {
    void t.client.connect({ relayUrl: 'u', namespace: 'ns', tracks: [{ name: 'video', streamType: 'video' }] });
    t.client.setVideo('video', { enabled: true });
    await flush();
    t.client.dispose();
    await flush();
    expect(t.feeds[0].dispose).toHaveBeenCalledOnce();
    expect(t.sessions[0].dispose).toHaveBeenCalledOnce();
    // nothing more comes out of a disposed core
    t.workerPort.posted.length = 0;
    t.sessions[0].emit('stateChange', { state: 'connected', reconnectAttempts: 0 });
    expect(t.workerPort.posted).toHaveLength(0);
  });
});
