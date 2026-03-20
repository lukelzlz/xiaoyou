/**
 * Brave Search 工具
 * 使用 Brave Search API 进行网络搜索
 */

import { createChildLogger } from '../utils/logger.js';
import type { ToolDefinition } from './index.js';

const log = createChildLogger('brave-search');

// Brave Search API 配置
const BRAVE_API_URL = process.env.BRAVE_API_URL || 'https://api.search.brave.com/res/v1';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
  news?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
      age?: string;
    }>;
  };
}

/**
 * Brave Search 工具
 * 使用 Brave Search API 进行网络搜索
 */
export class BraveSearchTool implements ToolDefinition<{ query: string; count?: number }> {
  name = 'brave_search';
  description = '使用 Brave Search API 搜索网络信息，返回相关网页链接和摘要';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或问题',
      },
      count: {
        type: 'number',
        description: '返回结果数量，默认 5，最多 10',
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
  timeout = 15_000;

  async execute(params: { query: string; count?: number }): Promise<string> {
    const { query, count = 5 } = params;
    const limit = Math.min(count, 10);

    log.debug({ query, limit }, '执行 Brave 搜索');

    if (!BRAVE_API_KEY) {
      throw new Error('Brave Search API 未配置，请设置 BRAVE_API_KEY 环境变量');
    }

    try {
      const url = new URL(`${BRAVE_API_URL}/web/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));
      url.searchParams.set('search_lang', 'zh-hans');
      url.searchParams.set('country', 'cn');

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Brave API 请求失败 (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as BraveSearchResponse;
      return this.formatResults(data, query);
    } catch (error) {
      log.error({ error, query }, 'Brave 搜索异常');
      throw error;
    }
  }

  /**
   * 格式化搜索结果
   */
  private formatResults(data: BraveSearchResponse, query: string): string {
    const lines: string[] = [`搜索: "${query}"`, ''];

    // 网页结果
    const webResults = data.web?.results ?? [];
    if (webResults.length > 0) {
      lines.push('## 网页结果');
      for (let i = 0; i < webResults.length; i++) {
        const result = webResults[i];
        lines.push(`${i + 1}. **${result.title}**`);
        lines.push(`   ${result.url}`);
        if (result.description) {
          lines.push(`   ${result.description.slice(0, 200)}${result.description.length > 200 ? '...' : ''}`);
        }
        lines.push('');
      }
    }

    // 新闻结果
    const newsResults = data.news?.results ?? [];
    if (newsResults.length > 0) {
      lines.push('## 新闻结果');
      for (let i = 0; i < Math.min(newsResults.length, 3); i++) {
        const result = newsResults[i];
        lines.push(`${i + 1}. **${result.title}**${result.age ? ` (${result.age})` : ''}`);
        lines.push(`   ${result.url}`);
        if (result.description) {
          lines.push(`   ${result.description.slice(0, 150)}...`);
        }
        lines.push('');
      }
    }

    if (webResults.length === 0 && newsResults.length === 0) {
      lines.push('未找到相关结果。');
    }

    return lines.join('\n');
  }

}

/**
 * 创建并注册 Brave Search 工具
 */
export function createBraveSearchTool(): ToolDefinition<{ query: string; count?: number }> {
  return new BraveSearchTool();
}
