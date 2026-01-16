# Web Live Player

A framework-agnostic video streaming library for playing back **Sesame** video streams. Sesame is a video engine that delivers low-latency video over MoQ (Media over QUIC) and WebSocket transports.

## Features

- **Sesame stream playback** - Native support for Sesame video engine streams
- **WebCodecs-based decoding** - Hardware-accelerated video decoding
- **MoQ support** - Native Media over QUIC protocol support via `stinky-moq-js`
- **Pluggable stream sources** - Use dependency injection to provide video data from any transport
- **Frame scheduling** - Automatic buffering and drift correction for smooth playback
- **Optimized file loading** - Range-based chunked loading for fast playback of large MP4 files
- **No framework dependencies** - Works with vanilla JS, React, Three.js, or any other framework

## Installation

```bash
npm install @stinkycomputing/web-live-player
```

## Quick Start

### Using with MoQ (Standalone)

```typescript
import { createPlayer, createMoQSource } from '@stinkycomputing/web-live-player';

// Create player
const player = createPlayer({
  preferredDecoder: 'webcodecs-hw',
  bufferDelayMs: 100,
});

// Create MoQ source
const moqSource = createMoQSource({
  relayUrl: 'https://moq-relay.example.com',
  namespace: 'live/stream',
  subscriptions: [
    { trackName: 'video', streamType: 'video' },
    { trackName: 'audio', streamType: 'audio' },
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

### File Playback

For playing MP4 files from URLs or local files:

```typescript
import { createFilePlayer } from '@stinkycomputing/web-live-player';

const filePlayer = createFilePlayer({
  preferredDecoder: 'webcodecs-hw',
  enableAudio: true,
  debugLogging: false,
  playMode: 'once', // or 'loop' for continuous playback
});

// Load from URL (with optimized chunked loading)
await filePlayer.loadFromUrl('https://example.com/video.mp4');

// Or load from File object (e.g., from file input)
const file = fileInput.files[0];
await filePlayer.loadFromFile(file);

// Play the file
filePlayer.play();

// Render loop
function render() {
  const frame = filePlayer.getVideoFrame();
  if (frame) {
    ctx.drawImage(frame, 0, 0);
    frame.close();
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// Seek to position (in seconds)
await filePlayer.seek(30);

// Listen to events
filePlayer.on('ready', (info) => {
  console.log(`Video loaded: ${info.width}x${info.height}, ${info.duration}s`);
});

filePlayer.on('progress', (loaded, total) => {
  console.log(`Loading: ${(loaded / total * 100).toFixed(1)}%`);
});
```

**Optimized Loading**: The file player uses HTTP Range requests to load large files in chunks (1MB each). This means:
- Playback starts as soon as metadata is available (~1-2MB typically)
- Remaining file loads in the background during playback
- 10-30x faster time-to-first-frame for large files
- Automatic fallback to full download if server doesn't support ranges

## API Reference

### `createPlayer(config?)`

Creates a new player instance.

**Config options:**
- `preferredDecoder`: `'webcodecs-hw'` | `'webcodecs-sw'` | `'wasm'` - Decoder preference (default: `'webcodecs-sw'`). Note: WASM decoder only supports H.264 Baseline profile.
- `bufferDelayMs`: `number` - Buffer delay in milliseconds (default: 100)
- `enableAudio`: `boolean` - Enable audio playback (default: true)
- `videoTrackName`: `string | null` - Video track name for MoQ streams (default: `'video'`)
- `audioTrackName`: `string | null` - Audio track name for MoQ streams (default: `'audio'`)
- `debugLogging`: `boolean` - Enable debug logging

### `createFilePlayer(config?)`

Creates a file player instance for MP4 playback.

**Config options:**
- `preferredDecoder`: `'webcodecs-hw'` | `'webcodecs-sw'` | `'wasm'` - Decoder preference (default: `'webcodecs-sw'`)
- `enableAudio`: `boolean` - Enable audio playback (default: true)
- `audioContext`: `AudioContext` - Optional audio context (creates one if not provided)
- `playMode`: `'once'` | `'loop'` - Play mode (default: `'once'`)
- `debugLogging`: `boolean` - Enable debug logging

### `FileVideoPlayer`

File player class.

**Methods:**
- `loadFromUrl(url: string)` - Load MP4 from URL (uses range-based chunked loading)
- `loadFromFile(file: File)` - Load MP4 from File object
- `play()` - Start playback
- `pause()` - Pause playback
- `seek(timeSeconds: number)` - Seek to position
- `getVideoFrame()` - Get current video frame for rendering
- `getPosition()` - Get current position in seconds
- `getDuration()` - Get duration in seconds
- `getStats()` - Get playback statistics
- `setVolume(volume: number)` - Set audio volume (0-1)
- `setPlayMode(mode: 'once' | 'loop')` - Set play mode
- `dispose()` - Clean up resources

**Events:**
- `ready` - Emitted when file is loaded and ready to play
- `progress` - Emitted during file loading with (loaded, total) bytes
- `statechange` - Emitted when player state changes
- `ended` - Emitted when playback ends (in 'once' mode)
- `loop` - Emitted when video loops (in 'loop' mode)
- `seeked` - Emitted after seeking completes
- `error` - Emitted on errors

### `LiveVideoPlayer`

Main player class.

**Methods:**
- `setStreamSource(source: IStreamSource)` - Set the stream data source
- `setTrackFilter(trackName: string)` - Filter for specific track
- `connectToMoQRelay(relayUrl, namespace, options?)` - Connect directly to a MoQ relay
- `play()` - Start playback
- `pause()` - Pause playback
- `getVideoFrame(timestampMs: number)` - Get frame for current render timestamp
- `getStats()` - Get playback statistics
- `setVolume(volume: number)` - Set audio volume (0-1)
- `setDebugLogging(enabled: boolean)` - Enable/disable debug logging at runtime
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

> **Note:** The WASM decoder only supports **H.264 Baseline profile**. For Main or High profile streams, use `'webcodecs-hw'` or `'webcodecs-sw'` instead.

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

## Demos

The library includes three demo applications showcasing different use cases:

### [Player Demo](demo/player/)
Live stream and file playback with multiple decoder options.
- Connect to MoQ or WebSocket streams
- Play MP4 files with seeking
- Real-time statistics and frame timing visualization

### [Capture Demo](demo/capture/)
Media capture and encoding with transport publishing.
- Camera/microphone capture with device selection
- Configurable video/audio codecs and bitrates
- Publish to MoQ relay or WebSocket server

### [Chat Demo](demo/chat/)
Multi-user video chat combining capture and playback.
- Full duplex video/audio communication
- Room-based user discovery
- Text chat over data tracks

### Running the Demos

```bash
npm install
npm run dev
```

Open http://localhost:3001 to see all demos.

| Demo | URL | Description |
|------|-----|-------------|
| Player | http://localhost:3001/player/ | Stream playback & file player |
| Capture | http://localhost:3001/capture/ | Camera capture & streaming |
| Chat | http://localhost:3001/chat/ | Multi-user video chat |

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
