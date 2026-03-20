import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  env: z.enum(['development', 'production', 'test']),
  port: z.number().default(3000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  timezone: z.string().default('Asia/Shanghai'),

  discord: z.object({
    token: z.string(),
    clientId: z.string(),
    apiUrl: z.string().optional(),
  }),

  telegram: z.object({
    token: z.string(),
    apiUrl: z.string().optional(),
  }),

  // 聊天服务 - 快速响应
  chat: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
    model: z.string().default('chat'),
    embeddingModel: z.string().default('embedding'),
    maxTokens: z.number().default(4096),
    temperature: z.number().default(0.7),
    timeout: z.number().default(30000),
  }),

  // 多模态服务 - 视觉+音频识别 (omni 模型)
  omni: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
    model: z.string().default('omni'),
    maxTokens: z.number().default(4096),
    timeout: z.number().default(60000),
  }),

  // 规划服务 - 复杂任务规划
  plan: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
    model: z.string().default('plan'),
    maxTokens: z.number().default(8192),
    timeout: z.number().default(60000),
  }),

  openclaw: z.object({
    apiUrl: z.string().url(),
    apiKey: z.string(),
    maxConcurrent: z.number().default(10),
    taskTimeout: z.number().default(300000),
  }),

  redis: z.object({
    url: z.string().url(),
    keyPrefix: z.string().default('xiaoyou:'),
  }),

  qdrant: z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
    collection: z.string().default('xiaoyou_memories'),
  }),

  database: z.object({
    url: z.string().url(),
  }),

  brave: z.object({
    apiKey: z.string().optional(),
    apiUrl: z.string().url().default('https://api.search.brave.com/res/v1'),
  }),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse({
  env: (process.env.NODE_ENV || 'development') as 'development' | 'production' | 'test',
  port: parseInt(process.env.PORT || '3000'),
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
  timezone: process.env.TIMEZONE || 'Asia/Shanghai',

  discord: {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    apiUrl: process.env.DISCORD_API_URL,
  },

  telegram: {
    token: process.env.TELEGRAM_TOKEN || '',
    apiUrl: process.env.TELEGRAM_API_URL,
  },

  chat: {
    apiKey: process.env.CHAT_API_KEY || '',
    apiUrl: process.env.CHAT_API_URL || 'https://api.openai.com/v1',
    model: process.env.CHAT_MODEL || 'chat',
    embeddingModel: process.env.EMBEDDING_MODEL || 'embedding',
    maxTokens: parseInt(process.env.CHAT_MAX_TOKENS || '4096'),
    temperature: parseFloat(process.env.CHAT_TEMPERATURE || '0.7'),
    timeout: parseInt(process.env.CHAT_TIMEOUT || '30000'),
  },

  omni: {
    apiKey: process.env.OMNI_API_KEY || process.env.CHAT_API_KEY || '',
    apiUrl: process.env.OMNI_API_URL || process.env.CHAT_API_URL || 'https://api.openai.com/v1',
    model: process.env.OMNI_MODEL || 'omni',
    maxTokens: parseInt(process.env.OMNI_MAX_TOKENS || '4096'),
    timeout: parseInt(process.env.OMNI_TIMEOUT || '60000'),
  },

  plan: {
    apiKey: process.env.PLAN_API_KEY || '',
    apiUrl: process.env.PLAN_API_URL || 'https://api.openai.com/v1',
    model: process.env.PLAN_MODEL || 'plan',
    maxTokens: parseInt(process.env.PLAN_MAX_TOKENS || '8192'),
    timeout: parseInt(process.env.PLAN_TIMEOUT || '60000'),
  },

  openclaw: {
    apiUrl: process.env.OPENCLAW_API_URL || 'http://localhost:8080',
    apiKey: process.env.OPENCLAW_API_KEY || '',
    maxConcurrent: parseInt(process.env.OPENCLAW_MAX_CONCURRENT || '10'),
    taskTimeout: parseInt(process.env.OPENCLAW_TASK_TIMEOUT || '300000'),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'xiaoyou:',
  },

  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY,
    collection: process.env.QDRANT_COLLECTION || 'xiaoyou_memories',
  },

  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/xiaoyou',
  },

  brave: {
    apiKey: process.env.BRAVE_API_KEY,
    apiUrl: process.env.BRAVE_API_URL || 'https://api.search.brave.com/res/v1',
  },
});
