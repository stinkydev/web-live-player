/**
 * Video Encoder Worker
 * 
 * Handles video encoding in a separate thread using WebCodecs VideoEncoder.
 * Supports keyframe requests and configurable GOP (Group of Pictures).
 */

import { TimestampRebaser, wallClockUs } from './timestamp-rebase';

declare const self: Worker;

/**
 * Frames the encoder may have queued before new ones are dropped. A live encoder that falls
 * behind drops frames rather than queue them: latency, and the captured frames held, would grow
 * without bound.
 */
const MAX_ENCODE_QUEUE = 2;

let videoEncoder: VideoEncoder | undefined = undefined;
let processingStream: boolean = false;
let keyFrameRequested: boolean = false;
let frameCount: number = 0;
let gopSize: number = 60; // Default GOP size
// Capture timestamps on the wall clock shared with the audio track
const rebaser = new TimestampRebaser();
let framesDropped = 0;

self.onmessage = async (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'init':
      gopSize = data.gopSize || 60;
      createEncoder(data.config);
      break;
      
    case 'stream':
      if (data.readable) {
        await processReadableStream(data.readable);
      }
      break;
      
    case 'encode':
      encodeFrame(data.frame);
      break;
      
    case 'close':
      closeEncoder();
      break;
      
    case 'request-keyframe':
      keyFrameRequested = true;
      break;

    default:
      console.error('Unknown message type:', type);
  }
};

function createEncoder(config: VideoEncoderConfig) {
  try {
    videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        self.postMessage({
          type: 'chunk',
          data: chunk,
          metadata: metadata,
          timestamp: rebaser.map(chunk.timestamp),
          dropped: framesDropped,
        });
      },
      error: (err) => {
        self.postMessage({ type: 'error', data: err.message });
      },
    });

    videoEncoder.configure(config);
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', data: err instanceof Error ? err.message : String(err) });
  }
}

function encodeFrame(frame: VideoFrame) {
  if (!frame) {
    self.postMessage({ type: 'error', data: 'Received null or undefined frame' });
    return;
  }

  try {
    rebaser.observe(frame.timestamp, wallClockUs());

    if (!videoEncoder) {
      self.postMessage({ type: 'error', data: 'Encoder not initialized' });
      return;
    }

    if (videoEncoder.state !== 'configured') {
      self.postMessage({ type: 'error', data: `Encoder not in configured state: ${videoEncoder.state}` });
      return;
    }

    // A keyframe asked for (or due) goes on the next frame encoded
    if (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      framesDropped++;
      return;
    }

    frameCount++;
    let keyFrame = frameCount % gopSize === 0;
    
    // Honor keyframe requests
    if (keyFrameRequested) {
      keyFrameRequested = false;
      keyFrame = true;
      frameCount = 0; // Reset frame count after keyframe
    }
    
    videoEncoder.encode(frame, { keyFrame });
  } catch (err) {
    self.postMessage({ type: 'error', data: err instanceof Error ? err.message : String(err) });
  } finally {
    frame.close();
  }
}

function closeEncoder() {
  if (videoEncoder) {
    try {
      videoEncoder.close();
    } catch (e) {
      // Ignore close errors
    }
    videoEncoder = undefined;
  }
  
  processingStream = false;
  frameCount = 0;
  self.postMessage({ type: 'closed' });
}

async function processReadableStream(readable: ReadableStream) {
  if (processingStream) {
    self.postMessage({ type: 'error', data: 'Already processing a stream' });
    return;
  }
  
  processingStream = true;
  const reader = readable.getReader();
  
  try {
    while (true) {
      const { done, value: frame } = await reader.read();
      
      if (done) {
        break;
      }
      
      if (frame) {
        encodeFrame(frame);
      }
    }
  } catch (err) {
    self.postMessage({ 
      type: 'error', 
      data: err instanceof Error ? err.message : String(err)
    });
  } finally {
    reader.releaseLock();
    processingStream = false;
    self.postMessage({ type: 'stream-complete' });
  }
}
