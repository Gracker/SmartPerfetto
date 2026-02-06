import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DirectDrillDownExecutor } from '../directDrillDownExecutor';
import type { FollowUpResolution } from '../../followUpHandler';
import type { AnalysisServices, ExecutionContext, ProgressEmitter } from '../../orchestratorTypes';
import type { AgentResponse } from '../../../types/agentProtocol';
import { DirectSkillExecutor } from '../directSkillExecutor';
import { emitDataEnvelopes } from '../../taskGraphExecutor';
import { synthesizeFeedback } from '../../feedbackSynthesizer';

const mockExecuteTasks = jest.fn<any>();

jest.mock('../directSkillExecutor', () => ({
  DirectSkillExecutor: jest.fn(),
}));

jest.mock('../../taskGraphExecutor', () => ({
  emitDataEnvelopes: jest.fn(),
}));

jest.mock('../../feedbackSynthesizer', () => ({
  synthesizeFeedback: jest.fn(),
}));

const mockEmitDataEnvelopes = emitDataEnvelopes as jest.MockedFunction<typeof emitDataEnvelopes>;
const mockSynthesizeFeedback = synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>;

function createMockEmitter(): ProgressEmitter {
  return {
    emitUpdate: jest.fn(),
    log: jest.fn(),
  };
}

function createMockResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    agentId: 'cpu_agent',
    taskId: 'task_1',
    success: true,
    findings: [],
    confidence: 0.8,
    executionTimeMs: 10,
    toolResults: [
      {
        success: true,
        executionTimeMs: 8,
        data: {},
      },
    ],
    ...overrides,
  };
}

function createFollowUpResolution(): FollowUpResolution {
  return {
    isFollowUp: true,
    resolvedParams: { frame_id: 1435500 },
    focusIntervals: [
      {
        id: 1435500,
        processName: 'com.example.app',
        startTs: '1000000',
        endTs: '2000000',
        priority: 1,
        label: '帧 1435500',
        metadata: {
          sourceEntityType: 'frame',
          sourceEntityId: 1435500,
          frame_id: 1435500,
        },
      },
    ],
    confidence: 0.9,
  };
}

function createExecutionContext(query: string, aspects: string[] = []): ExecutionContext {
  return {
    query,
    sessionId: 'session-1',
    traceId: 'trace-1',
    intent: {
      primaryGoal: query,
      aspects,
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
      followUpType: 'drill_down',
    },
    initialHypotheses: [],
    sharedContext: {
      sessionId: 'session-1',
      traceId: 'trace-1',
      hypotheses: new Map(),
      confirmedFindings: [],
      investigationPath: [],
    },
    options: {
      traceProcessorService: {},
      packageName: 'com.example.app',
    },
    config: {
      maxRounds: 5,
      maxConcurrentTasks: 3,
      confidenceThreshold: 0.7,
      maxNoProgressRounds: 2,
      maxFailureRounds: 2,
      enableLogging: true,
    },
  };
}

function extractSkillIdsFromTasks(tasks: any[]): string[] {
  return Array.from(new Set(tasks.map(t => t.template?.directSkillId).filter(Boolean)));
}

describe('DirectDrillDownExecutor', () => {
  let services: AnalysisServices;
  let emitter: ProgressEmitter;

  beforeEach(() => {
    jest.clearAllMocks();

    services = {
      modelRouter: { callWithFallback: jest.fn() } as any,
      messageBus: {} as any,
      circuitBreaker: {} as any,
      emittedEnvelopeRegistry: undefined,
    };
    emitter = createMockEmitter();

    (DirectSkillExecutor as unknown as jest.Mock).mockImplementation(() => ({
      executeTasks: mockExecuteTasks,
    }));

    mockExecuteTasks.mockResolvedValue([createMockResponse()]);
    mockSynthesizeFeedback.mockResolvedValue({
      newFindings: [],
      confirmedFindings: [],
      updatedHypotheses: [],
      informationGaps: [],
    });
  });

  it('uses CPU in-range skills for cpu-focused drill-down follow-up', async () => {
    const executor = new DirectDrillDownExecutor(createFollowUpResolution(), services);
    const ctx = createExecutionContext('这一帧的 cpu 怎么样？', ['cpu']);

    await executor.execute(ctx, emitter);

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    const skillIds = extractSkillIdsFromTasks(tasks);

    expect(skillIds).toEqual(['cpu_load_in_range', 'scheduling_analysis']);
    expect(skillIds).not.toContain('jank_frame_detail');
  });

  it('includes cpu_freq_timeline for cpu frequency follow-up', async () => {
    const executor = new DirectDrillDownExecutor(createFollowUpResolution(), services);
    const ctx = createExecutionContext('这一帧的 cpu 频率变化是怎么样？', ['cpu', 'frequency']);

    await executor.execute(ctx, emitter);

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    const skillIds = extractSkillIdsFromTasks(tasks);

    expect(skillIds).toEqual([
      'cpu_freq_timeline',
      'cpu_load_in_range',
      'scheduling_analysis',
    ]);
  });

  it('keeps default frame drill-down skill for generic frame root-cause query', async () => {
    const executor = new DirectDrillDownExecutor(createFollowUpResolution(), services);
    const ctx = createExecutionContext('分析 1435500 这一帧的卡顿原因', ['frame']);

    await executor.execute(ctx, emitter);

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    const skillIds = extractSkillIdsFromTasks(tasks);

    expect(skillIds).toEqual(['jank_frame_detail']);
  });
});
