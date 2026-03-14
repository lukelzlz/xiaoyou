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
  }),

  telegram: z.object({
    token: z.string(),
  }),

  glm: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
    model: z.string().default('glm-4.5-air'),
    embeddingModel: z.string().default('text-embedding-3-small'),
    maxTokens: z.number().default(4096),
    temperature: z.number().default(0.7),
    timeout: z.number().default(30000),
  }),

  nemotron: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
    model: z.string().default('nemotron-3-super'),
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
  },

  telegram: {
    token: process.env.TELEGRAM_TOKEN || '',
  },

  glm: {
    apiKey: process.env.GLM_API_KEY || '',
    apiUrl: process.env.GLM_API_URL || 'https://api.glm.ai/v1',
    model: process.env.GLM_MODEL || 'glm-4.5-air',
    embeddingModel: process.env.GLM_EMBEDDING_MODEL || 'text-embedding-3-small',
    maxTokens: parseInt(process.env.GLM_MAX_TOKENS || '4096'),
    temperature: parseFloat(process.env.GLM_TEMPERATURE || '0.7'),
    timeout: parseInt(process.env.GLM_TIMEOUT || '30000'),
  },

  nemotron: {
    apiKey: process.env.NEMOTRON_API_KEY || '',
    apiUrl: process.env.NEMOTRON_API_URL || 'https://api.nvidia.com/v1',
    model: process.env.NEMOTRON_MODEL || 'nemotron-3-super',
    maxTokens: parseInt(process.env.NEMOTRON_MAX_TOKENS || '8192'),
    timeout: parseInt(process.env.NEMOTRON_TIMEOUT || '60000'),
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
