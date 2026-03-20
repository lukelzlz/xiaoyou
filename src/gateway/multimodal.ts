import dns from 'node:dns';
import type { Attachment, MultimodalContent } from '../types/index.js';
import { QuickService, type VisionAnalysisResult } from '../llm/quick.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('multimodal');

// ============ 安全配置 ============
const SECURITY_CONFIG = {
  // 文件大小限制 (10MB)
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  // 允许的 MIME 类型白名单
  ALLOWED_MIME_TYPES: {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
    audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'],
    video: ['video/mp4', 'video/webm', 'video/ogg'],
  },
  // URL 协议白名单
  ALLOWED_PROTOCOLS: ['http:', 'https:'],
  // 私有 IP 地址正则 (SSRF 防护)
  PRIVATE_IP_PATTERNS: [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^0\.0\.0\.0$/,
    /^localhost$/i,
    /^::1$/,
    /^fc00:/i,
    /^fe80:/i,
  ],
  // 最大 URL 长度
  MAX_URL_LENGTH: 2048,
} as const;

// 附件验证错误
export class AttachmentValidationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

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
  private readonly quick?: QuickService;

  constructor(private readonly services: MultimodalServices = {}, quick?: QuickService) {
    this.quick = quick;
  }

  /**
   * 验证附件安全性
   * 防止 SSRF、文件过大、非法类型等攻击
   */
  private async validateAttachment(attachment: Attachment): Promise<void> {
    // 1. 文件大小验证
    if (attachment.size && attachment.size > SECURITY_CONFIG.MAX_FILE_SIZE) {
      throw new AttachmentValidationError(
        `文件大小超过限制 (${SECURITY_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`,
        'FILE_TOO_LARGE'
      );
    }

    // 2. MIME 类型验证
    if (attachment.mimeType) {
      const mimeTypes = SECURITY_CONFIG.ALLOWED_MIME_TYPES as Record<string, readonly string[]>;
      const allowedTypes = mimeTypes[attachment.type];
      if (allowedTypes && !allowedTypes.includes(attachment.mimeType)) {
        throw new AttachmentValidationError(
          `不支持的 MIME 类型: ${attachment.mimeType}`,
          'INVALID_MIME_TYPE'
        );
      }
    }

    // 3. URL 验证 (SSRF 防护)
    await this.validateUrl(attachment.url);
  }

  /**
   * 验证 URL 安全性 (SSRF 防护)
   */
  private async validateUrl(url: string): Promise<void> {
    // URL 长度检查
    if (url.length > SECURITY_CONFIG.MAX_URL_LENGTH) {
      throw new AttachmentValidationError('URL 长度超过限制', 'URL_TOO_LONG');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new AttachmentValidationError('无效的 URL 格式', 'INVALID_URL');
    }

    // 协议检查
    if (!SECURITY_CONFIG.ALLOWED_PROTOCOLS.includes(parsedUrl.protocol as 'http:' | 'https:')) {
      throw new AttachmentValidationError(
        `不允许的 URL 协议: ${parsedUrl.protocol}`,
        'INVALID_PROTOCOL'
      );
    }

    // 私有 IP 检查 (SSRF 防护)
    const hostname = parsedUrl.hostname;
    for (const pattern of SECURITY_CONFIG.PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new AttachmentValidationError(
          '禁止访问私有网络地址',
          'SSRF_BLOCKED'
        );
      }
    }

    // DNS 重绑定防护 - 解析域名并检查实际 IP
    try {
      // 使用 Node.js 的 DNS 解析（如果可用）
      if (typeof dns !== 'undefined') {
        const addresses = await new Promise<string[]>((resolve, reject) => {
          dns.lookup(hostname, { all: true }, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses.map(a => a.address));
          });
        });

        for (const ip of addresses) {
          for (const pattern of SECURITY_CONFIG.PRIVATE_IP_PATTERNS) {
            if (pattern.test(ip)) {
              throw new AttachmentValidationError(
                '域名解析到私有网络地址',
                'DNS_REBINDING_BLOCKED'
              );
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof AttachmentValidationError) {
        throw error;
      }
      // DNS 解析失败不阻止请求（让实际请求失败）
      log.debug({ hostname, error }, 'DNS 解析跳过');
    }
  }

  async extract(attachments: Attachment[]): Promise<MultimodalContent[]> {
    const results = await Promise.all(
      attachments.map(async (attachment) => {
        try {
          // 安全验证
          await this.validateAttachment(attachment);

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
          // 安全验证错误使用特定日志级别
          if (error instanceof AttachmentValidationError) {
            log.warn({
              error: error.message,
              code: error.code,
              attachment: attachment.name
            }, '附件安全验证失败');
          } else {
            log.warn({ error, attachment: attachment.name }, '多模态内容提取失败');
          }
          return {
            type: attachment.type,
            url: attachment.url,
            metadata: {
              error: true,
              message: error instanceof AttachmentValidationError ? error.message : String(error),
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
        provider: this.services.recognizeImage ? 'external' : this.quick ? 'glm-vision' : 'mock',
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
        provider: this.services.parseDocument ? 'external' : this.quick ? 'glm-vision' : 'mock',
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
        provider: this.services.analyzeVideo ? 'external' : this.quick ? 'glm-vision' : 'mock',
        duration: null,
        hasAudio: null,
        ...analysis.metadata,
      },
    };
  }

  private async analyzeWithVisionModel(attachment: Attachment, instruction: string): Promise<OCRResult> {
    if (!this.quick) {
      return this.mockOCR(attachment);
    }

    const result = await this.quick.analyzeVision(
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
    if (!this.quick) {
      return this.mockDocumentParse(attachment);
    }

    const result = await this.quick.analyzeVision(
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
    if (!this.quick) {
      return this.mockVideoAnalysis(attachment);
    }

    const result: VisionAnalysisResult = await this.quick.analyzeVision(
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
    log.warn({ attachment: attachment.name }, '使用 Mock OCR（未配置视觉模型）');
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      text: `[图片内容待识别: ${attachment.name}]`,
      labels: this.deriveLabels(attachment),
      confidence: 0.5,
    };
  }

  private async mockDocumentParse(attachment: Attachment): Promise<DocumentParseResult> {
    log.warn({ attachment: attachment.name }, '使用 Mock 文档解析（未配置视觉模型）');
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
    log.warn({ attachment: attachment.name }, '使用 Mock 音频转录（未配置转录服务）');
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
    log.warn({ attachment: attachment.name }, '使用 Mock 视频分析（未配置视觉模型）');
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
