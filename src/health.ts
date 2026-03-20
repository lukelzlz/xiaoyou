import crypto from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Redis from 'ioredis';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from './config/index.js';
import { metricsService } from './monitoring/metrics.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('health');

// ============ Webhook 安全配置 ============
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';
const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000; // 5 分钟时间容差

/**
 * 验证 Webhook HMAC 签名
 */
function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  if (!WEBHOOK_SECRET) {
    log.warn('WEBHOOK_SECRET 未配置，跳过签名验证');
    return true; // 未配置密钥时允许（向后兼容）
  }

  // 检查时间戳防止重放攻击
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > WEBHOOK_TOLERANCE_MS) {
    log.warn({ timestamp: ts, now: Date.now() }, 'Webhook 时间戳无效');
    return false;
  }

  // 构建签名消息: timestamp.payload
  const message = `${timestamp}.${payload}`;
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(message)
    .digest('hex');

  // 使用时间安全比较防止时序攻击
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Webhook 签名验证中间件
 */
async function webhookAuthMiddleware(c: any, next: () => Promise<void>): Promise<Response | void> {
  if (!WEBHOOK_SECRET) {
    return next();
  }

  const signature = c.req.header(WEBHOOK_SIGNATURE_HEADER);
  const timestamp = c.req.header(WEBHOOK_TIMESTAMP_HEADER);

  if (!signature || !timestamp) {
    log.warn('Webhook 请求缺少签名头');
    return c.json({ error: 'Missing webhook signature' }, 401);
  }

  try {
    const rawBody = await c.req.text();
    const valid = verifyWebhookSignature(rawBody, signature, timestamp);

    if (!valid) {
      log.warn('Webhook 签名验证失败');
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    // 将解析后的 body 存储供后续使用
    c.set('rawBody', rawBody);
    c.set('parsedBody', JSON.parse(rawBody));
    return next();
  } catch (error) {
    log.error({ error }, 'Webhook 验证过程出错');
    return c.json({ error: 'Webhook verification failed' }, 401);
  }
}

/**
 * 获取请求 body (支持中间件预解析)
 */
async function getRequestBody<T>(c: any): Promise<T> {
  const parsed = c.get('parsedBody');
  if (parsed) {
    return parsed as T;
  }
  return await c.req.json() as T;
}

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
   * 需要有效的 HMAC 签名（当 WEBHOOK_SECRET 配置时）
   */
  app.post('/webhook/openclaw/task/completed', webhookAuthMiddleware, async (c) => {
    try {
      const body = await getRequestBody<{
        taskId: string;
        userId?: string;
        channelId?: string;
        platform?: string;
        metadata?: { userId?: string; channelId?: string; platform?: string };
        result?: unknown;
      }>(c);

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
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * OpenClaw 任务失败回调
   * POST /webhook/openclaw/task/failed
   * 需要有效的 HMAC 签名（当 WEBHOOK_SECRET 配置时）
   */
  app.post('/webhook/openclaw/task/failed', webhookAuthMiddleware, async (c) => {
    try {
      const body = await getRequestBody<{
        taskId: string;
        userId?: string;
        channelId?: string;
        platform?: string;
        metadata?: { userId?: string; channelId?: string; platform?: string };
        error?: string;
      }>(c);

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
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * OpenClaw 定时任务触发回调
   * POST /webhook/openclaw/cron/triggered
   * 需要有效的 HMAC 签名（当 WEBHOOK_SECRET 配置时）
   */
  app.post('/webhook/openclaw/cron/triggered', webhookAuthMiddleware, async (c) => {
    try {
      const body = await getRequestBody<{
        cronTaskId: string;
        userId?: string;
        metadata?: { userId?: string };
        message?: string;
      }>(c);

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
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * 通用 OpenClaw 回调端点
   * POST /webhook/openclaw
   * 需要有效的 HMAC 签名（当 WEBHOOK_SECRET 配置时）
   */
  app.post('/webhook/openclaw', webhookAuthMiddleware, async (c) => {
    try {
      const body = await getRequestBody<{
        event?: string;
        type?: string;
        taskId?: string;
        cronTaskId?: string;
        userId?: string;
        channelId?: string;
        platform?: string;
        metadata?: { userId?: string; channelId?: string; platform?: string };
        result?: unknown;
        error?: string;
        message?: string;
      }>(c);
      const event = body.event || body.type;

      log.info({ event, taskId: body.taskId }, '收到 OpenClaw 回调');

      switch (event) {
        case 'task.completed':
          if (webhookHandler) {
            await webhookHandler.onTaskCompleted({
              taskId: body.taskId || '',
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
              taskId: body.taskId || '',
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
              cronTaskId: body.cronTaskId || body.taskId || '',
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
      return c.json({ success: false, error: 'Internal server error' }, 500);
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
 * 安全改进：支持 HTTPS，验证主机名
 */
export function getWebhookUrl(): string {
  const host = process.env.WEBHOOK_HOST || 'localhost';
  const port = config.port;

  // 验证主机名安全性
  const allowedHostPattern = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;
  if (!allowedHostPattern.test(host) && host !== 'localhost') {
    log.warn({ host }, 'WEBHOOK_HOST 格式无效，使用 localhost');
    return `http://localhost:${port}/webhook/openclaw`;
  }

  // 根据环境选择协议
  const protocol = process.env.WEBHOOK_PROTOCOL === 'https' ? 'https' : 'http';
  const portSuffix = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80)
    ? ''
    : `:${port}`;

  return `${protocol}://${host}${portSuffix}/webhook/openclaw`;
}
