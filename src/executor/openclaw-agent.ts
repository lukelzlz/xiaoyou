import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type {
  CronRule,
  ExecutionPlan,
  ExecutionStatus,
  PlanResult,
  ScheduleTask,
  StepResult,
} from '../types/index.js';

const log = createChildLogger('openclaw-agent');

interface OpenClawTaskResponse {
  id: string;
  status?: string;
  result?: unknown;
  error?: string;
  nextExecution?: string;
}

interface CreateCronInput {
  cronExpression: string;
  timezone: string;
  taskTemplate: Record<string, unknown>;
}

export class OpenClawAgent {
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openclaw.apiKey}`,
    };
  }

  async executeTask(plan: ExecutionPlan): Promise<PlanResult | string> {
    const response = await fetch(`${config.openclaw.apiUrl}/tasks`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        type: 'multi_step',
        plan,
      }),
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.TOOL_ERROR, 'OpenClaw 任务创建失败', {
        retryable: true,
      });
    }

    const task = (await response.json()) as OpenClawTaskResponse;
    return this.waitForCompletion(task.id, plan.planId);
  }

  async createCronTask(input: CreateCronInput): Promise<OpenClawTaskResponse> {
    const response = await fetch(`${config.openclaw.apiUrl}/crons`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        expression: input.cronExpression,
        timezone: input.timezone,
        task: input.taskTemplate,
      }),
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 创建失败');
    }

    return (await response.json()) as OpenClawTaskResponse;
  }

  async updateCronTask(taskId: string, updates: Partial<ScheduleTask>): Promise<void> {
    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 更新失败');
    }
  }

  async deleteCronTask(taskId: string): Promise<void> {
    const response = await fetch(`${config.openclaw.apiUrl}/crons/${taskId}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.SCHEDULE_CONFLICT, 'OpenClaw CRON 删除失败');
    }
  }

  async getTaskStatus(taskId: string): Promise<OpenClawTaskResponse> {
    const response = await fetch(`${config.openclaw.apiUrl}/tasks/${taskId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.NOT_FOUND, 'OpenClaw 任务不存在');
    }

    return (await response.json()) as OpenClawTaskResponse;
  }

  async pushNotification(userId: string, message: string): Promise<void> {
    const response = await fetch(`${config.openclaw.apiUrl}/notifications`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        userId,
        message,
      }),
    });

    if (!response.ok) {
      log.warn({ userId }, 'OpenClaw 推送通知失败');
    }
  }

  async createRule(rule: CronRule, taskTemplate: Record<string, unknown>): Promise<string> {
    const result = await this.createCronTask({
      cronExpression: rule.expression,
      timezone: rule.timezone,
      taskTemplate,
    });

    return result.id;
  }

  private async waitForCompletion(taskId: string, planId: string): Promise<PlanResult> {
    const start = Date.now();

    while (Date.now() - start < config.openclaw.taskTimeout) {
      const task = await this.getTaskStatus(taskId);

      if (task.status === 'completed') {
        return {
          planId,
          status: 'success',
          stepResults: [],
          totalDuration: Date.now() - start,
          artifacts: [],
        };
      }

      if (task.status === 'failed') {
        throw new XiaoyouError(ErrorCode.TOOL_ERROR, task.error || 'OpenClaw 执行失败');
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new XiaoyouError(ErrorCode.LLM_TIMEOUT, 'OpenClaw 执行超时', {
      retryable: true,
    });
  }
}
