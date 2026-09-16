/**
 * MoQ Source
 * 
 * A self-contained MoQ stream source that doesn't require Elmo's node system.
 * Uses stinky-moq-js directly to connect to MoQ relays.
 */

import { BaseStreamSource } from './stream-source';

import type { MoQSessionConfig, SubscriptionConfig, MoqSessionSubscriber, SessionStatus } from 'stinky-moq-js';
import { SessionState } from 'stinky-moq-js';

/**
 * Track configuration for MoQ source
 */
export interface MoQTrack {
  trackName: string;
  priority?: number;
  streamType: 'video' | 'audio' | 'data';
}

/**
 * Configuration for MoQ source
 */
export interface MoQSourceConfig {
  relayUrl: string;
  namespace: string;
  subscriptions: MoQTrack[];
  reconnectionDelay?: number;
}

/**
 * Factory function to create a MoQ source
 */
export function createMoQSource(config: MoQSourceConfig): MoQSource {
  return new MoQSource(config);
}

/**
 * MoQ stream source implementation
 */
export class MoQSource extends BaseStreamSource {
  private config: MoQSourceConfig;
  private session: MoqSessionSubscriber | null = null;
  private trackTypeMap: Map<string, 'video' | 'audio' | 'data'> = new Map();
  private connecting: boolean = false;
  
  constructor(config: MoQSourceConfig) {
    super();
    this.config = config;
    
    // Build track type map for data handling
    for (const track of config.subscriptions) {
      this.trackTypeMap.set(track.trackName, track.streamType);
    }
  }
  
  /**
   * Connect to the MoQ relay
   */
  async connect(): Promise<void> {
    if (this.session || this.connecting) {
      return;
    }
    
    this.connecting = true;
    
    try {
      // Dynamically import stinky-moq-js to avoid bundling issues
      const { MoqSessionSubscriber } = await import('stinky-moq-js');
      
      const sessionConfig: MoQSessionConfig = {
        relayUrl: this.config.relayUrl,
        namespace: this.config.namespace,
        reconnection: {
          delay: this.config.reconnectionDelay ?? 3000,
        },
      };
      
      const subscriptions: SubscriptionConfig[] = this.config.subscriptions.map(t => ({
        trackName: t.trackName,
        priority: t.priority ?? 0,
        retry: { delay: 2000 },
      }));
      
      this.session = new MoqSessionSubscriber(sessionConfig, subscriptions);

      // Setup event listeners
      this.setupEventListeners();

      // Resolves once the relay is reached; the session keeps retrying on its own until
      // then, and rejects only if disconnect() disposes it first. The state listener
      // above emits 'connected'.
      await this.session.connect();

    } catch (error) {
      this._connected = false;
      if (this.session) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Disconnect from the MoQ relay
   */
  async disconnect(): Promise<void> {
    if (this.session) {
      this.session.dispose();
      this.session = null;
      this._connected = false;
      this.emit('disconnected');
    }
  }
  
  private setupEventListeners(): void {
    if (!this.session) return;
    
    // Listen for incoming data
    this.session.on('data', (trackName: string, data: Uint8Array) => {
      this.handleIncomingData(trackName, data);
    });
    
    // Listen for errors
    this.session.on('error', (error: any) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });
    
    // Mirror the session state. The session reconnects on its own, so a drop shows up as
    // 'reconnecting' and a recovery as another 'connected'.
    this.session.on('stateChange', (status: SessionStatus) => {
      const connected = status.state === SessionState.CONNECTED;
      if (connected === this._connected) return;
      this._connected = connected;
      this.emit(connected ? 'connected' : 'disconnected');
    });
  }
  
  private handleIncomingData(trackName: string, data: Uint8Array): void {
    this.parseAndEmitStreamData(trackName, data);
  }
  
  dispose(): void {
    this.disconnect();
    super.dispose();
  }
}
