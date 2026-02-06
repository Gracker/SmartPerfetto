/**
 * StrategyExecutor Unit Tests
 *
 * Comprehensive tests for the deterministic multi-stage pipeline executor:
 * 1. Staged Execution (overview -> session_overview -> frame_analysis)
 * 2. Interval Extraction from stage results
 * 3. Per-Interval Execution with timestamp parameters
 * 4. Direct Skill Mode (zero LLM overhead)
 * 5. Stage Skipping (prebuilt intervals, frame-level drill-down)
 * 6. Entity Capture (frames, sessions)
 * 7. Error Handling and graceful degradation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { StrategyExecutor } from '../strategyExecutor';
import type {
  StagedAnalysisStrategy,
  StageDefinition,
  StageTaskTemplate,
  FocusInterval,
  IntervalHelpers,
} from '../../../strategies/types';
import type {
  AgentResponse,
  AgentTask,
  SharedAgentContext,
  Hypothesis,
} from '../../../types/agentProtocol';
import type {
  AnalysisServices,
  ExecutionContext,
  ProgressEmitter,
} from '../../orchestratorTypes';
import type { Intent, Finding } from '../../../types';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock the dependencies
jest.mock('../../taskGraphExecutor', () => ({
  executeTaskGraph: jest.fn(),
  emitDataEnvelopes: jest.fn(),
}));

jest.mock('../../feedbackSynthesizer', () => ({
  synthesizeFeedback: jest.fn(),
}));

jest.mock('../directSkillExecutor', () => ({
  DirectSkillExecutor: jest.fn().mockImplementation(() => ({
    executeTasks: jest.fn(),
  })),
}));

jest.mock('../traceConfigDetector', () => ({
  detectTraceConfig: jest.fn(),
}));

jest.mock('../../jankCauseSummarizer', () => ({
  summarizeJankCauses: jest.fn(),
}));

jest.mock('../../entityCapture', () => ({
  captureEntitiesFromResponses: jest.fn(),
  captureEntitiesFromIntervals: jest.fn(),
  mergeCapturedEntities: jest.fn(),
}));

// Import mocked modules
import { executeTaskGraph, emitDataEnvelopes } from '../../taskGraphExecutor';
import { synthesizeFeedback } from '../../feedbackSynthesizer';
import { DirectSkillExecutor } from '../directSkillExecutor';
import { detectTraceConfig } from '../traceConfigDetector';
import { summarizeJankCauses } from '../../jankCauseSummarizer';
import {
  captureEntitiesFromResponses,
  captureEntitiesFromIntervals,
  mergeCapturedEntities,
} from '../../entityCapture';

// =============================================================================
// Test Utilities
// =============================================================================

function createMockProgressEmitter(): ProgressEmitter {
  return {
    emitUpdate: jest.fn(),
    log: jest.fn(),
  };
}

function createMockSharedContext(): SharedAgentContext {
  return {
    sessionId: 'test-session-123',
    traceId: 'trace-456',
    hypotheses: new Map(),
    confirmedFindings: [],
    investigationPath: [],
  };
}

function createMockIntent(): Intent {
  return {
    primaryGoal: 'Analyze scrolling jank',
    aspects: ['frame rendering', 'cpu usage'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
  };
}

function createMockServices(): AnalysisServices {
  return {
    modelRouter: {
      callWithFallback: jest.fn(),
    } as any,
    messageBus: {
      dispatch: jest.fn(),
      subscribe: jest.fn(),
    } as any,
    circuitBreaker: {
      recordFailure: jest.fn().mockReturnValue({ action: 'continue' }),
      recordSuccess: jest.fn(),
      forceClose: jest.fn(),
      isClosed: true,
    } as any,
    emittedEnvelopeRegistry: {
      filterNewEnvelopes: jest.fn((envs: any[]) => envs),
    } as any,
  };
}

function createMockExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    query: 'analyze scrolling jank',
    sessionId: 'test-session-123',
    traceId: 'trace-456',
    intent: createMockIntent(),
    initialHypotheses: [],
    sharedContext: createMockSharedContext(),
    options: {
      traceProcessorService: { executeQuery: jest.fn() },
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
    ...overrides,
  };
}

function createMockAgentResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    agentId: 'frame_agent',
    taskId: 'task_123',
    success: true,
    findings: [],
    confidence: 0.8,
    executionTimeMs: 100,
    toolResults: [{
      success: true,
      executionTimeMs: 50,
      data: {},
    }],
    ...overrides,
  };
}

function createMockFocusInterval(overrides: Partial<FocusInterval> = {}): FocusInterval {
  return {
    id: 1,
    processName: 'com.example.app',
    startTs: '100000000000000',
    endTs: '200000000000000',
    priority: 1,
    label: 'Test Interval',
    metadata: {},
    ...overrides,
  };
}

// =============================================================================
// Mock Strategy Definitions
// =============================================================================

function createOverviewStageDefinition(
  extractFn?: (responses: AgentResponse[], helpers: IntervalHelpers) => FocusInterval[],
  shouldStopFn?: (intervals: FocusInterval[]) => { stop: boolean; reason: string }
): StageDefinition {
  return {
    name: 'overview',
    description: 'Locate jank intervals',
    progressMessageTemplate: 'Stage {{stageIndex}}/{{totalStages}}: Overview',
    tasks: [{
      agentId: 'frame_agent',
      domain: 'frame',
      scope: 'global',
      priority: 1,
      evidenceNeeded: ['scroll sessions'],
      skillParams: {},
      descriptionTemplate: 'Analyze scrolling overview',
    }],
    extractIntervals: extractFn,
    shouldStop: shouldStopFn,
  };
}

function createSessionOverviewStageDefinition(
  extractFn?: (responses: AgentResponse[], helpers: IntervalHelpers) => FocusInterval[]
): StageDefinition {
  return {
    name: 'session_overview',
    description: 'Session-level stats',
    progressMessageTemplate: 'Stage {{stageIndex}}/{{totalStages}}: Session Overview',
    tasks: [{
      agentId: 'frame_agent',
      domain: 'frame',
      scope: 'per_interval',
      priority: 1,
      evidenceNeeded: ['frame list'],
      skillParams: {},
      descriptionTemplate: 'Analyze session {{scopeLabel}}',
    }],
    extractIntervals: extractFn,
  };
}

function createFrameAnalysisStageDefinition(): StageDefinition {
  return {
    name: 'frame_analysis',
    description: 'Per-frame deep dive',
    progressMessageTemplate: 'Stage {{stageIndex}}/{{totalStages}}: Frame Analysis',
    tasks: [{
      agentId: 'frame_agent',
      domain: 'frame',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'jank_frame_detail',
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
      descriptionTemplate: 'Analyze frame {{scopeLabel}}',
    }],
  };
}

function createMockStrategy(stages: StageDefinition[]): StagedAnalysisStrategy {
  return {
    id: 'test_strategy',
    name: 'Test Strategy',
    trigger: () => true,
    stages,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('StrategyExecutor', () => {
  let mockServices: AnalysisServices;
  let mockEmitter: ProgressEmitter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockServices = createMockServices();
    mockEmitter = createMockProgressEmitter();

    // Default mock implementations
    (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockResolvedValue([createMockAgentResponse()]);
    (synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>).mockResolvedValue({
      confirmedFindings: [],
      updatedHypotheses: [],
      newFindings: [],
      informationGaps: [],
    });
    (detectTraceConfig as jest.MockedFunction<typeof detectTraceConfig>).mockResolvedValue({
      vsyncPeriodNs: 16666666,
      refreshRateHz: 60,
      vsyncPeriodMs: 16.67,
    });
    (captureEntitiesFromResponses as jest.MockedFunction<typeof captureEntitiesFromResponses>).mockReturnValue({
      frames: [],
      sessions: [],
      cpuSlices: [],
      binders: [],
      gcs: [],
      memories: [],
      generics: [],
      candidateFrameIds: [],
      candidateSessionIds: [],
    });
    (captureEntitiesFromIntervals as jest.MockedFunction<typeof captureEntitiesFromIntervals>).mockReturnValue({
      frames: [],
      sessions: [],
      cpuSlices: [],
      binders: [],
      gcs: [],
      memories: [],
      generics: [],
      candidateFrameIds: [],
      candidateSessionIds: [],
    });
    (mergeCapturedEntities as jest.MockedFunction<typeof mergeCapturedEntities>).mockReturnValue({
      frames: [],
      sessions: [],
      cpuSlices: [],
      binders: [],
      gcs: [],
      memories: [],
      generics: [],
      candidateFrameIds: [],
      candidateSessionIds: [],
    });
    (summarizeJankCauses as jest.MockedFunction<typeof summarizeJankCauses>).mockReturnValue({
      totalJankFrames: 0,
      primaryCause: null,
      secondaryCauses: [],
      allCauses: [],
      summaryText: '',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // ===========================================================================
  // Staged Execution Tests
  // ===========================================================================

  describe('Staged Execution', () => {
    it('executes stages in order (0 -> 1 -> 2)', async () => {
      const stageOrder: string[] = [];

      const stage0 = createOverviewStageDefinition(
        () => [createMockFocusInterval({ id: 1 })],
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition(
        () => [createMockFocusInterval({ id: 1, metadata: { sourceEntityType: 'frame', frameId: 1 } })]
      );
      const stage2 = createFrameAnalysisStageDefinition();

      // Track stage execution order
      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockImplementation(async (tasks: any) => {
        const stageTask = tasks[0];
        if (stageTask.description.includes('overview')) {
          stageOrder.push('overview');
        } else if (stageTask.description.includes('session')) {
          stageOrder.push('session_overview');
        }
        return [createMockAgentResponse()];
      });

      // Mock DirectSkillExecutor for stage 2
      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([createMockAgentResponse()]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => {
        stageOrder.push('frame_analysis');
        return mockDirectExecutor as any;
      });

      const strategy = createMockStrategy([stage0, stage1, stage2]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      expect(stageOrder).toEqual(['overview', 'session_overview', 'frame_analysis']);
    });

    it('passes stage results to next stage via focusIntervals', async () => {
      const extractedIntervals: FocusInterval[] = [
        createMockFocusInterval({ id: 1, label: 'Session 1' }),
        createMockFocusInterval({ id: 2, label: 'Session 2' }),
      ];

      const stage0 = createOverviewStageDefinition(
        () => extractedIntervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockResolvedValue([createMockAgentResponse()]);

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      // Stage 1 should receive tasks for each interval
      const stage1Calls = (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mock.calls;
      // Second call is for stage 1 with per_interval scope
      expect(stage1Calls.length).toBe(2);
      const stage1Tasks = stage1Calls[1][0] as AgentTask[];
      expect(stage1Tasks.length).toBe(2); // One task per interval
    });

    it('emits stage_start events for each stage', async () => {
      const stage0 = createOverviewStageDefinition(
        () => [createMockFocusInterval()],
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const stageTransitions = emitCalls.filter(
        (call: any[]) => call[0] === 'stage_transition'
      );

      expect(stageTransitions.length).toBe(2);
      expect((stageTransitions[0][1] as any).stageName).toBe('overview');
      expect((stageTransitions[1][1] as any).stageName).toBe('session_overview');
    });
  });

  // ===========================================================================
  // Interval Extraction Tests
  // ===========================================================================

  describe('Interval Extraction', () => {
    it('extracts intervals from overview stage using extractIntervals callback', async () => {
      const mockExtractIntervals = jest.fn<(responses: AgentResponse[], helpers: IntervalHelpers) => FocusInterval[]>()
        .mockReturnValue([
          createMockFocusInterval({ id: 1 }),
          createMockFocusInterval({ id: 2 }),
        ]);

      const stage0 = createOverviewStageDefinition(
        mockExtractIntervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      expect(mockExtractIntervals).toHaveBeenCalled();
      // Verify helpers were passed
      const callArgs = mockExtractIntervals.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('payloadToObjectRows');
      expect(callArgs[1]).toHaveProperty('isLikelyAppProcessName');
      expect(callArgs[1]).toHaveProperty('formatNsRangeLabel');
    });

    it('handles empty intervals gracefully', async () => {
      const stage0 = createOverviewStageDefinition(
        () => [], // Return empty intervals
        (intervals) => ({
          stop: intervals.length === 0,
          reason: 'No intervals found',
        })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Should stop early due to shouldStop callback
      expect(result.stopReason).toContain('No intervals found');
      expect(result.rounds).toBe(1); // Only overview stage executed
    });

    it('handles extractIntervals failure with degradation', async () => {
      const stage0 = createOverviewStageDefinition(
        () => {
          throw new Error('Extraction failed');
        },
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Should emit degraded event
      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const degradedEvents = emitCalls.filter((call: any[]) => call[0] === 'degraded');
      expect(degradedEvents.length).toBe(1);
      expect((degradedEvents[0][1] as any).module).toBe('strategyExecutor.extractIntervals');

      // Should continue with empty intervals
      expect(result.stopReason).not.toBeNull();
    });
  });

  // ===========================================================================
  // Per-Interval Execution Tests
  // ===========================================================================

  describe('Per-Interval Execution', () => {
    it('runs per_interval tasks for each interval', async () => {
      const intervals = [
        createMockFocusInterval({ id: 1, startTs: '100000000', endTs: '200000000' }),
        createMockFocusInterval({ id: 2, startTs: '200000000', endTs: '300000000' }),
        createMockFocusInterval({ id: 3, startTs: '300000000', endTs: '400000000' }),
      ];

      const stage0 = createOverviewStageDefinition(
        () => intervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockResolvedValue([createMockAgentResponse()]);

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      // Second executeTaskGraph call should have 3 tasks (one per interval)
      const calls = (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mock.calls;
      expect(calls.length).toBe(2);
      const perIntervalTasks = calls[1][0] as AgentTask[];
      expect(perIntervalTasks.length).toBe(3);
    });

    it('passes interval timestamps to skill params', async () => {
      const interval = createMockFocusInterval({
        id: 1,
        startTs: '123456789000000',
        endTs: '987654321000000',
        processName: 'com.test.app',
      });

      const stage0 = createOverviewStageDefinition(
        () => [interval],
        () => ({ stop: false, reason: '' })
      );
      const stage1: StageDefinition = {
        name: 'per_interval_stage',
        description: 'Per interval',
        progressMessageTemplate: 'Stage {{stageIndex}}/{{totalStages}}',
        tasks: [{
          agentId: 'frame_agent',
          domain: 'frame',
          scope: 'per_interval',
          priority: 1,
          skillParams: { custom_param: 'test' },
          descriptionTemplate: 'Analyze {{scopeLabel}}',
        }],
      };

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      // Check the task context for timeRange
      const calls = (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mock.calls;
      const perIntervalTask = (calls[1][0] as AgentTask[])[0];
      expect(perIntervalTask.context.timeRange).toEqual({
        start: '123456789000000',
        end: '987654321000000',
      });
    });

    it('aggregates results from all intervals', async () => {
      const intervals = [
        createMockFocusInterval({ id: 1 }),
        createMockFocusInterval({ id: 2 }),
      ];

      const finding1: Finding = {
        id: 'f1',
        category: 'frame',
        type: 'jank',
        severity: 'warning',
        title: 'Finding 1',
        description: 'Desc 1',
      };
      const finding2: Finding = {
        id: 'f2',
        category: 'frame',
        type: 'jank',
        severity: 'critical',
        title: 'Finding 2',
        description: 'Desc 2',
      };

      const stage0 = createOverviewStageDefinition(
        () => intervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      (synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>)
        .mockResolvedValueOnce({
          confirmedFindings: [],
          updatedHypotheses: [],
          newFindings: [finding1],
          informationGaps: [],
        })
        .mockResolvedValueOnce({
          confirmedFindings: [],
          updatedHypotheses: [],
          newFindings: [finding2],
          informationGaps: [],
        });

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      expect(result.findings.length).toBe(2);
      expect(result.findings).toContainEqual(finding1);
      expect(result.findings).toContainEqual(finding2);
    });
  });

  // ===========================================================================
  // Direct Skill Mode Tests
  // ===========================================================================

  describe('Direct Skill Mode', () => {
    it('executes direct_skill mode without LLM', async () => {
      const frameIntervals = [
        createMockFocusInterval({ id: 1, metadata: { sourceEntityType: 'frame', frameId: 1 } }),
      ];

      const stage0 = createOverviewStageDefinition(
        () => frameIntervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createFrameAnalysisStageDefinition();

      const mockDirectResponse = createMockAgentResponse({
        findings: [{
          id: 'direct_f1',
          category: 'frame',
          type: 'jank',
          severity: 'warning',
          title: 'Direct Skill Finding',
          description: 'Found via direct skill',
        }],
      });

      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([mockDirectResponse]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      // DirectSkillExecutor should be instantiated
      expect(DirectSkillExecutor).toHaveBeenCalled();
      // executeTasks should be called
      expect(mockDirectExecutor.executeTasks).toHaveBeenCalled();
    });

    it('maps skill params correctly via paramMapping', async () => {
      const interval = createMockFocusInterval({
        id: 1,
        startTs: '111111',
        endTs: '222222',
        processName: 'com.test.pkg',
        metadata: {
          frameId: 12345,
          sessionId: 99,
        },
      });

      const stage0 = createOverviewStageDefinition(
        () => [interval],
        () => ({ stop: false, reason: '' })
      );

      const directSkillStage: StageDefinition = {
        name: 'direct_stage',
        description: 'Direct skill stage',
        progressMessageTemplate: 'Stage {{stageIndex}}/{{totalStages}}',
        tasks: [{
          agentId: 'frame_agent',
          domain: 'frame',
          scope: 'per_interval',
          priority: 1,
          executionMode: 'direct_skill',
          directSkillId: 'test_skill',
          paramMapping: {
            start_ts: 'startTs',
            end_ts: 'endTs',
            package: 'processName',
            frame_id: 'frameId',
            session_id: 'sessionId',
          },
          descriptionTemplate: 'Test {{scopeLabel}}',
        }],
      };

      let capturedTasks: any[] = [];
      const mockDirectExecutor = {
        executeTasks: jest.fn<(tasks: any[], emitter: any) => Promise<AgentResponse[]>>()
          .mockImplementation(async (tasks: any[]) => {
            capturedTasks = tasks;
            return [createMockAgentResponse()];
          }),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      const strategy = createMockStrategy([stage0, directSkillStage]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      // Check that executeTasks was called with properly configured tasks
      expect(mockDirectExecutor.executeTasks).toHaveBeenCalled();
      expect(capturedTasks.length).toBe(1);
      expect(capturedTasks[0].template.paramMapping).toEqual({
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
        frame_id: 'frameId',
        session_id: 'sessionId',
      });
      expect(capturedTasks[0].interval.startTs).toBe('111111');
      expect(capturedTasks[0].interval.endTs).toBe('222222');
    });

    it('returns skill results directly without agent transformation', async () => {
      const interval = createMockFocusInterval({ id: 1 });

      const stage0 = createOverviewStageDefinition(
        () => [interval],
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createFrameAnalysisStageDefinition();

      const directFinding: Finding = {
        id: 'direct_skill_finding',
        category: 'frame',
        type: 'performance',
        severity: 'critical',
        title: 'Direct Skill Result',
        description: 'From direct skill execution',
      };

      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([
          createMockAgentResponse({ findings: [directFinding] }),
        ]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      (synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>).mockResolvedValue({
        confirmedFindings: [],
        updatedHypotheses: [],
        newFindings: [directFinding],
        informationGaps: [],
      });

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Direct skill findings should be in the result
      expect(result.findings).toContainEqual(directFinding);
    });
  });

  // ===========================================================================
  // Stage Skipping Tests
  // ===========================================================================

  describe('Stage Skipping', () => {
    it('skips discovery stage when prebuilt intervals provided', async () => {
      const prebuiltIntervals = [
        createMockFocusInterval({ id: 1 }),
        createMockFocusInterval({ id: 2 }),
      ];

      const extractIntervalsSpy = jest.fn<(responses: AgentResponse[], helpers: IntervalHelpers) => FocusInterval[]>()
        .mockReturnValue([]);
      const stage0 = createOverviewStageDefinition(
        extractIntervalsSpy,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext({
        options: {
          traceProcessorService: { executeQuery: jest.fn() },
          prebuiltIntervals,
        },
      });

      await executor.execute(ctx, mockEmitter);

      // Discovery stage (stage0) should be skipped
      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const skippedTransitions = emitCalls.filter(
        (call: any[]) => call[0] === 'stage_transition' && (call[1] as any).skipped === true
      );
      expect(skippedTransitions.length).toBeGreaterThan(0);

      // extractIntervals should NOT be called since stage was skipped
      expect(extractIntervalsSpy).not.toHaveBeenCalled();
    });

    it('skips session_overview for frame-level drill-down', async () => {
      const frameIntervals = [
        createMockFocusInterval({
          id: 1,
          metadata: {
            sourceEntityType: 'frame',
            frameId: 12345,
          },
        }),
      ];

      const stage0 = createOverviewStageDefinition();
      const stage1 = createSessionOverviewStageDefinition();
      const stage2 = createFrameAnalysisStageDefinition();

      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([createMockAgentResponse()]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      const strategy = createMockStrategy([stage0, stage1, stage2]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext({
        options: {
          traceProcessorService: { executeQuery: jest.fn() },
          prebuiltIntervals: frameIntervals,
        },
      });

      await executor.execute(ctx, mockEmitter);

      // Check that session_overview was skipped
      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const sessionSkipped = emitCalls.find(
        (call: any[]) =>
          call[0] === 'stage_transition' &&
          (call[1] as any).stageName === 'session_overview' &&
          (call[1] as any).skipped === true
      );
      expect(sessionSkipped).toBeDefined();
    });

    it('respects shouldStop callback to stop early', async () => {
      const stage0 = createOverviewStageDefinition(
        () => [],
        (intervals) => ({
          stop: intervals.length === 0,
          reason: 'No jank intervals detected',
        })
      );
      const stage1 = createSessionOverviewStageDefinition();
      const stage2 = createFrameAnalysisStageDefinition();

      const strategy = createMockStrategy([stage0, stage1, stage2]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Should stop after stage 0
      expect(result.rounds).toBe(1);
      expect(result.stopReason).toContain('No jank intervals detected');

      // Stage 1 and 2 should not execute
      expect((executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mock.calls.length).toBe(1);
    });
  });

  // ===========================================================================
  // Entity Capture Tests
  // ===========================================================================

  describe('Entity Capture', () => {
    it('captures frames from jank_frames results', async () => {
      const mockFrames = [
        { frame_id: '1001', start_ts: '100', end_ts: '200' },
        { frame_id: '1002', start_ts: '200', end_ts: '300' },
      ];

      const responseWithFrames = createMockAgentResponse({
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            get_app_jank_frames: {
              columns: ['frame_id', 'start_ts', 'end_ts'],
              rows: [
                ['1001', '100', '200'],
                ['1002', '200', '300'],
              ],
            },
          },
        }],
      });

      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockResolvedValue([responseWithFrames]);
      (captureEntitiesFromResponses as jest.MockedFunction<typeof captureEntitiesFromResponses>).mockReturnValue({
        frames: mockFrames as any,
        sessions: [],
        cpuSlices: [],
        binders: [],
        gcs: [],
        memories: [],
        generics: [],
        candidateFrameIds: ['1001', '1002'],
        candidateSessionIds: [],
      });

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      expect(captureEntitiesFromResponses).toHaveBeenCalled();
      // Result should have captured entities
      expect(result.capturedEntities).toBeDefined();
    });

    it('captures sessions from scroll_sessions', async () => {
      const mockSessions = [
        { session_id: '1', start_ts: '100', end_ts: '1000' },
        { session_id: '2', start_ts: '1000', end_ts: '2000' },
      ];

      const responseWithSessions = createMockAgentResponse({
        toolResults: [{
          success: true,
          executionTimeMs: 50,
          data: {
            scroll_sessions: [
              { session_id: 1, start_ts: '100', end_ts: '1000', process_name: 'com.test' },
              { session_id: 2, start_ts: '1000', end_ts: '2000', process_name: 'com.test' },
            ],
          },
        }],
      });

      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockResolvedValue([responseWithSessions]);
      (captureEntitiesFromResponses as jest.MockedFunction<typeof captureEntitiesFromResponses>).mockReturnValue({
        frames: [],
        sessions: mockSessions as any,
        cpuSlices: [],
        binders: [],
        gcs: [],
        memories: [],
        generics: [],
        candidateFrameIds: [],
        candidateSessionIds: ['1', '2'],
      });

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      expect(captureEntitiesFromResponses).toHaveBeenCalled();
    });

    it('marks analyzed entity IDs in result', async () => {
      const frameIntervals = [
        createMockFocusInterval({
          id: 1,
          metadata: { sourceEntityType: 'frame', frameId: 101 },
        }),
        createMockFocusInterval({
          id: 2,
          metadata: { sourceEntityType: 'frame', frameId: 102 },
        }),
      ];

      const stage0 = createOverviewStageDefinition(
        () => frameIntervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createFrameAnalysisStageDefinition();

      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([
          createMockAgentResponse(),
          createMockAgentResponse(),
        ]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Analyzed frame IDs should be tracked
      expect(result.analyzedEntityIds).toBeDefined();
      expect(result.analyzedEntityIds?.frames).toContain('101');
      expect(result.analyzedEntityIds?.frames).toContain('102');
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('Error Handling', () => {
    it('handles stage execution failures gracefully', async () => {
      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockRejectedValueOnce(new Error('Task execution failed'));

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      // Should throw since executeTaskGraph fails
      await expect(executor.execute(ctx, mockEmitter)).rejects.toThrow('Task execution failed');
    });

    it('continues on non-critical errors in extractIntervals', async () => {
      let extractCallCount = 0;
      const stage0 = createOverviewStageDefinition(
        () => {
          extractCallCount++;
          throw new Error('Non-critical extraction error');
        },
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      // Should not throw, should continue with degradation
      const result = await executor.execute(ctx, mockEmitter);

      expect(extractCallCount).toBe(1);
      // Should have emitted degraded event
      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const degradedEvent = emitCalls.find((call: any[]) => call[0] === 'degraded');
      expect(degradedEvent).toBeDefined();
    });

    it('reports errors in findings when shouldStop throws', async () => {
      const stage0 = createOverviewStageDefinition(
        () => [createMockFocusInterval()],
        () => {
          throw new Error('shouldStop callback error');
        }
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Should emit degraded event but continue
      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const degradedEvent = emitCalls.find((call: any[]) => call[0] === 'degraded');
      expect(degradedEvent).toBeDefined();
      expect((degradedEvent![1] as any).module).toBe('strategyExecutor.shouldStop');
    });

    it('handles traceConfig detection failure gracefully', async () => {
      (detectTraceConfig as jest.MockedFunction<typeof detectTraceConfig>).mockRejectedValue(new Error('Detection failed'));

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      // Should not throw, should log and continue
      const result = await executor.execute(ctx, mockEmitter);

      expect(result).toBeDefined();
      const logCalls = (mockEmitter.log as jest.Mock).mock.calls;
      const errorLog = logCalls.find((call: any[]) =>
        (call[0] as string).includes('Detection failed')
      );
      expect(errorLog).toBeDefined();
    });
  });

  // ===========================================================================
  // Confidence and Result Aggregation Tests
  // ===========================================================================

  describe('Confidence and Result Aggregation', () => {
    it('aggregates confidence from successful responses', async () => {
      const responses = [
        createMockAgentResponse({ confidence: 0.7 }),
        createMockAgentResponse({ confidence: 0.9 }),
      ];

      (executeTaskGraph as jest.MockedFunction<typeof executeTaskGraph>).mockResolvedValue(responses);

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      // Confidence should be the max of average confidences
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('includes information gaps in result', async () => {
      (synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>).mockResolvedValue({
        confirmedFindings: [],
        updatedHypotheses: [],
        newFindings: [],
        informationGaps: ['Missing CPU data', 'No binder info'],
      });

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, mockEmitter);

      expect(result.informationGaps).toContain('Missing CPU data');
      expect(result.informationGaps).toContain('No binder info');
    });
  });

  // ===========================================================================
  // Jank Cause Summary Tests
  // ===========================================================================

  describe('Jank Cause Summary', () => {
    it('computes jank cause summary after frame_analysis stage', async () => {
      const frameIntervals = [createMockFocusInterval({ id: 1 })];

      const stage0 = createOverviewStageDefinition(
        () => frameIntervals,
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createFrameAnalysisStageDefinition();

      const finding: Finding = {
        id: 'f1',
        category: 'frame',
        type: 'jank',
        severity: 'critical',
        title: 'Jank detected',
        description: 'Desc',
        details: { cause_type: 'MainThread' },
      };

      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([
          createMockAgentResponse({ findings: [finding] }),
        ]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      (synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>).mockResolvedValue({
        confirmedFindings: [],
        updatedHypotheses: [],
        newFindings: [finding],
        informationGaps: [],
      });

      (summarizeJankCauses as jest.MockedFunction<typeof summarizeJankCauses>).mockReturnValue({
        totalJankFrames: 1,
        primaryCause: {
          causeType: 'slice',
          label: 'MainThread',
          frameCount: 1,
          percentage: 100,
          severity: 'critical',
          exampleCauses: ['Main thread busy'],
        },
        secondaryCauses: [],
        allCauses: [],
        summaryText: '1 frame with MainThread issue',
      });

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      expect(summarizeJankCauses).toHaveBeenCalled();
      expect(ctx.sharedContext.jankCauseSummary).toBeDefined();
      expect(ctx.sharedContext.jankCauseSummary?.totalJankFrames).toBe(1);
    });
  });

  // ===========================================================================
  // Progress Events Tests
  // ===========================================================================

  describe('Progress Events', () => {
    it('emits round_start progress for each stage', async () => {
      const stage0 = createOverviewStageDefinition(
        () => [createMockFocusInterval()],
        () => ({ stop: false, reason: '' })
      );
      const stage1 = createSessionOverviewStageDefinition();

      const strategy = createMockStrategy([stage0, stage1]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const roundStartEvents = emitCalls.filter(
        (call: any[]) => call[0] === 'progress' && (call[1] as any).phase === 'round_start'
      );

      expect(roundStartEvents.length).toBe(2);
      expect((roundStartEvents[0][1] as any).round).toBe(1);
      expect((roundStartEvents[1][1] as any).round).toBe(2);
    });

    it('emits tasks_dispatched progress', async () => {
      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const dispatchedEvents = emitCalls.filter(
        (call: any[]) => call[0] === 'progress' && (call[1] as any).phase === 'tasks_dispatched'
      );

      expect(dispatchedEvents.length).toBeGreaterThan(0);
    });

    it('emits synthesis_complete progress', async () => {
      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const synthesisEvents = emitCalls.filter(
        (call: any[]) => call[0] === 'progress' && (call[1] as any).phase === 'synthesis_complete'
      );

      expect(synthesisEvents.length).toBeGreaterThan(0);
    });

    it('emits finding events when new findings discovered', async () => {
      const finding: Finding = {
        id: 'new_finding',
        category: 'frame',
        type: 'jank',
        severity: 'warning',
        title: 'New Finding',
        description: 'Description',
      };

      (synthesizeFeedback as jest.MockedFunction<typeof synthesizeFeedback>).mockResolvedValue({
        confirmedFindings: [],
        updatedHypotheses: [],
        newFindings: [finding],
        informationGaps: [],
      });

      const stage0 = createOverviewStageDefinition();
      const strategy = createMockStrategy([stage0]);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, mockEmitter);

      const emitCalls = (mockEmitter.emitUpdate as jest.Mock).mock.calls;
      const findingEvents = emitCalls.filter((call: any[]) => call[0] === 'finding');

      expect(findingEvents.length).toBe(1);
      expect((findingEvents[0][1] as any).findings).toContainEqual(finding);
    });
  });

  // ===========================================================================
  // Max Rounds Budget Tests
  // ===========================================================================

  describe('Max Rounds Budget', () => {
    it('stops when hard max rounds reached', async () => {
      const stages = [
        createOverviewStageDefinition(() => [createMockFocusInterval()], () => ({ stop: false, reason: '' })),
        createSessionOverviewStageDefinition(() => [createMockFocusInterval()]),
        createFrameAnalysisStageDefinition(),
        // Add extra stages that should not execute
        createSessionOverviewStageDefinition(),
        createSessionOverviewStageDefinition(),
        createSessionOverviewStageDefinition(),
      ];

      const mockDirectExecutor = {
        executeTasks: jest.fn<() => Promise<AgentResponse[]>>().mockResolvedValue([createMockAgentResponse()]),
      };
      (DirectSkillExecutor as jest.MockedClass<typeof DirectSkillExecutor>).mockImplementation(() => mockDirectExecutor as any);

      const strategy = createMockStrategy(stages);
      const executor = new StrategyExecutor(strategy, mockServices);
      const ctx = createMockExecutionContext({
        config: {
          maxRounds: 3, // Hard limit at 3 rounds
          maxConcurrentTasks: 3,
          confidenceThreshold: 0.7,
          maxNoProgressRounds: 2,
          maxFailureRounds: 2,
          enableLogging: true,
        },
      });

      const result = await executor.execute(ctx, mockEmitter);

      // Should stop at maxRounds
      expect(result.rounds).toBeLessThanOrEqual(3);
      expect(result.stopReason).toContain('hard stage budget');
    });
  });
});
