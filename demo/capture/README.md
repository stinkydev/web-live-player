# Capture Demo

A media capture demo showcasing the **web-live-player** library's encoding and streaming capabilities.

## Features

- **Camera & microphone capture** with device selection
- **Real-time encoding** with VP8/VP9/H.264/HEVC video and Opus/AAC audio
- **Multiple transports**: MoQ (Media over QUIC) or WebSocket
- **Configurable settings**: resolution, bitrate, frame rate, keyframe interval
- **Live statistics**: frames encoded, bitrate, bytes sent
- **VU meter** for audio levels

## How It Works

### Publishing a Stream

```typescript
import { MediaCapture, MoQCaptureSink, CodecType } from '@stinkycomputing/web-live-player';

// 1. Create the transport sink
const sink = new MoQCaptureSink({
  relayUrl: 'https://moq-relay.example.com',
  namespace: 'my-stream',
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' },
});

await sink.connect();

// 2. Configure capture with encoder settings
const capture = new MediaCapture({
  sink,
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
  audio: {
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 2 },
  },
  videoEncoder: {
    codec: CodecType.VIDEO_VP8,
    width: 1280,
    height: 720,
    frameRate: 30,
    bitrate: 2_000_000,
    keyFrameInterval: 60,
    latencyMode: 'realtime',
  },
  audioEncoder: {
    codec: CodecType.AUDIO_OPUS,
    sampleRate: 48000,
    channels: 2,
    bitrate: 128_000,
    latencyMode: 'realtime',
  },
});

// 3. Start capturing
await capture.start();

// 4. Get MediaStream for local preview
const stream = capture.getMediaStream();
previewVideo.srcObject = stream;

// 5. Listen for events
capture.on('stats', (stats) => {
  console.log(`Encoded: ${stats.videoFramesEncoded} frames, ${stats.bytesSent} bytes`);
});

capture.on('audio-levels', (levels) => {
  console.log(`Audio level: ${levels.average}`);
});
```

### Using WebSocket Transport

```typescript
import { MediaCapture, WebSocketCaptureSink } from '@stinkycomputing/web-live-player';

const sink = new WebSocketCaptureSink({
  url: 'wss://stream-server.example.com/ingest',
  streamId: 'my-stream',
});

await sink.connect();

const capture = new MediaCapture({
  sink,
  // ... same config as above
});

await capture.start();
```

## Key Library Components Used

| Component | Purpose |
|-----------|---------|
| `MediaCapture` | Captures camera/mic, encodes with WebCodecs workers |
| `MoQCaptureSink` | Sends encoded data over MoQ transport |
| `WebSocketCaptureSink` | Sends encoded data over WebSocket |
| `CodecType` | Enum for video/audio codec selection |
| `SesameBinaryProtocol` | Binary protocol for packet serialization |

## Supported Codecs

**Video:**
- VP8 (`CodecType.VIDEO_VP8`)
- VP9 (`CodecType.VIDEO_VP9`)
- H.264/AVC (`CodecType.VIDEO_AVC`)
- H.265/HEVC (`CodecType.VIDEO_HEVC`)

**Audio:**
- Opus (`CodecType.AUDIO_OPUS`)
- AAC (`CodecType.AUDIO_AAC`)

## Running the Demo

```bash
cd /path/to/web-live-player
npm install
npm run dev
```

Then open http://localhost:3001/capture/
