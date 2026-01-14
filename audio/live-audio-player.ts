/**
 * Live Audio Player
 * 
 * Handles real-time audio playback for live streams (MoQ, WebSocket).
 * Supports Opus and AAC codecs with A/V sync via configurable buffer delay.
 */

import { CodecType, HeaderCodecData } from '../protocol/sesame-binary-protocol';

// Inline worklet code for live audio with sync support
const LIVE_WORKLET_CODE = `
class LiveAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // Buffer management
    this.buffers = [];
    this.currentBuffer = null;
    this.readIndex = 0;
    this.sampleRate = options.processorOptions?.sampleRate || 48000;
    
    // Sync parameters
    this.bufferTargetMs = 100; // Default 100ms buffer
    this.playing = false;
    
    // Stats
    this.processCount = 0;
    this.lastStatsProcess = 0;
    
    this.port.onmessage = (event) => this.handleMessage(event);
  }
  
  handleMessage(event) {
    const msg = event.data;
    
    switch (msg.type) {
      case 'audioData':
        if (!this.playing) return;
        
        // Limit buffer size to ~2 seconds
        while (this.buffers.length >= 100) {
          this.buffers.shift();
        }
        
        this.buffers.push({
          left: new Float32Array(msg.data.left),
          right: new Float32Array(msg.data.right),
          timestamp: msg.timestamp
        });
        break;
        
      case 'setBufferTarget':
        this.bufferTargetMs = Math.max(0, Math.min(5000, msg.targetMs));
        break;
        
      case 'setSampleRate':
        this.sampleRate = msg.sampleRate;
        break;
        
      case 'start':
        this.playing = true;
        break;
        
      case 'stop':
        this.playing = false;
        break;
        
      case 'clear':
        this.buffers = [];
        this.currentBuffer = null;
        this.readIndex = 0;
        break;
        
      case 'getStats':
        this.port.postMessage({
          type: 'stats',
          bufferMs: this.getCurrentBufferMs(),
          bufferCount: this.buffers.length,
          targetMs: this.bufferTargetMs
        });
        break;
    }
  }
  
  getCurrentBufferMs() {
    let totalSamples = 0;
    
    if (this.currentBuffer) {
      totalSamples += this.currentBuffer.left.length - this.readIndex;
    }
    
    for (const buffer of this.buffers) {
      totalSamples += buffer.left.length;
    }
    
    return (totalSamples / this.sampleRate) * 1000;
  }
  
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    
    const leftChannel = output[0];
    const rightChannel = output.length > 1 ? output[1] : output[0];
    
    if (!this.playing) {
      leftChannel.fill(0);
      rightChannel.fill(0);
      return true;
    }
    
    // Check sync - drop buffers if too far ahead
    this.processCount++;
    if (this.processCount % 10 === 0) {
      const currentMs = this.getCurrentBufferMs();
      const excess = currentMs - this.bufferTargetMs;
      
      // If significantly over target, drop old buffers
      if (excess > 100 && this.buffers.length > 2) {
        const toDrop = Math.min(Math.floor(excess / 20), this.buffers.length - 1);
        this.buffers.splice(0, toDrop);
      }
    }
    
    let outputIndex = 0;
    
    while (outputIndex < leftChannel.length) {
      // Need new buffer?
      if (!this.currentBuffer || this.readIndex >= this.currentBuffer.left.length) {
        if (this.buffers.length === 0) {
          // No more audio - fill with silence
          for (let i = outputIndex; i < leftChannel.length; i++) {
            leftChannel[i] = 0;
            rightChannel[i] = 0;
          }
          return true;
        }
        
        this.currentBuffer = this.buffers.shift();
        this.readIndex = 0;
      }
      
      // Copy samples
      const samplesRemaining = this.currentBuffer.left.length - this.readIndex;
      const samplesToCopy = Math.min(samplesRemaining, leftChannel.length - outputIndex);
      
      for (let i = 0; i < samplesToCopy; i++) {
        leftChannel[outputIndex + i] = this.currentBuffer.left[this.readIndex + i];
        rightChannel[outputIndex + i] = this.currentBuffer.right[this.readIndex + i];
      }
      
      outputIndex += samplesToCopy;
      this.readIndex += samplesToCopy;
    }
    
    return true;
  }
}

registerProcessor('live-audio-processor', LiveAudioProcessor);
`;

export interface LiveAudioConfig {
  bufferDelayMs?: number;
}

export class LiveAudioPlayer {
  private ctx: AudioContext;
  private decoder: AudioDecoder | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode;
  private initialized: boolean = false;
  private targetSampleRate: number;
  
  // Timing for live streams
  private startTime: number = 0;
  private bufferDelayMs: number;
  
  constructor(context: AudioContext, config: LiveAudioConfig = {}) {
    this.ctx = context;
    this.targetSampleRate = context.sampleRate;
    this.bufferDelayMs = config.bufferDelayMs ?? 100;
    this.gainNode = this.ctx.createGain();
    this.startTime = performance.now() * 1000; // Microseconds
  }
  
  /**
   * Initialize with codec info from stream header
   */
  async init(codecData?: HeaderCodecData): Promise<void> {
    if (this.ctx.audioWorklet === undefined) {
      throw new Error('AudioWorklet not supported - need localhost or HTTPS');
    }
    
    // Build decoder config based on codec type
    const decoderConfig = this.buildDecoderConfig(codecData);
    
    // Check if codec is supported
    const support = await AudioDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`Audio codec not supported: ${decoderConfig.codec}`);
    }
    
    // Create decoder
    this.decoder = new AudioDecoder({
      output: (frame) => this.handleDecodedFrame(frame),
      error: (err) => {
        console.error('LiveAudioPlayer decoder error:', err);
      }
    });
    
    this.decoder.configure(decoderConfig);
    
    // Load worklet
    const workletBlob = new Blob([LIVE_WORKLET_CODE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(workletBlob);
    
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    
    this.workletNode = new AudioWorkletNode(this.ctx, 'live-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sampleRate: this.ctx.sampleRate }
    });
    
    this.workletNode.connect(this.gainNode).connect(this.ctx.destination);
    
    // Set initial buffer target
    this.workletNode.port.postMessage({
      type: 'setBufferTarget',
      targetMs: this.bufferDelayMs
    });
    
    this.workletNode.port.postMessage({
      type: 'setSampleRate',
      sampleRate: this.ctx.sampleRate
    });
    
    this.initialized = true;
  }
  
  /**
   * Build decoder config based on codec type
   */
  private buildDecoderConfig(codecData?: HeaderCodecData): AudioDecoderConfig {
    const codecType = codecData?.codec_type ?? CodecType.AUDIO_OPUS;
    const sampleRate = codecData?.sample_rate || 48000;
    const channels = codecData?.channels || 2;
    
    switch (codecType) {
      case CodecType.AUDIO_OPUS:
        return {
          codec: 'opus',
          sampleRate: 48000, // Opus always uses 48kHz internally
          numberOfChannels: channels,
        };
        
      case CodecType.AUDIO_AAC:
        return {
          codec: 'mp4a.40.2', // AAC-LC
          sampleRate: sampleRate,
          numberOfChannels: channels,
        };
        
      case CodecType.AUDIO_PCM:
        // PCM doesn't need decoding, handle separately
        throw new Error('PCM audio not yet supported');
        
      default:
        // Default to Opus
        return {
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        };
    }
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
      
      // Detect planar vs interleaved
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
          leftChannelData.set(interleavedView);
          rightChannelData.set(interleavedView);
        } else {
          for (let i = 0; i < samplesPerChannel; i++) {
            leftChannelData[i] = interleavedView[i * 2];
            rightChannelData[i] = interleavedView[i * 2 + 1];
          }
        }
      } else {
        // Planar audio
        const leftBuffer = new ArrayBuffer(frame.allocationSize({
          planeIndex: 0, frameOffset: 0, frameCount: frame.numberOfFrames
        }));
        frame.copyTo(leftBuffer, { planeIndex: 0, frameOffset: 0, frameCount: frame.numberOfFrames });
        leftChannelData.set(new Float32Array(leftBuffer));
        
        if (frame.numberOfChannels > 1) {
          const rightBuffer = new ArrayBuffer(frame.allocationSize({
            planeIndex: 1, frameOffset: 0, frameCount: frame.numberOfFrames
          }));
          frame.copyTo(rightBuffer, { planeIndex: 1, frameOffset: 0, frameCount: frame.numberOfFrames });
          rightChannelData.set(new Float32Array(rightBuffer));
        } else {
          rightChannelData.set(leftChannelData);
        }
      }
      
      // Resample if needed
      const resampledLeft = this.resampleAudio(leftChannelData, frame.sampleRate, this.targetSampleRate);
      const resampledRight = this.resampleAudio(rightChannelData, frame.sampleRate, this.targetSampleRate);
      
      // Send to worklet with timestamp
      const timestamp = frame.timestamp ?? (performance.now() * 1000 - this.startTime);
      
      this.workletNode.port.postMessage({
        type: 'audioData',
        data: {
          left: resampledLeft.buffer,
          right: resampledRight.buffer
        },
        timestamp: timestamp
      }, [resampledLeft.buffer, resampledRight.buffer]);
      
      frame.close();
    } catch (error) {
      console.error('Error processing live audio frame:', error);
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
      outputData[i] = inputData[inputIndexFloor] * (1 - fraction) + inputData[inputIndexCeil] * fraction;
    }
    
    return outputData;
  }
  
  /**
   * Queue encoded audio data for decoding
   */
  decode(data: Uint8Array, pts?: bigint): void {
    if (!this.initialized || !this.decoder || this.decoder.state !== 'configured') {
      return;
    }
    
    if (data.length < 1) {
      return;
    }
    
    try {
      // Use PTS if provided, otherwise use relative time
      const timestamp = pts !== undefined 
        ? Number(pts)
        : (performance.now() * 1000) - this.startTime;
      
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.max(0, timestamp),
        data: data,
      });
      
      this.decoder.decode(chunk);
    } catch (error) {
      console.error('Error decoding live audio:', error);
    }
  }
  
  /**
   * Set buffer delay for A/V sync
   */
  setBufferDelay(delayMs: number): void {
    this.bufferDelayMs = delayMs;
    this.workletNode?.port.postMessage({
      type: 'setBufferTarget',
      targetMs: delayMs
    });
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
   * Clear audio buffers (for seek/reset)
   */
  clear(): void {
    this.workletNode?.port.postMessage({ type: 'clear' });
    this.resetTiming();
  }
  
  /**
   * Reset timing reference
   */
  resetTiming(): void {
    this.startTime = performance.now() * 1000;
  }
  
  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }
  
  /**
   * Dispose resources
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
      } catch (error) {
        // Ignore disposal errors
      }
      this.decoder = null;
    }
    
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch (error) {
        // Ignore
      }
      this.workletNode = null;
    }
    
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch (error) {
        // Ignore
      }
    }
  }
}
