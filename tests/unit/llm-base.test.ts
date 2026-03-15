import { describe, expect, it } from 'vitest';
import { OpenAICompatibleClient } from '../../src/llm/base.js';

import { XiaoyouError } from '../../src/utils/error.js';

class TestClient extends OpenAICompatibleClient {
  public parse<T>(raw: string, label: string): T {
    return this.parseJson<T>(raw, label);
  }

  public getRetryable(error: unknown) {
    return this.isRetryableError(error);
  }
}

describe('OpenAICompatibleClient', () => {
  it('应该能解析合法 JSON', () => {
    const client = new TestClient({
      apiKey: 'test-key',
      apiUrl: 'https://example.com/v1',
      model: 'test-model',
    });

    const result = client.parse<{ ok: boolean }>('{"ok":true}', '测试结果');
    expect(result.ok).toBe(true);
  });

  it('非法 JSON 应抛出错误', () => {
    const client = new TestClient({
      apiKey: 'test-key',
      apiUrl: 'https://example.com/v1',
      model: 'test-model',
    });

    expect(() => client.parse('not-json', '测试结果')).toThrowError();
  });

  it('能够正确识别可重试错误', () => {
    const client = new TestClient({
      apiKey: 'test-key',
      apiUrl: 'https://example.com/v1',
      model: 'test-model',
    });

    // HTTP Status Codes
    expect(client.getRetryable({ status: 429 })).toBe(true);
    expect(client.getRetryable({ status: 500 })).toBe(true);
    expect(client.getRetryable({ status: 502 })).toBe(true);
    expect(client.getRetryable({ status: 408 })).toBe(true);
    expect(client.getRetryable({ status: 400 })).toBe(false);
    expect(client.getRetryable({ status: 401 })).toBe(false);

    // Network Codes
    expect(client.getRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(client.getRetryable({ code: 'ETIMEDOUT' })).toBe(true);

    // XiaoyouError 包装
    const retryableError = new XiaoyouError('TEST_ERROR', 'msg', { retryable: true });
    const nonRetryableError = new XiaoyouError('TEST_ERROR', 'msg', { retryable: false });
    expect(client.getRetryable(retryableError)).toBe(true);
    expect(client.getRetryable(nonRetryableError)).toBe(false);
  });

  it('对于可重试错误，应执行重试策略', async () => {
    const client = new TestClient({
      apiKey: 'test-key',
      apiUrl: 'https://example.com/v1',
      model: 'test-model',
      maxRetries: 2,
      retryDelayMs: 10,
    });

    let attempts = 0;
    const operation = async () => {
      attempts++;
      if (attempts < 3) {
        // 模拟 429 Too Many Requests 错误
        throw { status: 429 };
      }
      return 'success';
    };

    // @ts-expect-error accessing protected method for testing
    const result = await client.executeWithRetry(operation);
    expect(result).toBe('success');
    expect(attempts).toBe(3); // 1st try + 2 retries
  });

  it('超过最大重试次数后应抛出错误', async () => {
    const client = new TestClient({
      apiKey: 'test-key',
      apiUrl: 'https://example.com/v1',
      model: 'test-model',
      maxRetries: 1,
      retryDelayMs: 10,
    });

    let attempts = 0;
    const operation = async () => {
      attempts++;
      throw { status: 500 };
    };

    // @ts-expect-error accessing protected method for testing
    await expect(client.executeWithRetry(operation)).rejects.toThrow();
    expect(attempts).toBe(2); // 1st try + 1 retry
  });
});
