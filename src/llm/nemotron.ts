import OpenAI from 'openai';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type { ExecutionPlan, TaskDescription, CronRule } from '../types/index.js';

const log = createChildLogger('nemotron');

export class NemotronService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.nemotron.apiKey,
      baseURL: config.nemotron.apiUrl,
    });
  }

  async chat(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: config.nemotron.model,
        max_tokens: config.nemotron.maxTokens,
        messages: [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          { role: 'user' as const, content: prompt },
        ],
      });

      return response.choices[0]?.message?.content ?? '';
    } catch (error) {
      log.error({ error }, 'Nemotron 调用失败');
      throw new XiaoyouError(ErrorCode.LLM_ERROR, 'Nemotron 调用失败', {
        cause: error instanceof Error ? error : new Error(String(error)),
        retryable: true,
      });
    }
  }

  async createPlan(task: TaskDescription): Promise<ExecutionPlan> {
    const prompt = `
你是一个任务规划专家。请将以下任务分解为可执行的步骤。

任务描述：${task.description}
任务类型：${task.type}
可用工具：${JSON.stringify(task.availableTools ?? [])}
约束条件：${JSON.stringify(task.constraints ?? {})}

请以 JSON 格式返回执行计划：
{
  "planId": "唯一ID",
  "description": "任务描述",
  "estimatedDuration": 30000,
  "requiredResources": [],
  "steps": [
    {
      "stepId": "step_1",
      "action": "动作名称",
      "description": "步骤描述",
      "params": {},
      "requiredParams": [],
      "optionalParams": [],
      "timeout": 30000,
      "retryPolicy": {"maxRetries":3,"retryInterval":1000,"backoffMultiplier":2,"maxInterval":30000,"retryableErrors":["TIMEOUT"]},
      "onFailure": "abort"
    }
  ],
  "dependencies": {"nodes":["step_1"],"edges":[]}
}

请仅返回 JSON。
`;

    const result = await this.chat(prompt);

    try {
      return JSON.parse(result) as ExecutionPlan;
    } catch (parseError) {
      log.error({ rawResponse: result.slice(0, 500), parseError }, '执行计划 JSON 解析失败');
      throw new XiaoyouError(ErrorCode.PLAN_INVALID, '无法解析执行计划', {
        details: { rawResponse: result.slice(0, 500) },
      });
    }
  }

  async generateCronRule(naturalLanguage: string, timezone?: string): Promise<CronRule> {
    const prompt = `
将以下自然语言描述转换为 CRON 表达式。

描述：${naturalLanguage}
时区：${timezone ?? 'Asia/Shanghai'}

请以 JSON 格式返回：
{
  "expression": "0 9 * * *",
  "description": "每天早上9点",
  "timezone": "Asia/Shanghai"
}

请仅返回 JSON。
`;

    const result = await this.chat(prompt);

    try {
      return JSON.parse(result) as CronRule;
    } catch (parseError) {
      log.error({ rawResponse: result.slice(0, 500), parseError }, 'CRON 规则 JSON 解析失败');
      throw new XiaoyouError(ErrorCode.PLAN_INVALID, '无法解析 CRON 规则', {
        details: { rawResponse: result.slice(0, 500) },
      });
    }
  }
}
