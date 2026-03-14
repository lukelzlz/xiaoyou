import OpenAI from 'openai';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import type { Intent, ParsedMessage } from '../types/index.js';
import { IntentType } from '../types/index.js';

const log = createChildLogger('glm');

export class GLMService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.glm.apiKey,
      baseURL: config.glm.apiUrl,
    });
  }

  async chat(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: config.glm.model,
        temperature: config.glm.temperature,
        max_tokens: config.glm.maxTokens,
        messages: [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          { role: 'user' as const, content: prompt },
        ],
      });

      return response.choices[0]?.message?.content ?? '';
    } catch (error) {
      log.error({ error }, 'GLM chat 调用失败');
      throw new XiaoyouError(ErrorCode.LLM_ERROR, 'GLM 调用失败', {
        cause: error instanceof Error ? error : new Error(String(error)),
        retryable: true,
      });
    }
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: config.glm.embeddingModel,
        input: text,
      });
      return response.data[0]?.embedding ?? [];
    } catch (error) {
      log.error({ error }, 'GLM embedding 调用失败');
      throw new XiaoyouError(ErrorCode.LLM_ERROR, '向量化失败', {
        cause: error instanceof Error ? error : new Error(String(error)),
        retryable: true,
      });
    }
  }

  async recognizeIntent(message: ParsedMessage, context?: string): Promise<Intent> {
    const prompt = `
你是一个意图识别系统。请分析以下用户消息并返回 JSON。

用户消息：${message.textContent}
上下文：${context ?? '无'}

可选意图：
- ${IntentType.CHAT_CASUAL}
- ${IntentType.CHAT_EMOTIONAL}
- ${IntentType.CHAT_QUESTION}
- ${IntentType.TOOL_SEARCH}
- ${IntentType.TOOL_EXTRACT}
- ${IntentType.TOOL_QUERY}
- ${IntentType.TASK_CODE}
- ${IntentType.TASK_AUTOMATION}
- ${IntentType.TASK_ANALYSIS}
- ${IntentType.SCHEDULE_CREATE}
- ${IntentType.SCHEDULE_MODIFY}
- ${IntentType.SCHEDULE_CANCEL}
- ${IntentType.SCHEDULE_QUERY}

请仅返回 JSON：
{"intent":"chat.casual","confidence":0.95,"entities":[]}
`;

    const result = await this.chat(prompt);

    try {
      const parsed = JSON.parse(result) as Partial<Intent> & { intent?: IntentType };
      const type = parsed.type ?? parsed.intent;

      if (!type || !Object.values(IntentType).includes(type)) {
        log.warn({ result, type }, 'LLM 返回了无效的意图类型');
        return {
          type: IntentType.CHAT_CASUAL,
          confidence: 0.3,
          entities: [],
        };
      }

      return {
        type,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.3,
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      };
    } catch (parseError) {
      log.warn({ result, parseError }, '意图 JSON 解析失败');
      return {
        type: IntentType.CHAT_CASUAL,
        confidence: 0.3,
        entities: [],
      };
    }
  }
}
