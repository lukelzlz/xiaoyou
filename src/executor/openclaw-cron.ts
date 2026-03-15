import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type { CronRule, ExecutionPlan, ScheduleTask } from '../types/index.js';

const log = createChildLogger('openclaw-cron');

interface CronTaskResponse {
  id: string;
  userId?: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'expired' | 'cancelled';
  expression: string;
  timezone: string;
  nextExecution?: string;
  lastExecution?: string;
  executionCount: number;
  maxExecutions?: number;
  startTime?: string;
  endTime?: string;
  task?: {
    type: string;
    params: Record<string, unknown>;
    callback?: string;
    plan?: ExecutionPlan;
  };
  notifyOnComplete?: boolean;
  notifyOnFailure?: boolean;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface TaskTemplate {
  type: string;
  params: Record<string, unknown>;
  callback?: string;
  plan?: ExecutionPlan;
}

interface CreateCronOptions {
  name?: string;
  description?: string;
  notifyOnComplete?: boolean;
  notifyOnFailure?: boolean;
}

export class OpenClawCron {
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openclaw.apiKey}`,
    };
  }

  /** 注册定时任务 */
  async register(rule: CronRule, task: TaskTemplate, options?: CreateCronOptions): Promise<string> {
    log.info({ expression: rule.expression, taskType: task.type }, '注册定时任务');

    const response = await fetch(`${config.openclaw.apiUrl}/crons`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        expression: rule.expression,
        timezone: rule.timezone,
        description: rule.description,
        name: options?.name,
        task: {
          type: task.type,
          params: task.params,
          callback: task.callback,
          plan: task.plan,
        },
        startTime: rule.startTime?.toISOString(),
        endTime: rule.endTime?.toISOString(),
        maxExecutions: rule.maxExecutions,
        notifyOnComplete: options?.notifyOnComplete ?? false,
        notifyOnFailure: options?.notifyOnFailure ?? true,
      }),
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 注册失败', {
        details: { status: response.status },
        retryable: true,
      });
    }

    const cronTask = (await response.json()) as CronTaskResponse;
    log.info({ taskId: cronTask.id }, '定时任务注册成功');
    return cronTask.id;
  }

  /** 更新定时任务 */
  async update(taskId: string, updates: Partial<CronRule> & { task?: Partial<TaskTemplate> }): Promise<void> {
    log.info({ taskId, updates }, '更新定时任务');

    const body: Record<string, unknown> = {};
    if (updates.expression) body.expression = updates.expression;
    if (updates.timezone) body.timezone = updates.timezone;
    if (updates.description) body.description = updates.description;
    if (updates.startTime) body.startTime = updates.startTime.toISOString();
    if (updates.endTime) body.endTime = updates.endTime.toISOString();
    if (updates.maxExecutions !== undefined) body.maxExecutions = updates.maxExecutions;
    if (updates.task) body.task = updates.task;

    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 更新失败', {
        details: { taskId, status: response.status },
      });
    }
  }

  /** 取消定时任务 */
  async cancel(taskId: string): Promise<void> {
    log.info({ taskId }, '取消定时任务');

    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 取消失败', {
        details: { taskId, status: response.status },
      });
    }
  }

  /** 暂停定时任务 */
  async pause(taskId: string): Promise<void> {
    log.info({ taskId }, '暂停定时任务');

    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}/pause`, {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 暂停失败');
    }
  }

  /** 恢复定时任务 */
  async resume(taskId: string): Promise<void> {
    log.info({ taskId }, '恢复定时任务');

    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}/resume`, {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 恢复失败');
    }
  }

  /** 获取下次执行时间 */
  async getNextExecution(taskId: string): Promise<Date> {
    const task = await this.getTaskDetail(taskId);
    return new Date(task.nextExecution ?? Date.now());
  }

  /** 获取用户的所有定时任务 */
  async listTasks(userId: string): Promise<ScheduleTask[]> {
    const response = await fetch(
      `${config.openclaw.apiUrl}/crons?userId=${encodeURIComponent(userId)}`,
      {
        method: 'GET',
        headers: this.headers,
      },
    );

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '获取定时任务列表失败');
    }

    const tasks = (await response.json()) as CronTaskResponse[];
    return tasks.map((t) => this.toScheduleTask(t));
  }

  /** 获取单个定时任务详情 */
  async getTask(taskId: string): Promise<ScheduleTask> {
    const task = await this.getTaskDetail(taskId);
    return this.toScheduleTask(task);
  }

  /** 获取原始任务详情 */
  async getTaskDetail(taskId: string): Promise<CronTaskResponse> {
    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.NOT_FOUND, '定时任务不存在', {
        details: { taskId },
      });
    }

    return (await response.json()) as CronTaskResponse;
  }

  /** 获取任务执行历史 */
  async getExecutionHistory(taskId: string, options?: { limit?: number; offset?: number }): Promise<Array<{
    executionId: string;
    executedAt: Date;
    status: 'success' | 'failed';
    duration: number;
    error?: string;
  }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const url = `${config.openclaw.apiUrl}/crons/${taskId}/history${params.toString() ? `?${params}` : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '获取执行历史失败', {
        details: { taskId, status: response.status },
      });
    }

    const history = (await response.json()) as Array<{
      executionId: string;
      executedAt: string;
      status: 'success' | 'failed';
      duration: number;
      error?: string;
    }>;

    return history.map((item) => ({
      ...item,
      executedAt: new Date(item.executedAt),
    }));
  }

  /** 发送通知回调 */
  async sendCallback(taskId: string, event: 'completed' | 'failed', data: Record<string, unknown>): Promise<void> {
    const task = await this.getTaskDetail(taskId);
    const callbackUrl = task.task?.callback;

    if (!callbackUrl) {
      log.debug({ taskId }, '任务未配置回调地址，跳过通知');
      return;
    }

    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          event,
          timestamp: new Date().toISOString(),
          ...data,
        }),
      });

      if (!response.ok) {
        log.warn({ taskId, callbackUrl, status: response.status }, '回调通知发送失败');
      } else {
        log.debug({ taskId, event }, '回调通知发送成功');
      }
    } catch (error) {
      log.warn({ taskId, callbackUrl, error }, '回调通知请求异常');
    }
  }

  /** 发送系统通知（用于告警或直接触达用户） */
  async sendNotification(userId: string, title: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    log.info({ userId, level, title }, '发送定时任务系统通知');

    try {
      const response = await fetch(`${config.openclaw.apiUrl}/notifications`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          userId,
          title,
          message,
          level,
        }),
      });

      if (!response.ok) {
        log.warn({ userId, status: response.status }, 'OpenClaw 系统通知发送失败');
      }
    } catch (error) {
      log.warn({ error, userId }, 'OpenClaw 系统通知请求异常');
    }
  }

  /** 将 API 响应转换为 ScheduleTask 类型 */
  private toScheduleTask(t: CronTaskResponse): ScheduleTask {
    return {
      id: t.id,
      userId: t.userId ?? '',
      name: t.name ?? `定时任务 ${t.id}`,
      description: t.description,
      rule: {
        expression: t.expression,
        description: t.description ?? '',
        timezone: t.timezone,
        startTime: t.startTime ? new Date(t.startTime) : undefined,
        endTime: t.endTime ? new Date(t.endTime) : undefined,
        maxExecutions: t.maxExecutions,
      },
      plan: t.task?.plan ?? {
        planId: t.id,
        description: t.description ?? '',
        steps: [],
        dependencies: { nodes: [], edges: [] },
        estimatedDuration: 0,
        requiredResources: [],
      },
      notifyOnComplete: t.notifyOnComplete ?? false,
      notifyOnFailure: t.notifyOnFailure ?? true,
      status: t.status,
      executionCount: t.executionCount,
      lastExecution: t.lastExecution ? new Date(t.lastExecution) : undefined,
      nextExecution: t.nextExecution ? new Date(t.nextExecution) : undefined,
      createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
      updatedAt: t.updatedAt ? new Date(t.updatedAt) : new Date(),
    };
  }
}
