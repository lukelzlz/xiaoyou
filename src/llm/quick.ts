import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { safeJsonParse } from '../utils/json.js';
import type { Intent, ParsedMessage } from '../types/index.js';
import { IntentType } from '../types/index.js';
import { OpenAICompatibleClient } from './base.js';

const log = createChildLogger('chat');

export interface VisionAnalysisResult {
  text: string;
  labels: string[];
  confidence: number;
  metadata?: Record<string, unknown>;
}

/**
 * 聊天服务
 * 用于快速响应、意图识别、向量嵌入
 */
export class ChatService extends OpenAICompatibleClient {
  constructor() {
    super({
      apiKey: config.chat.apiKey,
      apiUrl: config.chat.apiUrl,
      model: config.chat.model,
      maxTokens: config.chat.maxTokens,
      temperature: config.chat.temperature,
      timeout: config.chat.timeout,
    });
  }

  async chat(prompt: string, options?: { systemPrompt?: string }): Promise<string> {
    return super.chat(prompt, options?.systemPrompt ? { systemPrompt: options.systemPrompt } : undefined);
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: config.chat.embeddingModel,
        input: text,
      });
      return response.data[0]?.embedding ?? [];
    } catch (error) {
      log.error({ error }, 'Embedding 调用失败');
      throw error;
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

    const parsed = safeJsonParse<Partial<Intent> & { intent?: IntentType }>(result);
    if (!parsed) {
      log.warn({ result }, '意图 JSON 解析失败');
      return {
        type: IntentType.CHAT_CASUAL,
        confidence: 0.3,
        entities: [],
      };
    }

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
  }
}
