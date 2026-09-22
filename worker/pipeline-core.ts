/**
 * The worker side of the pipeline: one MoQ session, one video feed per enabled video track.
 *
 * Video frames are parsed here and decoded here; their headers go to the main thread on
 * keyframes and when they carry side data. Audio and data frames go over whole, as bytes.
 * The class takes its port and its factories so it runs in a test without a worker.
 */

import { WireProtocol, FrameType } from '@stinkycomputing/sesame-api-client';
import type { ParsedFrame } from '@stinkycomputing/sesame-api-client';
import type { ICatalog, MoQSessionConfig, SessionStatus, SubscriptionConfig, SubscriptionStatus } from 'stinky-moq-js';
import type { Logger, PreferredDecoder } from '../types';
import type { VideoFeedCallbacks, VideoFeedConfig, VideoMetadata } from '../player/video-feed';
import {
  ACK_BATCH, IN_FLIGHT_LIMIT,
  FromWorkerMessage, PipelineConnectConfig, PipelinePort, PipelineStreamType, ToWorkerMessage, TrackStats, VideoTrackSettings,
} from './pipeline-protocol';

/** The part of a MoQ subscriber session the core uses. */
export interface PipelineSession {
  on(event: string, handler: (...args: any[]) => void): void;
  connect(): Promise<void>;
  dispose(): void;
}

/** A video feed as the core drives it: the player's feed plus what the stats report. */
export interface PipelineFeed {
  push(data: ParsedFrame): void;
  flush(): void;
  setPreferredDecoder(type: PreferredDecoder): boolean;
  setDebugLogging(enabled: boolean): void;
  readonly decoderState: string;
  readonly decodeQueueSize: number;
  readonly framesDecoded: number;
  readonly streamWidth: number;
  readonly streamHeight: number;
  readonly frameRate: number;
  dispose(): void;
}

export interface PipelineCoreDeps {
  createSession(config: MoQSessionConfig, subscriptions: SubscriptionConfig[]): PipelineSession;
  createFeed(config: VideoFeedConfig, callbacks: VideoFeedCallbacks): PipelineFeed;
  /** Milliseconds since the epoch; the default places performance.now() on the epoch. */
  epochNow?: () => number;
  /** How often stats are posted; 0 posts none on its own (postStats() still works). */
  statsIntervalMs?: number;
}

const WIRE_PREFIX_SIZE = 4;

interface VideoTrack {
  feed: PipelineFeed;
  inFlight: number;
  dropped: number;
}

export class PipelineCore {
  private session: PipelineSession | null = null;
  private trackTypes = new Map<string, PipelineStreamType>();
  private videoTracks = new Map<string, VideoTrack>();
  private bytesReceived = new Map<string, number>();
  private debugLogging = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly epochNow: () => number;
  private readonly logger: Logger;

  constructor(private port: PipelinePort, private deps: PipelineCoreDeps) {
    this.epochNow = deps.epochNow ?? (() => performance.timeOrigin + performance.now());
    this.logger = {
      debug: (message) => { if (this.debugLogging) this.post({ type: 'log', level: 'debug', message }); },
      info: (message) => this.post({ type: 'log', level: 'info', message }),
      warn: (message) => this.post({ type: 'log', level: 'warn', message }),
      error: (message) => this.post({ type: 'log', level: 'error', message }),
    };
    port.onmessage = (event) => this.handle(event.data as ToWorkerMessage);
  }

  private post(message: FromWorkerMessage, transfer?: Transferable[]): void {
    if (this.disposed) return;
    this.port.postMessage(message, transfer);
  }

  private handle(message: ToWorkerMessage): void {
    switch (message.type) {
      case 'connect': this.connect(message.config); break;
      case 'video': this.setVideo(message.track, message.settings); break;
      case 'flush': this.videoTracks.get(message.track)?.feed.flush(); break;
      // The transport has no keyframe request; the publisher's next keyframe resumes decoding.
      case 'request-keyframe': break;
      case 'ack': {
        const track = this.videoTracks.get(message.track);
        if (track) track.inFlight = Math.max(0, track.inFlight - message.frames);
        break;
      }
      case 'debug-logging':
        this.debugLogging = message.enabled;
        for (const track of this.videoTracks.values()) track.feed.setDebugLogging(message.enabled);
        break;
      case 'dispose': this.dispose(); break;
    }
  }

  private connect(config: PipelineConnectConfig): void {
    if (this.session) return;
    this.debugLogging = config.debugLogging ?? false;
    for (const track of config.tracks) {
      if (track.streamType) this.trackTypes.set(track.name, track.streamType);
    }
    const params: MoQSessionConfig = {
      relayUrl: config.relayUrl,
      namespace: config.namespace,
      reconnection: { delay: config.reconnectionDelay ?? 3000 },
      subscribeAll: !!config.subscribeAll,
    };
    const subscriptions: SubscriptionConfig[] = config.subscribeAll
      ? []
      : config.tracks.map(t => ({ trackName: t.name, priority: 0, retry: { delay: 2000 } }));
    const session = this.deps.createSession(params, subscriptions);
    this.session = session;

    session.on('data', (trackName: string, data: Uint8Array) => this.onData(trackName, data));
    session.on('catalog', (catalog: ICatalog) => {
      for (const t of catalog.tracks) {
        if (t.trackName && t.type) this.trackTypes.set(t.trackName, t.type);
      }
      this.post({ type: 'catalog', catalog });
    });
    session.on('stateChange', (status: SessionStatus) => {
      this.post({ type: 'state', state: status.state, reconnectAttempts: status.reconnectAttempts, lastError: status.lastError?.message });
    });
    session.on('subscriptionStateChange', (trackName: string, status: SubscriptionStatus) => {
      this.post({ type: 'subscription', track: trackName, state: status.state, error: status.lastError?.message });
    });
    session.on('subscriptionError', (trackName: string, error: Error) => {
      this.post({ type: 'subscription', track: trackName, state: 'failed', error: error.message });
    });
    session.on('error', (error: Error) => this.post({ type: 'error', message: error.message }));

    session.connect().then(
      () => this.post({ type: 'connected' }),
      (error) => this.post({ type: 'connect-failed', message: error instanceof Error ? error.message : String(error) }),
    );

    const interval = this.deps.statsIntervalMs ?? 250;
    if (interval > 0) this.statsTimer = setInterval(() => this.postStats(), interval);
  }

  private setVideo(trackName: string, settings: VideoTrackSettings): void {
    const existing = this.videoTracks.get(trackName);
    if (!settings.enabled) {
      if (existing) {
        existing.feed.dispose();
        this.videoTracks.delete(trackName);
      }
      return;
    }
    this.trackTypes.set(trackName, 'video');
    if (existing) {
      if (settings.preferredDecoder) existing.feed.setPreferredDecoder(settings.preferredDecoder);
      return;
    }
    const track: VideoTrack = { feed: null as unknown as PipelineFeed, inFlight: 0, dropped: 0 };
    track.feed = this.deps.createFeed(
      { preferredDecoder: settings.preferredDecoder, logger: this.logger, debugLogging: this.debugLogging },
      {
        onFrame: (frame, timestampUs, arrivalTime, decodeTime, isKeyframe) => this.onFrame(trackName, track, frame, timestampUs, arrivalTime, decodeTime, isKeyframe),
        onMetadata: (metadata: VideoMetadata) => this.post({ type: 'metadata', track: trackName, ...metadata }),
        onError: (error) => this.post({ type: 'error', message: `${trackName}: ${error.message}` }),
      },
    );
    this.videoTracks.set(trackName, track);
  }

  // Decoded frames the main thread has not taken are not queued behind it: past the window
  // they are closed here, and the scheduler on the other side skips ahead as it would have.
  private onFrame(trackName: string, track: VideoTrack, frame: VideoFrame, timestampUs: number, arrivalTime: number, decodeTime: number, isKeyframe: boolean): void {
    if (this.disposed || track.inFlight >= IN_FLIGHT_LIMIT) {
      frame.close();
      track.dropped++;
      return;
    }
    // The feed's times are its performance.now(); the main thread has another origin.
    const offset = this.epochNow() - performance.now();
    track.inFlight++;
    this.post({
      type: 'frame', track: trackName, frame, timestampUs,
      arrivalEpochMs: arrivalTime + offset, decodeEpochMs: decodeTime + offset, isKeyframe,
    }, [frame]);
  }

  private onData(trackName: string, bytes: Uint8Array): void {
    this.bytesReceived.set(trackName, (this.bytesReceived.get(trackName) ?? 0) + bytes.byteLength);
    let type = this.trackTypes.get(trackName);
    if (type === 'video' || type === undefined) {
      const parsed = WireProtocol.parse(bytes);
      if (parsed.valid && parsed.header) {
        if (type === undefined) {
          type = streamTypeOf(parsed.header.type);
          this.trackTypes.set(trackName, type);
        }
        if (type === 'video') {
          this.videoTracks.get(trackName)?.feed.push(parsed);
          const media = parsed.header.media;
          if (media?.keyframe || hasSideData(media)) {
            const headerBytes = bytes.slice(0, WIRE_PREFIX_SIZE + headerSize(bytes));
            this.post({ type: 'data', track: trackName, streamType: 'video', bytes: headerBytes, wireBytes: bytes.byteLength }, [headerBytes.buffer]);
          }
          return;
        }
      }
    }
    // A copy: the transport's buffer may hold the frames that follow this one.
    const copy = bytes.slice();
    this.post({ type: 'data', track: trackName, streamType: type ?? 'data', bytes: copy, wireBytes: bytes.byteLength }, [copy.buffer]);
  }

  public postStats(): void {
    const tracks: Record<string, TrackStats> = {};
    for (const [name, track] of this.videoTracks) {
      const feed = track.feed;
      tracks[name] = {
        decoderState: feed.decoderState,
        decodeQueueSize: feed.decodeQueueSize,
        framesDecoded: feed.framesDecoded,
        framesDropped: track.dropped,
        width: feed.streamWidth,
        height: feed.streamHeight,
        frameRate: feed.frameRate,
      };
    }
    const bytesReceived: Record<string, number> = {};
    for (const [name, bytes] of this.bytesReceived) bytesReceived[name] = bytes;
    this.bytesReceived.clear();
    this.post({ type: 'stats', tracks, bytesReceived });
  }

  public dispose(): void {
    if (this.disposed) return;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    for (const track of this.videoTracks.values()) track.feed.dispose();
    this.videoTracks.clear();
    this.session?.dispose();
    this.session = null;
    this.disposed = true;
    this.port.onmessage = null;
  }
}

function streamTypeOf(frameType: number | null | undefined): PipelineStreamType {
  if (frameType === FrameType.FRAME_TYPE_VIDEO) return 'video';
  if (frameType === FrameType.FRAME_TYPE_AUDIO) return 'audio';
  return 'data';
}

function headerSize(bytes: Uint8Array): number {
  if (bytes.byteLength < WIRE_PREFIX_SIZE) return 0;
  return new DataView(bytes.buffer, bytes.byteOffset, WIRE_PREFIX_SIZE).getUint32(0, true);
}

function hasSideData(media: unknown): boolean {
  if (!media || typeof media !== 'object') return false;
  const m = media as { sideData?: unknown[]; side_data?: unknown[] };
  return (m.sideData?.length ?? m.side_data?.length ?? 0) > 0;
}

export { ACK_BATCH };
