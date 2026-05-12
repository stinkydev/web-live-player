import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketSource } from './websocket-source';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

describe('WebSocketSource dispose/disconnect', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = (globalThis as any).window;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as any).WebSocket = MockWebSocket as any;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        location: {
          protocol: 'http:',
          host: 'localhost',
        },
      },
    });
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    vi.restoreAllMocks();
  });

  it('dispose closes websocket and releases handlers/reference', async () => {
    const source = new WebSocketSource({ url: 'ws://localhost/test' });

    const connected = source.connect();
    const socket = MockWebSocket.instances[0];
    expect(socket).toBeTruthy();

    socket.onopen?.({} as Event);
    await connected;

    source.dispose();

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect((source as any).webSocket).toBeNull();
    expect(source.connected).toBe(false);
  });

  it('server close clears socket reference', async () => {
    const source = new WebSocketSource({ url: 'ws://localhost/test' });

    const connected = source.connect();
    const socket = MockWebSocket.instances[0];
    socket.onopen?.({} as Event);
    await connected;

    socket.onclose?.({} as CloseEvent);

    expect((source as any).webSocket).toBeNull();
    expect(source.connected).toBe(false);
  });
});
