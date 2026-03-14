import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config/index.js';
import type { VectorMemory, VectorMetadata, RetrievalOptions } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { GLMService } from '../llm/glm.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';

const log = createChildLogger('vector-memory');

export class VectorMemoryStore {
  private client: QdrantClient;
  private collection: string;
  private glm: GLMService;

  constructor(glm: GLMService) {
    this.client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
    });
    this.collection = config.qdrant.collection;
    this.glm = glm;
  }

  async init(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collection);

      if (!exists) {
        await this.client.createCollection(this.collection, {
          vectors: { size: 1536, distance: 'Cosine' },
        });
        log.info(`集合 ${this.collection} 已创建`);
      }
    } catch (err) {
      log.error({ err }, '初始化向量数据库失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '向量数据库初始化失败', {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async store(memory: VectorMemory): Promise<void> {
    const vector = await this.glm.embed(memory.content);

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
          },
        },
      ],
    });
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<VectorMemory[]> {
    const queryVector = await this.glm.embed(query);
    const filter = this.buildFilter(options);

    const results = await this.client.search(this.collection, {
      vector: queryVector,
      limit: options.topK ?? 10,
      score_threshold: options.threshold ?? 0.7,
      filter: filter ?? undefined,
    });

    return results.map((r) => ({
      id: r.id as string,
      content: (r.payload?.content as string) ?? '',
      embedding: [],
      metadata: {
        type: (r.payload?.type as VectorMetadata['type']) ?? 'conversation',
        userId: (r.payload?.userId as string) ?? '',
        sessionId: r.payload?.sessionId as string | undefined,
        taskId: r.payload?.taskId as string | undefined,
        importance: (r.payload?.importance as number) ?? 0.5,
        accessCount: (r.payload?.accessCount as number) ?? 0,
        tags: (r.payload?.tags as string[]) ?? [],
      },
      createdAt: new Date((r.payload?.createdAt as string) ?? Date.now()),
    }));
  }

  private buildFilter(options: RetrievalOptions) {
    const must: unknown[] = [];

    if (options.userId) {
      must.push({ key: 'userId', match: { value: options.userId } });
    }
    if (options.type) {
      must.push({ key: 'type', match: { value: options.type } });
    }

    return must.length > 0 ? { must } : null;
  }
}
