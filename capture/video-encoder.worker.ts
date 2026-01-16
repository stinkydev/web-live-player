/**
 * Video Encoder Worker
 * 
 * Handles video encoding in a separate thread using WebCodecs VideoEncoder.
 * Supports keyframe requests and configurable GOP (Group of Pictures).
 */

export {};

declare const self: Worker;

let videoEncoder: VideoEncoder | undefined = undefined;
let processingStream: boolean = false;
let keyFrameRequested: boolean = false;
let frameCount: number = 0;
let gopSize: number = 60; // Default GOP size

self.onmessage = async (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'init':
      gopSize = data.config.gopSize || 60;
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
  videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      self.postMessage({ 
        type: 'chunk', 
        data: chunk,
        metadata: metadata
      });
    },
    error: (err) => {
      self.postMessage({ type: 'error', data: err.message });
    },
  });

  videoEncoder.configure(config);
  self.postMessage({ type: 'ready' });
}

function encodeFrame(frame: VideoFrame) {
  if (!frame) {
    self.postMessage({ type: 'error', data: 'Received null or undefined frame' });
    return;
  }
  
  if (!videoEncoder) {
    self.postMessage({ type: 'error', data: 'Encoder not initialized' });
    return;
  }
  
  if (videoEncoder.state !== 'configured') {
    self.postMessage({ type: 'error', data: `Encoder not in configured state: ${videoEncoder.state}` });
    return;
  }
  
  try {
    frameCount++;
    let keyFrame = frameCount % gopSize === 0;
    
    // Honor keyframe requests
    if (keyFrameRequested) {
      keyFrameRequested = false;
      keyFrame = true;
      frameCount = 0; // Reset frame count after keyframe
    }
    
    videoEncoder.encode(frame, { keyFrame });
    frame.close();
  } catch (err) {
    self.postMessage({ type: 'error', data: err instanceof Error ? err.message : String(err) });
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
