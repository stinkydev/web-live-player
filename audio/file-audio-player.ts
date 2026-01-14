/**
 * File Audio Player
 * 
 * Decodes and plays audio from MP4 files using WebCodecs AudioDecoder
 * and AudioWorklet for real-time playback.
 */

// Worklet URL will be resolved by Vite
const WORKLET_CODE = `
class AudioPlayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffers = [];
    this.sampleRate = options.processorOptions?.sampleRate || 48000;
    this.bufferIndex = 0;
    this.sampleIndex = 0;
    this.playing = false;
    
    this.port.onmessage = (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'audioData':
          if (this.buffers.length < 100) {
            this.buffers.push({
              left: new Float32Array(msg.data.left),
              right: new Float32Array(msg.data.right)
            });
          }
          break;
        case 'setSampleRate':
          this.sampleRate = msg.sampleRate;
          break;
        case 'clear':
          this.buffers = [];
          this.bufferIndex = 0;
          this.sampleIndex = 0;
          break;
        case 'start':
          this.playing = true;
          break;
        case 'stop':
          this.playing = false;
          break;
      }
    };
  }
  
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    
    const leftChannel = output[0];
    const rightChannel = output.length > 1 ? output[1] : output[0];
    
    if (!this.playing || this.buffers.length === 0) {
      leftChannel.fill(0);
      rightChannel.fill(0);
      return true;
    }
    
    let outputIndex = 0;
    while (outputIndex < leftChannel.length && this.buffers.length > 0) {
      const currentBuffer = this.buffers[0];
      const samplesRemaining = currentBuffer.left.length - this.sampleIndex;
      const samplesToCopy = Math.min(samplesRemaining, leftChannel.length - outputIndex);
      
      for (let i = 0; i < samplesToCopy; i++) {
        leftChannel[outputIndex + i] = currentBuffer.left[this.sampleIndex + i];
        rightChannel[outputIndex + i] = currentBuffer.right[this.sampleIndex + i];
      }
      
      outputIndex += samplesToCopy;
      this.sampleIndex += samplesToCopy;
      
      if (this.sampleIndex >= currentBuffer.left.length) {
        this.buffers.shift();
        this.sampleIndex = 0;
      }
    }
    
    // Fill remaining with silence
    for (let i = outputIndex; i < leftChannel.length; i++) {
      leftChannel[i] = 0;
      rightChannel[i] = 0;
    }
    
    return true;
  }
}

registerProcessor('audio-play-processor', AudioPlayProcessor);
`;

export interface AudioPlayerConfig {
  sampleRate?: number;
  channels?: number;
}

export class FileAudioPlayer {
  private ctx: AudioContext;
  private decoder: AudioDecoder | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode;
  private initialized: boolean = false;
  private targetSampleRate: number;
  
  // Audio codec config from MP4
  private codecConfig: AudioDecoderConfig | null = null;
  
  constructor(context: AudioContext, config: AudioPlayerConfig = {}) {
    this.ctx = context;
    this.targetSampleRate = config.sampleRate ?? context.sampleRate;
    this.gainNode = this.ctx.createGain();
  }
  
  /**
   * Initialize the audio player with codec info from MP4
   */
  async init(codec: string, sampleRate: number, numberOfChannels: number, description?: Uint8Array): Promise<void> {
    if (this.ctx.audioWorklet === undefined) {
      throw new Error('AudioWorklet not supported - need localhost or HTTPS');
    }
    
    // Build codec config
    this.codecConfig = {
      codec: codec,
      sampleRate: sampleRate,
      numberOfChannels: numberOfChannels,
    };
    
    if (description) {
      this.codecConfig.description = description;
    }
    
    // Check if codec is supported
    const support = await AudioDecoder.isConfigSupported(this.codecConfig);
    if (!support.supported) {
      throw new Error(`Audio codec not supported: ${codec}`);
    }
    
    // Create decoder
    this.decoder = new AudioDecoder({
      output: (frame) => this.handleDecodedFrame(frame),
      error: (err) => {
        console.error('AudioDecoder error:', err);
      }
    });
    
    this.decoder.configure(this.codecConfig);
    
    // Load worklet from inline code using Blob URL
    const workletBlob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(workletBlob);
    
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    
    this.workletNode = new AudioWorkletNode(this.ctx, 'audio-play-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sampleRate: this.ctx.sampleRate }
    });
    
    this.workletNode.connect(this.gainNode).connect(this.ctx.destination);
    
    // Set sample rate in worklet
    this.workletNode.port.postMessage({
      type: 'setSampleRate',
      sampleRate: this.ctx.sampleRate
    });
    
    this.initialized = true;
  }
  
  /**
   * Handle decoded audio frame
   */
  private handleDecodedFrame(frame: AudioData): void {
    if (!this.workletNode) {
      frame.close();
      return;
    }
    
    try {
      const samplesPerChannel = frame.numberOfFrames;
      
      // Detect if audio is planar or interleaved
      let numPlanes = 1;
      try {
        if (frame.numberOfChannels > 1) {
          frame.allocationSize({ planeIndex: 1, frameOffset: 0, frameCount: 1 });
          numPlanes = frame.numberOfChannels;
        }
      } catch {
        numPlanes = 1;
      }
      
      const leftChannelData = new Float32Array(samplesPerChannel);
      const rightChannelData = new Float32Array(samplesPerChannel);
      
      if (numPlanes === 1) {
        // Interleaved audio
        const allocationSize = frame.allocationSize({
          planeIndex: 0,
          frameOffset: 0,
          frameCount: frame.numberOfFrames
        });
        
        const interleavedBuffer = new ArrayBuffer(allocationSize);
        frame.copyTo(interleavedBuffer, {
          planeIndex: 0,
          frameOffset: 0,
          frameCount: frame.numberOfFrames
        });
        
        const interleavedView = new Float32Array(interleavedBuffer);
        
        if (frame.numberOfChannels === 1) {
          // Mono - copy to both channels
          leftChannelData.set(interleavedView);
          rightChannelData.set(interleavedView);
        } else {
          // Stereo interleaved - de-interleave
          for (let i = 0; i < samplesPerChannel; i++) {
            leftChannelData[i] = interleavedView[i * 2];
            rightChannelData[i] = interleavedView[i * 2 + 1];
          }
        }
      } else {
        // Planar audio
        const leftAllocationSize = frame.allocationSize({
          planeIndex: 0,
          frameOffset: 0,
          frameCount: frame.numberOfFrames
        });
        
        const leftBuffer = new ArrayBuffer(leftAllocationSize);
        frame.copyTo(leftBuffer, {
          planeIndex: 0,
          frameOffset: 0,
          frameCount: frame.numberOfFrames
        });
        
        leftChannelData.set(new Float32Array(leftBuffer));
        
        if (frame.numberOfChannels > 1) {
          const rightAllocationSize = frame.allocationSize({
            planeIndex: 1,
            frameOffset: 0,
            frameCount: frame.numberOfFrames
          });
          
          const rightBuffer = new ArrayBuffer(rightAllocationSize);
          frame.copyTo(rightBuffer, {
            planeIndex: 1,
            frameOffset: 0,
            frameCount: frame.numberOfFrames
          });
          
          rightChannelData.set(new Float32Array(rightBuffer));
        } else {
          rightChannelData.set(leftChannelData);
        }
      }
      
      // Resample if needed
      const resampledLeft = this.resampleAudio(leftChannelData, frame.sampleRate, this.targetSampleRate);
      const resampledRight = this.resampleAudio(rightChannelData, frame.sampleRate, this.targetSampleRate);
      
      // Send to worklet
      this.workletNode.port.postMessage({
        type: 'audioData',
        data: {
          left: resampledLeft.buffer,
          right: resampledRight.buffer
        }
      }, [resampledLeft.buffer, resampledRight.buffer]);
      
      frame.close();
    } catch (error) {
      console.error('Error processing audio frame:', error);
      frame.close();
    }
  }
  
  /**
   * Resample audio to target sample rate
   */
  private resampleAudio(inputData: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
    if (inputSampleRate === outputSampleRate) {
      return inputData;
    }
    
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.floor(inputData.length / ratio);
    const outputData = new Float32Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const inputIndex = i * ratio;
      const inputIndexFloor = Math.floor(inputIndex);
      const inputIndexCeil = Math.min(inputIndexFloor + 1, inputData.length - 1);
      const fraction = inputIndex - inputIndexFloor;
      
      // Linear interpolation
      outputData[i] = inputData[inputIndexFloor] * (1 - fraction) + inputData[inputIndexCeil] * fraction;
    }
    
    return outputData;
  }
  
  /**
   * Decode an audio sample
   */
  decode(data: Uint8Array, timestamp: number, duration: number): void {
    if (!this.initialized || !this.decoder || this.decoder.state !== 'configured') {
      return;
    }
    
    try {
      const chunk = new EncodedAudioChunk({
        type: 'key', // AAC frames are all keyframes
        timestamp: timestamp,
        duration: duration,
        data: data,
      });
      
      this.decoder.decode(chunk);
    } catch (error) {
      console.error('Error decoding audio:', error);
    }
  }
  
  /**
   * Start audio playback
   */
  start(): void {
    this.workletNode?.port.postMessage({ type: 'start' });
    this.ctx.resume();
  }
  
  /**
   * Stop audio playback
   */
  stop(): void {
    this.workletNode?.port.postMessage({ type: 'stop' });
  }
  
  /**
   * Clear audio buffers
   */
  clear(): void {
    this.workletNode?.port.postMessage({ type: 'clear' });
  }
  
  /**
   * Reset timing for seamless loop (clears worklet buffer)
   */
  resetTiming(): void {
    // Clear the worklet buffer to prepare for new audio from loop start
    this.workletNode?.port.postMessage({ type: 'clear' });
  }
  
  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }
  
  /**
   * Dispose of resources
   */
  dispose(): void {
    this.initialized = false;
    
    if (this.decoder) {
      try {
        if (this.decoder.state === 'configured') {
          this.decoder.reset();
        }
        if (this.decoder.state !== 'closed') {
          this.decoder.close();
        }
      } catch {
        // Ignore errors during cleanup
      }
      this.decoder = null;
    }
    
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      this.workletNode = null;
    }
  }
}
