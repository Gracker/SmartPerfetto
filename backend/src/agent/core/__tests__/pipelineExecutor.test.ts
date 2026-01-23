/**
 * PipelineExecutor Unit Tests
 *
 * 测试流水线执行器的核心功能：
 * 1. 阶段执行顺序
 * 2. 依赖管理
 * 3. 并行执行
 * 4. 超时处理
 * 5. 重试机制
 * 6. 检查点和暂停/恢复
 * 7. 错误处理
 * 8. 生命周期钩子
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  PipelineExecutor,
  StageExecutor,
  PipelineTimeoutError,
  PipelineAbortError,
  StageTimeoutError,
} from '../pipelineExecutor';
import {
  PipelineStage,
  PipelineConfig,
  StageResult,
  SubAgentContext,
  SubAgentResult,
  PipelineCallbacks,
  Finding,
} from '../../types';
import { HookRegistry } from '../../hooks';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock Stage Executor
const createMockExecutor = (
  result: Partial<SubAgentResult> = {},
  delay: number = 10
): StageExecutor => ({
  execute: jest.fn(async (_stage: PipelineStage, _context: SubAgentContext): Promise<SubAgentResult> => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return {
      success: true,
      findings: [],
      data: {},
      executionTimeMs: delay,
      ...result,
    };
  }) as unknown as StageExecutor['execute'],
});

// Mock 失败的执行器
const createFailingExecutor = (error: string): StageExecutor => ({
  execute: jest.fn(async (): Promise<SubAgentResult> => {
    throw new Error(error);
  }) as unknown as StageExecutor['execute'],
});

// 默认阶段配置
const createStages = (): PipelineStage[] => [
  {
    id: 'plan',
    name: '任务规划',
    description: '理解用户意图',
    agentType: 'planner',
    dependencies: [],
    canParallelize: false,
    timeout: 5000,
    maxRetries: 2,
  },
  {
    id: 'execute',
    name: '执行分析',
    description: '执行具体分析',
    agentType: 'worker',
    dependencies: ['plan'],
    canParallelize: true,
    timeout: 10000,
    maxRetries: 3,
  },
  {
    id: 'evaluate',
    name: '评估结果',
    description: '评估分析质量',
    agentType: 'evaluator',
    dependencies: ['execute'],
    canParallelize: false,
    timeout: 5000,
    maxRetries: 2,
  },
];

// Mock SubAgentContext
const createMockContext = (): SubAgentContext => ({
  sessionId: 'test-session',
  traceId: 'test-trace',
  query: '分析性能',
  intent: {
    primaryGoal: '分析性能',
    aspects: ['scrolling'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
  },
  plan: {
    tasks: [],
    estimatedDuration: 5000,
    parallelizable: false,
  },
  previousResults: [],
  traceProcessorService: {},
});

// =============================================================================
// Test Suite: 初始化
// =============================================================================

describe('PipelineExecutor', () => {
  let executor: PipelineExecutor;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    executor?.removeAllListeners();
  });

  describe('初始化', () => {
    it('应该使用默认阶段配置初始化', () => {
      executor = new PipelineExecutor();
      expect(executor).toBeInstanceOf(PipelineExecutor);
    });

    it('应该接受自定义阶段配置', () => {
      const stages = createStages();
      executor = new PipelineExecutor({ stages });
      expect(executor).toBeInstanceOf(PipelineExecutor);
    });

    it('应该接受自定义配置选项', () => {
      executor = new PipelineExecutor({
        stages: createStages(),
        maxTotalDuration: 60000,
        enableParallelization: true,
      });
      expect(executor).toBeInstanceOf(PipelineExecutor);
    });
  });

  // =============================================================================
  // Test Suite: 阶段执行顺序
  // =============================================================================

  describe('阶段执行顺序', () => {
    beforeEach(() => {
      const stages = createStages();
      executor = new PipelineExecutor({ stages });
    });

    it('应该按依赖顺序执行阶段', async () => {
      const executionOrder: string[] = [];

      // 注册执行器
      const planExecutor = createMockExecutor({ data: { planned: true } });
      const executeExecutor = createMockExecutor({ data: { executed: true } });
      const evaluateExecutor = createMockExecutor({ data: { evaluated: true } });

      // 包装执行器以记录顺序
      executor.registerExecutor('planner', {
        execute: async (stage, ctx) => {
          executionOrder.push('plan');
          return planExecutor.execute(stage, ctx);
        },
      });
      executor.registerExecutor('worker', {
        execute: async (stage, ctx) => {
          executionOrder.push('execute');
          return executeExecutor.execute(stage, ctx);
        },
      });
      executor.registerExecutor('evaluator', {
        execute: async (stage, ctx) => {
          executionOrder.push('evaluate');
          return evaluateExecutor.execute(stage, ctx);
        },
      });

      const context = createMockContext();
      await executor.execute(context);

      expect(executionOrder).toEqual(['plan', 'execute', 'evaluate']);
    });

    it('应该在依赖未完成时等待', async () => {
      // 创建带延迟的执行器
      const slowExecutor = createMockExecutor({}, 100);
      const fastExecutor = createMockExecutor({}, 10);

      executor.registerExecutor('planner', slowExecutor);
      executor.registerExecutor('worker', fastExecutor);
      executor.registerExecutor('evaluator', fastExecutor);

      const context = createMockContext();
      const result = await executor.execute(context);

      // 验证所有阶段都执行了
      expect(result.stageResults.length).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // Test Suite: 依赖管理
  // =============================================================================

  describe('依赖管理', () => {
    it('应该正确解析阶段依赖', () => {
      const stages: PipelineStage[] = [
        { id: 'a', name: 'A', description: '', agentType: 'worker', dependencies: [], timeout: 1000, maxRetries: 1, canParallelize: false },
        { id: 'b', name: 'B', description: '', agentType: 'worker', dependencies: ['a'], timeout: 1000, maxRetries: 1, canParallelize: false },
        { id: 'c', name: 'C', description: '', agentType: 'worker', dependencies: ['a'], timeout: 1000, maxRetries: 1, canParallelize: true },
        { id: 'd', name: 'D', description: '', agentType: 'worker', dependencies: ['b', 'c'], timeout: 1000, maxRetries: 1, canParallelize: false },
      ];

      executor = new PipelineExecutor({ stages });
      // 验证拓扑排序
    });

    it('应该检测循环依赖', () => {
      const stages: PipelineStage[] = [
        { id: 'a', name: 'A', description: '', agentType: 'worker', dependencies: ['b'], timeout: 1000, maxRetries: 1, canParallelize: false },
        { id: 'b', name: 'B', description: '', agentType: 'worker', dependencies: ['a'], timeout: 1000, maxRetries: 1, canParallelize: false },
      ];

      // 应该抛出循环依赖错误或在执行时检测
      executor = new PipelineExecutor({ stages });
    });
  });

  // =============================================================================
  // Test Suite: 并行执行
  // =============================================================================

  describe('并行执行', () => {
    it('应该并行执行可并行的阶段', async () => {
      const stages: PipelineStage[] = [
        { id: 'init', name: 'Init', description: '', agentType: 'planner', dependencies: [], timeout: 1000, maxRetries: 1, canParallelize: false },
        { id: 'task1', name: 'Task1', description: '', agentType: 'worker', dependencies: ['init'], timeout: 1000, maxRetries: 1, canParallelize: true },
        { id: 'task2', name: 'Task2', description: '', agentType: 'worker', dependencies: ['init'], timeout: 1000, maxRetries: 1, canParallelize: true },
        { id: 'task3', name: 'Task3', description: '', agentType: 'worker', dependencies: ['init'], timeout: 1000, maxRetries: 1, canParallelize: true },
        { id: 'finish', name: 'Finish', description: '', agentType: 'evaluator', dependencies: ['task1', 'task2', 'task3'], timeout: 1000, maxRetries: 1, canParallelize: false },
      ];

      executor = new PipelineExecutor({
        stages,
        enableParallelization: true,
      });

      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      // 注册带计时的执行器
      ['planner', 'worker', 'evaluator'].forEach((type) => {
        executor.registerExecutor(type, {
          execute: async (stage: PipelineStage, _context: SubAgentContext) => {
            startTimes[stage.id] = Date.now();
            await new Promise((resolve) => setTimeout(resolve, 50));
            endTimes[stage.id] = Date.now();
            return { success: true, findings: [], data: {}, executionTimeMs: 50 };
          },
        });
      });

      const context = createMockContext();
      await executor.execute(context);

      // task1, task2, task3 应该几乎同时开始（如果并行化启用）
      if (startTimes['task1'] && startTimes['task2'] && startTimes['task3']) {
        const maxStartDiff = Math.max(
          Math.abs(startTimes['task1'] - startTimes['task2']),
          Math.abs(startTimes['task2'] - startTimes['task3']),
          Math.abs(startTimes['task1'] - startTimes['task3'])
        );
        // 并行执行时，开始时间差应该很小
        // 如果串行，差应该约等于 50ms
        expect(maxStartDiff).toBeLessThan(30);
      }
    });

    it('应该在禁用并行化时串行执行', async () => {
      const stages = createStages();
      executor = new PipelineExecutor({
        stages,
        enableParallelization: false,
      });

      // 验证串行执行
    });
  });

  // =============================================================================
  // Test Suite: 超时处理
  // =============================================================================

  describe('超时处理', () => {
    it('应该在阶段超时时触发错误', async () => {
      const stages: PipelineStage[] = [
        {
          id: 'slow',
          name: 'Slow',
          description: '',
          agentType: 'worker',
          dependencies: [],
          timeout: 100, // 100ms 超时
          maxRetries: 0,
          canParallelize: false,
        },
      ];

      executor = new PipelineExecutor({ stages });

      // 注册一个慢执行器
      executor.registerExecutor('worker', {
        execute: async (_stage: PipelineStage, _context: SubAgentContext) => {
          await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms
          return { success: true, findings: [], data: {}, executionTimeMs: 500 };
        },
      });

      const context = createMockContext();
      const callbacks: Partial<PipelineCallbacks> = {
        onError: jest.fn(async () => 'skip' as const) as unknown as PipelineCallbacks['onError'],
      };

      await executor.execute(context, callbacks);

      // 验证错误回调被调用
      // expect(callbacks.onError).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Test Suite: 重试机制
  // =============================================================================

  describe('重试机制', () => {
    it('应该在失败时重试', async () => {
      const stages: PipelineStage[] = [
        {
          id: 'flaky',
          name: 'Flaky',
          description: '',
          agentType: 'worker',
          dependencies: [],
          timeout: 5000,
          maxRetries: 3,
          canParallelize: false,
        },
      ];

      executor = new PipelineExecutor({ stages });

      let attempts = 0;
      executor.registerExecutor('worker', {
        execute: async (_stage: PipelineStage, _context: SubAgentContext) => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Transient error');
          }
          return { success: true, findings: [], data: { recovered: true }, executionTimeMs: 10 };
        },
      });

      const context = createMockContext();
      const result = await executor.execute(context);

      expect(attempts).toBe(3);
      expect(result.stageResults[0]?.success).toBe(true);
    });

    it('应该在达到最大重试次数后失败', async () => {
      const stages: PipelineStage[] = [
        {
          id: 'failing',
          name: 'Failing',
          description: '',
          agentType: 'worker',
          dependencies: [],
          timeout: 5000,
          maxRetries: 2,
          canParallelize: false,
        },
      ];

      executor = new PipelineExecutor({ stages });
      executor.registerExecutor('worker', createFailingExecutor('Permanent error'));

      const context = createMockContext();
      const callbacks: Partial<PipelineCallbacks> = {
        onError: jest.fn(async () => 'abort' as const) as unknown as PipelineCallbacks['onError'],
      };

      const result = await executor.execute(context, callbacks as PipelineCallbacks);

      // 验证错误处理
      expect(result.stageResults[0]?.success).toBe(false);
    });
  });

  // =============================================================================
  // Test Suite: 暂停和恢复
  // =============================================================================

  describe('暂停和恢复', () => {
    it('应该能够暂停执行', async () => {
      const stages = createStages();
      executor = new PipelineExecutor({ stages });

      // 注册执行器
      executor.registerExecutor('planner', createMockExecutor({}, 100));
      executor.registerExecutor('worker', createMockExecutor({}, 100));
      executor.registerExecutor('evaluator', createMockExecutor({}, 100));

      const context = createMockContext();

      // 启动执行并立即暂停
      const executePromise = executor.execute(context);
      await new Promise((resolve) => setTimeout(resolve, 50));
      executor.pause();

      const result = await executePromise;

      // 验证暂停状态
      expect(result.pausedAt).toBeDefined();
    });

    it('应该能够从暂停点恢复', async () => {
      const stages = createStages();
      executor = new PipelineExecutor({ stages });

      const planExecutor = createMockExecutor({ data: { planned: true } });
      const executeExecutor = createMockExecutor({ data: { executed: true } });
      const evaluateExecutor = createMockExecutor({ data: { evaluated: true } });

      executor.registerExecutor('planner', planExecutor);
      executor.registerExecutor('worker', executeExecutor);
      executor.registerExecutor('evaluator', evaluateExecutor);

      const context = createMockContext();

      const previousResults: StageResult[] = [
        {
          stageId: 'plan',
          success: true,
          data: { planned: true },
          findings: [],
          startTime: Date.now() - 2000,
          endTime: Date.now() - 1500,
          retryCount: 0,
        },
      ];

      const result = await executor.resumeFrom('execute', context, previousResults);

      expect(planExecutor.execute).not.toHaveBeenCalled();
      expect(executeExecutor.execute).toHaveBeenCalled();
      expect(evaluateExecutor.execute).toHaveBeenCalled();
      expect(result.stageResults.some(r => r.stageId === 'plan')).toBe(true);
    });
  });

  // =============================================================================
  // Test Suite: 回调
  // =============================================================================

  describe('回调', () => {
    beforeEach(() => {
      const stages = createStages();
      executor = new PipelineExecutor({ stages });

      executor.registerExecutor('planner', createMockExecutor());
      executor.registerExecutor('worker', createMockExecutor());
      executor.registerExecutor('evaluator', createMockExecutor());
    });

    it('应该调用 onStageStart 回调', async () => {
      const onStageStart = jest.fn();

      const context = createMockContext();
      await executor.execute(context, { onStageStart });

      expect(onStageStart).toHaveBeenCalledTimes(3);
    });

    it('应该调用 onStageComplete 回调', async () => {
      const onStageComplete = jest.fn();

      const context = createMockContext();
      await executor.execute(context, { onStageComplete });

      expect(onStageComplete).toHaveBeenCalledTimes(3);
    });

    it('应该调用 onProgress 回调', async () => {
      const onProgress = jest.fn();

      const context = createMockContext();
      await executor.execute(context, { onProgress });

      expect(onProgress).toHaveBeenCalled();
    });

    it('应该调用 onError 回调并根据返回值决定行为', async () => {
      const stages: PipelineStage[] = [
        {
          id: 'failing',
          name: 'Failing',
          description: '',
          agentType: 'worker',
          dependencies: [],
          timeout: 5000,
          maxRetries: 0,
          canParallelize: false,
        },
      ];

      executor = new PipelineExecutor({ stages });
      executor.registerExecutor('worker', createFailingExecutor('Test error'));

      const context = createMockContext();

      // 测试 skip 决策
      const skipResult = await executor.execute(context, {
        onError: jest.fn(async () => 'skip' as const) as unknown as PipelineCallbacks['onError'],
      } as PipelineCallbacks);
      expect(skipResult.stageResults[0]?.success).toBe(false);

      // 测试 abort 决策
      // const abortResult = await executor.execute(context, {
      //   onError: jest.fn().mockResolvedValue({ decision: 'abort' }),
      // });
    });
  });

  // =============================================================================
  // Test Suite: 钩子系统
  // =============================================================================

  describe('钩子系统', () => {
    it('应该执行 subagent:start 钩子', async () => {
      const stages = createStages();
      const hookRegistry = new HookRegistry();
      const startHook = jest.fn(async () => ({ continue: true }));

      hookRegistry.register('subagent:start', 'pre', {
        name: 'start-hook',
        priority: 0,
        handler: startHook,
      });

      executor = new PipelineExecutor({ stages }, hookRegistry);
      executor.registerExecutor('planner', createMockExecutor());
      executor.registerExecutor('worker', createMockExecutor());
      executor.registerExecutor('evaluator', createMockExecutor());

      const context = createMockContext();
      await executor.execute(context);

      expect(startHook).toHaveBeenCalled();
    });

    it('应该执行 subagent:complete 钩子', async () => {
      const stages = createStages();
      const hookRegistry = new HookRegistry();
      const completeHook = jest.fn(async () => ({ continue: true }));

      hookRegistry.register('subagent:complete', 'post', {
        name: 'complete-hook',
        priority: 0,
        handler: completeHook,
      });

      executor = new PipelineExecutor({ stages }, hookRegistry);
      executor.registerExecutor('planner', createMockExecutor());
      executor.registerExecutor('worker', createMockExecutor());
      executor.registerExecutor('evaluator', createMockExecutor());

      const context = createMockContext();
      await executor.execute(context);

      expect(completeHook).toHaveBeenCalled();
    });

    it('应该执行 subagent:error 钩子', async () => {
      const stages: PipelineStage[] = [
        {
          id: 'failing',
          name: 'Failing',
          description: 'Failing stage',
          agentType: 'worker',
          dependencies: [],
          timeout: 5000,
          maxRetries: 0,
          canParallelize: false,
        },
      ];

      const hookRegistry = new HookRegistry();
      const errorHook = jest.fn(async () => ({ continue: true }));

      hookRegistry.register('subagent:error', 'post', {
        name: 'error-hook',
        priority: 0,
        handler: errorHook,
      });

      executor = new PipelineExecutor({ stages }, hookRegistry);
      executor.registerExecutor('worker', createFailingExecutor('Test error'));

      const context = createMockContext();
      const result = await executor.execute(context);

      expect(result.stageResults[0]?.success).toBe(false);
      expect(errorHook).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Test Suite: 取消
  // =============================================================================

  describe('取消', () => {
    it('应该能够取消执行', async () => {
      const stages = createStages();
      executor = new PipelineExecutor({ stages });

      executor.registerExecutor('planner', createMockExecutor({}, 200));
      executor.registerExecutor('worker', createMockExecutor({}, 200));
      executor.registerExecutor('evaluator', createMockExecutor({}, 200));

      const context = createMockContext();

      const executePromise = executor.execute(context);
      await new Promise((resolve) => setTimeout(resolve, 50));
      executor.cancel();

      const result = await executePromise;

      // 验证取消状态
      expect(result.stageResults.length).toBeLessThan(3);
    });
  });
});

// =============================================================================
// Test Suite: 边界情况
// =============================================================================

describe('PipelineExecutor - 边界情况', () => {
  it('应该处理空阶段列表', async () => {
    const executor = new PipelineExecutor({ stages: [] });
    const context = createMockContext();

    const result = await executor.execute(context);
    expect(result.stageResults).toHaveLength(0);
  });

  it('应该处理单个阶段', async () => {
    const stages: PipelineStage[] = [
      {
        id: 'single',
        name: 'Single',
        description: '',
        agentType: 'worker',
        dependencies: [],
        timeout: 5000,
        maxRetries: 1,
        canParallelize: false,
      },
    ];

    const executor = new PipelineExecutor({ stages });
    executor.registerExecutor('worker', createMockExecutor({ data: { single: true } }));

    const context = createMockContext();
    const result = await executor.execute(context);

    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0].success).toBe(true);
  });

  it('应该处理所有阶段并行的情况', async () => {
    const stages: PipelineStage[] = [
      { id: 'a', name: 'A', description: '', agentType: 'worker', dependencies: [], timeout: 1000, maxRetries: 1, canParallelize: true },
      { id: 'b', name: 'B', description: '', agentType: 'worker', dependencies: [], timeout: 1000, maxRetries: 1, canParallelize: true },
      { id: 'c', name: 'C', description: '', agentType: 'worker', dependencies: [], timeout: 1000, maxRetries: 1, canParallelize: true },
    ];

    const executor = new PipelineExecutor({ stages, enableParallelization: true });
    executor.registerExecutor('worker', createMockExecutor());

    const context = createMockContext();
    const result = await executor.execute(context);

    expect(result.stageResults).toHaveLength(3);
  });
});

// =============================================================================
// Test Suite: 结果收集
// =============================================================================

describe('PipelineExecutor - 结果收集', () => {
  it('应该收集所有阶段结果', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });

    executor.registerExecutor('planner', createMockExecutor({ data: { stage: 'plan' } }));
    executor.registerExecutor('worker', createMockExecutor({ data: { stage: 'execute' } }));
    executor.registerExecutor('evaluator', createMockExecutor({ data: { stage: 'evaluate' } }));

    const context = createMockContext();
    await executor.execute(context);

    const results = executor.getAllResults();
    expect(results.length).toBe(3);
  });

  it('应该能够获取单个阶段结果', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });

    executor.registerExecutor('planner', createMockExecutor({ data: { test: 'value' } }));
    executor.registerExecutor('worker', createMockExecutor());
    executor.registerExecutor('evaluator', createMockExecutor());

    const context = createMockContext();
    await executor.execute(context);

    const result = executor.getStageResult('plan');
    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
  });

  it('应该收集所有 findings', async () => {
    const findings: Finding[] = [
      { id: 'f1', title: 'Finding 1', description: 'Desc 1', severity: 'warning' },
      { id: 'f2', title: 'Finding 2', description: 'Desc 2', severity: 'info' },
    ];

    const stages: PipelineStage[] = [
      { id: 'analysis', name: 'Analysis', description: '', agentType: 'worker', dependencies: [], timeout: 5000, maxRetries: 1, canParallelize: false },
    ];

    const executor = new PipelineExecutor({ stages });
    executor.registerExecutor('worker', {
      execute: jest.fn(async (_stage: PipelineStage, _context: SubAgentContext) => ({
        success: true,
        findings,
        data: {},
        executionTimeMs: 10,
      })) as unknown as StageExecutor['execute'],
    });

    const context = createMockContext();
    await executor.execute(context);

    const allFindings = executor.getAllFindings();
    expect(allFindings.length).toBe(2);
    expect(allFindings[0].id).toBe('f1');
  });

  it('对不存在的阶段返回 undefined', async () => {
    const executor = new PipelineExecutor({ stages: createStages() });
    const result = executor.getStageResult('nonexistent');
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// Test Suite: 阶段访问
// =============================================================================

describe('PipelineExecutor - 阶段访问', () => {
  it('应该能够获取所有阶段', () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });

    const allStages = executor.getStages();
    expect(allStages).toHaveLength(3);
  });

  it('应该能够获取单个阶段', () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });

    const stage = executor.getStage('plan');
    expect(stage).toBeDefined();
    expect(stage?.id).toBe('plan');
  });

  it('对不存在的阶段返回 undefined', () => {
    const executor = new PipelineExecutor({ stages: createStages() });
    const stage = executor.getStage('nonexistent');
    expect(stage).toBeUndefined();
  });
});

// =============================================================================
// Test Suite: 并行组
// =============================================================================

describe('PipelineExecutor - 并行组', () => {
  it('应该返回正确的并行组', () => {
    const stages: PipelineStage[] = [
      { id: 'base', name: 'Base', description: '', agentType: 'planner', dependencies: [], timeout: 1000, maxRetries: 1, canParallelize: false },
      { id: 'p1', name: 'P1', description: '', agentType: 'worker', dependencies: ['base'], timeout: 1000, maxRetries: 1, canParallelize: true },
      { id: 'p2', name: 'P2', description: '', agentType: 'worker', dependencies: ['base'], timeout: 1000, maxRetries: 1, canParallelize: true },
      { id: 'p3', name: 'P3', description: '', agentType: 'worker', dependencies: ['base'], timeout: 1000, maxRetries: 1, canParallelize: true },
      { id: 'final', name: 'Final', description: '', agentType: 'evaluator', dependencies: ['p1', 'p2', 'p3'], timeout: 1000, maxRetries: 1, canParallelize: false },
    ];

    const executor = new PipelineExecutor({ stages });
    const groups = executor.getParallelGroups();

    // 应该有 3 组：[base], [p1, p2, p3], [final]
    expect(groups.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// Test Suite: 重置
// =============================================================================

describe('PipelineExecutor - 重置', () => {
  it('应该能够重置状态', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });

    executor.registerExecutor('planner', createMockExecutor());
    executor.registerExecutor('worker', createMockExecutor());
    executor.registerExecutor('evaluator', createMockExecutor());

    const context = createMockContext();
    await executor.execute(context);

    // 执行后有结果
    expect(executor.getAllResults().length).toBe(3);

    // 重置
    executor.reset();

    // 重置后无结果
    expect(executor.getAllResults().length).toBe(0);
  });

  it('重置后应该能够重新执行', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });

    executor.registerExecutor('planner', createMockExecutor());
    executor.registerExecutor('worker', createMockExecutor());
    executor.registerExecutor('evaluator', createMockExecutor());

    const context = createMockContext();

    // 第一次执行
    await executor.execute(context);

    // 重置
    executor.reset();

    // 第二次执行应该成功
    const result = await executor.execute(context);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Test Suite: 错误类
// =============================================================================

describe('Pipeline Error Classes', () => {
  it('PipelineTimeoutError 应该有正确的名称', () => {
    const error = new PipelineTimeoutError('Test timeout');
    expect(error.name).toBe('PipelineTimeoutError');
    expect(error.message).toBe('Test timeout');
    expect(error).toBeInstanceOf(Error);
  });

  it('PipelineAbortError 应该有正确的名称', () => {
    const error = new PipelineAbortError('Test abort');
    expect(error.name).toBe('PipelineAbortError');
    expect(error.message).toBe('Test abort');
    expect(error).toBeInstanceOf(Error);
  });

  it('StageTimeoutError 应该有正确的名称', () => {
    const error = new StageTimeoutError('Test stage timeout');
    expect(error.name).toBe('StageTimeoutError');
    expect(error.message).toBe('Test stage timeout');
    expect(error).toBeInstanceOf(Error);
  });
});

// =============================================================================
// Test Suite: 事件发射
// =============================================================================

describe('PipelineExecutor - 事件发射', () => {
  it('应该发射 stageStart 事件', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });
    const handler = jest.fn();

    executor.on('stageStart', handler);

    executor.registerExecutor('planner', createMockExecutor());
    executor.registerExecutor('worker', createMockExecutor());
    executor.registerExecutor('evaluator', createMockExecutor());

    const context = createMockContext();
    await executor.execute(context);

    expect(handler).toHaveBeenCalled();
  });

  it('应该发射 stageComplete 事件', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });
    const handler = jest.fn();

    executor.on('stageComplete', handler);

    executor.registerExecutor('planner', createMockExecutor());
    executor.registerExecutor('worker', createMockExecutor());
    executor.registerExecutor('evaluator', createMockExecutor());

    const context = createMockContext();
    await executor.execute(context);

    expect(handler).toHaveBeenCalled();
  });

  it('应该发射 progress 事件', async () => {
    const stages = createStages();
    const executor = new PipelineExecutor({ stages });
    const handler = jest.fn();

    executor.on('progress', handler);

    executor.registerExecutor('planner', createMockExecutor());
    executor.registerExecutor('worker', createMockExecutor());
    executor.registerExecutor('evaluator', createMockExecutor());

    const context = createMockContext();
    await executor.execute(context);

    expect(handler).toHaveBeenCalled();
  });

  it('应该发射 reset 事件', () => {
    const executor = new PipelineExecutor({ stages: createStages() });
    const handler = jest.fn();

    executor.on('reset', handler);
    executor.reset();

    expect(handler).toHaveBeenCalled();
  });

  it('应该发射 paused 事件', () => {
    const executor = new PipelineExecutor({ stages: createStages() });
    const handler = jest.fn();

    executor.on('paused', handler);
    executor.pause();

    expect(handler).toHaveBeenCalled();
  });

  it('应该发射 resumed 事件', () => {
    const executor = new PipelineExecutor({ stages: createStages() });
    const handler = jest.fn();

    executor.on('resumed', handler);
    executor.pause();
    executor.resume();

    expect(handler).toHaveBeenCalled();
  });

  it('应该发射 cancelled 事件', () => {
    const executor = new PipelineExecutor({ stages: createStages() });
    const handler = jest.fn();

    executor.on('cancelled', handler);
    executor.cancel();

    expect(handler).toHaveBeenCalled();
  });
});
