/**
 * AudioWorklet processor for LiveAudioPlayer.
 *
 * Bundled into a string at build time (see vite-plugin-worklet.ts) and registered with
 * registerWorklet(). It owns a PlayoutRing and does what the main thread tells it; every
 * few render quanta it reports where its read position is, which is how the player keeps
 * the audio on its LiveClock.
 *
 * Messages in:
 *   { type: 'write', pos, left, right }  - decoded audio at absolute stream position `pos`
 *   { type: 'seek', pos, contextTime }    - read position `pos` at context time `contextTime`
 *   { type: 'step', step }               - stream samples per output sample
 *   { type: 'playing', value }           - audible or muted
 *   { type: 'clear' } / { type: 'reset' }
 * Message out:
 *   { type: 'position', contextTime, pos, step, buffered, underrun, late, overflow }
 */

import { PlayoutRing } from './playout-ring';

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

/** Render quanta between position reports (about 21 ms at 48 kHz) */
const REPORT_EVERY = 8;
/** Longest stretch of buffered audio a report scans for */
const BUFFERED_SCAN_LIMIT = 1 << 16;

class LiveAudioPlayoutProcessor extends AudioWorkletProcessor {
  private ring = new PlayoutRing({ outputRate: sampleRate });
  private quanta = 0;
  private seekPos = NaN;
  private seekAt = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => this.onMessage(event.data);
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case 'write':
        this.ring.write(msg.pos, new Float32Array(msg.left), msg.right ? new Float32Array(msg.right) : null);
        break;
      case 'seek':
        this.seekPos = msg.pos;
        this.seekAt = msg.contextTime;
        break;
      case 'step':
        this.ring.step = msg.step;
        break;
      case 'playing':
        this.ring.playing = msg.value;
        break;
      case 'clear':
        this.ring.clear();
        break;
      case 'reset':
        this.ring.reset();
        this.seekPos = NaN;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    // A seek names the position due at a context time; it lands a little later, so move
    // it on by however far the context has got since
    if (this.seekPos === this.seekPos) {
      this.ring.seek(this.seekPos + (currentTime - this.seekAt) * sampleRate * this.ring.step);
      this.seekPos = NaN;
    }

    if (++this.quanta % REPORT_EVERY === 0) {
      this.port.postMessage({
        type: 'position',
        contextTime: currentTime,
        pos: this.ring.readPos,
        step: this.ring.step,
        buffered: this.ring.bufferedAhead(BUFFERED_SCAN_LIMIT),
        underrun: this.ring.underrunSamples,
        late: this.ring.lateSamples,
        overflow: this.ring.overflowSamples,
      });
    }

    this.ring.render(out[0], out.length > 1 ? out[1] : out[0]);
    return true;
  }
}

registerProcessor('live-audio-playout', LiveAudioPlayoutProcessor);
