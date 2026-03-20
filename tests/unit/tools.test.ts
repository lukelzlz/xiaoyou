import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ToolRegistry,
  ExtractTool,
  QueryTool,
  describeTool,
  discoverTools,
  invokeTool,
  registerTool,
  unregisterTool,
} from '../../src/tools/index.js';
import { BraveSearchTool } from '../../src/tools/brave-search.js';
import { MemoryTool, MemoryStoreTool } from '../../src/tools/memory.js';

describe('ToolRegistry', () => {
  it('应该校验必填参数和额外参数', async () => {
    const registry = new ToolRegistry();
    registry.register(new ExtractTool());

    await expect(registry.invoke('extract', {})).rejects.toThrow('缺少必填参数');
    await expect(registry.invoke('extract', { content: '测试', extra: true })).rejects.toThrow('不允许额外参数');
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

describe('QueryTool', () => {
  const tool = new QueryTool();

  it('应该返回当前时间', async () => {
    const result = await tool.execute({ query: '查询时间' });
    expect(result).toContain('当前时间');
  });

  it('应该返回当前日期', async () => {
    const result = await tool.execute({ query: '今天日期' });
    expect(result).toContain('今天日期');
  });

  it('应该返回星期', async () => {
    const result = await tool.execute({ query: '今天是星期几' });
    expect(result).toContain('今天是星期');
  });

  it('应该支持英文查询', async () => {
    const result = await tool.execute({ query: 'what time' });
    expect(result).toContain('当前时间');
  });

  it('应该拒绝不支持的查询类型', async () => {
    await expect(tool.execute({ query: '天气怎么样' })).rejects.toThrow('不支持的查询类型');
  });
});

describe('BraveSearchTool', () => {
  it('应该定义正确的工具名称和参数', () => {
    const tool = new BraveSearchTool();
    expect(tool.name).toBe('brave_search');
    expect(tool.description).toContain('搜索');
    expect(tool.parameters.required).toContain('query');
    expect(tool.timeout).toBe(15_000);
  });

  it('应该正确格式化搜索结果', () => {
    const tool = new BraveSearchTool();
    // Access private method via type assertion
    const formatResults = (tool as unknown as { formatResults: (data: { web?: { results?: Array<{ title: string; url: string; description: string }> }; news?: { results?: Array<{ title: string; url: string; description: string; age?: string }> } }, q: string) => string }).formatResults.bind(tool);

    const result = formatResults({
      web: {
        results: [
          { title: 'Test Title', url: 'https://example.com', description: 'Test description' },
        ],
      },
    }, 'test query');

    expect(result).toContain('搜索: "test query"');
    expect(result).toContain('Test Title');
    expect(result).toContain('https://example.com');
    expect(result).toContain('Test description');
  });

  it('应该格式化新闻结果', () => {
    const tool = new BraveSearchTool();
    const formatResults = (tool as unknown as { formatResults: (data: { web?: { results?: Array<{ title: string; url: string; description: string }> }; news?: { results?: Array<{ title: string; url: string; description: string; age?: string }> } }, q: string) => string }).formatResults.bind(tool);

    const result = formatResults({
      web: { results: [] },
      news: {
        results: [
          { title: 'News Item', url: 'https://news.example.com', description: 'Breaking news', age: '2 hours ago' },
        ],
      },
    }, 'news');

    expect(result).toContain('新闻结果');
    expect(result).toContain('News Item');
    expect(result).toContain('2 hours ago');
  });

  it('应该在无结果时显示提示', () => {
    const tool = new BraveSearchTool();
    const formatResults = (tool as unknown as { formatResults: (data: { web?: { results?: Array<{ title: string; url: string; description: string }> }; news?: { results?: Array<{ title: string; url: string; description: string; age?: string }> } }, q: string) => string }).formatResults.bind(tool);

    const result = formatResults({ web: { results: [] } }, 'nothing');
    expect(result).toContain('未找到相关结果');
  });
});

describe('MemoryTool', () => {
  it('应该定义正确的参数 schema', () => {
    const tool = new MemoryTool();
    expect(tool.name).toBe('memory_search');
    expect(tool.parameters.required).toContain('query');
    expect(tool.timeout).toBe(10_000);
  });
});

describe('MemoryStoreTool', () => {
  it('应该定义正确的参数 schema', () => {
    const tool = new MemoryStoreTool();
    expect(tool.name).toBe('memory_store');
    expect(tool.parameters.required).toContain('content');
    expect(tool.timeout).toBe(10_000);
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
