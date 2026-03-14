import { Bot, Context } from 'grammy';
import type { ControllerService } from '../../controller/index.js';
import type { GatewayService } from '../../gateway/index.js';
import type { PlatformAdapter, ResponseContent } from '../../types/index.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('telegram-adapter');

interface TelegramAdapterOptions {
  token: string;
  gateway: GatewayService;
  controller: ControllerService;
}

export class TelegramAdapter implements PlatformAdapter {
  private bot: Bot;
  private gateway: GatewayService;
  private controller: ControllerService;

  constructor(options: TelegramAdapterOptions) {
    this.bot = new Bot(options.token);
    this.gateway = options.gateway;
    this.controller = options.controller;
  }

  async start(): Promise<void> {
    this.bot.on('message', this.handleMessage.bind(this));
    this.bot.start();
    log.info('Telegram 适配器已启动');
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendMessage(channelId: string, content: ResponseContent): Promise<void> {
    const chatId = Number(channelId);

    if (content.type === 'text') {
      await this.bot.api.sendMessage(chatId, content.content);
      return;
    }

    if (content.type === 'image') {
      await this.bot.api.sendPhoto(chatId, content.url, {
        caption: content.caption,
      });
      return;
    }

    if (content.type === 'file') {
      await this.bot.api.sendDocument(chatId, content.url);
      return;
    }

    if (content.type === 'embed') {
      const text = `*${content.title}*\n\n${content.description}`;
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(channelId), 'typing');
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || message.from?.is_bot) return;

    try {
      const userId = String(message.from?.id ?? 0);
      if (!this.gateway.checkRateLimit(userId)) {
        log.warn({ userId }, 'Telegram 用户触发速率限制');
        await ctx.reply('您发送消息的速度太快了，请稍后再试。');
        return;
      }

      const attachments = this.extractAttachments(message);
      let content = message.text ?? '';

      if (attachments.length > 0) {
        const multimodalContents = await this.gateway.extractMultimodal(attachments);
        for (const mc of multimodalContents) {
          if (mc.extractedText) {
            content += `\n[${mc.type} 提取内容]: ${mc.extractedText}`;
          }
        }
      }

      const parsed = await this.gateway.parseMessage({
        platform: 'telegram',
        channelId: String(message.chat.id),
        userId,
        content,
        attachments,
        timestamp: message.date * 1000,
      });

      await this.sendTyping(String(message.chat.id));
      const response = await this.controller.handleMessage(parsed);
      await ctx.reply(response);
    } catch (error) {
      log.error({ error }, 'Telegram 消息处理失败');
      await ctx.reply('抱歉，处理您的请求时出现了问题。');
    }
  }

  private extractAttachments(message: Context['message']): Array<{
    type: 'image' | 'document' | 'audio' | 'video';
    url: string;
    name: string;
  }> {
    if (!message) return [];

    const attachments: Array<{
      type: 'image' | 'document' | 'audio' | 'video';
      url: string;
      name: string;
    }> = [];

    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      attachments.push({
        type: 'image',
        url: largest.file_id,
        name: 'photo.jpg',
      });
    }

    if (message.document) {
      attachments.push({
        type: 'document',
        url: message.document.file_id,
        name: message.document.file_name ?? 'document',
      });
    }

    if (message.audio) {
      attachments.push({
        type: 'audio',
        url: message.audio.file_id,
        name: message.audio.file_name ?? 'audio',
      });
    }

    if (message.video) {
      attachments.push({
        type: 'video',
        url: message.video.file_id,
        name: message.video.file_name ?? 'video',
      });
    }

    return attachments;
  }
}
