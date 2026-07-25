# Web Live Player

A framework-agnostic video streaming library for playing back **Sesame** video streams. Sesame is a video engine that delivers low-latency video over MoQ (Media over QUIC) and WebSocket transports.

## Features

- **Sesame stream playback** - Native support for Sesame video engine streams
- **WebCodecs-based decoding** - Hardware-accelerated video decoding
- **MoQ support** - Native Media over QUIC protocol support via `stinky-moq-js`
- **Pluggable stream sources** - Use dependency injection to provide video data from any transport
- **Frame scheduling** - Automatic buffering and drift correction for smooth playback
- **Optimized file loading** - Range-based chunked loading for fast playback of large MP4 files
- **Capture and publishing** - Encode camera/microphone with WebCodecs and publish over MoQ or WebSocket
- **No framework dependencies** - Works with vanilla JS, React, Three.js, or any other framework

## Installation

```bash
npm install @stinkycomputing/web-live-player
```

## Requirements

The library is browser-only and builds directly on modern media APIs. Rather than
tracking version numbers, detect what you need at runtime:

| Capability | Required APIs | Notes |
|------------|---------------|-------|
| Video playback | `VideoDecoder` (WebCodecs) | The `'wasm'` decoder needs only `VideoFrame`, not `VideoDecoder` - H.264 Baseline only |
| Audio playback | `AudioDecoder`, `AudioWorklet` | Needs a **secure context** (HTTPS or `localhost`) |
| MoQ transport | `WebTransport` | Chromium-based browsers at the time of writing |
| Capture / publishing | `VideoEncoder`, `AudioEncoder`, `MediaStreamTrackProcessor`, `getUserMedia` | `MediaStreamTrackProcessor` is Chromium-only; needs a secure context |
| File playback | `VideoDecoder`, `fetch` with HTTP Range support for progressive loading | Falls back to a full download |

```typescript
const canPlay = 'VideoDecoder' in window;
const canPlayAudio = canPlay && 'AudioDecoder' in window && !!window.isSecureContext;
const canUseMoQ = 'WebTransport' in window;
const canCapture = 'VideoEncoder' in window && 'MediaStreamTrackProcessor' in window;
```

`AudioWorklet` throws outside a secure context, so audio playback fails on plain
`http://` origins other than `localhost`.

## Stream Requirements

Two properties of the incoming stream matter, and getting either wrong looks like a
dead stream rather than an error.

### H.264 must be Annex B

The live path configures `VideoDecoder` **without a `description`**, which means the
bitstream must be in Annex B format (NAL units prefixed with `00 00 01` /
`00 00 00 01`, with in-band SPS/PPS). The WASM decoder likewise splits incoming
packets on start codes. A length-prefixed (AVCC) stream decodes to nothing.

If you publish with this library's capture module, this is already handled - it
configures the encoder with `avc: { format: 'annexb' }`.

File playback is different: MP4 samples are length-prefixed, so the file player
passes the `avcC`/`hvcC` box to the decoder as a `description`. No action needed.

### Track names must match

The player filters incoming packets by track name:

- **Video** is accepted only when `trackName` equals `videoTrackName` (default
  `'video'`), or when that option is `null`.
- **Audio** is accepted when `trackName` equals `audioTrackName` (default `'audio'`)
  **or** when the packet's `streamType` is `'audio'`.

Video has no such fallback, which matters for transports that name the track after
the stream. `WebSocketSource` labels every packet with the stream ID, so with the
default config no video is accepted. Either filter for the stream explicitly:

```typescript
await wsSource.loadLive('my-stream');
player.setTrackFilter('my-stream');   // or: createPlayer({ videoTrackName: null })
```

...or set `videoTrackName: null` to accept video from any track. When packets are
being dropped this way, the player logs a one-time warning naming the track it saw
and the one it expected.

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

Or let the player build the source for you:

```typescript
await player.connectToMoQRelay('https://moq-relay.example.com', 'live/stream', {
  videoTrack: 'video',
  audioTrack: 'audio',   // pass false to skip audio
});
player.play();
```

### Using with WebSocket

`WebSocketSource` speaks the Sesame WebSocket protocol: JSON commands out, binary
wire-protocol frames in.

```typescript
import { createPlayer, createWebSocketSource } from '@stinkycomputing/web-live-player';

const source = createWebSocketSource({
  useCurrentHost: true,      // build the URL from window.location
  apiPath: '/api/video',
  autoReconnect: true,
});

await source.connect();
await source.loadLive('my-stream');

const player = createPlayer();
player.setStreamSource(source);

// Packets are tagged with the stream ID, so filter for it (see Stream Requirements)
player.setTrackFilter('my-stream');
player.play();
```

With `autoReconnect`, a dropped connection is retried every `reconnectDelay` ms and
the current stream is re-loaded automatically.

### Custom Stream Source

```typescript
import { createPlayer, IStreamSource, BaseStreamSource } from '@stinkycomputing/web-live-player';

class MyCustomSource extends BaseStreamSource {
  async connect() {
    // Your connection logic
    this._connected = true;
    this.emit('connected');
  }

  // Call this with raw wire-protocol bytes - it parses and emits 'data' for you
  handleBytes(trackName: string, bytes: Uint8Array) {
    this.parseAndEmitStreamData(trackName, bytes);
  }
}

const source = new MyCustomSource();
await source.connect();

const player = createPlayer();
player.setStreamSource(source);
player.play();
```

If you have already-parsed frames, emit them directly instead:

```typescript
this.emit('data', { trackName, streamType: 'video', data: parsedFrame });
```

Implement the optional `requestKeyframe()` so the player can ask for a fresh
keyframe after a flush or decoder switch.

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
    // The player owns the frame - draw from it, don't close it
    ctx.drawImage(frame, 0, 0);
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

**Optimized Loading**: The file player uses HTTP Range requests to load large files
in 4MB chunks. This means:
- Playback starts as soon as metadata is available (~1-2MB typically)
- Remaining file loads in the background during playback
- 10-30x faster time-to-first-frame for large files
- Automatic fallback to full download if server doesn't support ranges

**Memory**: decoded frames hold full video memory, so the player decodes at most
`maxBufferedFrames` (default 60) ahead of the playback position and resumes as you
drain them via `getVideoFrame()`. Encoded samples for the whole file are retained to
support seeking and looping.

## API Reference

### `createPlayer(config?)` / `LiveVideoPlayer`

Creates a live player instance.

**Config options (`PlayerConfig`):**
- `preferredDecoder`: `'webcodecs-hw' | 'webcodecs-sw' | 'wasm'` - Decoder preference (default: `'webcodecs-sw'`). The WASM decoder supports H.264 Baseline only.
- `bufferDelayMs`: `number` - Target buffer delay in milliseconds (default: `100`). `0` enables bypass mode: always render the newest frame and drop the rest.
- `enableAudio`: `boolean` - Enable audio playback (default: `true`)
- `audioContext`: `AudioContext` - External context to use. When provided the player neither creates nor closes it; otherwise it owns one and closes it on `dispose()`.
- `videoTrackName`: `string | null` - Video track to accept (default: `'video'`, `null` accepts any)
- `audioTrackName`: `string | null` - Audio track to accept (default: `'audio'`, `null` accepts any)
- `debugLogging`: `boolean` - Enable debug logging (default: `false`)

**Methods:**
- `setStreamSource(source: IStreamSource)` - Set the stream data source
- `setTrackFilter(trackName: string)` - Accept video from this track, overriding `videoTrackName`
- `connectToMoQSession(session: IStreamSource, videoTrackName?)` - Attach an existing MoQ session
- `connectToMoQRelay(relayUrl, namespace, options?): Promise<IStreamSource>` - Build a MoQ source, connect it, and return it. `options`: `{ videoTrack?: string; audioTrack?: string | false }`. The player owns this source and disposes it - see [MoQ Session Injection](#moq-session-injection).
- `play()` / `pause()` - Start and pause playback
- `getVideoFrame(timestampMs: number): VideoFrame | null` - Frame for the current render timestamp. Player-owned; see [Best Practices](#best-practices).
- `setBufferDelay(delayMs: number)` - Change the target buffer delay at runtime (applies to video and audio)
- `getBufferDelay(): number` - Current target buffer delay
- `setPreferredDecoder(type: PreferredDecoder)` - Switch decoders at runtime. Rebuilds the decoder and requests a keyframe.
- `flush()` - Drop the decoder and frame buffer, then request a keyframe. Used to recover from stalls.
- `setVolume(volume: number)` / `getVolume(): number` - Audio volume, clamped to 0-1. Remembered across audio (re)initialization, so it can be set before audio arrives.
- `getStats(): PlayerStats` - Playback statistics (see [Statistics](#statistics))
- `getPacketTimingHistory(): PacketTimingEntry[]` - Recent packet arrival/decode timing, oldest first, for jitter visualization
- `setDebugLogging(enabled: boolean)` - Toggle debug logging at runtime
- `on(event, handler)` / `off(event, handler)` - Subscribe and unsubscribe
- `dispose()` - Release the decoder, audio, buffered frames and handlers. Disposes the stream source only if the player created it.

**Events:**
- `frame: (frame: VideoFrame) => void` - A frame finished decoding. The player owns it; it is only valid for the duration of the handler.
- `metadata: (m: { width, height, codec }) => void` - Stream metadata resolved after decoder configuration
- `statechange: (state: PlayerState) => void` - `'idle' | 'playing' | 'paused' | 'error'`
- `error: (error: Error) => void` - Decoder or configuration failure

### `createFilePlayer(config?)` / `FileVideoPlayer`

Creates a file player instance for MP4 playback.

**Config options (`FilePlayerConfig`):**
- `preferredDecoder`: `'webcodecs-hw' | 'webcodecs-sw' | 'wasm'` - Decoder preference (default: `'webcodecs-sw'`)
- `enableAudio`: `boolean` - Enable audio playback (default: `true`)
- `audioContext`: `AudioContext` - Optional audio context (creates one if not provided)
- `playMode`: `'once' | 'loop'` - Play mode (default: `'once'`)
- `maxBufferedFrames`: `number` - Decoded frames to hold ahead of the playback position (default: `60`, floor of 3)
- `debugLogging`: `boolean` - Enable debug logging
- `loop`: `boolean` - **Deprecated**, use `playMode`

**Methods:**
- `loadFromUrl(url: string): Promise<MP4FileInfo>` - Load MP4 from URL (range-based chunked loading)
- `loadFromFile(file: File): Promise<MP4FileInfo>` - Load MP4 from a `File`
- `play()` - Start playback. After `'ended'`, restarts from the beginning.
- `pause()` - Pause playback
- `seek(timeSeconds: number)` - Seek to the nearest keyframe at or before the target
- `getVideoFrame(): VideoFrame | null` - Frame for the current position. Player-owned.
- `getPosition(): number` / `getDuration(): number` - Position and duration in seconds
- `getFileInfo(): MP4FileInfo | null` - Metadata of the loaded file
- `getStats(): FilePlayerStats` - `{ duration, position, bufferSize, width, height, frameRate, codec, state }`
- `setVolume(volume: number)` / `getVolume(): number` - Audio volume, 0-1
- `setPlayMode(mode: FilePlayMode)` / `getPlayMode()` - Play mode; `setLoop(boolean)` is deprecated
- `setDebugLogging(enabled: boolean)` - Toggle debug logging
- `dispose(full = false)` - Release decoder, buffers and source. Pass `true` to also close an owned `AudioContext`; the default keeps it alive so the next `load*()` can reuse it. Event handlers are **not** cleared.

**Events:**
- `ready: (info: MP4FileInfo) => void` - File loaded and ready to play
- `progress: (loaded: number, total: number) => void` - Loading progress in bytes
- `statechange: (state: FilePlayerState) => void` - `'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error'`
- `ended: () => void` - Playback reached the end (`'once'` mode)
- `loop: () => void` - Playback wrapped around (`'loop'` mode)
- `seeked: (timeSeconds: number) => void` - Seek completed
- `error: (error: Error) => void` - Load or decode failure

### Statistics

`LiveVideoPlayer.getStats()` returns `PlayerStats`:

| Field | Meaning |
|-------|---------|
| `bufferSize` | Frames currently buffered |
| `bufferMs` / `avgBufferMs` | Current and averaged buffer depth in ms |
| `targetBufferMs` | Configured buffer delay |
| `droppedFrames` / `totalFrames` | Frames dropped and enqueued since start |
| `decoderState` | Underlying decoder state, or `'none'` |
| `streamWidth` / `streamHeight` | Coded dimensions from codec data |
| `frameRate` | Estimated from packet timestamps (defaults to 30 until estimated) |
| `latency` | `LatencyStats \| null` |
| `bandwidth` | `BandwidthStats \| null` |

`LatencyStats` holds `decodeLatency`, `bufferLatency`, `totalLatency` and their
`avg*` counterparts, in milliseconds rounded to 0.1, averaged over roughly the last
second of frames.

`BandwidthStats` holds `videoBytesPerSecond`, `audioBytesPerSecond` and
`totalBytesPerSecond`, recomputed at most every 500ms when `getStats()` is called.

`PacketTimingEntry` (from `getPacketTimingHistory()`) holds `arrivalTime`,
`intervalMs`, `streamTimestampUs`, `isKeyframe`, `decodeLatencyMs` and `wasDropped`.
Entries are copies, safe to retain.

### Stream Sources

#### `createMoQSource(config)` / `MoQSource`

- `relayUrl`: `string` - MoQ relay URL
- `namespace`: `string` - Broadcast namespace
- `subscriptions`: `MoQTrack[]` - `{ trackName, streamType: 'video' | 'audio' | 'data', priority? }`
- `reconnectionDelay`: `number` - Delay between reconnects in ms (default: `3000`)

Methods: `connect()`, `disconnect()`, `dispose()`, plus the `IStreamSource` events.

#### `createWebSocketSource(config?)` / `WebSocketSource`

**Config (`WebSocketSourceConfig`):**

- `url`: `string` - Explicit WebSocket URL. Overrides `useCurrentHost`.
- `useCurrentHost`: `boolean` - Derive the URL from `window.location` (default: `true`)
- `apiPath`: `string` - Path used with `useCurrentHost` (default: `'/api/video'`)
- `clientId`: `string` - Sent as the `id` query parameter (default: `'video-player'`)
- `timeout`: `number` - Connection and request timeout in ms (default: `5000`)
- `autoReconnect`: `boolean` - Reconnect and re-load the stream after a drop (default: `false`)
- `reconnectDelay`: `number` - Delay between reconnects in ms (default: `3000`)

Methods: `connect()`, `loadLive(streamId)`, `requestKeyframe()` (throttled to once
per second), `disconnect()`, `dispose()`.

#### `MP4FileSource`

Standalone MP4 demuxer, usable without `FileVideoPlayer`. The constructor takes
`MP4FileSourceEvents`:

```typescript
import { MP4FileSource } from '@stinkycomputing/web-live-player';

const source = new MP4FileSource({
  onReady: (info) => {},        // MP4FileInfo
  onSamples: (samples) => {},   // DecodableSample[]
  onProgress: (loaded, total) => {},
  onEnded: () => {},            // all samples extracted (fires once)
  onError: (error) => {},
});

const info = await source.loadFromUrl('https://example.com/video.mp4');
const description = source.getVideoDescription();  // avcC/hvcC for VideoDecoder
```

`MP4FileInfo`: `duration` (seconds), `timescale`, `width`, `height`, `videoCodec`,
`audioCodec?`, `frameRate?`, `bitrate?`, `audioChannels?`, `audioSampleRate?`,
`isMoovAtStart?`. A `false` value for `isMoovAtStart` means the file needs
`-movflags +faststart` for progressive playback.

`DecodableSample`: `data`, `timestamp` and `duration` in microseconds,
`isKeyframe`, `type`.

Methods: `loadFromUrl`, `loadFromFile`, `seek(timeSeconds)`, `start()`, `stop()`,
`getFileInfo()`, `getVideoDescription()`, `getAudioDescription()`, `getPosition()`,
`dispose()`.

#### `IStreamSource` / `BaseStreamSource`

Interface for stream data sources.

- `on(event, handler)` / `off(event, handler)` for `'data' | 'error' | 'connected' | 'disconnected'`
- `connected?: boolean`
- `requestKeyframe?(): void` - Optional; the player calls it after a flush or decoder switch
- `dispose?(): void`

A `'data'` event carries `{ trackName, streamType, data }` where `data` is a parsed
wire-protocol frame. Extend `BaseStreamSource` to get event plumbing plus
`parseAndEmitStreamData(trackName, bytes)`, which parses raw bytes and emits the
event with the right `streamType`.

### Decoders

Both decoders implement `IVideoDecoder`, so they are interchangeable.

#### `WebCodecsDecoder`

```typescript
const decoder = new WebCodecsDecoder({
  onFrameDecoded: (frame) => {},   // alias: onFrame
  onError: (error) => {},
  onQueueOverflow: (queueSize) => {},
  maxQueueSize: 10,
  logger,
});

await decoder.configure(codecData, preferHardware);   // from stream codec data
await decoder.configure(videoDecoderConfig);          // or a raw WebCodecs config
decoder.decodeBinary(parsedFrame, timestampUs?);      // live packets
decoder.decode({ data, timestamp, duration, isKeyframe });  // demuxed samples (SampleData)
```

Both `configure` overloads try the requested hardware preference first and fall
back to the opposite. `flush()` awaits pending frames; `flushSync()` resets and
reconfigures immediately; `reset()`, `dispose()`, `state` and `decodeQueueSize`
round out the API - `state` is a `DecoderState`. When `decodeQueueSize` exceeds
`maxQueueSize` the packet is dropped and `onQueueOverflow` fires. The options object
is `DecoderConfig`; the shared shape used by `IVideoDecoder` implementations is
`VideoDecoderOptions`.

#### `WasmDecoder`

Software H.264 **Baseline** decoding in a worker, for environments without
WebCodecs. Same interface, but `onFrameDecoded` receives a `YUVFrame`:

```typescript
import { WasmDecoder } from '@stinkycomputing/web-live-player';

const decoder = new WasmDecoder({   // WasmDecoderConfig
  onFrameDecoded: (yuv) => {
    // { y, u, v, width, height, chromaStride, chromaHeight, timestamp, data? }
  },
  onError: (error) => {},
  onQueueOverflow: (queueSize) => {},
  maxQueueSize: 10,
});
```

`YUVFrame.data` is present when the three planes are contiguous in I420 order, in
which case it can go straight to `new VideoFrame(data, { format: 'I420', ... })`
with no repacking. Requires [bundler configuration](#wasm-decoder-tinyh264).
`isVideoFrame(frame)` and `isYUVFrame(frame)` narrow a `DecodedFrame`.

### Audio Players

Usually driven by the players, but usable directly.

`LiveAudioPlayer(context, { bufferDelayMs })` (`LiveAudioConfig`) - `init(codecData)`,
`decode(payload, timestampUs)`, `setBufferDelay(ms)`, `start()`, `stop()`,
`clear()`, `resetTiming()`, `setVolume(0-1)`, `dispose()`. Decodes Opus and AAC and
resamples to the context rate; PCM is not supported.

`FileAudioPlayer(context, { sampleRate?, channels? })` -
`init(codec, sampleRate, channels, description?)`,
`decode(data, timestamp, duration)`, and the same playback controls.

### `BasePlayer<TState>`

Both players extend `BasePlayer`, which supplies `state`, `setState()`, the
`on`/`off`/`emit` plumbing and logger configuration (`BasePlayerConfig` is just
`{ debugLogging?: boolean }`). Extend it if you are building a player of your own:

```typescript
import { BasePlayer } from '@stinkycomputing/web-live-player';

type MyState = 'idle' | 'running';

class MyPlayer extends BasePlayer<MyState> {
  constructor() { super('idle', false); }
  dispose() { this.clearEventHandlers(); }
}
```

### `FrameScheduler<T>`

The buffering and drift-correction engine, generic over the frame type.

```typescript
const scheduler = new FrameScheduler<VideoFrame>({   // SchedulerConfig<VideoFrame>
  bufferDelayMs: 100,            // 0 = bypass mode, always newest frame
  maxBufferSize,                 // default: max(30, 2x buffer delay at 60fps)
  driftCheckInterval: 150,       // dequeues between drift checks
  driftCorrectionThresholdMs: 30,
  logger: (msg) => {},
  onFrameDropped: (frame, reason) => frame.close(),   // 'overflow' | 'skip'
});

scheduler.enqueueFrame(frame, timestampUs, arrivalTime, decodeTime, isKeyframe);
const frame = scheduler.dequeue(performance.now());
```

`enqueue(frame, timestampUs, timing, isKeyframe?)` takes a `FrameTiming` object
instead; `enqueueFrame` is the allocation-free variant. Also exposes
`getStatus(): SchedulerStatus`, `getLatencyStats()`, `getPacketTimingHistory()`,
`setBufferDelay()`, `getBufferDelay()`, `clear()`, `resetStats()` and `logStatus()`.

**You must close dropped frames** in `onFrameDropped` - the scheduler never closes
them itself. `clear()` reports every buffered frame through the same callback.

## Capture and Publishing

The capture module encodes camera and microphone with WebCodecs in workers and
publishes Sesame wire-protocol packets through a **sink**. Requires
`MediaStreamTrackProcessor` (Chromium) and a secure context.

```typescript
import {
  createMediaCapture,
  createMoQSink,
  CodecType,
} from '@stinkycomputing/web-live-player';

const sink = createMoQSink({
  relayUrl: 'https://moq-relay.example.com',
  namespace: 'live/stream',
  videoTrack: { trackName: 'video', priority: 1 },
  audioTrack: { trackName: 'audio', priority: 2 },
});

const capture = createMediaCapture({   // MediaCaptureConfig
  video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: true,
  videoEncoder: {
    codec: CodecType.CODEC_TYPE_VIDEO_VP9,
    bitrate: 2_000_000,
    keyFrameInterval: 60,
  },
  audioEncoder: {
    codec: CodecType.CODEC_TYPE_AUDIO_OPUS,
    bitrate: 128_000,
  },
  audioLevelMonitoring: true,
  sink,
});

capture.on('state-change', (state) => console.log(state));
capture.on('error', (error) => console.error(error));

await capture.start();     // prompts for permissions, connects the sink, starts encoding
// ...
await capture.stop();
capture.dispose();         // also disposes the sink
```

`start()` rejects if the encoders fail to configure, so a rejected promise means
nothing is being published.

### Capture configuration

`MediaCaptureConfig` extends `CaptureConfig` with the sink and routing fields:

- `video` / `audio`: `boolean | MediaTrackConstraints` - What to capture. `true` uses the defaults (1920x1080@30, 48kHz stereo). At least one is required.
- `videoEncoder`: `{ codec, width?, height?, bitrate?, frameRate?, keyFrameInterval?, latencyMode? }` - Defaults to VP9, 2 Mbps, 30fps, keyframe every 60 frames, `'realtime'`. Dimensions come from the actual track settings.
- `audioEncoder`: `{ codec, sampleRate?, channels?, bitrate?, latencyMode? }` - Defaults to Opus, 48kHz stereo, 128 kbps.
- `audioLevelMonitoring`: `boolean` - Emit `'audio-levels'` (default: `false`)
- `audioLevelInterval`: `number` - Minimum ms between level events (default: `50`)
- `statsInterval`: `number` - How often `'stats'` is emitted and bitrates are recomputed, in ms (default: `1000`)
- `sink`: `ICaptureSink` - Required transport
- `topic`: `string` - Written to the packet's routing metadata
- `audioTimestampOffset`: `number` - Microseconds added to audio timestamps, to align A/V

Codecs come from `CodecType`. Supported for capture: VP8, VP9, H.264 (AVC), HEVC,
AV1, Opus and AAC. The wire header advertises the codec you configured, along with
profile and level for H.264. PCM is rejected.

H.264 and HEVC are encoded as Annex B, which is what the player expects for live
streams.

### Capture API

- `start()` / `stop()` - Begin and end capture. `stop()` releases the media tracks.
- `pause()` / `resume()` - Stop and restart publishing without tearing anything down. Encoding continues while paused, so timestamps stay continuous and the camera permission stays live; encoded chunks are simply not handed to the sink, and they are not counted in stats. `resume()` requests a keyframe so the receiver recovers immediately.
- `requestKeyframe()` - Force a keyframe on the next encoded frame. Sinks call this when a subscriber joins or the server asks.
- `getState(): CaptureState` - `'idle' | 'initializing' | 'capturing' | 'paused' | 'stopped' | 'error'`
- `getStats(): CaptureStats` - `videoFramesEncoded`, `audioFramesEncoded`, `bytesSent`, `packetsSent`, `videoBitrate`, `audioBitrate`, `startTime`, `duration`. Frame and byte counters are cumulative across start/stop cycles; the bitrates are bits per second measured over the last `statsInterval`, counting encoded payload without wire framing. Poll it, or subscribe to `'stats'`.
- `getMediaStream(): MediaStream | undefined` - The captured stream, for a local preview
- `setMoQSession(session)` - Inject an existing `MoqSessionBroadcaster` into a MoQ sink
- `dispose()` - Release everything, including the sink
- `MediaCapture.hasMediaDevices()` / `MediaCapture.getDevices()` - Static device helpers

Events: `'state-change'` (`CaptureState`), `'stats'` (`CaptureStats`, every
`statsInterval` while capturing), `'audio-levels'`
(`{ timestamp, levels: number[] }`, per-channel RMS), `'error'` (`Error`).

### Sinks

`createWebSocketSink(config)` → `WebSocketCaptureSink`. Config
(`WebSocketSinkConfig`): `url`, `connectionTimeout` (default `5000`),
`autoReconnect`, `reconnectDelay` (default `3000`). Sends each packet as a binary
message, and treats an inbound text message containing `keyframe` as a keyframe
request.

`createMoQSink(config)` → `MoQCaptureSink`. Config (`MoQSinkConfig`): `relayUrl`
and `namespace` (or an existing `session`), `videoTrack` / `audioTrack` /
`dataTracks` (each a `MoQTrackConfig`), `reconnectionDelay`. Starts a new MoQ
group on each keyframe, bundles 50 audio frames per group, and requests a keyframe
when a subscriber asks for the video track. `sendData(trackName, bytes)` publishes
on a data track, and `setMoQSession(session)` swaps in an external broadcaster
(which the sink will not dispose).

Implement `ICaptureSink` - or extend `BaseCaptureSink` - for another transport:

```typescript
import { BaseCaptureSink } from '@stinkycomputing/web-live-player';
import type { SerializedPacket } from '@stinkycomputing/web-live-player';

class MySink extends BaseCaptureSink {
  async connect() { this._connected = true; }
  async disconnect() { this._connected = false; }

  send(packet: SerializedPacket) {
    // packet: { data: ArrayBuffer, isKeyframe, timestamp, type: 'video' | 'audio' }
    myTransport.send(packet.data);
  }

  // Call this.requestKeyframe() when the far end needs a fresh keyframe
}
```

`BaseCaptureSink` provides `connected`, `reconnect()`, `onKeyframeRequest()`,
`requestKeyframe()` and a `dispose()` that disconnects. Its constructor takes a
`CaptureSinkConfig` (`video?: VideoStreamConfig`, `audio?: AudioStreamConfig`,
`topic?`, `audioTimestampOffset?`).

`MediaCapture` drives a `MediaStreamEncoder` internally, which owns the encoder
workers and emits `'chunk'`, `'audio-levels'`, `'error'` and `'ready'` to
`EncoderEventHandler` callbacks. Use it directly if you want encoded chunks without
a sink. Handlers registered on `MediaCapture` are `CaptureEventHandler`s.

## MoQ Session Injection

Both directions accept an externally created MoQ session, which is what you want
when a single connection is shared between components, when a framework hands you
its own session object, or when you need control over the connection's lifetime.

### Playback

| Approach | Who owns the source |
|----------|---------------------|
| `await player.connectToMoQRelay(url, namespace, opts)` | The player. It builds a `MoQSource`, connects it, and disposes it on `dispose()`. It returns the source so you can tear it down earlier. |
| `player.setStreamSource(source)` | You. The player unsubscribes on `dispose()` but never disposes your source. |
| `player.connectToMoQSession(session, videoTrackName?)` | You. A thin wrapper over `setStreamSource()` plus an optional `setTrackFilter()`. |

Anything implementing `IStreamSource` can be injected, including sessions supplied
by other frameworks - Elmo's `MoQSessionNode` implements it directly:

```typescript
const player = createPlayer({ enableAudio: true });

player.connectToMoQSession(elmoSessionNode, 'video');
await elmoSessionNode.connect();
player.play();
```

Replacing an injected source with `setStreamSource()` again just re-subscribes; if
the player owned the previous source it disposes it first.

### Capture

`MoQCaptureSink` creates its own `MoqSessionBroadcaster` unless you supply one.
There are three ways to supply it, all equivalent:

```typescript
import { MoqSessionBroadcaster } from 'stinky-moq-js';
import { createMoQSink, createMediaCapture, CodecType } from '@stinkycomputing/web-live-player';

const session = new MoqSessionBroadcaster(
  { relayUrl: 'https://relay.example.com/moq', namespace: 'my-stream' },
  [
    { trackName: 'video', priority: 1, type: 'video' },
    { trackName: 'audio', priority: 2, type: 'audio' },
  ]
);
await session.connect();

// 1. At construction - relayUrl and namespace are then unnecessary
const sink = createMoQSink({
  session,
  videoTrack: { trackName: 'video' },
  audioTrack: { trackName: 'audio' },
});

// 2. Afterwards, on the sink
sink.setMoQSession(session);

// 3. Afterwards, through the capture (throws if the sink isn't a MoQ sink)
const capture = createMediaCapture({ sink, video: true, audio: true });
capture.setMoQSession(session);
```

**Ownership:** a session the sink created is connected and disposed by the sink. An
injected session is never disposed by the sink - `disconnect()` and `dispose()`
detach from it and leave it running, so closing it stays your responsibility.

MoQ normally needs separate sessions for broadcasting and subscribing, so sharing
one instance across capture and playback only works with a unified session object
such as Elmo's `MoQSessionNode`. Otherwise pair a `MoqSessionBroadcaster` for
capture with a `MoQSource` for playback against the same relay and namespace.

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
    // Update texture with the VideoFrame - valid until the next getVideoFrame()
    texture.image = frame;
    texture.needsUpdate = true;
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
}
```

If you need raw YUV data for custom processing, you can access the `WasmDecoder` directly - see [Decoders](#wasmdecoder).

### Best Practices

1. **Don't close frames from `getVideoFrame()`** - the player owns them and closes each one when the next is due. They are valid until the following call; `clone()` if you need to keep one, and close the clone yourself. The same applies to frames delivered by the `'frame'` event, which are only valid for the duration of the handler.
2. **Check for null frames** - `getVideoFrame()` returns null when no frame is ready
3. **Use performance.now()** - Pass accurate timestamps for proper frame scheduling
4. **Handle resize** - Update canvas dimensions when video dimensions change
5. **Call `dispose()`** - Decoders, workers, audio contexts and buffered frames are not released by garbage collection alone


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

### Peer dependencies

`mp4box`, `tinyh264`, `stinky-moq-js` and `@stinkycomputing/sesame-api-client` stay
external in the published bundle, so your bundler resolves them from
`node_modules`. `stinky-moq-js` is imported dynamically, so bundlers can split MoQ
out of the initial chunk for apps that never use it.

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

Type-check and test:

```bash
npm run typecheck
npm test
```

## License

MIT
