import {
  Client,
  GatewayIntentBits,
  Message,
} from 'discord.js';
import type { ControllerService } from '../../controller/index.js';
import type { GatewayService } from '../../gateway/index.js';
import type { PlatformAdapter, ResponseContent } from '../../types/index.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('discord-adapter');

interface DiscordAdapterOptions {
  token: string;
  gateway: GatewayService;
  controller: ControllerService;
}

export class DiscordAdapter implements PlatformAdapter {
  private client: Client;
  private gateway: GatewayService;
  private controller: ControllerService;
  private token: string;

  constructor(options: DiscordAdapterOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.gateway = options.gateway;
    this.controller = options.controller;
    this.token = options.token;
  }

  async start(): Promise<void> {
    this.client.on('messageCreate', this.handleMessage.bind(this));
    await this.client.login(this.token);
    log.info('Discord 适配器已启动');
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async sendMessage(channelId: string, content: ResponseContent): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    if (content.type === 'text') {
      await channel.send(content.content);
      return;
    }

    if (content.type === 'embed') {
      await channel.send({
        embeds: [
          {
            title: content.title,
            description: content.description,
            fields: content.fields,
          },
        ],
      });
      return;
    }

    if (content.type === 'image') {
      await channel.send({
        content: content.caption,
        files: [content.url],
      });
      return;
    }

    if (content.type === 'file') {
      await channel.send({ files: [content.url] });
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'sendTyping' in channel) {
      await channel.sendTyping();
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    try {
      const parsed = this.gateway.parseMessage({
        platform: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        content: message.content,
        attachments: [...message.attachments.values()].map((attachment) => ({
          type: this.getAttachmentType(attachment.contentType ?? ''),
          url: attachment.url,
          name: attachment.name ?? 'attachment',
          mimeType: attachment.contentType ?? undefined,
          size: attachment.size,
        })),
        timestamp: message.createdTimestamp,
        guildId: message.guildId ?? undefined,
        replyTo: message.reference?.messageId,
      });

      await this.sendTyping(message.channelId);
      const response = await this.controller.handleMessage(parsed);
      await message.reply(response);
    } catch (error) {
      log.error({ error }, 'Discord 消息处理失败');
      await message.reply('抱歉，处理您的请求时出现了问题。');
    }
  }

  private getAttachmentType(mimeType: string): 'image' | 'document' | 'audio' | 'video' {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
  }
}
