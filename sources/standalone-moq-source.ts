/**
 * Standalone MoQ Source
 * 
 * A self-contained MoQ stream source that doesn't require Elmo's node system.
 * Uses stinky-moq-js directly to connect to MoQ relays.
 */

import { BaseStreamSource, StreamDataEvent } from './stream-source';
import { SesameBinaryProtocol } from '../protocol/sesame-binary-protocol';
import type { MoQSessionConfig, SubscriptionConfig, MoqSessionSubscriber } from 'stinky-moq-js';

/**
 * Track configuration for standalone MoQ source
 */
export interface StandaloneMoQTrack {
  trackName: string;
  priority?: number;
  streamType: 'video' | 'audio' | 'data';
}

/**
 * Configuration for standalone MoQ source
 */
export interface StandaloneMoQConfig {
  relayUrl: string;
  namespace: string;
  subscriptions: StandaloneMoQTrack[];
  reconnectionDelay?: number;
}

/**
 * Factory function to create a standalone MoQ source
 */
export function createStandaloneMoQSource(config: StandaloneMoQConfig): StandaloneMoQSource {
  return new StandaloneMoQSource(config);
}

/**
 * Standalone MoQ stream source implementation
 */
export class StandaloneMoQSource extends BaseStreamSource {
  private config: StandaloneMoQConfig;
  private session: MoqSessionSubscriber | null = null;
  private trackTypeMap: Map<string, 'video' | 'audio' | 'data'> = new Map();
  private connecting: boolean = false;
  
  constructor(config: StandaloneMoQConfig) {
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
      
      await this.session.connect();
      this._connected = true;
      this.emit('connected');
      
    } catch (error) {
      this._connected = false;
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
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
    
    // Listen for state changes
    this.session.on('stateChange', (status: any) => {
      if (status.state === 'disconnected') {
        this._connected = false;
        this.emit('disconnected');
      }
    });
  }
  
  private handleIncomingData(trackName: string, data: Uint8Array): void {
    const streamType = this.trackTypeMap.get(trackName) || 'data';
    
    if (streamType === 'video' || streamType === 'audio') {
      // Parse binary protocol for video/audio
      try {
        const parsedData = SesameBinaryProtocol.parseData(data);
        
        if (!parsedData.valid) {
          console.warn(`Invalid ${streamType} packet format for track ${trackName}`);
          return;
        }
        
        const event: StreamDataEvent = {
          trackName,
          streamType,
          data: parsedData,
        };
        
        this.emit('data', event);
      } catch (error) {
        console.error(`Failed to parse ${streamType} packet:`, error);
      }
    } else {
      // For data streams, create a minimal parsed data structure
      const event: StreamDataEvent = {
        trackName,
        streamType: 'data',
        data: {
          valid: true,
          header: null,
          metadata: null,
          codec_data: null,
          payload: data,
          payload_size: data.length,
        },
      };
      
      this.emit('data', event);
    }
  }
  
  dispose(): void {
    this.disconnect();
    super.dispose();
  }
}
