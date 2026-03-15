import { describe, expect, it, vi } from 'vitest';
import { PluginManager, ExtensionPoint, type Plugin } from '../../src/plugins/index.js';
import type { ParsedMessage, EnhancedIntent } from '../../src/types/index.js';
import { IntentType } from '../../src/types/index.js';

describe('PluginManager', () => {
  it('应能够注册和卸载插件', async () => {
    const manager = new PluginManager();
    const onLoadSpy = vi.fn();
    const onUnloadSpy = vi.fn();

    const plugin: Plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
      onLoad: onLoadSpy,
      onUnload: onUnloadSpy,
      extensions: [],
    };

    await manager.register(plugin);
    expect(onLoadSpy).toHaveBeenCalledTimes(1);
    expect(manager.getRegisteredPlugins()).toHaveLength(1);
    expect(manager.getRegisteredPlugins()[0].name).toBe('test-plugin');

    await manager.unregister('test-plugin');
    expect(onUnloadSpy).toHaveBeenCalledTimes(1);
    expect(manager.getRegisteredPlugins()).toHaveLength(0);
  });

  it('应按优先级执行 MESSAGE_PREPROCESS 扩展点', async () => {
    const manager = new PluginManager();

    await manager.register({
      name: 'p1',
      version: '1.0.0',
      description: 'p1',
      extensions: [
        {
          point: ExtensionPoint.MESSAGE_PREPROCESS,
          priority: 10,
          handler: async (msg: ParsedMessage) => {
            return { ...msg, textContent: msg.textContent + ' [p1]' };
          },
        },
      ],
    });

    await manager.register({
      name: 'p2',
      version: '1.0.0',
      description: 'p2',
      extensions: [
        {
          point: ExtensionPoint.MESSAGE_PREPROCESS,
          priority: 20, // 优先级更高，先执行
          handler: async (msg: ParsedMessage) => {
            return { ...msg, textContent: msg.textContent + ' [p2]' };
          },
        },
      ],
    });

    const mockMessage = {
      id: '1',
      platform: 'discord',
      textContent: 'hello',
    } as ParsedMessage;

    const result = await manager.executeMessagePreprocess(mockMessage);
    // p2 先执行，然后是 p1
    expect(result.textContent).toBe('hello [p2] [p1]');
  });

  it('扩展点不返回结果时，应透传上一次的结果', async () => {
    const manager = new PluginManager();

    await manager.register({
      name: 'p1',
      version: '1.0.0',
      description: 'p1',
      extensions: [
        {
          point: ExtensionPoint.INTENT_POSTPROCESS,
          priority: 10,
          handler: async (intent: EnhancedIntent) => {
            // 不返回任何内容（void）
          },
        },
      ],
    });

    const mockIntent: EnhancedIntent = {
      type: IntentType.CHAT_CASUAL,
      confidence: 0.9,
      entities: [],
    };

    const mockMessage = {} as ParsedMessage;

    const result = await manager.executeIntentPostprocess(mockIntent, mockMessage);
    expect(result).toBe(mockIntent); // 引用一致
  });

  it('应正确隔离和执行 TASK_PREPROCESS 和 TASK_POSTPROCESS', async () => {
    const manager = new PluginManager();

    await manager.register({
      name: 'p1',
      version: '1.0.0',
      description: 'p1',
      extensions: [
        {
          point: ExtensionPoint.TASK_PREPROCESS,
          priority: 10,
          handler: async (desc: string) => `[PREFIX] ${desc}`,
        },
        {
          point: ExtensionPoint.TASK_POSTPROCESS,
          priority: 10,
          handler: async (res: any) => ({ ...res, injected: true }),
        },
      ],
    });

    const mockMessage = {} as ParsedMessage;

    const preResult = await manager.executeTaskPreprocess('do something', mockMessage);
    expect(preResult).toBe('[PREFIX] do something');

    const postResult = await manager.executeTaskPostprocess({ status: 'success' }, mockMessage);
    expect(postResult).toMatchObject({ status: 'success', injected: true });
  });

  it('插件抛出错误不应中断执行链路', async () => {
    const manager = new PluginManager();

    await manager.register({
      name: 'p1',
      version: '1.0.0',
      description: 'p1',
      extensions: [
        {
          point: ExtensionPoint.RESPONSE_PREPROCESS,
          priority: 20,
          handler: async () => {
            throw new Error('plugin error');
          },
        },
      ],
    });

    await manager.register({
      name: 'p2',
      version: '1.0.0',
      description: 'p2',
      extensions: [
        {
          point: ExtensionPoint.RESPONSE_PREPROCESS,
          priority: 10,
          handler: async (resp: string) => resp + ' (modified)',
        },
      ],
    });

    const mockMessage = {} as ParsedMessage;
    const result = await manager.executeResponsePreprocess('original', mockMessage);

    // 错误被捕获，执行链路继续
    expect(result).toBe('original (modified)');
  });
});
