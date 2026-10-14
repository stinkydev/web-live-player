/**
 * A/V sync test
 *
 * Publisher: a 320x180 VP8 + Opus stream where every 50th frame (once a second) is white and the
 * audio chunk with the same timestamp carries a 1 kHz beep. Both come from one frame counter, so
 * in the stream they are aligned to the sample.
 *
 * Meter: plays the stream back and measures when each flash is drawn and when each beep reaches
 * the audio output. Both are found in the media itself (brightness, level), so any flash-and-beep
 * stream can be measured (from an onset detector between the player and the speakers, mapped
 * to performance time with the context's output timestamp). Their difference is the end-to-end
 * A/V offset; positive means the audio comes late.
 *
 * Capture: publishes camera and microphone through MediaCapture instead, to check the capture
 * pipeline. Its media carries no flash or beep, so only the playback statistics apply.
 *
 * URL parameters (for headless runs): relay, ns, buffer, mode, publish=pattern|capture|off (or
 * 1|0), seconds, autostart=1, debug=1.
 * The summary is logged as `SYNC_RESULT {...}`.
 */

import {
  CodecType,
  WireProtocol,
  sesame,
} from '@stinkycomputing/sesame-api-client';
import {
  createMoQSource,
  LiveAudioPlayer,
  LiveClock,
  LiveVideoPlayer,
  MediaCapture,
  MoQCaptureSink,
  StreamDataEvent,
} from '../../index';
import type { IMediaCodecData } from '@stinkycomputing/sesame-api-client';

const $ = (id: string) => document.getElementById(id)!;
const relayInput = $('relay') as HTMLInputElement;
const nsInput = $('namespace') as HTMLInputElement;
const bufferInput = $('buffer') as HTMLInputElement;
const modeSelect = $('mode') as HTMLSelectElement;
const publishSelect = $('publish') as HTMLSelectElement;
const startButton = $('start') as HTMLButtonElement;
const stopButton = $('stop') as HTMLButtonElement;
const canvas = $('view') as HTMLCanvasElement;
const view = canvas.getContext('2d')!;
const statsEl = $('stats');
const logEl = $('log');

const params = new URLSearchParams(location.search);
relayInput.value = params.get('relay') ?? relayInput.value;
nsInput.value = params.get('ns') ?? `wlp-sync-test-${Math.random().toString(36).slice(2, 8)}`;
bufferInput.value = params.get('buffer') ?? bufferInput.value;
modeSelect.value = params.get('mode') ?? modeSelect.value;
const publishParam = params.get('publish');
publishSelect.value = publishParam === '0' ? 'off' : publishParam === '1' || !publishParam ? 'pattern' : publishParam;
const debug = params.get('debug') === '1';

function log(msg: string) {
  console.log(`SYNC ${msg}`);
  logEl.textContent = `${new Date().toISOString().slice(11, 23)} ${msg}\n${logEl.textContent}`.slice(0, 20000);
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

const FPS = 50;
const FRAME_US = 1_000_000 / FPS;
const SAMPLES_PER_FRAME = 48000 / FPS;   // 960: one Opus frame per video frame
const WIDTH = 320;
const HEIGHT = 180;

class TestPublisher {
  private sink: MoQCaptureSink;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  private draw = this.canvas.getContext('2d')!;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startPerf = 0;
  private baseUs = 0;
  private k = 0;
  private forceKeyframe = true;

  constructor(relayUrl: string, namespace: string) {
    this.sink = new MoQCaptureSink({
      relayUrl,
      namespace,
      videoTrack: { trackName: 'video' },
      audioTrack: { trackName: 'audio' },
    });
    this.sink.onKeyframeRequest(() => { this.forceKeyframe = true; });
  }

  async start(): Promise<void> {
    await this.sink.connect();

    this.videoEncoder = new VideoEncoder({
      output: (chunk) => this.send('video', chunk, chunk.type === 'key'),
      error: (e) => log(`video encoder error: ${e.message}`),
    });
    this.videoEncoder.configure({ codec: 'vp8', width: WIDTH, height: HEIGHT, bitrate: 400_000, framerate: FPS, latencyMode: 'realtime' });

    this.audioEncoder = new AudioEncoder({
      output: (chunk) => this.send('audio', chunk, true),
      error: (e) => log(`audio encoder error: ${e.message}`),
    });
    this.audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 64_000 });

    // Timestamps on whole seconds, so a flash frame is one whose timestamp is
    this.baseUs = Math.ceil(Date.now() / 1000) * 1_000_000;
    this.startPerf = performance.now();
    this.timer = setInterval(() => this.tick(), 5);
    log(`publishing to ${namespace()}`);
  }

  private tick(): void {
    // Everything due by now, paced by the frame counter so the stream never drifts
    while (this.startPerf + (this.k * FRAME_US) / 1000 <= performance.now()) {
      this.produce(this.k++);
    }
  }

  private produce(k: number): void {
    const timestamp = this.baseUs + k * FRAME_US;
    const flash = k % FPS === 0;

    this.draw.fillStyle = flash ? '#fff' : '#203040';
    this.draw.fillRect(0, 0, WIDTH, HEIGHT);
    this.draw.fillStyle = flash ? '#000' : '#4ecdc4';
    this.draw.font = '48px monospace';
    this.draw.fillText(String(k % 1000).padStart(3, '0'), 110, 110);
    const frame = new VideoFrame(this.canvas, { timestamp, duration: FRAME_US });
    const keyFrame = this.forceKeyframe || k % FPS === 0;
    this.forceKeyframe = false;
    this.videoEncoder?.encode(frame, { keyFrame });
    frame.close();

    const samples = new Float32Array(SAMPLES_PER_FRAME * 2);   // planar: left then right
    if (flash) {
      for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
        const v = 0.6 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
        samples[i] = v;
        samples[SAMPLES_PER_FRAME + i] = v;
      }
    }
    const audio = new AudioData({
      format: 'f32-planar', sampleRate: 48000, numberOfFrames: SAMPLES_PER_FRAME, numberOfChannels: 2, timestamp, data: samples,
    });
    this.audioEncoder?.encode(audio);
    audio.close();
  }

  private send(type: 'video' | 'audio', chunk: EncodedVideoChunk | EncodedAudioChunk, keyframe: boolean): void {
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    const codecData: IMediaCodecData = type === 'video'
      ? { codecType: CodecType.CODEC_TYPE_VIDEO_VP8, width: WIDTH, height: HEIGHT, timebaseNum: 1, timebaseDen: 1_000_000 }
      : { codecType: CodecType.CODEC_TYPE_AUDIO_OPUS, sampleRate: 48000, channels: 2, timebaseNum: 1, timebaseDen: 1_000_000 };
    const header: sesame.v1.wire.IFrameHeader = {
      type: type === 'video' ? sesame.v1.wire.FrameType.FRAME_TYPE_VIDEO : sesame.v1.wire.FrameType.FRAME_TYPE_AUDIO,
      media: { pts: chunk.timestamp, keyframe, codecData },
    };
    const packet = WireProtocol.serialize(header, payload);
    if (!packet) return;
    const data = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
    this.sink.send({ data, isKeyframe: keyframe, timestamp: chunk.timestamp, type });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.videoEncoder?.close(); } catch { /* closed */ }
    try { this.audioEncoder?.close(); } catch { /* closed */ }
    await this.sink.disconnect();
    this.sink.dispose();
  }
}

/** Camera and microphone through the library's capture pipeline */
class CapturePublisher {
  private sink: MoQCaptureSink;
  private capture: MediaCapture;

  constructor(relayUrl: string, namespace: string) {
    this.sink = new MoQCaptureSink({
      relayUrl,
      namespace,
      videoTrack: { trackName: 'video' },
      audioTrack: { trackName: 'audio' },
    });
    this.capture = new MediaCapture({
      sink: this.sink,
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
      audio: true,
      videoEncoder: { codec: CodecType.CODEC_TYPE_VIDEO_VP8, bitrate: 800_000, frameRate: 30, keyFrameInterval: 60, latencyMode: 'realtime' },
    });
    this.capture.on('error', (e) => log(`capture error: ${e.message}`));
  }

  async start(): Promise<void> {
    await this.sink.connect();
    await this.capture.start();
    log(`capturing to ${namespace()}`);
  }

  async stop(): Promise<void> {
    const stats = this.capture.getStats();
    log(`capture stats ${JSON.stringify(stats)}`);
    await this.capture.stop();
    this.capture.dispose();
    await this.sink.disconnect();
    this.sink.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------------------------

/**
 * Passes audio through and reports the context time of each beep: a 128-sample block far louder
 * than the running level, timed at the first sample (in it or the block before) above a quarter
 * of its peak.
 */
const DETECTOR_CODE = `
class OnsetDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.level = 0;
    this.prev = new Float32Array(128);
    this.sinceOnset = 1e9;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const ch = input && input.length ? input[0] : null;
    for (let c = 0; c < output.length; c++) {
      if (ch) output[c].set(input[c] || ch); else output[c].fill(0);
    }
    const block = ch || new Float32Array(128);
    let peak = 0;
    for (let i = 0; i < block.length; i++) peak = Math.max(peak, Math.abs(block[i]));
    this.sinceOnset += block.length;
    if (peak > 0.05 && peak > 4 * this.level && this.sinceOnset > sampleRate / 2) {
      const threshold = peak / 4;
      let at = block.length;
      for (let i = 0; i < 128 && at === block.length; i++) if (Math.abs(this.prev[i]) > threshold) at = i - 128;
      for (let i = 0; i < block.length && at === block.length; i++) if (Math.abs(block[i]) > threshold) at = i;
      this.port.postMessage({ onset: currentTime + at / sampleRate });
      this.sinceOnset = 0;
    }
    this.level += 0.01 * (peak - this.level);
    this.prev.set(block);
    return true;
  }
}
registerProcessor('onset-detector', OnsetDetector);
`;

interface Sample { flashPerf: number; frameTs: number }

class Meter {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private detector: AudioWorkletNode | null = null;
  private source = createMoQSource({
    relayUrl: relayInput.value,
    namespace: namespace(),
    subscriptions: [
      { trackName: 'video', streamType: 'video' },
      { trackName: 'audio', streamType: 'audio' },
    ],
  });
  private player: LiveVideoPlayer | null = null;
  private audio: LiveAudioPlayer | null = null;
  private audioCodec: IMediaCodecData | null = null;
  private raf = 0;
  private lastFrame: VideoFrame | null = null;
  private flashes: Sample[] = [];
  private onsets: number[] = [];
  /** Stream timestamp being heard at each onset */
  private onsetPts: number[] = [];
  private offsets: number[] = [];
  /** Beep timestamp minus flash frame timestamp: how the stream itself aligns them */
  private streamOffsets: number[] = [];
  private avSync: number[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private started = performance.now();
  private ticks = 0;
  private thumb = new OffscreenCanvas(32, 18).getContext('2d', { willReadFrequently: true })!;
  private luma = 0;
  private lastFlash = -1e9;

  async start(): Promise<void> {
    const blob = new Blob([DETECTOR_CODE], { type: 'application/javascript' });
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(blob));
    this.detector = new AudioWorkletNode(this.ctx, 'onset-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.detector.connect(this.ctx.destination);
    this.detector.port.onmessage = (e) => this.onOnset(e.data.onset);

    const bufferDelayMs = Number(bufferInput.value);
    if (modeSelect.value === 'shared') {
      // Separately owned players on one clock, the way elmo wires them
      const clock = new LiveClock({ bufferDelayMs, logger: debug ? (m) => log(m) : undefined });
      this.player = new LiveVideoPlayer({ clock, enableAudio: false, debugLogging: debug });
      this.audio = new LiveAudioPlayer(this.ctx, { clock, destination: this.detector, trackKey: 'audio:audio' });
      this.source.on('data', (event: StreamDataEvent) => this.onAudioData(event));
    } else {
      this.player = new LiveVideoPlayer({ bufferDelayMs, audioContext: this.ctx, audioDestination: this.detector, debugLogging: debug });
    }
    this.player.setStreamSource(this.source);
    this.player.play();
    await this.ctx.resume().catch(() => {});
    await this.source.connect();
    log(`playing ${namespace()} (${modeSelect.value}, buffer ${bufferDelayMs} ms), audio context ${this.ctx.state} at ${this.ctx.sampleRate} Hz`);

    const render = (t: number) => {
      this.raf = requestAnimationFrame(render);
      this.render(t);
    };
    this.raf = requestAnimationFrame(render);
    this.statsTimer = setInterval(() => this.showStats(), 1000);
  }

  private async onAudioData(event: StreamDataEvent): Promise<void> {
    if (event.streamType !== 'audio' || !event.data.header) return;
    const codec = event.data.header.media?.codecData;
    if (codec && !this.audioCodec) {
      this.audioCodec = codec;
      await this.audio!.init(codec);
      this.audio!.start();
    }
    this.audio?.decodeFrame(event.data);
  }

  private render(t: number): void {
    const frame = this.player?.getVideoFrame(t) ?? null;
    if (!frame || frame === this.lastFrame) return;
    this.lastFrame = frame;
    view.drawImage(frame, 0, 0, canvas.width, canvas.height);

    // A flash: the middle of the picture gets clearly brighter. Test streams flash the whole
    // frame, or (tjolahopp) a small box in the centre from mid to light grey.
    const w = frame.displayWidth, h = frame.displayHeight;
    this.thumb.drawImage(frame, w * 0.42, h * 0.44, w * 0.16, h * 0.12, 0, 0, 32, 18);
    const pixels = this.thumb.getImageData(0, 0, 32, 18).data;
    let luma = 0;
    for (let i = 0; i < pixels.length; i += 4) luma += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    luma /= (pixels.length / 4) * 255;
    const now = performance.now();
    if (luma > this.luma + 0.12 && now - this.lastFlash > 500) {
      // Drawn now, on screen with the next frame the browser composites
      this.lastFlash = now;
      this.flashes.push({ flashPerf: now, frameTs: frame.timestamp });
      this.match();
    }
    this.luma += 0.1 * (luma - this.luma);
  }

  private onOnset(contextTime: number): void {
    const ts = this.ctx.getOutputTimestamp();
    const perf = ts.contextTime && ts.performanceTime
      ? ts.performanceTime + (contextTime - ts.contextTime) * 1000
      : performance.now() + (contextTime - this.ctx.currentTime + (this.ctx.outputLatency || this.ctx.baseLatency || 0)) * 1000;
    this.onsets.push(perf);
    // The audio keeps to the clock (its error is in the stats), so the clock says what was heard
    this.onsetPts.push(this.player?.getClock().ptsAt(perf) ?? NaN);
    this.match();
  }

  /** Pair flashes and beeps that are less than half a second apart */
  private match(): void {
    while (this.flashes.length && this.onsets.length) {
      const f = this.flashes[0].flashPerf;
      const a = this.onsets[0];
      if (Math.abs(a - f) < 500) {
        this.offsets.push(a - f);
        const beepPts = this.onsetPts[0];
        if (beepPts === beepPts) this.streamOffsets.push((beepPts - this.flashes[0].frameTs) / 1000);
        this.flashes.shift();
        this.onsets.shift();
        this.onsetPts.shift();
      } else if (a < f) {
        this.onsets.shift();
        this.onsetPts.shift();
      } else {
        this.flashes.shift();
      }
    }
  }

  private showStats(): void {
    const s = this.player?.getStats();
    if (!s) return;
    const audio = s.sync.audio ?? this.audio?.getStats() ?? null;
    if (s.sync.avSyncMs !== null) this.avSync.push(s.sync.avSyncMs);
    const items: [string, string][] = [
      ['A/V offset (measured)', this.offsets.length ? `${median(this.offsets).toFixed(1)} ms (n=${this.offsets.length})` : '-'],
      ['A/V offset in the stream', this.streamOffsets.length ? `${median(this.streamOffsets).toFixed(1)} ms` : '-'],
      ['A/V offset (player)', s.sync.avSyncMs !== null ? `${s.sync.avSyncMs} ms` : '-'],
      ['Clock', `${s.sync.clockRunning ? 'running' : 'waiting'}, rate ${s.sync.clockRate.toFixed(4)}, jumps ${s.sync.clockJumps}`],
      ['Video buffer', `${s.bufferMs} ms / ${s.targetBufferMs} ms (${s.bufferSize} frames)`],
      ['Frames', `${s.totalFrames} decoded, ${s.droppedFrames} dropped, ${s.sync.lateFrames} late`],
      ['Audio', audio ? `${audio.state}, buffered ${audio.bufferedMs} ms, err ${audio.syncErrorMs ?? '-'} ms` : '-'],
      ['Audio drops', audio ? `${audio.underrunMs} ms silent, ${audio.lateMs} ms late, ${audio.jumps} jumps, ${audio.gaps} gaps` : '-'],
      ['Latency', s.latency ? `${s.latency.avgTotalLatency} ms arrival to display` : '-'],
    ];
    if (++this.ticks % 5 === 0) log(items.map(([k, v]) => `${k}: ${v}`).join(" | "));
    statsEl.innerHTML = items.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  }

  summary() {
    const s = this.player?.getStats();
    const audio = s?.sync.audio ?? this.audio?.getStats() ?? null;
    return {
      mode: modeSelect.value,
      bufferMs: Number(bufferInput.value),
      seconds: Math.round((performance.now() - this.started) / 1000),
      contextRate: this.ctx.sampleRate,
      contextState: this.ctx.state,
      outputLatencyMs: Math.round((this.ctx.outputLatency || 0) * 1000),
      measured: this.offsets.length ? describe(this.offsets) : null,
      // How far apart the stream itself puts beep and flash, and what playback adds on top
      inStream: this.streamOffsets.length ? describe(this.streamOffsets) : null,
      addedByPlayback: this.streamOffsets.length === this.offsets.length && this.offsets.length
        ? describe(this.offsets.map((o, i) => o - this.streamOffsets[i])) : null,
      playerAvSync: this.avSync.length ? describe(this.avSync) : null,
      video: s && {
        decoded: s.totalFrames, dropped: s.droppedFrames, late: s.sync.lateFrames,
        clockJumps: s.sync.clockJumps, clockRate: s.sync.clockRate, latency: s.latency,
      },
      audio,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.player?.dispose();
    this.audio?.dispose();
    this.source.dispose();
    this.ctx.close();
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function describe(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, mean: Math.round(mean * 10) / 10, min: at(0), p5: at(0.05), median: at(0.5), p95: at(0.95), max: at(1) };
}

function namespace(): string {
  return nsInput.value.trim();
}

// ---------------------------------------------------------------------------------------------

let publisher: TestPublisher | CapturePublisher | null = null;
let meter: Meter | null = null;

async function start() {
  startButton.disabled = true;
  stopButton.disabled = false;
  try {
    if (publishSelect.value === 'pattern') {
      publisher = new TestPublisher(relayInput.value, namespace());
    } else if (publishSelect.value === 'capture') {
      publisher = new CapturePublisher(relayInput.value, namespace());
    }
    await publisher?.start();
    meter = new Meter();
    await meter.start();
  } catch (error) {
    log(`failed: ${error}`);
  }
}

async function stop() {
  const result = meter?.summary();
  if (result) {
    log(`result ${JSON.stringify(result)}`);
    console.log(`SYNC_RESULT ${JSON.stringify(result)}`);
  }
  meter?.dispose();
  meter = null;
  await publisher?.stop();
  publisher = null;
  startButton.disabled = false;
  stopButton.disabled = true;
}

startButton.addEventListener('click', start);
stopButton.addEventListener('click', stop);

if (params.get('autostart') === '1') {
  start();
  const seconds = Number(params.get('seconds') ?? 30);
  setTimeout(stop, seconds * 1000);
}
