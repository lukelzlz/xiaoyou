import { describe, expect, it, vi } from 'vitest';
import { MultimodalExtractor } from '../../src/gateway/multimodal.js';
import { GatewayService } from '../../src/gateway/index.js';
import { OmniService } from '../../src/llm/omni.js';
import type { Attachment, RawMessage } from '../../src/types/index.js';

describe('MultimodalExtractor', () => {
  it('应该提取图片内容', async () => {
    const extractor = new MultimodalExtractor();
    const attachments: Attachment[] = [
      {
        type: 'image',
        url: 'https://example.com/test.png',
        name: 'test.png',
      },
    ];

    const result = await extractor.extract(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image');
    expect(result[0].extractedText).toContain('图片内容待识别');
    expect(result[0].metadata).toMatchObject({
      sourceName: 'test.png',
      provider: 'mock',
    });
  });

  it('应该提取文档内容并带 metadata', async () => {
    const extractor = new MultimodalExtractor();
    const attachments: Attachment[] = [
      {
        type: 'document',
        url: 'https://example.com/test.pdf',
        name: 'test.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      },
    ];

    const result = await extractor.extract(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('document');
    expect(result[0].metadata).toMatchObject({
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      provider: 'mock',
    });
  });

  it('应该支持注入外部多模态服务', async () => {
    const extractor = new MultimodalExtractor({
      recognizeImage: vi.fn().mockResolvedValue({
        text: '识别出的图片文字',
        labels: ['diagram', 'ui'],
        confidence: 0.91,
      }),
    });

    const result = await extractor.extract([
      {
        type: 'image',
        url: 'https://example.com/diagram.png',
        name: 'diagram.png',
      },
    ]);

    expect(result[0]).toMatchObject({
      extractedText: '识别出的图片文字',
      labels: ['diagram', 'ui'],
      confidence: 0.91,
      metadata: { provider: 'external' },
    });
  });

  it('应该支持基于视觉大语言模型提取图片内容', async () => {
    const omni = {
      analyzeVision: vi.fn().mockResolvedValue({
        text: '截图中显示 TypeScript 编译错误',
        labels: ['screenshot', 'error'],
        confidence: 0.93,
        metadata: { scene: 'terminal' },
      }),
    } as unknown as OmniService;

    const extractor = new MultimodalExtractor({}, omni);
    const result = await extractor.extract([
      {
        type: 'image',
        url: 'https://example.com/error.png',
        name: 'error.png',
      },
    ]);

    expect(result[0]).toMatchObject({
      extractedText: '截图中显示 TypeScript 编译错误',
      labels: ['screenshot', 'error'],
      confidence: 0.93,
      metadata: { provider: 'omni' },
    });
  });

  it('应该构建适合注入控制层的多模态上下文摘要', () => {
    const extractor = new MultimodalExtractor();
    const summary = extractor.buildPromptContext([
      {
        type: 'image',
        url: 'https://example.com/test.png',
        extractedText: '界面上显示 deploy succeeded',
        labels: ['screenshot'],
        confidence: 0.88,
        metadata: { sourceName: 'test.png' },
      },
    ]);

    expect(summary).toContain('附件1');
    expect(summary).toContain('提取文本=界面上显示 deploy succeeded');
    expect(summary).toContain('标签=screenshot');
  });

  it('网关应将多模态摘要写入解析消息 metadata', async () => {
    const gateway = new GatewayService({
      recognizeImage: async () => ({
        text: '终端输出包含 error',
        labels: ['screenshot'],
        confidence: 0.8,
      }),
    });

    const raw: RawMessage = {
      platform: 'discord',
      channelId: 'c1',
      userId: 'u1',
      content: '帮我看看截图',
      timestamp: Date.now(),
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/test.png',
          name: 'test.png',
        },
      ],
    };

    const parsed = await gateway.parseMessage(raw);
    expect(parsed.metadata.multimodalSummary).toContain('终端输出包含 error');
    expect(parsed.multimodalContents).toHaveLength(1);
  });

  it('网关在注入 Omni 服务时应优先走视觉模型链路', async () => {
    const omni = {
      analyzeVision: vi.fn().mockResolvedValue({
        text: '视觉模型识别到控制台报错堆栈',
        labels: ['console', 'error'],
        confidence: 0.96,
        metadata: { scene: 'terminal' },
      }),
    } as unknown as OmniService;

    const gateway = new GatewayService(undefined, omni);
    const raw: RawMessage = {
      platform: 'discord',
      channelId: 'c1',
      userId: 'u1',
      content: '分析这个截图',
      timestamp: Date.now(),
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/runtime-error.png',
          name: 'runtime-error.png',
        },
      ],
    };

    const parsed = await gateway.parseMessage(raw);

    expect(omni.analyzeVision).toHaveBeenCalledTimes(1);
    expect(parsed.metadata.multimodalSummary).toContain('视觉模型识别到控制台报错堆栈');
    expect(parsed.multimodalContents?.[0].metadata).toMatchObject({ provider: 'omni' });
  });

  it('当单个附件提取失败时应该返回错误 metadata 而不是整体抛错', async () => {
    const extractor = new MultimodalExtractor();
    const spy = vi
      .spyOn(extractor as unknown as { mockOCR: (attachment: Attachment) => Promise<unknown> }, 'mockOCR')
      .mockRejectedValueOnce(new Error('OCR failed'));

    const attachments: Attachment[] = [
      {
        type: 'image',
        url: 'https://example.com/bad.png',
        name: 'bad.png',
      },
    ];

    const result = await extractor.extract(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].metadata).toMatchObject({ error: true, sourceName: 'bad.png' });

    spy.mockRestore();
  });
});