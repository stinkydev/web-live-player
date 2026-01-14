/**
 * Stream Source Interface - Core abstraction for receiving video/audio data
 * 
 * This interface allows the player to receive data from any transport:
 * - MoQSession (via adapter)
 * - WebSocket connections
 * - Custom protocols
 */

import type { ParsedData } from '../protocol/sesame-binary-protocol';

/**
 * Event data emitted when stream data is received
 */
export interface StreamDataEvent {
  trackName: string;
  streamType: 'video' | 'audio' | 'data';
  data: ParsedData;
}

/**
 * Handler type for stream data events
 */
export type StreamDataHandler = (event: StreamDataEvent) => void;

/**
 * Handler type for error events
 */
export type StreamErrorHandler = (error: Error) => void;

/**
 * Handler type for connection state events
 */
export type StreamConnectionHandler = () => void;

/**
 * Stream source event types
 */
export type StreamSourceEvent = 'data' | 'error' | 'connected' | 'disconnected';

/**
 * Interface for stream data sources.
 * Implement this interface to provide video/audio data to the player
 * from any transport mechanism.
 */
export interface IStreamSource {
  /**
   * Subscribe to stream events
   */
  on(event: 'data', handler: StreamDataHandler): void;
  on(event: 'error', handler: StreamErrorHandler): void;
  on(event: 'connected', handler: StreamConnectionHandler): void;
  on(event: 'disconnected', handler: StreamConnectionHandler): void;
  
  /**
   * Unsubscribe from stream events
   */
  off(event: StreamSourceEvent, handler: Function): void;
  
  /**
   * Current connection state (optional)
   */
  readonly connected?: boolean;
  
  /**
   * Request a keyframe from the stream (for live streams)
   */
  requestKeyframe?(): void;
  
  /**
   * Dispose the stream source and clean up resources
   */
  dispose?(): void;
}

/**
 * Base class for implementing stream sources with event handling
 */
export abstract class BaseStreamSource implements IStreamSource {
  protected handlers: Map<string, Set<Function>> = new Map();
  protected _connected: boolean = false;
  
  get connected(): boolean {
    return this._connected;
  }
  
  on(event: 'data', handler: StreamDataHandler): void;
  on(event: 'error', handler: StreamErrorHandler): void;
  on(event: 'connected', handler: StreamConnectionHandler): void;
  on(event: 'disconnected', handler: StreamConnectionHandler): void;
  on(event: StreamSourceEvent, handler: Function): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }
  
  off(event: StreamSourceEvent, handler: Function): void {
    this.handlers.get(event)?.delete(handler);
  }
  
  protected emit(event: 'data', data: StreamDataEvent): void;
  protected emit(event: 'error', error: Error): void;
  protected emit(event: 'connected' | 'disconnected'): void;
  protected emit(event: StreamSourceEvent, ...args: any[]): void {
    this.handlers.get(event)?.forEach(handler => handler(...args));
  }
  
  dispose(): void {
    this.handlers.clear();
  }
}
