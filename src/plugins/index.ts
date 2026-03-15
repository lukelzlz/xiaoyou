import { createChildLogger } from '../utils/logger.js';
import type { ParsedMessage, EnhancedIntent } from '../types/index.js';

const log = createChildLogger('plugins');

export enum ExtensionPoint {
  MESSAGE_PREPROCESS = 'message.preprocess',
  INTENT_POSTPROCESS = 'intent.postprocess',
  TASK_PREPROCESS = 'task.preprocess',
  TASK_POSTPROCESS = 'task.postprocess',
  RESPONSE_PREPROCESS = 'response.preprocess',
}

// 扩展点处理函数类型定义
export type MessagePreprocessHandler = (message: ParsedMessage) => Promise<ParsedMessage | void>;
export type IntentPostprocessHandler = (intent: EnhancedIntent, message: ParsedMessage) => Promise<EnhancedIntent | void>;
export type TaskPreprocessHandler = (taskDescription: string, message: ParsedMessage) => Promise<string | void>;
export type TaskPostprocessHandler = (result: unknown, message: ParsedMessage) => Promise<unknown | void>;
export type ResponsePreprocessHandler = (response: string, message: ParsedMessage) => Promise<string | void>;

export type ExtensionHandler =
  | MessagePreprocessHandler
  | IntentPostprocessHandler
  | TaskPreprocessHandler
  | TaskPostprocessHandler
  | ResponsePreprocessHandler;

export interface Extension {
  point: ExtensionPoint;
  handler: ExtensionHandler;
  priority: number;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  onLoad?: () => Promise<void> | void;
  onUnload?: () => Promise<void> | void;
  extensions: Extension[];
}

export class PluginManager {
  private plugins: Map<string, Plugin> = new Map();
  // 按照扩展点分类存储，且按照 priority 降序排列
  private extensions: Map<ExtensionPoint, Extension[]> = new Map();

  constructor() {
    for (const point of Object.values(ExtensionPoint)) {
      this.extensions.set(point, []);
    }
  }

  /**
   * 注册插件
   */
  async register(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      log.warn({ pluginName: plugin.name }, '插件已注册，将被覆盖');
    }

    try {
      if (plugin.onLoad) {
        await plugin.onLoad();
      }

      this.plugins.set(plugin.name, plugin);

      for (const ext of plugin.extensions) {
        const list = this.extensions.get(ext.point);
        if (list) {
          list.push(ext);
          // 优先级高的排在前面
          list.sort((a, b) => b.priority - a.priority);
        }
      }

      log.info({ pluginName: plugin.name, extensionsCount: plugin.extensions.length }, '插件注册成功');
    } catch (error) {
      log.error({ pluginName: plugin.name, error }, '插件加载失败');
      throw error;
    }
  }

  /**
   * 卸载插件
   */
  async unregister(pluginName: string): Promise<void> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return;
    }

    try {
      if (plugin.onUnload) {
        await plugin.onUnload();
      }

      // 移除该插件对应的所有扩展点
      for (const list of this.extensions.values()) {
        const filtered = list.filter((ext) => !plugin.extensions.includes(ext));
        // 重新赋值给原数组（这里通过清空再 push，以保持引用，或者直接更新 map）
        list.length = 0;
        list.push(...filtered);
      }

      this.plugins.delete(pluginName);
      log.info({ pluginName }, '插件已卸载');
    } catch (error) {
      log.error({ pluginName, error }, '插件卸载失败');
    }
  }

  /**
   * 执行 MESSAGE_PREPROCESS 扩展点
   */
  async executeMessagePreprocess(message: ParsedMessage): Promise<ParsedMessage> {
    let currentMessage = message;
    const exts = this.extensions.get(ExtensionPoint.MESSAGE_PREPROCESS) || [];

    for (const ext of exts) {
      const handler = ext.handler as MessagePreprocessHandler;
      try {
        const result = await handler(currentMessage);
        if (result) {
          currentMessage = result;
        }
      } catch (error) {
        log.error({ point: ext.point, error }, '插件执行失败');
      }
    }
    return currentMessage;
  }

  /**
   * 执行 INTENT_POSTPROCESS 扩展点
   */
  async executeIntentPostprocess(intent: EnhancedIntent, message: ParsedMessage): Promise<EnhancedIntent> {
    let currentIntent = intent;
    const exts = this.extensions.get(ExtensionPoint.INTENT_POSTPROCESS) || [];

    for (const ext of exts) {
      const handler = ext.handler as IntentPostprocessHandler;
      try {
        const result = await handler(currentIntent, message);
        if (result) {
          currentIntent = result;
        }
      } catch (error) {
        log.error({ point: ext.point, error }, '插件执行失败');
      }
    }
    return currentIntent;
  }

  /**
   * 执行 TASK_PREPROCESS 扩展点
   */
  async executeTaskPreprocess(taskDescription: string, message: ParsedMessage): Promise<string> {
    let currentDesc = taskDescription;
    const exts = this.extensions.get(ExtensionPoint.TASK_PREPROCESS) || [];

    for (const ext of exts) {
      const handler = ext.handler as TaskPreprocessHandler;
      try {
        const result = await handler(currentDesc, message);
        if (result) {
          currentDesc = result;
        }
      } catch (error) {
        log.error({ point: ext.point, error }, '插件执行失败');
      }
    }
    return currentDesc;
  }

  /**
   * 执行 TASK_POSTPROCESS 扩展点
   */
  async executeTaskPostprocess(result: unknown, message: ParsedMessage): Promise<unknown> {
    let currentResult = result;
    const exts = this.extensions.get(ExtensionPoint.TASK_POSTPROCESS) || [];

    for (const ext of exts) {
      const handler = ext.handler as TaskPostprocessHandler;
      try {
        const res = await handler(currentResult, message);
        if (res) {
          currentResult = res;
        }
      } catch (error) {
        log.error({ point: ext.point, error }, '插件执行失败');
      }
    }
    return currentResult;
  }

  /**
   * 执行 RESPONSE_PREPROCESS 扩展点
   */
  async executeResponsePreprocess(response: string, message: ParsedMessage): Promise<string> {
    let currentResponse = response;
    const exts = this.extensions.get(ExtensionPoint.RESPONSE_PREPROCESS) || [];

    for (const ext of exts) {
      const handler = ext.handler as ResponsePreprocessHandler;
      try {
        const res = await handler(currentResponse, message);
        if (res) {
          currentResponse = res;
        }
      } catch (error) {
        log.error({ point: ext.point, error }, '插件执行失败');
      }
    }
    return currentResponse;
  }

  // 获取所有已注册插件信息
  getRegisteredPlugins(): { name: string; version: string; description: string }[] {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
    }));
  }
}

// 导出一个全局单例供全系统使用
export const pluginManager = new PluginManager();
