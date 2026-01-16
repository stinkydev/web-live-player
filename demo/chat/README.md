# Chat Demo

A multi-user video chat application showcasing the **web-live-player** library for both capture and playback.

## Features

- **Multi-user video chat** with automatic user discovery
- **Real-time video/audio** using MoQ transport
- **Text chat** over data tracks
- **Room-based** namespace organization
- **Local preview** with mute controls

## How It Works

This demo combines capture and playback to create a complete video chat application:

### Publishing (Capture Side)

```typescript
import { MediaCapture, MoQCaptureSink, CodecType } from '@stinkycomputing/web-live-player';

// 1. Create MoQ sink with video, audio, and data tracks
const captureSink = new MoQCaptureSink({
  relayUrl: 'https://moq-relay.example.com',
  namespace: `${roomName}/user/${myUserId}`,
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' },
  dataTracks: [{ trackName: 'chat' }],  // For text messages
});

await captureSink.connect();

// 2. Start capturing with the sink
const capture = new MediaCapture({
  sink: captureSink,
  video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
  audio: { sampleRate: { ideal: 48000 }, channelCount: { ideal: 1 } },
  videoEncoder: {
    codec: CodecType.VIDEO_VP8,
    width: 640,
    height: 480,
    frameRate: 24,
    bitrate: 800_000,
    keyFrameInterval: 48,
    latencyMode: 'realtime',
  },
  audioEncoder: {
    codec: CodecType.AUDIO_OPUS,
    sampleRate: 48000,
    channels: 1,
    bitrate: 64_000,
    latencyMode: 'realtime',
  },
});

await capture.start();

// 3. Send chat messages via data track
function sendChat(text: string) {
  const message = { userId: myUserId, userName: myName, text, timestamp: Date.now() };
  captureSink.sendData('chat', new TextEncoder().encode(JSON.stringify(message)));
}
```

### Subscribing (Playback Side)

```typescript
import { LiveVideoPlayer, MoQSource } from '@stinkycomputing/web-live-player';

// 1. Create stream source with video, audio, and data tracks
const source = new MoQSource({
  relayUrl: 'https://moq-relay.example.com',
  namespace: `${roomName}/user/${remoteUserId}`,
  subscriptions: [
    { trackName: 'video', streamType: 'video', priority: 1 },
    { trackName: 'audio', streamType: 'audio', priority: 2 },
    { trackName: 'chat', streamType: 'data', priority: 3 },
  ],
});

// 2. Listen for chat messages on the data track
source.on('data', (event) => {
  if (event.trackName === 'chat' && event.data.payload) {
    const msg = JSON.parse(new TextDecoder().decode(event.data.payload));
    displayChatMessage(msg);
  }
});

await source.connect();

// 3. Create player for video/audio
const player = new LiveVideoPlayer({
  enableAudio: true,
  videoTrackName: 'video',
  audioTrackName: 'audio',
  bufferDelayMs: 100,
});

player.setStreamSource(source);
player.play();

// 4. Render loop
function renderLoop(timestamp: number) {
  const frame = player.getVideoFrame(timestamp);
  if (frame) {
    ctx.drawImage(frame, 0, 0);
    // Note: Don't close the frame - player manages lifecycle
  }
  requestAnimationFrame(renderLoop);
}
```

## Key Library Components Used

| Component | Purpose |
|-----------|---------|
| `MoQCaptureSink` | Publishes video/audio/data over MoQ |
| `MediaCapture` | Captures and encodes camera/microphone |
| `LiveVideoPlayer` | Decodes and schedules video frames |
| `MoQSource` | Subscribes to MoQ tracks (video, audio, data) |
| `sendData()` | Sends custom data (chat) on data tracks |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User A                                   │
│  ┌──────────────┐    ┌───────────────┐    ┌─────────────────┐  │
│  │ MediaCapture │───▶│ MoQCaptureSink│───▶│   MoQ Relay     │  │
│  └──────────────┘    └───────────────┘    └────────┬────────┘  │
│                                                     │           │
│  ┌──────────────┐    ┌───────────────────┐              │           │
│  │LiveVideoPlayer│◀──│    MoQSource    │◀─────────────┤           │
│  └──────────────┘    └───────────────────┘              │           │
└─────────────────────────────────────────────────────────┼───────────┘
                                                      │
┌─────────────────────────────────────────────────────┼───────────┐
│                         User B                      │           │
│  ┌──────────────┐    ┌───────────────┐              │           │
│  │ MediaCapture │───▶│ MoQCaptureSink│───▶──────────┤           │
│  └──────────────┘    └───────────────┘              │           │
│                                                     ▼           │
│  ┌──────────────┐    ┌───────────────────┐  ┌───────────────┐  │
│  │LiveVideoPlayer│◀──│    MoQSource    │◀─│   MoQ Relay   │  │
│  └──────────────┘    └───────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Running the Demo

```bash
cd /path/to/web-live-player
npm install
npm run dev
```

Then open http://localhost:3001/chat/
