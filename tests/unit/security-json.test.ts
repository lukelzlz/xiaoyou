import { describe, it, expect } from 'vitest';
import { safeJsonParse, safeJsonParseWithDetails, tryParseJson } from '../../src/utils/json.js';

describe('Safe JSON Parsing Security Tests', () => {
  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse<{ name: string }>('{"name": "test"}');
      expect(result).toEqual({ name: 'test' });
    });

    it('should return null for invalid JSON', () => {
      expect(safeJsonParse('not json')).toBeNull();
      expect(safeJsonParse('{invalid}')).toBeNull();
      expect(safeJsonParse('{"unclosed": "string')).toBeNull();
    });

    it('should reject JSON exceeding max length', () => {
      const largeObject = { data: 'a'.repeat(11 * 1024 * 1024) }; // 11MB+
      const json = JSON.stringify(largeObject);

      const result = safeJsonParse(json, { maxLength: 1024 * 1024 });
      expect(result).toBeNull();
    });

    it('should prevent prototype pollution', () => {
      const malicious = '{"__proto__": {"polluted": true}, "constructor": {"polluted": true}}';

      const result = safeJsonParse(malicious);
      expect(result).not.toBeNull();
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it('should prevent constructor pollution', () => {
      const malicious = '{"constructor": {"prototype": {"polluted": true}}}';

      const result = safeJsonParse(malicious);
      expect(result).not.toBeNull();
      expect((Object.prototype as any).polluted).toBeUndefined();
    });

    it('should handle deeply nested objects', () => {
      let deep: any = {};
      let current = deep;
      for (let i = 0; i < 200; i++) {
        current.nested = {};
        current = current.nested;
      }

      const json = JSON.stringify(deep);
      const result = safeJsonParse(json, { maxDepth: 100 });
      expect(result).toBeNull();
    });

    it('should allow nested objects within limit', () => {
      let deep: any = {};
      let current = deep;
      for (let i = 0; i < 50; i++) {
        current.nested = {};
        current = current.nested;
      }

      const json = JSON.stringify(deep);
      const result = safeJsonParse(json, { maxDepth: 100 });
      expect(result).not.toBeNull();
    });

    it('should handle arrays', () => {
      expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
      expect(safeJsonParse('[]')).toEqual([]);
    });

    it('should handle null and primitive values', () => {
      expect(safeJsonParse('null')).toBeNull();
      expect(safeJsonParse('true')).toBe(true);
      expect(safeJsonParse('false')).toBe(false);
      expect(safeJsonParse('42')).toBe(42);
      expect(safeJsonParse('"string"')).toBe('string');
    });

    it('should handle Unicode in JSON', () => {
      const result = safeJsonParse<{ emoji: string }>('{"emoji": "🎉"}');
      expect(result).toEqual({ emoji: '🎉' });
    });
  });

  describe('safeJsonParseWithDetails', () => {
    it('should return success for valid JSON', () => {
      const result = safeJsonParseWithDetails('{"name": "test"}');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: 'test' });
      }
    });

    it('should return error details for invalid JSON', () => {
      const result = safeJsonParseWithDetails('not json');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('解析失败');
      }
    });

    it('should return error for exceeding max length', () => {
      const largeObject = { data: 'a'.repeat(11 * 1024 * 1024) };
      const json = JSON.stringify(largeObject);

      const result = safeJsonParseWithDetails(json, { maxLength: 1024 * 1024 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('最大长度');
      }
    });

    it('should return error for exceeding max depth', () => {
      let deep: any = {};
      let current = deep;
      for (let i = 0; i < 200; i++) {
        current.nested = {};
        current = current.nested;
      }

      const json = JSON.stringify(deep);
      const result = safeJsonParseWithDetails(json, { maxDepth: 100 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('嵌套深度');
      }
    });
  });

  describe('tryParseJson', () => {
    it('should return parsed value for valid JSON', () => {
      const result = tryParseJson('{"name": "test"}', { default: true });
      expect(result).toEqual({ name: 'test' });
    });

    it('should return default value for invalid JSON', () => {
      const result = tryParseJson('not json', { default: true });
      expect(result).toEqual({ default: true });
    });

    it('should handle different default types', () => {
      expect(tryParseJson('invalid', 'default')).toBe('default');
      expect(tryParseJson('invalid', 42)).toBe(42);
      expect(tryParseJson('invalid', null)).toBeNull();
      expect(tryParseJson('invalid', [1, 2, 3])).toEqual([1, 2, 3]);
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle __proto__ in arrays', () => {
      const malicious = '{"arr": ["__proto__", "polluted"]}';
      const result = safeJsonParse(malicious);
      expect(result).not.toBeNull();
    });

    it('should handle empty objects and arrays', () => {
      expect(safeJsonParse('{}')).toEqual({});
      expect(safeJsonParse('[]')).toEqual([]);
    });

    it('should handle whitespace', () => {
      expect(safeJsonParse('  {"name": "test"}  ')).toEqual({ name: 'test' });
      expect(safeJsonParse('\n\t{"name": "test"}\n')).toEqual({ name: 'test' });
    });

    it('should handle special numbers', () => {
      expect(safeJsonParse('{"num": -123.456}')).toEqual({ num: -123.456 });
      expect(safeJsonParse('{"num": 1e10}')).toEqual({ num: 1e10 });
      expect(safeJsonParse('{"num": 1.5e-3}')).toEqual({ num: 0.0015 });
    });

    it('should handle escaped characters', () => {
      const result = safeJsonParse<{ str: string }>('{"str": "line1\\nline2\\ttab\\"quote\\""}');
      expect(result).toEqual({ str: 'line1\nline2\ttab"quote"' });
    });

    it('should allow __proto__ key when preventProtoPollution is disabled', () => {
      // When preventProtoPollution is false, __proto__ keys are preserved in the result
      const result = safeJsonParse(
        '{"__proto__": {"test": true}}',
        { preventProtoPollution: false }
      );
      // The result should not be null
      expect(result).not.toBeNull();
      // The key should be preserved (note: we check using hasOwnProperty or similar)
      // Since __proto__ is a special key, we need to check it differently
      expect(result).toHaveProperty('__proto__');
      // But it should NOT pollute Object.prototype
      expect((Object.prototype as any).test).toBeUndefined();
    });
  });
});
