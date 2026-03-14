import { describe, expect, it } from 'vitest';
import { MessageParser } from '../../src/gateway/parser.js';

describe('MessageParser', () => {
  const parser = new MessageParser();

  it('应该清理 mention 并提取 URL 与日期实体', () => {
    const parsed = parser.parse({
      platform: 'discord',
      channelId: 'channel-1',
      userId: 'user-1',
      content: '<@123456> 请查看 https://example.com ，提醒我在 2026-03-20 处理',
      timestamp: Date.now(),
    });

    expect(parsed.textContent).toBe('请查看 https://example.com ，提醒我在 2026-03-20 处理');
    expect(parsed.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'url',
          value: 'https://example.com',
        }),
        expect.objectContaining({
          type: 'date',
          value: '2026-03-20',
        }),
      ]),
    );
  });

  it('应该为消息生成基本结构', () => {
    const parsed = parser.parse({
      platform: 'telegram',
      channelId: '10001',
      userId: '20002',
      content: '你好',
      timestamp: 1710000000000,
      replyTo: 'prev-msg',
    });

    expect(parsed.id).toBeTruthy();
    expect(parsed.platform).toBe('telegram');
    expect(parsed.channelId).toBe('10001');
    expect(parsed.userId).toBe('20002');
    expect(parsed.metadata.replyTo).toBe('prev-msg');
    expect(parsed.timestamp).toBeInstanceOf(Date);
  });
});
