/**
 * The pipeline worker: the MoQ session and the video decoders of one connection.
 * Created by PipelineClient.create() on the main thread.
 */

import { MoqSessionSubscriber } from 'stinky-moq-js';
import { PipelineCore } from './pipeline-core';
import { VideoFeed } from '../player/video-feed';
import type { PipelinePort } from './pipeline-protocol';

new PipelineCore(self as unknown as PipelinePort, {
  createSession: (config, subscriptions) => new MoqSessionSubscriber(config, subscriptions),
  createFeed: (config, callbacks) => new VideoFeed(config, callbacks),
});
