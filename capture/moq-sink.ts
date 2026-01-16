/**
 * MoQ Capture Sink
 * 
 * Sends captured media data over MoQ (Media over QUIC) transport
 * using stinky-moq-js library.
 */

import {
  BaseCaptureSink,
  CaptureSinkConfig,
  SerializedPacket,
} from './capture-sink';
import type { MoqSessionBroadcaster, MoQSessionConfig, BroadcastConfig } from 'stinky-moq-js';

/**
 * Track configuration for MoQ publishing
 */
export interface MoQTrackConfig {
  trackName: string;
  priority?: number;
}

/**
 * MoQ-specific sink configuration
 */
export interface MoQSinkConfig extends CaptureSinkConfig {
  /** MoQ relay URL */
  relayUrl: string;
  /** Namespace for the streams */
  namespace: string;
  /** Video track configuration */
  videoTrack?: MoQTrackConfig;
  /** Audio track configuration */
  audioTrack?: MoQTrackConfig;
  /** Reconnection delay in ms */
  reconnectionDelay?: number;
}

/**
 * Capture sink that sends data over MoQ
 */
export class MoQCaptureSink extends BaseCaptureSink {
  private moqConfig: MoQSinkConfig;
  private session: MoqSessionBroadcaster | null = null;
  private connecting = false;
  private disposed = false;
  private audioGroupSequence = 0;
  private videoGroupSequence = 0;

  constructor(config: MoQSinkConfig) {
    super(config);
    this.moqConfig = config;
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Sink has been disposed');
    }

    if (this.session || this.connecting) {
      return;
    }

    this.connecting = true;

    try {
      // Dynamically import stinky-moq-js
      const { MoqSessionBroadcaster } = await import('stinky-moq-js');

      const sessionConfig: MoQSessionConfig = {
        relayUrl: this.moqConfig.relayUrl,
        namespace: this.moqConfig.namespace,
        reconnection: {
          delay: this.moqConfig.reconnectionDelay ?? 3000,
        },
      };

      // Build track configurations (BroadcastConfig requires 'type' field)
      const broadcasts: BroadcastConfig[] = [];
      
      if (this.moqConfig.videoTrack) {
        broadcasts.push({
          trackName: this.moqConfig.videoTrack.trackName,
          priority: this.moqConfig.videoTrack.priority ?? 1,
          type: 'video',
        });
      }
      
      if (this.moqConfig.audioTrack) {
        broadcasts.push({
          trackName: this.moqConfig.audioTrack.trackName,
          priority: this.moqConfig.audioTrack.priority ?? 2,
          type: 'audio',
        });
      }

      this.session = new MoqSessionBroadcaster(sessionConfig, broadcasts);

      // Setup event listeners
      this.setupEventListeners();

      await this.session.connect();
      this._connected = true;

    } catch (error) {
      this._connected = false;
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      this.session.dispose();
      this.session = null;
      this._connected = false;
    }
    this.audioGroupSequence = 0;
    this.videoGroupSequence = 0;
  }

  send(packet: SerializedPacket): void {
    if (!this.session || !this._connected) {
      return;
    }

    try {
      const trackConfig = packet.type === 'video' 
        ? this.moqConfig.videoTrack 
        : this.moqConfig.audioTrack;

      if (!trackConfig) {
        return;
      }

      // Determine if this should start a new group
      // Video: new group on keyframe
      // Audio: each packet is a new group
      let newGroup = false;
      if (packet.type === 'video') {
        if (packet.isKeyframe) {
          this.videoGroupSequence++;
          newGroup = true;
        }
      } else {
        this.audioGroupSequence++;
        newGroup = true;
      }

      // Send data to MoQ session
      this.session.send(
        trackConfig.trackName,
        new Uint8Array(packet.data),
        newGroup
      );
    } catch (err) {
      console.error('Failed to send MoQ packet:', err);
    }
  }

  private setupEventListeners(): void {
    if (!this.session) return;

    // Listen for new subscribers (to send keyframes)
    this.session.on('new-subscriber', (info: { trackName: string }) => {
      if (info.trackName === this.moqConfig.videoTrack?.trackName) {
        this.requestKeyframe();
      }
    });

    // Listen for errors
    this.session.on('error', (error: any) => {
      console.error('MoQ session error:', error);
    });

    // Listen for state changes
    this.session.on('stateChange', (status: any) => {
      if (status.state === 'disconnected') {
        this._connected = false;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}

/**
 * Factory function to create a MoQ capture sink
 */
export function createMoQSink(config: MoQSinkConfig): MoQCaptureSink {
  return new MoQCaptureSink(config);
}
