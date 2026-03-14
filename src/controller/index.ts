import { nanoid } from 'nanoid';
import type { Intent, ParsedMessage, HotMemory } from '../types/index.js';
import { IntentType, SceneType } from '../types/index.js';
import { GLMService } from '../llm/glm.js';
import { HotMemoryStore } from '../memory/hot.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('intent');

export class IntentRecognizer {
  private glm: GLMService;
  private memory: HotMemoryStore;

  constructor(glm: GLMService, memory: HotMemoryStore) {
    this.glm = glm;
    this.memory = memory;
  }

  async recognize(message: ParsedMessage): Promise<Intent> {
    const memory = await this.memory.get(message.channelId);
    const context = this.buildContext(memory);

    const intent = await this.glm.recognizeIntent(message, context);

    log.debug({ intent, messageId: message.id }, '意图识别完成');
    return intent;
  }

  private buildContext(memory: HotMemory | null): string {
    if (!memory || memory.conversationHistory.length === 0) {
      return '无历史对话';
    }

    const recent = memory.conversationHistory.slice(-5);
    return recent.map((t) => `${t.role}: ${t.content}`).join('\n');
  }
}

export class SceneRouter {
  route(intent: Intent): SceneType {
    const type = intent.type;

    if (type.startsWith('chat.')) return SceneType.CHAT;
    if (type.startsWith('tool.')) return SceneType.TOOL;
    if (type.startsWith('task.')) return SceneType.TASK;
    if (type.startsWith('schedule.')) return SceneType.SCHEDULE;
    if (type.startsWith('feedback.')) return SceneType.CHAT;

    return SceneType.CHAT;
  }
}

export class ControllerService {
  private intentRecognizer: IntentRecognizer;
  private sceneRouter: SceneRouter;
  private memory: HotMemoryStore;
  private glm: GLMService;

  // 服务处理器（稍后注入）
  private handlers: Map<SceneType, SceneHandler> = new Map();

  constructor(glm: GLMService, memory: HotMemoryStore) {
    this.glm = glm;
    this.memory = memory;
    this.intentRecognizer = new IntentRecognizer(glm, memory);
    this.sceneRouter = new SceneRouter();
  }

  registerHandler(scene: SceneType, handler: SceneHandler): void {
    this.handlers.set(scene, handler);
  }

  async handleMessage(message: ParsedMessage): Promise<string> {
    log.info({ messageId: message.id, userId: message.userId }, '处理消息');

    // 1. 意图识别
    const intent = await this.intentRecognizer.recognize(message);

    // 2. 场景路由
    const scene = this.sceneRouter.route(intent);

    // 3. 获取处理器
    const handler = this.handlers.get(scene);

    if (!handler) {
      // 默认聊天处理
      return this.defaultChat(message);
    }

    // 4. 执行处理
    const response = await handler.handle(message, intent);

    // 5. 记录对话
    await this.memory.addConversationTurn(message.channelId, message.userId, {
      turnId: nanoid(),
      timestamp: new Date(),
      role: 'user',
      content: message.textContent,
      intent: intent.type,
    });

    await this.memory.addConversationTurn(message.channelId, message.userId, {
      turnId: nanoid(),
      timestamp: new Date(),
      role: 'assistant',
      content: response,
    });

    return response;
  }

  private async defaultChat(message: ParsedMessage): Promise<string> {
    const memory = await this.memory.get(message.channelId);
    const history = memory?.conversationHistory.slice(-10) ?? [];

    const context = history.map((t) => `${t.role}: ${t.content}`).join('\n');
    const prompt = `历史对话：\n${context}\n\n用户：${message.textContent}\n\n请回复：`;

    return this.glm.chat(prompt, '你是小悠，一个友好、智能的 AI 助手。');
  }
}

export interface SceneHandler {
  handle(message: ParsedMessage, intent: Intent): Promise<string>;
}
