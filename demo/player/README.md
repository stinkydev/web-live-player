# Player Demo

A comprehensive video player demo showcasing the **web-live-player** library's playback capabilities.

## Features

- **Live streaming** via MoQ (Media over QUIC) or WebSocket
- **File playback** from URLs or local files with seeking
- **Multiple decoder options**: WebCodecs hardware, WebCodecs software, WASM
- **Real-time statistics**: latency, frame rate, buffer status, bandwidth
- **Frame timing visualization** graph

## How It Works

### Live Stream Playback

```typescript
import { createPlayer, createMoQSource } from '@stinkycomputing/web-live-player';

// 1. Create the player with your preferred decoder
const player = createPlayer({
  preferredDecoder: 'webcodecs-hw',
  bufferDelayMs: 100,
  enableAudio: true,
});

// 2. Create a MoQ stream source
const source = createMoQSource({
  relayUrl: 'https://moq-relay.example.com',
  namespace: 'live/stream',
  subscriptions: [
    { trackName: 'video', streamType: 'video' },
    { trackName: 'audio', streamType: 'audio' },
  ],
});

// 3. Connect and play
await source.connect();
player.setStreamSource(source);
player.play();

// 4. Render loop - draw frames to canvas
function render(timestamp: number) {
  const frame = player.getVideoFrame(timestamp);
  if (frame) {
    ctx.drawImage(frame, 0, 0);
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
```

### File Playback

```typescript
import { createFilePlayer } from '@stinkycomputing/web-live-player';

// 1. Create file player
const filePlayer = createFilePlayer({
  preferredDecoder: 'webcodecs-hw',
  enableAudio: true,
  playMode: 'loop', // or 'once'
});

// 2. Load from URL (uses efficient range-based loading)
await filePlayer.loadFromUrl('https://example.com/video.mp4');

// 3. Play and render
filePlayer.play();

function render() {
  const frame = filePlayer.getVideoFrame();
  if (frame) {
    ctx.drawImage(frame, 0, 0);
    frame.close(); // File player requires manual frame closing
  }
  requestAnimationFrame(render);
}
```

## Key Library Components Used

| Component | Purpose |
|-----------|---------|
| `LiveVideoPlayer` | Manages live stream decoding and frame scheduling |
| `FileVideoPlayer` | Handles MP4 file loading, seeking, and playback |
| `createMoQSource` | Connects to MoQ relay and subscribes to tracks |
| `createWebSocketSource` | Connects to WebSocket stream server |
| `getVideoFrame()` | Returns the current decoded frame for rendering |

## Running the Demo

```bash
cd /path/to/web-live-player
npm install
npm run dev
```

Then open http://localhost:3001/player/
