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

function createFollowUpResolutionNeedsEnrichment(): FollowUpResolution {
  return {
    isFollowUp: true,
    resolvedParams: { frame_id: 1435500 },
    focusIntervals: [
      {
        id: 1435500,
        processName: '',
        startTs: '0',
        endTs: '0',
        priority: 1,
        label: '帧 1435500',
        metadata: {
          sourceEntityType: 'frame',
          sourceEntityId: 1435500,
          frame_id: 1435500,
          needsEnrichment: true,
        },
      },
    ],
    confidence: 0.9,
  };
}

function createStartupFollowUpResolutionNeedsEnrichment(): FollowUpResolution {
  return {
    isFollowUp: true,
    resolvedParams: { startup_id: 12 },
    focusIntervals: [
      {
        id: 12,
        processName: '',
        startTs: '0',
        endTs: '0',
        priority: 1,
        label: '启动事件 12',
        metadata: {
          sourceEntityType: 'startup',
          sourceEntityId: 12,
          startup_id: 12,
          needsEnrichment: true,
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

  it('does not treat incidental core-like aspect tokens as cpu focus', async () => {
    const executor = new DirectDrillDownExecutor(createFollowUpResolution(), services);
    const ctx = createExecutionContext('分析 1435500 这个frame', ['scrolling_core_metrics', 'score']);

    await executor.execute(ctx, emitter);

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    const skillIds = extractSkillIdsFromTasks(tasks);

    expect(skillIds).toEqual(['jank_frame_detail']);
  });

  it('refreshes jank summary from current drill-down scope', async () => {
    const responseWithMechanism = createMockResponse({
      toolResults: [
        {
          success: true,
          executionTimeMs: 8,
          data: {},
          metadata: {
            frameMechanismRecord: {
              frameId: '1435500',
              sessionId: '7',
              startTs: '1000000',
              endTs: '2000000',
              scopeLabel: '帧 1435500',
              causeType: 'sched_latency',
              sourceStep: 'root_cause',
              supplyConstraint: 'scheduling_delay',
              amplificationPath: 'sf_consumer_backpressure',
            },
          },
        },
      ],
    });
    mockExecuteTasks.mockResolvedValue([responseWithMechanism]);

    const executor = new DirectDrillDownExecutor(createFollowUpResolution(), services);
    const ctx = createExecutionContext('分析 1435500 这一帧的卡顿原因', ['frame']);
    (ctx.sharedContext as any).jankCauseSummary = { totalJankFrames: 99 };

    await executor.execute(ctx, emitter);

    expect(ctx.sharedContext.frameMechanismRecords).toHaveLength(1);
    expect(ctx.sharedContext.jankCauseSummary?.totalJankFrames).toBe(1);
  });

  it('clears stale jank summary when current drill-down has no frame mechanism records', async () => {
    const executor = new DirectDrillDownExecutor(createFollowUpResolution(), services);
    const ctx = createExecutionContext('分析 1435500 这一帧的卡顿原因', ['frame']);
    (ctx.sharedContext as any).jankCauseSummary = { totalJankFrames: 99 };

    await executor.execute(ctx, emitter);

    expect(ctx.sharedContext.frameMechanismRecords).toEqual([]);
    expect(ctx.sharedContext.jankCauseSummary).toBeUndefined();
  });

  it('uses traceProcessorService.query(traceId, sql) for interval enrichment', async () => {
    const queryMock = jest.fn<any>().mockResolvedValue({
      columns: ['frame_id', 'start_ts', 'end_ts', 'process_name', 'jank_type', 'layer_name', 'vsync_missed'],
      rows: [[
        1435500,
        '123456789000000',
        '123456889000000',
        'com.example.app',
        'App Deadline Missed',
        'SurfaceView',
        1,
      ]],
    });

    const executor = new DirectDrillDownExecutor(createFollowUpResolutionNeedsEnrichment(), services);
    const ctx = createExecutionContext('分析 1435500 这一帧的卡顿原因', ['frame']);
    ctx.options.traceProcessorService = {
      query: queryMock,
    };

    await executor.execute(ctx, emitter);

    expect(queryMock).toHaveBeenCalledWith(
      'trace-1',
      expect.stringContaining('COALESCE(a.display_frame_token, a.surface_frame_token) = 1435500')
    );

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    expect(tasks[0].interval.startTs).toBe('123456789000000');
    expect(tasks[0].interval.endTs).toBe('123456889000000');
  });

  it('falls back to doFrame alias mapping when frame token enrichment misses', async () => {
    const queryMock = jest.fn<any>()
      // Primary lookup (actual_frame_timeline_slice by frame token) misses.
      .mockResolvedValueOnce({ columns: [], rows: [] })
      // Legacy lookup (android_frames.frame_id) misses.
      .mockResolvedValueOnce({ columns: [], rows: [] })
      // Alias lookup via Choreographer#doFrame name hit.
      .mockResolvedValueOnce({
        columns: ['frame_id', 'start_ts', 'end_ts', 'process_name', 'jank_type', 'layer_name'],
        rows: [[
          1435611,
          '223456789000000',
          '223456889000000',
          'com.example.app',
          'App Deadline Missed',
          'SurfaceView',
        ]],
      });

    const followUp: FollowUpResolution = {
      isFollowUp: true,
      resolvedParams: { frame_id: 1435596 },
      focusIntervals: [
        {
          id: 1435596,
          processName: '',
          startTs: '0',
          endTs: '0',
          priority: 1,
          label: '帧 1435596',
          metadata: {
            sourceEntityType: 'frame',
            sourceEntityId: 1435596,
            frame_id: 1435596,
            needsEnrichment: true,
          },
        },
      ],
      confidence: 0.9,
    };

    const executor = new DirectDrillDownExecutor(followUp, services);
    const ctx = createExecutionContext('分析 1435596 这一帧的卡顿原因', ['frame']);
    ctx.options.traceProcessorService = {
      query: queryMock,
    };

    await executor.execute(ctx, emitter);

    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[0][1]).toContain('actual_frame_timeline_slice');
    expect(queryMock.mock.calls[1][1]).toContain('FROM android_frames');
    expect(queryMock.mock.calls[2][1]).toContain('Choreographer#doFrame 1435596');

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    expect(tasks[0].interval.startTs).toBe('223456789000000');
    expect(tasks[0].interval.endTs).toBe('223456889000000');
    expect(tasks[0].interval.metadata.frame_id).toBe('1435611');
    expect(tasks[0].interval.metadata.resolvedFrom).toBe('doframe_alias');
  });

  it('routes startup drill-down to startup_detail and enriches startup interval', async () => {
    const queryMock = jest.fn<any>().mockResolvedValue({
      columns: ['startup_id', 'start_ts', 'end_ts', 'dur_ms', 'process_name', 'startup_type', 'ttid_ms', 'ttfd_ms'],
      rows: [[
        12,
        '323456789000000',
        '323457089000000',
        300,
        'com.example.app',
        'warm',
        280,
        320,
      ]],
    });

    const executor = new DirectDrillDownExecutor(createStartupFollowUpResolutionNeedsEnrichment(), services);
    const ctx = createExecutionContext('分析启动 12 的详细瓶颈', ['startup']);
    ctx.options.traceProcessorService = {
      query: queryMock,
    };

    await executor.execute(ctx, emitter);

    expect(queryMock).toHaveBeenCalledWith(
      'trace-1',
      expect.stringContaining('WHERE s.startup_id = 12')
    );

    const tasks = mockExecuteTasks.mock.calls[0][0] as any[];
    const skillIds = extractSkillIdsFromTasks(tasks);
    expect(skillIds).toEqual(['startup_detail']);
    expect(tasks[0].interval.startTs).toBe('323456789000000');
    expect(tasks[0].interval.endTs).toBe('323457089000000');
    expect(tasks[0].interval.metadata.startup_type).toBe('warm');
  });
});
