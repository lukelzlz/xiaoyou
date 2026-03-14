import { createChildLogger } from '../utils/logger.js';
import type { Intent, ParsedMessage, TaskDescription } from '../types/index.js';
import { IntentType } from '../types/index.js';
import { GLMService } from '../llm/glm.js';
import { NemotronService } from '../llm/nemotron.js';
import { HotMemoryStore } from '../memory/hot.js';
import { VectorMemoryStore } from '../memory/vector.js';
import { MemoryFlush } from '../memory/flush.js';
import { OpenClawAgent } from '../executor/openclaw-agent.js';
import { OpenClawCron } from '../executor/openclaw-cron.js';
import { SearchTool, ExtractTool, QueryTool } from '../tools/index.js';
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

  async handle(message: ParsedMessage, intent: Intent): Promise<string> {
    // 使用 channelId:userId 组合键，避免群聊中不同用户数据混淆
    const sessionKey = `${message.channelId}:${message.userId}`;
    const hotMemory = await this.memory.get(sessionKey);
    const history = hotMemory?.conversationHistory.slice(-10) ?? [];

    // 尝试从向量数据库检索相关长期记忆
    let longTermContext = '';
    try {
      const retrieved = await this.vectorMemory.retrieve(message.textContent, {
        userId: message.userId,
        topK: 3,
        threshold: 0.75,
      });
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
  private searchTool = new SearchTool();
  private extractTool = new ExtractTool();
  private queryTool = new QueryTool();

  async handle(message: ParsedMessage, intent: Intent): Promise<string> {
    log.info({ intent: intent.type, userId: message.userId }, '工具调用');

    switch (intent.type) {
      case IntentType.TOOL_SEARCH: {
        const result = await this.searchTool.execute({ query: message.textContent });
        return result;
      }
      case IntentType.TOOL_EXTRACT: {
        const result = await this.extractTool.execute({ content: message.textContent });
        return result;
      }
      case IntentType.TOOL_QUERY: {
        const result = await this.queryTool.execute({ query: message.textContent });
        return result;
      }
      default:
        return '暂不支持该工具请求。';
    }
  }
}

// ============ 场景 C：任务服务 ============

export class TaskService implements SceneHandler {
  constructor(
    private planner: NemotronService,
    private executor: OpenClawAgent,
    private memoryFlush: MemoryFlush,
  ) {}

  async handle(message: ParsedMessage, _intent: Intent): Promise<string> {
    log.info({ userId: message.userId }, '开始处理复杂任务');

    const task: TaskDescription = {
      description: message.textContent,
      type: 'general',
      availableTools: ['search', 'extract', 'query'],
    };

    // 1. 规划
    const plan = await this.planner.createPlan(task);
    log.info({ planId: plan.planId, steps: plan.steps.length }, '任务规划完成');

    // 2. 执行
    const result = await this.executor.executeTask(plan);

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
      return result;
    }

    return `任务已完成（计划ID: ${result.planId}）\n` +
      `状态: ${result.status}\n` +
      `耗时: ${Math.round(result.totalDuration / 1000)}秒\n` +
      `步骤: ${result.stepResults.length} 步`;
  }
}

// ============ 场景 D：定时任务服务 ============

export class ScheduleService implements SceneHandler {
  constructor(
    private planner: NemotronService,
    private executor: OpenClawAgent,
    private cron: OpenClawCron,
  ) {}

  async handle(message: ParsedMessage, intent: Intent): Promise<string> {
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

    // 2. 通过 OpenClaw CRON 注册定时任务
    const taskId = await this.cron.register(rule, {
      type: 'scheduled_task',
      params: {
        description: message.textContent,
        userId: message.userId,
        channelId: message.channelId,
      },
    });

    return [
      '✅ 定时任务已创建',
      `📋 任务ID: ${taskId}`,
      `⏰ 规则: ${rule.description}`,
      `🔄 CRON: ${rule.expression}`,
      `🌏 时区: ${rule.timezone}`,
    ].join('\n');
  }

  private async modifySchedule(message: ParsedMessage): Promise<string> {
    // 从消息中提取任务 ID（简单实现）
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
      return '请提供要取消的定时任务 ID，例如：取消任务 task_abc123';
    }

    const taskId = idMatch[1];

    try {
      await this.cron.cancel(taskId);
      return `✅ 定时任务 ${taskId} 已取消`;
    } catch (error) {
      log.warn({ error, taskId }, '取消定时任务失败');
      if (error instanceof XiaoyouError && error.code === ErrorCode.NOT_FOUND) {
        return `❌ 未找到定时任务 ${taskId}，请确认任务 ID 是否正确。`;
      }
      return `❌ 取消定时任务 ${taskId} 失败，请稍后重试。`;
    }
  }

  private async querySchedule(message: ParsedMessage): Promise<string> {
    const tasks = await this.cron.listTasks(message.userId);

    if (tasks.length === 0) {
      return '当前没有活跃的定时任务。';
    }

    const lines = [
      `📋 您的定时任务列表（共 ${tasks.length} 个）：`,
      '',
      ...tasks.map((t, i) => {
        const next = t.nextExecution ? new Date(t.nextExecution).toLocaleString('zh-CN') : '未知';
        return `${i + 1}. ID: ${t.id} | 状态: ${t.status} | 下次执行: ${next}`;
      }),
    ];

    return lines.join('\n');
  }
}
