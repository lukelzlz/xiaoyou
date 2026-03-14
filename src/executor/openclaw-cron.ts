import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type { CronRule, ScheduleTask } from '../types/index.js';

const log = createChildLogger('openclaw-cron');

interface CronTaskResponse {
  id: string;
  status: string;
  nextExecution?: string;
  executionCount?: number;
  error?: string;
}

interface TaskTemplate {
  type: string;
  params: Record<string, unknown>;
  callback?: string;
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
  async register(rule: CronRule, task: TaskTemplate): Promise<string> {
    log.info({ expression: rule.expression, taskType: task.type }, '注册定时任务');

    const response = await fetch(`${config.openclaw.apiUrl}/crons`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        expression: rule.expression,
        timezone: rule.timezone,
        task: {
          type: task.type,
          params: task.params,
          callback: task.callback,
        },
        startTime: rule.startTime?.toISOString(),
        endTime: rule.endTime?.toISOString(),
        maxExecutions: rule.maxExecutions,
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
  async update(taskId: string, rule: Partial<CronRule>): Promise<void> {
    log.info({ taskId, rule }, '更新定时任务');

    const body: Record<string, unknown> = {};
    if (rule.expression) body.expression = rule.expression;
    if (rule.timezone) body.timezone = rule.timezone;
    if (rule.startTime) body.startTime = rule.startTime.toISOString();
    if (rule.endTime) body.endTime = rule.endTime.toISOString();
    if (rule.maxExecutions !== undefined) body.maxExecutions = rule.maxExecutions;

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
    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.NOT_FOUND, '定时任务不存在');
    }

    const task = (await response.json()) as CronTaskResponse;
    return new Date(task.nextExecution ?? Date.now());
  }

  /** 获取用户的所有定时任务 */
  async listTasks(userId: string): Promise<CronTaskResponse[]> {
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

    return (await response.json()) as CronTaskResponse[];
  }

  /** 获取单个定时任务详情 */
  async getTask(taskId: string): Promise<CronTaskResponse> {
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
}
