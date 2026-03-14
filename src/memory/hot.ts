import Redis from 'ioredis';
import { config } from '../config/index.js';
import type { ActiveTask, ConversationTurn, HotMemory, UserPreferences } from '../types/index.js';

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

  // ============ 活动任务跟踪 ============

  async addActiveTask(sessionId: string, userId: string, task: ActiveTask): Promise<void> {
    const memory = await this.ensure(sessionId, userId);
    const tasks = [...memory.activeTasks.filter((t) => t.taskId !== task.taskId), task];

    await this.set({
      ...memory,
      activeTasks: tasks,
      lastUpdated: new Date(),
    });
  }

  async updateTaskProgress(sessionId: string, userId: string, taskId: string, progress: number, status?: string): Promise<void> {
    const memory = await this.ensure(sessionId, userId);
    const tasks = memory.activeTasks.map((t) =>
      t.taskId === taskId ? { ...t, progress, status: status ?? t.status } : t,
    );

    await this.set({
      ...memory,
      activeTasks: tasks,
      lastUpdated: new Date(),
    });
  }

  async removeActiveTask(sessionId: string, userId: string, taskId: string): Promise<void> {
    const memory = await this.ensure(sessionId, userId);
    const tasks = memory.activeTasks.filter((t) => t.taskId !== taskId);

    await this.set({
      ...memory,
      activeTasks: tasks,
      lastUpdated: new Date(),
    });
  }

  async getActiveTasks(sessionId: string): Promise<ActiveTask[]> {
    const memory = await this.get(sessionId);
    return memory?.activeTasks ?? [];
  }

  // ============ 上下文变量管理 ============

  async setContextVariable(sessionId: string, userId: string, key: string, value: unknown): Promise<void> {
    const memory = await this.ensure(sessionId, userId);

    await this.set({
      ...memory,
      contextVariables: {
        ...memory.contextVariables,
        [key]: value,
      },
      lastUpdated: new Date(),
    });
  }

  async getContextVariable(sessionId: string, key: string): Promise<unknown> {
    const memory = await this.get(sessionId);
    return memory?.contextVariables[key];
  }

  async clearContextVariables(sessionId: string, userId: string): Promise<void> {
    const memory = await this.ensure(sessionId, userId);

    await this.set({
      ...memory,
      contextVariables: {},
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
