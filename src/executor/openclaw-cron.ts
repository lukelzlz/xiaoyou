import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import {
  getOpenClawRpcClient,
  type SessionInfo,
} from './openclaw-rpc.js';
import type { CronRule, ExecutionPlan, ScheduleTask } from '../types/index.js';

const log = createChildLogger('openclaw-cron');

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

/**
 * OpenClaw CRON 定时任务管理
 *
 * 通过 WebSocket RPC 与 OpenClaw Gateway 通信
 * 支持多 session 隔离
 */
export class OpenClawCron {
  private rpc = getOpenClawRpcClient();

  /**
   * 注册定时任务
   */
  async register(
    rule: CronRule,
    task: TaskTemplate,
    options?: CreateCronOptions,
    session?: SessionInfo,
  ): Promise<string> {
    log.info({ expression: rule.expression, taskType: task.type }, '注册定时任务');

    await this.rpc.connect();

    const result = await this.rpc.createCronTask(
      rule.expression,
      {
        type: task.type,
        params: task.params,
      },
      {
        timezone: rule.timezone,
        session,
        callback: task.callback,
      },
    );

    log.info({ taskId: result.taskId }, '定时任务注册成功');
    return result.taskId;
  }

  /**
   * 更新定时任务
   */
  async update(
    taskId: string,
    updates: Partial<CronRule> & { task?: Partial<TaskTemplate> },
  ): Promise<void> {
    log.info({ taskId, updates }, '更新定时任务');

    await this.rpc.connect();

    await this.rpc.updateCronTask(taskId, {
      expression: updates.expression,
      enabled: true,
    });
  }

  /**
   * 取消定时任务
   */
  async cancel(taskId: string): Promise<void> {
    log.info({ taskId }, '取消定时任务');
    await this.rpc.connect();
    await this.rpc.deleteCronTask(taskId);
  }

  /**
   * 暂停定时任务
   */
  async pause(taskId: string): Promise<void> {
    log.info({ taskId }, '暂停定时任务');
    await this.rpc.connect();
    await this.rpc.updateCronTask(taskId, { enabled: false });
  }

  /**
   * 恢复定时任务
   */
  async resume(taskId: string): Promise<void> {
    log.info({ taskId }, '恢复定时任务');
    await this.rpc.connect();
    await this.rpc.updateCronTask(taskId, { enabled: true });
  }

  /**
   * 获取下次执行时间
   */
  async getNextExecution(taskId: string): Promise<Date> {
    const task = await this.getTaskDetail(taskId);
    return new Date(task.nextExecution ?? Date.now());
  }

  /**
   * 获取用户的所有定时任务
   */
  async listTasks(userId: string): Promise<ScheduleTask[]> {
    await this.rpc.connect();

    const tasks = await this.rpc.listCronTasks(userId);

    return tasks.map(t => this.toScheduleTask(t));
  }

  /**
   * 获取单个定时任务详情
   */
  async getTask(taskId: string): Promise<ScheduleTask> {
    const task = await this.getTaskDetail(taskId);
    return this.toScheduleTask(task);
  }

  /**
   * 获取原始任务详情
   */
  async getTaskDetail(taskId: string): Promise<{
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
    task?: TaskTemplate;
  }> {
    // 通过 RPC 获取任务详情
    await this.rpc.connect();

    const result = await this.rpc.call<{
      id: string;
      userId?: string;
      name?: string;
      description?: string;
      status: string;
      expression: string;
      timezone: string;
      nextExecution?: string;
      lastExecution?: string;
      executionCount: number;
      task?: TaskTemplate;
    }>('cron.get', { taskId });

    return {
      ...result,
      status: result.status as 'active' | 'paused' | 'expired' | 'cancelled',
    };
  }

  /**
   * 获取任务执行历史
   */
  async getExecutionHistory(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<Array<{
    executionId: string;
    executedAt: Date;
    status: 'success' | 'failed';
    duration: number;
    error?: string;
  }>> {
    await this.rpc.connect();

    const history = await this.rpc.call<Array<{
      executionId: string;
      executedAt: string;
      status: 'success' | 'failed';
      duration: number;
      error?: string;
    }>>('cron.history', {
      taskId,
      limit: options?.limit,
      offset: options?.offset,
    });

    return history.map(item => ({
      ...item,
      executedAt: new Date(item.executedAt),
    }));
  }

  /**
   * 发送通知回调
   */
  async sendCallback(
    taskId: string,
    event: 'completed' | 'failed',
    data: Record<string, unknown>,
  ): Promise<void> {
    log.info({ taskId, event }, '发送回调通知');

    // 通过 RPC 发送回调
    await this.rpc.connect();

    await this.rpc.call('cron.callback', {
      taskId,
      event,
      ...data,
    });
  }

  /**
   * 发送系统通知
   */
  async sendNotification(
    session: SessionInfo,
    title: string,
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): Promise<void> {
    log.info({ userId: session.userId, level, title }, '发送系统通知');

    await this.rpc.connect();
    await this.rpc.sendNotification(session, `${title}\n\n${message}`);
  }

  /**
   * 转换为 ScheduleTask 类型
   */
  private toScheduleTask(t: {
    id: string;
    userId?: string;
    name?: string;
    description?: string;
    status?: string;
    expression?: string;
    timezone?: string;
    nextExecution?: string;
    lastExecution?: string;
    executionCount?: number;
    task?: TaskTemplate;
  }): ScheduleTask {
    return {
      id: t.id,
      userId: t.userId ?? '',
      name: t.name ?? `定时任务 ${t.id}`,
      description: t.description,
      rule: {
        expression: t.expression ?? '',
        description: t.description ?? '',
        timezone: t.timezone ?? config.timezone,
      },
      plan: t.task?.plan ?? {
        planId: t.id,
        description: t.description ?? '',
        steps: [],
        dependencies: { nodes: [], edges: [] },
        estimatedDuration: 0,
        requiredResources: [],
      },
      notifyOnComplete: true,
      notifyOnFailure: true,
      status: (t.status || 'active') as ScheduleTask['status'],
      executionCount: t.executionCount ?? 0,
      lastExecution: t.lastExecution ? new Date(t.lastExecution) : undefined,
      nextExecution: t.nextExecution ? new Date(t.nextExecution) : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}
