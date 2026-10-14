/**
 * Live Audio Player
 *
 * Plays a live audio track (Opus or AAC) on a LiveClock, in sync with every video player on the
 * same clock. Given no clock, it makes its own. The decoding and the playout keeping to the clock
 * are ClockedAudioOutput's; this adds what live streams need: the packets' arrival reported to
 * the clock, decoder setup from the stream's codec data, and the output's latency reported to the
 * clock as the least delay it can play at. It makes itself known to the clock, so that a video
 * player on it measures A/V sync against it.
 */

import { CodecType, IMediaCodecData, ParsedFrame } from '@stinkycomputing/sesame-api-client';
import { LiveClock, DEFAULT_BUFFER_DELAY_MS } from '../sync/live-clock';
import { rescaleTime, timebaseFromCodecData, MICROSECOND_TIMEBASE, Timebase, PtsValue } from '../protocol/codec-utils';
import { ClockedAudioOutput, AudioOutputStats, AudioOutputState } from './clocked-audio-output';

export interface LiveAudioConfig {
  /** Buffer delay of the clock the player makes when none is given (default: 150) */
  bufferDelayMs?: number;
  /** Clock to play on. Share one with LiveVideoPlayers to keep them in sync. */
  clock?: LiveClock;
  /** Node the audio goes to (default: the context's destination) */
  destination?: AudioNode;
  /** Name the player's packets are reported under on the clock (default: 'audio') */
  trackKey?: string;
  /** Time source in milliseconds, on the performance.now() timeline (default: performance.now) */
  now?: () => number;
}

export type LiveAudioState = AudioOutputState;
export type LiveAudioStats = AudioOutputStats;

export class LiveAudioPlayer {
  private readonly clock: LiveClock;
  private readonly trackKey: string;
  private readonly now: () => number;
  private readonly output: ClockedAudioOutput;
  private timebase: Timebase = MICROSECOND_TIMEBASE;
  private warnedNoTimestamp = false;

  constructor(context: AudioContext, config: LiveAudioConfig = {}) {
    this.clock = config.clock ?? new LiveClock({ bufferDelayMs: config.bufferDelayMs ?? DEFAULT_BUFFER_DELAY_MS });
    this.trackKey = config.trackKey ?? 'audio';
    this.now = config.now ?? (() => performance.now());
    this.output = new ClockedAudioOutput(context, {
      clock: this.clock,
      destination: config.destination,
      onMinimumDelay: (delayMs) => this.clock.setMinimumDelay(this.trackKey, delayMs),
      now: this.now,
      name: 'LiveAudioPlayer',
    });
    this.clock.addAudio(this);
  }

  /** The clock the player follows */
  getClock(): LiveClock {
    return this.clock;
  }

  /**
   * Initialize with codec info from the stream header
   */
  async init(codecData?: IMediaCodecData): Promise<void> {
    this.timebase = timebaseFromCodecData(codecData);
    await this.output.configure(this.buildDecoderConfig(codecData));
  }

  private buildDecoderConfig(codecData?: IMediaCodecData): AudioDecoderConfig {
    const codecType = codecData?.codecType ?? CodecType.CODEC_TYPE_AUDIO_OPUS;
    const sampleRate = codecData?.sampleRate || 48000;
    const channels = codecData?.channels || 2;

    switch (codecType) {
      case CodecType.CODEC_TYPE_AUDIO_OPUS:
        // Opus always decodes at 48 kHz
        return { codec: 'opus', sampleRate: 48000, numberOfChannels: channels };
      case CodecType.CODEC_TYPE_AUDIO_AAC:
        return { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels };
      case CodecType.CODEC_TYPE_AUDIO_PCM:
        throw new Error('PCM audio not yet supported');
      default:
        return { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    }
  }

  /**
   * Queue an encoded audio packet. Packets are placed by their timestamps, so one without a
   * timestamp cannot be played and is dropped.
   *
   * @param ptsUs - Presentation timestamp in microseconds (number, bigint or Long)
   * @param arrivalMs - When the packet arrived, on the performance.now() timeline (default: now)
   */
  decode(data: Uint8Array, ptsUs: PtsValue, arrivalMs?: number): void {
    if (!this.output.isConfigured || data.length < 1) return;

    if (ptsUs === undefined || ptsUs === null) {
      if (!this.warnedNoTimestamp) {
        this.warnedNoTimestamp = true;
        console.warn('LiveAudioPlayer: dropping audio packets without a timestamp');
      }
      return;
    }

    const timestamp = rescaleTime(ptsUs, MICROSECOND_TIMEBASE, MICROSECOND_TIMEBASE);
    this.clock.onPacket(this.trackKey, timestamp, arrivalMs ?? this.now());
    this.output.decode(data, timestamp);
  }

  /**
   * Queue a parsed stream packet, taking its timestamp in the timebase of the codec data the
   * player was initialized with.
   */
  decodeFrame(frame: ParsedFrame, arrivalMs?: number): void {
    if (!frame.payload || !frame.header) return;
    const pts = frame.header.media?.pts;
    this.decode(frame.payload, pts === undefined || pts === null ? undefined : rescaleTime(pts, this.timebase, MICROSECOND_TIMEBASE), arrivalMs);
  }

  /**
   * Stream timestamp being heard at `perfMs` (default: now), in microseconds, or null while
   * nothing is playing.
   */
  audiblePtsAt(perfMs?: number): number | null {
    return this.output.audiblePtsAt(perfMs);
  }

  getStats(): LiveAudioStats {
    return this.output.getStats();
  }

  /**
   * Set the buffer delay. This is the clock's delay, so on a shared clock it applies to every
   * player on it.
   */
  setBufferDelay(delayMs: number): void {
    this.clock.setBufferDelay(delayMs);
  }

  /**
   * Make the audio heard. Playback keeps to the clock either way, so starting picks up at
   * whatever is due.
   */
  start(): void {
    this.output.start();
  }

  /** Mute the audio; it keeps to the clock so start() resumes in sync. */
  stop(): void {
    this.output.stop();
  }

  /** Drop the buffered audio (for a reset or a reconnect). */
  clear(): void {
    this.output.clear();
  }

  /** Set volume (0-1) */
  setVolume(volume: number): void {
    this.output.setVolume(volume);
  }

  dispose(): void {
    this.clock.clearMinimumDelay(this.trackKey);
    this.clock.removeAudio(this);
    this.output.dispose();
  }
}
