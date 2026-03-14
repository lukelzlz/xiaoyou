import { describe, expect, it } from 'vitest';
import { InMemoryContextManager } from '../../src/controller/context.js';
import type { SessionContext } from '../../src/types/index.js';

describe('InMemoryContextManager', () => {
  it('应该能够创建并获取上下文', async () => {
    const manager = new InMemoryContextManager();
    const sessionId = 'test-session';
    const ctx = await manager.getOrCreate(sessionId, 'user-1', 'channel-1', 'discord');

    expect(ctx.sessionId).toBe(sessionId);
    expect(ctx.userId).toBe('user-1');
    expect(ctx.platform).toBe('discord');

    const fetched = await manager.get(sessionId);
    expect(fetched).not.toBeNull();
    expect(fetched?.sessionId).toBe(sessionId);

    manager.destroy();
  });

  it('应该能够设置和获取变量', async () => {
    const manager = new InMemoryContextManager();
    const sessionId = 'test-session';
    await manager.getOrCreate(sessionId, 'u1', 'c1', 'telegram');

    await manager.setVariable(sessionId, 'testKey', 'testValue');
    const value = await manager.getVariable(sessionId, 'testKey');
    expect(value).toBe('testValue');

    manager.destroy();
  });

  it('应该能够更新元数据', async () => {
    const manager = new InMemoryContextManager();
    const sessionId = 'test-session';
    await manager.getOrCreate(sessionId, 'u1', 'c1', 'telegram');

    await manager.updateMetadata(sessionId, { lastIntent: 'chat' });
    const ctx = await manager.get(sessionId);
    expect(ctx?.metadata.lastIntent).toBe('chat');

    manager.destroy();
  });

  it('超过 TTL 应该被清理（通过 get）', async () => {
    // 设置很短的 TTL
    const manager = new InMemoryContextManager({ ttlMs: 10, cleanupIntervalMs: 1000 });
    const sessionId = 'expire-session';
    await manager.getOrCreate(sessionId, 'u1', 'c1', 'telegram');

    // 等待过期
    await new Promise((resolve) => setTimeout(resolve, 20));

    const ctx = await manager.get(sessionId);
    expect(ctx).toBeNull(); // 应该返回 null 因为已过期

    manager.destroy();
  });
});