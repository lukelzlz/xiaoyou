import type { ParsedMessage, HotMemory, EnhancedIntent, Sentiment, Entity } from '../types/index.js';
import { IntentType } from '../types/index.js';
import { ChatService } from '../llm/quick.js';
import { HotMemoryStore } from '../memory/hot.js';
import { createChildLogger } from '../utils/logger.js';
import { safeJsonParse } from '../utils/json.js';

const log = createChildLogger('intent');

/**
 * 意图识别器
 *
 * 负责：
 *  1. 根据用户消息和对话上下文识别意图
 *  2. 提取实体
 *  3. 分析情绪
 *  4. 返回增强的意图结果（EnhancedIntent）
 */
export class IntentRecognizer {
  private chat: ChatService;
  private memory: HotMemoryStore;

  constructor(chat: ChatService, memory: HotMemoryStore) {
    this.chat = chat;
    this.memory = memory;
  }

  /**
   * 执行完整的意图识别流程
   */
  async recognize(message: ParsedMessage): Promise<EnhancedIntent> {
    const sessionId = `${message.channelId}:${message.userId}`;
    const memory = await this.memory.get(sessionId);
    const context = this.buildContext(memory);

    // 1. 意图分类 + 实体提取（合并一次 LLM 调用）
    const intentResult = await this.classifyIntent(message, context);

    // 2. 将多模态提取内容注入实体与原始响应
    const multimodalEntities = this.extractMultimodalEntities(message);
    const mergedEntities = this.mergeEntities(intentResult.entities, multimodalEntities);

    // 3. 情绪分析（轻量规则 + LLM 回退）
    const sentiment = this.analyzeSentiment(message.textContent, intentResult);

    const enhanced: EnhancedIntent = {
      ...intentResult,
      entities: mergedEntities,
      sentiment,
      rawResponse: intentResult.rawResponse
        ? JSON.stringify({
            source: 'chat',
            llm: intentResult.rawResponse,
            multimodalSummary: message.metadata.multimodalSummary,
          })
        : undefined,
    };

    log.debug(
      { intent: enhanced.type, confidence: enhanced.confidence, sentiment: sentiment?.type, messageId: message.id },
      '意图识别完成',
    );

    return enhanced;
  }

  /**
   * 使用聊天模型进行意图分类和实体提取
   */
  private async classifyIntent(message: ParsedMessage, context: string): Promise<EnhancedIntent> {
    const multimodalSummary = message.metadata.multimodalSummary
      ? `\n多模态摘要：\n${message.metadata.multimodalSummary}`
      : '';

    const prompt = `
你是一个意图识别系统。请分析以下用户消息并返回 JSON。

用户消息：${message.textContent}
上下文：${context}
附件数量：${message.attachments.length}${multimodalSummary}
 
可选意图：
- ${IntentType.CHAT_CASUAL} (闲聊)
- ${IntentType.CHAT_EMOTIONAL} (情感陪伴)
- ${IntentType.CHAT_QUESTION} (简单问答)
- ${IntentType.TOOL_SEARCH} (搜索)
- ${IntentType.TOOL_EXTRACT} (信息提取)
- ${IntentType.TOOL_QUERY} (查询)
- ${IntentType.TASK_CODE} (代码生成)
- ${IntentType.TASK_AUTOMATION} (自动化)
- ${IntentType.TASK_ANALYSIS} (分析任务)
- ${IntentType.SCHEDULE_CREATE} (创建定时)
- ${IntentType.SCHEDULE_MODIFY} (修改定时)
- ${IntentType.SCHEDULE_CANCEL} (取消定时)
- ${IntentType.SCHEDULE_QUERY} (查询定时)
- ${IntentType.FEEDBACK_POSITIVE} (正面反馈)
- ${IntentType.FEEDBACK_NEGATIVE} (负面反馈)
- ${IntentType.FEEDBACK_CORRECTION} (纠正)

请仅返回 JSON（不要包含其他文本）：
{
  "intent": "chat.casual",
  "confidence": 0.95,
  "entities": [
    {"type": "url", "value": "https://...", "start": 0, "end": 10}
  ],
  "sentiment": "positive"
}
`;

    const result = await this.chat.chat(prompt);

    const parsed = safeJsonParse<{
      intent?: IntentType;
      type?: IntentType;
      confidence?: number;
      entities?: Array<{ type: string; value: string; start: number; end: number; confidence?: number }>;
      sentiment?: string;
    }>(result);

    if (!parsed) {
      log.warn({ result }, '意图 JSON 解析失败，回退到闲聊');
      return {
        type: IntentType.CHAT_CASUAL,
        confidence: 0.3,
        entities: message.entities,
        rawResponse: result,
      };
    }

    const type = parsed.intent ?? parsed.type;

    if (!type || !Object.values(IntentType).includes(type)) {
      log.warn({ result, type }, 'LLM 返回了无效的意图类型，回退到闲聊');
      return {
        type: IntentType.CHAT_CASUAL,
        confidence: 0.3,
        entities: message.entities,
        rawResponse: result,
      };
    }

    // 合并解析器已提取的实体与 LLM 提取的实体
    const llmEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
    const mergedEntities = this.mergeEntities(message.entities, llmEntities);

    return {
      type,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      entities: mergedEntities,
      rawResponse: result,
    };
  }

  /**
   * 情绪分析
   * 优先使用规则匹配，如果 LLM 已返回情绪则直接使用
   */
  private analyzeSentiment(text: string, intentResult: EnhancedIntent): Sentiment {
    // 如果 LLM 返回了情绪标签，直接用
    if (intentResult.rawResponse) {
      const parsed = safeJsonParse<{ sentiment?: string }>(intentResult.rawResponse);
      if (parsed?.sentiment) {
        return this.mapSentiment(parsed.sentiment);
      }
    }

    // 基于意图类型的快速推断
    if (intentResult.type === IntentType.FEEDBACK_POSITIVE) {
      return { type: 'positive', score: 0.8 };
    }
    if (intentResult.type === IntentType.FEEDBACK_NEGATIVE) {
      return { type: 'negative', score: 0.8 };
    }
    if (intentResult.type === IntentType.CHAT_EMOTIONAL) {
      return this.ruleSentiment(text);
    }

    // 基于关键词的轻量级规则分析
    return this.ruleSentiment(text);
  }

  /**
   * 基于关键词的规则情绪分析
   */
  private ruleSentiment(text: string): Sentiment {
    const positiveWords = ['谢谢', '感谢', '太好了', '棒', '厉害', '开心', '高兴', '喜欢', '爱', '赞', '不错', '好的'];
    const negativeWords = ['烦', '讨厌', '难过', '伤心', '生气', '失望', '无聊', '糟糕', '差劲', '不好', '不行', '差'];

    let positiveScore = 0;
    let negativeScore = 0;

    for (const word of positiveWords) {
      if (text.includes(word)) positiveScore += 1;
    }
    for (const word of negativeWords) {
      if (text.includes(word)) negativeScore += 1;
    }

    if (positiveScore > 0 && negativeScore > 0) {
      return { type: 'mixed', score: 0.5 };
    }
    if (positiveScore > 0) {
      return { type: 'positive', score: Math.min(0.5 + positiveScore * 0.15, 1.0) };
    }
    if (negativeScore > 0) {
      return { type: 'negative', score: Math.min(0.5 + negativeScore * 0.15, 1.0) };
    }

    return { type: 'neutral', score: 0.5 };
  }

  /**
   * 将 LLM 返回的情绪字符串映射为 Sentiment 对象
   */
  private mapSentiment(raw: string): Sentiment {
    const lower = raw.toLowerCase();
    if (lower.includes('positive') || lower === '正面' || lower === '积极') {
      return { type: 'positive', score: 0.7 };
    }
    if (lower.includes('negative') || lower === '负面' || lower === '消极') {
      return { type: 'negative', score: 0.7 };
    }
    if (lower.includes('mixed') || lower === '混合') {
      return { type: 'mixed', score: 0.5 };
    }
    return { type: 'neutral', score: 0.5 };
  }

  /**
   * 合并解析器和 LLM 提取的实体，去重
   */
  private mergeEntities(
    parserEntities: Entity[],
    llmEntities: Entity[],
  ): Entity[] {
    const seen = new Set(parserEntities.map((e) => `${e.type}:${e.value}`));
    const merged = [...parserEntities];

    for (const entity of llmEntities) {
      const key = `${entity.type}:${entity.value}`;
      if (!seen.has(key)) {
        merged.push(entity);
        seen.add(key);
      }
    }

    return merged;
  }

  private extractMultimodalEntities(message: ParsedMessage): Entity[] {
    if (!message.multimodalContents?.length) {
      return [];
    }

    const textLength = message.textContent.length;

    return message.multimodalContents.flatMap((content, index) => {
      const entities: Entity[] = [];

      if (content.extractedText) {
        entities.push({
          type: `${content.type}_text`,
          value: content.extractedText,
          start: textLength,
          end: textLength + content.extractedText.length,
          confidence: content.confidence,
        });
      }

      for (const label of content.labels ?? []) {
        entities.push({
          type: `${content.type}_label`,
          value: label,
          start: index,
          end: index + label.length,
          confidence: content.confidence,
        });
      }

      return entities;
    });
  }

  /**
   * 构建对话上下文摘要
   */
  private buildContext(memory: HotMemory | null): string {
    if (!memory || memory.conversationHistory.length === 0) {
      return '无历史对话';
    }

    const recent = memory.conversationHistory.slice(-5);
    return recent.map((t) => `${t.role}: ${t.content}`).join('\n');
  }
}
