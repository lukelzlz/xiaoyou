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

  quick: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
    model: z.string().default('quick'),
    embeddingModel: z.string().default('embedding'),
    visionModel: z.string().default('vision'),
    maxTokens: z.number().default(4096),
    temperature: z.number().default(0.7),
    timeout: z.number().default(30000),
  }),

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

  quick: {
    apiKey: process.env.QUICK_API_KEY || process.env.GLM_API_KEY || '',
    apiUrl: process.env.QUICK_API_URL || process.env.GLM_API_URL || 'https://api.glm.ai/v1',
    model: process.env.QUICK_MODEL || process.env.MODEL_ID || 'quick',
    embeddingModel: process.env.EMBEDDING_MODEL || 'embedding',
    visionModel: process.env.VISION_MODEL || 'vision',
    maxTokens: parseInt(process.env.QUICK_MAX_TOKENS || process.env.GLM_MAX_TOKENS || '4096'),
    temperature: parseFloat(process.env.QUICK_TEMPERATURE || process.env.GLM_TEMPERATURE || '0.7'),
    timeout: parseInt(process.env.QUICK_TIMEOUT || process.env.GLM_TIMEOUT || '30000'),
  },

  plan: {
    apiKey: process.env.PLAN_API_KEY || process.env.NEMOTRON_API_KEY || '',
    apiUrl: process.env.PLAN_API_URL || process.env.NEMOTRON_API_URL || 'https://api.nvidia.com/v1',
    model: process.env.PLAN_MODEL || process.env.NEMOTRON_MODEL || 'plan',
    maxTokens: parseInt(process.env.PLAN_MAX_TOKENS || process.env.NEMOTRON_MAX_TOKENS || '8192'),
    timeout: parseInt(process.env.PLAN_TIMEOUT || process.env.NEMOTRON_TIMEOUT || '60000'),
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
});
