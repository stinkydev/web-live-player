# Changelog

All notable changes to this project are documented here.

## Unreleased

### Changed

These are visible to integrators - check them before upgrading.

- **The Sesame client dependency is a range** (`>=1.9.0-alpha.1 <2`) instead of an
  exact pin, so the player shares the host application's copy. 1.9 parses frame side
  data (`MediaFrameData.side_data`), which the WebSocket source now passes through in
  the parsed frame header. No API change.
- **The Sesame client dependency is a range** (`>=1.9.0-alpha.1 <2`) instead of an
  exact pin, so the player shares the host application's copy. 1.9 parses frame side
  data (`MediaFrameData.side_data`), which the WebSocket source now passes through in
  the parsed frame header. No API change.
- **Frame ownership is now explicit.** Frames from `getVideoFrame()` are owned by the
  player and closed when the next frame is due; frames delivered by the `'frame'`
  event are only valid for the duration of the handler. The documentation previously
  told callers to close them, which could leave the player drawing from a closed
  frame. No code changed - but if you were calling `frame.close()` on a frame the
  player returned, remove it, and `clone()` instead when you need to retain one.
- **Capture advertises the codec it actually encoded.** The wire header was
  hardcoded to VP9 for video and Opus for audio regardless of configuration, so any
  non-default codec produced a stream the receiver could not decode. H.264 profile
  and level are now reported too, instead of zeros. If you worked around the old
  behavior on the receiving side, stop.
- **`MediaCapture.start()` rejects when the encoders fail to configure.** It
  previously resolved after a fixed 100ms and reported state `'capturing'` with a
  dead encoder. A rejected promise now means nothing is being published.
- **`FileVideoPlayer.play()` after `'ended'` restarts from the beginning.** It
  previously re-entered the end condition immediately and emitted `'ended'` again.
- **File playback bounds its decode-ahead** to `maxBufferedFrames` (new option,
  default 60) instead of decoding the whole file eagerly.
- **`connectToMoQRelay()` returns the `IStreamSource` it created**, and the player
  now disposes that source on `dispose()`. Previously the source was unreachable and
  its connection outlived the player. Sources passed to `setStreamSource()` or
  `connectToMoQSession()` are still owned by the caller and are only unsubscribed.
- **`codecTypeToString(CODEC_TYPE_AUDIO_PCM)` throws** instead of returning `'pcm'`,
  which is not a valid WebCodecs codec string and failed later at `configure()`.
- Live audio timestamps are rescaled to microseconds using the audio codec's
  timebase, matching how video timestamps are handled.
- `LiveVideoPlayer.dispose()` delivers its final `'statechange'` before clearing
  event handlers, so subscribers see the transition to `'idle'`.
- Video packets dropped by the track-name filter now log a one-time warning per
  track, naming the track seen and the one expected. This is the usual cause of a
  silent black screen with `WebSocketSource`, which labels tracks by stream ID.

### Removed

- `sources/standalone-moq-source.ts` - a byte-identical duplicate of
  `sources/moq-source.ts` that was never exported or imported.
- `MOQSESSION_INJECTION.md` - folded into the README's "MoQ Session Injection"
  section. The standalone file documented methods that no longer existed
  (`player.start(canvas)`, `player.disconnect()`), the wrong package name, codecs as
  strings rather than `CodecType`, and an outdated `IStreamSource` shape.

### Fixed

- **File playback decoded entire files into memory.** Nothing bounded the decoded
  frame buffer, so the decoder ran to end of file regardless of playback position -
  roughly 2.7 GB of video memory for 30 seconds of 1080p.
- **The WASM decoder submitted whole access units to a decoder that consumes one NAL
  per call.** Everything after the first NAL was discarded, so a keyframe arriving as
  SPS+PPS+IDR in one packet produced no picture at all. Packets are now split on
  Annex B start codes and submitted NAL by NAL.
- **The WASM decoder paired timestamps by position.** Any packet that produced no
  picture permanently offset the queue, giving every later frame the wrong
  timestamp. The presentation timestamp now travels with the picture out of the
  worker.
- The WASM decoder ignored `maxQueueSize`/`onQueueOverflow` (no backpressure), could
  corrupt worker memory with NALs larger than its 1 MB scratch buffer, and left
  in-flight pictures to arrive after `flush()` with timestamp 0.
- **`keyFrameInterval` was ignored** - the video encoder worker read `gopSize` from
  the wrong field of the init message and always used 60.
- **Audio level meters were wrong for planar stereo.** Levels were computed as if
  plane 0 were interleaved, which is not the layout Chromium's
  `MediaStreamTrackProcessor` produces.
- **MP4 range loading truncated to the first 4 MB** when the server reported neither
  `Content-Length` nor `Content-Range`, and reported success. End of file is now
  detected from a short chunk or a 416 response.
- `MP4FileSource` crashed on an empty sample batch, and `onEnded` fired repeatedly
  once the last batch was reached.
- The MoQ capture sink accumulated duplicate session listeners on every reconnect or
  session swap, multiplying keyframe requests, and disposed an owned session twice.
- Audio frames arriving while the live audio player was initializing were dropped;
  up to 32 are now queued and drained once it is running.
- A failed audio init left a dead player attached and an unhandled promise
  rejection; it now logs, cleans up, and retries on the next packet.
- A throw during decoder configuration could leave `isConfiguring` set, queueing
  video frames indefinitely.
- `FileVideoPlayer` could emit non-`Error` values on `'error'`, and `dispose()` left
  a pending `waitForBuffer()` promise unresolved across reloads.
- `FrameScheduler` skipped drift correction when the sync point was exactly 0.
- `FrameScheduler` constructed with `maxBufferSize: 0` (or negative) span forever in
  `enqueue()` - the overflow loop could never drain a zero-capacity buffer. The size
  is now floored at 1.
- Audio initialization could wedge permanently: `new AudioContext()` and the
  `LiveAudioPlayer` constructor ran outside the try block, so a failure there (the
  browser's context limit, or a closed context) left `audioInitializing` stuck true -
  queueing every later audio frame - and surfaced as an unhandled rejection.
- The MoQ capture sink left its session listeners attached on `disconnect()` when the
  session was injected, so a later `'stateChange'` could flip the sink back to
  connected and resume publishing after the caller disconnected.
- Decoder reconfiguration and audio initialization are fired without awaiting; both
  now attach a `.catch()`, so a throw during decoder construction (which happens
  outside `configureDecoder`'s own try) reports an error and resets the pipeline flags
  instead of becoming an unhandled rejection.
- The packet timing ring is cleared on codec reconfiguration, so a frame decoded after
  a PTS reset can't be matched against a stale entry and reported with the wrong
  arrival time.
- `WebSocketSource` cleanup and MoQ dependency updates from earlier work are
  unaffected; `rescaleTime`'s fast path now rejects non-safe integers so it can only
  return exact results.

### Performance

No API changes; the live path no longer allocates per frame.

- `FrameScheduler` uses preallocated ring buffers for frames, packet history,
  latency history and buffer-size history, with running sums instead of repeated
  `reduce` passes, and no `shift()` on any path.
- The live player replaced two per-frame `Map` insertions (and a 100-entry array
  rebuild on every frame) with a fixed typed-array timing ring.
- `rescaleTime` uses `Number` arithmetic and falls back to `BigInt` only when an
  intermediate would exceed 2^53; codec timebases are cached, and the microsecond
  timebase is a shared constant.
- WASM I420 frames go straight to `VideoFrame` when their planes are contiguous,
  removing a full-frame repack (~3 MB per frame at 1080p); the strided fallback
  reuses one staging buffer.
- Both audio players copy directly into channel buffers, cache planar detection
  instead of throwing per frame, and reuse a de-interleaving buffer. The worklets use
  `TypedArray.set`/`fill` instead of per-sample loops.
- Single-argument events avoid the rest-array allocation via `emit1`, and per-frame
  debug templates are only built when debug logging is on.

### Added

- `FilePlayerConfig.maxBufferedFrames` - bound on decoded frames held ahead of the
  playback position (default 60).
- `FrameScheduler.enqueueFrame(frame, timestampUs, arrivalTime, decodeTime, isKeyframe?)` -
  allocation-free alternative to `enqueue()`.
- `YUVFrame.data` - the contiguous I420 buffer behind the plane views, when the
  planes are contiguous, so consumers can skip repacking.
- `IVideoDecoder.decodeBinary(data, timestampUs?)` - accepts a pre-rescaled
  timestamp so the rescale isn't repeated per frame.
- `MediaStreamEncoder.hasEncoders` and `parseProfileLevel()` in the capture module.
- `MediaCapture.pause()` / `resume()` - stop and restart publishing without tearing
  down the encoders, media stream or sink. Encoding continues while paused so
  timestamps stay continuous; `resume()` requests a keyframe. This makes the
  previously unreachable `'paused'` capture state real.
- `MediaCapture` now emits `'stats'` on an interval (`CaptureConfig.statsInterval`,
  default 1000ms) - the event was previously declared but never fired.
- `CaptureStats.videoBitrate` and `audioBitrate` are now measured in bits per second
  over the last stats interval, instead of always reporting `0`.
- `CaptureConfig.statsInterval`.
- Documentation: requirements and feature detection, stream requirements (Annex B,
  track-name matching), a WebSocket source guide, a capture and publishing guide,
  a MoQ session injection guide, statistics reference, and API reference entries for
  every exported symbol.
- `CHANGELOG.md` is now included in the published package.
- Tests: PTS rescaling against exact BigInt math, Annex B NAL splitting, frame
  scheduler ring reuse and packet history, MP4 loading with an unknown file size, and
  capture bitrate measurement and pause gating.

## 0.1.16

- Add volume control to `FileVideoPlayer` and `LiveVideoPlayer`.

## 0.1.15

- Add video and data byte statistics to the player UI and API.
- Fix WebSocket cleanup, bump the Sesame dependency, and externalize `mp4box` and
  `tinyh264` in the library build.

## 0.1.14

- Bump `sesame-api-client` to 1.5.0-alpha.8.
- Support an external `AudioContext` via `PlayerConfig.audioContext`.
