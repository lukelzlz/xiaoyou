import type { ContextManager, Platform, SessionContext } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('context');

interface ContextManagerConfig {
  ttlMs: number;
  cleanupIntervalMs: number;
}

const defaultConfig: ContextManagerConfig = {
  ttlMs: 60 * 60 * 1000,
  cleanupIntervalMs: 10 * 60 * 1000,
};

/**
 * 内存版上下文管理器
 *
 * 负责：
 *  1. 保存会话级上下文变量
 *  2. 管理待处理动作（pendingAction）
 *  3. 追踪最近活跃时间
 *  4. 定期清理过期上下文
 *
 * 后续可替换为 Redis / 数据库存储实现。
 */
export class InMemoryContextManager implements ContextManager {
  private contexts = new Map<string, SessionContext>();
  private config: ContextManagerConfig;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
  }

  async get(sessionId: string): Promise<SessionContext | null> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      return null;
    }

    if (this.isExpired(context)) {
      this.contexts.delete(sessionId);
      return null;
    }

    return this.cloneContext(context);
  }

  async getOrCreate(
    sessionId: string,
    userId: string,
    channelId: string,
    platform: Platform,
  ): Promise<SessionContext> {
    const existing = await this.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = new Date();
    const context: SessionContext = {
      sessionId,
      userId,
      channelId,
      platform,
      createdAt: now,
      lastActiveAt: now,
      variables: {},
      metadata: {},
    };

    this.contexts.set(sessionId, context);
    log.debug({ sessionId, userId }, '创建新会话上下文');
    return this.cloneContext(context);
  }

  async setVariable(sessionId: string, key: string, value: unknown): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      throw new Error(`Session context not found: ${sessionId}`);
    }

    context.variables[key] = value;
    context.lastActiveAt = new Date();
  }

  async getVariable(sessionId: string, key: string): Promise<unknown> {
    const context = await this.get(sessionId);
    return context?.variables[key];
  }

  async setPendingAction(sessionId: string, action: SessionContext['pendingAction']): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      throw new Error(`Session context not found: ${sessionId}`);
    }

    context.pendingAction = action;
    context.lastActiveAt = new Date();

    log.debug({ sessionId, actionType: action?.type }, '设置待处理动作');
  }

  async clearPendingAction(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      return;
    }

    context.pendingAction = undefined;
    context.lastActiveAt = new Date();
  }

  async touch(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      return;
    }

    context.lastActiveAt = new Date();
  }

  /**
   * 更新上下文元数据
   */
  async updateMetadata(sessionId: string, patch: Record<string, unknown>): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) {
      throw new Error(`Session context not found: ${sessionId}`);
    }

    context.metadata = {
      ...context.metadata,
      ...patch,
    };
    context.lastActiveAt = new Date();
  }

  /**
   * 删除会话上下文
   */
  async delete(sessionId: string): Promise<void> {
    this.contexts.delete(sessionId);
  }

  /**
   * 获取上下文快照
   */
  async snapshot(sessionId: string): Promise<SessionContext | null> {
    return this.get(sessionId);
  }

  /**
   * 销毁管理器并清理定时器
   */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.contexts.clear();
  }

  private isExpired(context: SessionContext): boolean {
    return Date.now() - context.lastActiveAt.getTime() > this.config.ttlMs;
  }

  private cleanup(): void {
    let removed = 0;

    for (const [sessionId, context] of this.contexts.entries()) {
      if (this.isExpired(context)) {
        this.contexts.delete(sessionId);
        removed += 1;
      }
    }

    if (removed > 0) {
      log.debug({ removed }, '清理过期会话上下文');
    }
  }

  private cloneContext(context: SessionContext): SessionContext {
    return {
      ...context,
      createdAt: new Date(context.createdAt),
      lastActiveAt: new Date(context.lastActiveAt),
      pendingAction: context.pendingAction
        ? {
            ...context.pendingAction,
            expiresAt: new Date(context.pendingAction.expiresAt),
          }
        : undefined,
      variables: { ...context.variables },
      metadata: { ...context.metadata },
    };
  }
}
