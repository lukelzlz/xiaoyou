import { createChildLogger } from '../utils/logger.js';
import { createBraveSearchTool } from './brave-search.js';
import { createMemorySearchTool, createMemoryStoreTool } from './memory.js';

const log = createChildLogger('tools');

type JSONSchema = Record<string, unknown>;

function normalizeInput(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function extractUrls(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s]+/g);
  return matches ?? [];
}

function splitSentences(input: string): string[] {
  return input
    .split(/[。！？!?\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface ToolDefinition<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiredPermissions?: string[];
  timeout?: number;
  execute(params: TParams): Promise<string>;
}

export interface ToolExecutionContext {
  permissions?: string[];
  timeout?: number;
}

interface ObjectSchemaProperty {
  type?: string;
  enum?: unknown[];
}

interface ToolDescriptor {
  name: string;
  description: string;
  requiredPermissions: string[];
  timeout: number;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.validateDefinition(tool);
    this.tools.set(tool.name, tool);
    log.info({ tool: tool.name }, '工具已注册');
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      log.info({ tool: name }, '工具已移除');
    }
    return removed;
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  discover(query: string): ToolDefinition[] {
    if (!query) {
      return this.list();
    }
    const normalized = normalizeInput(query).toLowerCase();
    return this.list().filter((tool) => {
      return (
        tool.name.toLowerCase().includes(normalized) ||
        tool.description.toLowerCase().includes(normalized)
      );
    });
  }

  describe(name: string): ToolDescriptor | null {
    const tool = this.get(name);
    if (!tool) {
      return null;
    }

    return {
      name: tool.name,
      description: tool.description,
      requiredPermissions: tool.requiredPermissions ?? [],
      timeout: tool.timeout ?? 10_000,
    };
  }

  async invoke(
    name: string,
    params: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ): Promise<string> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`工具不存在: ${name}`);
    }

    this.checkPermissions(tool, context.permissions ?? []);
    this.validateParams(tool, params);

    const timeout = context.timeout ?? tool.timeout ?? 10_000;
    return this.withTimeout(tool.execute(params), timeout, name);
  }

  private checkPermissions(tool: ToolDefinition, permissions: string[]): void {
    if (!tool.requiredPermissions || tool.requiredPermissions.length === 0) {
      return;
    }

    const missing = tool.requiredPermissions.filter((permission) => !permissions.includes(permission));
    if (missing.length > 0) {
      throw new Error(`工具 ${tool.name} 缺少权限: ${missing.join(', ')}`);
    }
  }

  private validateDefinition(tool: ToolDefinition): void {
    if (!tool.name.trim()) {
      throw new Error('工具名称不能为空');
    }

    if (this.tools.has(tool.name)) {
      log.warn({ tool: tool.name }, '工具已存在，将执行覆盖注册');
    }

    const schemaType = tool.parameters?.type;
    if (schemaType && schemaType !== 'object') {
      throw new Error(`工具 ${tool.name} 的参数 schema 必须为 object`);
    }
  }

  private validateParams(tool: ToolDefinition, params: Record<string, unknown>): void {
    const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
    const properties = (tool.parameters.properties as Record<string, ObjectSchemaProperty> | undefined) ?? {};
    const allowAdditional = tool.parameters.additionalProperties !== false;

    for (const key of required) {
      const value = params[key as string];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        throw new Error(`工具 ${tool.name} 缺少必填参数: ${String(key)}`);
      }
    }

    for (const [key, value] of Object.entries(params)) {
      const schema = properties[key];
      if (!schema) {
        if (!allowAdditional) {
          throw new Error(`工具 ${tool.name} 不允许额外参数: ${key}`);
        }
        continue;
      }

      if (schema.type === 'string' && typeof value !== 'string') {
        throw new Error(`工具 ${tool.name} 参数 ${key} 必须为 string`);
      }
      if (schema.type === 'number' && typeof value !== 'number') {
        throw new Error(`工具 ${tool.name} 参数 ${key} 必须为 number`);
      }
      if (schema.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`工具 ${tool.name} 参数 ${key} 必须为 boolean`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        throw new Error(`工具 ${tool.name} 参数 ${key} 不在允许范围内`);
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeout: number, name: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`工具 ${name} 执行超时 (${timeout}ms)`)), timeout);
      }),
    ]);
  }
}

export class ExtractTool implements ToolDefinition<{ content: string }> {
  name = 'extract';
  description = '提取文本中的结构化信息';
  parameters: JSONSchema = {
    type: 'object',
    properties: {
      content: { type: 'string' },
    },
    required: ['content'],
    additionalProperties: false,
  };
  timeout = 8_000;

  async execute(params: { content: string }): Promise<string> {
    const content = params.content.trim();
    log.debug({ preview: content.slice(0, 100) }, '执行提取');

    const urls = extractUrls(content);
    const sentences = splitSentences(content);
    const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    const dates = content.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g) ?? [];
    const numbers = content.match(/\d+(?:\.\d+)?/g) ?? [];

    const summary = sentences.slice(0, 3).join('；') || content.slice(0, 120);

    return [
      '提取结果：',
      `- 摘要：${summary || '无'}`,
      `- 链接数：${urls.length}`,
      `- 邮箱数：${emails.length}`,
      `- 日期数：${dates.length}`,
      `- 数字数：${numbers.length}`,
      urls.length > 0 ? `- 链接列表：${urls.join('、')}` : '- 链接列表：无',
      emails.length > 0 ? `- 邮箱列表：${emails.join('、')}` : '- 邮箱列表：无',
      dates.length > 0 ? `- 日期列表：${dates.join('、')}` : '- 日期列表：无',
    ].join('\n');
  }
}

export class QueryTool implements ToolDefinition<{ query: string }> {
  name = 'query';
  description = '执行轻量查询请求，如获取时间、日期等系统信息';
  parameters: JSONSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询内容，支持：时间、日期' },
    },
    required: ['query'],
    additionalProperties: false,
  };
  timeout = 5_000;

  async execute(params: { query: string }): Promise<string> {
    const query = normalizeInput(params.query);
    log.debug({ query }, '执行查询');

    const lowered = query.toLowerCase();

    if (lowered.includes('time') || query.includes('时间')) {
      return `当前时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }

    if (lowered.includes('date') || query.includes('日期')) {
      return `今天日期: ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }

    if (lowered.includes('week') || query.includes('星期') || query.includes('周')) {
      const days = ['日', '一', '二', '三', '四', '五', '六'];
      return `今天是星期${days[new Date().getDay()]}`;
    }

    throw new Error(`不支持的查询类型: ${query}。支持的查询：时间、日期、星期`);
  }
}

export const defaultToolRegistry = new ToolRegistry();

export function registerTool(tool: ToolDefinition): void {
  defaultToolRegistry.register(tool);
}

export function unregisterTool(name: string): boolean {
  return defaultToolRegistry.unregister(name);
}

export function discoverTools(query: string = ''): ToolDefinition[] {
  return defaultToolRegistry.discover(query);
}

export function describeTool(name: string): ToolDescriptor | null {
  return defaultToolRegistry.describe(name);
}

export async function invokeTool(
  name: string,
  params: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<string> {
  return defaultToolRegistry.invoke(name, params, context);
}

registerTool(new ExtractTool());
registerTool(new QueryTool());
registerTool(createBraveSearchTool());
registerTool(createMemorySearchTool());
registerTool(createMemoryStoreTool());
