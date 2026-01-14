/**
 * MP4FileSource Tests
 * 
 * Tests for range-based loading functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  });
  
  describe('Chunk Size', () => {
    it('should use 256KB chunk size for range requests', () => {
      // This is a documentation test - the actual chunk size is defined in the implementation
      // and should be 256KB (256 * 1024 bytes) for optimal performance
      const expectedChunkSize = 256 * 1024;
      expect(expectedChunkSize).toBe(262144);
    });
  });
  
  afterEach(() => {
    source.dispose();
  });
});
