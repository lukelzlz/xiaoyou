import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Redis from 'ioredis';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './config/index.js';
import { metricsService } from './monitoring/metrics.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('health');

// 全局回调处理器（由外部设置）
let webhookHandler: WebhookHandler | null = null;

export interface WebhookHandler {
  onTaskCompleted(data: {
    taskId: string;
    userId: string;
    channelId: string;
    platform: string;
    result?: unknown;
  }): Promise<void>;

  onTaskFailed(data: {
    taskId: string;
    userId: string;
    channelId: string;
    platform: string;
    error: string;
  }): Promise<void>;

  onCronTriggered(data: {
    cronTaskId: string;
    userId: string;
    message: string;
  }): Promise<void>;
}

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

/**
 * 设置 webhook 处理器
 */
export function setWebhookHandler(handler: WebhookHandler): void {
  webhookHandler = handler;
  log.info('Webhook 处理器已设置');
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

  // 健康检查
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

  // 就绪检查
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

  // 监控指标
  app.get('/metrics', (c) => {
    return c.json(metricsService.getSnapshot());
  });

  // ============ OpenClaw Webhook 端点 ============

  /**
   * OpenClaw 任务完成回调
   * POST /webhook/openclaw/task/completed
   */
  app.post('/webhook/openclaw/task/completed', async (c) => {
    try {
      const body = await c.req.json();

      log.info({ taskId: body.taskId }, '收到任务完成回调');

      if (webhookHandler) {
        await webhookHandler.onTaskCompleted({
          taskId: body.taskId,
          userId: body.userId || body.metadata?.userId || '',
          channelId: body.channelId || body.metadata?.channelId || '',
          platform: body.platform || body.metadata?.platform || 'discord',
          result: body.result,
        });
      }

      return c.json({ success: true });
    } catch (error) {
      log.error({ error }, '处理任务完成回调失败');
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  /**
   * OpenClaw 任务失败回调
   * POST /webhook/openclaw/task/failed
   */
  app.post('/webhook/openclaw/task/failed', async (c) => {
    try {
      const body = await c.req.json();

      log.info({ taskId: body.taskId }, '收到任务失败回调');

      if (webhookHandler) {
        await webhookHandler.onTaskFailed({
          taskId: body.taskId,
          userId: body.userId || body.metadata?.userId || '',
          channelId: body.channelId || body.metadata?.channelId || '',
          platform: body.platform || body.metadata?.platform || 'discord',
          error: body.error || '未知错误',
        });
      }

      return c.json({ success: true });
    } catch (error) {
      log.error({ error }, '处理任务失败回调失败');
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  /**
   * OpenClaw 定时任务触发回调
   * POST /webhook/openclaw/cron/triggered
   */
  app.post('/webhook/openclaw/cron/triggered', async (c) => {
    try {
      const body = await c.req.json();

      log.info({ cronTaskId: body.cronTaskId }, '收到定时任务触发回调');

      if (webhookHandler) {
        await webhookHandler.onCronTriggered({
          cronTaskId: body.cronTaskId,
          userId: body.userId || body.metadata?.userId || '',
          message: body.message || '定时任务已执行',
        });
      }

      return c.json({ success: true });
    } catch (error) {
      log.error({ error }, '处理定时任务触发回调失败');
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  /**
   * 通用 OpenClaw 回调端点
   * POST /webhook/openclaw
   */
  app.post('/webhook/openclaw', async (c) => {
    try {
      const body = await c.req.json();
      const event = body.event || body.type;

      log.info({ event, taskId: body.taskId }, '收到 OpenClaw 回调');

      switch (event) {
        case 'task.completed':
          if (webhookHandler) {
            await webhookHandler.onTaskCompleted({
              taskId: body.taskId,
              userId: body.userId || body.metadata?.userId || '',
              channelId: body.channelId || body.metadata?.channelId || '',
              platform: body.platform || body.metadata?.platform || 'discord',
              result: body.result,
            });
          }
          break;

        case 'task.failed':
          if (webhookHandler) {
            await webhookHandler.onTaskFailed({
              taskId: body.taskId,
              userId: body.userId || body.metadata?.userId || '',
              channelId: body.channelId || body.metadata?.channelId || '',
              platform: body.platform || body.metadata?.platform || 'discord',
              error: body.error || '未知错误',
            });
          }
          break;

        case 'cron.triggered':
          if (webhookHandler) {
            await webhookHandler.onCronTriggered({
              cronTaskId: body.cronTaskId || body.taskId,
              userId: body.userId || body.metadata?.userId || '',
              message: body.message || '定时任务已执行',
            });
          }
          break;

        default:
          log.warn({ event }, '未知的回调事件类型');
      }

      return c.json({ success: true });
    } catch (error) {
      log.error({ error }, '处理 OpenClaw 回调失败');
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  return app;
}

export function startHealthServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = createHealthApp();
    const port = config.port;

    try {
      const server = serve({ fetch: app.fetch, port }, () => {
        log.info({ port }, 'HTTP 服务已启动 (健康检查 + Webhook)');
        resolve();
      });

      server.on('error', (err: Error) => {
        log.error({ err, port }, 'HTTP 服务启动失败');
        reject(err);
      });
    } catch (err) {
      log.error({ err, port }, 'HTTP 服务启动失败');
      reject(err);
    }
  });
}

/**
 * 获取 webhook URL
 * 用于配置 OpenClaw 回调地址
 */
export function getWebhookUrl(): string {
  const host = process.env.WEBHOOK_HOST || 'localhost';
  const port = config.port;
  return `http://${host}:${port}/webhook/openclaw`;
}
