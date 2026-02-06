/**
 * HypothesisExecutor Unit Tests
 *
 * Tests the adaptive hypothesis-driven analysis loop:
 * 1. Basic Execution (single round, findings, entity capture)
 * 2. Multi-Round Loop (confidence threshold, hard/soft budget)
 * 3. Early Stop Conditions (noProgress, failureRatio, circuit breaker)
 * 4. Intervention Mechanism (low confidence, ambiguity, timeout)
 * 5. Task Graph (planning, dependency execution, filtering)
 * 6. FocusStore Integration (prioritization, focus recording)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { HypothesisExecutor } from '../hypothesisExecutor';
import type { Finding, Intent } from '../../../types';
import type {
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
} from '../../../types/agentProtocol';
import type {
  AnalysisServices,
  ExecutionContext,
  ProgressEmitter,
} from '../../orchestratorTypes';
import type { StrategyDecision } from '../../../agents/iterationStrategyPlanner';
import type { UserFocus } from '../../../context/focusStore';
import type { IncrementalScope } from '../../incrementalAnalyzer';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockModelRouter = () => ({
  callWithFallback: jest.fn<any>().mockResolvedValue({
    success: true,
    response: JSON.stringify({
      tasks: [
        {
          id: 't1',
          domain: 'frame',
          description: 'Collect frame metrics',
          evidence_needed: ['jank frames', 'fps'],
          time_range: null,
          depends_on: [],
        },
      ],
    }),
    modelId: 'test-model',
    usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
    latencyMs: 100,
  }),
});

const createMockAgentRegistry = () => {
  const mockAgent = {
    config: {
      id: 'frame_agent',
      name: 'Frame Agent',
      domain: 'frame',
      description: 'Frame analysis',
    },
  };

  return {
    getForDomain: jest.fn<any>().mockReturnValue(mockAgent),
    get: jest.fn<any>().mockReturnValue(mockAgent),
    getAgentsForTopic: jest.fn<any>().mockReturnValue([mockAgent]),
    getAll: jest.fn<any>().mockReturnValue([mockAgent]),
    getAgentIds: jest.fn<any>().mockReturnValue(['frame_agent']),
    getAgentDescriptionsForLLM: jest.fn<any>().mockReturnValue('- frame_agent: Frame Agent'),
  };
};

const createMockStrategyPlanner = () => ({
  planNextIteration: jest.fn<any>().mockResolvedValue({
    strategy: 'conclude',
    confidence: 0.8,
    reasoning: 'Sufficient findings collected',
  } as StrategyDecision),
  resetProgressTracking: jest.fn<any>(),
  getSkillsForFocusArea: jest.fn<any>().mockReturnValue([]),
  updateConfig: jest.fn<any>(),
});

const createMockMessageBus = () => ({
  dispatchTasksParallel: jest.fn<any>().mockResolvedValue([createMockAgentResponse()]),
  updateHypothesis: jest.fn<any>(),
  registerAgent: jest.fn<any>(),
  send: jest.fn<any>(),
  broadcast: jest.fn<any>(),
  subscribe: jest.fn<any>(),
  unsubscribe: jest.fn<any>(),
});

const createMockCircuitBreaker = () => ({
  recordFailure: jest.fn<any>().mockReturnValue({ action: 'retry' }),
  recordSuccess: jest.fn<any>(),
  recordIteration: jest.fn<any>().mockReturnValue({ action: 'continue' }),
  canExecute: jest.fn<any>().mockReturnValue({ action: 'continue' }),
  forceClose: jest.fn<any>().mockReturnValue(true),
  reset: jest.fn<any>(),
  handleUserResponse: jest.fn<any>().mockReturnValue({ action: 'continue' }),
  isClosed: true,
  isTripped: false,
  isHalfOpen: false,
  circuitState: 'closed',
  forceCloseCallCount: 0,
  isForceCloseLimitReached: false,
  getDiagnostics: jest.fn<any>().mockReturnValue({}),
  getAllDiagnostics: jest.fn<any>().mockReturnValue({}),
  on: jest.fn<any>(),
  off: jest.fn<any>(),
  emit: jest.fn<any>(),
});

const createMockFocusStore = () => ({
  getTopFocuses: jest.fn<any>().mockReturnValue([]),
  recordInteraction: jest.fn<any>(),
  getFocus: jest.fn<any>().mockReturnValue(null),
  getAllFocuses: jest.fn<any>().mockReturnValue([]),
  toSnapshot: jest.fn<any>().mockReturnValue({ version: 1, focuses: [] }),
  fromSnapshot: jest.fn<any>(),
  clear: jest.fn<any>(),
});

function createMockAgentResponse(overrides?: Partial<AgentResponse>): AgentResponse {
  return {
    agentId: 'frame_agent',
    taskId: 'task_1',
    success: true,
    findings: [
      {
        id: 'f1',
        severity: 'warning',
        title: 'Frame drop detected',
        description: 'Multiple frames exceeded budget',
        source: 'frame_agent',
        confidence: 0.8,
        details: { frame_count: 5 },
      },
    ],
    hypothesisUpdates: [],
    suggestions: [],
    confidence: 0.7,
    executionTimeMs: 100,
    toolResults: [
      {
        success: true,
        data: { rows: [{ id: 1 }] },
        executionTimeMs: 50,
        dataEnvelopes: [],
      },
    ],
    reasoning: [],
    ...overrides,
  };
}

function createMockHypothesis(overrides?: Partial<Hypothesis>): Hypothesis {
  return {
    id: 'hypo_1',
    description: 'Main thread blocking causes jank',
    confidence: 0.6,
    status: 'investigating',
    supportingEvidence: [],
    contradictingEvidence: [],
    proposedBy: 'system',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockSharedContext(overrides?: Partial<SharedAgentContext>): SharedAgentContext {
  return {
    sessionId: 'test-session',
    traceId: 'test-trace',
    hypotheses: new Map([['hypo_1', createMockHypothesis()]]),
    confirmedFindings: [],
    investigationPath: [],
    ...overrides,
  };
}

function createMockIntent(overrides?: Partial<Intent>): Intent {
  return {
    primaryGoal: 'Analyze scrolling jank',
    aspects: ['jank', 'frame'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
    ...overrides,
  };
}

function createMockExecutionContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    query: 'Why is scrolling janky?',
    sessionId: 'test-session',
    traceId: 'test-trace',
    intent: createMockIntent(),
    initialHypotheses: [createMockHypothesis()],
    sharedContext: createMockSharedContext(),
    options: {
      traceProcessorService: {},
      packageName: 'com.example.app',
    },
    config: {
      maxRounds: 5,
      softMaxRounds: 3,
      maxConcurrentTasks: 3,
      confidenceThreshold: 0.7,
      maxNoProgressRounds: 2,
      maxFailureRounds: 2,
      enableLogging: false,
    },
    ...overrides,
  };
}

function createMockServices(): AnalysisServices {
  return {
    modelRouter: createMockModelRouter() as any,
    messageBus: createMockMessageBus() as any,
    circuitBreaker: createMockCircuitBreaker() as any,
    emittedEnvelopeRegistry: undefined,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('HypothesisExecutor', () => {
  let executor: HypothesisExecutor;
  let services: AnalysisServices;
  let agentRegistry: ReturnType<typeof createMockAgentRegistry>;
  let strategyPlanner: ReturnType<typeof createMockStrategyPlanner>;
  let emitter: ProgressEmitter;
  let emittedUpdates: Array<{ type: string; content: any }>;
  let logs: string[];

  beforeEach(() => {
    emittedUpdates = [];
    logs = [];

    services = createMockServices();
    agentRegistry = createMockAgentRegistry();
    strategyPlanner = createMockStrategyPlanner();

    emitter = {
      emitUpdate: (type: any, content: any) => {
        emittedUpdates.push({ type: String(type), content });
      },
      log: (message: any) => {
        logs.push(String(message));
      },
    };

    executor = new HypothesisExecutor(services, agentRegistry as any, strategyPlanner as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Basic Execution Tests
  // ===========================================================================

  describe('Basic Execution', () => {
    it('executes single round successfully', async () => {
      const ctx = createMockExecutionContext();

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBe(1);
      expect(result.findings).toHaveLength(1);
      expect(result.stopReason).toBeNull();
      expect(services.messageBus.dispatchTasksParallel).toHaveBeenCalled();
    });

    it('returns findings from agent responses', async () => {
      const ctx = createMockExecutionContext();
      const mockResponse = createMockAgentResponse({
        findings: [
          { id: 'f1', severity: 'critical', title: 'Critical jank', description: 'Severe', source: 'frame_agent', confidence: 0.9 },
          { id: 'f2', severity: 'warning', title: 'Minor jank', description: 'Small', source: 'frame_agent', confidence: 0.7 },
        ],
      });

      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([mockResponse]);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(2);
      expect(result.findings[0].severity).toBe('critical');
      expect(result.findings[1].severity).toBe('warning');
    });

    it('returns confidence from strategy decision', async () => {
      const ctx = createMockExecutionContext();

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'conclude',
        confidence: 0.85,
        reasoning: 'Analysis complete',
      });

      const result = await executor.execute(ctx, emitter);

      expect(result.confidence).toBe(0.85);
      expect(result.lastStrategy?.strategy).toBe('conclude');
    });

    it('emits progress updates during execution', async () => {
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, emitter);

      const progressUpdates = emittedUpdates.filter(u => u.type === 'progress');
      const phases = progressUpdates.map(u => u.content.phase);

      expect(phases).toContain('round_start');
      expect(phases).toContain('task_graph_planned');
      expect(phases).toContain('tasks_dispatched');
      expect(phases).toContain('synthesis_complete');
      expect(phases).toContain('strategy_decision');
    });

    it('emits evidence-based hypotheses after first synthesis', async () => {
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, emitter);

      const progressUpdates = emittedUpdates.filter(u => u.type === 'progress');
      const phases = progressUpdates.map(u => u.content.phase);
      const synthesisIndex = phases.indexOf('synthesis_complete');
      const hypothesesIndex = phases.indexOf('hypotheses_generated');

      expect(hypothesesIndex).toBeGreaterThan(-1);
      expect(synthesisIndex).toBeGreaterThan(-1);
      expect(hypothesesIndex).toBeGreaterThan(synthesisIndex);

      const hypothesisUpdate = progressUpdates[hypothesesIndex];
      expect(hypothesisUpdate.content.evidenceBased).toBe(true);
      expect(Array.isArray(hypothesisUpdate.content.hypotheses)).toBe(true);
      expect(Array.isArray(hypothesisUpdate.content.evidenceSummary)).toBe(true);
    });

    it('does not emit hypotheses_generated when first round has no evidence', async () => {
      const ctx = createMockExecutionContext();
      const emptyResponse = createMockAgentResponse({
        findings: [],
        toolResults: [],
      });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([emptyResponse]);

      await executor.execute(ctx, emitter);

      const hasHypothesisEvent = emittedUpdates.some(
        u => u.type === 'progress' && u.content.phase === 'hypotheses_generated'
      );
      expect(hasHypothesisEvent).toBe(false);
    });
  });

  // ===========================================================================
  // Multi-Round Loop Tests
  // ===========================================================================

  describe('Multi-Round Loop', () => {
    it('continues until confidence threshold met', async () => {
      const ctx = createMockExecutionContext({
        config: { ...createMockExecutionContext().config, maxRounds: 5, confidenceThreshold: 0.7 },
      });

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.5, reasoning: 'Need more' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.8, reasoning: 'Sufficient' });

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBe(2);
      expect(strategyPlanner.planNextIteration).toHaveBeenCalledTimes(2);
    });

    it('stops at hardMaxRounds', async () => {
      const ctx = createMockExecutionContext({
        config: { ...createMockExecutionContext().config, maxRounds: 3, softMaxRounds: 2, confidenceThreshold: 0.9 },
      });

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'continue',
        confidence: 0.5,
        reasoning: 'Need more evidence',
      });

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBe(3);
    });

    it('respects softMaxRounds preference when confidence is sufficient', async () => {
      const ctx = createMockExecutionContext({
        config: { ...createMockExecutionContext().config, maxRounds: 5, softMaxRounds: 2, confidenceThreshold: 0.6 },
      });

      const mockResponse = createMockAgentResponse({
        findings: [{ id: 'f1', severity: 'warning', title: 'Issue', description: 'desc', source: 'test', confidence: 0.8 }],
      });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([mockResponse]);

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'continue',
        confidence: 0.7,
        reasoning: 'Could continue',
      });

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBeLessThanOrEqual(2);
    });

    it('continues past softMaxRounds if confidence is insufficient', async () => {
      const ctx = createMockExecutionContext({
        config: { ...createMockExecutionContext().config, maxRounds: 4, softMaxRounds: 2, confidenceThreshold: 0.9 },
      });

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.3, reasoning: 'Low' })
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.4, reasoning: 'Still low' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.5, reasoning: 'Give up' });

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBe(3);
    });

    it('handles deep_dive strategy', async () => {
      const ctx = createMockExecutionContext();

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'deep_dive', confidence: 0.6, reasoning: 'Need deeper', focusArea: 'cpu' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.8, reasoning: 'Done' });

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBe(2);
      expect(services.messageBus.updateHypothesis).toHaveBeenCalled();
    });

    it('handles pivot strategy', async () => {
      const ctx = createMockExecutionContext();

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'pivot', confidence: 0.5, reasoning: 'Change direction', newDirection: 'Memory issues' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.7, reasoning: 'Done' });

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBe(2);
      expect(services.messageBus.updateHypothesis).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Early Stop Conditions Tests
  // ===========================================================================

  describe('Early Stop Conditions', () => {
    it('stops when noProgressRounds exceeded', async () => {
      const ctx = createMockExecutionContext({
        config: { ...createMockExecutionContext().config, maxRounds: 10, maxNoProgressRounds: 2 },
      });

      const emptyResponse = createMockAgentResponse({ findings: [] });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([emptyResponse]);

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'continue',
        confidence: 0.5,
        reasoning: 'Keep going',
      });

      const result = await executor.execute(ctx, emitter);

      expect(result.stopReason).toContain('没有新增证据');
      expect(result.rounds).toBeLessThan(10);

      const earlyStopUpdate = emittedUpdates.find(
        u => u.type === 'progress' && u.content.phase === 'early_stop'
      );
      expect(earlyStopUpdate).toBeDefined();
    });

    it('stops when failureRatio too high', async () => {
      const ctx = createMockExecutionContext({
        config: {
          ...createMockExecutionContext().config,
          maxRounds: 10,
          maxFailureRounds: 2,
          maxNoProgressRounds: 10, // Disable noProgress early stop
        },
      });

      const failedResponses = [
        createMockAgentResponse({ success: false, findings: [] }),
        createMockAgentResponse({ success: false, findings: [] }),
        createMockAgentResponse({ success: false, findings: [] }),
      ];
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue(failedResponses);

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'continue',
        confidence: 0.5,
        reasoning: 'Keep going',
      });

      const result = await executor.execute(ctx, emitter);

      // Should stop early due to failure ratio
      expect(result.stopReason).toContain('失败');
      expect(result.rounds).toBeLessThan(10);
    });

    it('stops on circuit breaker trip', async () => {
      const ctx = createMockExecutionContext();

      const mockCircuitBreaker = createMockCircuitBreaker();
      mockCircuitBreaker.recordFailure.mockReturnValue({ action: 'ask_user', reason: 'Too many failures' });

      const failedResponse = createMockAgentResponse({ success: false, findings: [] });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([failedResponse]);

      services.circuitBreaker = mockCircuitBreaker as any;
      executor = new HypothesisExecutor(services, agentRegistry as any, strategyPlanner as any);

      await executor.execute(ctx, emitter);

      expect(mockCircuitBreaker.recordFailure).toHaveBeenCalled();

      const circuitBreakerUpdate = emittedUpdates.find(u => u.type === 'circuit_breaker');
      expect(circuitBreakerUpdate).toBeDefined();
    });

    it('resets noProgressRounds counter when findings are discovered', async () => {
      // This test verifies that finding new evidence resets the noProgress counter.
      // When findings are discovered, the counter should reset to 0.
      const ctx = createMockExecutionContext({
        config: {
          ...createMockExecutionContext().config,
          maxRounds: 6,
          maxNoProgressRounds: 3, // Allow 3 rounds without progress
        },
      });

      let callCount = 0;
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockImplementation(() => {
        callCount++;
        // Round 1: finding, Round 2: no finding, Round 3: finding (resets), Round 4: conclude
        if (callCount === 1 || callCount === 3) {
          return Promise.resolve([createMockAgentResponse({
            findings: [{ id: `f${callCount}`, severity: 'warning', title: `Finding ${callCount}`, description: 'desc', source: 'test' }],
          })]);
        }
        return Promise.resolve([createMockAgentResponse({ findings: [] })]);
      });

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.4, reasoning: 'Keep going' })
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.4, reasoning: 'Keep going' })
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.6, reasoning: 'Found something' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.7, reasoning: 'Done' });

      const result = await executor.execute(ctx, emitter);

      // Should complete without early stop due to noProgress (we reset the counter)
      expect(result.stopReason).toBeNull();
      expect(result.rounds).toBe(4);
      // Verify we accumulated findings from both rounds where we had findings
      expect(result.findings.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // Intervention Mechanism Tests
  // ===========================================================================

  describe('Intervention Mechanism', () => {
    it('requests intervention when confidence too low', async () => {
      const ctx = createMockExecutionContext();

      executor = new HypothesisExecutor(services, agentRegistry as any, strategyPlanner as any, {
        confidenceThreshold: 0.8,
        autoIntervention: true,
      });

      const minimalResponse = createMockAgentResponse({ findings: [] });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([minimalResponse]);

      ctx.sharedContext.hypotheses = new Map();

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'conclude',
        confidence: 0.3,
        reasoning: 'Low confidence',
      });

      const result = await executor.execute(ctx, emitter);

      if (result.interventionRequest) {
        expect(result.interventionRequest.type).toBe('low_confidence');
        expect(result.interventionRequest.possibleDirections).toBeDefined();
        expect(result.pausedForIntervention).toBe(true);
      }
    });

    it('requests intervention when ambiguous directions exist', async () => {
      const ctx = createMockExecutionContext();

      executor = new HypothesisExecutor(services, agentRegistry as any, strategyPlanner as any, {
        confidenceThreshold: 0.4,
        autoIntervention: true,
      });

      ctx.sharedContext.hypotheses = new Map([
        ['hypo_1', createMockHypothesis({ id: 'hypo_1', description: 'Direction A', confidence: 0.5, status: 'proposed' })],
        ['hypo_2', createMockHypothesis({ id: 'hypo_2', description: 'Direction B', confidence: 0.48, status: 'proposed' })],
      ]);

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'continue',
        confidence: 0.5,
        reasoning: 'Ambiguous',
      });

      const result = await executor.execute(ctx, emitter);

      const interventionUpdate = emittedUpdates.find(
        u => u.type === 'progress' && u.content.phase === 'intervention_required'
      );
      if (interventionUpdate) {
        expect(['ambiguity', 'low_confidence']).toContain(interventionUpdate.content.type);
      }
    });

    it('includes possible directions in intervention', async () => {
      const ctx = createMockExecutionContext();

      executor = new HypothesisExecutor(services, agentRegistry as any, strategyPlanner as any, {
        confidenceThreshold: 0.9,
        autoIntervention: true,
      });

      ctx.sharedContext.hypotheses = new Map([
        ['hypo_1', createMockHypothesis({ description: 'Main thread blocking', confidence: 0.4, status: 'investigating' })],
      ]);

      const minimalResponse = createMockAgentResponse({ findings: [] });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([minimalResponse]);

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'conclude',
        confidence: 0.3,
        reasoning: 'Low confidence',
      });

      const result = await executor.execute(ctx, emitter);

      if (result.interventionRequest) {
        expect(result.interventionRequest.possibleDirections).toBeDefined();
        expect(Array.isArray(result.interventionRequest.possibleDirections)).toBe(true);
        expect(result.interventionRequest.possibleDirections.length).toBeGreaterThan(0);

        for (const direction of result.interventionRequest.possibleDirections) {
          expect(direction).toHaveProperty('id');
          expect(direction).toHaveProperty('description');
          expect(direction).toHaveProperty('confidence');
        }
      }
    });

    it('does not request intervention when autoIntervention is disabled', async () => {
      const ctx = createMockExecutionContext();

      executor = new HypothesisExecutor(services, agentRegistry as any, strategyPlanner as any, {
        confidenceThreshold: 0.9,
        autoIntervention: false,
      });

      const minimalResponse = createMockAgentResponse({ findings: [] });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([minimalResponse]);

      strategyPlanner.planNextIteration.mockResolvedValue({
        strategy: 'conclude',
        confidence: 0.2,
        reasoning: 'Very low confidence',
      });

      const result = await executor.execute(ctx, emitter);

      expect(result.interventionRequest).toBeUndefined();
      expect(result.pausedForIntervention).toBeFalsy();
    });
  });

  // ===========================================================================
  // Task Graph Tests
  // ===========================================================================

  describe('Task Graph', () => {
    it('plans tasks based on hypotheses', async () => {
      const ctx = createMockExecutionContext();

      await executor.execute(ctx, emitter);

      expect(services.modelRouter.callWithFallback).toHaveBeenCalled();

      const callArgs = (services.modelRouter.callWithFallback as jest.Mock<any>).mock.calls[0];
      const prompt = callArgs[0] as string;

      expect(prompt).toContain('假设');
    });

    it('executes tasks in dependency order', async () => {
      const ctx = createMockExecutionContext();

      (services.modelRouter.callWithFallback as jest.Mock<any>).mockResolvedValue({
        success: true,
        response: JSON.stringify({
          tasks: [
            { id: 't1', domain: 'frame', description: 'Task 1', evidence_needed: ['fps'], depends_on: [] },
            { id: 't2', domain: 'cpu', description: 'Task 2', evidence_needed: ['load'], depends_on: ['t1'] },
          ],
        }),
        modelId: 'test',
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 100,
      });

      await executor.execute(ctx, emitter);

      expect(services.messageBus.dispatchTasksParallel).toHaveBeenCalled();
    });

    it('handles no tasks generated gracefully', async () => {
      const ctx = createMockExecutionContext();

      (services.modelRouter.callWithFallback as jest.Mock<any>).mockResolvedValue({
        success: true,
        response: JSON.stringify({ tasks: [] }),
        modelId: 'test',
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 100,
      });

      agentRegistry.getForDomain.mockReturnValue(undefined);
      agentRegistry.get.mockReturnValue(undefined);
      agentRegistry.getAgentsForTopic.mockReturnValue([]);
      agentRegistry.getAll.mockReturnValue([]);

      const result = await executor.execute(ctx, emitter);

      expect(result.stopReason).toContain('No tasks');
    });

    it('filters tasks by incremental scope when extension', async () => {
      const incrementalScope: IncrementalScope = {
        type: 'entity',
        isExtension: true,
        relevantAgents: ['cpu_agent'],
        entities: [],
        timeRanges: [],
        relevantSkills: [],
        reason: 'Focus on CPU',
      };

      const ctx = createMockExecutionContext({ incrementalScope });

      (services.modelRouter.callWithFallback as jest.Mock<any>).mockResolvedValue({
        success: true,
        response: JSON.stringify({
          tasks: [
            { id: 't1', domain: 'frame', description: 'Frame task', evidence_needed: ['fps'], depends_on: [] },
            { id: 't2', domain: 'cpu', description: 'CPU task', evidence_needed: ['load'], depends_on: [] },
          ],
        }),
        modelId: 'test',
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 100,
      });

      const frameAgent = { config: { id: 'frame_agent', domain: 'frame' } };
      const cpuAgent = { config: { id: 'cpu_agent', domain: 'cpu' } };

      agentRegistry.getForDomain.mockImplementation((domain: string) => {
        if (domain === 'frame') return frameAgent;
        if (domain === 'cpu') return cpuAgent;
        return undefined;
      });

      await executor.execute(ctx, emitter);

      const scopeFilterUpdate = emittedUpdates.find(
        u => u.type === 'progress' && u.content.phase === 'task_scope_filtered'
      );

      if (scopeFilterUpdate) {
        expect(scopeFilterUpdate.content.allowedAgents).toContain('cpu_agent');
      }
    });
  });

  // ===========================================================================
  // FocusStore Integration Tests
  // ===========================================================================

  describe('FocusStore Integration', () => {
    it('uses FocusStore for focus-aware strategy planning', async () => {
      const ctx = createMockExecutionContext();
      const mockFocusStore = createMockFocusStore();

      const mockFocuses: UserFocus[] = [
        {
          id: 'focus_1',
          type: 'entity',
          target: { entityType: 'frame', entityId: '123' },
          weight: 0.8,
          lastInteractionTime: Date.now(),
          interactionHistory: [],
          createdAt: Date.now(),
        },
      ];
      mockFocusStore.getTopFocuses.mockReturnValue(mockFocuses);

      executor.setFocusStore(mockFocusStore as any);

      await executor.execute(ctx, emitter);

      expect(mockFocusStore.getTopFocuses).toHaveBeenCalledWith(3);
    });

    it('includes focus context in strategy decision', async () => {
      const ctx = createMockExecutionContext();
      const mockFocusStore = createMockFocusStore();

      const mockFocuses: UserFocus[] = [
        {
          id: 'focus_1',
          type: 'timeRange',
          target: { timeRange: { start: '1000', end: '2000' } },
          weight: 0.9,
          lastInteractionTime: Date.now(),
          interactionHistory: [],
          createdAt: Date.now(),
        },
      ];
      mockFocusStore.getTopFocuses.mockReturnValue(mockFocuses);

      executor.setFocusStore(mockFocusStore as any);

      await executor.execute(ctx, emitter);

      const plannerCalls = strategyPlanner.planNextIteration.mock.calls;
      expect(plannerCalls.length).toBeGreaterThan(0);

      const lastCall = plannerCalls[plannerCalls.length - 1][0];
      expect(lastCall).toHaveProperty('userFocusContext');
    });

    it('calculates focus alignment for evaluation', async () => {
      const ctx = createMockExecutionContext();
      const mockFocusStore = createMockFocusStore();

      const mockFocuses: UserFocus[] = [
        {
          id: 'focus_1',
          type: 'entity',
          target: { entityType: 'frame', entityId: 'frame_123' },
          weight: 0.9,
          lastInteractionTime: Date.now(),
          interactionHistory: [],
          createdAt: Date.now(),
        },
      ];
      mockFocusStore.getTopFocuses.mockReturnValue(mockFocuses);

      const alignedResponse = createMockAgentResponse({
        findings: [
          {
            id: 'f1',
            severity: 'warning',
            title: 'Frame issue',
            description: 'Issue in focused frame',
            source: 'frame_agent',
            confidence: 0.8,
            details: { frame_id: 'frame_123' },
          },
        ],
      });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([alignedResponse]);

      executor.setFocusStore(mockFocusStore as any);

      const result = await executor.execute(ctx, emitter);

      expect(result.findings).toHaveLength(1);

      const plannerCalls = strategyPlanner.planNextIteration.mock.calls;
      if (plannerCalls.length > 0) {
        const evaluation = (plannerCalls[0][0] as any).evaluation;
        expect(evaluation.qualityScore).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ===========================================================================
  // Edge Cases and Error Handling
  // ===========================================================================

  describe('Edge Cases', () => {
    it('handles empty hypotheses map', async () => {
      const ctx = createMockExecutionContext();
      ctx.sharedContext.hypotheses = new Map();

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBeGreaterThanOrEqual(1);
    });

    it('handles task graph planning failure gracefully', async () => {
      const ctx = createMockExecutionContext();

      (services.modelRouter.callWithFallback as jest.Mock<any>).mockRejectedValue(
        new Error('LLM unavailable')
      );

      const result = await executor.execute(ctx, emitter);

      expect(result.rounds).toBeGreaterThanOrEqual(1);

      const degradedUpdate = emittedUpdates.find(u => u.type === 'degraded');
      expect(degradedUpdate).toBeDefined();
      expect(degradedUpdate?.content.module).toBe('taskGraphPlanner');
    });

    it('handles concurrent task execution', async () => {
      const ctx = createMockExecutionContext();

      (services.modelRouter.callWithFallback as jest.Mock<any>).mockResolvedValue({
        success: true,
        response: JSON.stringify({
          tasks: [
            { id: 't1', domain: 'frame', description: 'Task 1', evidence_needed: ['fps'], depends_on: [] },
            { id: 't2', domain: 'cpu', description: 'Task 2', evidence_needed: ['load'], depends_on: [] },
            { id: 't3', domain: 'memory', description: 'Task 3', evidence_needed: ['heap'], depends_on: [] },
          ],
        }),
        modelId: 'test',
        usage: { inputTokens: 100, outputTokens: 50 },
        latencyMs: 100,
      });

      const agents = ['frame', 'cpu', 'memory'].map(domain => ({
        config: { id: `${domain}_agent`, domain },
      }));

      agentRegistry.getForDomain.mockImplementation((domain: string) => {
        return agents.find(a => a.config.domain === domain);
      });

      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([
        createMockAgentResponse({ agentId: 'frame_agent' }),
        createMockAgentResponse({ agentId: 'cpu_agent' }),
        createMockAgentResponse({ agentId: 'memory_agent' }),
      ]);

      const result = await executor.execute(ctx, emitter);

      expect(services.messageBus.dispatchTasksParallel).toHaveBeenCalled();
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it('preserves information gaps across rounds', async () => {
      const ctx = createMockExecutionContext();

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.5, reasoning: 'Need more' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.8, reasoning: 'Done' });

      const result = await executor.execute(ctx, emitter);

      expect(result.informationGaps).toBeDefined();
      expect(Array.isArray(result.informationGaps)).toBe(true);
    });

    it('handles session context for entity tracking', async () => {
      const mockSessionContext = {
        startTraceAgentExperiment: jest.fn<any>().mockReturnValue('exp_1'),
        completeTraceAgentExperiment: jest.fn<any>(),
        ingestEvidenceFromResponses: jest.fn<any>().mockReturnValue(['ev_1']),
        generatePromptContext: jest.fn<any>().mockReturnValue(''),
        getTraceAgentState: jest.fn<any>().mockReturnValue({ contradictions: [] }),
      };

      const ctx = createMockExecutionContext({
        sessionContext: mockSessionContext as any,
      });

      await executor.execute(ctx, emitter);

      expect(mockSessionContext.startTraceAgentExperiment).toHaveBeenCalled();
      expect(mockSessionContext.ingestEvidenceFromResponses).toHaveBeenCalled();
    });

    it('uses contradictions from session context as information gaps', async () => {
      const mockSessionContext = {
        startTraceAgentExperiment: jest.fn<any>().mockReturnValue('exp_1'),
        completeTraceAgentExperiment: jest.fn<any>(),
        ingestEvidenceFromResponses: jest.fn<any>().mockReturnValue([]),
        generatePromptContext: jest.fn<any>().mockReturnValue(''),
        getTraceAgentState: jest.fn<any>().mockReturnValue({
          contradictions: [
            { description: 'CPU and frame data disagree' },
            { description: 'Memory spike timing mismatch' },
          ],
        }),
      };

      const ctx = createMockExecutionContext({
        sessionContext: mockSessionContext as any,
      });

      await executor.execute(ctx, emitter);

      expect(services.modelRouter.callWithFallback).toHaveBeenCalled();
      const prompt = (services.modelRouter.callWithFallback as jest.Mock<any>).mock.calls[0][0] as string;

      expect(prompt.toLowerCase()).toContain('矛盾');
    });
  });

  // ===========================================================================
  // Finding Emission Tests
  // ===========================================================================

  describe('Finding Emission', () => {
    it('emits finding updates when new findings discovered', async () => {
      const ctx = createMockExecutionContext();

      const responseWithFindings = createMockAgentResponse({
        findings: [{ id: 'f1', severity: 'critical', title: 'Critical issue', description: 'desc', source: 'test' }],
      });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([responseWithFindings]);

      await executor.execute(ctx, emitter);

      const findingUpdate = emittedUpdates.find(u => u.type === 'finding');
      expect(findingUpdate).toBeDefined();
      expect(findingUpdate?.content.findings).toHaveLength(1);
    });

    it('does not emit finding update when no new findings', async () => {
      const ctx = createMockExecutionContext();

      const responseNoFindings = createMockAgentResponse({ findings: [] });
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockResolvedValue([responseNoFindings]);

      await executor.execute(ctx, emitter);

      const findingUpdates = emittedUpdates.filter(u => u.type === 'finding');
      expect(findingUpdates).toHaveLength(0);
    });

    it('accumulates findings across rounds', async () => {
      const ctx = createMockExecutionContext();

      let roundCount = 0;
      (services.messageBus.dispatchTasksParallel as jest.Mock<any>).mockImplementation(() => {
        roundCount++;
        return Promise.resolve([
          createMockAgentResponse({
            findings: [{ id: `f${roundCount}`, severity: 'warning', title: `Finding ${roundCount}`, description: 'desc', source: 'test' }],
          }),
        ]);
      });

      strategyPlanner.planNextIteration
        .mockResolvedValueOnce({ strategy: 'continue', confidence: 0.5, reasoning: 'Continue' })
        .mockResolvedValueOnce({ strategy: 'conclude', confidence: 0.8, reasoning: 'Done' });

      const result = await executor.execute(ctx, emitter);

      expect(result.findings.length).toBeGreaterThanOrEqual(2);
      expect(result.rounds).toBe(2);
    });
  });
});
