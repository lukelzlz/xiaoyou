import { MessageParser } from './parser.js';
import type { ParsedMessage, RawMessage } from '../types/index.js';

export class GatewayService {
  private parser: MessageParser;

  constructor() {
    this.parser = new MessageParser();
  }

  parseMessage(raw: RawMessage): ParsedMessage {
    return this.parser.parse(raw);
  }
}
