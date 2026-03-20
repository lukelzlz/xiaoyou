import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawCron } from '../../src/executor/openclaw-cron.js';
import type { OpenClawRpcClient } from '../../src/executor/openclaw-rpc.js';
import type { CronRule } from '../../src/types/index.js';

// Mock the RPC client module
const mockGetOpenClawRpcClient = vi.fn();

vi.mock('../../src/executor/openclaw-rpc.js', () => ({
  getOpenClawRpcClient: () => mockGetOpenClawRpcClient(),
}));

describe('OpenClawCron', () => {
  let cron: OpenClawCron;
  let mockRpc: {
    connect: ReturnType<typeof vi.fn>;
    createCronTask: ReturnType<typeof vi.fn>;
    updateCronTask: ReturnType<typeof vi.fn>;
    deleteCronTask: ReturnType<typeof vi.fn>;
    listCronTasks: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
    sendNotification: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    // Create mock RPC client
    mockRpc = {
      connect: vi.fn().mockResolvedValue(undefined),
      createCronTask: vi.fn(),
      updateCronTask: vi.fn().mockResolvedValue(undefined),
      deleteCronTask: vi.fn().mockResolvedValue(undefined),
      listCronTasks: vi.fn(),
      call: vi.fn(),
      sendNotification: vi.fn().mockResolvedValue(undefined),
    };

    mockGetOpenClawRpcClient.mockReturnValue(mockRpc as unknown as OpenClawRpcClient);

    cron = new OpenClawCron();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应该能成功注册定时任务', async () => {
    mockRpc.createCronTask.mockResolvedValueOnce({ taskId: 'test-task-id' });

    const rule: CronRule = {
      expression: '0 9 * * *',
      description: '每天早上9点',
      timezone: 'Asia/Shanghai',
    };
    const task = {
      type: 'test_task',
      params: {},
    };

    const taskId = await cron.register(rule, task);
    expect(taskId).toBe('test-task-id');
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.createCronTask).toHaveBeenCalledOnce();
  });

  it('注册冲突时应该抛出异常', async () => {
    mockRpc.createCronTask.mockRejectedValueOnce(new Error('Conflict'));

    const rule: CronRule = {
      expression: '0 9 * * *',
      description: '每天早上9点',
      timezone: 'Asia/Shanghai',
    };
    const task = {
      type: 'test_task',
      params: {},
    };

    await expect(cron.register(rule, task)).rejects.toThrow();
    expect(mockRpc.connect).toHaveBeenCalledOnce();
  });

  it('应该能成功更新定时任务', async () => {
    await expect(cron.update('test-id', { expression: '0 10 * * *' })).resolves.toBeUndefined();
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.updateCronTask).toHaveBeenCalledWith('test-id', {
      expression: '0 10 * * *',
      enabled: true,
    });
  });

  it('应该能成功取消定时任务', async () => {
    await expect(cron.cancel('test-id')).resolves.toBeUndefined();
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.deleteCronTask).toHaveBeenCalledWith('test-id');
  });

  it('应该能成功获取用户任务列表', async () => {
    mockRpc.listCronTasks.mockResolvedValueOnce([
      {
        id: 'task-1',
        status: 'active',
        expression: '0 * * * *',
        nextExecution: '2024-01-01T00:00:00Z',
      },
    ]);

    const tasks = await cron.listTasks('user-1');
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.listCronTasks).toHaveBeenCalledWith('user-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-1');
  });

  it('获取执行历史失败时应该抛出异常', async () => {
    mockRpc.call.mockRejectedValueOnce(new Error('Internal error'));

    await expect(cron.getExecutionHistory('test-id')).rejects.toThrow();
    expect(mockRpc.connect).toHaveBeenCalledOnce();
  });

  it('发送通知应该成功', async () => {
    await expect(
      cron.sendNotification(
        { userId: 'user-1', channelId: 'ch-1', platform: 'discord' },
        'Title',
        'Message'
      )
    ).resolves.toBeUndefined();
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.sendNotification).toHaveBeenCalled();
  });
});
