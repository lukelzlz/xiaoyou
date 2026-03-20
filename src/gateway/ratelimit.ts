import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('ratelimit');

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  lastRequest: number;
  burstCount: number;
  lastBurstReset: number;
}

export interface RateLimitConfig {
  /** 时间窗口（毫秒） */
  windowMs: number;
  /** 窗口内最大请求数 */
  maxRequests: number;
  /** 被限流后的冷却时间（毫秒） */
  cooldownMs: number;
  /** 突发请求限制（短时间内允许的额外请求数） */
  burstLimit: number;
  /** 突发窗口（毫秒） */
  burstWindowMs: number;
  /** IP 限流：每个 IP 的最大请求数 */
  maxRequestsPerIp: number;
}

const defaultConfig: RateLimitConfig = {
  windowMs: 60_000,        // 1 分钟
  maxRequests: 20,         // 每分钟 20 条
  cooldownMs: 30_000,      // 冷却 30 秒
  burstLimit: 5,           // 突发请求限制 5 条
  burstWindowMs: 5_000,    // 突发窗口 5 秒
  maxRequestsPerIp: 100,   // 每个 IP 每分钟最多 100 条
};

export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private blockedUntil: Map<string, number> = new Map();
  private ipLimits: Map<string, RateLimitEntry> = new Map();
  private ipBlockedUntil: Map<string, number> = new Map();
  private config: RateLimitConfig;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...defaultConfig, ...config };

    // 定期清理过期的限流记录
    this.cleanupInterval = setInterval(() => this.cleanup(), this.config.windowMs * 2);
  }

  /**
   * 检查用户是否被限流
   * @param userId 用户 ID
   * @param ip 可选的 IP 地址，用于 IP 级别限流
   * @returns true 表示允许通过，false 表示被限流
   */
  check(userId: string, ip?: string): boolean {
    const now = Date.now();

    // 1. IP 级别限流检查（如果提供了 IP）
    if (ip && !this.checkIpLimit(ip, now)) {
      log.info({ ip }, 'IP 触发速率限制');
      return false;
    }

    // 2. 检查用户是否在冷却期内
    const blockedUntil = this.blockedUntil.get(userId);
    if (blockedUntil && now < blockedUntil) {
      log.debug({ userId, remainingMs: blockedUntil - now }, '用户仍在冷却期');
      return false;
    }

    // 冷却期结束，清除封锁
    if (blockedUntil && now >= blockedUntil) {
      this.blockedUntil.delete(userId);
      this.limits.delete(userId);
    }

    const entry = this.limits.get(userId);

    if (!entry) {
      // 首次请求
      this.limits.set(userId, {
        count: 1,
        firstRequest: now,
        lastRequest: now,
        burstCount: 1,
        lastBurstReset: now,
      });
      return true;
    }

    // 检查是否在时间窗口内
    if (now - entry.firstRequest > this.config.windowMs) {
      // 窗口已过期，重置计数
      this.limits.set(userId, {
        count: 1,
        firstRequest: now,
        lastRequest: now,
        burstCount: 1,
        lastBurstReset: now,
      });
      return true;
    }

    // 3. 突发请求检查
    if (now - entry.lastBurstReset > this.config.burstWindowMs) {
      // 重置突发计数
      entry.burstCount = 1;
      entry.lastBurstReset = now;
    } else if (entry.burstCount >= this.config.burstLimit) {
      // 突发请求超限，但检查总体限制
      if (entry.count >= this.config.maxRequests) {
        this.blockedUntil.set(userId, now + this.config.cooldownMs);
        log.info(
          { userId, count: entry.count, windowMs: this.config.windowMs },
          '用户触发速率限制',
        );
        return false;
      }
    } else {
      entry.burstCount++;
    }

    // 4. 在窗口内，检查是否超限
    if (entry.count >= this.config.maxRequests) {
      // 触发限流
      this.blockedUntil.set(userId, now + this.config.cooldownMs);
      log.info(
        { userId, count: entry.count, windowMs: this.config.windowMs },
        '用户触发速率限制',
      );
      return false;
    }

    // 增加计数
    entry.count++;
    entry.lastRequest = now;
    return true;
  }

  /**
   * 检查 IP 级别限流
   */
  private checkIpLimit(ip: string, now: number): boolean {
    // 检查是否在 IP 冷却期
    const ipBlocked = this.ipBlockedUntil.get(ip);
    if (ipBlocked && now < ipBlocked) {
      return false;
    }

    if (ipBlocked && now >= ipBlocked) {
      this.ipBlockedUntil.delete(ip);
      this.ipLimits.delete(ip);
    }

    const entry = this.ipLimits.get(ip);

    if (!entry) {
      this.ipLimits.set(ip, {
        count: 1,
        firstRequest: now,
        lastRequest: now,
        burstCount: 0,
        lastBurstReset: now,
      });
      return true;
    }

    if (now - entry.firstRequest > this.config.windowMs) {
      this.ipLimits.set(ip, {
        count: 1,
        firstRequest: now,
        lastRequest: now,
        burstCount: 0,
        lastBurstReset: now,
      });
      return true;
    }

    if (entry.count >= this.config.maxRequestsPerIp) {
      this.ipBlockedUntil.set(ip, now + this.config.cooldownMs);
      log.info({ ip, count: entry.count }, 'IP 触发速率限制');
      return false;
    }

    entry.count++;
    entry.lastRequest = now;
    return true;
  }

  /**
   * 获取用户的剩余配额
   */
  getRemaining(userId: string): { remaining: number; resetAt: number } {
    const now = Date.now();

    const blockedUntil = this.blockedUntil.get(userId);
    if (blockedUntil && now < blockedUntil) {
      return { remaining: 0, resetAt: blockedUntil };
    }

    const entry = this.limits.get(userId);
    if (!entry) {
      return { remaining: this.config.maxRequests, resetAt: now + this.config.windowMs };
    }

    if (now - entry.firstRequest > this.config.windowMs) {
      return { remaining: this.config.maxRequests, resetAt: now + this.config.windowMs };
    }

    return {
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetAt: entry.firstRequest + this.config.windowMs,
    };
  }

  /**
   * 手动重置某用户的限流状态
   */
  reset(userId: string): void {
    this.limits.delete(userId);
    this.blockedUntil.delete(userId);
  }

  /**
   * 手动重置某 IP 的限流状态
   */
  resetIp(ip: string): void {
    this.ipLimits.delete(ip);
    this.ipBlockedUntil.delete(ip);
  }

  /**
   * 清理过期记录
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    // 清理用户限流记录
    for (const [userId, entry] of this.limits.entries()) {
      if (now - entry.lastRequest > this.config.windowMs * 2) {
        this.limits.delete(userId);
        cleaned++;
      }
    }

    for (const [userId, until] of this.blockedUntil.entries()) {
      if (now > until) {
        this.blockedUntil.delete(userId);
        cleaned++;
      }
    }

    // 清理 IP 限流记录
    for (const [ip, entry] of this.ipLimits.entries()) {
      if (now - entry.lastRequest > this.config.windowMs * 2) {
        this.ipLimits.delete(ip);
        cleaned++;
      }
    }

    for (const [ip, until] of this.ipBlockedUntil.entries()) {
      if (now > until) {
        this.ipBlockedUntil.delete(ip);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.debug({ cleaned }, '清理过期限流记录');
    }
  }

  /**
   * 关闭限流器（清理定时器）
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.limits.clear();
    this.blockedUntil.clear();
    this.ipLimits.clear();
    this.ipBlockedUntil.clear();
  }
}
