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
import type { MoqSessionBroadcaster, MoQSessionConfig, BroadcastConfig, SessionStatus } from 'stinky-moq-js';
import { SessionState } from 'stinky-moq-js';

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
  /** Additional data tracks (e.g., for chat messages) */
  dataTracks?: MoQTrackConfig[];
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
  
  // Track current group for video (multiple frames can be in a group)
  private currentVideoGroup: boolean = true; // Start with needing a new group
  
  // Audio grouping: bundle 50 audio frames per group
  private audioFrameCount: number = 0;
  private static readonly AUDIO_FRAMES_PER_GROUP = 50;

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
      
      // Add any additional data tracks
      if (this.moqConfig.dataTracks) {
        for (const dataTrack of this.moqConfig.dataTracks) {
          broadcasts.push({
            trackName: dataTrack.trackName,
            priority: dataTrack.priority ?? 3,
            type: 'data',
          });
        }
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
    // Reset group state - next video frame needs a new group
    this.currentVideoGroup = true;
    this.audioFrameCount = 0;
  }

  send(packet: SerializedPacket): void {
    // Check session state before trying to send
    if (!this.session || !this._connected) {
      return;
    }

    const trackConfig = packet.type === 'video' 
      ? this.moqConfig.videoTrack 
      : this.moqConfig.audioTrack;

    if (!trackConfig) {
      return;
    }

    // Determine if this should start a new group
    // Video: new group on keyframe, then all delta frames belong to that group
    // Audio: each packet is its own group (matches working implementation)
    let newGroup: boolean;
    
    if (packet.type === 'video') {
      if (packet.isKeyframe) {
        // Keyframe starts a new group
        newGroup = true;
        this.currentVideoGroup = false; // Next frame will be in this group
      } else {
        // Delta frame: only start new group if we haven't had a keyframe yet
        newGroup = this.currentVideoGroup;
        if (newGroup) {
          // We're starting a group with a non-keyframe (shouldn't happen normally)
          this.currentVideoGroup = false;
        }
      }
    } else {
      // Audio: bundle 50 frames per group
      if (this.audioFrameCount % MoQCaptureSink.AUDIO_FRAMES_PER_GROUP === 0) {
        newGroup = true;
      } else {
        newGroup = false;
      }
      this.audioFrameCount++;
    }

    // Send data to MoQ session
    // Silently catch errors - they're expected during normal operation
    // (stream resets, subscriber disconnections, etc.)
    try {
      this.session.send(
        trackConfig.trackName,
        new Uint8Array(packet.data),
        newGroup
      );
    } catch {
      // Silently ignore send errors - this matches the working implementation
      // The session will handle reconnection internally
    }
  }

  private setupEventListeners(): void {
    if (!this.session) return;

    // Listen for track requests (when a new subscriber wants a track)
    // This is the correct event name from stinky-moq-js
    this.session.on('trackRequested', (trackName: string) => {
      if (trackName === this.moqConfig.videoTrack?.trackName) {
        // Reset video group state - next frame needs to start a new group
        this.currentVideoGroup = true;
        // Request a keyframe from the encoder
        this.requestKeyframe();
      }
    });

    // Listen for errors
    this.session.on('error', (error: Error) => {
      console.error('MoQ session error:', error);
      // Some errors may indicate we need to reset group state
      if (error.message?.includes('reset') || error.message?.includes('stream')) {
        this.currentVideoGroup = true;
      }
    });

    // Listen for state changes to keep _connected in sync
    this.session.on('stateChange', (status: SessionStatus) => {
      const wasConnected = this._connected;
      this._connected = status.state === SessionState.CONNECTED;
      
      // If we just disconnected, reset group state for reconnection
      if (wasConnected && !this._connected) {
        this.currentVideoGroup = true;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    super.dispose();
  }
  
  /**
   * Send custom data on a data track (e.g., chat messages)
   * Each data message starts a new group.
   * @param trackName The data track name to send on
   * @param data The data to send
   */
  sendData(trackName: string, data: Uint8Array): void {
    if (!this.session || !this._connected) {
      return;
    }
    
    try {
      // Data messages always start a new group
      this.session.send(trackName, data, true);
    } catch {
      // Silently ignore send errors
    }
  }
}

/**
 * Factory function to create a MoQ capture sink
 */
export function createMoQSink(config: MoQSinkConfig): MoQCaptureSink {
  return new MoQCaptureSink(config);
}
