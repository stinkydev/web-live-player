/**
 * Base Player Class
 * 
 * Common functionality shared between LiveVideoPlayer and FileVideoPlayer:
 * - Event handling (on/off/emit)
 * - State management
 * - Logging configuration
 */

import type { Logger } from '../types';
import { consoleLogger, silentLogger } from '../types';

/**
 * Base player configuration
 */
export interface BasePlayerConfig {
  /** Enable debug logging */
  debugLogging?: boolean;
}

/**
 * Create a logger with configurable debug output
 */
export function createLogger(debugLogging: boolean): Logger {
  return {
    debug: debugLogging ? consoleLogger.debug : silentLogger.debug,
    info: consoleLogger.info,
    warn: consoleLogger.warn,
    error: consoleLogger.error,
  };
}

/**
 * Base class for video players providing common event handling and state management
 */
export abstract class BasePlayer<TState extends string> {
  protected eventHandlers: Map<string, Set<Function>> = new Map();
  protected logger: Logger;
  protected _state: TState;
  
  constructor(initialState: TState, debugLogging: boolean = false) {
    this._state = initialState;
    this.logger = createLogger(debugLogging);
  }
  
  /**
   * Current player state
   */
  get state(): TState {
    return this._state;
  }
  
  /**
   * Update player state and emit statechange event
   */
  protected setState(state: TState): void {
    if (this._state !== state) {
      const oldState = this._state;
      this._state = state;
      this.logger.debug(`State: ${oldState} -> ${state}`);
      this.emit('statechange', state);
    }
  }
  
  /**
   * Enable/disable debug logging
   */
  setDebugLogging(enabled: boolean): void {
    this.logger = createLogger(enabled);
  }
  
  /**
   * Subscribe to an event
   */
  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }
  
  /**
   * Unsubscribe from an event
   */
  off(event: string, handler: Function): void {
    this.eventHandlers.get(event)?.delete(handler);
  }
  
  /**
   * Emit an event to all subscribers
   */
  protected emit(event: string, ...args: any[]): void {
    this.eventHandlers.get(event)?.forEach(handler => handler(...args));
  }
  
  /**
   * Clear all event handlers (called during dispose)
   */
  protected clearEventHandlers(): void {
    this.eventHandlers.clear();
  }
  
  /**
   * Dispose the player and release resources
   */
  abstract dispose(): void;
}
