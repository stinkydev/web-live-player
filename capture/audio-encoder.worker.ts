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

// @ts-ignore AudioData type
function calculateAndSendAudioLevels(frame: AudioData) {
  // Throttle audio level messages
  const now = performance.now();
  if (now - lastAudioLevelTime < audioLevelInterval) {
    return;
  }
  
  lastAudioLevelTime = now;
  
  try {
    // Get audio data from the frame
    const numChannels = frame.numberOfChannels || 2;
    const samples = new Float32Array(frame.allocationSize({ planeIndex: 0 }) / 4);
    frame.copyTo(samples, { planeIndex: 0 });
    
    // Calculate RMS levels for each channel
    const channelLevels: number[] = [];
    const samplesPerChannel = samples.length / numChannels;
    
    for (let channel = 0; channel < numChannels; channel++) {
      let sum = 0;
      for (let i = 0; i < samplesPerChannel; i++) {
        const sample = samples[i * numChannels + channel];
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / samplesPerChannel);
      channelLevels[channel] = rms;
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
