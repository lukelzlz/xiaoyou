import type { Attachment, MultimodalContent } from '../types/index.js';
import { GLMService, type VisionAnalysisResult } from '../llm/glm.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('multimodal');

export interface OCRResult {
  text: string;
  labels: string[];
  confidence: number;
}

export interface DocumentParseResult {
  text: string;
  metadata: Record<string, unknown>;
}

export interface AudioTranscriptionResult {
  text: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface VideoAnalysisResult {
  text?: string;
  labels?: string[];
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MultimodalServices {
  recognizeImage?: (attachment: Attachment) => Promise<OCRResult>;
  parseDocument?: (attachment: Attachment) => Promise<DocumentParseResult>;
  transcribeAudio?: (attachment: Attachment) => Promise<AudioTranscriptionResult>;
  analyzeVideo?: (attachment: Attachment) => Promise<VideoAnalysisResult>;
}

export class MultimodalExtractor {
  private readonly glm?: GLMService;

  constructor(private readonly services: MultimodalServices = {}, glm?: GLMService) {
    this.glm = glm;
  }

  async extract(attachments: Attachment[]): Promise<MultimodalContent[]> {
    const results = await Promise.all(
      attachments.map(async (attachment) => {
        try {
          switch (attachment.type) {
            case 'image':
              return await this.extractFromImage(attachment);
            case 'document':
              return await this.extractFromDocument(attachment);
            case 'audio':
              return await this.extractFromAudio(attachment);
            case 'video':
              return await this.extractFromVideo(attachment);
          }
        } catch (error) {
          log.warn({ error, attachment: attachment.name }, '多模态内容提取失败');
          return {
            type: attachment.type,
            url: attachment.url,
            metadata: {
              error: true,
              message: String(error),
              sourceName: attachment.name,
              mimeType: attachment.mimeType,
            },
          } satisfies MultimodalContent;
        }
      }),
    );

    return results;
  }

  buildPromptContext(contents: MultimodalContent[]): string {
    if (!contents.length) {
      return '';
    }

    return contents
      .map((content, index) => {
        const parts = [`附件${index + 1}`, `类型=${content.type}`];

        if (content.extractedText) {
          parts.push(`提取文本=${this.normalizeSnippet(content.extractedText)}`);
        }

        if (content.labels?.length) {
          parts.push(`标签=${content.labels.join('、')}`);
        }

        if (typeof content.confidence === 'number') {
          parts.push(`置信度=${content.confidence.toFixed(2)}`);
        }

        if (content.metadata && Object.keys(content.metadata).length > 0) {
          const metadataSummary = this.summarizeMetadata(content.metadata);
          if (metadataSummary) {
            parts.push(`元数据=${metadataSummary}`);
          }
        }

        return parts.join(' | ');
      })
      .join('\n');
  }

  private async extractFromImage(attachment: Attachment): Promise<MultimodalContent> {
    log.debug({ url: attachment.url }, '提取图片内容');

    const ocrResult: OCRResult = this.services.recognizeImage
      ? await this.services.recognizeImage(attachment)
      : await this.analyzeWithVisionModel(attachment, '请识别图片中的文本、界面元素、关键对象和场景。');

    return {
      type: 'image',
      url: attachment.url,
      extractedText: ocrResult.text,
      labels: ocrResult.labels,
      confidence: ocrResult.confidence,
      metadata: {
        sourceName: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        provider: this.services.recognizeImage ? 'external' : this.glm ? 'glm-vision' : 'mock',
      },
    };
  }

  private async extractFromDocument(attachment: Attachment): Promise<MultimodalContent> {
    log.debug({ url: attachment.url, mimeType: attachment.mimeType }, '提取文档内容');

    const parseResult: DocumentParseResult = this.services.parseDocument
      ? await this.services.parseDocument(attachment)
      : await this.parseDocumentWithVisionModel(attachment);

    return {
      type: 'document',
      url: attachment.url,
      extractedText: parseResult.text,
      metadata: {
        ...parseResult.metadata,
        mimeType: attachment.mimeType,
        size: attachment.size,
        sourceName: attachment.name,
        provider: this.services.parseDocument ? 'external' : this.glm ? 'glm-vision' : 'mock',
      },
    };
  }

  private async extractFromAudio(attachment: Attachment): Promise<MultimodalContent> {
    log.debug({ url: attachment.url }, '提取音频内容');

    const transcription = this.services.transcribeAudio
      ? await this.services.transcribeAudio(attachment)
      : await this.mockTranscription(attachment);

    return {
      type: 'audio',
      url: attachment.url,
      extractedText: transcription.text,
      confidence: transcription.confidence,
      metadata: {
        mimeType: attachment.mimeType,
        size: attachment.size,
        sourceName: attachment.name,
        provider: this.services.transcribeAudio ? 'external' : 'mock',
        duration: null,
        ...transcription.metadata,
      },
    };
  }

  private async extractFromVideo(attachment: Attachment): Promise<MultimodalContent> {
    log.debug({ url: attachment.url }, '提取视频内容');

    const analysis = this.services.analyzeVideo
      ? await this.services.analyzeVideo(attachment)
      : await this.analyzeVideoWithVisionModel(attachment);

    return {
      type: 'video',
      url: attachment.url,
      extractedText: analysis.text,
      labels: analysis.labels,
      confidence: analysis.confidence,
      metadata: {
        mimeType: attachment.mimeType,
        size: attachment.size,
        sourceName: attachment.name,
        provider: this.services.analyzeVideo ? 'external' : this.glm ? 'glm-vision' : 'mock',
        duration: null,
        hasAudio: null,
        ...analysis.metadata,
      },
    };
  }

  private async analyzeWithVisionModel(attachment: Attachment, instruction: string): Promise<OCRResult> {
    if (!this.glm) {
      return this.mockOCR(attachment);
    }

    const result = await this.glm.analyzeVision(
      {
        url: attachment.url,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
      },
      instruction,
    );

    return {
      text: result.text,
      labels: result.labels,
      confidence: result.confidence,
    };
  }

  private async parseDocumentWithVisionModel(attachment: Attachment): Promise<DocumentParseResult> {
    if (!this.glm) {
      return this.mockDocumentParse(attachment);
    }

    const result = await this.glm.analyzeVision(
      {
        url: attachment.url,
        type: 'document',
        name: attachment.name,
        mimeType: attachment.mimeType,
      },
      '请总结文档主要内容，提取正文、标题、表格或关键字段，并返回结构化 JSON。',
    );

    return {
      text: result.text,
      metadata: {
        ...(result.metadata ?? {}),
        labels: result.labels,
      },
    };
  }

  private async analyzeVideoWithVisionModel(attachment: Attachment): Promise<VideoAnalysisResult> {
    if (!this.glm) {
      return this.mockVideoAnalysis(attachment);
    }

    const result: VisionAnalysisResult = await this.glm.analyzeVision(
      {
        url: attachment.url,
        type: 'video',
        name: attachment.name,
        mimeType: attachment.mimeType,
      },
      '请根据视频封面或关键帧链接总结内容、场景和潜在动作。',
    );

    return {
      text: result.text,
      labels: result.labels,
      confidence: result.confidence,
      metadata: result.metadata,
    };
  }

  private async mockOCR(attachment: Attachment): Promise<OCRResult> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      text: `[图片内容待识别: ${attachment.name}]`,
      labels: this.deriveLabels(attachment),
      confidence: 0.5,
    };
  }

  private async mockDocumentParse(attachment: Attachment): Promise<DocumentParseResult> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      text: `[文档内容待解析: ${attachment.name}]`,
      metadata: {
        filename: attachment.name,
        parsed: false,
        kind: this.inferDocumentKind(attachment),
      },
    };
  }

  private async mockTranscription(attachment: Attachment): Promise<AudioTranscriptionResult> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      text: `[音频转录待处理: ${attachment.name}]`,
      confidence: 0.45,
      metadata: {
        language: 'unknown',
      },
    };
  }

  private async mockVideoAnalysis(attachment: Attachment): Promise<VideoAnalysisResult> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      text: `[视频内容待分析: ${attachment.name}]`,
      labels: ['video'],
      confidence: 0.4,
      metadata: {
        keyFramesExtracted: false,
      },
    };
  }

  private deriveLabels(attachment: Attachment): string[] {
    const normalized = `${attachment.name} ${attachment.mimeType ?? ''}`.toLowerCase();
    const labels = ['image'];

    if (normalized.includes('screenshot')) {
      labels.push('screenshot');
    }
    if (normalized.includes('invoice') || normalized.includes('receipt')) {
      labels.push('document');
    }
    if (normalized.includes('diagram')) {
      labels.push('diagram');
    }

    return labels;
  }

  private inferDocumentKind(attachment: Attachment): string {
    const normalized = `${attachment.name} ${attachment.mimeType ?? ''}`.toLowerCase();

    if (normalized.includes('pdf')) {
      return 'pdf';
    }
    if (normalized.includes('word') || normalized.includes('doc')) {
      return 'word';
    }
    if (normalized.includes('sheet') || normalized.includes('excel') || normalized.includes('csv')) {
      return 'spreadsheet';
    }

    return 'generic';
  }

  private summarizeMetadata(metadata: Record<string, unknown>): string {
    return Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .slice(0, 5)
      .map(([key, value]) => `${key}=${this.normalizeSnippet(String(value))}`)
      .join(', ');
  }

  private normalizeSnippet(value: string, maxLength = 120): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxLength) {
      return compact;
    }
    return `${compact.slice(0, maxLength)}...`;
  }
}
