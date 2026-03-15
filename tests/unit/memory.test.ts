import { describe, expect, it, vi } from 'vitest';
import { MemoryFlush } from '../../src/memory/flush.js';
import { VectorMemoryStore } from '../../src/memory/vector.js';

function createMemoryFlush() {
  const hotMemory = {
    get: vi.fn(),
    set: vi.fn(),
  };
  const vectorMemory = {
    retrieve: vi.fn(),
    store: vi.fn(),
  };

  const flush = new MemoryFlush(hotMemory as never, vectorMemory as never, {
    conversationThreshold: 2,
    keepRecentTurns: 1,
    intervalMs: 1000,
    maxSummaryLength: 100,
  });

  return { flush, hotMemory, vectorMemory };
}

describe('MemoryFlush', () => {
  it('应该计算重要性衰减', async () => {
    const { flush } = createMemoryFlush();
    await expect(flush.decayImportance(3, 0.8)).resolves.toBeLessThan(0.8);
    await expect(flush.decayImportance(100, 0.2)).resolves.toBeGreaterThanOrEqual(0.1);
  });

  it('应该归档用户偏好并复用已存在记录', async () => {
    const { flush, vectorMemory } = createMemoryFlush();
    vectorMemory.retrieve.mockResolvedValue([
      {
        id: 'pref-existing',
        content: '用户偏好',
        embedding: [],
        metadata: {
          type: 'preference',
          userId: 'user-1',
          sessionId: 'session-1',
          importance: 0.9,
          accessCount: 3,
          tags: ['preference'],
        },
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
    vectorMemory.store.mockResolvedValue(undefined);

    await flush.flushUserPreferences({
      sessionId: 'session-1',
      userId: 'user-1',
      conversationHistory: [],
      activeTasks: [],
      userPreferences: {
        language: 'zh-CN',
        responseStyle: 'casual',
        timezone: 'Asia/Shanghai',
        notificationSettings: { enabled: true, channels: ['telegram'] },
      },
      contextVariables: {},
      lastUpdated: new Date(),
      ttl: 3600,
    });

    expect(vectorMemory.store).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pref-existing',
        metadata: expect.objectContaining({ accessCount: 3 }),
      }),
    );
  });
});

describe('VectorMemoryStore', () => {
  it('应该在 keyword 模式下走 scroll 检索', async () => {
    const glm = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    const store = new VectorMemoryStore(glm as never);
    const scrollMock = vi.fn().mockResolvedValue({
      points: [
        {
          id: 'mem-1',
          payload: {
            content: '这是关于用户偏好的记忆',
            type: 'preference',
            userId: 'user-1',
            importance: 0.8,
            accessCount: 2,
            tags: ['preference'],
            createdAt: '2026-03-01T00:00:00.000Z',
          },
        },
      ],
    });

    Reflect.set(store, 'client', {
      scroll: scrollMock,
      search: vi.fn(),
    });

    const results = await store.retrieve(
      '用户偏好',
      {
        method: 'keyword',
        topK: 1,
        threshold: 0.7,
        filters: { type: 'preference' },
      },
      'user-1',
    );

    expect(scrollMock).toHaveBeenCalledOnce();
    expect(results[0].metadata.type).toBe('preference');
  });
});
