import { nanoid } from 'nanoid';
import type {
  EnhancedIntent,
  ParsedMessage,
  SceneHandler,
  SceneType,
  SessionContext,
} from '../types/index.js';
import { GLMService } from '../llm/glm.js';
import { HotMemoryStore } from '../memory/hot.js';
import { createChildLogger } from '../utils/logger.js';
import { IntentRecognizer } from './intent.js';
import { SceneRouter } from './router.js';
import { InMemoryContextManager } from './context.js';

const log = createChildLogger('controller');

/**
 * 控制层服务
 *
 * 负责：
 *  1. 管理会话上下文
 *  2. 调用意图识别器
 *  3. 根据规则路由到对应场景
 *  4. 记录对话历史
 */
export class ControllerService {
  private intentRecognizer: IntentRecognizer;
  private sceneRouter: SceneRouter;
  private contextManager: InMemoryContextManager;
  private memory: HotMemoryStore;
  private glm: GLMService;
  private handlers: Map<SceneType, SceneHandler> = new Map();

  constructor(glm: GLMService, memory: HotMemoryStore) {
    this.glm = glm;
    this.memory = memory;
    this.intentRecognizer = new IntentRecognizer(glm, memory);
    this.sceneRouter = new SceneRouter();
    this.contextManager = new InMemoryContextManager();
  }

  registerHandler(scene: SceneType, handler: SceneHandler): void {
    this.handlers.set(scene, handler);
  }

  /**
   * 对外暴露：识别意图
   */
  async recognizeIntent(message: ParsedMessage): Promise<EnhancedIntent> {
    return this.intentRecognizer.recognize(message);
  }

  /**
   * 对外暴露：路由场景
   */
  routeToScene(intent: EnhancedIntent, message?: ParsedMessage): SceneType {
    return this.sceneRouter.route(intent, message);
  }

  /**
   * 对外暴露：管理上下文
   */
  async manageContext(message: ParsedMessage): Promise<SessionContext> {
    const sessionId = this.getSessionId(message);
    const context = await this.contextManager.getOrCreate(
      sessionId,
      message.userId,
      message.channelId,
      message.platform,
    );

    await this.contextManager.touch(sessionId);
    await this.contextManager.updateMetadata(sessionId, {
      lastMessageId: message.id,
      lastIntentAt: new Date().toISOString(),
      attachmentCount: message.attachments.length,
      multimodalSummary: message.metadata.multimodalSummary,
    });

    return context;
  }

  /**
   * 处理用户消息
   */
  async handleMessage(message: ParsedMessage): Promise<string> {
    log.info({ messageId: message.id, userId: message.userId }, '处理消息');

    const sessionId = this.getSessionId(message);

    // 1. 管理上下文
    await this.manageContext(message);

    // 2. 意图识别
    const intent = await this.recognizeIntent(message);

    // 3. 将本次识别结果写入上下文变量
    await this.contextManager.setVariable(sessionId, 'lastIntent', intent.type);
    await this.contextManager.setVariable(sessionId, 'lastIntentConfidence', intent.confidence);
    await this.contextManager.setVariable(sessionId, 'lastSentiment', intent.sentiment?.type ?? 'neutral');
    await this.contextManager.setVariable(sessionId, 'lastEntities', intent.entities);

    // 4. 场景路由
    const scene = this.routeToScene(intent, message);
    await this.contextManager.setVariable(sessionId, 'lastScene', scene);

    // 5. 获取处理器
    const handler = this.handlers.get(scene);
    if (!handler) {
      log.warn({ scene, messageId: message.id }, '未找到场景处理器，回退到默认聊天');
      const fallback = await this.defaultChat(message, intent);
      await this.recordConversation(message, intent, fallback);
      return fallback;
    }

    // 6. 执行处理器
    const response = await handler.handle(message, intent);

    // 7. 记录对话
    await this.recordConversation(message, intent, response);

    return response;
  }

  /**
   * 获取会话快照
   */
  async getContextSnapshot(message: ParsedMessage): Promise<SessionContext | null> {
    return this.contextManager.snapshot(this.getSessionId(message));
  }

  /**
   * 销毁控制器资源
   */
  destroy(): void {
    this.contextManager.destroy();
  }

  private async defaultChat(message: ParsedMessage, intent?: EnhancedIntent): Promise<string> {
    const sessionId = this.getSessionId(message);
    const memory = await this.memory.get(sessionId);
    const history = memory?.conversationHistory.slice(-10) ?? [];

    const context = history.map((t) => `${t.role}: ${t.content}`).join('\n');
    const sentimentLine = intent?.sentiment ? `\n用户情绪：${intent.sentiment.type}` : '';
    const prompt = `历史对话：\n${context}${sentimentLine}\n\n用户：${message.textContent}\n\n请回复：`;

    return this.glm.chat(prompt, '你是小悠，一个友好、智能、会结合上下文和用户情绪回应的 AI 助手。');
  }

  private async recordConversation(
    message: ParsedMessage,
    intent: EnhancedIntent,
    response: string,
  ): Promise<void> {
    const sessionId = this.getSessionId(message);

    await this.memory.addConversationTurn(sessionId, message.userId, {
      turnId: nanoid(),
      timestamp: new Date(),
      role: 'user',
      content: message.textContent,
      intent: intent.type,
      entities: intent.entities,
      sentiment: intent.sentiment?.type,
    });

    await this.memory.addConversationTurn(sessionId, message.userId, {
      turnId: nanoid(),
      timestamp: new Date(),
      role: 'assistant',
      content: response,
      sentiment: 'neutral',
    });
  }

  private getSessionId(message: ParsedMessage): string {
    return `${message.channelId}:${message.userId}`;
  }
}

export { IntentRecognizer } from './intent.js';
export { SceneRouter } from './router.js';
export { InMemoryContextManager } from './context.js';
export type { SceneHandler, SessionContext, EnhancedIntent } from '../types/index.js';
