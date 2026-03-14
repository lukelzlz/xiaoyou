import { nanoid } from 'nanoid';
import type { RawMessage, ParsedMessage, Entity } from '../types/index.js';

export class MessageParser {
  parse(raw: RawMessage): ParsedMessage {
    return {
      id: nanoid(),
      platform: raw.platform,
      channelId: raw.channelId,
      userId: raw.userId,
      rawContent: raw.content,
      textContent: this.cleanText(raw.content),
      entities: this.extractEntities(raw.content),
      attachments: raw.attachments ?? [],
      timestamp: new Date(raw.timestamp),
      metadata: {
        platform: raw.platform,
        guildId: raw.guildId,
        replyTo: raw.replyTo,
      },
    };
  }

  private cleanText(content: string): string {
    let cleaned = content.replace(/<@!?\d+>/g, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
  }

  private extractEntities(content: string): Entity[] {
    const entities: Entity[] = [];

    const urlRegex = /https?:\/\/[^\s]+/g;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(content)) !== null) {
      entities.push({
        type: 'url',
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    const dateRegex = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g;
    while ((match = dateRegex.exec(content)) !== null) {
      entities.push({
        type: 'date',
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    return entities;
  }
}
