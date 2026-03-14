import type { Intent, ParsedMessage, TaskDescription } from '../types/index.js';
import { NemotronService } from '../llm/nemotron.js';
import { OpenClawAgent } from '../executor/openclaw-agent.js';
import { SearchTool, ExtractTool, QueryTool } from '../tools/index.js';
import type { SceneHandler } from '../controller/index.js';

export class ChatService implements SceneHandler {
  async handle(_message: ParsedMessage, _intent: Intent): Promise<string> {
    return '我在这里。';
  }
}

export class ToolService implements SceneHandler {
  private searchTool = new SearchTool();
  private extractTool = new ExtractTool();
  private queryTool = new QueryTool();

  async handle(message: ParsedMessage, intent: Intent): Promise<string> {
    switch (intent.type) {
      case 'tool.search': {
        const result = await this.searchTool.execute({ query: message.textContent });
        return result;
      }
      case 'tool.extract': {
        const result = await this.extractTool.execute({ content: message.textContent });
        return result;
      }
      case 'tool.query': {
        const result = await this.queryTool.execute({ query: message.textContent });
        return result;
      }
      default:
        return '暂不支持该工具请求。';
    }
  }
}

export class TaskService implements SceneHandler {
  constructor(
    private planner: NemotronService,
    private executor: OpenClawAgent,
  ) {}

  async handle(message: ParsedMessage, _intent: Intent): Promise<string> {
    const task: TaskDescription = {
      description: message.textContent,
      type: 'general',
      availableTools: ['search', 'extract', 'query'],
    };

    const plan = await this.planner.createPlan(task);
    const result = await this.executor.executeTask(plan);

    if (typeof result === 'string') {
      return result;
    }

    return `任务已完成：${JSON.stringify(result)}`;
  }
}

export class ScheduleService implements SceneHandler {
  constructor(
    private planner: NemotronService,
    private executor: OpenClawAgent,
  ) {}

  async handle(message: ParsedMessage, _intent: Intent): Promise<string> {
    const rule = await this.planner.generateCronRule(message.textContent);
    const taskId = await this.executor.createCronTask({
      cronExpression: rule.expression,
      timezone: rule.timezone,
      taskTemplate: {
        description: message.textContent,
      },
    });

    return `定时任务已创建，ID: ${taskId.id ?? 'unknown'}，规则: ${rule.description}`;
  }
}
