/**
 * Media Clock
 *
 * The playout timeline of a file: a position that runs with the system clock while playing and
 * holds while paused. The file player shows the frame due at it and its audio keeps to it, the
 * way live players keep to a LiveClock.
 */

export class MediaClock {
  /** Speed, 1 = real time (a paused clock holds its position rather than run at 0) */
  readonly rate = 1;
  private readonly now: () => number;
  private playing = false;
  private anchorMs = 0;
  private anchorPtsUs = 0;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Position at `perfMs` (default: now), in microseconds */
  ptsAt(perfMs: number = this.now()): number {
    return this.playing ? this.anchorPtsUs + (perfMs - this.anchorMs) * 1000 : this.anchorPtsUs;
  }

  /** Run from the current position */
  play(): void {
    if (this.playing) return;
    this.anchorMs = this.now();
    this.playing = true;
  }

  /** Hold at the current position */
  pause(): void {
    if (!this.playing) return;
    this.anchorPtsUs = this.ptsAt();
    this.playing = false;
  }

  /** Move to `ptsUs`, playing on from there if playing */
  seek(ptsUs: number): void {
    this.anchorPtsUs = ptsUs;
    this.anchorMs = this.now();
  }
}
