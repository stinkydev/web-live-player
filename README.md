# Web Live Player

A framework-agnostic video streaming library for playing back **Sesame** video streams. Sesame is a video engine that delivers low-latency video over MoQ (Media over QUIC) and WebSocket transports.

## Features

- **Sesame stream playback** - Native support for Sesame video engine streams
- **WebCodecs-based decoding** - Hardware-accelerated video decoding
- **MoQ support** - Native Media over QUIC protocol support via `stinky-moq-js`
- **Pluggable stream sources** - Use dependency injection to provide video data from any transport
- **Frame scheduling** - Automatic buffering and drift correction for smooth playback
- **No framework dependencies** - Works with vanilla JS, React, Three.js, or any other framework

## Installation

```bash
npm install @stinkycomputing/web-live-player
```

For MoQ support, also install:

```bash
npm install stinky-moq-js
```

## Quick Start

### Using with MoQ (Standalone)

```typescript
import { createPlayer, createStandaloneMoQSource } from '@stinkycomputing/web-live-player';

// Create player
const player = createPlayer({
  preferredDecoder: 'webcodecs-hw',
  bufferSizeFrames: 3,
});

// Create MoQ source
const moqSource = createStandaloneMoQSource({
  relayUrl: 'https://moq-relay.example.com',
  namespace: 'live/stream',
  subscriptions: [
    { trackName: 'video', streamType: 'video' },
  ],
});

// Connect and play
await moqSource.connect();
player.setStreamSource(moqSource);
player.setTrackFilter('video');
player.play();

// Render loop
function render(timestamp) {
  const frame = player.getVideoFrame(timestamp);
  if (frame) {
    ctx.drawImage(frame, 0, 0);
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
```

### Using with Elmo's MoQSession

```typescript
import { createPlayer } from '@stinkycomputing/web-live-player';
import { MoQDiscoveryUtils } from '@elmo/core';

// Find session from Elmo's node tree
// MoQSessionNode implements IStreamSource directly
const session = MoQDiscoveryUtils.findMoQSession(currentNode, 'my-session');

// Create and configure player - session can be used directly as stream source
const player = createPlayer();
player.setStreamSource(session);
player.setTrackFilter('video-track');
player.play();
```

### Custom Stream Source

```typescript
import { createPlayer, IStreamSource, BaseStreamSource } from '@stinkycomputing/web-live-player';

class MyCustomSource extends BaseStreamSource {
  async connect() {
    // Your connection logic
    this._connected = true;
    this.emit('connected');
  }
  
  // Call this when you receive video data
  handleVideoData(trackName: string, data: ParsedData) {
    this.emit('data', {
      trackName,
      streamType: 'video',
      data,
    });
  }
}

const source = new MyCustomSource();
await source.connect();

const player = createPlayer();
player.setStreamSource(source);
player.play();
```

## API Reference

### `createPlayer(config?)`

Creates a new player instance.

**Config options:**
- `preferredDecoder`: `'webcodecs-hw'` | `'webcodecs-sw'` | `'wasm'` - Decoder preference
- `bufferSizeFrames`: `number` - Target buffer size (default: 3)
- `debugLogging`: `boolean` - Enable debug logging

### `LiveVideoPlayer`

Main player class.

**Methods:**
- `setStreamSource(source: IStreamSource)` - Set the stream data source
- `setTrackFilter(trackName: string)` - Filter for specific track
- `play()` - Start playback
- `pause()` - Pause playback
- `getVideoFrame(timestampMs: number)` - Get frame for current render timestamp
- `getStats()` - Get playback statistics
- `dispose()` - Clean up resources

**Events:**
- `frame` - Emitted when a frame is decoded
- `metadata` - Emitted when stream metadata is received
- `statechange` - Emitted when player state changes
- `error` - Emitted on errors

### `IStreamSource`

Interface for stream data sources.

**Events to emit:**
- `data` - Stream data event with `{ trackName, streamType, data }`
- `connected` - When connected
- `disconnected` - When disconnected
- `error` - On errors

## Rendering Frames to Canvas

The player returns `VideoFrame` objects that can be rendered in multiple ways:

### Basic Canvas Rendering

```typescript
const canvas = document.getElementById('video-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function render(timestamp: number) {
  const frame = player.getVideoFrame(timestamp);
  if (frame) {
    // Resize canvas to match video dimensions
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    
    // Draw the frame
    ctx.drawImage(frame, 0, 0);
    
    // IMPORTANT: Close the frame when done to release memory
    frame.close();
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
```

### WebGL / Three.js Rendering

For GPU-accelerated rendering (e.g., in Three.js):

```typescript
// Create a texture
const texture = new THREE.Texture();
texture.minFilter = THREE.LinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.colorSpace = THREE.SRGBColorSpace;

// In your render loop
function render(timestamp: number) {
  const frame = player.getVideoFrame(timestamp);
  if (frame) {
    // Update texture with the VideoFrame
    texture.image = frame;
    texture.needsUpdate = true;
    
    // Close previous frame if stored
    if (lastFrame) lastFrame.close();
    lastFrame = frame;
  }
  
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}
```

### Handling YUV Frames (WASM Decoder)

When using the WASM decoder, the library automatically converts YUV frames to `VideoFrame` objects using the browser's native I420 support. The GPU handles YUV→RGB conversion, so you can use the same rendering code regardless of decoder:

```typescript
// The player always returns VideoFrame, even with WASM decoder
const frame = player.getVideoFrame(timestamp);
if (frame) {
  ctx.drawImage(frame, 0, 0);
  frame.close();
}
```

If you need raw YUV data for custom processing, you can access the `WasmDecoder` directly:

```typescript
import { WasmDecoder } from '@stinkycomputing/web-live-player';

const decoder = new WasmDecoder({
  onFrameDecoded: (yuvFrame) => {
    // yuvFrame has: { y, u, v, width, height, stride, chromaStride, chromaHeight, timestamp }
    // Process raw YUV data here
  },
});
```

### Best Practices

1. **Always close VideoFrames** - Call `frame.close()` when done to prevent memory leaks
2. **Check for null frames** - `getVideoFrame()` returns null when no frame is ready
3. **Use performance.now()** - Pass accurate timestamps for proper frame scheduling
4. **Handle resize** - Update canvas dimensions when video dimensions change


## Bundler Configuration

### WASM Decoder (tinyh264)

The WASM decoder uses `tinyh264` which requires special bundler configuration for its Web Worker and WASM assets.

#### Vite

Add the following to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  // Handle tinyh264's .asset files as URLs
  assetsInclude: ['**/*.asset'],
  
  // Ensure worker files are bundled correctly
  worker: {
    format: 'es',
  },
});
```

#### Webpack

For Webpack, you may need to configure asset handling:

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.asset$/,
        type: 'asset/resource',
      },
    ],
  },
};
```

### WebCodecs Decoder (Recommended)

If you only need WebCodecs-based decoding (hardware or software), no special bundler configuration is required. Simply use:

```typescript
const player = createPlayer({
  preferredDecoder: 'webcodecs-hw', // or 'webcodecs-sw'
});
```

## Demo

Run the demo application:

```bash
cd video-player
npm install
npm run dev
```

Open http://localhost:3001 to see the demo.

## Building

Build the library:

```bash
npm run build
```

Build the demo:

```bash
npm run build:demo
```

## License

MIT
