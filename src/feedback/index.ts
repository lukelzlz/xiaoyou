/**
 * 用户反馈处理服务
 * 
 * 处理用户反馈，更新用户偏好和画像
 */
import { createChildLogger } from '../utils/logger.js';
import { VectorMemoryStore } from '../memory/vector.js';
import { HotMemoryStore } from '../memory/hot.js';
import { IntentType } from '../types/index.js';
import { nanoid } from 'nanoid';

const log = createChildLogger('feedback');

// ============ 类型定义 ============

export type FeedbackType = 'positive' | 'negative' | 'correction';

export interface UserFeedback {
  id: string;
  userId: string;
  messageId: string;
  type: FeedbackType;
  content?: string;
  correctedResponse?: string;
  originalResponse?: string;
  timestamp: Date;
  processed: boolean;
}

export interface FeedbackAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  topics: string[];
  suggestions: string[];
  preferenceUpdates: Record<string, unknown>;
}

export interface UserPreferenceUpdate {
  category: string;
  key: string;
  value: unknown;
  confidence: number;
  source: 'explicit' | 'implicit';
}

// ============ 反馈处理服务 ============

export class FeedbackService {
  private vectorMemory: VectorMemoryStore;
  private hotMemory: HotMemoryStore;

  constructor(vectorMemory: VectorMemoryStore, hotMemory: HotMemoryStore) {
    this.vectorMemory = vectorMemory;
    this.hotMemory = hotMemory;
  }

  /**
   * 处理用户反馈
   * @param feedback 用户反馈
   */
  async processFeedback(feedback: UserFeedback): Promise<void> {
    log.info({ feedbackId: feedback.id, userId: feedback.userId, type: feedback.type }, '处理用户反馈');

    try {
      // 1. 存储反馈记录
      await this.storeFeedback(feedback);

      // 2. 分析反馈
      const analysis = await this.analyzeFeedback(feedback);

      // 3. 更新用户偏好
      await this.updateUserPreferences(feedback.userId, analysis);

      // 4. 更新用户画像
      await this.updateUserProfile(feedback.userId, feedback, analysis);

      // 5. 标记为已处理
      feedback.processed = true;

      log.info({ feedbackId: feedback.id }, '反馈处理完成');
    } catch (error) {
      log.error({ error, feedbackId: feedback.id }, '反馈处理失败');
      throw error;
    }
  }

  /**
   * 存储反馈到向量数据库
   */
  private async storeFeedback(feedback: UserFeedback): Promise<void> {
    const content = this.buildFeedbackContent(feedback);

    await this.vectorMemory.store({
      id: feedback.id,
      content,
      embedding: [],
      metadata: {
        type: 'preference',
        userId: feedback.userId,
        importance: this.calculateImportance(feedback),
        accessCount: 0,
        tags: ['feedback', feedback.type, feedback.messageId],
      },
      createdAt: feedback.timestamp,
    });
  }

  /**
   * 构建反馈内容字符串
   */
  private buildFeedbackContent(feedback: UserFeedback): string {
    const parts = [`用户反馈类型: ${feedback.type}`];

    if (feedback.content) {
      parts.push(`反馈内容: ${feedback.content}`);
    }

    if (feedback.correctedResponse) {
      parts.push(`纠正回复: ${feedback.correctedResponse}`);
    }

    if (feedback.originalResponse) {
      parts.push(`原始回复: ${feedback.originalResponse}`);
    }

    return parts.join('\n');
  }

  /**
   * 计算反馈重要性
   */
  private calculateImportance(feedback: UserFeedback): number {
    switch (feedback.type) {
      case 'correction':
        return 0.95; // 纠正最重要
      case 'negative':
        return 0.85; // 负面反馈次之
      case 'positive':
        return 0.7; // 正面反馈
      default:
        return 0.5;
    }
  }

  /**
   * 分析反馈
   */
  private async analyzeFeedback(feedback: UserFeedback): Promise<FeedbackAnalysis> {
    const analysis: FeedbackAnalysis = {
      sentiment: 'neutral',
      topics: [],
      suggestions: [],
      preferenceUpdates: {},
    };

    // 基于反馈类型确定情感
    switch (feedback.type) {
      case 'positive':
        analysis.sentiment = 'positive';
        analysis.suggestions.push('保持当前响应风格');
        break;

      case 'negative':
        analysis.sentiment = 'negative';
        analysis.suggestions.push('调整响应策略');
        if (feedback.content) {
          analysis.topics.push(...this.extractTopics(feedback.content));
        }
        break;

      case 'correction':
        analysis.sentiment = 'neutral'; // 纠正是中性反馈
        if (feedback.correctedResponse) {
          analysis.suggestions.push(`学习用户偏好的回复方式: ${feedback.correctedResponse.slice(0, 100)}`);
          analysis.preferenceUpdates = {
            responseStyle: 'user_preferred',
            correctionExample: feedback.correctedResponse,
          };
        }
        break;
    }

    return analysis;
  }

  /**
   * 提取主题关键词
   */
  private extractTopics(content: string): string[] {
    const topics: string[] = [];

    // 简单的关键词提取
    const keywords = [
      '回复太长', '回复太短', '不够准确', '太啰嗦', '不够详细',
      '语气不好', '不够友好', '太正式', '太随意', '理解错误',
      '格式问题', '速度太慢', '信息过时',
    ];

    for (const keyword of keywords) {
      if (content.includes(keyword)) {
        topics.push(keyword);
      }
    }

    return topics;
  }

  /**
   * 更新用户偏好
   */
  private async updateUserPreferences(userId: string, analysis: FeedbackAnalysis): Promise<void> {
    // 获取用户会话
    const sessionKey = `user_prefs:${userId}`;
    const memory = await this.hotMemory.get(sessionKey);

    const currentPrefs = memory?.userPreferences || {
      language: 'zh-CN',
      responseStyle: 'casual',
      timezone: 'Asia/Shanghai',
      notificationSettings: { enabled: true, channels: [] },
    };

    // 根据分析结果更新偏好
    if (analysis.sentiment === 'negative') {
      // 负面反馈：可能需要调整响应风格
      if (analysis.topics.includes('回复太长')) {
        currentPrefs.responseStyle = 'concise';
      } else if (analysis.topics.includes('回复太短') || analysis.topics.includes('不够详细')) {
        currentPrefs.responseStyle = 'detailed';
      } else if (analysis.topics.includes('太正式')) {
        currentPrefs.responseStyle = 'casual';
      } else if (analysis.topics.includes('太随意')) {
        currentPrefs.responseStyle = 'formal';
      }
    }

    // 应用偏好更新
    if (Object.keys(analysis.preferenceUpdates).length > 0) {
      Object.assign(currentPrefs.customSettings || {}, analysis.preferenceUpdates);
    }

    // 保存更新后的偏好
    await this.hotMemory.update(sessionKey, {
      userPreferences: currentPrefs,
    });

    log.info({ userId, updates: analysis.preferenceUpdates }, '用户偏好已更新');
  }

  /**
   * 更新用户画像
   */
  private async updateUserProfile(
    userId: string,
    feedback: UserFeedback,
    analysis: FeedbackAnalysis,
  ): Promise<void> {
    // 构建画像更新内容
    const profileContent = this.buildProfileContent(feedback, analysis);

    // 存储到向量数据库作为长期记忆
    await this.vectorMemory.store({
      id: `profile_${userId}_${Date.now()}`,
      content: profileContent,
      embedding: [],
      metadata: {
        type: 'preference',
        userId,
        importance: 0.8,
        accessCount: 0,
        tags: ['profile', 'feedback_history', feedback.type],
      },
      createdAt: new Date(),
    });

    log.debug({ userId }, '用户画像已更新');
  }

  /**
   * 构建画像内容
   */
  private buildProfileContent(feedback: UserFeedback, analysis: FeedbackAnalysis): string {
    const parts = [
      `用户 ${feedback.userId} 的反馈记录:`,
      `时间: ${feedback.timestamp.toISOString()}`,
      `类型: ${feedback.type}`,
    ];

    if (feedback.content) {
      parts.push(`内容: ${feedback.content}`);
    }

    if (analysis.topics.length > 0) {
      parts.push(`关注点: ${analysis.topics.join(', ')}`);
    }

    if (analysis.suggestions.length > 0) {
      parts.push(`建议: ${analysis.suggestions.join('; ')}`);
    }

    return parts.join('\n');
  }

  /**
   * 获取用户反馈历史
   */
  async getFeedbackHistory(userId: string, limit: number = 10): Promise<UserFeedback[]> {
    const results = await this.vectorMemory.retrieve(`用户反馈 ${userId}`, {
      method: 'similarity',
      topK: limit,
      threshold: 0.5,
      userId,
      type: 'preference',
    });

    return results
      .filter(r => r.metadata.tags?.includes('feedback'))
      .map(r => this.parseFeedbackFromMemory(r.content, r.id, r.metadata.userId || userId, r.createdAt));
  }

  /**
   * 从存储内容解析反馈
   */
  private parseFeedbackFromMemory(content: string, id: string, userId: string, timestamp: Date): UserFeedback {
    const lines = content.split('\n');
    const feedback: UserFeedback = {
      id,
      userId,
      messageId: '',
      type: 'positive',
      timestamp,
      processed: true,
    };

    for (const line of lines) {
      if (line.startsWith('用户反馈类型:')) {
        feedback.type = line.split(':')[1].trim() as FeedbackType;
      } else if (line.startsWith('反馈内容:')) {
        feedback.content = line.split(':').slice(1).join(':').trim();
      } else if (line.startsWith('纠正回复:')) {
        feedback.correctedResponse = line.split(':').slice(1).join(':').trim();
      }
    }

    return feedback;
  }

  /**
   * 计算用户满意度
   */
  async calculateSatisfactionScore(userId: string): Promise<number> {
    const history = await this.getFeedbackHistory(userId, 100);

    if (history.length === 0) {
      return 0.5; // 默认中性
    }

    let score = 0;
    for (const feedback of history) {
      switch (feedback.type) {
        case 'positive':
          score += 1;
          break;
        case 'negative':
          score -= 0.5;
          break;
        case 'correction':
          score += 0.3; // 纠正表示用户愿意参与改进
          break;
      }
    }

    // 归一化到 0-1 范围
    const maxScore = history.length;
    const normalized = (score + maxScore) / (2 * maxScore);

    return Math.max(0, Math.min(1, normalized));
  }
}

// ============ 反馈意图处理器 ============

/**
 * 从消息中识别反馈意图
 */
export function recognizeFeedbackIntent(message: string): {
  isFeedback: boolean;
  type?: FeedbackType;
  confidence: number;
} {
  const lowered = message.toLowerCase();

  // 正面反馈关键词
  const positiveKeywords = ['👍', '好的', '很好', '太棒了', '谢谢', '感谢', '有帮助', '正确', '对'];
  for (const keyword of positiveKeywords) {
    if (lowered.includes(keyword)) {
      return { isFeedback: true, type: 'positive', confidence: 0.8 };
    }
  }

  // 负面反馈关键词
  const negativeKeywords = ['👎', '不好', '错误', '不对', '太差', '不满意', '失望', '不行'];
  for (const keyword of negativeKeywords) {
    if (lowered.includes(keyword)) {
      return { isFeedback: true, type: 'negative', confidence: 0.8 };
    }
  }

  // 纠正关键词
  const correctionKeywords = ['应该是', '应该是这样', '不对，', '错了，', '其实', '我想说的是'];
  for (const keyword of correctionKeywords) {
    if (lowered.includes(keyword)) {
      return { isFeedback: true, type: 'correction', confidence: 0.7 };
    }
  }

  return { isFeedback: false, confidence: 0 };
}

// ============ 导出 ============

import { defaultVectorMemoryStore } from '../memory/vector.js';
import { defaultHotMemoryStore } from '../memory/hot.js';

export const feedbackService = new FeedbackService(defaultVectorMemoryStore, defaultHotMemoryStore);
