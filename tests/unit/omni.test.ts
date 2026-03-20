import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OmniService } from '../../src/llm/omni.js';
import type { VisionAnalysisResult } from '../../src/llm/quick.js';

// 模拟配置
vi.mock('../../src/config/index.js', () => ({
  config: {
    logLevel: 'info',
    env: 'test',
    omni: {
      apiKey: 'test-omni-key',
      apiUrl: 'https://api.test.com/v1',
      model: 'test-omni-model',
      maxTokens: 4096,
      timeout: 60000,
    },
  },
}));

// 模拟 OpenAI 客户端
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: '测试图片分析结果',
                  labels: ['screenshot', 'code'],
                  confidence: 0.92,
                  metadata: { scene: 'editor' },
                }),
              },
            },
          ],
        }),
      },
    },
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({
          text: '这是一段测试音频的转录结果',
        }),
      },
    },
  })),
}));

describe('OmniService', () => {
  let service: OmniService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new OmniService();
  });

  describe('analyzeVision', () => {
    it('应该分析图片并返回结构化结果', async () => {
      const result = await service.analyzeVision({
        url: 'https://example.com/test.png',
        type: 'image',
        name: 'test.png',
        mimeType: 'image/png',
      });

      expect(result).toMatchObject({
        text: '测试图片分析结果',
        labels: ['screenshot', 'code'],
        confidence: 0.92,
        metadata: { scene: 'editor' },
      });
    });

    it('应该处理文档类型输入', async () => {
      const result = await service.analyzeVision({
        url: 'https://example.com/test.pdf',
        type: 'document',
        name: 'test.pdf',
        mimeType: 'application/pdf',
      });

      expect(result.text).toBeDefined();
      expect(result.labels).toBeInstanceOf(Array);
    });

    it('应该处理自定义指令', async () => {
      const result = await service.analyzeVision(
        {
          url: 'https://example.com/chart.png',
          type: 'image',
          name: 'chart.png',
        },
        '请分析这个图表中的数据趋势',
      );

      expect(result.text).toBeDefined();
    });

    it('应该在返回格式不完整时提供默认值', async () => {
      // 模拟返回不完整的 JSON
      const client = Reflect.get(service, 'client') as {
        chat: {
          completions: {
            create: ReturnType<typeof vi.fn>;
          };
        };
      };
      client.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ text: '只有文本' }),
            },
          },
        ],
      });

      const result = await service.analyzeVision({
        url: 'https://example.com/test.png',
        type: 'image',
      });

      expect(result.text).toBe('只有文本');
      expect(result.labels).toEqual([]);
      expect(result.confidence).toBe(0.6); // 默认值
      expect(result.metadata).toEqual({});
    });
  });

  describe('analyzeVideo', () => {
    it('应该通过视觉模型分析视频', async () => {
      const result = await service.analyzeVideo({
        url: 'https://example.com/test.mp4',
        name: 'test.mp4',
        mimeType: 'video/mp4',
      });

      expect(result.text).toBeDefined();
      expect(result.labels).toBeInstanceOf(Array);
    });

    it('应该支持自定义分析指令', async () => {
      const result = await service.analyzeVideo(
        {
          url: 'https://example.com/test.mp4',
          name: 'test.mp4',
        },
        '请描述视频中出现的人物和场景',
      );

      expect(result.text).toBeDefined();
    });
  });

  describe('transcribeAudio', () => {
    it('应该转录音频并返回结果', async () => {
      // 模拟 fetch 返回音频文件
      global.fetch = vi.fn().mockResolvedValue({
        blob: () => Promise.resolve(new Blob(['fake-audio'], { type: 'audio/mpeg' })),
      });

      const result = await service.transcribeAudio({
        url: 'https://example.com/test.mp3',
        name: 'test.mp3',
        mimeType: 'audio/mpeg',
      });

      expect(result).toMatchObject({
        text: '这是一段测试音频的转录结果',
        confidence: 0.9,
      });
    });

    it('应该在 fetch 失败时抛出错误', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(
        service.transcribeAudio({
          url: 'https://example.com/test.mp3',
        }),
      ).rejects.toThrow('Network error');
    });
  });
});
