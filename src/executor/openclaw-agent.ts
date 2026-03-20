import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import {
  getOpenClawRpcClient,
  type SessionInfo,
  type TaskOptions,
} from './openclaw-rpc.js';
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

interface CreateCronInput {
  cronExpression: string;
  timezone: string;
  taskTemplate: Record<string, unknown>;
}

/**
 * OpenClaw Agent 执行器
 *
 * 通过 WebSocket RPC 与 OpenClaw Gateway 通信
 * 支持多 session 隔离和任务监控
 */
export class OpenClawAgent {
  private rpc = getOpenClawRpcClient();

  /**
   * 执行任务计划
   */
  async executeTask(plan: ExecutionPlan, session?: SessionInfo): Promise<PlanResult | string> {
    log.info({ planId: plan.planId, steps: plan.steps.length }, '开始执行任务');

    try {
      // 确保 RPC 连接
      await this.rpc.connect();

      // 构建步骤
      const steps = plan.steps.map(step => ({
        action: step.action,
        params: step.params,
      }));

      // 创建任务
      const { taskId } = await this.rpc.executePlan(plan.planId, steps, { session });

      // 等待完成
      return this.waitForCompletion(taskId, plan, session);
    } catch (error) {
      log.error({ error, planId: plan.planId }, '任务执行失败');
      throw error;
    }
  }

  /**
   * 执行完整计划
   */
  async executePlan(plan: ExecutionPlan, session?: SessionInfo): Promise<PlanResult> {
    const result = await this.executeTask(plan, session);
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

  /**
   * 创建定时任务
   */
  async createCronTask(
    input: CreateCronInput,
    session?: SessionInfo,
  ): Promise<{ id: string }> {
    log.info({ expression: input.cronExpression }, '创建定时任务');

    await this.rpc.connect();

    const result = await this.rpc.createCronTask(
      input.cronExpression,
      input.taskTemplate as { type: string; params: Record<string, unknown> },
      {
        timezone: input.timezone,
        session,
      },
    );

    return { id: result.taskId };
  }

  /**
   * 更新定时任务
   */
  async updateCronTask(taskId: string, updates: Partial<ScheduleTask>): Promise<void> {
    await this.rpc.connect();

    if (updates.rule?.expression) {
      await this.rpc.updateCronTask(taskId, {
        expression: updates.rule.expression,
        enabled: updates.status === 'active',
      });
    }
  }

  /**
   * 删除定时任务
   */
  async deleteCronTask(taskId: string): Promise<void> {
    await this.rpc.connect();
    await this.rpc.deleteCronTask(taskId);
  }

  /**
   * 获取任务状态
   */
  async getTaskStatus(taskId: string): Promise<{
    id: string;
    status?: string;
    result?: unknown;
    error?: string;
    currentStep?: string;
    completedSteps?: string[];
    failedSteps?: string[];
    waitingForUser?: boolean;
  }> {
    await this.rpc.connect();

    const status = await this.rpc.getTaskStatus(taskId);

    return {
      id: taskId,
      status: status.status,
      result: status.result,
      error: status.error,
      currentStep: status.currentStep,
      completedSteps: status.completedSteps,
      failedSteps: status.failedSteps,
      waitingForUser: status.waitingForUser,
    };
  }

  /**
   * 推送通知给用户
   */
  async pushNotification(userId: string, message: string): Promise<void> {
    try {
      await this.rpc.connect();

      // 构建临时的 session 信息
      const session: SessionInfo = {
        sessionId: `notify:${userId}`,
        userId,
        channelId: userId,
        platform: 'discord', // 默认使用 discord
      };

      await this.rpc.sendNotification(session, message);
    } catch (error) {
      log.warn({ error, userId }, '推送通知失败');
    }
  }

  /**
   * 创建 CRON 规则
   */
  async createRule(
    rule: CronRule,
    taskTemplate: Record<string, unknown>,
    session?: SessionInfo,
  ): Promise<string> {
    const result = await this.createCronTask({
      cronExpression: rule.expression,
      timezone: rule.timezone,
      taskTemplate,
    }, session);

    return result.id;
  }

  /**
   * 暂停任务
   */
  async pause(planId: string): Promise<void> {
    log.info({ planId }, '暂停任务');
    await this.rpc.connect();
    await this.rpc.controlTask(planId, 'pause');
  }

  /**
   * 恢复任务
   */
  async resume(planId: string): Promise<void> {
    log.info({ planId }, '恢复任务');
    await this.rpc.connect();
    await this.rpc.controlTask(planId, 'resume');
  }

  /**
   * 取消任务
   */
  async cancel(planId: string): Promise<void> {
    log.info({ planId }, '取消任务');
    await this.rpc.connect();
    await this.rpc.controlTask(planId, 'cancel');
  }

  /**
   * 重试任务
   */
  async retry(planId: string): Promise<void> {
    log.info({ planId }, '重试任务');
    await this.rpc.connect();
    await this.rpc.controlTask(planId, 'retry');
  }

  /**
   * 获取执行状态
   */
  async getStatus(planId: string): Promise<ExecutionStatus> {
    await this.rpc.connect();

    const task = await this.rpc.getTaskStatus(planId);

    return {
      status: this.mapStatus(task.status),
      currentStep: task.currentStep,
      completedSteps: task.completedSteps ?? [],
      failedSteps: task.failedSteps ?? [],
      waitingForUser: task.waitingForUser ?? false,
      updatedAt: new Date(),
      error: task.error ? new Error(task.error) : undefined,
    };
  }

  /**
   * 统一控制接口
   */
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

  /**
   * 获取运行中的任务数量
   */
  getRunningTaskCount(): number {
    return this.rpc.getRunningTaskCount();
  }

  /**
   * 获取用户的运行中任务
   */
  getUserTasks(userId: string): Array<{
    taskId: string;
    planId: string;
    status: string;
    startTime: number;
  }> {
    return this.rpc.getUserTasks(userId).map(t => ({
      taskId: t.taskId,
      planId: t.planId,
      status: t.status,
      startTime: t.startTime,
    }));
  }

  /**
   * 等待任务完成
   */
  private async waitForCompletion(
    taskId: string,
    plan: ExecutionPlan,
    session?: SessionInfo,
  ): Promise<PlanResult> {
    const start = Date.now();
    const timeout = 300000; // 5 分钟超时

    while (Date.now() - start < timeout) {
      const task = await this.rpc.getTaskStatus(taskId);
      const mappedStatus = this.mapStatus(task.status);

      if (mappedStatus === 'completed') {
        return {
          planId: plan.planId,
          status: 'success',
          stepResults: this.buildStepResults(plan, task),
          totalDuration: Date.now() - start,
          artifacts: task.result ? [{ type: 'text', name: 'result', content: String(task.result) }] : [],
        };
      }

      if (mappedStatus === 'waiting_user') {
        return {
          planId: plan.planId,
          status: 'partial',
          stepResults: this.buildStepResults(plan, task),
          totalDuration: Date.now() - start,
          artifacts: [],
        };
      }

      if (mappedStatus === 'failed') {
        throw new XiaoyouError(ErrorCode.TOOL_ERROR, task.error || '任务执行失败');
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
          artifacts: [],
        };
      }

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    throw new XiaoyouError(ErrorCode.LLM_TIMEOUT, '任务执行超时', { retryable: true });
  }

  /**
   * 构建步骤结果
   */
  private buildStepResults(
    plan: ExecutionPlan,
    task: { completedSteps?: string[]; failedSteps?: string[]; result?: unknown },
  ): StepResult[] {
    const completedSteps = new Set(task.completedSteps ?? []);
    const failedSteps = new Set(task.failedSteps ?? []);

    return plan.steps.map(step => {
      if (completedSteps.has(step.stepId)) {
        return {
          stepId: step.stepId,
          status: 'success' as const,
          duration: 0,
        };
      }

      if (failedSteps.has(step.stepId)) {
        return {
          stepId: step.stepId,
          status: 'failed' as const,
          error: task.result ? new Error(String(task.result)) : undefined,
          duration: 0,
        };
      }

      return {
        stepId: step.stepId,
        status: 'skipped' as const,
        duration: 0,
      };
    });
  }

  /**
   * 映射状态
   */
  private mapStatus(status?: string): ExecutionStatus['status'] {
    switch (status) {
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
      case 'waiting_user':
        return 'waiting_user';
      default:
        return 'pending';
    }
  }
}

// 重新导出 SessionInfo 类型
export type { SessionInfo };
