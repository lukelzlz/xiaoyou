import Redis from 'ioredis';
import { config } from '../config/index.js';
import type { ConversationTurn, HotMemory, UserPreferences } from '../types/index.js';

const defaultPreferences: UserPreferences = {
  language: 'zh-CN',
  responseStyle: 'casual',
  timezone: 'Asia/Shanghai',
  notificationSettings: {
    enabled: true,
    channels: [],
  },
};

export class HotMemoryStore {
  private redis: Redis;
  private ttl = 3600;

  constructor() {
    this.redis = new Redis(config.redis.url, {
      keyPrefix: config.redis.keyPrefix,
    });
  }

  async get(sessionId: string): Promise<HotMemory | null> {
    const data = await this.redis.get(this.key(sessionId));
    if (!data) return null;

    const parsed = JSON.parse(data) as HotMemory;
    return {
      ...parsed,
      lastUpdated: new Date(parsed.lastUpdated),
      conversationHistory: parsed.conversationHistory.map((turn) => ({
        ...turn,
        timestamp: new Date(turn.timestamp),
      })),
    };
  }

  async set(memory: HotMemory): Promise<void> {
    await this.redis.set(this.key(memory.sessionId), JSON.stringify(memory), 'EX', this.ttl);
  }

  async ensure(sessionId: string, userId: string): Promise<HotMemory> {
    const existing = await this.get(sessionId);
    if (existing) return existing;

    const memory: HotMemory = {
      sessionId,
      userId,
      conversationHistory: [],
      activeTasks: [],
      userPreferences: defaultPreferences,
      contextVariables: {},
      lastUpdated: new Date(),
      ttl: this.ttl,
    };

    await this.set(memory);
    return memory;
  }

  async addConversationTurn(sessionId: string, userId: string, turn: ConversationTurn): Promise<void> {
    const memory = await this.ensure(sessionId, userId);
    const history = [...memory.conversationHistory, turn].slice(-50);

    await this.set({
      ...memory,
      conversationHistory: history,
      lastUpdated: new Date(),
    });
  }

  async updatePreferences(sessionId: string, userId: string, preferences: Partial<UserPreferences>): Promise<void> {
    const memory = await this.ensure(sessionId, userId);
    await this.set({
      ...memory,
      userPreferences: {
        ...memory.userPreferences,
        ...preferences,
      },
      lastUpdated: new Date(),
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId));
  }

  private key(sessionId: string): string {
    return `hot_memory:${sessionId}`;
  }
}
