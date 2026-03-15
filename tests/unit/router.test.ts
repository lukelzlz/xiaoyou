import { describe, expect, it } from 'vitest';
import { SceneRouter } from '../../src/controller/router.js';
import { IntentType, SceneType } from '../../src/types/index.js';
import type { EnhancedIntent, ParsedMessage } from '../../src/types/index.js';

describe('SceneRouter', () => {
  it('应该使用默认规则进行路由，优先匹配最高优先级的规则', () => {
    const router = new SceneRouter();
    const intent: EnhancedIntent = {
      type: IntentType.SCHEDULE_CREATE,
      confidence: 0.9,
      entities: [],
    };
    const scene = router.route(intent);
    expect(scene).toBe(SceneType.SCHEDULE);
  });

  it('任务场景应该匹配 requiresPlanning 条件', () => {
    const router = new SceneRouter();
    const intent: EnhancedIntent = {
      type: IntentType.TASK_AUTOMATION,
      confidence: 0.9,
      entities: [],
    };
    const scene = router.route(intent);
    expect(scene).toBe(SceneType.TASK);
  });

  it('带文件实体的聊天请求可提升为需要规划的任务场景', () => {
    const router = new SceneRouter([
      {
        intent: IntentType.CHAT_QUESTION,
        scene: SceneType.TASK,
        priority: 90,
        condition: { requiresPlanning: true },
      },
    ]);

    const intent: EnhancedIntent = {
      type: IntentType.CHAT_QUESTION,
      confidence: 0.92,
      entities: [{ type: 'file', value: 'report.pdf', start: 0, end: 10 }],
    };

    const scene = router.route(intent);
    expect(scene).toBe(SceneType.TASK);
  });

  it('如果没有匹配的规则，应该兜底到 CHAT 场景', () => {
    const router = new SceneRouter([]);
    router.removeRule(SceneType.CHAT, [IntentType.CHAT_CASUAL, IntentType.CHAT_EMOTIONAL, IntentType.CHAT_QUESTION]);
    router.removeRule(SceneType.SCHEDULE, [IntentType.SCHEDULE_CREATE, IntentType.SCHEDULE_MODIFY, IntentType.SCHEDULE_CANCEL, IntentType.SCHEDULE_QUERY]);
    // 强制传一个未定义的类型测试兜底
    const intent: EnhancedIntent = {
      type: 'unknown.intent' as IntentType,
      confidence: 0.9,
      entities: [],
    };
    const scene = router.route(intent);
    expect(scene).toBe(SceneType.CHAT);
  });

  it('应该支持添加自定义规则并按优先级生效', () => {
    const router = new SceneRouter();
    router.addRule({
      intent: IntentType.TOOL_SEARCH,
      scene: SceneType.CHAT, // 强制将 search 路由到 CHAT
      priority: 200, // 高于原本的工具优先级 (60)
    });

    const intent: EnhancedIntent = {
      type: IntentType.TOOL_SEARCH,
      confidence: 0.9,
      entities: [],
    };
    const scene = router.route(intent);
    expect(scene).toBe(SceneType.CHAT);
  });

  it('条件检查 minConfidence 应该生效', () => {
    const router = new SceneRouter();
    router.addRule({
      intent: IntentType.CHAT_CASUAL,
      scene: SceneType.CHAT,
      priority: 100,
      condition: { minConfidence: 0.9 },
    });

    const intentLow: EnhancedIntent = {
      type: IntentType.CHAT_CASUAL,
      confidence: 0.8,
      entities: [],
    };
    // 假设被原本的兜底（优先级 20）捕获
    const matchedRule1 = router.getMatchedRule(intentLow);
    expect(matchedRule1?.priority).toBe(20);

    const intentHigh: EnhancedIntent = {
      type: IntentType.CHAT_CASUAL,
      confidence: 0.95,
      entities: [],
    };
    const matchedRule2 = router.getMatchedRule(intentHigh);
    expect(matchedRule2?.priority).toBe(100);
  });
});