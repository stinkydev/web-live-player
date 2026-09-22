/**
 * A video feed decoded by a pipeline worker: the player's view of one video track there.
 * Packets pushed here are ignored, since the worker has them off the transport itself.
 */

import type { PipelineClient } from '../worker/pipeline-client';
import type { PreferredDecoder } from '../types';
import type { IVideoFeed, VideoFeedCallbacks } from './video-feed';

export class RemoteVideoFeed implements IVideoFeed {
  private preferred: PreferredDecoder;
  private unsubscribe: () => void;

  constructor(private client: PipelineClient, private track: string, preferredDecoder: PreferredDecoder | undefined, callbacks: VideoFeedCallbacks) {
    this.preferred = preferredDecoder ?? 'webcodecs-sw';
    this.unsubscribe = client.subscribeVideo(track, {
      onFrame: (frame, timestampUs, arrivalTime, decodeTime, isKeyframe) => callbacks.onFrame(frame, timestampUs, arrivalTime, decodeTime, isKeyframe),
      onMetadata: (metadata) => callbacks.onMetadata?.(metadata),
    });
    client.setVideo(track, { enabled: true, preferredDecoder: this.preferred });
  }

  public push(): void {}

  public flush(): void {
    this.client.flush(this.track);
  }

  public setPreferredDecoder(type: PreferredDecoder): boolean {
    if (type === this.preferred) return false;
    this.preferred = type;
    this.client.setVideo(this.track, { enabled: true, preferredDecoder: type });
    return true;
  }

  public setDebugLogging(): void {}

  public get decoderState(): string { return this.client.trackStats(this.track)?.decoderState ?? 'none'; }
  public get streamWidth(): number { return this.client.trackStats(this.track)?.width ?? 0; }
  public get streamHeight(): number { return this.client.trackStats(this.track)?.height ?? 0; }
  public get frameRate(): number { return this.client.trackStats(this.track)?.frameRate ?? 30; }
  /** Decoded frames the worker closed because the main thread had not taken the earlier ones. */
  public get framesDropped(): number { return this.client.trackStats(this.track)?.framesDropped ?? 0; }

  public dispose(): void {
    this.unsubscribe();
    this.client.setVideo(this.track, { enabled: false });
  }
}
