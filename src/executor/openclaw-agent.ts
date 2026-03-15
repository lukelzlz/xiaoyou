import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type {
  ControlAction,
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
  currentStep?: string;
  completedSteps?: string[];
  failedSteps?: string[];
  waitingForUser?: boolean;
  stepResults?: Array<{
    stepId: string;
    status: 'success' | 'failed' | 'skipped';
    output?: unknown;
    error?: string;
    duration?: number;
  }>;
  artifacts?: Array<{
    type: string;
    name: string;
    content: string;
    url?: string;
  }>;
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
        details: { status: response.status },
      });
    }

    const task = (await response.json()) as OpenClawTaskResponse;
    return this.waitForCompletion(task.id, plan);
  }

  async executePlan(plan: ExecutionPlan): Promise<PlanResult> {
    const result = await this.executeTask(plan);
    if (typeof result === 'string') {
      return {
        planId: plan.planId,
        status: 'success',
        stepResults: [],
        totalDuration: 0,
        artifacts: [{ type: 'text', name: 'result', content: result }],
      };
    }
    return result;
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

  private async waitForCompletion(taskId: string, plan: ExecutionPlan): Promise<PlanResult> {
    const start = Date.now();
    let pollCount = 0;

    while (Date.now() - start < config.openclaw.taskTimeout) {
      const task = await this.getTaskStatus(taskId);
      const mappedStatus = this.mapExecutionStatus(task);

      if (mappedStatus === 'completed') {
        return {
          planId: plan.planId,
          status: 'success',
          stepResults: this.buildStepResults(plan, task),
          totalDuration: Date.now() - start,
          artifacts: task.artifacts ?? [],
        };
      }

      if (mappedStatus === 'waiting_user') {
        return {
          planId: plan.planId,
          status: 'partial',
          stepResults: this.buildStepResults(plan, task),
          totalDuration: Date.now() - start,
          artifacts: task.artifacts ?? [],
        };
      }

      if (mappedStatus === 'failed') {
        throw new XiaoyouError(ErrorCode.TOOL_ERROR, task.error || 'OpenClaw 执行失败');
      }

      if (mappedStatus === 'cancelled') {
        throw new XiaoyouError(ErrorCode.TASK_CANCELLED, '任务已取消');
      }

      if (mappedStatus === 'paused') {
        return {
          planId: plan.planId,
          status: 'partial',
          stepResults: this.buildStepResults(plan, task),
          totalDuration: Date.now() - start,
          artifacts: task.artifacts ?? [],
        };
      }

      await new Promise((resolve) => setTimeout(resolve, this.getPollingInterval(plan, pollCount)));
      pollCount += 1;
    }

    throw new XiaoyouError(ErrorCode.LLM_TIMEOUT, 'OpenClaw 执行超时', {
      retryable: true,
    });
  }

  private buildStepResults(plan: ExecutionPlan, task: OpenClawTaskResponse): StepResult[] {
    const provided = new Map((task.stepResults ?? []).map((item) => [item.stepId, item]));

    return plan.steps.map((step) => {
      const remote = provided.get(step.stepId);
      if (remote) {
        return {
          stepId: step.stepId,
          status: remote.status,
          output: remote.output,
          error: remote.error ? new Error(remote.error) : undefined,
          duration: remote.duration ?? 0,
        };
      }

      if ((task.completedSteps ?? []).includes(step.stepId)) {
        return {
          stepId: step.stepId,
          status: 'success',
          duration: 0,
        };
      }

      if ((task.failedSteps ?? []).includes(step.stepId)) {
        return {
          stepId: step.stepId,
          status: 'failed',
          error: task.error ? new Error(task.error) : undefined,
          duration: 0,
        };
      }

      return {
        stepId: step.stepId,
        status: 'skipped',
        duration: 0,
      };
    });
  }

  private getPollingInterval(plan: ExecutionPlan, attempt = 0): number {
    const firstStep = plan.steps[0];
    const retryPolicy = firstStep?.retryPolicy;
    if (!retryPolicy) {
      return 1500;
    }

    const base = Math.max(retryPolicy.retryInterval, 1000);
    const multiplier = retryPolicy.backoffMultiplier > 0 ? retryPolicy.backoffMultiplier : 1;
    const interval = Math.round(base * Math.pow(multiplier, attempt));

    return Math.min(interval, retryPolicy.maxInterval || 5000);
  }

  private mapExecutionStatus(task: OpenClawTaskResponse): ExecutionStatus['status'] {
    if (task.waitingForUser || task.status === 'waiting_user') {
      return 'waiting_user';
    }

    switch (task.status) {
      case 'pending':
        return 'pending';
      case 'running':
      case 'retrying':
        return 'running';
      case 'paused':
        return 'paused';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  private resolveControlEndpoint(taskId: string, action: ControlAction): string {
    switch (action) {
      case 'pause':
        return `${config.openclaw.apiUrl}/tasks/${taskId}/pause`;
      case 'resume':
        return `${config.openclaw.apiUrl}/tasks/${taskId}/resume`;
      case 'retry':
        return `${config.openclaw.apiUrl}/tasks/${taskId}/retry`;
      case 'cancel':
        return `${config.openclaw.apiUrl}/tasks/${taskId}`;
      default:
        return `${config.openclaw.apiUrl}/tasks/${taskId}`;
    }
  }

  // ============ 执行控制方法 ============

  async pause(planId: string): Promise<void> {
    log.info({ planId }, '暂停执行计划');
    const response = await fetch(this.resolveControlEndpoint(planId, 'pause'), {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '暂停任务失败', {
        details: { planId, status: response.status },
      });
    }
  }

  async resume(planId: string): Promise<void> {
    log.info({ planId }, '恢复执行计划');
    const response = await fetch(this.resolveControlEndpoint(planId, 'resume'), {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '恢复任务失败', {
        details: { planId, status: response.status },
      });
    }
  }

  async cancel(planId: string): Promise<void> {
    log.info({ planId }, '取消执行计划');
    const response = await fetch(this.resolveControlEndpoint(planId, 'cancel'), {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '取消任务失败', {
        details: { planId, status: response.status },
      });
    }
  }

  async retry(planId: string): Promise<void> {
    log.info({ planId }, '重试执行计划');
    const response = await fetch(this.resolveControlEndpoint(planId, 'retry'), {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.INTERNAL, '重试任务失败', {
        details: { planId, status: response.status },
      });
    }
  }

  async getStatus(planId: string): Promise<ExecutionStatus> {
    const response = await fetch(`${config.openclaw.apiUrl}/tasks/${planId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new XiaoyouError(ErrorCode.NOT_FOUND, '任务不存在', {
        details: { planId },
      });
    }

    const task = (await response.json()) as OpenClawTaskResponse;
    return {
      status: this.mapExecutionStatus(task),
      currentStep: task.currentStep,
      completedSteps: task.completedSteps ?? [],
      failedSteps: task.failedSteps ?? [],
      waitingForUser: task.waitingForUser ?? false,
      updatedAt: new Date(),
      stepResults: task.stepResults?.map((item) => ({
        stepId: item.stepId,
        status: item.status,
        output: item.output,
        error: item.error ? new Error(item.error) : undefined,
        duration: item.duration ?? 0,
      })),
      error: task.error ? new Error(task.error) : undefined,
    };
  }

  async control(planId: string, action: ControlAction): Promise<void> {
    switch (action) {
      case 'pause':
        return this.pause(planId);
      case 'resume':
        return this.resume(planId);
      case 'cancel':
        return this.cancel(planId);
      case 'retry':
        return this.retry(planId);
      default:
        throw new XiaoyouError(ErrorCode.INVALID_INPUT, `不支持的控制动作: ${action}`);
    }
  }
}
