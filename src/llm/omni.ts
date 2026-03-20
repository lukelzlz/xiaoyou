/**
 * 多模态服务 (Omni)
 * 统一处理视觉和音频识别
 */

import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { OpenAICompatibleClient } from './base.js';
import type { VisionAnalysisResult } from './chat.js';

const log = createChildLogger('omni');

export interface AudioTranscriptionResult {
  text: string;
  confidence: number;
  language?: string;
  duration?: number;
}

/**
 * 多模态服务
 * 使用 omni 模型处理图片、文档、音频、视频
 */
export class OmniService extends OpenAICompatibleClient {
  constructor() {
    super({
      apiKey: config.omni.apiKey,
      apiUrl: config.omni.apiUrl,
      model: config.omni.model,
      maxTokens: config.omni.maxTokens,
      timeout: config.omni.timeout,
    });
  }

  /**
   * 分析图片/文档
   */
  async analyzeVision(
    input: { url: string; type: 'image' | 'document' | 'video'; name?: string; mimeType?: string },
    instruction?: string,
  ): Promise<VisionAnalysisResult> {
    const content = await this.chatWithVision(
      [
        `附件类型: ${input.type}`,
        `附件名称: ${input.name ?? 'unknown'}`,
        `MIME: ${input.mimeType ?? 'unknown'}`,
        instruction ?? '请提取主要文本、关键标签、场景摘要，并返回 JSON。',
      ].join('\n'),
      input.url,
      {
        systemPrompt:
          '你是一个多模态理解助手。请根据用户提供的附件进行视觉理解，并严格返回 JSON，字段包括 text、labels、confidence、metadata。',
        jsonMode: true,
      },
    );

    const parsed = this.parseJson<Partial<VisionAnalysisResult>>(content, '视觉分析结果');

    return {
      text: parsed.text ?? '',
      labels: Array.isArray(parsed.labels)
        ? parsed.labels.filter((item): item is string => typeof item === 'string')
        : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      metadata: parsed.metadata ?? {},
    };
  }

  /**
   * 转录音频
   */
  async transcribeAudio(
    input: { url: string; name?: string; mimeType?: string },
  ): Promise<AudioTranscriptionResult> {
    try {
      // 使用音频 URL 进行转录
      const response = await this.client.audio.transcriptions.create({
        model: config.omni.model,
        file: await this.fetchAudioFile(input.url),
      });

      return {
        text: response.text,
        confidence: 0.9,
        language: response.language,
      };
    } catch (error) {
      log.error({ error, url: input.url }, '音频转录失败');
      throw error;
    }
  }

  /**
   * 分析视频（提取关键帧后分析）
   */
  async analyzeVideo(
    input: { url: string; name?: string; mimeType?: string },
    instruction?: string,
  ): Promise<VisionAnalysisResult> {
    // 视频分析通过视觉模型处理
    return this.analyzeVision(
      { ...input, type: 'video' },
      instruction ?? '请分析视频内容，提取关键帧描述、场景、文字信息，返回 JSON。',
    );
  }

  private async fetchAudioFile(url: string): Promise<File> {
    const response = await fetch(url);
    const blob = await response.blob();
    return new File([blob], 'audio.mp3', { type: blob.type || 'audio/mpeg' });
  }
}
