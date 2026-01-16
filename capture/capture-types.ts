/**
 * Capture Types - Type definitions for media capture
 * 
 * Provides interfaces and types for capturing video/audio from
 * browser media devices and encoding them for transmission.
 */

import { CodecType, PacketType } from '../protocol/sesame-binary-protocol';

// Re-export CodecType for convenience
export { CodecType, PacketType };

/**
 * Video codec configuration options
 */
export interface VideoEncoderOptions {
  codec: CodecType;
  width?: number;
  height?: number;
  bitrate?: number;
  frameRate?: number;
  keyFrameInterval?: number;
  latencyMode?: 'quality' | 'realtime';
}

/**
 * Audio codec configuration options
 */
export interface AudioEncoderOptions {
  codec: CodecType;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  latencyMode?: 'quality' | 'realtime';
}

/**
 * Media capture configuration
 */
export interface CaptureConfig {
  /** Enable video capture */
  video?: boolean | MediaTrackConstraints;
  /** Enable audio capture */
  audio?: boolean | MediaTrackConstraints;
  /** Video encoder options */
  videoEncoder?: VideoEncoderOptions;
  /** Audio encoder options */
  audioEncoder?: AudioEncoderOptions;
  /** Enable audio level monitoring */
  audioLevelMonitoring?: boolean;
  /** Audio level reporting interval in ms */
  audioLevelInterval?: number;
}

/**
 * Default capture configuration
 */
export const DEFAULT_CAPTURE_CONFIG: Required<CaptureConfig> = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  },
  audio: {
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 2 },
  },
  videoEncoder: {
    codec: CodecType.VIDEO_VP9,
    bitrate: 2_000_000,
    frameRate: 30,
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
  audioLevelMonitoring: false,
  audioLevelInterval: 50,
};

/**
 * Encoded chunk event from encoder
 */
export interface EncodedChunkEvent {
  type: 'audio' | 'video';
  chunk: EncodedAudioChunk | EncodedVideoChunk;
  keyframe: boolean;
  timestamp: number;
  metadata?: EncodedChunkMetadata;
}

/**
 * Metadata associated with an encoded chunk
 */
export interface EncodedChunkMetadata {
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  decoderConfig?: VideoDecoderConfig | AudioDecoderConfig;
}

/**
 * Audio level data event
 */
export interface AudioLevelEvent {
  timestamp: number;
  levels: number[];
}

/**
 * Capture statistics
 */
export interface CaptureStats {
  /** Number of video frames encoded */
  videoFramesEncoded: number;
  /** Number of audio frames encoded */
  audioFramesEncoded: number;
  /** Total bytes sent */
  bytesSent: number;
  /** Packets sent */
  packetsSent: number;
  /** Current video bitrate */
  videoBitrate: number;
  /** Current audio bitrate */
  audioBitrate: number;
  /** Capture start time */
  startTime: number;
  /** Duration in ms */
  duration: number;
}

/**
 * Capture state
 */
export type CaptureState = 'idle' | 'initializing' | 'capturing' | 'paused' | 'stopped' | 'error';

/**
 * Events emitted by the capture system
 */
export interface CaptureEvents {
  'state-change': (state: CaptureState) => void;
  'encoded-chunk': (event: EncodedChunkEvent) => void;
  'audio-levels': (event: AudioLevelEvent) => void;
  'stats': (stats: CaptureStats) => void;
  'error': (error: Error) => void;
}

/**
 * Convert CodecType to WebCodecs codec string
 */
export function codecTypeToString(codec: CodecType): string {
  switch (codec) {
    case CodecType.VIDEO_VP8:
      return 'vp8';
    case CodecType.VIDEO_VP9:
      return 'vp09.00.10.08';
    case CodecType.VIDEO_AVC:
      return 'avc1.64001f';
    case CodecType.VIDEO_HEVC:
      return 'hvc1.1.L0.0';
    case CodecType.VIDEO_AV1:
      return 'av01.0.05M.08';
    case CodecType.AUDIO_OPUS:
      return 'opus';
    case CodecType.AUDIO_AAC:
      return 'mp4a.40.2';
    case CodecType.AUDIO_PCM:
      return 'pcm';
    default:
      throw new Error(`Unsupported codec type: ${codec}`);
  }
}

/**
 * Check if a codec is a video codec
 */
export function isVideoCodec(codec: CodecType): boolean {
  return codec >= CodecType.VIDEO_VP8 && codec <= CodecType.VIDEO_AV1;
}

/**
 * Check if a codec is an audio codec
 */
export function isAudioCodec(codec: CodecType): boolean {
  return codec >= CodecType.AUDIO_OPUS && codec <= CodecType.AUDIO_PCM;
}
