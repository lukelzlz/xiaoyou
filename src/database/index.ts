/**
 * 数据库服务层
 * 
 * 使用 Prisma ORM 进行数据持久化
 */
import { PrismaClient, type User, type Task, type Schedule, type Feedback, type AuditLog } from '@prisma/client';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';

const log = createChildLogger('database');

// ============ Prisma 客户端单例 ============

let prisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' 
        ? ['query', 'info', 'warn', 'error']
        : ['error'],
    });
  }
  return prisma;
}

export const db = getPrismaClient();

// ============ 用户服务 ============

export class UserService {
  /**
   * 创建或更新用户
   */
  async upsertUser(data: {
    discordId?: string;
    telegramId?: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<User> {
    try {
      // 根据 discordId 或 telegramId 查找现有用户
      let existingUser: User | null = null;
      
      if (data.discordId) {
        existingUser = await db.user.findUnique({ where: { discordId: data.discordId } });
      } else if (data.telegramId) {
        existingUser = await db.user.findUnique({ where: { telegramId: data.telegramId } });
      }

      if (existingUser) {
        // 更新现有用户
        return db.user.update({
          where: { id: existingUser.id },
          data: {
            ...data,
            lastActiveAt: new Date(),
          },
        });
      }

      // 创建新用户
      const user = await db.user.create({
        data: {
          ...data,
          profile: { create: {} }, // 创建空画像
        },
      });

      log.info({ userId: user.id }, '用户已创建');
      return user;
    } catch (error) {
      log.error({ error, data }, '创建/更新用户失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '数据库操作失败');
    }
  }

  /**
   * 获取用户
   */
  async getUser(userId: string): Promise<User | null> {
    return db.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    });
  }

  /**
   * 更新用户偏好
   */
  async updatePreferences(userId: string, preferences: Record<string, unknown>): Promise<User> {
    try {
      return await db.user.update({
        where: { id: userId },
        data: preferences,
      });
    } catch (error) {
      log.error({ error, userId }, '更新用户偏好失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '更新用户偏好失败');
    }
  }

  /**
   * 更新用户画像
   */
  async updateProfile(userId: string, data: Record<string, unknown>): Promise<void> {
    try {
      await db.userProfile.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });
    } catch (error) {
      log.error({ error, userId }, '更新用户画像失败');
    }
  }
}

// ============ 任务服务 ============

export class TaskService {
  /**
   * 创建任务
   */
  async createTask(data: {
    userId: string;
    description: string;
    type: string;
    priority?: string;
    plan?: Record<string, unknown>;
  }): Promise<Task> {
    try {
      const task = await db.task.create({
        data: {
          userId: data.userId,
          description: data.description,
          type: data.type,
          priority: data.priority || 'normal',
          plan: data.plan || {},
          status: 'pending',
        },
      });

      log.info({ taskId: task.id, userId: data.userId }, '任务已创建');
      return task;
    } catch (error) {
      log.error({ error, data }, '创建任务失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '创建任务失败');
    }
  }

  /**
   * 获取任务
   */
  async getTask(taskId: string): Promise<Task | null> {
    return db.task.findUnique({
      where: { id: taskId },
      include: { steps: true },
    });
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId: string, status: string, result?: Record<string, unknown>): Promise<Task> {
    try {
      const updateData: Record<string, unknown> = { status };
      
      if (status === 'running') {
        updateData.startedAt = new Date();
      } else if (['completed', 'failed', 'cancelled'].includes(status)) {
        updateData.completedAt = new Date();
      }
      
      if (result) {
        updateData.result = result;
      }

      return db.task.update({
        where: { id: taskId },
        data: updateData,
      });
    } catch (error) {
      log.error({ error, taskId, status }, '更新任务状态失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '更新任务状态失败');
    }
  }

  /**
   * 查询任务列表
   */
  async listTasks(options: {
    userId?: string;
    status?: string;
    type?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ tasks: Task[]; total: number }> {
    const { userId, status, type, page = 1, pageSize = 10 } = options;
    const skip = (page - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    if (status) where.status = status;
    if (type) where.type = type;

    const [tasks, total] = await Promise.all([
      db.task.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      db.task.count({ where }),
    ]);

    return { tasks, total };
  }

  /**
   * 创建任务步骤
   */
  async createTaskStep(taskId: string, step: {
    stepId: string;
    action: string;
    description?: string;
    params?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await db.taskStep.create({
        data: {
          taskId,
          stepId: step.stepId,
          action: step.action,
          description: step.description,
          params: step.params || {},
        },
      });
    } catch (error) {
      log.error({ error, taskId, stepId: step.stepId }, '创建任务步骤失败');
    }
  }

  /**
   * 更新任务步骤状态
   */
  async updateTaskStepStatus(
    taskId: string,
    stepId: string,
    status: string,
    output?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    try {
      const updateData: Record<string, unknown> = { status };
      
      if (status === 'running') {
        updateData.startedAt = new Date();
      } else if (['success', 'failed', 'skipped'].includes(status)) {
        updateData.completedAt = new Date();
      }
      
      if (output) updateData.output = output;
      if (error) updateData.error = error;

      await db.taskStep.updateMany({
        where: { taskId, stepId },
        data: updateData,
      });
    } catch (err) {
      log.error({ err, taskId, stepId }, '更新任务步骤状态失败');
    }
  }
}

// ============ 定时任务服务 ============

export class ScheduleService {
  /**
   * 创建定时任务
   */
  async createSchedule(data: {
    userId: string;
    name: string;
    description?: string;
    cronExpression: string;
    timezone?: string;
    taskTemplate: Record<string, unknown>;
    startTime?: Date;
    endTime?: Date;
    maxExecutions?: number;
  }): Promise<Schedule> {
    try {
      const schedule = await db.schedule.create({
        data: {
          userId: data.userId,
          name: data.name,
          description: data.description,
          cronExpression: data.cronExpression,
          timezone: data.timezone || 'Asia/Shanghai',
          taskTemplate: data.taskTemplate,
          startTime: data.startTime,
          endTime: data.endTime,
          maxExecutions: data.maxExecutions,
          status: 'active',
        },
      });

      log.info({ scheduleId: schedule.id, userId: data.userId }, '定时任务已创建');
      return schedule;
    } catch (error) {
      log.error({ error, data }, '创建定时任务失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '创建定时任务失败');
    }
  }

  /**
   * 获取定时任务
   */
  async getSchedule(scheduleId: string): Promise<Schedule | null> {
    return db.schedule.findUnique({
      where: { id: scheduleId },
    });
  }

  /**
   * 更新定时任务
   */
  async updateSchedule(scheduleId: string, data: Partial<{
    name: string;
    description: string;
    cronExpression: string;
    timezone: string;
    status: string;
    taskTemplate: Record<string, unknown>;
  }>): Promise<Schedule> {
    try {
      return db.schedule.update({
        where: { id: scheduleId },
        data,
      });
    } catch (error) {
      log.error({ error, scheduleId }, '更新定时任务失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '更新定时任务失败');
    }
  }

  /**
   * 删除定时任务
   */
  async deleteSchedule(scheduleId: string): Promise<void> {
    try {
      await db.schedule.delete({
        where: { id: scheduleId },
      });
      log.info({ scheduleId }, '定时任务已删除');
    } catch (error) {
      log.error({ error, scheduleId }, '删除定时任务失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '删除定时任务失败');
    }
  }

  /**
   * 查询定时任务列表
   */
  async listSchedules(options: {
    userId?: string;
    status?: string;
  }): Promise<Schedule[]> {
    const where: Record<string, unknown> = {};
    if (options.userId) where.userId = options.userId;
    if (options.status) where.status = options.status;

    return db.schedule.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 记录执行历史
   */
  async recordExecution(scheduleId: string, data: {
    status: string;
    result?: Record<string, unknown>;
    error?: string;
    duration?: number;
  }): Promise<void> {
    try {
      await db.scheduleHistory.create({
        data: {
          scheduleId,
          status: data.status,
          result: data.result,
          error: data.error,
          duration: data.duration,
          completedAt: new Date(),
        },
      });

      // 更新执行计数
      await db.schedule.update({
        where: { id: scheduleId },
        data: {
          executionCount: { increment: 1 },
          lastExecution: new Date(),
        },
      });
    } catch (error) {
      log.error({ error, scheduleId }, '记录执行历史失败');
    }
  }

  /**
   * 获取需要执行的定时任务
   */
  async getDueSchedules(): Promise<Schedule[]> {
    const now = new Date();
    
    return db.schedule.findMany({
      where: {
        status: 'active',
        nextExecution: { lte: now },
        OR: [
          { endTime: null },
          { endTime: { gte: now } },
        ],
      },
    });
  }
}

// ============ 反馈服务 ============

export class FeedbackService {
  /**
   * 创建反馈
   */
  async createFeedback(data: {
    userId: string;
    messageId?: string;
    taskId?: string;
    type: string;
    content?: string;
    correctedResponse?: string;
    originalResponse?: string;
  }): Promise<Feedback> {
    try {
      const feedback = await db.feedback.create({
        data,
      });

      log.info({ feedbackId: feedback.id, userId: data.userId, type: data.type }, '反馈已创建');
      return feedback;
    } catch (error) {
      log.error({ error, data }, '创建反馈失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '创建反馈失败');
    }
  }

  /**
   * 更新反馈处理状态
   */
  async markProcessed(feedbackId: string, analysis?: Record<string, unknown>): Promise<void> {
    try {
      await db.feedback.update({
        where: { id: feedbackId },
        data: {
          processed: true,
          analysis,
        },
      });
    } catch (error) {
      log.error({ error, feedbackId }, '更新反馈状态失败');
    }
  }

  /**
   * 查询反馈历史
   */
  async listFeedbacks(options: {
    userId?: string;
    type?: string;
    processed?: boolean;
    limit?: number;
  }): Promise<Feedback[]> {
    const where: Record<string, unknown> = {};
    if (options.userId) where.userId = options.userId;
    if (options.type) where.type = options.type;
    if (options.processed !== undefined) where.processed = options.processed;

    return db.feedback.findMany({
      where,
      take: options.limit || 10,
      orderBy: { createdAt: 'desc' },
    });
  }
}

// ============ 审计服务 ============

export class AuditService {
  /**
   * 记录审计日志
   */
  async log(data: {
    userId?: string;
    action: string;
    resource: string;
    result: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditLog> {
    try {
      return db.auditLog.create({
        data,
      });
    } catch (error) {
      log.error({ error, data }, '记录审计日志失败');
      // 审计日志失败不应影响主流程
      throw error;
    }
  }

  /**
   * 查询审计日志
   */
  async listLogs(options: {
    userId?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }): Promise<{ logs: AuditLog[]; total: number }> {
    const { userId, action, startDate, endDate, page = 1, pageSize = 20 } = options;
    const skip = (page - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (userId) where.userId = userId;
    if (action) where.action = action;
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Record<string, Date>).gte = startDate;
      if (endDate) (where.createdAt as Record<string, Date>).lte = endDate;
    }

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      db.auditLog.count({ where }),
    ]);

    return { logs, total };
  }
}

// ============ Webhook 服务 ============

export class WebhookService {
  /**
   * 存储 Webhook 事件
   */
  async storeEvent(data: {
    type: string;
    source: string;
    data: Record<string, unknown>;
  }): Promise<string> {
    try {
      const event = await db.webhookEvent.create({
        data,
      });
      return event.id;
    } catch (error) {
      log.error({ error, type: data.type }, '存储 Webhook 事件失败');
      throw new XiaoyouError(ErrorCode.INTERNAL, '存储 Webhook 事件失败');
    }
  }

  /**
   * 标记事件已处理
   */
  async markProcessed(eventId: string): Promise<void> {
    try {
      await db.webhookEvent.update({
        where: { id: eventId },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      log.error({ error, eventId }, '标记事件处理失败');
    }
  }

  /**
   * 标记事件处理失败
   */
  async markFailed(eventId: string, error: string): Promise<void> {
    try {
      await db.webhookEvent.update({
        where: { id: eventId },
        data: {
          error,
          retryCount: { increment: 1 },
        },
      });
    } catch (err) {
      log.error({ err, eventId }, '标记事件失败状态失败');
    }
  }

  /**
   * 获取未处理的事件
   */
  async getUnprocessedEvents(limit: number = 100): Promise<Array<{
    id: string;
    type: string;
    source: string;
    data: Record<string, unknown>;
  }>> {
    return db.webhookEvent.findMany({
      where: {
        processed: false,
        retryCount: { lt: 3 },
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
  }
}

// ============ 导出服务实例 ============

export const userService = new UserService();
export const taskService = new TaskService();
export const scheduleService = new ScheduleService();
export const feedbackService = new FeedbackService();
export const auditService = new AuditService();
export const webhookService = new WebhookService();
