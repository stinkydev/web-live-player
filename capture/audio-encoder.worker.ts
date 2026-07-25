/**
 * Audio Encoder Worker
 * 
 * Handles audio encoding in a separate thread using WebCodecs AudioEncoder.
 * Supports audio level monitoring for VU meters.
 */

export {};

declare const self: Worker;

let audioEncoder: AudioEncoder | undefined = undefined;
let processingStream: boolean = false;

// Audio level monitoring configuration
let audioLevelEnabled: boolean = false;
let audioLevelInterval: number = 50; // ms between audio level reports
let lastAudioLevelTime: number = 0;

self.onmessage = async (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'init':
      createEncoder(data.config);
      // Initialize audio level monitoring if specified
      if (data.audioLevels) {
        audioLevelEnabled = true;
        audioLevelInterval = data.audioLevels.interval || 50;
      }
      break;
      
    case 'stream':
      // Start processing the readable stream sent from the main thread
      if (data.readable) {
        await processReadableStream(data.readable);
      }
      break;
      
    case 'encode':
      // For one-off frames
      encodeChunk(data.frame);
      break;
      
    case 'close':
      closeEncoder();
      break;
      
    default:
      console.error('Unknown message type:', type);
  }
};

function createEncoder(config: AudioEncoderConfig) {
  try {
    audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        // Send encoded chunks back to main thread
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

    audioEncoder.configure(config);
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', data: err instanceof Error ? err.message : String(err) });
  }
}

// @ts-ignore AudioData type
function encodeChunk(frame: AudioData) {
  if (!frame) {
    self.postMessage({ type: 'error', data: 'Received null or undefined frame' });
    return;
  }
  
  if (!audioEncoder) {
    self.postMessage({ type: 'error', data: 'Encoder not initialized' });
    return;
  }
  
  if (audioEncoder.state !== 'configured') {
    self.postMessage({ type: 'error', data: `Encoder not in configured state: ${audioEncoder.state}` });
    return;
  }
  
  try {
    audioEncoder.encode(frame);
    frame.close(); // Important to free resources
  } catch (err) {
    self.postMessage({ type: 'error', data: err instanceof Error ? err.message : String(err) });
  }
}

function closeEncoder() {
  if (audioEncoder) {
    try {
      audioEncoder.close();
    } catch (e) {
      // Ignore close errors
    }
    audioEncoder = undefined;
  }
  
  processingStream = false;
  self.postMessage({ type: 'closed' });
}

/**
 * Whether decoded frames are planar (one plane per channel) or interleaved.
 * Probing throws for interleaved formats, so the result is cached.
 */
let planar: boolean | undefined;

// @ts-ignore AudioData type
function isPlanar(frame: AudioData): boolean {
  if (planar === undefined) {
    try {
      if (frame.numberOfChannels > 1) {
        frame.allocationSize({ planeIndex: 1, frameOffset: 0, frameCount: 1 });
        planar = true;
      } else {
        planar = false;
      }
    } catch {
      planar = false;
    }
  }
  return planar;
}

// @ts-ignore AudioData type
function calculateAndSendAudioLevels(frame: AudioData) {
  // Throttle audio level messages
  const now = performance.now();
  if (now - lastAudioLevelTime < audioLevelInterval) {
    return;
  }

  lastAudioLevelTime = now;

  try {
    const numChannels = frame.numberOfChannels || 1;
    const channelLevels: number[] = [];

    if (isPlanar(frame)) {
      // One plane per channel - each plane holds that channel's samples contiguously
      for (let channel = 0; channel < numChannels; channel++) {
        const plane = new Float32Array(frame.allocationSize({ planeIndex: channel }) / 4);
        frame.copyTo(plane, { planeIndex: channel });

        let sum = 0;
        for (let i = 0; i < plane.length; i++) {
          sum += plane[i] * plane[i];
        }
        channelLevels[channel] = plane.length > 0 ? Math.sqrt(sum / plane.length) : 0;
      }
    } else {
      // Single plane with channels interleaved sample by sample
      const samples = new Float32Array(frame.allocationSize({ planeIndex: 0 }) / 4);
      frame.copyTo(samples, { planeIndex: 0 });

      const samplesPerChannel = Math.floor(samples.length / numChannels);
      for (let channel = 0; channel < numChannels; channel++) {
        let sum = 0;
        for (let i = 0; i < samplesPerChannel; i++) {
          const sample = samples[i * numChannels + channel];
          sum += sample * sample;
        }
        channelLevels[channel] = samplesPerChannel > 0 ? Math.sqrt(sum / samplesPerChannel) : 0;
      }
    }

    // Send level data to main thread
    self.postMessage({
      type: 'audio-levels',
      data: {
        levels: channelLevels,
        timestamp: now
      }
    });

  } catch (err) {
    // Silently ignore audio level errors
  }
}

// Process a readable stream of audio frames
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
      
      // Process each frame through the encoder
      if (frame) {
        // Calculate and send audio levels if enabled
        if (audioLevelEnabled) {
          calculateAndSendAudioLevels(frame);
        }
        encodeChunk(frame);
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
