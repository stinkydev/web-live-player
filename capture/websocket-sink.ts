/**
 * WebSocket Capture Sink
 * 
 * Sends captured media data over a WebSocket connection.
 */

import {
  BaseCaptureSink,
  CaptureSinkConfig,
  SerializedPacket,
} from './capture-sink';

/**
 * WebSocket-specific sink configuration
 */
export interface WebSocketSinkConfig extends CaptureSinkConfig {
  /** WebSocket URL to connect to */
  url: string;
  /** Connection timeout in ms */
  connectionTimeout?: number;
  /** Whether to automatically reconnect on disconnect */
  autoReconnect?: boolean;
  /** Delay between reconnection attempts in ms */
  reconnectDelay?: number;
}

/**
 * Capture sink that sends data over WebSocket
 */
export class WebSocketCaptureSink extends BaseCaptureSink {
  private websocket?: WebSocket;
  private wsConfig: WebSocketSinkConfig;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(config: WebSocketSinkConfig) {
    super(config);
    this.wsConfig = config;
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Sink has been disposed');
    }

    return new Promise((resolve, reject) => {
      const timeout = this.wsConfig.connectionTimeout || 5000;
      let done = false;

      const timeoutId = setTimeout(() => {
        if (!done) {
          done = true;
          this.websocket?.close();
          reject(new Error('Connection timeout'));
        }
      }, timeout);

      try {
        this.websocket = new WebSocket(this.wsConfig.url);
        this.websocket.binaryType = 'arraybuffer';

        this.websocket.onopen = () => {
          if (!done) {
            done = true;
            clearTimeout(timeoutId);
            this._connected = true;
            resolve();
          }
        };

        this.websocket.onclose = () => {
          this._connected = false;
          if (!done) {
            done = true;
            clearTimeout(timeoutId);
            reject(new Error('WebSocket closed'));
          } else if (!this.disposed && this.wsConfig.autoReconnect) {
            this.scheduleReconnect();
          }
        };

        this.websocket.onerror = () => {
          if (!done) {
            done = true;
            clearTimeout(timeoutId);
            reject(new Error('WebSocket connection error'));
          }
        };

        this.websocket.onmessage = (event) => {
          // Handle keyframe requests from server
          if (typeof event.data === 'string') {
            const msg = event.data;
            if (msg === 'keyframe' || msg.includes('keyframe')) {
              this.requestKeyframe();
            }
          }
        };
      } catch (err) {
        done = true;
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    
    if (this.websocket) {
      this.websocket.onclose = null;
      this.websocket.onerror = null;
      this.websocket.onmessage = null;
      this.websocket.close();
      this.websocket = undefined;
    }
    
    this._connected = false;
  }

  send(packet: SerializedPacket): void {
    if (!this.connected || !this.websocket) {
      return;
    }

    try {
      this.websocket.send(packet.data);
    } catch (err) {
      console.error('Failed to send packet:', err);
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return;
    }

    const delay = this.wsConfig.reconnectDelay || 3000;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (!this.disposed) {
        try {
          await this.connect();
        } catch (err) {
          console.error('Reconnection failed:', err);
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    super.dispose();
  }
}

/**
 * Factory function to create a WebSocket capture sink
 */
export function createWebSocketSink(config: WebSocketSinkConfig): WebSocketCaptureSink {
  return new WebSocketCaptureSink(config);
}
