import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('tools');

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

export class SearchTool {
  async execute(params: { query: string }): Promise<string> {
    const query = normalizeInput(params.query);
    log.debug({ query }, '执行搜索');

    const urls = extractUrls(query);
    const keywords = query
      .replace(/https?:\/\/[^\s]+/g, '')
      .split(/[\s,，、]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .slice(0, 8);

    const lines = [
      `搜索请求已解析：${query}`,
      keywords.length > 0 ? `关键词：${keywords.join('、')}` : '关键词：未提取到明显关键词',
      urls.length > 0 ? `链接：${urls.join('、')}` : '链接：无',
      '说明：当前为项目内占位实现，后续可接入真实搜索 API。',
    ];

    return lines.join('\n');
  }
}

export class ExtractTool {
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

export class QueryTool {
  async execute(params: { query: string }): Promise<string> {
    const query = normalizeInput(params.query);
    log.debug({ query }, '执行查询');

    const lowered = query.toLowerCase();

    if (lowered.includes('time') || query.includes('时间')) {
      return `查询结果：当前系统时间为 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }

    if (lowered.includes('date') || query.includes('日期')) {
      return `查询结果：今天日期为 ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }

    return [
      `查询请求：${query}`,
      '当前为占位查询实现，已完成请求标准化与基础意图匹配。',
      '后续可接入数据库、业务 API 或第三方服务。',
    ].join('\n');
  }
}
