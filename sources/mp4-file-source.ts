/**
 * MP4 File Source - Client-side MP4 demuxing using mp4box.js
 * 
 * Loads MP4 files and extracts video/audio samples for decoding.
 * Works entirely in the browser without a backend server.
 */

import { createFile, type ISOFile, type Sample, type Movie, type Track } from 'mp4box';

/**
 * File metadata extracted from MP4
 */
export interface MP4FileInfo {
  duration: number;        // Duration in seconds
  timescale: number;       // File timescale
  width: number;          // Video width
  height: number;         // Video height
  videoCodec: string;     // Video codec string (e.g., 'avc1.42001f')
  audioCodec?: string;    // Audio codec string if present
  frameRate?: number;     // Estimated frame rate
  bitrate?: number;       // Video bitrate
  audioChannels?: number; // Number of audio channels
  audioSampleRate?: number; // Audio sample rate
}

/**
 * Sample ready for decoding
 */
export interface DecodableSample {
  data: Uint8Array;
  timestamp: number;      // Presentation time in microseconds
  duration: number;       // Duration in microseconds
  isKeyframe: boolean;
  type: 'video' | 'audio';
}

/**
 * Event handlers for MP4FileSource
 */
export interface MP4FileSourceEvents {
  onReady?: (info: MP4FileInfo) => void;
  onSamples?: (samples: DecodableSample[]) => void;
  onError?: (error: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
  onEnded?: () => void;
}

/**
 * MP4 File Source - Demuxes MP4 files in the browser
 */
export class MP4FileSource {
  private mp4File: ISOFile | null = null;
  private fileInfo: MP4FileInfo | null = null;
  private videoTrackId: number | null = null;
  private audioTrackId: number | null = null;
  private videoTrack: Track | null = null;
  private audioTrack: Track | null = null;
  
  // Sample extraction state
  private nextVideoSampleIndex: number = 0;
  private nextAudioSampleIndex: number = 0;
  private totalVideoSamples: number = 0;
  private totalAudioSamples: number = 0;
  private samplesRequested: boolean = false;
  
  // File loading state
  private fileSize: number = 0;
  private loadedBytes: number = 0;
  
  // Codec config data (needed for decoder configuration)
  private videoDescription: Uint8Array | null = null;
  private audioDescription: Uint8Array | null = null;
  
  // Event handlers
  private events: MP4FileSourceEvents = {};
  
  constructor(events: MP4FileSourceEvents = {}) {
    this.events = events;
  }
  
  /**
   * Get the extracted file info
   */
  getFileInfo(): MP4FileInfo | null {
    return this.fileInfo;
  }
  
  /**
   * Get the video codec description (for VideoDecoder.configure)
   */
  getVideoDescription(): Uint8Array | null {
    return this.videoDescription;
  }
  
  /**
   * Get the audio codec description (for AudioDecoder.configure)
   */
  getAudioDescription(): Uint8Array | null {
    return this.audioDescription;
  }
  
  /**
   * Load an MP4 file from a URL
   */
  async loadFromUrl(url: string): Promise<MP4FileInfo> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    this.fileSize = arrayBuffer.byteLength;
    
    return this.loadFromArrayBuffer(arrayBuffer);
  }
  
  /**
   * Load an MP4 file from a File object (e.g., from file input)
   */
  async loadFromFile(file: File): Promise<MP4FileInfo> {
    this.fileSize = file.size;
    const arrayBuffer = await file.arrayBuffer();
    return this.loadFromArrayBuffer(arrayBuffer);
  }
  
  /**
   * Load from a ReadableStreamDefaultReader (for progressive loading)
   * Uses WritableStream pattern for proper mp4box integration.
   */
  //@ts-ignore
  private async loadFromStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<MP4FileInfo> {
    this.initMP4File();
    
    let offset = 0;
    
    return new Promise((resolve, reject) => {
      const processChunk = (chunk: Uint8Array) => {
        // CRITICAL: Create a NEW ArrayBuffer for mp4box - don't reuse the stream's buffer
        // Stream chunks may share underlying buffers with different byte offsets
        const buffer = new ArrayBuffer(chunk.byteLength) as ArrayBuffer & { fileStart: number };
        new Uint8Array(buffer).set(chunk);
        
        // Inform MP4Box where in the file this chunk is from
        buffer.fileStart = offset;
        offset += buffer.byteLength;
        this.loadedBytes = offset;
        
        this.events.onProgress?.(this.loadedBytes, this.fileSize);
        this.mp4File?.appendBuffer(buffer);
      };
      
      const readChunk = async () => {
        try {
          const { done, value } = await reader.read();
          
          if (done) {
            this.mp4File?.flush();
            
            if (this.fileInfo) {
              resolve(this.fileInfo);
            } else {
              reject(new Error('File loaded but no video track found'));
            }
            return;
          }
          
          if (value) {
            processChunk(value);
          }
          
          readChunk();
        } catch (error) {
          reject(error);
        }
      };
      
      readChunk();
    });
  }
  
  /**
   * Load from a complete ArrayBuffer
   */
  private async loadFromArrayBuffer(arrayBuffer: ArrayBuffer): Promise<MP4FileInfo> {
    this.initMP4File();
    
    return new Promise((resolve, reject) => {
      // Store original onReady to chain with resolution
      const originalOnReady = this.mp4File!.onReady;
      this.mp4File!.onReady = (info: Movie) => {
        originalOnReady?.call(this.mp4File, info);
        
        if (this.fileInfo) {
          this.requestSamples();
          resolve(this.fileInfo);
        } else {
          reject(new Error('No video track found in file'));
        }
      };
      
      // Create MP4Box buffer
      const buffer = arrayBuffer as ArrayBuffer & { fileStart: number };
      buffer.fileStart = 0;
      this.loadedBytes = arrayBuffer.byteLength;
      
      this.mp4File?.appendBuffer(buffer);
      this.mp4File?.flush();
    });
  }
  
  /**
   * Initialize the mp4box ISOFile
   */
  private initMP4File(): void {
    this.mp4File = createFile();
    
    this.mp4File.onReady = (info: Movie) => {
      this.handleFileReady(info);
    };
    
    this.mp4File.onSamples = (trackId: number, _user: unknown, samples: Sample[]) => {
      this.handleSamples(trackId, samples);
    };
    
    this.mp4File.onError = (module: string, message: string) => {
      // Filter out non-fatal warnings about unknown metadata box types
      // These are common in files from Apple/QuickTime and don't affect playback
      if (message.includes('Invalid box type') || message.includes('Unknown box')) {
        console.warn(`[MP4FileSource] Ignoring unknown box: ${message}`);
        return;
      }
      
      const error = new Error(`MP4Box error in ${module}: ${message}`);
      this.events.onError?.(error);
    };
  }
  
  /**
   * Handle file ready event
   */
  private handleFileReady(info: Movie): void {
    // Find video track
    if (info.videoTracks.length > 0) {
      this.videoTrack = info.videoTracks[0];
      this.videoTrackId = this.videoTrack.id;
      this.totalVideoSamples = this.videoTrack.nb_samples;
      
      // Extract video description for decoder config
      const trak = this.mp4File?.getTrackById(this.videoTrackId);
      if (trak) {
        const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
        if (entry) {
          // Get avcC or hvcC box for codec description
          const avcC = (entry as any).avcC;
          const hvcC = (entry as any).hvcC;
          
          if (avcC) {
            // Serialize the avcC box to get proper description for WebCodecs
            // We need to write the box content (not the full box with header)
            this.videoDescription = this.serializeAvcC(avcC);
          } else if (hvcC) {
            // Serialize the hvcC box
            this.videoDescription = this.serializeHvcC(hvcC);
          }
        }
      }
    }
    
    // Find audio track
    if (info.audioTracks.length > 0) {
      this.audioTrack = info.audioTracks[0];
      this.audioTrackId = this.audioTrack.id;
      this.totalAudioSamples = this.audioTrack.nb_samples;
      
      // Extract audio description for decoder config (ESDS box for AAC)
      const audioTrak = this.mp4File?.getTrackById(this.audioTrackId);
      if (audioTrak) {
        const audioEntry = audioTrak.mdia?.minf?.stbl?.stsd?.entries?.[0];
        if (audioEntry) {
          const esds = (audioEntry as any).esds;
          if (esds) {
            // The DecoderSpecificInfo is nested in the descriptor hierarchy
            // Try different paths based on mp4box version
            let decoderConfig: Uint8Array | null = null;
            
            // Path 1: esd.descs[0].descs[0].data (DecoderConfigDescriptor -> DecoderSpecificInfo)
            if (esds.esd?.descs?.[0]?.descs?.[0]?.data) {
              decoderConfig = esds.esd.descs[0].descs[0].data;
            }
            // Path 2: Direct data on first descriptor
            else if (esds.esd?.descs?.[0]?.data) {
              decoderConfig = esds.esd.descs[0].data;
            }
            // Path 3: Try looking for DecoderSpecificInfo by tag (0x05)
            else if (esds.esd?.descs) {
              for (const desc of esds.esd.descs) {
                if (desc.tag === 0x04 && desc.descs) { // DecoderConfigDescriptor
                  for (const subdesc of desc.descs) {
                    if (subdesc.tag === 0x05 && subdesc.data) { // DecoderSpecificInfo
                      decoderConfig = subdesc.data;
                      break;
                    }
                  }
                }
                if (decoderConfig) break;
              }
            }
            
            if (decoderConfig) {
              this.audioDescription = decoderConfig;
            }
          }
        }
      }
    }
    
    if (!this.videoTrack) {
      this.events.onError?.(new Error('No video track found in file'));
      return;
    }
    
    // Build file info
    this.fileInfo = {
      duration: this.videoTrack.duration / this.videoTrack.timescale,
      timescale: this.videoTrack.timescale,
      width: this.videoTrack.video?.width ?? 0,
      height: this.videoTrack.video?.height ?? 0,
      videoCodec: this.videoTrack.codec,
      frameRate: this.videoTrack.nb_samples / (this.videoTrack.duration / this.videoTrack.timescale),
      bitrate: this.videoTrack.bitrate,
    };
    
    if (this.audioTrack) {
      this.fileInfo.audioCodec = this.audioTrack.codec;
      this.fileInfo.audioChannels = this.audioTrack.audio?.channel_count;
      this.fileInfo.audioSampleRate = this.audioTrack.audio?.sample_rate;
    }
    
    // Start demuxing IMMEDIATELY in onReady (like reference implementation)
    // This must happen before any more data is appended
    this.requestSamples();
    
    this.events.onReady?.(this.fileInfo);
  }
  
  /**
   * Request samples to be extracted
   */
  private requestSamples(): void {
    if (this.samplesRequested) return;
    this.samplesRequested = true;

    if (this.videoTrackId !== null) {
      // Request ALL samples at once (like the reference implementation)
      this.mp4File?.setExtractionOptions(this.videoTrackId, null, {
        nbSamples: this.totalVideoSamples,
      });
    }

    if (this.audioTrackId !== null) {
      this.mp4File?.setExtractionOptions(this.audioTrackId, null, {
        nbSamples: this.totalAudioSamples,
      });
    }

    this.mp4File?.start();
  }
  
  /**
   * Handle samples from mp4box
   */
  private handleSamples(trackId: number, samples: Sample[]): void {
    const isVideo = trackId === this.videoTrackId;
    const track = isVideo ? this.videoTrack : this.audioTrack;
    
    if (!track) return;
    
    const decodableSamples: DecodableSample[] = samples
      .filter(sample => {
        if (!sample.data) {
          console.warn(`[MP4FileSource] Sample ${sample.number} has no data`);
          return false;
        }
        return true;
      })
      .map(sample => {
        // Convert sample time to microseconds
        const timestampUs = (sample.cts / sample.timescale) * 1_000_000;
        const durationUs = (sample.duration / sample.timescale) * 1_000_000;
      
        return {
          data: sample.data!,
          timestamp: timestampUs,
          duration: durationUs,
          isKeyframe: sample.is_sync,
          type: isVideo ? 'video' : 'audio',
        };
    });
    
    // Update sample indices
    if (isVideo) {
      this.nextVideoSampleIndex += samples.length;
      
      // Check if we've reached the end
      if (this.nextVideoSampleIndex >= this.totalVideoSamples) {
        this.events.onEnded?.();
      }
    } else {
      this.nextAudioSampleIndex += samples.length;
    }
    
    // Release sample data to free memory
    if (this.mp4File) {
      const lastSample = samples[samples.length - 1];
      this.mp4File.releaseUsedSamples(trackId, lastSample.number);
    }
    
    this.events.onSamples?.(decodableSamples);
  }
  
  /**
   * Seek to a specific time in seconds
   * Returns the actual seek time (may be different due to keyframe alignment)
   */
  seek(timeSeconds: number): number {
    if (!this.mp4File || !this.videoTrackId) {
      return 0;
    }
    
    // Seek to nearest keyframe
    const result = this.mp4File.seek(timeSeconds, true);
    
    // Reset sample indices
    this.nextVideoSampleIndex = 0;
    this.nextAudioSampleIndex = 0;
    
    // Restart extraction from new position
    this.samplesRequested = false;
    this.mp4File.stop();
    this.requestSamples();
    
    return result.time;
  }
  
  /**
   * Get current position info
   */
  getPosition(): { currentSample: number; totalSamples: number; progress: number } {
    return {
      currentSample: this.nextVideoSampleIndex,
      totalSamples: this.totalVideoSamples,
      progress: this.totalVideoSamples > 0 
        ? this.nextVideoSampleIndex / this.totalVideoSamples 
        : 0,
    };
  }
  
  /**
   * Stop extraction
   */
  stop(): void {
    this.mp4File?.stop();
  }
  
  /**
   * Resume extraction
   */
  start(): void {
    this.mp4File?.start();
  }
  
  /**
   * Dispose and clean up
   */
  dispose(): void {
    this.mp4File?.stop();
    this.mp4File = null;
    this.fileInfo = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoDescription = null;
  }
  
  /**
   * Serialize avcC box content for WebCodecs description
   * Format: AVCDecoderConfigurationRecord
   */
  private serializeAvcC(avcC: any): Uint8Array {
    // Calculate total size
    let size = 6; // configurationVersion(1) + AVCProfileIndication(1) + profile_compatibility(1) + AVCLevelIndication(1) + lengthSizeMinusOne(1) + numOfSPS(1)
    
    // Add SPS sizes
    const sps = avcC.SPS || [];
    for (const nalu of sps) {
      size += 2 + nalu.data.length; // 2 bytes for length + nalu data
    }
    
    size += 1; // numOfPPS
    
    // Add PPS sizes
    const pps = avcC.PPS || [];
    for (const nalu of pps) {
      size += 2 + nalu.data.length; // 2 bytes for length + nalu data
    }
    
    // Create buffer and write
    const buffer = new Uint8Array(size);
    let offset = 0;
    
    buffer[offset++] = avcC.configurationVersion || 1;
    buffer[offset++] = avcC.AVCProfileIndication;
    buffer[offset++] = avcC.profile_compatibility;
    buffer[offset++] = avcC.AVCLevelIndication;
    buffer[offset++] = 0xFF; // lengthSizeMinusOne = 3 (4-byte NAL lengths) + reserved bits
    buffer[offset++] = 0xE0 | sps.length; // numOfSPS + reserved bits
    
    // Write SPS
    for (const nalu of sps) {
      const len = nalu.data.length;
      buffer[offset++] = (len >> 8) & 0xFF;
      buffer[offset++] = len & 0xFF;
      buffer.set(new Uint8Array(nalu.data), offset);
      offset += len;
    }
    
    buffer[offset++] = pps.length; // numOfPPS
    
    // Write PPS
    for (const nalu of pps) {
      const len = nalu.data.length;
      buffer[offset++] = (len >> 8) & 0xFF;
      buffer[offset++] = len & 0xFF;
      buffer.set(new Uint8Array(nalu.data), offset);
      offset += len;
    }
    
    return buffer;
  }
  
  /**
   * Serialize hvcC box content for WebCodecs description
   * Format: HEVCDecoderConfigurationRecord
   */
  private serializeHvcC(hvcC: any): Uint8Array {
    // For HEVC, the structure is more complex
    // For now, just return the raw data if available
    if (hvcC.data && hvcC.data instanceof Uint8Array) {
      return hvcC.data;
    }
    
    // Simplified: return empty if we can't serialize
    console.warn('HEVC serialization not fully implemented');
    return new Uint8Array(0);
  }
}
