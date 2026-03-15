import { describe, expect, it, vi } from 'vitest';
import { OpenClawAgent } from '../../src/executor/openclaw-agent.js';
import { NemotronService } from '../../src/llm/nemotron.js';
import type { ExecutionPlan } from '../../src/types/index.js';

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
  it('应该返回带等待用户和步骤结果的执行状态', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'plan-1',
        status: 'waiting_user',
        currentStep: 'step-1',
        completedSteps: [],
        failedSteps: [],
        waitingForUser: true,
        stepResults: [
          {
            stepId: 'step-1',
            status: 'failed',
            error: 'missing command',
            duration: 1200,
          },
        ],
      }),
    });

    vi.stubGlobal('fetch', fetchMock);
    const agent = new OpenClawAgent();
    const status = await agent.getStatus('plan-1');

    expect(status.status).toBe('waiting_user');
    expect(status.waitingForUser).toBe(true);
    expect(status.stepResults).toEqual([
      expect.objectContaining({
        stepId: 'step-1',
        status: 'failed',
        duration: 1200,
      }),
    ]);

    vi.unstubAllGlobals();
  });

  it('应该使用指数退避计算轮询间隔', () => {
    const agent = new OpenClawAgent();
    const getPollingInterval = Reflect.get(agent, 'getPollingInterval') as (plan: ExecutionPlan, attempt?: number) => number;

    expect(getPollingInterval.call(agent, samplePlan, 0)).toBe(1000);
    expect(getPollingInterval.call(agent, samplePlan, 1)).toBe(2000);
    expect(getPollingInterval.call(agent, samplePlan, 3)).toBe(8000);
  });
});

describe('NemotronService', () => {
  it('应该识别缺失参数并生成 warning', () => {
    const service = Object.create(NemotronService.prototype) as NemotronService;
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
    const service = Object.create(NemotronService.prototype) as NemotronService;
    const buildFallbackQuestion = Reflect.get(service, 'buildFallbackQuestion') as (missingParams: Array<{ paramName: string }>) => string;

    const question = buildFallbackQuestion.call(service, [
      { paramName: 'path' },
      { paramName: 'language' },
    ]);

    expect(question).toContain('path');
    expect(question).toContain('language');
  });
});
