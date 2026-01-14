/**
 * BasePlayer Tests
 * 
 * Tests for the shared player base class functionality:
 * - Event handling (on/off/emit)
 * - State management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BasePlayer } from './base-player';

// Concrete implementation for testing
type TestState = 'idle' | 'active' | 'error';

class TestPlayer extends BasePlayer<TestState> {
  constructor(debugLogging = false) {
    super('idle', debugLogging);
  }
  
  // Expose protected methods for testing
  public testSetState(state: TestState): void {
    this.setState(state);
  }
  
  public testEmit(event: string, ...args: any[]): void {
    this.emit(event, ...args);
  }
  
  dispose(): void {
    this.clearEventHandlers();
    this.setState('idle');
  }
}

describe('BasePlayer', () => {
  let player: TestPlayer;
  
  beforeEach(() => {
    player = new TestPlayer();
  });
  
  describe('State Management', () => {
    it('should initialize with provided state', () => {
      expect(player.state).toBe('idle');
    });
    
    it('should update state via setState', () => {
      player.testSetState('active');
      expect(player.state).toBe('active');
    });
    
    it('should emit statechange event when state changes', () => {
      const handler = vi.fn();
      player.on('statechange', handler);
      
      player.testSetState('active');
      
      expect(handler).toHaveBeenCalledWith('active');
      expect(handler).toHaveBeenCalledTimes(1);
    });
    
    it('should not emit statechange when state is unchanged', () => {
      const handler = vi.fn();
      player.on('statechange', handler);
      
      player.testSetState('idle'); // Same as initial
      
      expect(handler).not.toHaveBeenCalled();
    });
  });
  
  describe('Event Handling', () => {
    it('should register and call event handlers', () => {
      const handler = vi.fn();
      player.on('customEvent', handler);
      
      player.testEmit('customEvent', 'arg1', 'arg2');
      
      expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
    });
    
    it('should support multiple handlers for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      
      player.on('customEvent', handler1);
      player.on('customEvent', handler2);
      
      player.testEmit('customEvent', 'data');
      
      expect(handler1).toHaveBeenCalledWith('data');
      expect(handler2).toHaveBeenCalledWith('data');
    });
    
    it('should remove handler via off()', () => {
      const handler = vi.fn();
      player.on('customEvent', handler);
      player.off('customEvent', handler);
      
      player.testEmit('customEvent', 'data');
      
      expect(handler).not.toHaveBeenCalled();
    });
    
    it('should only remove specified handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      
      player.on('customEvent', handler1);
      player.on('customEvent', handler2);
      player.off('customEvent', handler1);
      
      player.testEmit('customEvent', 'data');
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith('data');
    });
    
    it('should handle events with no handlers gracefully', () => {
      // Should not throw
      expect(() => player.testEmit('unknownEvent', 'data')).not.toThrow();
    });
    
    it('should clear all handlers on dispose', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      
      player.on('event1', handler1);
      player.on('event2', handler2);
      
      player.dispose();
      
      player.testEmit('event1', 'data');
      player.testEmit('event2', 'data');
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });
  
  describe('Logging', () => {
    it('should respect debug logging setting', () => {
      const debugPlayer = new TestPlayer(true);
      // Just verify it doesn't throw - actual logging behavior is internal
      expect(() => debugPlayer.testSetState('active')).not.toThrow();
    });
    
    it('should allow changing debug logging at runtime', () => {
      expect(() => {
        player.setDebugLogging(true);
        player.testSetState('active');
        player.setDebugLogging(false);
        player.testSetState('idle');
      }).not.toThrow();
    });
  });
});
