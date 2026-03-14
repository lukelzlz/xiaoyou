import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Redis from 'ioredis';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './config/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('health');

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
  version: string;
  env: string;
}

export interface ReadinessCheckResult {
  status: 'ready' | 'not_ready';
  checks: Record<string, boolean>;
}

async function checkRedis(): Promise<boolean> {
  try {
    const redis = new Redis(config.redis.url, {
      connectTimeout: 3000,
      lazyConnect: true,
    });
    await redis.ping();
    await redis.quit();
    return true;
  } catch {
    return false;
  }
}

async function checkQdrant(): Promise<boolean> {
  try {
    const client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
      timeout: 3000,
    });
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

export function createHealthApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const result: HealthCheckResult = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '0.1.0',
      env: config.env,
    };
    return c.json(result);
  });

  app.get('/ready', async (c) => {
    const checks: Record<string, boolean> = {
      redis: await checkRedis(),
      qdrant: await checkQdrant(),
    };

    const allHealthy = Object.values(checks).every((v) => v);
    const result: ReadinessCheckResult = {
      status: allHealthy ? 'ready' : 'not_ready',
      checks,
    };

    return c.json(result, allHealthy ? 200 : 503);
  });

  return app;
}

export function startHealthServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = createHealthApp();
    const port = config.port;

    try {
      const server = serve({ fetch: app.fetch, port }, () => {
        log.info({ port }, '健康检查服务已启动');
        resolve();
      });

      server.on('error', (err: Error) => {
        log.error({ err, port }, '健康检查服务启动失败');
        reject(err);
      });
    } catch (err) {
      log.error({ err, port }, '健康检查服务启动失败');
      reject(err);
    }
  });
}
