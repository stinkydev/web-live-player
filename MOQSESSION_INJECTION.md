# MoQ Session Injection

This document explains how to inject external MoQ session instances into both the Capture system and LiveVideoPlayer, enabling advanced use cases like shared sessions and custom MoQ implementations.

## Overview

Both the capture system and player support flexible MoQ session injection:

**Capture System** - Two ways to work with MoQ sessions:

1. **Automatic Session Creation** (default): The `MoQCaptureSink` creates and manages its own `MoqSessionBroadcaster` instance
2. **Session Injection**: Provide an existing `MoqSessionBroadcaster` instance that is shared across multiple components

**LiveVideoPlayer** - Multiple ways to connect to MoQ streams:
1. **Direct Relay Connection**: Automatically creates a `MoQSource` and connects to a MoQ relay
2. **Stream Source Injection**: Inject any `IStreamSource` implementation (e.g., Elmo's `MoQSessionNode`)
3. **MoQ Session Injection**: Convenience method for MoQ-compatible sources

## Use Cases

Session injection is useful when:
- You want to share a single MoQ connection between capture and playback
- You're using a framework like Elmo that provides its own MoQ session instances
- You need fine-grained control over the MoQ session lifecycle
- You want to broadcast and subscribe on the same connection
- You have a custom MoQ implementation that implements `IStreamSource`

---

# Capture System: MoQ Session Injection

## Method 1: Inject During Sink Creation

Pass the session directly in the configuration:

```typescript
import { MoqSessionBroadcaster } from 'stinky-moq-js';
import { createMoQSink, createMediaCapture } from 'web-live-player';

// Create your own MoQ session
const broadcasts = [
  { trackName: 'video', priority: 1, type: 'video' },
  { trackName: 'audio', priority: 2, type: 'audio' }
];

const session = new MoqSessionBroadcaster(
  { relayUrl: 'https://relay.example.com/moq', namespace: 'my-stream' },
  broadcasts
);

await session.connect();

// Create sink with injected session
const sink = createMoQSink({
  session: session,  // Inject the session
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' }
});

// Create capture with the sink
const capture = createMediaCapture({
  sink: sink,
  video: true,
  audio: true,
  videoEncoder: { codec: 'vp9', bitrate: 2000000 },
  audioEncoder: { codec: 'opus', bitrate: 128000 }
});

// Start capturing
await capture.start();
```

**Important**: When using an injected session, you don't need to provide `relayUrl` or `namespace` in the sink config.

## Method 2: Inject After Creation

Use the `setMoQSession()` method:

```typescript
// Create sink without a session initially
const sink = createMoQSink({
  relayUrl: 'https://relay.example.com/moq',  // Will be ignored later
  namespace: 'my-stream',
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' }
});

// Later, inject your session
const session = new MoqSessionBroadcaster(/* ... */);
await session.connect();
sink.setMoQSession(session);

// Create capture
const capture = createMediaCapture({ sink, video: true, audio: true });
await capture.start();
```

## Method 3: Inject Through MediaCapture

You can also inject the session through the `MediaCapture` instance:

```typescript
const sink = createMoQSink({
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' }
});

const capture = createMediaCapture({ sink, video: true, audio: true });

// Inject session through MediaCapture
const session = new MoqSessionBroadcaster(/* ... */);
await session.connect();
capture.setMoQSession(session);

await capture.start();
```

## Session Lifecycle Management

### Owned vs Injected Sessions

- **Owned Session**: Created by `MoQCaptureSink` automatically when no session is injected
  - The sink is responsible for connecting and disposing the session
  - `disconnect()` and `dispose()` will clean up the session

- **Injected Session**: Provided externally via configuration or `setMoQSession()`
  - The sink does NOT dispose the session
  - You are responsible for managing the session lifecycle
  - `disconnect()` only disconnects from the session, doesn't dispose it

### Example: Shared Session

```typescript
import { MoqSessionBroadcaster } from 'stinky-moq-js';
import { createMoQSink, createMediaCapture, createPlayer } from 'web-live-player';

// Create a shared MoQ session
const session = new MoqSessionBroadcaster(
  { relayUrl: 'https://relay.example.com/moq', namespace: 'my-stream' },
  [
    { trackName: 'video', priority: 1, type: 'video' },
    { trackName: 'audio', priority: 2, type: 'audio' }
  ]
);

await session.connect();

// Use for capture (broadcasting)
const sink = createMoQSink({
  session: session,
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' }
});

const capture = createMediaCapture({
  sink,
  video: true,
  audio: true
});

await capture.start();

// Use for playback (subscribing) - requires a MoqSessionSubscriber
// Note: Typically you'd use separate sessions for broadcast vs subscribe,
// or use Elmo's unified MoQSessionNode which handles both
```

## Configuration Reference

### MoQSinkConfig

```typescript
interface MoQSinkConfig {
  // Optional when session is provided
  relayUrl?: string;
  namespace?: string;
  
  // Track configuration
  videoTrack?: { trackName: string; priority?: number };
  audioTrack?: { trackName: string; priority?: number };
  dataTracks?: { trackName: string; priority?: number }[];
  
  // Session injection
  session?: MoqSessionBroadcaster;
  
  // Other options
  reconnectionDelay?: number;
}
```

## Comparison with LiveVideoPlayer

The capture system's session injection mirrors the player's source injection:

| LiveVideoPlayer | MediaCapture / MoQCaptureSink |
|----------------|-------------------------------|
| `setStreamSource(source)` | `setMoQSession(session)` |
| `connectToMoQSession(session)` | `setMoQSession(session)` |
| Receives data from source | Sends data to session |
| Works with `IStreamSource` | Works with `MoqSessionBroadcaster` |

## Error Handling

```typescript
const sink = createMoQSink({
  videoTrack: { trackName: 'video' }
});

// This will throw if sink doesn't support MoQ session injection
try {
  capture.setMoQSession(session);
} catch (error) {
  console.error('Sink does not support MoQ session injection:', error);
}
```

## Migration Guide

### Before (Automatic Session)

```typescript
const sink = createMoQSink({
  relayUrl: 'https://relay.example.com/moq',
  namespace: 'my-stream',
  videoTrack: { trackName: 'video' }
});
```

### After (Injected Session)

```typescript
const session = new MoqSessionBroadcaster(
  { relayUrl: 'https://relay.example.com/moq', namespace: 'my-stream' },
  [{ trackName: 'video', priority: 1, type: 'video' }]
);
await session.connect();

const sink = createMoQSink({
  session: session,
  videoTrack: { trackName: 'video' }
});
```

Both approaches work identically from the caller's perspective. The injected session approach gives you more control over the session lifecycle.
---

# LiveVideoPlayer: MoQ Session/Source Injection

The LiveVideoPlayer provides multiple ways to connect to MoQ streams, giving you flexibility in how you manage sessions and sources.

## Method 1: Connect to MoQ Relay Directly

The simplest approach - the player handles everything:

```typescript
import { createPlayer } from 'web-live-player';

const player = createPlayer({
  enableAudio: true,
  videoTrackName: 'video',
  audioTrackName: 'audio'
});

// Automatically creates MoQSource and connects
await player.connectToMoQRelay(
  'https://relay.example.com/moq',
  'my-stream',
  {
    videoTrack: 'video',  // Optional, defaults to config.videoTrackName or 'video'
    audioTrack: 'audio'   // Optional, defaults to config.audioTrackName or 'audio'
  }
);

await player.start(canvasElement);
```

**Note**: This method creates and manages a `MoQSource` internally. The player owns the connection lifecycle.

## Method 2: Inject Stream Source

For maximum flexibility, inject any `IStreamSource` implementation:

```typescript
import { createPlayer, createMoQSource } from 'web-live-player';

// Create your own MoQ source
const moqSource = createMoQSource({
  relayUrl: 'https://relay.example.com/moq',
  namespace: 'my-stream',
  subscriptions: [
    { trackName: 'video', streamType: 'video', priority: 0 },
    { trackName: 'audio', streamType: 'audio', priority: 0 }
  ]
});

const player = createPlayer({ enableAudio: true });

// Inject the source
player.setStreamSource(moqSource);

// Connect and start
await moqSource.connect();
await player.start(canvasElement);
```

**Benefits**:
- Full control over source lifecycle
- Can inject any `IStreamSource` implementation (MoQSource, WebSocketSource, custom sources)
- Enables source reuse across multiple components

## Method 3: Connect to MoQ Session (Convenience)

A convenience method specifically for MoQ-compatible stream sources:

```typescript
import { createPlayer } from 'web-live-player';
// Assuming you're using Elmo or another framework that provides MoQSessionNode

const player = createPlayer({ enableAudio: true });

// Inject a MoQ session that implements IStreamSource
// For example, Elmo's MoQSessionNode implements IStreamSource directly
player.connectToMoQSession(moqSessionNode, 'video');

await player.start(canvasElement);
```

**Note**: This is essentially a wrapper around `setStreamSource()` with optional track filtering. It's useful when working with frameworks like Elmo that provide session objects implementing `IStreamSource`.

## Method 4: Set Track Filter

If you need to filter for a specific track after setting the source:

```typescript
player.setStreamSource(source);
player.setTrackFilter('video');  // Only process data from 'video' track
await player.start(canvasElement);
```

## Working with Elmo's MoQSessionNode

Elmo's `MoQSessionNode` implements `IStreamSource` directly, making integration seamless:

```typescript
import { createPlayer } from 'web-live-player';
import { MoQSessionNode } from '@elmonet/elmo';  // Example

const elmoSession = new MoQSessionNode({
  relayUrl: 'https://relay.example.com/moq',
  namespace: 'my-stream',
  subscriptions: [
    { trackName: 'video', type: 'video' },
    { trackName: 'audio', type: 'audio' }
  ]
});

const player = createPlayer({ enableAudio: true });
player.connectToMoQSession(elmoSession);  // Or use setStreamSource()

await elmoSession.connect();
await player.start(canvasElement);
```

## Session Lifecycle Management

### Player-Owned Source (Method 1)
- Created by `connectToMoQRelay()`
- Player manages connection and disposal
- `disconnect()` cleans up the internal source

### Injected Source (Methods 2-4)
- Provided externally via `setStreamSource()` or `connectToMoQSession()`
- You are responsible for managing the source lifecycle
- Player only disconnects from the source, doesn't dispose it

## Configuration Reference

### PlayerConfig

```typescript
interface PlayerConfig {
  preferredDecoder?: 'webcodecs' | 'wasm';
  bufferDelayMs?: number;  // Default: 100ms
  enableAudio?: boolean;
  videoTrackName?: string | null;  // Default: 'video', null accepts any track
  audioTrackName?: string | null;  // Default: 'audio', null accepts any track
  debugLogging?: boolean;
}
```

### IStreamSource Interface

Any object implementing this interface can be injected into the player:

```typescript
interface IStreamSource {
  on(event: 'data', handler: (event: StreamDataEvent) => void): void;
  off(event: 'data', handler: (event: StreamDataEvent) => void): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  dispose(): void;
}
```

---

# Comparison: Capture vs Player

| Feature | MediaCapture / MoQCaptureSink | LiveVideoPlayer |
|---------|------------------------------|-----------------|
| **Primary Method** | `setMoQSession(session)` | `setStreamSource(source)` |
| **Convenience Method** | N/A | `connectToMoQSession(session)` |
| **Auto-Connect Method** | N/A | `connectToMoQRelay(url, ns, opts)` |
| **Session Type** | `MoqSessionBroadcaster` | Any `IStreamSource` |
| **Direction** | Sends data to session | Receives data from source |
| **Track Filtering** | Configured at sink creation | `setTrackFilter(trackName)` |

---

# Shared Session Example

Here's how to use a shared MoQ connection for both capture and playback:

```typescript
import { MoqSessionBroadcaster, MoqSessionSubscriber } from 'stinky-moq-js';
import { createMoQSink, createMediaCapture, createPlayer, createMoQSource } from 'web-live-player';

// For capture: Create broadcaster session
const broadcasterSession = new MoqSessionBroadcaster(
  { relayUrl: 'https://relay.example.com/moq', namespace: 'my-stream' },
  [
    { trackName: 'video', priority: 1, type: 'video' },
    { trackName: 'audio', priority: 2, type: 'audio' }
  ]
);
await broadcasterSession.connect();

// Inject into capture
const sink = createMoQSink({
  session: broadcasterSession,
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' }
});

const capture = createMediaCapture({
  sink,
  video: true,
  audio: true
});
await capture.start();

// For playback: Create subscriber source
// Note: Typically you need a separate session for subscribing
const moqSource = createMoQSource({
  relayUrl: 'https://relay.example.com/moq',
  namespace: 'my-stream',
  subscriptions: [
    { trackName: 'video', streamType: 'video' },
    { trackName: 'audio', streamType: 'audio' }
  ]
});

const player = createPlayer({ enableAudio: true });
player.setStreamSource(moqSource);
await moqSource.connect();
await player.start(canvasElement);
```

**Note**: MoQ typically requires separate sessions for broadcasting and subscribing. If you're using a framework like Elmo that provides unified session objects handling both, you can share a single session instance.