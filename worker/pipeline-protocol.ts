/**
 * Messages between a pipeline worker and its client on the main thread.
 *
 * The worker owns the MoQ session and decodes the video tracks the client enables. Decoded
 * frames cross as transferred VideoFrames; the other tracks' wire frames cross as bytes for
 * the main thread to parse as it would have off the transport. Times cross as milliseconds
 * since the epoch, because each thread's performance.now() counts from its own origin.
 */

import type { ICatalog } from 'stinky-moq-js';
import type { PreferredDecoder } from '../types';

export type PipelineStreamType = 'video' | 'audio' | 'data';

export interface PipelineTrack {
  name: string;
  streamType?: PipelineStreamType;
}

export interface PipelineConnectConfig {
  relayUrl: string;
  namespace: string;
  /** The tracks to subscribe to, or with subscribeAll the per-track settings only. */
  tracks: PipelineTrack[];
  /** Subscribe to every track the publisher's catalog lists. */
  subscribeAll?: boolean;
  /** Initial delay between reconnection attempts in ms (default 3000). */
  reconnectionDelay?: number;
  debugLogging?: boolean;
}

export interface VideoTrackSettings {
  /** Decode the track in the worker and post its frames. */
  enabled: boolean;
  preferredDecoder?: PreferredDecoder;
}

export interface TrackStats {
  decoderState: string;
  decodeQueueSize: number;
  framesDecoded: number;
  /** Decoded frames closed in the worker because the main thread had not taken the earlier ones. */
  framesDropped: number;
  width: number;
  height: number;
  frameRate: number;
}

export type ToWorkerMessage =
  | { type: 'connect'; config: PipelineConnectConfig }
  | { type: 'video'; track: string; settings: VideoTrackSettings }
  | { type: 'flush'; track: string }
  | { type: 'request-keyframe'; track?: string }
  /** The main thread took this many posted frames of the track. */
  | { type: 'ack'; track: string; frames: number }
  | { type: 'debug-logging'; enabled: boolean }
  | { type: 'dispose' };

export type FromWorkerMessage =
  | { type: 'connected' }
  | { type: 'connect-failed'; message: string }
  | { type: 'state'; state: string; reconnectAttempts: number; lastError?: string }
  | { type: 'catalog'; catalog: ICatalog }
  | { type: 'subscription'; track: string; state: string; error?: string }
  | {
      type: 'frame';
      track: string;
      frame: VideoFrame;
      timestampUs: number;
      arrivalEpochMs: number;
      decodeEpochMs: number;
      isKeyframe: boolean;
    }
  /**
   * A wire frame of an audio or data track, whole; of a video track, its prefix and header
   * only (on keyframes and frames carrying side data), so the main thread sees codec and
   * side data changes without the payload.
   */
  | { type: 'data'; track: string; streamType: PipelineStreamType; bytes: Uint8Array; wireBytes: number }
  | { type: 'metadata'; track: string; width: number; height: number; codec: string }
  /** Per video track state, and the bytes received per track since the last stats message. */
  | { type: 'stats'; tracks: Record<string, TrackStats>; bytesReceived: Record<string, number> }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string };

/** What both ends post through: a Worker, a DedicatedWorkerGlobalScope or a MessagePort. */
export interface PipelinePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * Frames posted to the main thread and not yet acknowledged, per track, before the worker
 * closes new ones instead. A guard against a main thread that stopped taking frames, not
 * against a slow one: it sits above the scheduler's own capacity, so a stall the buffer would
 * have covered still costs nothing. While frames wait unclosed the decoder's output pool
 * holds it back, so the guard rarely engages.
 */
export const IN_FLIGHT_LIMIT = 64;
/** Frames the client takes between acknowledgements. */
export const ACK_BATCH = 4;
