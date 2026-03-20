import { describe, it, expect, beforeEach } from 'vitest';
import { MultimodalExtractor, AttachmentValidationError } from '../../src/gateway/multimodal.js';

describe('MultimodalExtractor Security Tests', () => {
  let extractor: MultimodalExtractor;

  beforeEach(() => {
    extractor = new MultimodalExtractor({});
  });

  describe('SSRF Protection', () => {
    it('should block requests to localhost', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'http://localhost:8080/image.png',
        name: 'test.png',
        mimeType: 'image/png',
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      expect(results[0].metadata?.message).toContain('私有网络地址');
    });

    it('should block requests to 127.0.0.1', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'http://127.0.0.1:8080/image.png',
        name: 'test.png',
        mimeType: 'image/png',
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      expect(results[0].metadata?.message).toContain('私有网络地址');
    });

    it('should block requests to private IP ranges (10.x.x.x)', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'http://10.0.0.1/image.png',
        name: 'test.png',
        mimeType: 'image/png',
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      expect(results[0].metadata?.message).toContain('私有网络地址');
    });

    it('should block requests to private IP ranges (172.16-31.x.x)', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'http://172.16.0.1/image.png',
        name: 'test.png',
        mimeType: 'image/png',
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      expect(results[0].metadata?.message).toContain('私有网络地址');
    });

    it('should block requests to private IP ranges (192.168.x.x)', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'http://192.168.1.1/image.png',
        name: 'test.png',
        mimeType: 'image/png',
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      expect(results[0].metadata?.message).toContain('私有网络地址');
    });

    it('should block requests with invalid protocols', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'file:///etc/passwd',
        name: 'passwd',
        // Don't specify mimeType to avoid MIME validation first
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      const message = results[0].metadata?.message || '';
      expect(message).toContain('协议');
    });

    it('should allow requests to public IPs', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'https://example.com/image.png',
        name: 'test.png',
        mimeType: 'image/png',
        size: 1000,
      };

      // This should not throw SSRF error (may fail for other reasons like network)
      const results = await extractor.extract([attachment]);
      // We're not checking success because the URL might not exist
      // We're just ensuring no SSRF error is thrown
      const message = results[0].metadata?.message || '';
      expect(message).not.toContain('私有网络地址');
    });
  });

  describe('File Size Validation', () => {
    it('should reject files larger than 10MB', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'https://example.com/large.png',
        name: 'large.png',
        mimeType: 'image/png',
        size: 11 * 1024 * 1024, // 11MB
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      expect(results[0].metadata?.message).toContain('大小超过限制');
    });

    it('should allow files smaller than 10MB', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'https://example.com/small.png',
        name: 'small.png',
        mimeType: 'image/png',
        size: 5 * 1024 * 1024, // 5MB
      };

      const results = await extractor.extract([attachment]);
      const message = results[0].metadata?.message || '';
      expect(message).not.toContain('大小超过限制');
    });
  });

  describe('MIME Type Validation', () => {
    it('should reject invalid MIME types for images', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'https://example.com/image.exe',
        name: 'malware.exe',
        mimeType: 'application/x-msdownload',
        size: 1000,
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      const message = results[0].metadata?.message || '';
      expect(message).toContain('MIME 类型');
    });

    it('should allow valid image MIME types', async () => {
      const validMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

      for (const mimeType of validMimeTypes) {
        const attachment = {
          type: 'image' as const,
          url: `https://example.com/image.${mimeType.split('/')[1]}`,
          name: `image.${mimeType.split('/')[1]}`,
          mimeType,
          size: 1000,
        };

        const results = await extractor.extract([attachment]);
        const message = results[0].metadata?.message || '';
        expect(message).not.toContain('MIME 类型');
      }
    });
  });

  describe('URL Validation', () => {
    it('should reject URLs longer than 2048 characters', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2100);
      const attachment = {
        type: 'image' as const,
        url: longUrl,
        name: 'test.png',
        mimeType: 'image/png',
        size: 1000,
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      const message = results[0].metadata?.message || '';
      expect(message).toContain('URL 长度');
    });

    it('should reject malformed URLs', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'not-a-valid-url',
        name: 'test.png',
        mimeType: 'image/png',
        size: 1000,
      };

      const results = await extractor.extract([attachment]);
      expect(results[0].metadata?.error).toBe(true);
      const message = results[0].metadata?.message || '';
      expect(message).toContain('URL');
    });
  });

  describe('SSRF Protection for Public URLs', () => {
    it('should allow requests to public IPs', async () => {
      const attachment = {
        type: 'image' as const,
        url: 'https://example.com/image.png',
        name: 'test.png',
        mimeType: 'image/png',
        size: 1000,
      };

      // This should not throw SSRF error (may fail for other reasons like network)
      const results = await extractor.extract([attachment]);
      // We're not checking success because the URL might not exist
      // We're just ensuring no SSRF error is thrown
      const message = results[0].metadata?.message || '';
      expect(message).not.toContain('私有网络地址');
    });
  });
});
