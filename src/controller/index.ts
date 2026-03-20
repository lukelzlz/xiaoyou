import { nanoid } from 'nanoid';
import type {
  EnhancedIntent,
  ParsedMessage,
  SceneHandler,
  SceneType,
  SessionContext,
} from '../types/index.js';
import { QuickService } from '../llm/quick.js';
import { HotMemoryStore } from '../memory/hot.js';
import { metricsService } from '../monitoring/metrics.js';
import { createChildLogger } from '../utils/logger.js';
import { pluginManager } from '../plugins/index.js';
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
  private quick: QuickService;
  private handlers: Map<SceneType, SceneHandler> = new Map();

  constructor(quick: QuickService, memory: HotMemoryStore) {
    this.quick = quick;
    this.memory = memory;
    this.intentRecognizer = new IntentRecognizer(quick, memory);
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
  routeToScene(intent: EnhancedIntent, message?: ParsedMessage, context?: SessionContext): SceneType {
    return this.sceneRouter.route(intent, message, context);
  }

  /**
   * 对外暴露：管理上下文
   */
  async manageContext(message: ParsedMessage): Promise<SessionContext> {
    const sessionId = this.getSessionId(message);
    await this.contextManager.getOrCreate(
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
      multimodalCount: message.multimodalContents?.length ?? 0,
    });

    return (await this.contextManager.snapshot(sessionId)) as SessionContext;
  }

  /**
   * 处理用户消息
   */
  async handleMessage(message: ParsedMessage): Promise<string> {
    const startAt = Date.now();
    log.info({ messageId: message.id, userId: message.userId }, '处理消息');
    metricsService.recordMessage(message.userId);

    const processedMessage = await pluginManager.executeMessagePreprocess(message);
    const sessionId = this.getSessionId(processedMessage);

    // 1. 管理上下文
    const context = await this.manageContext(processedMessage);

    // 2. 意图识别
    const rawIntent = await this.recognizeIntent(processedMessage);
    const intent = await pluginManager.executeIntentPostprocess(rawIntent, processedMessage);

    // 3. 将本次识别结果写入上下文变量
    await this.contextManager.setVariable(sessionId, 'lastIntent', intent.type);
    await this.contextManager.setVariable(sessionId, 'lastIntentConfidence', intent.confidence);
    await this.contextManager.setVariable(sessionId, 'lastSentiment', intent.sentiment?.type ?? 'neutral');
    await this.contextManager.setVariable(sessionId, 'lastEntities', intent.entities);

    // 4. 场景路由
    const scene = this.routeToScene(intent, processedMessage, context);
    await this.contextManager.setVariable(sessionId, 'lastScene', scene);
    await this.contextManager.updateMetadata(sessionId, {
      lastScene: scene,
      lastIntentType: intent.type,
      lastIntentConfidence: intent.confidence,
    });

    if (scene === 'task') {
      await this.contextManager.setActiveTask(sessionId, {
        taskId: `pending:${processedMessage.id}`,
        description: processedMessage.textContent,
        status: 'routing',
        progress: 0,
      });
    } else if (context.activeTask) {
      await this.contextManager.setActiveTask(sessionId, undefined);
    }

    // 5. 获取处理器
    const handler = this.handlers.get(scene);
    if (!handler) {
      log.warn({ scene, messageId: processedMessage.id }, '未找到场景处理器，回退到默认聊天');
      const fallback = await this.defaultChat(processedMessage, intent);
      const finalFallback = await pluginManager.executeResponsePreprocess(fallback, processedMessage);
      await this.recordConversation(processedMessage, intent, finalFallback);
      metricsService.recordRequest({ durationMs: Date.now() - startAt, success: true });
      return finalFallback;
    }

    // 6. 执行处理器
    let response: string;
    try {
      response = await handler.handle(processedMessage, intent);
      const finalResponse = await pluginManager.executeResponsePreprocess(response, processedMessage);

      if (scene === 'task') {
        await this.contextManager.setActiveTask(sessionId, {
          taskId: `completed:${processedMessage.id}`,
          description: processedMessage.textContent,
          status: 'completed',
          progress: 100,
        });
      }

      // 7. 记录对话
      await this.recordConversation(processedMessage, intent, finalResponse);
      metricsService.recordRequest({ durationMs: Date.now() - startAt, success: true });

      return finalResponse;
    } catch (error) {
      log.error({ scene, messageId: processedMessage.id, error }, '场景处理器执行失败');
      
      if (scene === 'task') {
        await this.contextManager.setActiveTask(sessionId, {
          taskId: `failed:${processedMessage.id}`,
          description: processedMessage.textContent,
          status: 'failed',
          progress: 0,
        });
      }
      
      metricsService.recordRequest({ durationMs: Date.now() - startAt, success: false });
      throw error;
    }
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

    return this.quick.chat(prompt, { systemPrompt: '你是小悠，一个友好、智能、会结合上下文和用户情绪回应的 AI 助手。' });
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
