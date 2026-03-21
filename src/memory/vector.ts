import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config/index.js';
import type { RetrievalStrategy, VectorMemory, VectorMetadata } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ChatService } from '../llm/quick.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';

const log = createChildLogger('vector-memory');

export class VectorMemoryStore {
  private client: QdrantClient;
  private collection: string;
  private chat: ChatService;

  constructor(chat: ChatService) {
    this.client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
    });
    this.collection = config.qdrant.collection;
    this.chat = chat;
  }

  async init(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collection);

      if (!exists) {
        await this.client.createCollection(this.collection, {
          vectors: { size: 1536, distance: 'Cosine' },
        });

        // 为基于关键字的混合检索创建有效负载索引
        await this.client.createPayloadIndex(this.collection, {
          field_name: 'content',
          field_schema: 'text',
        });
        
        await this.client.createPayloadIndex(this.collection, {
          field_name: 'tags',
          field_schema: 'keyword',
        });

        log.info(`集合 ${this.collection} 及索引已创建`);
      }
    } catch (err) {
      log.error({ err }, '初始化向量数据库失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '向量数据库初始化失败', {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async store(memory: VectorMemory): Promise<void> {
    const vector = await this.chat.embed(memory.content);

    await this.client.upsert(this.collection, {
      wait: true,
      points: [
        {
          id: memory.id,
          vector,
          payload: {
            content: memory.content,
            ...memory.metadata,
            createdAt: memory.createdAt.toISOString(),
            expiresAt: memory.expiresAt?.toISOString(),
          },
        },
      ],
    });

    log.debug({ id: memory.id, type: memory.metadata.type }, '记忆已存储到向量数据库');
  }

  /**
   * 检索记忆，支持混合检索策略和时间范围过滤
   */
  async retrieve(query: string, strategy: RetrievalStrategy, userId?: string): Promise<VectorMemory[]> {
    const filter = this.buildFilter(strategy, userId);
    
    // 如果启用了混合/关键字检索且数据库配置支持，可组装专门请求
    // 此处简化为利用 Qdrant 结合全文过滤的 Search
    
    if (strategy.method === 'keyword' && query.trim() !== '') {
      // 纯关键字检索（假设配置了 payload index text）
      const textFilter = {
        must: [
          { key: 'content', match: { text: query } }
        ]
      };
      
      const combinedFilter = filter ? { must: [...(filter.must as unknown[]), ...textFilter.must] } : textFilter;
      
      const results = await this.client.scroll(this.collection, {
        filter: combinedFilter,
        limit: strategy.topK ?? 10,
      });
      return results.points.map((r) => this.toVectorMemory(r.id as string, r.payload, 1.0));
    }

    // 默认使用相似度或混合
    const queryVector = await this.chat.embed(query);

    const results = await this.client.search(this.collection, {
      vector: queryVector,
      limit: strategy.topK ?? 10,
      score_threshold: strategy.threshold ?? 0.7,
      filter: filter ?? undefined,
    });

    return results.map((r) => this.toVectorMemory(r.id as string, r.payload, r.score));
  }

  /**
   * 记录记忆被访问（更新访问计数和重要性）
   */
  async markAccessed(memoryId: string): Promise<void> {
    try {
      const records = await this.client.retrieve(this.collection, {
        ids: [memoryId],
      });

      if (records.length === 0) return;

      const record = records[0];
      const payload = record.payload || {};
      const currentCount = (payload.accessCount as number) || 0;
      const currentImportance = (payload.importance as number) || 0.5;

      // 重要性随着访问次数增加而微调，最大 1.0
      const newImportance = Math.min(1.0, currentImportance + 0.01);

      await this.client.setPayload(this.collection, {
        points: [memoryId],
        payload: {
          accessCount: currentCount + 1,
          importance: newImportance,
        },
      });

      log.debug({ id: memoryId, accessCount: currentCount + 1 }, '记忆访问记录已更新');
    } catch (error) {
      log.warn({ error, id: memoryId }, '更新记忆访问记录失败');
    }
  }

  private buildFilter(strategy: RetrievalStrategy, userId?: string) {
    const must: unknown[] = [];

    if (userId) {
      must.push({ key: 'userId', match: { value: userId } });
    }

    if (strategy.filters) {
      for (const [key, value] of Object.entries(strategy.filters)) {
        must.push({ key, match: { value } });
      }
    }

    if (strategy.timeRange) {
      const timeConditions: unknown[] = [];
      if (strategy.timeRange.start) {
        timeConditions.push({ gte: strategy.timeRange.start.toISOString() });
      }
      if (strategy.timeRange.end) {
        timeConditions.push({ lte: strategy.timeRange.end.toISOString() });
      }

      if (timeConditions.length > 0) {
        must.push({
          key: 'createdAt',
          range: Object.assign({}, ...timeConditions),
        });
      }
    }

    return must.length > 0 ? { must } : null;
  }

  private toVectorMemory(id: string, payload: Record<string, unknown> | null | undefined, score?: number): VectorMemory {
    if (!payload) {
      return {
        id,
        content: '',
        embedding: [],
        metadata: {
          type: 'conversation',
          userId: '',
          importance: 0,
          accessCount: 0,
          tags: [],
        },
        createdAt: new Date(),
        score,
      };
    }

    return {
      id,
      content: (payload.content as string) ?? '',
      embedding: [], // 检索结果中不需要包含原始向量，节省内存
      metadata: {
        type: (payload.type as VectorMetadata['type']) ?? 'conversation',
        userId: (payload.userId as string) ?? '',
        sessionId: payload.sessionId as string | undefined,
        taskId: payload.taskId as string | undefined,
        importance: (payload.importance as number) ?? 0.5,
        accessCount: (payload.accessCount as number) ?? 0,
        tags: (payload.tags as string[]) ?? [],
      },
      createdAt: payload.createdAt ? new Date(payload.createdAt as string) : new Date(),
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt as string) : undefined,
      score,
    };
  }
}
