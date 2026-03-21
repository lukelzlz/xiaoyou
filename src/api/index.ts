/**
 * REST API 路由
 *
 * 实现文档 docs/api.md 中定义的 API 接口
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import { config } from '../config/index.js';
import { HotMemoryStore } from '../memory/hot.js';
import { VectorMemoryStore } from '../memory/vector.js';
import { MemoryFlush } from '../memory/flush.js';
import { PlanService } from '../llm/plan.js';
import { OpenClawAgent, type SessionInfo } from '../executor/openclaw-agent.js';
import { OpenClawCron } from '../executor/openclaw-cron.js';
import { invokeTool, defaultToolRegistry } from '../tools/index.js';
import { IntentType, SceneType, type Intent, type Entity } from '../types/index.js';
import { authenticationService, authorizationService } from '../security/index.js';

const log = createChildLogger('api');

// ============ 认证类型定义 ============

/**
 * 认证用户信息，存储在 Hono context 中
 */
interface AuthUser {
  userId: string;
  roles: string[];
}

/**
 * 扩展 Hono 的 context 类型
 */
declare module 'hono' {
  interface ContextVariableMap {
    authUser: AuthUser;
  }
}

// ============ 通用类型定义 ============

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  timestamp: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ============ 请求 Schema ============

const incomingMessageSchema = z.object({
  platform: z.enum(['discord', 'telegram']),
  channelId: z.string(),
  userId: z.string(),
  content: z.string(),
  attachments: z.array(z.object({
    type: z.enum(['image', 'document', 'audio', 'video']),
    url: z.string(),
    name: z.string(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
  })).optional(),
  replyTo: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const outgoingMessageSchema = z.object({
  platform: z.enum(['discord', 'telegram']),
  channelId: z.string(),
  content: z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('embed'), title: z.string(), description: z.string(), fields: z.array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() })).optional() }),
    z.object({ type: z.literal('file'), url: z.string(), name: z.string() }),
    z.object({ type: z.literal('image'), url: z.string(), caption: z.string().optional() }),
  ]),
  replyTo: z.string().optional(),
});

const intentAnalyzeSchema = z.object({
  text: z.string(),
  context: z.object({
    recentMessages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional(),
    activeTask: z.string().optional(),
    userPreferences: z.record(z.unknown()).optional(),
  }).optional(),
  userId: z.string().optional(),
});

const createTaskSchema = z.object({
  description: z.string(),
  type: z.enum(['code', 'automation', 'analysis']),
  params: z.record(z.unknown()).optional(),
  userId: z.string(),
  channelId: z.string(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
});

const taskControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry']),
  params: z.record(z.unknown()).optional(),
});

const createScheduleSchema = z.object({
  name: z.string(),
  description: z.string(),
  cronExpression: z.string(),
  timezone: z.string(),
  taskTemplate: createTaskSchema.omit({ userId: true, channelId: true }),
  notifyOnComplete: z.boolean(),
  notifyOnFailure: z.boolean(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  maxExecutions: z.number().optional(),
});

const feedbackSchema = z.object({
  userId: z.string(),
  messageId: z.string(),
  type: z.enum(['positive', 'negative', 'correction']),
  content: z.string().optional(),
  correctedResponse: z.string().optional(),
});

// ============ API 响应辅助函数 ============

function successResponse<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function errorResponse(code: string, message: string, details?: Record<string, unknown>): ApiResponse<never> {
  return {
    success: false,
    error: { code, message, details },
    timestamp: new Date().toISOString(),
  };
}

// ============ 认证中间件 ============

/**
 * 认证中间件
 * 验证 Bearer Token 并将用户信息存储到 context 中
 */
async function authMiddleware(c: Context, next: () => Promise<void>) {
  // 跳过健康检查端点
  if (c.req.path === '/health' || c.req.path === '/api/health') {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const apiKey = c.req.header('X-API-Key');

  // 支持 API Key 认证（用于服务间通信）
  if (apiKey) {
    const validApiKey = process.env.API_KEY;
    if (validApiKey && apiKey === validApiKey) {
      c.set('authUser', { userId: 'system', roles: ['admin'] });
      return next();
    }
    return c.json(errorResponse('ERR_UNAUTHORIZED', 'Invalid API key'), 401);
  }

  // Bearer Token 认证
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(errorResponse('ERR_UNAUTHORIZED', 'Missing authentication. Provide Bearer token or X-API-Key'), 401);
  }

  const token = authHeader.slice(7);

  try {
    const decoded = authenticationService.verifyToken(token);
    c.set('authUser', {
      userId: decoded.userId,
      roles: decoded.roles || ['user'],
    });
    return next();
  } catch (error) {
    log.warn({ error }, 'Token 验证失败');
    return c.json(errorResponse('ERR_UNAUTHORIZED', 'Invalid or expired token'), 401);
  }
}

/**
 * 可选认证中间件
 * 如果提供了认证信息则验证，否则允许匿名访问
 */
async function optionalAuthMiddleware(c: Context, next: () => Promise<void>) {
  const authHeader = c.req.header('Authorization');
  const apiKey = c.req.header('X-API-Key');

  // API Key 认证
  if (apiKey) {
    const validApiKey = process.env.API_KEY;
    if (validApiKey && apiKey === validApiKey) {
      c.set('authUser', { userId: 'system', roles: ['admin'] });
    }
    return next();
  }

  // Bearer Token 认证
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = authenticationService.verifyToken(token);
      c.set('authUser', {
        userId: decoded.userId,
        roles: decoded.roles || ['user'],
      });
    } catch {
      // 可选认证，忽略错误
    }
  }

  return next();
}

/**
 * 获取当前认证用户
 */
function getAuthUser(c: Context): AuthUser | undefined {
  return c.get('authUser');
}

/**
 * 要求用户认证的辅助函数
 */
function requireAuth(c: Context): AuthUser {
  const user = getAuthUser(c);
  if (!user) {
    throw new XiaoyouError(ErrorCode.UNAUTHORIZED, 'Authentication required');
  }
  return user;
}

/**
 * 检查资源所有权 - 用于资源级别的授权验证
 * @param resourceOwnerId 资源所有者的 userId
 * @param authUser 当前认证用户
 * @returns 如果有权限返回 true，否则抛出 403 错误
 */
function checkResourceOwnership(resourceOwnerId: string, authUser: AuthUser): boolean {
  // 管理员可以访问所有资源
  if (authUser.roles.includes('admin')) {
    return true;
  }
  // 检查是否是资源所有者
  if (resourceOwnerId !== authUser.userId) {
    throw new XiaoyouError(ErrorCode.FORBIDDEN, '无权访问此资源');
  }
  return true;
}

// ============ API 路由工厂 ============

export interface ApiDeps {
  memory: HotMemoryStore;
  vectorMemory: VectorMemoryStore;
  memoryFlush: MemoryFlush;
  planner: PlanService;
  executor: OpenClawAgent;
  cron: OpenClawCron;
}

export function createApiRouter(deps: ApiDeps): Hono {
  const app = new Hono();
  const { memory, vectorMemory, memoryFlush, planner, executor, cron } = deps;

  // 应用认证中间件到所有 /api/* 路由
  app.use('/api/*', authMiddleware);

  // ============ 消息处理 API ============

  /**
   * POST /api/messages/incoming - 接收消息
   */
  app.post('/api/messages/incoming', async (c) => {
    try {
      const body = incomingMessageSchema.parse(await c.req.json());
      const messageId = `msg_${nanoid()}`;

      log.info({ messageId, platform: body.platform, userId: body.userId }, '接收消息');

      // 这里只是接收消息，实际处理由 controller 层完成
      // API 层负责消息的接收和确认

      return c.json(successResponse({
        messageId,
        status: 'accepted',
      }));
    } catch (error) {
      log.error({ error }, '接收消息失败');
      if (error instanceof z.ZodError) {
        return c.json(errorResponse('ERR_INVALID_INPUT', '参数验证失败', { errors: error.errors }), 400);
      }
      return c.json(errorResponse('ERR_INTERNAL', '内部错误'), 500);
    }
  });

  /**
   * POST /api/messages/outgoing - 发送消息
   */
  app.post('/api/messages/outgoing', async (c) => {
    try {
      const body = outgoingMessageSchema.parse(await c.req.json());
      const messageId = `msg_${nanoid()}`;

      log.info({ messageId, platform: body.platform, channelId: body.channelId }, '发送消息');

      // 实际发送由平台适配器完成
      // 这里返回消息 ID 供追踪

      return c.json(successResponse({
        messageId,
        status: 'sent',
      }));
    } catch (error) {
      log.error({ error }, '发送消息失败');
      if (error instanceof z.ZodError) {
        return c.json(errorResponse('ERR_INVALID_INPUT', '参数验证失败', { errors: error.errors }), 400);
      }
      return c.json(errorResponse('ERR_INTERNAL', '内部错误'), 500);
    }
  });

  /**
   * GET /api/messages/:messageId/status - 查询消息状态
   */
  app.get('/api/messages/:messageId/status', async (c) => {
    const { messageId } = c.req.param();

    try {
      // 从热记忆中查询消息状态
      // 实际实现需要根据业务逻辑追踪消息状态

      return c.json(successResponse({
        messageId,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    } catch (error) {
      log.error({ error, messageId }, '查询消息状态失败');
      return c.json(errorResponse('ERR_NOT_FOUND', '消息不存在'), 404);
    }
  });

  // ============ 意图识别 API ============

  /**
   * POST /api/intent/analyze - 意图分析
   */
  app.post('/api/intent/analyze', async (c) => {
    try {
      const body = intentAnalyzeSchema.parse(await c.req.json());

      // 使用规划服务进行意图分析
      const prompt = `分析以下用户消息的意图，返回 JSON 格式：
{"intent": "意图类型", "confidence": 0.95, "entities": []}

可用意图类型：
- chat.casual, chat.emotional, chat.question
- tool.search, tool.extract, tool.query
- task.code, task.automation, task.analysis
- schedule.create, schedule.modify, schedule.cancel, schedule.query

用户消息：${body.text}`;

      const response = await planner.createPlan({
        description: prompt,
        type: 'intent_analysis',
      });

      // 解析意图结果
      let intent: Intent;
      try {
        const parsed = JSON.parse(response.description || '{}');
        intent = {
          type: parsed.intent as IntentType || IntentType.CHAT_CASUAL,
          confidence: parsed.confidence || 0.5,
          entities: (parsed.entities || []) as Entity[],
        };
      } catch {
        intent = {
          type: IntentType.CHAT_CASUAL,
          confidence: 0.5,
          entities: [],
        };
      }

      // 映射到场景
      const sceneMap: Record<string, SceneType> = {
        'chat.': SceneType.CHAT,
        'tool.': SceneType.TOOL,
        'task.': SceneType.TASK,
        'schedule.': SceneType.SCHEDULE,
      };
      let suggestedScene = SceneType.CHAT;
      for (const [prefix, scene] of Object.entries(sceneMap)) {
        if (intent.type.startsWith(prefix)) {
          suggestedScene = scene;
          break;
        }
      }

      return c.json(successResponse({
        intent: intent.type,
        confidence: intent.confidence,
        entities: intent.entities,
        suggestedScene,
      }));
    } catch (error) {
      log.error({ error }, '意图分析失败');
      return c.json(errorResponse('ERR_LLM_ERROR', '意图分析失败'), 502);
    }
  });

  // ============ 任务管理 API ============

  /**
   * POST /api/tasks - 创建任务
   */
  app.post('/api/tasks', async (c) => {
    try {
      const body = createTaskSchema.parse(await c.req.json());
      const taskId = `task_${nanoid()}`;

      log.info({ taskId, type: body.type, userId: body.userId }, '创建任务');

      // 创建执行计划
      const plan = await planner.createPlan({
        description: body.description,
        type: body.type,
        availableTools: ['search', 'extract', 'query'],
      });

      // 检查缺失参数
      const missingParams: string[] = [];
      for (const step of plan.steps) {
        for (const required of step.requiredParams) {
          if (!body.params?.[required]) {
            missingParams.push(`${step.stepId}.${required}`);
          }
        }
      }

      return c.json(successResponse({
        taskId,
        status: 'created',
        plan: missingParams.length === 0 ? plan : undefined,
        missingParams: missingParams.length > 0 ? missingParams : undefined,
      }));
    } catch (error) {
      log.error({ error }, '创建任务失败');
      return c.json(errorResponse('ERR_INTERNAL', '创建任务失败'), 500);
    }
  });

  /**
   * GET /api/tasks/:taskId - 查询任务状态
   */
  app.get('/api/tasks/:taskId', async (c) => {
    const { taskId } = c.req.param();
    const authUser = getAuthUser(c);

    try {
      const status = await executor.getTaskStatus(taskId);

      // 资源级别授权检查：验证任务所有权
      // 注意：当前 executor.getTaskStatus 不返回 userId，需要从数据库查询
      // TODO: 集成数据库后，从 TaskService 查询任务并验证所有权
      // 目前仅验证用户已认证，管理员可访问所有任务
      if (authUser && !authUser.roles.includes('admin')) {
        // 非管理员用户：未来需要验证任务所有权
        // const task = await taskService.getTask(taskId);
        // checkResourceOwnership(task.userId, authUser);
      }

      return c.json(successResponse({
        taskId,
        status: status.status || 'pending',
        progress: {
          totalSteps: 0,
          completedSteps: status.completedSteps?.length || 0,
          currentStep: status.currentStep,
        },
        result: status.result,
        error: status.error,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    } catch (error) {
      log.error({ error, taskId }, '查询任务状态失败');
      return c.json(errorResponse('ERR_NOT_FOUND', '任务不存在'), 404);
    }
  });

  /**
   * POST /api/tasks/:taskId/control - 控制任务
   */
  app.post('/api/tasks/:taskId/control', async (c) => {
    const { taskId } = c.req.param();
    const authUser = getAuthUser(c);

    try {
      const body = taskControlSchema.parse(await c.req.json());
      
      // 资源级别授权检查
      // TODO: 集成数据库后验证任务所有权
      if (authUser && !authUser.roles.includes('admin')) {
        // 非管理员用户：未来需要验证任务所有权
      }
      
      const previousStatus = await executor.getTaskStatus(taskId);

      switch (body.action) {
        case 'pause':
          await executor.pause(taskId);
          break;
        case 'resume':
          await executor.resume(taskId);
          break;
        case 'cancel':
          await executor.cancel(taskId);
          break;
        case 'retry':
          // 重试需要重新提交任务
          break;
      }

      const currentStatus = await executor.getTaskStatus(taskId);

      return c.json(successResponse({
        taskId,
        previousStatus: previousStatus.status,
        currentStatus: currentStatus.status,
      }));
    } catch (error) {
      log.error({ error, taskId }, '控制任务失败');
      return c.json(errorResponse('ERR_INTERNAL', '控制任务失败'), 500);
    }
  });

  /**
   * GET /api/tasks - 查询任务列表
   */
  app.get('/api/tasks', async (c) => {
    const userId = c.req.query('userId');
    const status = c.req.query('status');
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '10');

    try {
      // 实际实现需要从数据库查询
      // 这里返回空列表作为占位

      return c.json(successResponse({
        items: [],
        total: 0,
        page,
        pageSize,
        hasMore: false,
      }));
    } catch (error) {
      log.error({ error }, '查询任务列表失败');
      return c.json(errorResponse('ERR_INTERNAL', '查询任务列表失败'), 500);
    }
  });

  // ============ 定时任务 API ============

  /**
   * POST /api/schedules - 创建定时任务
   */
  app.post('/api/schedules', async (c) => {
    try {
      const body = createScheduleSchema.parse(await c.req.json());
      const authUser = requireAuth(c);

      // 生成 CRON 规则
      const rule = await planner.generateCronRule(body.cronExpression);

      // 创建定时任务 - 使用认证用户的 userId
      const session: SessionInfo = {
        sessionId: `schedule:${nanoid()}`,
        userId: authUser.userId,
        channelId: 'schedule',
        platform: 'discord',
      };

      const scheduleId = await cron.register(rule, {
        type: body.taskTemplate.type,
        params: body.taskTemplate.params || {},
      }, {
        name: body.name,
        description: body.description,
        notifyOnComplete: body.notifyOnComplete,
        notifyOnFailure: body.notifyOnFailure,
      }, session);

      return c.json(successResponse({
        scheduleId,
        status: 'active',
        nextExecution: new Date().toISOString(),
      }));
    } catch (error) {
      log.error({ error }, '创建定时任务失败');
      return c.json(errorResponse('ERR_INTERNAL', '创建定时任务失败'), 500);
    }
  });

  /**
   * GET /api/schedules/:scheduleId - 查询定时任务
   */
  app.get('/api/schedules/:scheduleId', async (c) => {
    const { scheduleId } = c.req.param();
    const authUser = getAuthUser(c);

    try {
      const task = await cron.getTask(scheduleId);

      // 资源级别授权检查
      if (authUser && !authUser.roles.includes('admin')) {
        // 非管理员用户需要验证任务所有权
        if (task.userId && task.userId !== authUser.userId) {
          return c.json(errorResponse('ERR_FORBIDDEN', '无权访问此定时任务'), 403);
        }
      }

      return c.json(successResponse({
        scheduleId: task.id,
        name: task.name,
        description: task.description,
        cronExpression: task.rule.expression,
        timezone: task.rule.timezone,
        status: task.status,
        nextExecution: task.nextExecution?.toISOString(),
        lastExecution: task.lastExecution?.toISOString(),
        executionCount: task.executionCount,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      }));
    } catch (error) {
      log.error({ error, scheduleId }, '查询定时任务失败');
      return c.json(errorResponse('ERR_NOT_FOUND', '定时任务不存在'), 404);
    }
  });

  /**
   * PUT /api/schedules/:scheduleId - 更新定时任务
   */
  app.put('/api/schedules/:scheduleId', async (c) => {
    const { scheduleId } = c.req.param();
    const authUser = getAuthUser(c);

    try {
      // 资源级别授权检查 - 先获取任务验证所有权
      const existingTask = await cron.getTask(scheduleId);
      if (authUser && !authUser.roles.includes('admin')) {
        if (existingTask.userId && existingTask.userId !== authUser.userId) {
          return c.json(errorResponse('ERR_FORBIDDEN', '无权修改此定时任务'), 403);
        }
      }

      // 使用 schema 验证请求体
      const updateScheduleBodySchema = z.object({
        cronExpression: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        notifyOnComplete: z.boolean().optional(),
        notifyOnFailure: z.boolean().optional(),
        enabled: z.boolean().optional(),
      });
      
      const body = updateScheduleBodySchema.parse(await c.req.json());

      if (body.cronExpression) {
        const rule = await planner.generateCronRule(body.cronExpression);
        await cron.update(scheduleId, rule);
      }

      const task = await cron.getTask(scheduleId);

      return c.json(successResponse({
        scheduleId,
        status: task.status,
        nextExecution: task.nextExecution?.toISOString(),
      }));
    } catch (error) {
      log.error({ error, scheduleId }, '更新定时任务失败');
      if (error instanceof z.ZodError) {
        return c.json(errorResponse('ERR_INVALID_INPUT', '参数验证失败', { errors: error.errors }), 400);
      }
      return c.json(errorResponse('ERR_INTERNAL', '更新定时任务失败'), 500);
    }
  });

  /**
   * DELETE /api/schedules/:scheduleId - 删除定时任务
   */
  app.delete('/api/schedules/:scheduleId', async (c) => {
    const { scheduleId } = c.req.param();
    const authUser = getAuthUser(c);

    try {
      // 资源级别授权检查 - 先获取任务验证所有权
      const existingTask = await cron.getTask(scheduleId);
      if (authUser && !authUser.roles.includes('admin')) {
        if (existingTask.userId && existingTask.userId !== authUser.userId) {
          return c.json(errorResponse('ERR_FORBIDDEN', '无权删除此定时任务'), 403);
        }
      }

      await cron.cancel(scheduleId);

      return c.json(successResponse({
        scheduleId,
        status: 'cancelled',
      }));
    } catch (error) {
      log.error({ error, scheduleId }, '删除定时任务失败');
      return c.json(errorResponse('ERR_INTERNAL', '删除定时任务失败'), 500);
    }
  });

  /**
   * GET /api/schedules - 查询定时任务列表
   */
  app.get('/api/schedules', async (c) => {
    const userId = c.req.query('userId');
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '10');

    try {
      const tasks = userId ? await cron.listTasks(userId) : [];

      return c.json(successResponse({
        items: tasks.map(t => ({
          scheduleId: t.id,
          name: t.name,
          cronExpression: t.rule.expression,
          status: t.status,
          nextExecution: t.nextExecution?.toISOString(),
          executionCount: t.executionCount,
        })),
        total: tasks.length,
        page,
        pageSize,
        hasMore: false,
      }));
    } catch (error) {
      log.error({ error }, '查询定时任务列表失败');
      return c.json(errorResponse('ERR_INTERNAL', '查询定时任务列表失败'), 500);
    }
  });

  // ============ 记忆系统 API ============

  /**
   * GET /api/memory/hot/:sessionId - 读取热记忆
   */
  app.get('/api/memory/hot/:sessionId', async (c) => {
    const { sessionId } = c.req.param();

    try {
      const hotMemory = await memory.get(sessionId);

      if (!hotMemory) {
        return c.json(errorResponse('ERR_NOT_FOUND', '会话不存在'), 404);
      }

      return c.json(successResponse({
        sessionId: hotMemory.sessionId,
        userId: hotMemory.userId,
        conversationHistory: hotMemory.conversationHistory,
        activeTasks: hotMemory.activeTasks,
        userPreferences: hotMemory.userPreferences,
        contextVariables: hotMemory.contextVariables,
        lastUpdated: hotMemory.lastUpdated.toISOString(),
      }));
    } catch (error) {
      log.error({ error, sessionId }, '读取热记忆失败');
      return c.json(errorResponse('ERR_INTERNAL', '读取热记忆失败'), 500);
    }
  });

  /**
   * PATCH /api/memory/hot/:sessionId - 更新热记忆
   */
  app.patch('/api/memory/hot/:sessionId', async (c) => {
    const { sessionId } = c.req.param();

    try {
      const body = await c.req.json();

      await memory.update(sessionId, body);

      return c.json(successResponse({
        sessionId,
        updated: true,
      }));
    } catch (error) {
      log.error({ error, sessionId }, '更新热记忆失败');
      return c.json(errorResponse('ERR_INTERNAL', '更新热记忆失败'), 500);
    }
  });

  /**
   * POST /api/memory/vector/search - 向量记忆检索
   */
  app.post('/api/memory/vector/search', async (c) => {
    try {
      const body = await c.req.json();

      const results = await vectorMemory.retrieve(body.query, {
        method: 'similarity',
        topK: body.topK || 10,
        threshold: body.threshold || 0.7,
        userId: body.userId,
        type: body.type,
        timeRange: body.timeRange,
      });

      return c.json(successResponse({
        results: results.map(r => ({
          id: r.id,
          content: r.content,
          score: r.score ?? 0,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
        })),
        totalFound: results.length,
      }));
    } catch (error) {
      log.error({ error }, '向量记忆检索失败');
      return c.json(errorResponse('ERR_INTERNAL', '向量记忆检索失败'), 500);
    }
  });

  /**
   * POST /api/memory/flush - 记忆归档
   */
  app.post('/api/memory/flush', async (c) => {
    try {
      const body = await c.req.json();

      const result = await memoryFlush.flushSession(body.sessionId);

      return c.json(successResponse({
        sessionId: body.sessionId,
        archivedItems: result.archivedCount,
        status: result.status,
      }));
    } catch (error) {
      log.error({ error }, '记忆归档失败');
      return c.json(errorResponse('ERR_INTERNAL', '记忆归档失败'), 500);
    }
  });

  // ============ 工具调用 API ============

  /**
   * POST /api/tools/search - 搜索工具
   */
  app.post('/api/tools/search', async (c) => {
    try {
      const body = await c.req.json();
      const result = await invokeTool('brave_search', { query: body.query });

      return c.json(successResponse({
        results: [{ title: '搜索结果', snippet: result }],
        totalResults: 1,
      }));
    } catch (error) {
      log.error({ error }, '搜索失败');
      return c.json(errorResponse('ERR_TOOL_ERROR', '搜索失败'), 502);
    }
  });

  /**
   * POST /api/tools/extract - 内容提取工具
   */
  app.post('/api/tools/extract', async (c) => {
    try {
      const body = await c.req.json();
      const result = await invokeTool('extract', { content: body.url || body.content });

      return c.json(successResponse({
        content: result,
        metadata: { wordCount: result.length },
      }));
    } catch (error) {
      log.error({ error }, '内容提取失败');
      return c.json(errorResponse('ERR_TOOL_ERROR', '内容提取失败'), 502);
    }
  });

  /**
   * POST /api/tools/query - 查询工具
   */
  app.post('/api/tools/query', async (c) => {
    try {
      const body = await c.req.json();
      const result = await invokeTool('query', { query: body.query });

      return c.json(successResponse({
        data: result,
        format: 'text',
      }));
    } catch (error) {
      log.error({ error }, '查询失败');
      return c.json(errorResponse('ERR_TOOL_ERROR', '查询失败'), 502);
    }
  });

  /**
   * GET /api/tools - 获取可用工具列表
   */
  app.get('/api/tools', async (c) => {
    const tools = defaultToolRegistry.list();

    return c.json(successResponse({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }));
  });

  // ============ 用户反馈 API ============

  /**
   * POST /api/feedback - 提交反馈
   */
  app.post('/api/feedback', async (c) => {
    try {
      const body = feedbackSchema.parse(await c.req.json());
      const feedbackId = `fb_${nanoid()}`;

      log.info({ feedbackId, userId: body.userId, type: body.type }, '收到用户反馈');

      // 存储反馈到向量数据库
      await vectorMemory.store({
        id: feedbackId,
        content: JSON.stringify({
          messageId: body.messageId,
          type: body.type,
          content: body.content,
          correctedResponse: body.correctedResponse,
        }),
        embedding: [],
        metadata: {
          type: 'preference',
          userId: body.userId,
          importance: body.type === 'correction' ? 0.9 : 0.7,
          accessCount: 0,
          tags: ['feedback', body.type],
        },
        createdAt: new Date(),
      });

      return c.json(successResponse({
        feedbackId,
        status: 'received',
      }));
    } catch (error) {
      log.error({ error }, '提交反馈失败');
      return c.json(errorResponse('ERR_INTERNAL', '提交反馈失败'), 500);
    }
  });

  /**
   * GET /api/users/:userId/profile - 查询用户画像
   */
  app.get('/api/users/:userId/profile', async (c) => {
    const { userId } = c.req.param();

    try {
      // 从向量数据库检索用户偏好
      const preferences = await vectorMemory.retrieve(`用户偏好 ${userId}`, {
        method: 'similarity',
        topK: 10,
        threshold: 0.5,
        userId,
        type: 'preference',
      });

      return c.json(successResponse({
        userId,
        preferences: {
          language: 'zh-CN',
          responseStyle: 'casual',
          timezone: config.timezone,
        },
        stats: {
          totalMessages: 0,
          totalTasks: 0,
          taskSuccessRate: 0,
          feedbackScore: 0,
        },
        recentTopics: [],
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      }));
    } catch (error) {
      log.error({ error, userId }, '查询用户画像失败');
      return c.json(errorResponse('ERR_INTERNAL', '查询用户画像失败'), 500);
    }
  });

  // ============ 系统管理 API ============

  /**
   * GET /api/health - 健康检查
   */
  app.get('/api/health', async (c) => {
    return c.json(successResponse({
      status: 'ok',
      uptime: process.uptime(),
      version: '1.0.0',
      env: config.env,
    }));
  });

  /**
   * GET /api/metrics - 系统指标
   */
  app.get('/api/metrics', async (c) => {
    const memUsage = process.memoryUsage();

    return c.json(successResponse({
      system: {
        cpuUsage: 0, // 需要 os.cpus() 计算
        memoryUsage: memUsage.heapUsed / memUsage.heapTotal,
        diskUsage: 0, // 需要额外实现
      },
      application: {
        requestsPerMinute: 0,
        averageResponseTime: 0,
        errorRate: 0,
        activeConnections: 0,
      },
      business: {
        activeUsers: 0,
        messagesProcessed: 0,
        tasksRunning: 0,
        scheduledTasks: 0,
      },
    }));
  });

  return app;
}
