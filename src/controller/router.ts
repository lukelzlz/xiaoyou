import type { EnhancedIntent, ParsedMessage, RoutingRule, RoutingCondition } from '../types/index.js';
import { IntentType, SceneType } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('router');

/**
 * 默认路由规则
 * 按优先级从高到低排列
 */
const defaultRoutingRules: RoutingRule[] = [
  // 定时场景 - 最高优先级
  {
    intent: [IntentType.SCHEDULE_CREATE, IntentType.SCHEDULE_MODIFY, IntentType.SCHEDULE_CANCEL, IntentType.SCHEDULE_QUERY],
    scene: SceneType.SCHEDULE,
    priority: 100,
    description: '定时任务管理',
  },

  // 任务场景 - 需要规划
  {
    intent: [IntentType.TASK_CODE, IntentType.TASK_AUTOMATION, IntentType.TASK_ANALYSIS],
    scene: SceneType.TASK,
    priority: 80,
    condition: { requiresPlanning: true },
    description: '复杂任务执行',
  },

  // 工具场景
  {
    intent: [IntentType.TOOL_SEARCH, IntentType.TOOL_EXTRACT, IntentType.TOOL_QUERY],
    scene: SceneType.TOOL,
    priority: 60,
    description: '工具调用',
  },

  // 反馈场景 - 路由到聊天
  {
    intent: [IntentType.FEEDBACK_POSITIVE, IntentType.FEEDBACK_NEGATIVE, IntentType.FEEDBACK_CORRECTION],
    scene: SceneType.CHAT,
    priority: 40,
    description: '用户反馈',
  },

  // 聊天场景 - 最低优先级（默认兜底）
  {
    intent: [IntentType.CHAT_CASUAL, IntentType.CHAT_EMOTIONAL, IntentType.CHAT_QUESTION],
    scene: SceneType.CHAT,
    priority: 20,
    description: '日常聊天',
  },
];

/**
 * 场景路由器
 *
 * 负责：
 *  1. 根据意图类型匹配路由规则
 *  2. 按优先级选择最优场景
 *  3. 支持条件匹配（如 requiresPlanning、minConfidence）
 *  4. 支持动态添加/更新路由规则
 */
export class SceneRouter {
  private rules: RoutingRule[];

  constructor(customRules?: RoutingRule[]) {
    // 如果提供了自定义规则，合并并按优先级排序
    if (customRules && customRules.length > 0) {
      this.rules = this.mergeAndSortRules(defaultRoutingRules, customRules);
    } else {
      this.rules = [...defaultRoutingRules].sort((a, b) => b.priority - a.priority);
    }

    log.info({ ruleCount: this.rules.length }, '场景路由器初始化完成');
  }

  /**
   * 根据意图路由到对应场景
   */
  route(intent: EnhancedIntent, message?: ParsedMessage): SceneType {
    // 按优先级遍历规则
    for (const rule of this.rules) {
      if (this.matchesRule(rule, intent, message)) {
        log.debug(
          { intent: intent.type, scene: rule.scene, priority: rule.priority },
          '路由匹配成功',
        );
        return rule.scene;
      }
    }

    // 兜底：返回聊天场景
    log.debug({ intent: intent.type }, '无匹配规则，使用默认聊天场景');
    return SceneType.CHAT;
  }

  /**
   * 获取匹配的路由规则详情
   */
  getMatchedRule(intent: EnhancedIntent, message?: ParsedMessage): RoutingRule | null {
    for (const rule of this.rules) {
      if (this.matchesRule(rule, intent, message)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * 添加或更新路由规则
   */
  addRule(rule: RoutingRule): void {
    const existingIndex = this.rules.findIndex(
      (r) => r.scene === rule.scene && this.intentArraysEqual(r.intent, rule.intent),
    );

    if (existingIndex >= 0) {
      this.rules[existingIndex] = rule;
      log.info({ scene: rule.scene, priority: rule.priority }, '路由规则已更新');
    } else {
      this.rules.push(rule);
      log.info({ scene: rule.scene, priority: rule.priority }, '路由规则已添加');
    }

    // 重新排序
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 移除路由规则
   */
  removeRule(scene: SceneType, intent: IntentType | IntentType[]): boolean {
    const index = this.rules.findIndex(
      (r) => r.scene === scene && this.intentArraysEqual(r.intent, Array.isArray(intent) ? intent : [intent]),
    );

    if (index >= 0) {
      this.rules.splice(index, 1);
      log.info({ scene }, '路由规则已移除');
      return true;
    }

    return false;
  }

  /**
   * 获取所有路由规则
   */
  getRules(): RoutingRule[] {
    return [...this.rules];
  }

  /**
   * 检查规则是否匹配
   */
  private matchesRule(rule: RoutingRule, intent: EnhancedIntent, message?: ParsedMessage): boolean {
    // 1. 检查意图类型是否匹配
    const intentTypes = Array.isArray(rule.intent) ? rule.intent : [rule.intent];
    if (!intentTypes.includes(intent.type)) {
      return false;
    }

    // 2. 检查条件
    if (rule.condition) {
      if (!this.matchesCondition(rule.condition, intent, message)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 检查条件是否满足
   */
  private matchesCondition(condition: RoutingCondition, intent: EnhancedIntent, message?: ParsedMessage): boolean {
    // 最小置信度检查
    if (condition.minConfidence !== undefined && intent.confidence < condition.minConfidence) {
      return false;
    }

    // 附件检查
    if (condition.hasAttachments !== undefined) {
      const hasAttachments = message ? message.attachments.length > 0 : false;
      if (condition.hasAttachments !== hasAttachments) {
        return false;
      }
    }

    // 自定义条件检查
    if (condition.custom && message) {
      try {
        if (!condition.custom(intent, message)) {
          return false;
        }
      } catch (error) {
        log.warn({ error, condition }, '自定义路由条件执行失败');
        return false;
      }
    }

    return true;
  }

  /**
   * 合并并排序规则
   */
  private mergeAndSortRules(defaultRules: RoutingRule[], customRules: RoutingRule[]): RoutingRule[] {
    const merged = new Map<string, RoutingRule>();

    // 先添加默认规则
    for (const rule of defaultRules) {
      const key = this.ruleKey(rule);
      merged.set(key, rule);
    }

    // 用自定义规则覆盖
    for (const rule of customRules) {
      const key = this.ruleKey(rule);
      merged.set(key, rule);
    }

    // 按优先级降序排序
    return Array.from(merged.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * 生成规则唯一键
   */
  private ruleKey(rule: RoutingRule): string {
    const intents = Array.isArray(rule.intent) ? rule.intent.join(',') : rule.intent;
    return `${rule.scene}:${intents}`;
  }

  /**
   * 比较两个意图数组是否相等
   */
  private intentArraysEqual(a: IntentType | IntentType[], b: IntentType | IntentType[]): boolean {
    const arrA = Array.isArray(a) ? [...a].sort() : [a];
    const arrB = Array.isArray(b) ? [...b].sort() : [b];
    return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i]);
  }
}
