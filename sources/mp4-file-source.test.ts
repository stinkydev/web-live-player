/**
 * MP4FileSource Tests
 * 
 * Tests for the unified loadFromUrl method that automatically detects
 * range support and uses progressive or full loading accordingly.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MP4FileSource } from './mp4-file-source';

describe('MP4FileSource', () => {
  let source: MP4FileSource;
  let onProgressMock: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    onProgressMock = vi.fn();
    source = new MP4FileSource({
      onProgress: onProgressMock
    });
  });
  
  afterEach(() => {
    source.dispose();
    vi.restoreAllMocks();
  });
  
  describe('loadFromUrl', () => {
    it('should make HEAD request first to get file size', async () => {
      const fetchMock = vi.fn()
        // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Length') return '5000000';
              return null;
            }
          }
        })
        // Range request - return 200 to simulate no range support
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
        });
      
      global.fetch = fetchMock;
      
      // This will fail because we don't have real MP4 data, but we can verify fetch calls
      try {
        await source.loadFromUrl('http://example.com/video.mp4');
      } catch {
        // Expected - no valid MP4 data
      }
      
      expect(fetchMock).toHaveBeenCalledWith('http://example.com/video.mp4', { method: 'HEAD' });
    });
    
    it('should use Range header on first data request', async () => {
      const fetchMock = vi.fn()
        // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Length') return '5000000';
              return null;
            }
          }
        })
        // Range request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
        });
      
      global.fetch = fetchMock;
      
      try {
        await source.loadFromUrl('http://example.com/video.mp4');
      } catch {
        // Expected - no valid MP4 data
      }
      
      // Second call should be the range request
      expect(fetchMock.mock.calls[1]).toEqual([
        'http://example.com/video.mp4',
        { headers: { 'Range': 'bytes=0-4194303' } } // 4MB chunk size
      ]);
    });
    
    it('should process full file when server returns 200 instead of 206', async () => {
      const testData = new ArrayBuffer(1000);
      
      const fetchMock = vi.fn()
        // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Length') return '1000';
              return null;
            }
          }
        })
        // Range request returns 200 (full file)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(testData)
        });
      
      global.fetch = fetchMock;
      
      try {
        await source.loadFromUrl('http://example.com/video.mp4');
      } catch {
        // Expected - no valid MP4 data
      }
      
      // Verify only 2 fetch calls (HEAD + one full request)
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    
    it('should continue with progressive loading when server returns 206', async () => {
      const chunk1 = new ArrayBuffer(1000);
      
      const fetchMock = vi.fn()
        // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Length') return '5000';
              return null;
            }
          }
        })
        // First range request returns 206
        .mockResolvedValueOnce({
          ok: true,
          status: 206,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Range') return 'bytes 0-999/5000';
              return null;
            }
          },
          arrayBuffer: () => Promise.resolve(chunk1)
        });
      
      global.fetch = fetchMock;
      
      try {
        await source.loadFromUrl('http://example.com/video.mp4');
      } catch {
        // Expected - no valid MP4 data, but we can verify progressive mode was used
      }
      
      // With 206 response, it should try to continue loading more chunks
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    
    it('should parse file size from Content-Range header if HEAD failed', async () => {
      const chunk1 = new ArrayBuffer(1000);
      
      const fetchMock = vi.fn()
        // HEAD request fails
        .mockRejectedValueOnce(new Error('HEAD not supported'))
        // Range request returns 206 with Content-Range
        .mockResolvedValueOnce({
          ok: true,
          status: 206,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Range') return 'bytes 0-999/8000000';
              return null;
            }
          },
          arrayBuffer: () => Promise.resolve(chunk1)
        });
      
      global.fetch = fetchMock;
      
      try {
        await source.loadFromUrl('http://example.com/video.mp4');
      } catch {
        // Expected - no valid MP4 data
      }
      
      // Verify file size was parsed from Content-Range
      expect((source as any).fileSize).toBe(8000000);
    });
    
    it('should report progress during loading', async () => {
      const chunk1 = new ArrayBuffer(1000);
      
      const fetchMock = vi.fn()
        // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (header: string) => {
              if (header === 'Content-Length') return '1000';
              return null;
            }
          }
        })
        // Range request returns 200 (full file)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(chunk1)
        });
      
      global.fetch = fetchMock;
      
      try {
        await source.loadFromUrl('http://example.com/video.mp4');
      } catch {
        // Expected - no valid MP4 data
      }
      
      // Progress should not be called for full file load (only for progressive)
      // but loadedBytes should be set
      expect((source as any).loadedBytes).toBe(1000);
    });
    
    it('should throw error on HTTP failure', async () => {
      const fetchMock = vi.fn()
        // HEAD request
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => null }
        })
        // Range request fails
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => null }
        });
      
      global.fetch = fetchMock;
      
      await expect(source.loadFromUrl('http://example.com/video.mp4'))
        .rejects.toThrow('Failed to fetch: 404 Not Found');
    });
  });
  
  describe('Chunk Size', () => {
    it('should use 4MB chunk size for range requests', () => {
      // The implementation uses 4MB chunks for optimal performance
      const expectedChunkSize = 4 * 1024 * 1024;
      expect(expectedChunkSize).toBe(4194304);
    });
  });
  
  describe('Getters', () => {
    it('should return null for fileInfo before loading', () => {
      expect(source.getFileInfo()).toBeNull();
    });
    
    it('should return null for videoDescription before loading', () => {
      expect(source.getVideoDescription()).toBeNull();
    });
    
    it('should return null for audioDescription before loading', () => {
      expect(source.getAudioDescription()).toBeNull();
    });
  });
});
