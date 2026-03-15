import { describe, expect, it, vi } from 'vitest';
import { ControllerService } from '../../src/controller/index.js';
import { IntentType, SceneType } from '../../src/types/index.js';
import type { EnhancedIntent, ParsedMessage } from '../../src/types/index.js';

function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: 'msg-1',
    platform: 'telegram',
    channelId: 'channel-1',
    userId: 'user-1',
    rawContent: '帮我分析这个文件',
    textContent: '帮我分析这个文件',
    entities: [],
    attachments: [],
    multimodalContents: [],
    timestamp: new Date('2026-03-14T00:00:00.000Z'),
    metadata: {
      platform: 'telegram',
    },
    ...overrides,
  };
}

describe('ControllerService', () => {
  it('应该把上下文、意图和场景路由串联起来', async () => {
    const glm = {
      chat: vi.fn().mockResolvedValue('默认回复'),
    };

    const memory = {
      get: vi.fn().mockResolvedValue({ conversationHistory: [] }),
      addConversationTurn: vi.fn().mockResolvedValue(undefined),
    };

    const controller = new ControllerService(glm as never, memory as never);
    const taskHandler = {
      handle: vi.fn().mockResolvedValue('任务执行完成'),
    };

    controller.registerHandler(SceneType.TASK, taskHandler);

    const recognizeSpy = vi.spyOn(controller, 'recognizeIntent').mockResolvedValue({
      type: IntentType.TASK_ANALYSIS,
      confidence: 0.92,
      entities: [{ type: 'file', value: 'report.pdf', start: 0, end: 10 }],
      sentiment: { type: 'neutral', score: 0.5 },
    } satisfies EnhancedIntent);

    const message = createMessage();
    const response = await controller.handleMessage(message);
    const snapshot = await controller.getContextSnapshot(message);

    expect(response).toBe('任务执行完成');
    expect(recognizeSpy).toHaveBeenCalledWith(message);
    expect(taskHandler.handle).toHaveBeenCalledWith(message, expect.objectContaining({ type: IntentType.TASK_ANALYSIS }));
    expect(snapshot?.variables.lastScene).toBe(SceneType.TASK);
    expect(snapshot?.variables.lastIntent).toBe(IntentType.TASK_ANALYSIS);
    expect(snapshot?.metadata.lastScene).toBe(SceneType.TASK);
    expect(snapshot?.activeTask).toEqual(
      expect.objectContaining({
        status: 'completed',
        progress: 100,
      }),
    );
    expect(memory.addConversationTurn).toHaveBeenCalledTimes(2);

    controller.destroy();
  });

  it('没有注册处理器时应该回退到默认聊天', async () => {
    const glm = {
      chat: vi.fn().mockResolvedValue('回退聊天回复'),
    };

    const memory = {
      get: vi.fn().mockResolvedValue({
        conversationHistory: [{ role: 'user', content: '你好' }],
      }),
      addConversationTurn: vi.fn().mockResolvedValue(undefined),
    };

    const controller = new ControllerService(glm as never, memory as never);
    vi.spyOn(controller, 'recognizeIntent').mockResolvedValue({
      type: IntentType.CHAT_CASUAL,
      confidence: 0.88,
      entities: [],
      sentiment: { type: 'positive', score: 0.7 },
    });

    const response = await controller.handleMessage(createMessage({ textContent: '今天真开心', rawContent: '今天真开心' }));

    expect(response).toBe('回退聊天回复');
    expect(glm.chat).toHaveBeenCalledOnce();
    expect(memory.addConversationTurn).toHaveBeenCalledTimes(2);

    controller.destroy();
  });
});
