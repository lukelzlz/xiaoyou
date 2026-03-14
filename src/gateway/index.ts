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

  parseMessage(raw: RawMessage): ParsedMessage {
    return this.parser.parse(raw);
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
}

export { MultimodalExtractor, RateLimiter };
