/**
 * WebSocket Stream Source
 * 
 * Implements IStreamSource for WebSocket-based video streaming.
 * Uses the Sesame Binary Protocol for parsing video/audio frames.
 */

import { BaseStreamSource, StreamDataEvent } from './stream-source';
import { SesameBinaryProtocol, PacketType } from '../protocol/sesame-binary-protocol';

const REQUEST_TIMEOUT_MS = 5000;
const MIN_KEYFRAME_REQUEST_INTERVAL_MS = 1000;

/**
 * Configuration for WebSocket stream source
 */
export interface WebSocketSourceConfig {
  /** WebSocket URL (ws:// or wss://) */
  url?: string;
  /** Auto-construct URL from current page location */
  useCurrentHost?: boolean;
  /** API path for video endpoint */
  apiPath?: string;
  /** Client ID for the connection */
  clientId?: string;
  /** Connection timeout in milliseconds */
  timeout?: number;
  /** Enable automatic reconnection */
  autoReconnect?: boolean;
  /** Reconnection delay in milliseconds */
  reconnectDelay?: number;
}

/**
 * Video metadata returned from the server
 */
export interface VideoMetadata {
  width: number;
  height: number;
  frameRate?: number;
  duration?: number;
  codec?: string;
}

interface MessageWaiter {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  id: number;
  timeout: number;
}

interface Command {
  id?: number;
  type: 'load' | 'seek' | 'read' | 'live' | 'unload' | 'keyframe';
  paramNum?: number;
  filename?: string;
  project?: string;
}

interface Response {
  id: number;
  data?: any;
  error?: string;
}

/**
 * WebSocket-based stream source for live and file-based video playback.
 * 
 * @example
 * ```typescript
 * const source = new WebSocketSource({ useCurrentHost: true });
 * await source.connect();
 * await source.loadLive('my-stream');
 * 
 * source.on('data', (event) => {
 *   if (event.streamType === 'video') {
 *     // Handle video frame
 *   }
 * });
 * ```
 */
export class WebSocketSource extends BaseStreamSource {
  private webSocket: WebSocket | null = null;
  private messageWaiters: MessageWaiter[] = [];
  private requestId: number = 0;
  private timeoutCheckInterval: number | null = null;
  private ignoreCmdsBelow = 0;
  private isLiveStream: boolean = false;
  private config: Required<WebSocketSourceConfig>;
  private lastKeyframeRequest: number = 0;
  private currentTrackName: string = 'default';
  private reconnectTimeout: number | null = null;
  private disposed: boolean = false;

  constructor(config: WebSocketSourceConfig = {}) {
    super();
    
    this.config = {
      url: config.url || '',
      useCurrentHost: config.useCurrentHost ?? true,
      apiPath: config.apiPath || '/api/video',
      clientId: config.clientId || 'video-player',
      timeout: config.timeout || REQUEST_TIMEOUT_MS,
      autoReconnect: config.autoReconnect ?? false,
      reconnectDelay: config.reconnectDelay || 3000,
    };
  }

  /**
   * Get the WebSocket URL based on configuration
   */
  private getWebSocketUrl(): string {
    if (this.config.url) {
      return this.config.url;
    }

    if (this.config.useCurrentHost && typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}${this.config.apiPath}?id=${this.config.clientId}`;
    }

    throw new Error('WebSocket URL not configured. Provide url or enable useCurrentHost.');
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const url = this.getWebSocketUrl();
      let connectionResolved = false;

      try {
        this.webSocket = new WebSocket(url);
        this.webSocket.binaryType = 'arraybuffer';

        // Start timeout checker
        this.startTimeoutChecker();

        this.webSocket.onopen = () => {
          if (connectionResolved) return;
          connectionResolved = true;
          this._connected = true;
          this.emit('connected');
          resolve();
        };

        this.webSocket.onmessage = (event) => {
          this.handleMessage(event);
        };

        this.webSocket.onclose = () => {
          const wasConnected = this._connected;
          this._connected = false;
          
          if (!connectionResolved) {
            connectionResolved = true;
            reject(new Error('WebSocket connection closed'));
          }
          
          if (wasConnected) {
            this.emit('disconnected');
            this.handleDisconnect();
          }
        };

        this.webSocket.onerror = (_error) => {
          if (!connectionResolved) {
            connectionResolved = true;
            reject(new Error('WebSocket connection error'));
          }
          this.emit('error', new Error('WebSocket error'));
        };

        // Connection timeout
        setTimeout(() => {
          if (!connectionResolved) {
            connectionResolved = true;
            this.webSocket?.close();
            reject(new Error('Connection timeout'));
          }
        }, this.config.timeout);

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.stopReconnect();
    
    if (this.webSocket) {
      this.webSocket.close();
      this.webSocket = null;
    }
    
    this._connected = false;
    this.stopTimeoutChecker();
    this.clearWaiters();
  }

  /**
   * Load a live stream by ID
   */
  async loadLive(streamId: string): Promise<VideoMetadata> {
    this.isLiveStream = true;
    this.currentTrackName = streamId;
    this.ignoreCmdsBelow = this.requestId;
    return this.request({ type: 'live', filename: streamId });
  }

  /**
   * Load a video file
   */
  async loadFile(project: string, filename: string): Promise<VideoMetadata> {
    this.isLiveStream = false;
    this.currentTrackName = filename;
    this.ignoreCmdsBelow = this.requestId;
    return this.request({ type: 'load', filename, project });
  }

  /**
   * Seek to a position in the video (file playback only)
   */
  async seek(positionMs: number): Promise<void> {
    if (this.isLiveStream) {
      throw new Error('Cannot seek in live stream');
    }
    return this.request({ type: 'seek', paramNum: positionMs });
  }

  /**
   * Request more packets from the server (file playback)
   */
  async read(packetCount: number): Promise<void> {
    return this.request({ type: 'read', paramNum: packetCount });
  }

  /**
   * Unload the current stream
   */
  async unload(): Promise<void> {
    this.isLiveStream = false;
    return this.request({ type: 'unload' });
  }

  /**
   * Request a keyframe (live streams only)
   */
  requestKeyframe(): void {
    if (!this.isLiveStream) {
      console.warn('Keyframe request ignored: not a live stream');
      return;
    }

    const now = Date.now();
    if (now - this.lastKeyframeRequest < MIN_KEYFRAME_REQUEST_INTERVAL_MS) {
      return; // Throttle keyframe requests
    }

    this.lastKeyframeRequest = now;
    this.request({ type: 'keyframe' }).catch(() => {
      // Ignore errors for keyframe requests
    });
  }

  /**
   * Flush pending requests (useful when seeking)
   */
  flush(): void {
    this.ignoreCmdsBelow = this.requestId;
  }

  /**
   * Dispose the stream source
   */
  override dispose(): void {
    this.disposed = true;
    this.disconnect();
    super.dispose();
  }

  // Private methods

  private async request(cmd: Command): Promise<any> {
    if (!this._connected || !this.webSocket) {
      throw new Error('Not connected to WebSocket server');
    }

    cmd.id = this.requestId++;
    this.webSocket.send(JSON.stringify(cmd));
    return this.waitForResponse(cmd.id);
  }

  private waitForResponse(id: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.messageWaiters.push({
        resolve,
        reject,
        id,
        timeout: Date.now() + this.config.timeout,
      });
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === 'string') {
      // JSON response
      try {
        const response: Response = JSON.parse(event.data);
        this.handleResponse(response);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    } else if (event.data instanceof ArrayBuffer) {
      // Binary data (video/audio frame)
      this.handleBinaryData(event.data);
    }
  }

  private handleResponse(response: Response): void {
    // Server broadcast message (id = -1)
    if (response.id === -1) {
      if (response.error) {
        this.emit('error', new Error(response.error));
      }
      return;
    }

    // Find and resolve waiting promise
    const waiterIndex = this.messageWaiters.findIndex(w => w.id === response.id);
    if (waiterIndex !== -1) {
      const waiter = this.messageWaiters[waiterIndex];
      this.messageWaiters.splice(waiterIndex, 1);

      if (response.error) {
        waiter.reject(new Error(response.error));
      } else {
        waiter.resolve(response.data);
      }
    }
  }

  private handleBinaryData(data: ArrayBuffer): void {
    const dataArray = new Uint8Array(data);
    const parsedData = SesameBinaryProtocol.parseData(dataArray);

    if (!parsedData.valid || !parsedData.header) {
      console.warn('Invalid binary packet received');
      return;
    }

    // Skip outdated packets for file playback
    if (!this.isLiveStream && parsedData.header.id !== undefined) {
      if (Number(parsedData.header.id) < this.ignoreCmdsBelow) {
        return;
      }
    }

    // Determine stream type from packet type
    let streamType: 'video' | 'audio' | 'data' = 'data';
    if (parsedData.header.type === PacketType.VIDEO_FRAME) {
      streamType = 'video';
    } else if (parsedData.header.type === PacketType.AUDIO_FRAME) {
      streamType = 'audio';
    }

    // Emit data event
    const event: StreamDataEvent = {
      trackName: this.currentTrackName,
      streamType,
      data: parsedData,
    };

    this.emit('data', event);
  }

  private handleDisconnect(): void {
    this.clearWaiters();

    if (this.config.autoReconnect && !this.disposed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.stopReconnect();
    
    this.reconnectTimeout = window.setTimeout(async () => {
      try {
        await this.connect();
        // Optionally reload the stream
        if (this.isLiveStream && this.currentTrackName) {
          await this.loadLive(this.currentTrackName);
        }
      } catch (err) {
        // Retry reconnection
        this.scheduleReconnect();
      }
    }, this.config.reconnectDelay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private startTimeoutChecker(): void {
    this.stopTimeoutChecker();
    
    this.timeoutCheckInterval = window.setInterval(() => {
      const now = Date.now();
      const timedOut = this.messageWaiters.filter(w => w.timeout <= now);
      
      timedOut.forEach(waiter => {
        waiter.reject(new Error('Request timeout'));
        const index = this.messageWaiters.indexOf(waiter);
        if (index !== -1) {
          this.messageWaiters.splice(index, 1);
        }
      });
    }, 1000);
  }

  private stopTimeoutChecker(): void {
    if (this.timeoutCheckInterval !== null) {
      clearInterval(this.timeoutCheckInterval);
      this.timeoutCheckInterval = null;
    }
  }

  private clearWaiters(): void {
    this.messageWaiters.forEach(waiter => {
      waiter.reject(new Error('Connection closed'));
    });
    this.messageWaiters = [];
  }
}

/**
 * Factory function to create a WebSocket stream source
 */
export function createWebSocketSource(config?: WebSocketSourceConfig): WebSocketSource {
  return new WebSocketSource(config);
}
