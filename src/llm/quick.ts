import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import type { Intent, ParsedMessage } from '../types/index.js';
import { IntentType } from '../types/index.js';
import { OpenAICompatibleClient } from './base.js';

const log = createChildLogger('quick');

export interface VisionAnalysisResult {
  text: string;
  labels: string[];
  confidence: number;
  metadata?: Record<string, unknown>;
}

/**
 * Quick 服务（快速响应模型）
 * 用于聊天、意图识别、视觉分析、向量嵌入
 */
export class QuickService extends OpenAICompatibleClient {
  constructor() {
    super({
      apiKey: config.quick.apiKey,
      apiUrl: config.quick.apiUrl,
      model: config.quick.model,
      visionModel: config.quick.visionModel,
      maxTokens: config.quick.maxTokens,
      temperature: config.quick.temperature,
      timeout: config.quick.timeout,
    });
  }

  async chat(prompt: string, options?: { systemPrompt?: string }): Promise<string> {
    return super.chat(prompt, options?.systemPrompt ? { systemPrompt: options.systemPrompt } : undefined);
  }

  async analyzeVision(
    input: { url: string; type: 'image' | 'document' | 'audio' | 'video'; name?: string; mimeType?: string },
    instruction?: string,
  ): Promise<VisionAnalysisResult> {
    const content = await this.chatWithVision(
      [
        `附件类型: ${input.type}`,
        `附件名称: ${input.name ?? 'unknown'}`,
        `MIME: ${input.mimeType ?? 'unknown'}`,
        instruction ?? '请提取主要文本、关键标签、场景摘要，并返回 JSON。',
      ].join('\n'),
      input.url,
      {
        systemPrompt:
          '你是一个多模态理解助手。请根据用户提供的附件链接进行视觉理解，并严格返回 JSON，字段包括 text、labels、confidence、metadata。',
        jsonMode: true,
      },
    );

    const parsed = this.parseJson<Partial<VisionAnalysisResult>>(content, '视觉分析结果');

    return {
      text: parsed.text ?? '',
      labels: Array.isArray(parsed.labels)
        ? parsed.labels.filter((item): item is string => typeof item === 'string')
        : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      metadata: parsed.metadata ?? {},
    };
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: config.quick.embeddingModel,
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

// 兼容旧名称
export const GLMService = QuickService;
