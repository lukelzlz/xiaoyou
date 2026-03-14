export enum ErrorCode {
  INVALID_INPUT = 'ERR_INVALID_INPUT',
  UNAUTHORIZED = 'ERR_UNAUTHORIZED',
  FORBIDDEN = 'ERR_FORBIDDEN',
  NOT_FOUND = 'ERR_NOT_FOUND',
  RATE_LIMIT = 'ERR_RATE_LIMIT',
  INTERNAL = 'ERR_INTERNAL',
  LLM_TIMEOUT = 'ERR_LLM_TIMEOUT',
  LLM_ERROR = 'ERR_LLM_ERROR',
  TOOL_ERROR = 'ERR_TOOL_ERROR',
  PLAN_INVALID = 'ERR_PLAN_INVALID',
  TASK_CANCELLED = 'ERR_TASK_CANCELLED',
  SCHEDULE_CONFLICT = 'ERR_SCHEDULE_CONFLICT',
  MEMORY_FULL = 'ERR_MEMORY_FULL',
}

export class XiaoyouError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; retryable?: boolean; cause?: Error }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'XiaoyouError';
    this.code = code;
    this.details = options?.details;
    this.retryable = options?.retryable ?? false;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof XiaoyouError) {
    return error.retryable;
  }
  return false;
}

export function wrapError(error: unknown, code: ErrorCode, message: string): XiaoyouError {
  const cause = error instanceof Error ? error : new Error(String(error));
  return new XiaoyouError(code, message, { cause });
}
