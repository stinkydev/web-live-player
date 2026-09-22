/**
 * The main thread's handle on a pipeline worker.
 *
 * Decoded frames of a video track go to the one consumer that subscribed to it, with the
 * worker's times moved onto this thread's performance.now(). Audio and data frames come out
 * of `source`, an IStreamSource, parsed as they would have been off the transport; a video
 * track's headers come out of it too, with an empty payload.
 */

import { BaseStreamSource } from '../sources/stream-source';
import type { Logger } from '../types';
import { consoleLogger } from '../types';
import {
  ACK_BATCH, FromWorkerMessage, PipelineConnectConfig, PipelinePort, ToWorkerMessage, TrackStats, VideoTrackSettings,
} from './pipeline-protocol';
// Inlined into the library as a blob: the worker bundles the MoQ and Sesame libraries, and a
// consumer serves no worker file of its own.
import PipelineWorker from './pipeline.worker.ts?worker&inline';

export type VideoFrameHandler = (frame: VideoFrame, timestampUs: number, arrivalTime: number, decodeTime: number, isKeyframe: boolean) => void;

export interface VideoTrackHandlers {
  /** The callee owns the frame. */
  onFrame: VideoFrameHandler;
  onMetadata?(metadata: { width: number; height: number; codec: string }): void;
}

export type PipelineClientEvents = {
  connected: () => void;
  disconnected: () => void;
  /** The session's state, as the MoQ library reports it (connected, reconnecting, ...). */
  state: (state: string, reconnectAttempts: number, lastError?: string) => void;
  catalog: (catalog: import('stinky-moq-js').ICatalog) => void;
  subscription: (track: string, state: string, error?: string) => void;
  /** Per video track stats, and bytes received per track since the previous event. */
  stats: (tracks: Record<string, TrackStats>, bytesReceived: Record<string, number>) => void;
  error: (error: Error) => void;
};

/** A Worker, or anything else with its posting surface, for a client to drive. */
export interface PipelineWorkerLike extends PipelinePort {
  terminate?(): void;
}

/** The audio, data and video header frames of the pipeline's tracks, as an IStreamSource. */
export class WorkerStreamSource extends BaseStreamSource {
  constructor(private client: PipelineClient) {
    super();
  }

  requestKeyframe(): void {
    this.client.requestKeyframe();
  }

  /** @internal */
  deliver(trackName: string, bytes: Uint8Array, wireBytes: number): void {
    this.parseAndEmitStreamData(trackName, bytes, wireBytes);
  }

  /** @internal */
  setConnected(connected: boolean): void {
    if (this._connected === connected) return;
    this._connected = connected;
    this.emit(connected ? 'connected' : 'disconnected');
  }

  /** @internal */
  fail(error: Error): void {
    this.emit('error', error);
  }
}

export class PipelineClient {
  public readonly source: WorkerStreamSource;
  private handlers = new Map<string, Set<Function>>();
  private videoHandlers = new Map<string, VideoTrackHandlers>();
  private stats = new Map<string, TrackStats>();
  private pendingAcks = new Map<string, number>();
  private connectWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private logger: Logger;
  private disposed = false;

  /** Spawns the pipeline worker. */
  static create(options: { logger?: Logger } = {}): PipelineClient {
    const worker = new PipelineWorker();
    // A Worker's onmessage takes a MessageEvent; the port type asks only for its data
    return new PipelineClient(worker as unknown as PipelineWorkerLike, options);
  }

  constructor(private worker: PipelineWorkerLike, options: { logger?: Logger } = {}) {
    this.logger = options.logger ?? consoleLogger;
    this.source = new WorkerStreamSource(this);
    worker.onmessage = (event) => this.handle(event.data as FromWorkerMessage);
  }

  /** Resolves once the relay is reached; the session keeps retrying on its own until then. */
  connect(config: PipelineConnectConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
      this.post({ type: 'connect', config });
    });
  }

  /** Decode a video track in the worker (or stop), and pick its decoder. */
  setVideo(track: string, settings: VideoTrackSettings): void {
    this.post({ type: 'video', track, settings });
  }

  flush(track: string): void {
    this.post({ type: 'flush', track });
  }

  requestKeyframe(track?: string): void {
    this.post({ type: 'request-keyframe', track });
  }

  setDebugLogging(enabled: boolean): void {
    this.post({ type: 'debug-logging', enabled });
  }

  /**
   * Take the decoded frames of a video track. One consumer per track: a frame has one owner.
   * Returns the unsubscribe; frames of a track nobody takes are closed on arrival.
   */
  subscribeVideo(track: string, handlers: VideoTrackHandlers): () => void {
    if (this.videoHandlers.has(track)) {
      this.logger.warn(`Pipeline: video track "${track}" already has a consumer; replacing it`);
    }
    this.videoHandlers.set(track, handlers);
    return () => {
      if (this.videoHandlers.get(track) === handlers) this.videoHandlers.delete(track);
    };
  }

  /** The last reported stats of a video track. */
  trackStats(track: string): TrackStats | undefined {
    return this.stats.get(track);
  }

  on<K extends keyof PipelineClientEvents>(event: K, handler: PipelineClientEvents[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<K extends keyof PipelineClientEvents>(event: K, handler: PipelineClientEvents[K]): void {
    this.handlers.get(event)?.delete(handler);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.post({ type: 'dispose' });
    this.worker.onmessage = null;
    this.worker.terminate?.();
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w.reject(new Error('pipeline disposed'));
    this.videoHandlers.clear();
    this.handlers.clear();
    this.source.setConnected(false);
    this.source.dispose();
  }

  private post(message: ToWorkerMessage): void {
    if (this.disposed && message.type !== 'dispose') return;
    this.worker.postMessage(message);
  }

  private emit<K extends keyof PipelineClientEvents>(event: K, ...args: Parameters<PipelineClientEvents[K]>): void {
    this.handlers.get(event)?.forEach(handler => handler(...args));
  }

  private handle(message: FromWorkerMessage): void {
    if (this.disposed) return;
    switch (message.type) {
      case 'frame': {
        const handlers = this.videoHandlers.get(message.track);
        if (handlers) {
          // The worker's times are on the epoch; this thread counts from its own origin.
          const origin = performance.timeOrigin;
          handlers.onFrame(message.frame, message.timestampUs, message.arrivalEpochMs - origin, message.decodeEpochMs - origin, message.isKeyframe);
        } else {
          message.frame.close();
        }
        this.ack(message.track);
        break;
      }
      case 'data':
        this.source.deliver(message.track, message.bytes, message.wireBytes);
        break;
      case 'metadata':
        this.videoHandlers.get(message.track)?.onMetadata?.({ width: message.width, height: message.height, codec: message.codec });
        break;
      case 'stats':
        for (const [track, stats] of Object.entries(message.tracks)) this.stats.set(track, stats);
        this.emit('stats', message.tracks, message.bytesReceived);
        break;
      case 'state': {
        const connected = message.state === 'connected';
        this.source.setConnected(connected);
        this.emit('state', message.state, message.reconnectAttempts, message.lastError);
        this.emit(connected ? 'connected' : 'disconnected');
        break;
      }
      case 'connected': {
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        for (const w of waiters) w.resolve();
        break;
      }
      case 'connect-failed': {
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        for (const w of waiters) w.reject(new Error(message.message));
        break;
      }
      case 'catalog':
        this.emit('catalog', message.catalog);
        break;
      case 'subscription':
        this.emit('subscription', message.track, message.state, message.error);
        break;
      case 'log':
        this.logger[message.level](message.message);
        break;
      case 'error': {
        const error = new Error(message.message);
        this.emit('error', error);
        this.source.fail(error);
        break;
      }
    }
  }

  private ack(track: string): void {
    const pending = (this.pendingAcks.get(track) ?? 0) + 1;
    if (pending >= ACK_BATCH) {
      this.pendingAcks.set(track, 0);
      this.post({ type: 'ack', track, frames: pending });
    } else {
      this.pendingAcks.set(track, pending);
    }
  }
}
