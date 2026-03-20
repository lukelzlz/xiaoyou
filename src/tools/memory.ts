/**
 * Memory 工具
 * 让小悠可以主动搜索和检索记忆
 */

import { createChildLogger } from '../utils/logger.js';
import { VectorMemoryStore } from '../memory/vector.js';
import { ChatService } from '../llm/quick.js';
import type { ToolDefinition } from './index.js';
import type { RetrievalStrategy } from '../types/index.js';

const log = createChildLogger('memory-tool');

/**
 * Memory 搜索工具
 * 支持向量相似度检索和关键字检索
 */
export class MemoryTool implements ToolDefinition<{ query: string; method?: 'similarity' | 'keyword'; limit?: number }> {
  name = 'memory_search';
  description = '搜索小悠的记忆库，检索相关的对话历史、知识点和用户信息';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或问题描述',
      },
      method: {
        type: 'string',
        enum: ['similarity', 'keyword'],
        description: '检索方法：similarity（语义相似度）或 keyword（关键字匹配），默认 similarity',
      },
      limit: {
        type: 'number',
        description: '返回结果数量，默认 5，最多 10',
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
  timeout = 10_000;

  private vectorStore: VectorMemoryStore | null = null;

  private async getVectorStore(): Promise<VectorMemoryStore> {
    if (!this.vectorStore) {
      const chat = new ChatService();
      this.vectorStore = new VectorMemoryStore(chat);
      await this.vectorStore.init();
    }
    return this.vectorStore;
  }

  async execute(params: { query: string; method?: 'similarity' | 'keyword'; limit?: number }): Promise<string> {
    const { query, method = 'similarity', limit = 5 } = params;
    const topK = Math.min(limit, 10);

    log.debug({ query, method, topK }, '执行记忆搜索');

    try {
      const store = await this.getVectorStore();

      const strategy: RetrievalStrategy = {
        method,
        topK,
        threshold: method === 'similarity' ? 0.6 : undefined,
      };

      const results = await store.retrieve(query, strategy);

      if (results.length === 0) {
        return `记忆搜索: "${query}"\n\n未找到相关记忆。`;
      }

      const lines: string[] = [`记忆搜索: "${query}"`, '', `找到 ${results.length} 条相关记忆:`, ''];

      for (let i = 0; i < results.length; i++) {
        const memory = results[i];
        const typeLabel = this.getTypeLabel(memory.metadata.type);
        const timeAgo = this.formatTimeAgo(memory.createdAt);

        lines.push(`## ${i + 1}. ${typeLabel} (${timeAgo})`);
        lines.push(memory.content);

        if (memory.metadata.tags.length > 0) {
          lines.push(`标签: ${memory.metadata.tags.join(', ')}`);
        }
        lines.push('');
      }

      return lines.join('\n');
    } catch (error) {
      log.error({ error, query }, '记忆搜索失败');
      throw new Error(`记忆搜索失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      conversation: '对话',
      knowledge: '知识',
      preference: '偏好',
      task: '任务',
      fact: '事实',
    };
    return labels[type] ?? type;
  }

  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;
    if (diffDays < 7) return `${diffDays} 天前`;
    return date.toLocaleDateString('zh-CN');
  }
}

/**
 * Memory 存储工具
 * 让小悠可以主动存储重要信息到记忆库
 */
export class MemoryStoreTool implements ToolDefinition<{ content: string; type?: string; tags?: string }> {
  name = 'memory_store';
  description = '将重要信息存储到小悠的记忆库，便于后续检索';
  parameters = {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '要存储的内容',
      },
      type: {
        type: 'string',
        enum: ['knowledge', 'preference', 'fact', 'task'],
        description: '记忆类型：knowledge（知识）、preference（偏好）、fact（事实）、task（任务），默认 knowledge',
      },
      tags: {
        type: 'string',
        description: '标签，用逗号分隔',
      },
    },
    required: ['content'],
    additionalProperties: false,
  };
  timeout = 10_000;

  private vectorStore: VectorMemoryStore | null = null;

  private async getVectorStore(): Promise<VectorMemoryStore> {
    if (!this.vectorStore) {
      const chat = new ChatService();
      this.vectorStore = new VectorMemoryStore(chat);
      await this.vectorStore.init();
    }
    return this.vectorStore;
  }

  async execute(params: { content: string; type?: string; tags?: string }): Promise<string> {
    const { content, type = 'knowledge', tags } = params;

    log.debug({ content: content.slice(0, 50), type, tags }, '存储记忆');

    try {
      const store = await this.getVectorStore();

      const memory = {
        id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content,
        embedding: [],
        metadata: {
          type: type as 'knowledge' | 'preference' | 'fact' | 'task',
          userId: 'system',
          importance: 0.7,
          accessCount: 0,
          tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        },
        createdAt: new Date(),
      };

      await store.store(memory);

      return `记忆已存储:\n- 类型: ${type}\n- 内容: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}\n- 标签: ${memory.metadata.tags.join(', ') || '无'}`;
    } catch (error) {
      log.error({ error, content: content.slice(0, 50) }, '存储记忆失败');
      throw new Error(`存储记忆失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 创建 Memory 搜索工具
 */
export function createMemorySearchTool(): ToolDefinition<{ query: string; method?: 'similarity' | 'keyword'; limit?: number }> {
  return new MemoryTool();
}

/**
 * 创建 Memory 存储工具
 */
export function createMemoryStoreTool(): ToolDefinition<{ content: string; type?: string; tags?: string }> {
  return new MemoryStoreTool();
}
