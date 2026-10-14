/**
 * Stats Overlay
 *
 * A diagnostic panel for a LiveVideoPlayer: the delay asked for and the one the clock runs at,
 * what the video and audio need, latency from arrival to screen, network jitter, A/V sync and
 * drops - over a graph of the last ten seconds showing, for each video frame, when it was ready
 * against when it had to be: a dot above the line is a frame that came late.
 *
 * It renders into a canvas of its own (`canvas`) a few times a second; drawOnto() copies that onto
 * any 2D context, or the canvas can be used directly, as a WebGL texture say.
 */

import type { LiveVideoPlayer, PlayerStats } from './live-player';
import type { PacketTimingEntry } from '../scheduling/playback-stats';

export interface StatsOverlayOptions {
  /** Size in CSS pixels (default: 420 x 200) */
  width?: number;
  height?: number;
  /** Pixel scale of the canvas, for high-density displays or large video (default: 1) */
  scale?: number;
  /** How often the panel is redrawn, in ms (default: 250) */
  updateIntervalMs?: number;
  /** Time the graph spans, at most, in ms (default: 10 000) */
  historyMs?: number;
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const COLORS = {
  background: 'rgba(0, 0, 0, 0.7)',
  text: '#f0f0f0',
  dim: '#a0a0a0',
  onTime: '#4ecdc4',
  late: '#ff6b6b',
  line: '#ffb347',
  grid: 'rgba(255, 255, 255, 0.15)',
};

const LINE_HEIGHT = 16;

export class StatsOverlay {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly ctx: Canvas2D;
  private readonly width: number;
  private readonly height: number;
  private readonly updateIntervalMs: number;
  private readonly historyMs: number;
  private lastUpdate = -Infinity;

  constructor(readonly player: LiveVideoPlayer, options: StatsOverlayOptions = {}) {
    this.width = options.width ?? 420;
    this.height = options.height ?? 200;
    this.updateIntervalMs = options.updateIntervalMs ?? 250;
    this.historyMs = options.historyMs ?? 10_000;
    const scale = options.scale ?? 1;

    const w = Math.round(this.width * scale);
    const h = Math.round(this.height * scale);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      this.canvas = canvas;
    } else {
      this.canvas = new OffscreenCanvas(w, h);
    }
    this.ctx = this.canvas.getContext('2d') as Canvas2D;
    this.ctx.scale(scale, scale);
  }

  /** Redraw the panel if it is due. Returns true when the canvas changed. */
  update(now: number = performance.now()): boolean {
    if (now - this.lastUpdate < this.updateIntervalMs) return false;
    this.lastUpdate = now;
    this.render(this.player.getStats(), this.player.getPacketTimingHistory(), now);
    return true;
  }

  /** Update if due, and draw the panel onto `ctx` with its top left corner at x, y. */
  drawOnto(ctx: Canvas2D, x = 8, y = 8): void {
    this.update();
    ctx.drawImage(this.canvas as CanvasImageSource, x, y, this.width, this.height);
  }

  private render(stats: PlayerStats, history: PacketTimingEntry[], now: number): void {
    const ctx = this.ctx;
    const sync = stats.sync;
    const audio = sync.audio;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    // The graph spans historyMs, or what the history holds if that is less (a high frame rate)
    let from = now - this.historyMs;
    if (history.length >= PACKET_HISTORY_FULL && history[0].arrivalTime > from) from = history[0].arrivalTime;
    const span = Math.max(1, now - from);

    // Frames in it: network lateness, and when each was ready (lateness plus decoding)
    const recent = history.filter((p) => p.arrivalTime >= from && p.latenessMs === p.latenessMs);
    const jitter = recent.map((p) => p.latenessMs).sort((a, b) => a - b);
    const pct = (q: number) => (jitter.length ? jitter[Math.min(jitter.length - 1, Math.floor(q * jitter.length))] : NaN);
    // A frame had to be ready this long after the earliest arrivals to be on screen on time
    const readyBy = sync.effectiveDelayMs - sync.displayLeadMs;

    const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || v !== v ? '-' : v.toFixed(digits));
    const lines: [string, string][] = [
      [`Delay ${stats.targetBufferMs} ms, runs at ${sync.effectiveDelayMs} ms`, `needs video ${fmt(sync.videoMinimumDelayMs)}, audio ${fmt(audio?.minimumDelayMs)}`],
      [`Arrival to screen ${fmt(stats.latency?.avgTotalLatency)} ms`, `decode ${fmt(stats.latency?.avgDecodeLatency, 1)} ms`],
      [`Jitter p50 ${fmt(pct(0.5))}  p95 ${fmt(pct(0.95))}  max ${fmt(jitter[jitter.length - 1])} ms`, `last ${(span / 1000).toFixed(0)} s`],
      [`A/V ${fmt(sync.avSyncMs, 1)} ms`, `clock ${sync.clockRate.toFixed(4)}x`],
      [`Late ${sync.lateFrames} frames, audio dropped ${fmt(audio?.lateMs)} ms`, ''],
    ];

    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    lines.forEach(([main, side], i) => {
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(main, 8, 6 + i * LINE_HEIGHT);
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = 'right';
      ctx.fillText(side, this.width - 8, 6 + i * LINE_HEIGHT);
    });
    ctx.textAlign = 'left';

    // Graph: when each frame was ready, against the line it had to be ready by
    const gx = 8;
    const gy = 6 + lines.length * LINE_HEIGHT + 6;
    const gw = this.width - 16;
    const gh = this.height - gy - 8;
    // From just below the fastest frame to above the slowest and the line, so the spread shows
    let fastest = Infinity;
    let slowest = 0;
    for (const p of recent) {
      const ready = p.latenessMs + p.decodeLatencyMs;
      fastest = Math.min(fastest, ready);
      slowest = Math.max(slowest, ready);
    }
    const yMin = fastest === Infinity ? 0 : Math.max(0, Math.floor((Math.min(fastest, readyBy) - 10) / 10) * 10);
    const yMax = Math.min(yMin + 1000, Math.max(yMin + 50, readyBy + 20, slowest + 10));
    const yOf = (ms: number) => gy + gh - ((Math.max(yMin, Math.min(ms, yMax)) - yMin) / (yMax - yMin)) * gh;
    const xOf = (t: number) => gx + ((t - from) / span) * gw;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);

    for (const p of recent) {
      const ready = p.latenessMs + p.decodeLatencyMs;
      ctx.fillStyle = ready > readyBy ? COLORS.late : COLORS.onTime;
      ctx.fillRect(xOf(p.arrivalTime) - 1, yOf(ready) - 1, 2, 2);
    }

    const ly = Math.round(yOf(readyBy)) + 0.5;
    ctx.strokeStyle = COLORS.line;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(gx, ly);
    ctx.lineTo(gx + gw, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.line;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`ready by ${Math.round(readyBy)} ms`, gx + 4, ly - 2);
    ctx.fillStyle = COLORS.dim;
    ctx.textBaseline = 'top';
    ctx.fillText('frame ready, ms after earliest arrival', gx + 4, gy + 3);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(yMax)} ms`, gx + gw - 4, gy + 3);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.round(yMin)} ms`, gx + gw - 4, gy + gh - 2);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
  }
}

/** Entries the player's packet history holds when full (PlaybackStats) */
const PACKET_HISTORY_FULL = 600;
