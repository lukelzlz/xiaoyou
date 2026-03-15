import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OpenClawCron } from '../../src/executor/openclaw-cron.js';
import { ErrorCode, XiaoyouError } from '../../src/utils/error.js';
import type { CronRule } from '../../src/types/index.js';

// 模拟全局 fetch
const originalFetch = global.fetch;

describe('OpenClawCron', () => {
  let cron: OpenClawCron;

  beforeEach(() => {
    cron = new OpenClawCron();
    vi.restoreAllMocks();
  });

  it('应该能成功注册定时任务', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        id: 'test-cron-id',
        status: 'active',
      }),
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    const rule: CronRule = {
      expression: '0 9 * * *',
      description: '每天早上9点',
      timezone: 'Asia/Shanghai',
    };
    const task = {
      type: 'test_task',
      params: { param1: 'value1' },
    };

    const taskId = await cron.register(rule, task);
    expect(taskId).toBe('test-cron-id');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('注册失败时应该抛出异常', async () => {
    const mockResponse = {
      ok: false,
      status: 409,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    const rule: CronRule = {
      expression: '0 9 * * *',
      description: '每天早上9点',
      timezone: 'Asia/Shanghai',
    };
    const task = {
      type: 'test_task',
      params: {},
    };

    await expect(cron.register(rule, task)).rejects.toThrow(XiaoyouError);
    await expect(cron.register(rule, task)).rejects.toMatchObject({
      code: ErrorCode.SCHEDULE_CONFLICT,
    });
  });

  it('应该能成功更新定时任务', async () => {
    const mockResponse = {
      ok: true,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    await expect(cron.update('test-id', { expression: '0 10 * * *' })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('应该能成功取消定时任务', async () => {
    const mockResponse = {
      ok: true,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    await expect(cron.cancel('test-id')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('应该能成功获取用户任务列表', async () => {
    const mockResponse = {
      ok: true,
      json: async () => [
        {
          id: 'task-1',
          status: 'active',
          expression: '0 * * * *',
          timezone: 'UTC',
          executionCount: 5,
        },
      ],
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    const tasks = await cron.listTasks('user-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-1');
  });

  it('获取执行历史失败时应该抛出异常', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    await expect(cron.getExecutionHistory('test-id')).rejects.toThrow(XiaoyouError);
    await expect(cron.getExecutionHistory('test-id')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
  });

  it('发送通知失败时不会抛出异常（只记录警告）', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse as unknown as Response);

    // 调用 sendNotification，它内部只是用 log.warn 记录
    await expect(cron.sendNotification('user-1', 'Title', 'Message')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
