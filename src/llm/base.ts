import OpenAI from 'openai';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';

const log = createChildLogger('llm-client');

export interface BaseLLMConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface ChatOptions {
  systemPrompt?: string;
  jsonMode?: boolean;
}

export abstract class OpenAICompatibleClient {
  protected client: OpenAI;
  protected model: string;
  protected maxTokens: number;
  protected temperature: number;
  protected timeout: number;
  protected maxRetries: number;
  protected retryDelayMs: number;

  constructor(config: BaseLLMConfig) {
    this.timeout = config.timeout ?? 30000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 500;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.apiUrl,
      timeout: this.timeout,
      maxRetries: 0,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.7;
  }

  /**
   * 基础对话能力
   */
  async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
    try {
      const response = await this.executeWithRetry(() =>
        this.client.chat.completions.create({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          messages: [
            ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
            { role: 'user' as const, content: prompt },
          ],
          ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      );

      return response.choices[0]?.message?.content ?? '';
    } catch (error) {
      log.error({ error, model: this.model }, 'LLM Chat 调用失败');
      throw new XiaoyouError(ErrorCode.LLM_ERROR, `调用 ${this.model} 失败`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        retryable: this.isRetryableError(error),
      });
    }
  }

  /**
   * 带视觉能力的对话，如果底层模型不支持可以由子类覆盖或在调用时抛出错误
   */
  async chatWithVision(
    prompt: string,
    imageUrl: string,
    options: ChatOptions = {},
  ): Promise<string> {
    try {
      const response = await this.executeWithRetry(() =>
        this.client.chat.completions.create({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          messages: [
            ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      );

      return response.choices[0]?.message?.content ?? '';
    } catch (error) {
      log.error({ error, model: this.model }, 'LLM 视觉分析调用失败');
      throw new XiaoyouError(ErrorCode.LLM_ERROR, `调用 ${this.model} 视觉分析失败`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        retryable: this.isRetryableError(error),
      });
    }
  }

  /**
   * JSON 解析安全包装
   */
  protected parseJson<T>(raw: string, label: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch (parseError) {
      log.error({ rawResponse: raw.slice(0, 500), parseError }, `${label} JSON 解析失败`);
      throw new XiaoyouError(ErrorCode.PLAN_INVALID, `无法解析${label}`, {
        details: { rawResponse: raw.slice(0, 500) },
      });
    }
  }

  protected async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries || !this.isRetryableError(error)) {
          throw error;
        }

        const delay = Math.min(this.retryDelayMs * 2 ** attempt, 5000);
        log.warn(
          { model: this.model, attempt: attempt + 1, nextDelay: delay, error },
          'LLM 调用失败，准备重试',
        );
        await this.sleep(delay);
        attempt += 1;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  protected isRetryableError(error: unknown): boolean {
    if (error instanceof XiaoyouError) {
      return error.retryable ?? false;
    }

    const status = typeof error === 'object' && error !== null && 'status' in error ? Reflect.get(error, 'status') : undefined;
    const code = typeof error === 'object' && error !== null && 'code' in error ? Reflect.get(error, 'code') : undefined;

    if (typeof status === 'number') {
      return status === 408 || status === 429 || status >= 500;
    }

    if (typeof code === 'string') {
      return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED'].includes(code);
    }

    return error instanceof Error;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
