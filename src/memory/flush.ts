import { nanoid } from 'nanoid';
import { createChildLogger } from '../utils/logger.js';
import { HotMemoryStore } from './hot.js';
import { VectorMemoryStore } from './vector.js';
import type { HotMemory, VectorMemory, VectorMetadata, ConversationTurn } from '../types/index.js';

const log = createChildLogger('memory-flush');

export interface FlushConfig {
  /** 对话轮数阈值，超过此数量触发归档 */
  conversationThreshold: number;
  /** 归档定时间隔（毫秒） */
  intervalMs: number;
  /** 归档时保留的最近对话轮数 */
  keepRecentTurns: number;
  /** 归档摘要的最大字符数 */
  maxSummaryLength: number;
}

const defaultFlushConfig: FlushConfig = {
  conversationThreshold: 30,
  intervalMs: 300_000, // 5 分钟
  keepRecentTurns: 10,
  maxSummaryLength: 2000,
};

export class MemoryFlush {
  private hotMemory: HotMemoryStore;
  private vectorMemory: VectorMemoryStore;
  private config: FlushConfig;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private trackedSessions: Set<string> = new Set();
  private flushing = false;

  constructor(
    hotMemory: HotMemoryStore,
    vectorMemory: VectorMemoryStore,
    config?: Partial<FlushConfig>,
  ) {
    this.hotMemory = hotMemory;
    this.vectorMemory = vectorMemory;
    this.config = { ...defaultFlushConfig, ...config };
  }

  /** 启动定期归档 */
  start(): void {
    if (this.flushInterval) return;

    this.flushInterval = setInterval(() => {
      if (this.flushing) {
        log.debug('上一次归档仍在进行中，跳过本次');
        return;
      }
      this.flushing = true;
      this.flushAll()
        .catch((err) => {
          log.error({ err }, '定期归档失败');
        })
        .finally(() => {
          this.flushing = false;
        });
    }, this.config.intervalMs);

    log.info(
      { intervalMs: this.config.intervalMs, threshold: this.config.conversationThreshold },
      '记忆归档服务已启动',
    );
  }

  /** 停止定期归档 */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    log.info('记忆归档服务已停止');
  }

  /** 跟踪需要归档的会话 */
  track(sessionId: string): void {
    this.trackedSessions.add(sessionId);
  }

  /** 归档所有被跟踪的会话 */
  async flushAll(): Promise<void> {
    const sessions = Array.from(this.trackedSessions);
    let flushed = 0;

    for (const sessionId of sessions) {
      try {
        const didFlush = await this.flushSession(sessionId);
        if (didFlush) flushed++;
      } catch (error) {
        log.error({ error, sessionId }, '会话归档失败');
      }
    }

    if (flushed > 0) {
      log.info({ flushed, total: sessions.length }, '批量归档完成');
    }
  }

  /** 归档单个会话的热记忆到向量数据库 */
  async flushSession(sessionId: string): Promise<boolean> {
    const memory = await this.hotMemory.get(sessionId);
    if (!memory) {
      this.trackedSessions.delete(sessionId);
      return false;
    }

    const history = memory.conversationHistory;

    // 未达到归档阈值
    if (history.length < this.config.conversationThreshold) {
      return false;
    }

    log.info(
      { sessionId, historyLength: history.length },
      '开始归档会话记忆',
    );

    // 将旧的对话归档到向量数据库
    const turnsToArchive = history.slice(0, -this.config.keepRecentTurns);
    const turnsToKeep = history.slice(-this.config.keepRecentTurns);

    // 分批归档
    const batches = this.batchConversation(turnsToArchive, 10);
    for (const batch of batches) {
      await this.archiveBatch(memory, batch);
    }

    // 更新热记忆，只保留最近的对话
    await this.hotMemory.set({
      ...memory,
      conversationHistory: turnsToKeep,
      lastUpdated: new Date(),
    });

    log.info(
      { sessionId, archived: turnsToArchive.length, kept: turnsToKeep.length },
      '会话记忆归档完成',
    );

    return true;
  }

  /** 归档用户偏好到向量数据库 */
  async flushUserPreferences(memory: HotMemory): Promise<void> {
    const preferenceContent = JSON.stringify(memory.userPreferences);

    const vectorMemory: VectorMemory = {
      id: `pref_${memory.userId}_${Date.now()}`,
      content: `用户偏好: ${preferenceContent}`,
      embedding: [],
      metadata: {
        type: 'preference',
        userId: memory.userId,
        sessionId: memory.sessionId,
        importance: 0.8,
        accessCount: 0,
        tags: ['preference', 'user-profile'],
      },
      createdAt: new Date(),
    };

    await this.vectorMemory.store(vectorMemory);
    log.debug({ userId: memory.userId }, '用户偏好已归档');
  }

  /** 归档任务记录到向量数据库 */
  async archiveTask(
    userId: string,
    taskDescription: string,
    taskResult: string,
    taskId?: string,
  ): Promise<void> {
    const content = `任务: ${taskDescription}\n结果: ${taskResult}`;

    const vectorMemory: VectorMemory = {
      id: taskId ?? `task_${nanoid()}`,
      content,
      embedding: [],
      metadata: {
        type: 'task',
        userId,
        taskId: taskId ?? nanoid(),
        importance: 0.7,
        accessCount: 0,
        tags: ['task', 'archived'],
      },
      createdAt: new Date(),
    };

    await this.vectorMemory.store(vectorMemory);
    log.info({ taskId: vectorMemory.id, userId }, '任务已归档');
  }

  // ============ 私有辅助方法 ============

  private async archiveBatch(
    memory: HotMemory,
    turns: ConversationTurn[],
  ): Promise<void> {
    const summary = this.summarizeTurns(turns);

    const vectorMemory: VectorMemory = {
      id: `conv_${nanoid()}`,
      content: summary,
      embedding: [],
      metadata: {
        type: 'conversation',
        userId: memory.userId,
        sessionId: memory.sessionId,
        importance: this.calculateImportance(turns),
        accessCount: 0,
        tags: this.extractTags(turns),
      },
      createdAt: new Date(),
    };

    await this.vectorMemory.store(vectorMemory);
  }

  private batchConversation(turns: ConversationTurn[], batchSize: number): ConversationTurn[][] {
    const batches: ConversationTurn[][] = [];
    for (let i = 0; i < turns.length; i += batchSize) {
      batches.push(turns.slice(i, i + batchSize));
    }
    return batches;
  }

  private summarizeTurns(turns: ConversationTurn[]): string {
    const lines = turns.map((t) => `${t.role}: ${t.content}`);
    const joined = lines.join('\n');

    // 截断到最大长度
    if (joined.length > this.config.maxSummaryLength) {
      return joined.slice(0, this.config.maxSummaryLength) + '...';
    }

    return joined;
  }

  private calculateImportance(turns: ConversationTurn[]): number {
    let importance = 0.5;

    // 包含任务意图的对话更重要
    const hasTask = turns.some(
      (t) => t.intent && (t.intent.startsWith('task.') || t.intent.startsWith('schedule.')),
    );
    if (hasTask) importance += 0.2;

    // 包含工具调用的对话稍微重要
    const hasTool = turns.some((t) => t.intent?.startsWith('tool.'));
    if (hasTool) importance += 0.1;

    return Math.min(importance, 1.0);
  }

  private extractTags(turns: ConversationTurn[]): string[] {
    const tags = new Set<string>();
    tags.add('conversation');

    for (const turn of turns) {
      if (turn.intent) {
        const category = turn.intent.split('.')[0];
        tags.add(category);
      }
    }

    return Array.from(tags);
  }
}
