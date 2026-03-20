import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatService } from '../../src/services/index.js';
import type { ParsedMessage, EnhancedIntent, VectorMemory } from '../../src/types/index.js';
import { IntentType } from '../../src/types/index.js';

// 模拟配置
vi.mock('../../src/config/index.js', () => ({
  config: {
    logLevel: 'info',
    env: 'test',
    chat: {
      apiKey: 'test-key',
      apiUrl: 'https://api.test.com/v1',
      model: 'test-model',
      embeddingModel: 'test-embed',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 30000,
    },
    qdrant: {
      url: 'http://localhost:6333',
      apiKey: 'test-key',
      collection: 'test-collection',
    },
  },
}));

describe('ChatService (Scene Handler)', () => {
  let service: ChatService;
  let mockLLM: { chat: ReturnType<typeof vi.fn>; embed: ReturnType<typeof vi.fn> };
  let mockMemory: { get: ReturnType<typeof vi.fn> };
  let mockVectorMemory: {
    retrieve: ReturnType<typeof vi.fn>;
    store: ReturnType<typeof vi.fn>;
  };
  let mockMemoryFlush: {
    track: ReturnType<typeof vi.fn>;
    archiveTask: ReturnType<typeof vi.fn>;
  };

  const createMessage = (overrides?: Partial<ParsedMessage>): ParsedMessage => ({
    id: 'msg-1',
    platform: 'discord',
    channelId: 'ch-1',
    userId: 'user-1',
    rawContent: '你好',
    textContent: '你好',
    entities: [],
    attachments: [],
    timestamp: new Date(),
    metadata: { platform: 'discord' },
    ...overrides,
  });

  const createIntent = (type: IntentType = IntentType.CHAT_CASUAL): EnhancedIntent => ({
    type,
    confidence: 0.9,
    entities: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockLLM = {
      chat: vi.fn().mockResolvedValue('你好呀！有什么我可以帮你的吗？'),
      embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    };

    mockMemory = {
      get: vi.fn().mockResolvedValue(null),
    };

    mockVectorMemory = {
      retrieve: vi.fn().mockResolvedValue([]),
      store: vi.fn().mockResolvedValue(undefined),
    };

    mockMemoryFlush = {
      track: vi.fn(),
      archiveTask: vi.fn().mockResolvedValue(undefined),
    };

    service = new ChatService(
      mockLLM as any,
      mockMemory as any,
      mockVectorMemory as any,
      mockMemoryFlush as any,
    );
  });

  it('应该处理聊天消息并返回回复', async () => {
    const message = createMessage();
    const intent = createIntent();

    const reply = await service.handle(message, intent);

    expect(reply).toBe('你好呀！有什么我可以帮你的吗？');
    expect(mockLLM.chat).toHaveBeenCalledTimes(1);
  });

  it('应该使用 channelId:userId 组合键', async () => {
    const message = createMessage({ channelId: 'group-1', userId: 'user-2' });
    const intent = createIntent();

    await service.handle(message, intent);

    expect(mockMemory.get).toHaveBeenCalledWith('group-1:user-2');
  });

  it('应该包含对话历史上下文', async () => {
    mockMemory.get.mockResolvedValue({
      conversationHistory: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
    });

    const message = createMessage({ textContent: '我叫小明' });
    const intent = createIntent();

    await service.handle(message, intent);

    const chatPrompt = mockLLM.chat.mock.calls[0][0] as string;
    expect(chatPrompt).toContain('历史对话');
    expect(chatPrompt).toContain('你好');
  });

  it('应该检索长期记忆并包含在上下文中', async () => {
    mockVectorMemory.retrieve.mockResolvedValue([
      { content: '用户之前提到喜欢猫' },
      { content: '用户住在北京' },
    ]);

    const message = createMessage({ textContent: '我之前说过什么' });
    const intent = createIntent(IntentType.CHAT_QUESTION);

    await service.handle(message, intent);

    const chatPrompt = mockLLM.chat.mock.calls[0][0] as string;
    expect(chatPrompt).toContain('相关历史记忆');
    expect(chatPrompt).toContain('用户之前提到喜欢猫');
  });

  it('长期记忆检索失败时不应影响主流程', async () => {
    mockVectorMemory.retrieve.mockRejectedValue(new Error('Qdrant 连接失败'));

    const message = createMessage();
    const intent = createIntent();

    const reply = await service.handle(message, intent);
    expect(reply).toBe('你好呀！有什么我可以帮你的吗？');
  });

  it('应该立即将对话存入向量数据库', async () => {
    const message = createMessage({ textContent: '帮我记住一件事' });
    const intent = createIntent();

    await service.handle(message, intent);

    expect(mockVectorMemory.store).toHaveBeenCalledTimes(1);

    const storedMemory = mockVectorMemory.store.mock.calls[0][0] as VectorMemory;
    expect(storedMemory.content).toContain('用户: 帮我记住一件事');
    expect(storedMemory.content).toContain('小悠:');
    expect(storedMemory.metadata.type).toBe('conversation');
    expect(storedMemory.metadata.userId).toBe('user-1');
    expect(storedMemory.metadata.tags).toContain('conversation');
    expect(storedMemory.id).toMatch(/^conv_/);
  });

  it('向量存储失败时不应影响返回结果', async () => {
    mockVectorMemory.store.mockRejectedValue(new Error('存储失败'));

    const message = createMessage();
    const intent = createIntent();

    const reply = await service.handle(message, intent);
    expect(reply).toBe('你好呀！有什么我可以帮你的吗？');
  });

  it('应该跟踪会话供 MemoryFlush 使用', async () => {
    const message = createMessage({ channelId: 'ch-5', userId: 'user-3' });
    const intent = createIntent();

    await service.handle(message, intent);

    expect(mockMemoryFlush.track).toHaveBeenCalledWith('ch-5:user-3');
  });

  describe('calculateImportance', () => {
    it('任务类型意图应有较高重要性', async () => {
      const message = createMessage();
      const intent = createIntent(IntentType.TASK_CODE);

      await service.handle(message, intent);

      const storedMemory = mockVectorMemory.store.mock.calls[0][0] as VectorMemory;
      expect(storedMemory.metadata.importance).toBe(0.8);
    });

    it('定时任务意图应有较高重要性', async () => {
      const message = createMessage();
      const intent = createIntent(IntentType.SCHEDULE_CREATE);

      await service.handle(message, intent);

      const storedMemory = mockVectorMemory.store.mock.calls[0][0] as VectorMemory;
      expect(storedMemory.metadata.importance).toBe(0.8);
    });

    it('工具类型意图应有中等重要性', async () => {
      const message = createMessage();
      const intent = createIntent(IntentType.TOOL_SEARCH);

      await service.handle(message, intent);

      const storedMemory = mockVectorMemory.store.mock.calls[0][0] as VectorMemory;
      expect(storedMemory.metadata.importance).toBe(0.6);
    });

    it('普通聊天意图应有基础重要性', async () => {
      const message = createMessage();
      const intent = createIntent(IntentType.CHAT_CASUAL);

      await service.handle(message, intent);

      const storedMemory = mockVectorMemory.store.mock.calls[0][0] as VectorMemory;
      expect(storedMemory.metadata.importance).toBe(0.5);
    });
  });
});
