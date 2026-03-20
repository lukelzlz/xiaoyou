import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawAgent } from '../../src/executor/openclaw-agent.js';
import { PlanService } from '../../src/llm/plan.js';
import type { OpenClawRpcClient } from '../../src/executor/openclaw-rpc.js';
import type { ExecutionPlan } from '../../src/types/index.js';

// Mock the RPC client module
const mockGetOpenClawRpcClient = vi.fn();

vi.mock('../../src/executor/openclaw-rpc.js', () => ({
  getOpenClawRpcClient: () => mockGetOpenClawRpcClient(),
}));

const samplePlan: ExecutionPlan = {
  planId: 'plan-1',
  description: '测试计划',
  estimatedDuration: 5000,
  requiredResources: [],
  dependencies: { nodes: ['step-1'], edges: [] },
  steps: [
    {
      stepId: 'step-1',
      action: 'run',
      description: '执行命令',
      params: { command: 'echo hello' },
      requiredParams: ['command'],
      optionalParams: [],
      timeout: 3000,
      retryPolicy: {
        maxRetries: 3,
        retryInterval: 1000,
        backoffMultiplier: 2,
        maxInterval: 8000,
        retryableErrors: ['TIMEOUT'],
      },
      onFailure: 'abort',
    },
  ],
};

describe('OpenClawAgent', () => {
  let agent: OpenClawAgent;
  let mockRpc: {
    connect: ReturnType<typeof vi.fn>;
    executePlan: ReturnType<typeof vi.fn>;
    getTaskStatus: ReturnType<typeof vi.fn>;
    controlTask: ReturnType<typeof vi.fn>;
    createCronTask: ReturnType<typeof vi.fn>;
    updateCronTask: ReturnType<typeof vi.fn>;
    deleteCronTask: ReturnType<typeof vi.fn>;
    sendNotification: ReturnType<typeof vi.fn>;
    getRunningTaskCount: ReturnType<typeof vi.fn>;
    getUserTasks: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    // Create mock RPC client
    mockRpc = {
      connect: vi.fn().mockResolvedValue(undefined),
      executePlan: vi.fn(),
      getTaskStatus: vi.fn(),
      controlTask: vi.fn().mockResolvedValue(undefined),
      createCronTask: vi.fn().mockResolvedValue({ taskId: 'test-task-id' }),
      updateCronTask: vi.fn().mockResolvedValue(undefined),
      deleteCronTask: vi.fn().mockResolvedValue(undefined),
      sendNotification: vi.fn().mockResolvedValue(undefined),
      getRunningTaskCount: vi.fn().mockReturnValue(0),
      getUserTasks: vi.fn().mockReturnValue([]),
    };

    mockGetOpenClawRpcClient.mockReturnValue(mockRpc as unknown as OpenClawRpcClient);

    agent = new OpenClawAgent();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应该返回带等待用户和步骤结果的执行状态', async () => {
    mockRpc.getTaskStatus.mockResolvedValueOnce({
      status: 'waiting_user',
      currentStep: 'step-1',
      completedSteps: [],
      failedSteps: ['step-1'],
      waitingForUser: true,
      result: { stepResults: [{ stepId: 'step-1', status: 'failed', error: 'missing command', duration: 1200 }] },
    });

    const status = await agent.getStatus('plan-1');

    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(status.status).toBe('waiting_user');
    expect(status.waitingForUser).toBe(true);
    expect(status.failedSteps).toContain('step-1');
  });

  it('应该能暂停任务', async () => {
    await agent.pause('plan-1');
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.controlTask).toHaveBeenCalledWith('plan-1', 'pause');
  });

  it('应该能恢复任务', async () => {
    await agent.resume('plan-1');
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.controlTask).toHaveBeenCalledWith('plan-1', 'resume');
  });

  it('应该能取消任务', async () => {
    await agent.cancel('plan-1');
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.controlTask).toHaveBeenCalledWith('plan-1', 'cancel');
  });

  it('应该能重试任务', async () => {
    await agent.retry('plan-1');
    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(mockRpc.controlTask).toHaveBeenCalledWith('plan-1', 'retry');
  });

  it('应该能创建定时任务', async () => {
    const result = await agent.createCronTask({
      cronExpression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      taskTemplate: { type: 'test', params: {} },
    });

    expect(mockRpc.connect).toHaveBeenCalledOnce();
    expect(result.id).toBe('test-task-id');
  });

  it('应该能获取运行中的任务数量', () => {
    mockRpc.getRunningTaskCount.mockReturnValue(3);
    expect(agent.getRunningTaskCount()).toBe(3);
  });
});

describe('PlanService', () => {
  it('应该识别缺失参数并生成 warning', () => {
    const service = Object.create(PlanService.prototype) as PlanService;
    const result = service.validateParams({
      ...samplePlan,
      steps: [
        {
          ...samplePlan.steps[0],
          params: { command: '' },
          requiredParams: ['command', 'outputPath'],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.missingParams).toEqual([
      expect.objectContaining({ paramName: 'command' }),
      expect.objectContaining({ paramName: 'outputPath' }),
    ]);
  });

  it('应该在追问兜底文案中合并缺失参数名', () => {
    const service = Object.create(PlanService.prototype) as PlanService;
    const buildFallbackQuestion = Reflect.get(service, 'buildFallbackQuestion') as (missingParams: Array<{ paramName: string }>) => string;

    const question = buildFallbackQuestion.call(service, [
      { paramName: 'path' },
      { paramName: 'language' },
    ]);

    expect(question).toContain('path');
    expect(question).toContain('language');
  });
});
