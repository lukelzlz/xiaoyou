import OpenAI from 'openai';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type {
  ClarificationQuestion,
  CronRule,
  ExecutionPlan,
  MissingParam,
  TaskDescription,
  ValidationResult,
} from '../types/index.js';

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

  /**
   * 创建执行计划
   * 自动执行计划校验，如果参数不完整，抛出可识别错误供上层处理。
   */
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

要求：
1. steps 不能为空
2. 每个 step 必须包含 stepId / action / params / requiredParams / optionalParams / timeout / retryPolicy / onFailure
3. 若某一步所需信息不足，请把参数名放到 requiredParams 中，并在 params 中留空值
4. 仅返回 JSON，不要附带解释
`;

    const result = await this.chat(prompt);
    const plan = this.parseJson<ExecutionPlan>(result, '执行计划');

    const validation = this.validateParams(plan);
    if (!validation.valid) {
      log.warn({ missingParams: validation.missingParams, planId: plan.planId }, '执行计划参数不完整');
      throw new XiaoyouError(ErrorCode.PLAN_INVALID, '执行计划缺少必要参数', {
        details: {
          planId: plan.planId,
          missingParams: validation.missingParams,
          warnings: validation.warnings,
        },
      });
    }

    return plan;
  }

  /**
   * 更新已有计划
   */
  async updatePlan(planId: string, updates: Partial<ExecutionPlan>): Promise<ExecutionPlan> {
    const prompt = `
你是一个任务规划专家。请根据已有计划 ID 和更新内容，输出更新后的完整执行计划。

计划 ID：${planId}
更新内容：${JSON.stringify(updates)}

请返回完整的 ExecutionPlan JSON，结构必须合法，且 planId 保持为 ${planId}。
仅返回 JSON。
`;

    const result = await this.chat(prompt);
    const updatedPlan = this.parseJson<ExecutionPlan>(result, '更新后的执行计划');

    if (updatedPlan.planId !== planId) {
      updatedPlan.planId = planId;
    }

    return updatedPlan;
  }

  /**
   * 校验计划是否缺失必需参数
   */
  validateParams(plan: ExecutionPlan): ValidationResult {
    const missingParams: MissingParam[] = [];
    const warnings: string[] = [];

    if (!plan.steps || plan.steps.length === 0) {
      warnings.push('执行计划没有任何步骤');
      return {
        valid: false,
        missingParams,
        warnings,
      };
    }

    for (const step of plan.steps) {
      if (!step.stepId) {
        warnings.push('存在缺少 stepId 的步骤');
      }

      if (!step.action) {
        warnings.push(`步骤 ${step.stepId || 'unknown'} 缺少 action`);
      }

      for (const requiredParam of step.requiredParams ?? []) {
        const value = step.params?.[requiredParam];
        const isMissing =
          value === undefined ||
          value === null ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && value.length === 0);

        if (isMissing) {
          missingParams.push({
            stepId: step.stepId,
            paramName: requiredParam,
            description: step.description ?? `步骤 ${step.stepId} 所需参数`,
            type: this.inferParamType(requiredParam),
            required: true,
          });
        }
      }
    }

    return {
      valid: missingParams.length === 0 && warnings.length === 0,
      missingParams,
      warnings,
    };
  }

  /**
   * 生成用户追问
   */
  async generateClarification(missingParams: MissingParam[]): Promise<ClarificationQuestion> {
    const compactParams = missingParams.map((item) => ({
      stepId: item.stepId,
      paramName: item.paramName,
      description: item.description,
      type: item.type,
    }));

    const prompt = `
你是一个任务规划助手。当前执行计划缺少一些必要参数，请为用户生成一条简洁、清晰、自然的追问。

缺失参数：${JSON.stringify(compactParams)}

请返回 JSON：
{
  "question": "为了继续执行，我需要你补充……",
  "context": "说明这些参数将用于哪些步骤",
  "suggestions": ["示例值1", "示例值2"]
}

要求：
1. 追问应尽量合并，不要一项一问
2. 使用中文
3. suggestions 最多 3 条
4. 仅返回 JSON
`;

    const result = await this.chat(prompt);
    const parsed = this.parseJson<{ question?: string; context?: string; suggestions?: string[] }>(
      result,
      '追问问题',
    );

    return {
      question: parsed.question ?? this.buildFallbackQuestion(missingParams),
      context: parsed.context ?? '补齐必要参数后才能继续生成或执行计划。',
      missingParams,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : undefined,
    };
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
    return this.parseJson<CronRule>(result, 'CRON 规则');
  }

  private parseJson<T>(raw: string, label: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch (parseError) {
      log.error({ rawResponse: raw.slice(0, 500), parseError }, `${label} JSON 解析失败`);
      throw new XiaoyouError(ErrorCode.PLAN_INVALID, `无法解析${label}`, {
        details: { rawResponse: raw.slice(0, 500) },
      });
    }
  }

  private inferParamType(paramName: string): string {
    const lower = paramName.toLowerCase();

    if (lower.includes('path') || lower.includes('file') || lower.includes('url')) {
      return 'string';
    }
    if (lower.includes('count') || lower.includes('limit') || lower.includes('number')) {
      return 'number';
    }
    if (lower.includes('date') || lower.includes('time')) {
      return 'datetime';
    }
    if (lower.includes('enable') || lower.includes('flag') || lower.startsWith('is')) {
      return 'boolean';
    }

    return 'string';
  }

  private buildFallbackQuestion(missingParams: MissingParam[]): string {
    const names = missingParams.map((item) => item.paramName).join('、');
    return `为了继续执行任务，请补充以下信息：${names}`;
  }
}
