import { MessageParser } from './parser.js';
import { MultimodalExtractor } from './multimodal.js';
import { RateLimiter } from './ratelimit.js';
import type { ParsedMessage, RawMessage, Attachment } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('gateway');

export class GatewayService {
  private parser: MessageParser;
  private multimodal: MultimodalExtractor;
  private rateLimiter: RateLimiter;

  constructor() {
    this.parser = new MessageParser();
    this.multimodal = new MultimodalExtractor();
    this.rateLimiter = new RateLimiter();
  }

  async parseMessage(raw: RawMessage): Promise<ParsedMessage> {
    const parsed = this.parser.parse(raw);

    if (!parsed.attachments.length) {
      return parsed;
    }

    const multimodalContents = await this.extractMultimodal(parsed.attachments);
    const multimodalSummary = this.buildMultimodalSummary(multimodalContents);

    return {
      ...parsed,
      multimodalContents,
      metadata: {
        ...parsed.metadata,
        multimodalSummary,
      },
    };
  }

  async extractMultimodal(attachments: Attachment[]) {
    return this.multimodal.extract(attachments);
  }

  checkRateLimit(userId: string): boolean {
    return this.rateLimiter.check(userId);
  }

  getRateLimitRemaining(userId: string) {
    return this.rateLimiter.getRemaining(userId);
  }

  destroy(): void {
    this.rateLimiter.destroy();
    log.info('网关服务已销毁');
  }

  private buildMultimodalSummary(contents: NonNullable<ParsedMessage['multimodalContents']>): string {
    if (!contents.length) {
      return '';
    }

    return contents
      .map((item, index) => {
        const text = item.extractedText ? `文本: ${item.extractedText}` : '文本: 无';
        const labels = item.labels?.length ? `标签: ${item.labels.join('、')}` : '标签: 无';
        return `附件${index + 1}(${item.type}) - ${text}; ${labels}`;
      })
      .join('\n');
  }
}

export { MultimodalExtractor, RateLimiter };
