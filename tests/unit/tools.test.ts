import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  SearchTool,
  describeTool,
  discoverTools,
  invokeTool,
  registerTool,
  unregisterTool,
} from '../../src/tools/index.js';

describe('ToolRegistry', () => {
  it('应该校验必填参数和额外参数', async () => {
    const registry = new ToolRegistry();
    registry.register(new SearchTool());

    await expect(registry.invoke('search', {})).rejects.toThrow('缺少必填参数');
    await expect(registry.invoke('search', { query: '测试', extra: true })).rejects.toThrow('不允许额外参数');
  });

  it('应该检查权限并返回工具描述', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'secure-tool',
      description: '需要权限的工具',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
        required: ['input'],
        additionalProperties: false,
      },
      requiredPermissions: ['tool.secure'],
      timeout: 2000,
      async execute(params: Record<string, unknown>) {
        return `ok:${String(params.input)}`;
      },
    });

    expect(registry.describe('secure-tool')).toEqual({
      name: 'secure-tool',
      description: '需要权限的工具',
      requiredPermissions: ['tool.secure'],
      timeout: 2000,
    });

    await expect(registry.invoke('secure-tool', { input: 'x' })).rejects.toThrow('缺少权限');
    await expect(
      registry.invoke('secure-tool', { input: 'x' }, { permissions: ['tool.secure'] }),
    ).resolves.toBe('ok:x');
  });
});

describe('default tool registry exports', () => {
  it('应该支持 discover、describe、register 与 unregister', async () => {
    registerTool({
      name: 'tmp-tool',
      description: '临时工具',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
      async execute(params: Record<string, unknown>) {
        return `value:${String(params.value)}`;
      },
    });

    expect(discoverTools('临时')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tmp-tool' })]),
    );
    expect(describeTool('tmp-tool')).toEqual(
      expect.objectContaining({ name: 'tmp-tool', description: '临时工具' }),
    );
    await expect(invokeTool('tmp-tool', { value: 'abc' })).resolves.toBe('value:abc');
    expect(unregisterTool('tmp-tool')).toBe(true);
  });
});
