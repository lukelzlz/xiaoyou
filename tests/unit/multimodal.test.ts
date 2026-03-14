import { describe, expect, it, vi } from 'vitest';
import { MultimodalExtractor } from '../../src/gateway/multimodal.js';
import type { Attachment } from '../../src/types/index.js';

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
    });
  });

  it('当单个附件提取失败时应该返回错误 metadata 而不是整体抛错', async () => {
    const extractor = new MultimodalExtractor();
    const spy = vi
      .spyOn(extractor as unknown as { mockOCR: (url: string) => Promise<unknown> }, 'mockOCR')
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
    expect(result[0].metadata).toMatchObject({ error: true });

    spy.mockRestore();
  });
});