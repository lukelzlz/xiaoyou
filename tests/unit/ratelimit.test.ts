import { describe, expect, it, beforeEach } from 'vitest';
import { RateLimiter } from '../../src/gateway/ratelimit.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('应该允许正常频率的请求通过', () => {
    expect(limiter.check('user-1')).toBe(true);
    expect(limiter.check('user-1')).toBe(true);
  });

  it('应该在超出限制后拒绝请求', () => {
    const userId = 'user-flood';
    // 快速发送大量请求直到被限制
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if (!limiter.check(userId)) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });

  it('不同用户之间不应互相影响', () => {
    // 耗尽 user-a 的配额
    for (let i = 0; i < 100; i++) {
      limiter.check('user-a');
    }
    // user-b 应该仍然可以通过
    expect(limiter.check('user-b')).toBe(true);
  });

  it('getRemaining 应该返回剩余次数', () => {
    const result = limiter.getRemaining('user-new');
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('destroy 不应抛出异常', () => {
    expect(() => limiter.destroy()).not.toThrow();
  });
});
