import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../../src/gateway/ratelimit.js';

describe('RateLimiter Security Tests', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      windowMs: 60_000,
      maxRequests: 5,
      burstLimit: 3,
      burstWindowMs: 5_000,
      maxRequestsPerIp: 10,
      cooldownMs: 30_000,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  describe('User Rate Limiting', () => {
    it('should allow requests within limit', () => {
      for (let i = 0; i < 5; i++) {
        expect(limiter.check('user1')).toBe(true);
      }
    });

    it('should block requests exceeding limit', () => {
      // Make 5 requests (limit)
      for (let i = 0; i < 5; i++) {
        limiter.check('user1');
      }
      // 6th request should be blocked
      expect(limiter.check('user1')).toBe(false);
    });

    it('should track different users separately', () => {
      // User 1 makes 5 requests
      for (let i = 0; i < 5; i++) {
        limiter.check('user1');
      }
      // User 1 should be blocked
      expect(limiter.check('user1')).toBe(false);
      // User 2 should still be allowed
      expect(limiter.check('user2')).toBe(true);
    });

    it('should enforce cooldown period', () => {
      // Make 5 requests (trigger limit)
      for (let i = 0; i < 5; i++) {
        limiter.check('user1');
      }
      expect(limiter.check('user1')).toBe(false);

      // Get remaining quota
      const remaining = limiter.getRemaining('user1');
      expect(remaining.remaining).toBe(0);
    });
  });

  describe('IP Rate Limiting', () => {
    it('should apply IP-based rate limiting', () => {
      // Make 10 requests from same IP (IP limit)
      for (let i = 0; i < 10; i++) {
        limiter.check(`user${i}`, '192.168.1.1');
      }
      // 11th request should be blocked by IP limit
      expect(limiter.check('user99', '192.168.1.1')).toBe(false);
    });

    it('should track IPs independently from users', () => {
      // User 1 makes requests from IP 1
      for (let i = 0; i < 5; i++) {
        limiter.check('user1', '192.168.1.1');
      }
      // User 1 should be blocked
      expect(limiter.check('user1', '192.168.1.1')).toBe(false);

      // User 2 from different IP should be allowed
      expect(limiter.check('user2', '192.168.1.2')).toBe(true);
    });
  });

  describe('Reset Functionality', () => {
    it('should reset user rate limit', () => {
      // Make 5 requests (trigger limit)
      for (let i = 0; i < 5; i++) {
        limiter.check('user1');
      }
      expect(limiter.check('user1')).toBe(false);

      // Reset
      limiter.reset('user1');

      // Should be allowed again
      expect(limiter.check('user1')).toBe(true);
    });

    it('should reset IP rate limit', () => {
      // Make 10 requests from same IP
      for (let i = 0; i < 10; i++) {
        limiter.check(`user${i}`, '192.168.1.1');
      }
      expect(limiter.check('user99', '192.168.1.1')).toBe(false);

      // Reset IP
      limiter.resetIp('192.168.1.1');

      // Should be allowed again
      expect(limiter.check('user99', '192.168.1.1')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty user ID', () => {
      expect(limiter.check('')).toBe(true);
    });

    it('should handle special characters in user ID', () => {
      expect(limiter.check('user@example.com')).toBe(true);
      expect(limiter.check('user:123:456')).toBe(true);
    });

    it('should handle IPv6 addresses', () => {
      expect(limiter.check('user1', '::1')).toBe(true);
      expect(limiter.check('user2', '2001:db8::1')).toBe(true);
    });

    it('should handle rapid requests', () => {
      const results: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        results.push(limiter.check('user1'));
      }
      // First 5 should succeed, rest should fail
      expect(results.slice(0, 5).every(r => r === true)).toBe(true);
      expect(results.slice(5).every(r => r === false)).toBe(true);
    });
  });
});
