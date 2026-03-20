/**
 * 安全的 JSON 解析工具
 * 防止 DoS 攻击和原型污染
 */

export interface SafeJsonParseOptions {
  /** 最大允许的字符串长度 */
  maxLength?: number;
  /** 最大允许的嵌套深度 */
  maxDepth?: number;
  /** 是否禁止 __proto__ 等危险键 */
  preventProtoPollution?: boolean;
}

const DEFAULT_OPTIONS: Required<SafeJsonParseOptions> = {
  maxLength: 10 * 1024 * 1024, // 10MB
  maxDepth: 100,
  preventProtoPollution: true,
};

/**
 * 安全的 JSON 解析
 * @param text 要解析的 JSON 字符串
 * @param options 安全选项
 * @returns 解析结果或 null（解析失败时）
 */
export function safeJsonParse<T = unknown>(
  text: string,
  options?: SafeJsonParseOptions
): T | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 长度检查
  if (text.length > opts.maxLength) {
    return null;
  }

  try {
    const parsed = JSON.parse(text, (key, value) => {
      // 防止原型污染
      if (opts.preventProtoPollution) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          return undefined;
        }
      }
      return value;
    });

    // 深度检查
    if (opts.maxDepth > 0) {
      const depth = getDepth(parsed);
      if (depth > opts.maxDepth) {
        return null;
      }
    }

    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * 安全的 JSON 解析（带详细错误信息）
 */
export function safeJsonParseWithDetails<T = unknown>(
  text: string,
  options?: SafeJsonParseOptions
): { success: true; data: T } | { success: false; error: string } {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 长度检查
  if (text.length > opts.maxLength) {
    return { success: false, error: `JSON 字符串超过最大长度限制 (${opts.maxLength} 字符)` };
  }

  try {
    const parsed = JSON.parse(text, (key, value) => {
      // 防止原型污染
      if (opts.preventProtoPollution) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          return undefined;
        }
      }
      return value;
    });

    // 深度检查
    if (opts.maxDepth > 0) {
      const depth = getDepth(parsed);
      if (depth > opts.maxDepth) {
        return { success: false, error: `JSON 嵌套深度超过限制 (${opts.maxDepth})` };
      }
    }

    return { success: true, data: parsed as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `JSON 解析失败: ${message}` };
  }
}

/**
 * 计算对象的嵌套深度
 */
function getDepth(obj: unknown, currentDepth = 0): number {
  if (currentDepth > 1000) {
    return currentDepth; // 防止循环引用导致的无限递归
  }

  if (typeof obj !== 'object' || obj === null) {
    return currentDepth;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return currentDepth + 1;
    }
    return Math.max(...obj.map(item => getDepth(item, currentDepth + 1)));
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return currentDepth + 1;
  }

  return Math.max(
    ...Object.values(obj).map(value => getDepth(value, currentDepth + 1))
  );
}

/**
 * 尝试解析 JSON，失败时返回默认值
 */
export function tryParseJson<T>(text: string, defaultValue: T, options?: SafeJsonParseOptions): T {
  const result = safeJsonParse<T>(text, options);
  return result ?? defaultValue;
}
