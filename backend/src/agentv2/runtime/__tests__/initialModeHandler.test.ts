import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InitialModeHandler } from '../modeHandlers/initialModeHandler';
import { selectInitialExecutor } from '../runtimeInitialExecutorSelector';
import { HypothesisExecutor } from '../../../agent/core/executors/hypothesisExecutor';

jest.mock('../runtimeInitialExecutorSelector', () => ({
  selectInitialExecutor: jest.fn(),
}));

jest.mock('../../../agent/core/executors/hypothesisExecutor', () => ({
  HypothesisExecutor: jest.fn(),
}));

describe('InitialModeHandler strategy fallback', () => {
  const runtimeConfig = {
    maxRounds: 5,
    maxConcurrentTasks: 3,
    confidenceThreshold: 0.7,
    maxNoProgressRounds: 2,
    maxFailureRounds: 2,
    enableLogging: false,
  } as any;

  const createSessionContext = (previousFindings: any[] = []) => ({
    getEntityStore: () => ({
      getAnalyzedFrameIds: () => [],
      getAnalyzedSessionIds: () => [],
    }),
    getAllFindings: () => previousFindings,
    getAllTurns: () => [],
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back to HypothesisExecutor when strategy exits with no tasks', async () => {
    const strategyExecute: any = jest.fn();
    strategyExecute.mockResolvedValue({
      findings: [],
      lastStrategy: null,
      confidence: 0.4,
      informationGaps: ['gap-a'],
      rounds: 1,
      stopReason: 'No tasks generated for strategy stage: overview',
    });
    const strategyExecutor = {
      execute: strategyExecute,
    };

    (selectInitialExecutor as any).mockResolvedValue({
      executor: strategyExecutor,
      executorType: 'strategy',
      initialHypotheses: [],
      strategyMatchResult: {
        strategy: { id: 'scrolling', name: 'Scrolling Strategy' },
        confidence: 0.82,
        matchMethod: 'keyword',
        reasoning: 'keyword match',
      },
      effectiveConfig: runtimeConfig,
    });

    const hypothesisExecute: any = jest.fn();
    hypothesisExecute.mockResolvedValue({
      findings: [
        {
          id: 'f-hypo-1',
          severity: 'warning',
          title: 'Hypothesis finding',
          description: 'Recovered by fallback',
          confidence: 0.8,
        },
      ],
      lastStrategy: { strategy: 'conclude', confidence: 0.8, reasoning: 'done' },
      confidence: 0.8,
      informationGaps: ['gap-b'],
      rounds: 2,
      stopReason: 'Hypothesis completed',
    });
    const hypothesisSetFocusStore = jest.fn();
    (HypothesisExecutor as unknown as jest.Mock).mockImplementation(() => ({
      setFocusStore: hypothesisSetFocusStore,
      execute: hypothesisExecute,
    }));

    const emitter = {
      emitUpdate: jest.fn(),
      log: jest.fn(),
    };

    const resultFinalizer = {
      handleExecutorIntervention: jest.fn(),
      applyEntityWriteback: jest.fn(),
      finalizeAnalysisResult: jest.fn().mockImplementation((input: any) => ({
        sessionId: 's1',
        success: true,
        findings: input.mergedFindings,
        hypotheses: [],
        conclusion: 'ok',
        confidence: input.executorResult.confidence,
        rounds: input.executorResult.rounds,
        totalDurationMs: 1,
      })),
    };

    const handler = new InitialModeHandler({
      runtimeConfig,
      modelRouter: {} as any,
      executionFactory: {
        createExecutionServices: () => ({
          modelRouter: {} as any,
          messageBus: {
            createSharedContext: () => ({ hypotheses: new Map() }),
          },
          circuitBreaker: {} as any,
        }),
      } as any,
      resultFinalizer: resultFinalizer as any,
      incrementalAnalyzer: {
        determineScope: () => ({
          type: 'full',
          relevantAgents: [],
          relevantSkills: [],
          isExtension: false,
          reason: 'full',
        }),
        mergeFindings: (left: any[], right: any[]) => [...left, ...right],
      } as any,
      focusStore: {} as any,
      agentRegistry: {} as any,
      strategyPlanner: {} as any,
      strategyRegistry: {
        getAll: () => [{ id: 'scrolling' }],
      } as any,
      updateBridge: {
        createEmitter: () => emitter,
      } as any,
    });

    const runtimeContext = {
      intent: {
        primaryGoal: 'Analyze',
        aspects: [],
        expectedOutputType: 'diagnosis',
        complexity: 'simple',
      },
      sessionContext: createSessionContext(),
      executionOptions: {},
      decisionContext: { mode: 'initial' },
    } as any;

    const result = await handler.execute({
      runtimeContext,
      query: 'analyze trace',
      sessionId: 's1',
      traceId: 't1',
    });

    expect(HypothesisExecutor).toHaveBeenCalledTimes(1);
    expect(hypothesisSetFocusStore).toHaveBeenCalledTimes(1);
    expect(hypothesisExecute).toHaveBeenCalledTimes(1);
    expect(emitter.emitUpdate).toHaveBeenCalledWith(
      'strategy_fallback',
      expect.objectContaining({
        fallbackTo: 'hypothesis_driven',
        reason: 'No tasks generated for strategy stage: overview',
      })
    );

    const finalizeCall: any = (resultFinalizer.finalizeAnalysisResult as any).mock.calls[0][0];
    expect(finalizeCall.executorResult.rounds).toBe(3);
    expect(finalizeCall.executorResult.findings).toHaveLength(1);
    expect(finalizeCall.executorResult.confidence).toBe(0.8);
    expect(result.findings).toHaveLength(1);
  });

  it('does not fallback when strategy completes normally', async () => {
    const strategyExecute: any = jest.fn();
    strategyExecute.mockResolvedValue({
      findings: [
        {
          id: 'f-1',
          severity: 'info',
          title: 'done',
          description: 'strategy finished',
        },
      ],
      lastStrategy: { strategy: 'conclude', confidence: 0.9, reasoning: 'done' },
      confidence: 0.9,
      informationGaps: [],
      rounds: 1,
      stopReason: 'Strategy Scrolling Strategy completed',
    });
    const strategyExecutor = {
      execute: strategyExecute,
    };

    (selectInitialExecutor as any).mockResolvedValue({
      executor: strategyExecutor,
      executorType: 'strategy',
      initialHypotheses: [],
      strategyMatchResult: {
        strategy: { id: 'scrolling', name: 'Scrolling Strategy' },
        confidence: 0.9,
        matchMethod: 'keyword',
      },
      effectiveConfig: runtimeConfig,
    });

    (HypothesisExecutor as unknown as jest.Mock).mockImplementation(() => ({
      setFocusStore: jest.fn(),
      execute: jest.fn(),
    }));

    const resultFinalizer = {
      handleExecutorIntervention: jest.fn(),
      applyEntityWriteback: jest.fn(),
      finalizeAnalysisResult: (() => {
        const fn: any = jest.fn();
        fn.mockResolvedValue({
          sessionId: 's1',
          success: true,
          findings: [],
          hypotheses: [],
          conclusion: 'ok',
          confidence: 0.9,
          rounds: 1,
          totalDurationMs: 1,
        });
        return fn;
      })(),
    };

    const handler = new InitialModeHandler({
      runtimeConfig,
      modelRouter: {} as any,
      executionFactory: {
        createExecutionServices: () => ({
          modelRouter: {} as any,
          messageBus: {
            createSharedContext: () => ({ hypotheses: new Map() }),
          },
          circuitBreaker: {} as any,
        }),
      } as any,
      resultFinalizer: resultFinalizer as any,
      incrementalAnalyzer: {
        determineScope: () => ({
          type: 'full',
          relevantAgents: [],
          relevantSkills: [],
          isExtension: false,
          reason: 'full',
        }),
        mergeFindings: (left: any[], right: any[]) => [...left, ...right],
      } as any,
      focusStore: {} as any,
      agentRegistry: {} as any,
      strategyPlanner: {} as any,
      strategyRegistry: { getAll: () => [{ id: 'scrolling' }] } as any,
      updateBridge: {
        createEmitter: () => ({ emitUpdate: jest.fn(), log: jest.fn() }),
      } as any,
    });

    const runtimeContext = {
      intent: {
        primaryGoal: 'Analyze',
        aspects: [],
        expectedOutputType: 'diagnosis',
        complexity: 'simple',
      },
      sessionContext: createSessionContext(),
      executionOptions: {},
      decisionContext: { mode: 'initial' },
    } as any;

    await handler.execute({
      runtimeContext,
      query: 'analyze trace',
      sessionId: 's1',
      traceId: 't1',
    });

    expect(HypothesisExecutor).not.toHaveBeenCalled();
  });
});
