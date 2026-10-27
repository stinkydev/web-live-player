# Changelog

All notable changes to this project are documented here.

## Unreleased

### Fixed

- **A backlog inside the decoder no longer holds the latency up for good.** A `VideoDecoder`
  can take chunks in as they come and still hold them up: stalled, or unable to put out a frame
  until the player lets one go. `decodeQueueSize` stops counting a chunk once it is taken in, so
  the four-at-a-time limit did not keep the backlog in the player, where it can be let go. Its
  frames came out as late as the delay allowed, counted towards the video's minimum delay, and
  the delay rose to cover them: in a test, one 1.7 s stall left the picture 1.7 s behind for
  good, the overlay showing the delay "needed" by the video. The decoder now holds at most 20
  frames from chunk in to frame out (the four it is given at a time and the 16 H.264 may keep
  back to reorder; `maxFramesInDecoder` and `framesInDecoder` on `WebCodecsDecoder`), and the
  rest wait in the player. The decoder's latency is measured from when a chunk goes into it, so
  every frame counts, whatever it waited before, and a stall's latency is gone from the minimum
  delay within about 60 frames (before, a minimum raised by turning the screen off could stay
  for minutes, as frames that had waited never counted). A backlog in the player is skipped at a
  keyframe once it has made frames late, the time decoding takes included, for half a second
  without a break: the chunk or two a decoder leaves waiting now and then no longer set off a
  skip, and a keyframe request, at every keyframe. A decoder held full for longer than the delay
  asked for is restarted at a keyframe, at most every 30 s. Frames decoded while a decoder
  starts up no longer count towards the minimum delay. The WASM decoder is handled the same way:
  its worker decodes one picture at a time, so the rest of its queue counts as waiting
  (`IVideoDecoder` gains `framesInDecoder`, `outputStartedAt` and `starting`).

- **The live decoder is configured for low latency.** It was given `latencyMode: 'realtime'`, an
  encoder option the decoder ignores, so it could keep frames back (frame-threaded software
  decoding, for one). It now gets `optimizeForLatency: true`. The global `VideoDecoderConfig`
  augmentation adding `latencyMode` is gone.

## 0.2.4

### Fixed

- **Short decoder stalls no longer add up to a latency that never comes down.** A backlog
  shorter than the skip limit counted towards the video's minimum delay, the higher delay raised
  the skip limit with it, and each stall below the limit (a busy main thread, a garbage
  collection) added to the latency for good: in a test, a 200 ms stall and one of 60 ms every
  two seconds took it to 1.9 s within a minute. Frames that wait behind others no longer count
  towards the minimum delay, and a backlog longer than the delay is skipped at the next keyframe,
  without the 250 ms floor a decoder restart needed.

## 0.2.3

### Fixed

- **A decoder that falls behind catches up without stalling every keyframe.** 0.2.2 restarted a
  decoder holding more than the delay's worth of frames at the next keyframe. A hardware decoder
  takes about half a second to start up again, and the frames arriving meanwhile left it behind
  once more, so the picture held for half a second at every keyframe until the page was
  reloaded. The live player now gives the decoder four chunks at a time and keeps the rest
  itself (`maxInDecoder` on `WebCodecsDecoder`). A backlog longer than the delay is let go at
  the next keyframe without restarting the decoder, and a keyframe is asked of the source to
  shorten the wait. A full queue at a keyframe no longer restarts the decoder either.

## 0.2.2

### Fixed

- **Switching away from the tab no longer leaves the video seconds behind for good.** Chrome
  stops the video decoder in a hidden tab while packets keep arriving. Back in view, the
  decoder only kept pace with its backlog, and the backlog's decode latency raised the delay
  the picture was given, so it never caught up. A decoder holding more than the buffer delay's
  worth of frames (at least 250 ms) now restarts from the next keyframe, and frames decoded
  behind a backlog or in a hidden tab no longer count towards the video's minimum delay.

## 0.2.1

### Fixed

- **Audio steps exactly on wall-clock timelines.** Streams from `MediaCapture` are stamped on the
  wall clock, which puts the worklet's read position near 1e14 samples - where a double cannot
  hold the fraction of a resampling step. On a 44.1 kHz device audio ran 0.5% fast and the
  follower's corrections came in coarse 1.4% jumps. The read position is now a whole sample and
  a fraction.
- **A gap in the audio no longer throws away the audio before it.** Restarting the decoder at a
  gap discarded what it still held, so a burst of packets (a subscription's backlog, a file's
  feed) lost everything before the gap. The decoder now finishes what it holds first, and
  packets arriving meanwhile wait in order. A seek still discards at once.
- **40 and 60 ms Opus packets are no longer taken for gaps.** Packet length was assumed to be
  20 ms until something decoded; it is now read from the Opus header (or the AAC frame size),
  or taken from the duration given.
- **A buffer delay of seconds keeps its audio.** The worklet's ring held 2.7 s and dropped audio
  written further ahead; it now grows (up to 43 s at 48 kHz).
- **Long buffer delays keep their video.** The live player held at most 30 decoded frames, so
  at 50 fps a delay of 1 s dropped frames before their turn and the picture froze. The queue now
  holds what the clock's delay spans at the stream's frame rate (up to 240 frames).
- **Two seeks during one fade-out go to the second**, rather than adding up.
- **`MediaCapture` drop counts carry over a stop and a start**, like its other counters.
- **MP4 duration follows the edit list**, so a file with a leading empty edit plays to its end
  and loops at the right point.
- **A video player sees audio played separately on its clock.** It knew only audio of its own, so
  with a separate `LiveAudioPlayer` on its clock (elmo's live audio) `SyncStats.audio` and
  `avSyncMs` were null and the stats overlay showed no audio. A `LiveAudioPlayer` now makes
  itself known to its clock, and a video player without audio of its own uses that.

### Changed

- `LiveAudioPlayer.decode()` requires a timestamp: a packet without one cannot be placed and is
  dropped (with a warning, once). The old fallback could never start.

### Added

- `presentationDurationS()`, the edit list's presentation duration.
- `LiveClock.addAudio()` / `removeAudio()` / `getAudio()` and the `ClockAudio` type.

## 0.2.0

Live playback is rebuilt around a clock that audio and video share. See "Timing and A/V Sync"
in the README.

### Breaking

- **`FrameScheduler` is gone.** The live player keeps to a `LiveClock` instead, buffering
  decoded frames in a `VideoFrameQueue` with statistics in `PlaybackStats`.
  `FrameScheduler`, `FrameTiming`, `SchedulerStatus`, `SchedulerConfig` and `DropReason` are
  removed; `LatencyStats` and `PacketTimingEntry` are still exported.
- **`FileAudioPlayer` takes a clock.** `new FileAudioPlayer(context, { clock })`, timestamps in
  microseconds on the clock's timeline; `resetTiming()` is removed, `resync()` added.
- **`LiveAudioPlayer` is rewritten.** `decode(payload, ptsUs)` takes the timestamp in
  microseconds, and it now matters - the old player ignored it. `decodeFrame(frame)` takes a
  parsed packet with its timestamp in the timebase of the codec data given to `init()`.
  `resetTiming()` is removed. Pass `{ clock }` to play in sync with a video player.
- **Audio waits for `play()`, and `pause()` mutes it.** The live player used to start audio as
  soon as it arrived and keep it playing while paused.
- **`bufferDelayMs` defaults to 150 and means a delay behind the earliest-arriving packets.**
  Data later than that is dropped, so latency stays where it is set. `0` still shows each
  frame as soon as it decodes; audio then plays 50 ms behind, out of sync.
- **`getVideoFrame()` no longer uses its argument.** It picks the frame due when the frame will
  be on screen, by default 1.5 render intervals after the call (`displayLatencyMs`), so render
  loops on a timeline of their own (a fixed frame rate) get the right frame.

### Fixed

- **Audio and video play in sync.** They used to share nothing but the buffer delay setting:
  audio played its chunks back to back as they arrived, its timestamps ignored, with latency
  anywhere between nothing and the delay plus 100 ms, while video corrected its own clock with a
  freeze or a skip every few seconds. Both now present what one clock says is due, the audio
  heard (output latency included) checked against it every 20 ms. Measured with a flash and a
  beep sharing a timestamp: within about 11 ms of each other at the screen and the speakers.
- **Audio no longer drifts on 44.1 kHz devices.** Resampling each chunk on its own dropped a
  sample at every boundary: 48 kHz Opus ran 68 ms a minute fast, AAC 51 ms. One continuous read
  now converts the rate, and the audio device's own drift is learned and taken out.
- **Playback starts at the buffer delay.** Video used to start on its first frame and reach the
  delay about three seconds later, with a freeze.
- **The backlog a subscription opens with is no longer shown.** A relay hands a new subscriber
  the current group from its start, up to a GOP of old frames; video started that far behind
  the live edge and caught up with a skip. It is now decoded but not shown.
- **Streams published with `MediaCapture` carry their timestamps.** The pts was written as a
  bigint, which the wire serializer writes as 0, so every packet went out stamped 0.
- **`MediaCapture` puts audio and video on one clock.** The browser stamps each captured track
  on a clock of its own; in Chrome the camera's and the microphone's are hours apart (one counts
  from system start), so a player keeping to timestamps could not play them together - the new
  one dropped all the audio as late. The encoder workers now map each track onto the wall clock
  as frames are delivered: the published tracks line up within a few tens of milliseconds, and
  follow a capture clock that drifts.
- **A capture encoder that falls behind drops frames instead of queueing them**, so latency and
  memory no longer grow without bound. `CaptureStats` counts them in `videoFramesDropped` and
  `audioFramesDropped`.
- **The video encoder worker closes every frame it is handed**, including those arriving before
  the encoder is configured, which leaked.
- **File playback keeps audio and video in sync.** `FileVideoPlayer` timed video by the system
  clock and played audio as a queue of chunks, so the two only started together: every pause
  moved the audio ahead by up to a frame, an underrun or a background tab moved it for good, the
  100-chunk worklet queue silently dropped audio of 20 ms chunks, and 48 kHz AAC on a 44.1 kHz
  device ran 51 ms a minute ahead. It now plays both on a `MediaClock`, the audio keeping to it
  like live audio does. Measured with flash-and-beep files: within 20 ms at the screen through
  pauses, seeks and loops, at 44.1 and 48 kHz.
- **MP4 edit lists are applied.** Files with B-frames start their video a few frames into the
  media and AAC files skip the encoder's priming, both through the edit list; ignored, video
  showed 67 ms late and audio 21 ms early in a typical ffmpeg file.
- **Opus in MP4 plays.** mp4box names the codec `'Opus'`, which WebCodecs rejects; the track had
  no audio.
- **A seek lands on the requested time**, not on the keyframe before it, and drops no audio:
  the audio decoder restarts at the new position instead of playing what it held first.
- **A file in a background tab keeps its audio**, and its picture catches up from a keyframe on
  return instead of decoding its way through.
- **Decoded audio keeps its timestamps across a gap.** Chrome's `AudioDecoder` stamps its output
  by counting samples from the first chunk, so after packets were lost or skipped every chunk
  came out early by the gap. The decoder restarts at a gap.
- **A small buffer delay no longer breaks audio or sync.** The audio output renders ahead of what
  is heard (40-60 ms in Chrome) and the video decoder takes its time, both before any network
  jitter: below those, audio chunks were dropped and video showed late. Each player now reports
  what it needs to its clock (`setMinimumDelay`), and the clock runs at the larger of the buffer
  delay and that. Network lateness never raises it.

### Added

- `LiveClock` and the `clock` option of `LiveVideoPlayer` and `LiveAudioPlayer`: players of one
  stream owned separately stay in sync by sharing one.
- `audioDestination` and `displayLatencyMs` player options, `getClock()`, and `getStats().sync`
  (`SyncStats`): the clock's state, the measured A/V offset, late frames and the audio player's
  `LiveAudioStats`.
- `LiveAudioPlayer`: `destination` and `trackKey` options, `getStats()`, `audiblePtsAt()`.
- `FileVideoPlayer`: `audioDestination` and `displayLatencyMs` options; `getStats().audio`.
- `MediaClock`, and `editListOffsetUs()` for the edit list arithmetic.
- `MediaCapture`: `mediaStream` option, to capture a stream of your own (a canvas, a screen)
  instead of the camera and microphone.
- A/V sync test demo (`demo/sync`): publishes a flash-and-beep test pattern - directly, or
  through `MediaCapture` - and measures lip sync of it, or of any flash-and-beep stream, at the
  screen and the speakers.
- `StatsOverlay`: a diagnostic panel for a `LiveVideoPlayer`, drawn into a canvas of its own -
  the delay asked for and the one the clock runs at, what video and audio need, latency, network
  jitter, A/V sync and late frames, over a graph of when each frame was ready against when it
  had to be. The player demo has it as a checkbox.
- `LiveClock.setMinimumDelay()` / `clearMinimumDelay()` / `getEffectiveDelay()`; `SyncStats`
  gains `effectiveDelayMs`, `minimumDelayMs`, `videoMinimumDelayMs` and `displayLeadMs`, the
  audio stats `outputLeadMs` and `minimumDelayMs`, and `PacketTimingEntry` `latenessMs`.

### Changed

- The live player creates its `AudioContext` when audio first arrives, so a stream without audio
  never makes one.
- The audio worklet is TypeScript, bundled into the library as a string by
  `vite-plugin-worklet.ts`. Its processor is registered as `live-audio-playout`.

## 0.1.30

### Fixed

- **A publisher restart no longer leaves the player dropping frames.** When Sesame is
  stopped and started again the stream's timestamps start over, but the frame scheduler
  kept the real-time-to-stream-time mapping it had built for the old run. Against it every
  new frame was hours late, so each render took the newest frame and dropped the rest: the
  picture kept moving but the jitter buffer was gone, and any burst of frames turned into
  drops for the rest of the session. The scheduler now treats a timestamp that steps
  backwards, or jumps ahead by more than a second, as a new timeline: it drops what it has
  buffered (reported to `onFrameDropped` with the new reason `'discontinuity'`) and
  re-syncs from the next frame. `DropReason` is exported for callers that switch on the
  reason.

## 0.1.28

### Fixed

- **Memory no longer grows for the life of a MoQ subscription.** `@moq/net` retained
  about 1 KB of promises per frame received, and a copy of every transport chunk, so a
  long session on a low-end device stalled on ever-longer garbage collections.
  stinky-moq-js 0.2.2 ships a patched `@moq/net` and logs its build on load
  (`stinky-moq-js 0.2.2 (built ...)`), which is how to tell a page runs the fixed code.

- **A slow decoder start no longer trips the queue guard.** Until a decoder has produced
  its first frame it is initialising, so a full queue is accepted rather than dropped or
  restarted (a restart would only begin the initialisation again), and the limit is now
  ten seconds of frames.

- **A full decoder queue no longer blacks out playback.** The live player used to
  reset the decoder when its queue passed 10 chunks and then wait for the next keyframe,
  so the group a relay hands a new subscriber up front, or a busy main thread delaying the
  decoder's output callbacks, turned into a freeze lasting a whole GOP, and on a loaded
  page into a permanent one. The limit is now 256 chunks, which a decoder takes in its
  stride; a delta frame that finds the queue full is dropped while the queued frames keep
  showing, and a keyframe that finds it full restarts the decoder from that frame at once.
  Frames that arrived while the decoder was configuring are replayed from the newest
  keyframe among them rather than all of them, and only the newest of them is shown: the
  first picture is the live edge, not a fast-forward through the group.

### Changed

These are visible to integrators - check them before upgrading.

- **`stinky-moq-js` is now `^0.2.0`** (was pinned to 0.1.22). It depends on `@moq/net`, which
  is installed alongside; nothing changes in the player's public API.
- **`MoQSource` mirrors the session state across reconnects.** `stinky-moq-js` 0.2 reconnects
  on its own with backoff, so the source now emits `'disconnected'` when the relay connection
  drops and `'connected'` again once it is back, and `connected` reflects the live state. It
  previously only reported the final disconnect. `connect()` resolves once the relay is
  reached instead of rejecting on a failed first attempt, so a relay that is down shows as a
  pending connection rather than an error.

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
