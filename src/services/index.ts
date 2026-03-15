import { createChildLogger } from '../utils/logger.js';
import type { EnhancedIntent, ParsedMessage, TaskDescription } from '../types/index.js';
import { IntentType } from '../types/index.js';
import { GLMService } from '../llm/glm.js';
import { NemotronService } from '../llm/nemotron.js';
import { HotMemoryStore } from '../memory/hot.js';
import { VectorMemoryStore } from '../memory/vector.js';
import { MemoryFlush } from '../memory/flush.js';
import { OpenClawAgent } from '../executor/openclaw-agent.js';
import { OpenClawCron } from '../executor/openclaw-cron.js';
import { invokeTool } from '../tools/index.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type { SceneHandler } from '../controller/index.js';

const log = createChildLogger('services');

// ============ 场景 A：聊天服务 ============

export class ChatService implements SceneHandler {
  constructor(
    private glm: GLMService,
    private memory: HotMemoryStore,
    private vectorMemory: VectorMemoryStore,
    private memoryFlush: MemoryFlush,
  ) {}

  async handle(message: ParsedMessage, intent: EnhancedIntent): Promise<string> {
    // 使用 channelId:userId 组合键，避免群聊中不同用户数据混淆
    const sessionKey = `${message.channelId}:${message.userId}`;
    const hotMemory = await this.memory.get(sessionKey);
    const history = hotMemory?.conversationHistory.slice(-10) ?? [];

    // 尝试从向量数据库检索相关长期记忆
    let longTermContext = '';
    try {
      const retrieved = await this.vectorMemory.retrieve(message.textContent, {
        method: 'similarity',
        topK: 3,
        threshold: 0.75,
      }, message.userId);
      if (retrieved.length > 0) {
        longTermContext = `\n\n相关历史记忆：\n${retrieved.map((r) => r.content).join('\n---\n')}`;
      }
    } catch {
      // 向量检索失败不影响主流程
      log.debug('长期记忆检索失败，降级处理');
    }

    const context = history.map((t) => `${t.role}: ${t.content}`).join('\n');

    const systemPrompt = `你是小悠，一个友好、智能的 AI 助手。你具有以下特点：
- 说话风格亲切自然，像朋友一样陪伴用户
- 能够识别用户的情感状态并给予适当回应
- 回答简洁但有温度
- 必要时会追问以更好地理解用户需求`;

    const prompt = `${context ? `历史对话：\n${context}\n` : ''}${longTermContext}\n\n用户（意图: ${intent.type}）：${message.textContent}\n\n请回复：`;

    const reply = await this.glm.chat(prompt, systemPrompt);

    // 跟踪会话，供 MemoryFlush 定期归档
    this.memoryFlush.track(sessionKey);

    return reply;
  }
}

// ============ 场景 B：工具服务 ============

export class ToolService implements SceneHandler {
  async handle(message: ParsedMessage, intent: EnhancedIntent): Promise<string> {
    log.info({ intent: intent.type, userId: message.userId }, '工具调用');

    try {
      switch (intent.type) {
        case IntentType.TOOL_SEARCH:
          return await invokeTool('search', { query: message.textContent });
        
        case IntentType.TOOL_EXTRACT:
          return await invokeTool('extract', { content: message.textContent });
          
        case IntentType.TOOL_QUERY:
          return await invokeTool('query', { query: message.textContent });
          
        default:
          return '暂不支持该工具请求。';
      }
    } catch (error) {
      log.error({ error, intent: intent.type }, '工具调用失败');
      return `❌ 工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }
  }
}

// ============ 场景 C：任务服务 ============

import { pluginManager } from '../plugins/index.js';

import { metricsService } from '../monitoring/metrics.js';

export class TaskService implements SceneHandler {
  constructor(
    private planner: NemotronService,
    private executor: OpenClawAgent,
    private memoryFlush: MemoryFlush,
  ) {}

  async handle(message: ParsedMessage, _intent: EnhancedIntent): Promise<string> {
    log.info({ userId: message.userId }, '开始处理复杂任务');

    const finalDescription = await pluginManager.executeTaskPreprocess(message.textContent, message);

    const task: TaskDescription = {
      description: finalDescription,
      type: 'general',
      availableTools: ['search', 'extract', 'query'],
    };

    // 1. 规划
    const plan = await this.planner.createPlan(task);
    log.info({ planId: plan.planId, steps: plan.steps.length }, '任务规划完成');

    // 2. 执行
    const rawResult = await this.executor.executeTask(plan);
    const result = await pluginManager.executeTaskPostprocess(rawResult, message);

    // 3. 归档任务结果
    try {
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      await this.memoryFlush.archiveTask(
        message.userId,
        message.textContent,
        resultStr,
        plan.planId,
      );
    } catch (archiveError) {
      log.warn({ archiveError }, '任务归档失败');
    }

    if (typeof result === 'string') {
      metricsService.recordTask(true);
      return result;
    }

    const typedResult = result as any; // Allow for plugin modifications but fallback to standard PlanResult
    metricsService.recordTask(typedResult.status === 'success' || typedResult.status === 'partial');
    return `任务已完成（计划ID: ${typedResult.planId || plan.planId}）\n` +
      `状态: ${typedResult.status || 'unknown'}\n` +
      `耗时: ${Math.round((typedResult.totalDuration || 0) / 1000)}秒\n` +
      `步骤: ${typedResult.stepResults?.length || 0} 步`;
  }
}

// ============ 场景 D：定时任务服务 ============

export class ScheduleService implements SceneHandler {
  constructor(
    private planner: NemotronService,
    private executor: OpenClawAgent,
    private cron: OpenClawCron,
  ) {}

  async handle(message: ParsedMessage, intent: EnhancedIntent): Promise<string> {
    log.info({ intent: intent.type, userId: message.userId }, '处理定时任务请求');

    switch (intent.type) {
      case IntentType.SCHEDULE_CREATE:
        return this.createSchedule(message);

      case IntentType.SCHEDULE_MODIFY:
        return this.modifySchedule(message);

      case IntentType.SCHEDULE_CANCEL:
        return this.cancelSchedule(message);

      case IntentType.SCHEDULE_QUERY:
        return this.querySchedule(message);

      default:
        return this.createSchedule(message);
    }
  }

  private async createSchedule(message: ParsedMessage): Promise<string> {
    // 1. 使用 Nemotron 将自然语言转换为 CRON 规则
    const rule = await this.planner.generateCronRule(message.textContent);

    // 2. 规划任务执行步骤（复杂任务才附带执行计划）
    const isComplex = message.textContent.includes('执行') || message.textContent.includes('步');
    const plan = isComplex
      ? await this.planner.createPlan({
          description: message.textContent,
          type: 'scheduled_automation',
        })
      : undefined;

    // 3. 通过 OpenClaw CRON 注册定时任务
    const taskId = await this.cron.register(
      rule,
      {
        type: 'scheduled_task',
        params: {
          description: message.textContent,
          userId: message.userId,
          channelId: message.channelId,
        },
        ...(plan ? { plan } : {}),
      },
      {
        name: `UserTask_${message.userId.slice(0, 5)}_${Date.now()}`,
        description: message.textContent,
        notifyOnFailure: true,
        notifyOnComplete: true, // 增强：支持任务完成时通知
      }
    );

    return [
      '✅ 定时任务已创建',
      `📋 任务ID: ${taskId}`,
      `⏰ 规则: ${rule.description}`,
      `🔄 CRON: ${rule.expression}`,
      `🌏 时区: ${rule.timezone}`,
      isComplex ? '✨ 已生成复杂执行计划' : '',
    ].filter(Boolean).join('\n');
  }

  private async modifySchedule(message: ParsedMessage): Promise<string> {
    const idMatch = message.textContent.match(/(?:任务|ID|id)[:\s]*([a-zA-Z0-9_-]+)/);
    if (!idMatch) {
      return '请提供要修改的定时任务 ID，例如：修改任务 task_abc123 的时间为每天上午10点';
    }

    const taskId = idMatch[1];

    try {
      const rule = await this.planner.generateCronRule(message.textContent);
      await this.cron.update(taskId, rule);

      return [
        '✅ 定时任务已更新',
        `📋 任务ID: ${taskId}`,
        `⏰ 新规则: ${rule.description}`,
        `🔄 CRON: ${rule.expression}`,
      ].join('\n');
    } catch (error) {
      log.warn({ error, taskId }, '修改定时任务失败');
      if (error instanceof XiaoyouError && error.code === ErrorCode.NOT_FOUND) {
        return `❌ 未找到定时任务 ${taskId}，请确认任务 ID 是否正确。`;
      }
      return `❌ 修改定时任务 ${taskId} 失败，请稍后重试。`;
    }
  }

  private async cancelSchedule(message: ParsedMessage): Promise<string> {
    const idMatch = message.textContent.match(/(?:任务|ID|id)[:\s]*([a-zA-Z0-9_-]+)/);
    if (!idMatch) {
      return '请提供要取消或暂停的定时任务 ID，例如：取消任务 task_abc123';
    }

    const taskId = idMatch[1];
    const isPause = message.textContent.includes('暂停');

    try {
      if (isPause) {
        await this.cron.pause(taskId);
        return `✅ 定时任务 ${taskId} 已暂停`;
      } else {
        await this.cron.cancel(taskId);
        return `✅ 定时任务 ${taskId} 已取消`;
      }
    } catch (error) {
      log.warn({ error, taskId }, '操作定时任务失败');
      if (error instanceof XiaoyouError && error.code === ErrorCode.NOT_FOUND) {
        return `❌ 未找到定时任务 ${taskId}，请确认任务 ID 是否正确。`;
      }
      return `❌ 操作定时任务 ${taskId} 失败，请稍后重试。`;
    }
  }

  private async querySchedule(message: ParsedMessage): Promise<string> {
    const tasks = await this.cron.listTasks(message.userId);

    if (tasks.length === 0) {
      return '当前没有您的定时任务记录。';
    }

    const lines = [
      `📋 您的定时任务列表（共 ${tasks.length} 个）：`,
      '',
      ...tasks.map((t, i) => {
        const next = t.nextExecution ? t.nextExecution.toLocaleString('zh-CN') : '无';
        const name = t.name || t.id;
        const statusMap: Record<string, string> = {
          active: '运行中 🟢',
          paused: '已暂停 🟡',
          expired: '已过期 ⚪',
          cancelled: '已取消 🔴'
        };
        const statusStr = statusMap[t.status] || t.status;
        
        return `${i + 1}. [${name}] | 状态: ${statusStr} | 下次执行: ${next}\n   规则: ${t.rule.description}`;
      }),
    ];

    return lines.join('\n');
  }
}
