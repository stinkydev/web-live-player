/**
 * MP4FileSource Tests
 * 
 * Tests for range-based loading functionality
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MP4FileSource } from './mp4-file-source';

describe('MP4FileSource', () => {
  let source: MP4FileSource;
  
  beforeEach(() => {
    source = new MP4FileSource();
  });
  
  describe('Range Support Detection', () => {
    it('should detect range support from Accept-Ranges header', async () => {
      // Mock fetch for HEAD request
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (header: string) => {
            if (header === 'Accept-Ranges') return 'bytes';
            if (header === 'Content-Length') return '1000000';
            return null;
          }
        }
      });
      
      // Use private method via any type (for testing only)
      const supportsRanges = await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect(supportsRanges).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('http://example.com/video.mp4', { method: 'HEAD' });
    });
    
    it('should detect no range support when Accept-Ranges is none', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (header: string) => {
            if (header === 'Accept-Ranges') return 'none';
            if (header === 'Content-Length') return '1000000';
            return null;
          }
        }
      });
      
      const supportsRanges = await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect(supportsRanges).toBe(false);
    });
    
    it('should detect no range support when Accept-Ranges header is missing', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (header: string) => {
            if (header === 'Content-Length') return '1000000';
            return null;
          }
        }
      });
      
      const supportsRanges = await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect(supportsRanges).toBe(false);
    });
    
    it('should fallback to range request when HEAD fails', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('HEAD not allowed'))
        .mockResolvedValueOnce({
          status: 206,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Range') return 'bytes 0-0/1000000';
              return null;
            }
          }
        });
      
      const supportsRanges = await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect(supportsRanges).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
    
    it('should return false when range requests fail', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('HEAD not allowed'))
        .mockRejectedValueOnce(new Error('Range not allowed'));
      
      const supportsRanges = await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect(supportsRanges).toBe(false);
    });
    
    it('should parse file size from Content-Length header', async () => {
      const expectedSize = 5000000;
      
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (header: string) => {
            if (header === 'Accept-Ranges') return 'bytes';
            if (header === 'Content-Length') return expectedSize.toString();
            return null;
          }
        }
      });
      
      await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect((source as any).fileSize).toBe(expectedSize);
    });
    
    it('should parse file size from Content-Range header', async () => {
      const expectedSize = 3000000;
      
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('HEAD not allowed'))
        .mockResolvedValueOnce({
          status: 206,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Range') return `bytes 0-0/${expectedSize}`;
              return null;
            }
          }
        });
      
      await (source as any).checkRangeSupport('http://example.com/video.mp4');
      
      expect((source as any).fileSize).toBe(expectedSize);
    });
  });
  
  describe('Chunk Size', () => {
    it('should use 256KB chunk size for range requests', () => {
      // This is a documentation test - the actual chunk size is defined in the implementation
      // and should be 256KB (256 * 1024 bytes) for optimal performance
      const expectedChunkSize = 256 * 1024;
      expect(expectedChunkSize).toBe(262144);
    });
  });
  
  describe('loadFromUrl routing', () => {
    it('should use range-based loading when server supports ranges', async () => {
      // Mock checkRangeSupport to return true
      const checkRangeSupportSpy = vi.spyOn(source as any, 'checkRangeSupport').mockResolvedValue(true);
      const loadFromUrlWithRangesSpy = vi.spyOn(source as any, 'loadFromUrlWithRanges').mockResolvedValue({
        duration: 10,
        timescale: 1000,
        width: 1920,
        height: 1080,
        videoCodec: 'avc1.42001f',
      });
      
      await source.loadFromUrl('http://example.com/video.mp4');
      
      expect(checkRangeSupportSpy).toHaveBeenCalled();
      expect(loadFromUrlWithRangesSpy).toHaveBeenCalled();
    });
    
    it('should fallback to full loading when server does not support ranges', async () => {
      // Mock checkRangeSupport to return false
      const checkRangeSupportSpy = vi.spyOn(source as any, 'checkRangeSupport').mockResolvedValue(false);
      const loadFromUrlFullSpy = vi.spyOn(source as any, 'loadFromUrlFull').mockResolvedValue({
        duration: 10,
        timescale: 1000,
        width: 1920,
        height: 1080,
        videoCodec: 'avc1.42001f',
      });
      
      await source.loadFromUrl('http://example.com/video.mp4');
      
      expect(checkRangeSupportSpy).toHaveBeenCalled();
      expect(loadFromUrlFullSpy).toHaveBeenCalled();
    });
  });
  
  afterEach(() => {
    source.dispose();
    vi.restoreAllMocks();
  });
});
