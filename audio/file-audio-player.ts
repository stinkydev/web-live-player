/**
 * File Audio Player
 *
 * Plays the audio track of a file (AAC or Opus from an MP4) on a clock, normally the file
 * player's MediaClock: decoded audio is placed by its timestamps and heard when the clock says
 * it is due, so it keeps with the picture through pauses, seeks and loops. While muted (paused)
 * it holds its place. The decoding and the playout are ClockedAudioOutput's.
 */

import { ClockedAudioOutput, AudioClock, AudioOutputStats } from './clocked-audio-output';

export interface FileAudioConfig {
  /** Clock to play on: the file player's */
  clock: AudioClock;
  /** Node the audio goes to (default: the context's destination) */
  destination?: AudioNode;
}

export type FileAudioStats = AudioOutputStats;

export class FileAudioPlayer {
  private readonly output: ClockedAudioOutput;

  constructor(context: AudioContext, config: FileAudioConfig) {
    this.output = new ClockedAudioOutput(context, {
      clock: config.clock,
      destination: config.destination,
      holdWhileMuted: true,
      name: 'FileAudioPlayer',
    });
  }

  /**
   * Initialize with the track's codec (e.g. 'mp4a.40.2', 'opus') and its decoder description
   * (the AudioSpecificConfig of an AAC track)
   */
  async init(codec: string, sampleRate: number, numberOfChannels: number, description?: Uint8Array): Promise<void> {
    // mp4box names an Opus track 'Opus'; WebCodecs wants 'opus', and no description (that would be an OpusHead, not the dOps box)
    const opus = codec.toLowerCase() === 'opus';
    const config: AudioDecoderConfig = { codec: opus ? 'opus' : codec, sampleRate: opus ? 48000 : sampleRate, numberOfChannels };
    if (description && !opus) config.description = description;
    await this.output.configure(config);
  }

  /** Queue a sample, its timestamp and duration in microseconds on the clock's timeline */
  decode(data: Uint8Array, timestampUs: number, durationUs?: number): void {
    this.output.decode(data, timestampUs, durationUs);
  }

  /** Timestamp being heard at `perfMs` (default: now), in microseconds; null while nothing plays */
  audiblePtsAt(perfMs?: number): number | null {
    return this.output.audiblePtsAt(perfMs);
  }

  getStats(): FileAudioStats {
    return this.output.getStats();
  }

  /** Make the audio heard */
  start(): void {
    this.output.start();
  }

  /** Mute the audio; it holds its place */
  stop(): void {
    this.output.stop();
  }

  /** Drop the buffered audio (for a seek) */
  clear(): void {
    this.output.clear();
  }

  /** Move to where the clock is now: call after the clock jumps, before feeding the new position */
  resync(): void {
    this.output.resync();
  }

  /** Set volume (0-1) */
  setVolume(volume: number): void {
    this.output.setVolume(volume);
  }

  dispose(): void {
    this.output.dispose();
  }
}
