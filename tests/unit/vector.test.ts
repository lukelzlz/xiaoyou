import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VectorMemoryStore } from '../../src/memory/vector.js';
import { ErrorCode, XiaoyouError } from '../../src/utils/error.js';
import type { RetrievalStrategy, VectorMemory } from '../../src/types/index.js';

// 模拟 QdrantClient
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    getCollections: vi.fn().mockResolvedValue({
      collections: [],
    }),
    createCollection: vi.fn().mockResolvedValue(undefined),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([
      {
        id: 'test-id-1',
        score: 0.95,
        payload: {
          content: '测试内容',
          type: 'conversation',
          userId: 'user-1',
          importance: 0.8,
          accessCount: 5,
          tags: ['test'],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      },
    ]),
    scroll: vi.fn().mockResolvedValue({
      points: [
        {
          id: 'test-id-2',
          payload: {
            content: '关键字匹配内容',
            type: 'conversation',
            userId: 'user-1',
            importance: 0.7,
            accessCount: 3,
            tags: [],
            createdAt: '2024-01-02T00:00:00.000Z',
          },
        },
      ],
    }),
    retrieve: vi.fn().mockResolvedValue([
      {
        id: 'test-id-1',
        payload: {
          content: '测试内容',
          accessCount: 5,
          importance: 0.8,
        },
      },
    ]),
    setPayload: vi.fn().mockResolvedValue(undefined),
  })),
}));

// 模拟 ChatService
vi.mock('../../src/llm/quick.js', () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  })),
}));

// 模拟配置（必须包含所有必需字段以避免 pino 初始化失败）
vi.mock('../../src/config/index.js', () => ({
  config: {
    logLevel: 'info',
    env: 'test',
    qdrant: {
      url: 'http://localhost:6333',
      apiKey: 'test-key',
      collection: 'test-collection',
    },
  },
}));

describe('VectorMemoryStore', () => {
  let store: VectorMemoryStore;
  let mockChat: { embed: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    // 动态导入以应用模拟
    const { ChatService } = await import('../../src/llm/quick.js');
    mockChat = new ChatService() as unknown as { embed: ReturnType<typeof vi.fn> };
    store = new VectorMemoryStore(mockChat as unknown as Parameters<typeof VectorMemoryStore>[0]);
  });

  it('应该能成功初始化集合', async () => {
    await expect(store.init()).resolves.toBeUndefined();
  });

  it('应该能存储记忆', async () => {
    const memory: VectorMemory = {
      id: 'test-memory-id',
      content: '这是一条测试记忆',
      embedding: [],
      metadata: {
        type: 'conversation',
        userId: 'user-1',
        importance: 0.5,
        accessCount: 0,
        tags: ['test'],
      },
      createdAt: new Date(),
    };

    await expect(store.store(memory)).resolves.toBeUndefined();
    expect(mockChat.embed).toHaveBeenCalledWith('这是一条测试记忆');
  });

  it('应该能使用相似度检索', async () => {
    const strategy: RetrievalStrategy = {
      method: 'similarity',
      topK: 5,
      threshold: 0.7,
    };

    const results = await store.retrieve('测试查询', strategy, 'user-1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('test-id-1');
    expect(results[0].content).toBe('测试内容');
  });

  it('应该能使用关键字检索', async () => {
    const strategy: RetrievalStrategy = {
      method: 'keyword',
      topK: 10,
      threshold: 0.5,
    };

    const results = await store.retrieve('关键字', strategy, 'user-1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('test-id-2');
  });

  it('应该能使用时间范围过滤', async () => {
    const strategy: RetrievalStrategy = {
      method: 'similarity',
      topK: 5,
      threshold: 0.7,
      timeRange: {
        start: new Date('2024-01-01'),
        end: new Date('2024-12-31'),
      },
    };

    const results = await store.retrieve('测试查询', strategy, 'user-1');
    expect(results).toHaveLength(1);
  });

  it('应该能使用自定义过滤器', async () => {
    const strategy: RetrievalStrategy = {
      method: 'similarity',
      topK: 5,
      threshold: 0.7,
      filters: {
        type: 'conversation',
      },
    };

    const results = await store.retrieve('测试查询', strategy, 'user-1');
    expect(results).toHaveLength(1);
  });

  it('应该能更新访问计数和重要性', async () => {
    await expect(store.markAccessed('test-id-1')).resolves.toBeUndefined();
  });

  it('访问不存在的记忆时应该静默处理', async () => {
    // 获取 store 内部持有的 client 实例并覆写 retrieve
    const client = Reflect.get(store, 'client') as { retrieve: ReturnType<typeof vi.fn> };
    client.retrieve.mockResolvedValueOnce([]);

    await expect(store.markAccessed('non-existent-id')).resolves.toBeUndefined();
  });
});
