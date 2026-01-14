/**
 * Sesame Binary Protocol - TypeScript Implementation
 * 
 * This module provides TypeScript implementation of the Sesame binary protocol
 * for serializing and deserializing multimedia data packets.
 */

// Protocol constants
export const PROTOCOL_MAGIC = 0x4D534553; // 'SESM'
export const PROTOCOL_VERSION = 1;

// Header size constants (computed to match C++ sizeof results)
// HeaderData: uint32(4) + uint32(4) + uint64(8) + uint64(8) + uint16(2) + uint16(2) + uint16(2) = 30 bytes + 2 bytes padding = 32 bytes
export const HEADER_DATA_SIZE = 32;
// HeaderCodecData: uint32(4) + uint32(4) + uint32(4) + uint16(2) + uint16(2) + uint16(2) + uint16(2) + uint8(1) + uint8(1) + uint8(1) + uint8(1) = 24 bytes
export const HEADER_CODEC_DATA_SIZE = 24;
// HeaderMetadata: char[64] = 64 bytes
export const HEADER_METADATA_SIZE = 64;

// Feature flags
export const FLAG_HAS_CODEC_DATA = 1 << 0;
export const FLAG_HAS_METADATA = 1 << 1;
export const FLAG_IS_KEYFRAME = 1 << 2;

// Packet types
export enum PacketType {
  VIDEO_FRAME = 1,
  AUDIO_FRAME = 2,
  RPC = 3,
  MUXED_DATA = 4,
  DECODER_DATA = 5
}

export enum CodecType {
  VIDEO_VP8 = 1,
  VIDEO_VP9 = 2,
  VIDEO_AVC = 3,
  VIDEO_HEVC = 4,
  VIDEO_AV1 = 5,
  AUDIO_OPUS = 64,
  AUDIO_AAC = 65,
  AUDIO_PCM = 66,
}

// Header data structure (32 bytes total - 8-byte aligned)
// Layout matches C++ version exactly
export interface HeaderData {
  magic: number;         // uint32_t - 4 bytes (offset 0)
  flags: number;         // uint32_t - 4 bytes (offset 4)
  pts: bigint;          // uint64_t - 8 bytes (offset 8) 
  id: bigint;           // uint64_t - 8 bytes (offset 16)
  version: number;      // uint16_t - 2 bytes (offset 24)
  header_size: number;  // uint16_t - 2 bytes (offset 26)
  type: PacketType;     // uint16_t - 2 bytes (offset 28)
  reserved: number;     // uint16_t - 2 bytes (offset 30) - RESERVED for future use
}

// Codec data structure (24 bytes total - perfectly 8-byte aligned)
// Layout matches C++ version exactly
export interface HeaderCodecData {
  sample_rate: number;   // uint32_t - 4 bytes (offset 0)
  timebase_num: number;  // uint32_t - 4 bytes (offset 4)
  timebase_den: number;  // uint32_t - 4 bytes (offset 8)
  codec_profile: number; // uint16_t - 2 bytes (offset 12)
  codec_level: number;   // uint16_t - 2 bytes (offset 14)
  width: number;         // uint16_t - 2 bytes (offset 16)
  height: number;        // uint16_t - 2 bytes (offset 18)
  codec_type: CodecType; // uint8_t - 1 byte (offset 20)
  channels: number;      // uint8_t - 1 byte (offset 21)
  bit_depth: number;     // uint8_t - 1 byte (offset 22)
  reserved: number;      // uint8_t - 1 byte (offset 23) - RESERVED for future use
}

// Metadata structure (64 bytes total)
export interface HeaderMetadata {
  metadata: string; // null-terminated string up to 64 chars
}

// Parsed data structure
export interface ParsedData {
  valid: boolean;
  header: HeaderData | null;
  metadata: HeaderMetadata | null;
  codec_data: HeaderCodecData | null;
  payload: Uint8Array | null;
  payload_size: number;
}

/**
 * Main binary protocol class with static methods for serialization/deserialization
 */
export class SesameBinaryProtocol {
  
  /**
   * Initialize a header data structure with proper defaults
   */
  static initHeader(
    type: PacketType,
    flags: number,
    pts: bigint,
    id: bigint
  ): HeaderData {
    return {
      magic: PROTOCOL_MAGIC,
      version: PROTOCOL_VERSION,
      header_size: this.calculateHeaderSize(flags),
      type,
      flags,
      pts,
      id,
      reserved: 0 // Always zero reserved fields
    };
  }

  /**
   * Calculate the total header size based on flags
   */
  static calculateHeaderSize(flags: number): number {
    let size = HEADER_DATA_SIZE;
    
    if (flags & FLAG_HAS_METADATA) {
      size += HEADER_METADATA_SIZE;
    }
    
    if (flags & FLAG_HAS_CODEC_DATA) {
      size += HEADER_CODEC_DATA_SIZE;
    }
    
    return size;
  }

  /**
   * Validate a header structure
   */
  static validateHeader(header: HeaderData, totalSize: number): boolean {
    // Check magic number
    if (header.magic !== PROTOCOL_MAGIC) {
      return false;
    }

    // Check version
    if (header.version !== PROTOCOL_VERSION) {
      return false;
    }

    // Check header size matches expected size based on flags
    const expectedHeaderSize = this.calculateHeaderSize(header.flags);
    if (header.header_size !== expectedHeaderSize) {
      return false;
    }

    // Check that total size is at least as large as header size
    if (totalSize < header.header_size) {
      return false;
    }

    return true;
  }

  /**
   * Serialize data into a Uint8Array buffer
   */
  static serialize(
    header: HeaderData,
    metadata: HeaderMetadata | null = null,
    codecData: HeaderCodecData | null = null,
    payload: Uint8Array | null = null
  ): Uint8Array | null {
    
    // Determine what optional data to include based on flags
    const includeMetadata = metadata !== null && (header.flags & FLAG_HAS_METADATA);
    const includeCodec = codecData !== null && (header.flags & FLAG_HAS_CODEC_DATA);
    
    // Calculate total size
    let totalSize = HEADER_DATA_SIZE;
    if (includeMetadata) totalSize += HEADER_METADATA_SIZE;
    if (includeCodec) totalSize += HEADER_CODEC_DATA_SIZE;
    if (payload) totalSize += payload.length;

    // Update header size
    header.header_size = totalSize - (payload ? payload.length : 0);

    // Create buffer
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Write header (following C++ field order exactly)
    view.setUint32(offset, header.magic, true); offset += 4;
    view.setUint32(offset, header.flags, true); offset += 4;
    view.setBigUint64(offset, header.pts, true); offset += 8;
    view.setBigUint64(offset, header.id, true); offset += 8;
    view.setUint16(offset, header.version, true); offset += 2;
    view.setUint16(offset, header.header_size, true); offset += 2;
    view.setUint16(offset, header.type, true); offset += 2;
    view.setUint16(offset, header.reserved, true); offset += 2;

    // Write metadata if present
    if (includeMetadata && metadata) {
      const metadataBytes = this.stringToFixedBytes(metadata.metadata, 64);
      new Uint8Array(buffer, offset, 64).set(metadataBytes);
      offset += 64;
    }

    // Write codec data if present (following C++ field order exactly)
    if (includeCodec && codecData) {
      view.setUint32(offset, codecData.sample_rate, true); offset += 4;
      view.setUint32(offset, codecData.timebase_num, true); offset += 4;
      view.setUint32(offset, codecData.timebase_den, true); offset += 4;
      view.setUint16(offset, codecData.codec_profile, true); offset += 2;
      view.setUint16(offset, codecData.codec_level, true); offset += 2;
      view.setUint16(offset, codecData.width, true); offset += 2;
      view.setUint16(offset, codecData.height, true); offset += 2;
      view.setUint8(offset, codecData.codec_type); offset += 1;
      view.setUint8(offset, codecData.channels); offset += 1;
      view.setUint8(offset, codecData.bit_depth); offset += 1;
      view.setUint8(offset, codecData.reserved); offset += 1;
    }

    // Write payload
    if (payload && payload.length > 0) {
      new Uint8Array(buffer, offset).set(payload);
    }

    return new Uint8Array(buffer);
  }

  /**
   * Parse incoming binary data
   */
  static parseData(data: Uint8Array): ParsedData {
    const result: ParsedData = {
      valid: false,
      header: null,
      metadata: null,
      codec_data: null,
      payload: null,
      payload_size: 0
    };

    if (!data || data.length < 36) {
      return result;
    }

    const view = new DataView(data.buffer, data.byteOffset);
    let offset = 0;

    // Parse header (following C++ field order exactly)
    const header: HeaderData = {
      magic: view.getUint32(offset, true),
      flags: view.getUint32(offset + 4, true),
      pts: view.getBigUint64(offset + 8, true),
      id: view.getBigUint64(offset + 16, true),
      version: view.getUint16(offset + 24, true),
      header_size: view.getUint16(offset + 26, true),
      type: view.getUint16(offset + 28, true) as PacketType,
      reserved: view.getUint16(offset + 30, true)
    };
    offset += HEADER_DATA_SIZE;

    if (!this.validateHeader(header, data.length)) {
      return result;
    }

    result.header = header;

    // Parse metadata if present
    if (header.flags & FLAG_HAS_METADATA) {
      if (data.length < offset + HEADER_METADATA_SIZE) {
        return result; // Invalid - not enough data
      }
      
      const metadataBytes = data.slice(offset, offset + HEADER_METADATA_SIZE);
      const metadataStr = this.fixedBytesToString(metadataBytes);
      result.metadata = { metadata: metadataStr };
      offset += HEADER_METADATA_SIZE;
    }

    // Parse codec data if present
    if (header.flags & FLAG_HAS_CODEC_DATA) {
      if (data.length < offset + HEADER_CODEC_DATA_SIZE) {
        return result; // Invalid - not enough data
      }

      result.codec_data = {
        sample_rate: view.getUint32(offset, true),
        timebase_num: view.getUint32(offset + 4, true),
        timebase_den: view.getUint32(offset + 8, true),
        codec_profile: view.getUint16(offset + 12, true),
        codec_level: view.getUint16(offset + 14, true),
        width: view.getUint16(offset + 16, true),
        height: view.getUint16(offset + 18, true),
        codec_type: view.getUint8(offset + 20),
        channels: view.getUint8(offset + 21),
        bit_depth: view.getUint8(offset + 22),
        reserved: view.getUint8(offset + 23)
      };
      offset += HEADER_CODEC_DATA_SIZE;
    }

    // Set payload pointer and size
    if (offset < data.length) {
      result.payload = data.slice(offset);
      result.payload_size = result.payload.length;
    } else {
      result.payload = new Uint8Array(0);
      result.payload_size = 0;
    }

    result.valid = true;
    return result;
  }

  /**
   * Helper: Convert string to fixed-size byte array (null-terminated)
   */
  private static stringToFixedBytes(str: string, size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    
    // Use TextEncoder if available (Node.js/modern browsers), otherwise fallback to UTF-8 encoding
    let encoded: Uint8Array;
    if (typeof TextEncoder !== 'undefined') {
      const encoder = new TextEncoder();
      encoded = encoder.encode(str);
    } else {
      // Fallback for environments without TextEncoder
      encoded = new Uint8Array(Buffer.from(str, 'utf8'));
    }
    
    // Copy up to size-1 bytes to leave room for null terminator
    const copyLen = Math.min(encoded.length, size - 1);
    bytes.set(encoded.slice(0, copyLen));
    
    // Null terminate
    bytes[copyLen] = 0;
    
    return bytes;
  }

  /**
   * Helper: Convert fixed-size byte array to string (null-terminated)
   */
  private static fixedBytesToString(bytes: Uint8Array): string {
    // Find null terminator
    let len = bytes.length;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        len = i;
        break;
      }
    }
    
    // Use TextDecoder if available (Node.js/modern browsers), otherwise fallback to Buffer
    if (typeof TextDecoder !== 'undefined') {
      const decoder = new TextDecoder();
      return decoder.decode(bytes.slice(0, len));
    } else {
      // Fallback for environments without TextDecoder
      return Buffer.from(bytes.slice(0, len)).toString('utf8');
    }
  }
}

// All interfaces and enums are already exported above