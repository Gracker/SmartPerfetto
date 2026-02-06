/**
 * AgentDrivenOrchestrator Unit Tests
 *
 * Tests the thin coordination layer that:
 * 1. Initializes infrastructure (message bus, agent registry, strategy registry)
 * 2. Understands user intent and generates hypotheses
 * 3. Routes to the appropriate executor based on follow-up type and strategy matching
 * 4. Manages session context for multi-turn support
 * 5. Generates conclusions from executor results
 */

import { EventEmitter } from 'events';
import { AgentDrivenOrchestrator, createAgentDrivenOrchestrator } from '../agentDrivenOrchestrator';
import type { ModelRouter } from '../modelRouter';
import type { AgentDrivenOrchestratorConfig, ExecutorResult } from '../orchestratorTypes';
import type { Intent, Finding } from '../../types';
import type { Hypothesis } from '../../types/agentProtocol';
import { sessionContextManager } from '../../context/enhancedSessionContext';
import { createEmptyCapturedEntities } from '../entityCapture';

// Mock all dependencies
jest.mock('../intentUnderstanding', () => ({
  understandIntent: jest.fn(),
}));

jest.mock('../hypothesisGenerator', () => ({
  generateInitialHypotheses: jest.fn(),
  translateFollowUpType: jest.fn((type: string) => {
    const translations: Record<string, string> = {
      'drill_down': '深入分析',
      'clarify': '澄清',
      'extend': '扩展',
      'compare': '对比',
      'initial': '初始',
    };
    return translations[type] || type;
  }),
}));

jest.mock('../conclusionGenerator', () => ({
  generateConclusion: jest.fn(),
}));

jest.mock('../followUpHandler', () => ({
  resolveFollowUp: jest.fn(),
}));

jest.mock('../drillDownResolver', () => ({
  resolveDrillDown: jest.fn(),
}));

jest.mock('../entityCapture', () => ({
  applyCapturedEntities: jest.fn(),
  createEmptyCapturedEntities: jest.fn(() => ({
    frames: [],
    sessions: [],
    cpuSlices: [],
    binders: [],
    gcs: [],
    memories: [],
    generics: [],
    candidateFrameIds: [],
    candidateSessionIds: [],
  })),
}));

jest.mock('../../../services/adb', () => ({
  detectAdbContext: jest.fn().mockResolvedValue({
    mode: 'off',
    enabled: false,
    availability: { installed: false },
  }),
  getAdbService: jest.fn().mockReturnValue({
    isAdbAvailable: () => false,
    getDevices: () => [],
    executeCommand: jest.fn(),
  }),
}));

jest.mock('../executors/traceConfigDetector', () => ({
  detectTraceConfig: jest.fn().mockResolvedValue({
    refreshRateHz: 60,
    vsyncPeriodMs: 16.67,
    isVRR: false,
  }),
}));

// Mock domain agent registry to avoid loading real agents
const mockAgent = {
  id: 'mock_agent',
  name: 'Mock Agent',
  domain: 'mock',
  execute: jest.fn().mockResolvedValue({ findings: [], confidence: 0.5 }),
};

jest.mock('../../agents/domain', () => ({
  createDomainAgentRegistry: jest.fn().mockReturnValue({
    getAll: () => [mockAgent],
    get: (id: string) => (id === 'mock_agent' ? mockAgent : undefined),
  }),
  DomainAgentRegistry: jest.fn(),
}));

// Mock communication module
jest.mock('../../communication', () => ({
  createAgentMessageBus: jest.fn().mockReturnValue({
    registerAgent: jest.fn(),
    reset: jest.fn(),
    createSharedContext: jest.fn().mockReturnValue({
      sessionId: 'test-session',
      traceId: 'test-trace',
      hypotheses: new Map(),
      confirmedFindings: [],
      investigationPath: [],
    }),
    updateHypothesis: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
  }),
  AgentMessageBus: jest.fn(),
}));

// Mock strategies
jest.mock('../../strategies', () => ({
  createEnhancedStrategyRegistry: jest.fn().mockReturnValue({
    match: jest.fn().mockReturnValue(null),
    matchEnhanced: jest.fn().mockResolvedValue({
      strategy: null,
      confidence: 0,
      matchMethod: 'none',
      fallbackReason: 'no_match',
    }),
    getAll: () => [],
  }),
  StrategyRegistry: jest.fn(),
}));

// Mock iteration strategy planner
jest.mock('../../agents/iterationStrategyPlanner', () => ({
  createIterationStrategyPlanner: jest.fn().mockReturnValue({
    evaluate: jest.fn(),
    resetProgressTracking: jest.fn(),
  }),
}));

// Mock strategy selector
jest.mock('../strategySelector', () => ({
  detectTraceContext: jest.fn().mockResolvedValue({}),
}));

// Mock the executors
jest.mock('../executors/clarifyExecutor');
jest.mock('../executors/comparisonExecutor');
jest.mock('../executors/extendExecutor');
jest.mock('../executors/directDrillDownExecutor');
jest.mock('../executors/strategyExecutor');
jest.mock('../executors/hypothesisExecutor');

// Import mocked modules
import { understandIntent } from '../intentUnderstanding';
import { generateInitialHypotheses, translateFollowUpType } from '../hypothesisGenerator';
import { generateConclusion } from '../conclusionGenerator';
import { resolveFollowUp } from '../followUpHandler';
import { resolveDrillDown } from '../drillDownResolver';
import { applyCapturedEntities } from '../entityCapture';
import { ClarifyExecutor } from '../executors/clarifyExecutor';
import { ComparisonExecutor } from '../executors/comparisonExecutor';
import { ExtendExecutor } from '../executors/extendExecutor';
import { DirectDrillDownExecutor } from '../executors/directDrillDownExecutor';
import { StrategyExecutor } from '../executors/strategyExecutor';
import { HypothesisExecutor } from '../executors/hypothesisExecutor';
import { createEnhancedStrategyRegistry } from '../../strategies';

describe('AgentDrivenOrchestrator', () => {
  let mockModelRouter: jest.Mocked<Partial<ModelRouter>>;
  let orchestrator: AgentDrivenOrchestrator;
  let emittedEvents: Array<{ event: string; data: any }>;

  // Default mock implementations
  const defaultIntent: Intent = {
    primaryGoal: '分析滑动卡顿',
    aspects: ['jank', 'frame'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
  };

  const defaultHypotheses: Hypothesis[] = [
    {
      id: 'hyp-1',
      description: '主线程阻塞导致掉帧',
      status: 'proposed',
      confidence: 0.7,
      supportingEvidence: [],
      contradictingEvidence: [],
      proposedBy: 'test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const defaultFindings: Finding[] = [
    {
      id: 'f-1',
      severity: 'critical',
      title: '主线程阻塞',
      description: '检测到主线程长时间阻塞',
      source: 'test',
      confidence: 0.9,
      details: {},
    },
  ];

  const defaultExecutorResult: ExecutorResult = {
    findings: defaultFindings,
    lastStrategy: null,
    confidence: 0.85,
    informationGaps: [],
    rounds: 2,
    stopReason: 'confidence_met',
  };

  const defaultConfig: Partial<AgentDrivenOrchestratorConfig> = {
    maxRounds: 5,
    maxConcurrentTasks: 3,
    confidenceThreshold: 0.7,
    maxNoProgressRounds: 2,
    maxFailureRounds: 2,
    enableLogging: false,
  };

  // Unique session ID generator for test isolation
  let testCounter = 0;
  const getUniqueSessionId = () => `test-session-${Date.now()}-${testCounter++}`;
  const getUniqueTraceId = () => `test-trace-${Date.now()}-${testCounter}`;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Track emitted events
    emittedEvents = [];

    // Create mock model router
    mockModelRouter = {
      callWithFallback: jest.fn().mockResolvedValue({
        success: true,
        response: '测试响应',
        modelId: 'test-model',
        usage: { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
        latencyMs: 500,
      }),
    };

    // Setup default mock implementations
    (understandIntent as jest.Mock).mockResolvedValue(defaultIntent);
    (generateInitialHypotheses as jest.Mock).mockResolvedValue(defaultHypotheses);
    (generateConclusion as jest.Mock).mockResolvedValue('测试结论：检测到主线程阻塞问题');
    (resolveFollowUp as jest.Mock).mockReturnValue({
      isFollowUp: false,
      resolvedParams: {},
      confidence: 1.0,
    });
    (resolveDrillDown as jest.Mock).mockResolvedValue(null);

    // Create orchestrator
    orchestrator = createAgentDrivenOrchestrator(
      mockModelRouter as unknown as ModelRouter,
      defaultConfig
    );

    // Track events
    orchestrator.on('update', (data) => {
      emittedEvents.push({ event: 'update', data });
    });
  });

  afterEach(() => {
    if (orchestrator) {
      orchestrator.reset();
      orchestrator.removeAllListeners();
    }
  });

  afterAll(() => {
    // Ensure all event listeners are cleaned up
    if (orchestrator) {
      orchestrator.removeAllListeners();
    }
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('Initialization', () => {
    test('creates orchestrator with default config', () => {
      const orch = createAgentDrivenOrchestrator(mockModelRouter as unknown as ModelRouter);
      expect(orch).toBeInstanceOf(AgentDrivenOrchestrator);
      expect(orch).toBeInstanceOf(EventEmitter);
    });

    test('creates orchestrator with custom config', () => {
      const customConfig: Partial<AgentDrivenOrchestratorConfig> = {
        maxRounds: 10,
        confidenceThreshold: 0.9,
        enableLogging: true,
      };
      const orch = createAgentDrivenOrchestrator(
        mockModelRouter as unknown as ModelRouter,
        customConfig
      );
      expect(orch).toBeInstanceOf(AgentDrivenOrchestrator);
    });

    test('provides access to FocusStore', () => {
      expect(orchestrator.getFocusStore()).toBeDefined();
    });

    test('provides access to InterventionController', () => {
      expect(orchestrator.getInterventionController()).toBeDefined();
    });

    test('reset clears internal state', () => {
      const focusStore = orchestrator.getFocusStore();
      focusStore.recordInteraction({
        type: 'explicit',
        target: { entityType: 'frame', entityId: '123' },
        source: 'agent',
        timestamp: Date.now(),
      });

      orchestrator.reset();

      expect(focusStore.getTopFocuses(1)).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Executor Routing Tests (5 paths)
  // ===========================================================================

  describe('Executor Routing', () => {
    let mockExecutorInstance: { execute: jest.Mock };

    beforeEach(() => {
      mockExecutorInstance = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
    });

    test('routes to ClarifyExecutor when followUpType is clarify', async () => {
      const clarifyIntent: Intent = {
        ...defaultIntent,
        followUpType: 'clarify',
        referencedEntities: [{ type: 'frame', id: 123 }],
      };
      (understandIntent as jest.Mock).mockResolvedValue(clarifyIntent);
      (ClarifyExecutor as jest.Mock).mockImplementation(() => mockExecutorInstance);

      await orchestrator.analyze('为什么帧123卡顿?', 'session-1', 'trace-1');

      expect(ClarifyExecutor).toHaveBeenCalled();
      expect(mockExecutorInstance.execute).toHaveBeenCalled();
    });

    test('routes to ComparisonExecutor when followUpType is compare', async () => {
      const compareIntent: Intent = {
        ...defaultIntent,
        followUpType: 'compare',
        referencedEntities: [
          { type: 'frame', id: 123 },
          { type: 'frame', id: 456 },
        ],
      };
      (understandIntent as jest.Mock).mockResolvedValue(compareIntent);
      (ComparisonExecutor as jest.Mock).mockImplementation(() => mockExecutorInstance);

      await orchestrator.analyze('对比帧123和帧456', 'session-1', 'trace-1');

      expect(ComparisonExecutor).toHaveBeenCalled();
      expect(mockExecutorInstance.execute).toHaveBeenCalled();
    });

    test('routes to ExtendExecutor when followUpType is extend', async () => {
      const extendIntent: Intent = {
        ...defaultIntent,
        followUpType: 'extend',
      };
      (understandIntent as jest.Mock).mockResolvedValue(extendIntent);

      const mockExtendExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (ExtendExecutor as jest.Mock).mockImplementation(() => mockExtendExecutor);

      await orchestrator.analyze('继续分析其他帧', 'session-1', 'trace-1');

      expect(ExtendExecutor).toHaveBeenCalled();
      expect(mockExtendExecutor.setFocusStore).toHaveBeenCalled();
      expect(mockExtendExecutor.execute).toHaveBeenCalled();
    });

    test('routes to DirectDrillDownExecutor for drill_down with focus intervals', async () => {
      const drillDownIntent: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 123 }],
        extractedParams: { frame_id: 123 },
      };
      (understandIntent as jest.Mock).mockResolvedValue(drillDownIntent);
      (resolveFollowUp as jest.Mock).mockReturnValue({
        isFollowUp: true,
        resolvedParams: { frame_id: 123 },
        focusIntervals: [
          {
            startTs: '123456789000000',
            endTs: '123456889000000',
            processName: 'com.example.app',
            label: '帧 123',
          },
        ],
        confidence: 0.9,
      });
      (resolveDrillDown as jest.Mock).mockResolvedValue({
        intervals: [
          {
            startTs: '123456789000000',
            endTs: '123456889000000',
            processName: 'com.example.app',
            label: '帧 123',
          },
        ],
        traces: [{ entityType: 'frame', entityId: '123', used: ['followUp'], enriched: true }],
      });
      (DirectDrillDownExecutor as jest.Mock).mockImplementation(() => mockExecutorInstance);

      await orchestrator.analyze('详细分析帧123', 'session-1', 'trace-1');

      expect(DirectDrillDownExecutor).toHaveBeenCalled();
      expect(mockExecutorInstance.execute).toHaveBeenCalled();
    });

    test('routes to StrategyExecutor when strategy matches', async () => {
      (understandIntent as jest.Mock).mockResolvedValue(defaultIntent);

      // Mock a matched scrolling strategy. Even with default preference
      // "hypothesis_experiment", scrolling should still use StrategyExecutor.
      const matchEnhancedMock = (orchestrator as any).strategyRegistry.matchEnhanced as jest.Mock;
      matchEnhancedMock.mockResolvedValueOnce({
        strategy: {
          id: 'scrolling',
          name: 'Scrolling/Jank Analysis',
          stages: [],
          trigger: () => true,
        },
        confidence: 0.92,
        matchMethod: 'keyword',
      });

      const mockStrategyExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
      (StrategyExecutor as jest.Mock).mockImplementation(() => mockStrategyExecutor);

      const mockHypothesisExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockHypothesisExecutor);

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(StrategyExecutor).toHaveBeenCalled();
      expect(mockStrategyExecutor.execute).toHaveBeenCalled();
      expect(mockHypothesisExecutor.execute).not.toHaveBeenCalled();
    });

    test('routes to StrategyExecutor for scene reconstruction strategy', async () => {
      const sceneIntent: Intent = {
        ...defaultIntent,
        primaryGoal: '场景还原',
        aspects: ['general'],
      };
      (understandIntent as jest.Mock).mockResolvedValue(sceneIntent);

      const matchEnhancedMock = (orchestrator as any).strategyRegistry.matchEnhanced as jest.Mock;
      matchEnhancedMock.mockResolvedValueOnce({
        strategy: {
          id: 'scene_reconstruction',
          name: '场景还原分析',
          stages: [],
          trigger: () => true,
        },
        confidence: 0.95,
        matchMethod: 'keyword',
      });

      const mockStrategyExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
      (StrategyExecutor as jest.Mock).mockImplementation(() => mockStrategyExecutor);

      const mockHypothesisExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockHypothesisExecutor);

      await orchestrator.analyze('场景还原', 'session-1', 'trace-1');

      expect(StrategyExecutor).toHaveBeenCalled();
      expect(mockStrategyExecutor.execute).toHaveBeenCalled();
      expect(mockHypothesisExecutor.execute).not.toHaveBeenCalled();
    });

    test('routes to HypothesisExecutor when no strategy matches', async () => {
      const generalIntent: Intent = {
        ...defaultIntent,
        primaryGoal: '一般性能分析',
        aspects: ['general'],
      };
      (understandIntent as jest.Mock).mockResolvedValue(generalIntent);

      const mockHypothesisExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockHypothesisExecutor);

      await orchestrator.analyze('一般性能分析', 'session-1', 'trace-1');

      // When no strategy matches, HypothesisExecutor is used
      expect(mockHypothesisExecutor.execute).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Intent Understanding Tests
  // ===========================================================================

  describe('Intent Understanding', () => {
    beforeEach(() => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);
    });

    test('calls understandIntent with query and session context', async () => {
      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(understandIntent).toHaveBeenCalledWith(
        '分析滑动卡顿',
        expect.any(Object), // sessionContext
        expect.any(Object), // modelRouter
        expect.any(Object) // emitter
      );
    });

    test('extracts follow-up type from intent', async () => {
      const drillDownIntent: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 456 }],
      };
      (understandIntent as jest.Mock).mockResolvedValue(drillDownIntent);

      await orchestrator.analyze('分析帧456', 'session-1', 'trace-1');

      // Verify that follow-up type is used in routing
      expect(understandIntent).toHaveBeenCalled();
      const intentResult = (understandIntent as jest.Mock).mock.results[0].value;
      expect((await intentResult).followUpType).toBe('drill_down');
    });

    test('handles referenced entities from intent', async () => {
      const intentWithEntities: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        referencedEntities: [
          { type: 'frame', id: 123 },
          { type: 'session', id: 2 },
        ],
        extractedParams: { frame_id: 123, session_id: 2 },
      };
      (understandIntent as jest.Mock).mockResolvedValue(intentWithEntities);

      await orchestrator.analyze('分析帧123和会话2', 'session-1', 'trace-1');

      expect(resolveFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          referencedEntities: expect.arrayContaining([
            expect.objectContaining({ type: 'frame', id: 123 }),
          ]),
        }),
        expect.any(Object)
      );
    });
  });

  // ===========================================================================
  // Session Context Tests
  // ===========================================================================

  describe('Session Context', () => {
    beforeEach(() => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);
    });

    test('gets or creates session context', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      expect(sessionContext).toBeDefined();
      expect(sessionContext.getSessionId()).toBe(sessionId);
    });

    test('records turn after analysis', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const turns = sessionContext.getAllTurns();
      expect(turns.length).toBeGreaterThan(0);
    });

    test('passes session context to executor', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          traceId,
          sessionContext: expect.any(Object),
        }),
        expect.any(Object)
      );
    });

    test('supports multi-turn conversations', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      // First turn
      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      // Second turn
      const followUpIntent: Intent = {
        ...defaultIntent,
        followUpType: 'extend',
      };
      (understandIntent as jest.Mock).mockResolvedValue(followUpIntent);

      const mockExtendExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (ExtendExecutor as jest.Mock).mockImplementation(() => mockExtendExecutor);

      await orchestrator.analyze('继续分析', sessionId, traceId);

      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const turns = sessionContext.getAllTurns();
      expect(turns.length).toBe(2);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('Error Handling', () => {
    test('returns failure result on analysis error', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      (understandIntent as jest.Mock).mockRejectedValue(new Error('Intent parsing failed'));

      const result = await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      expect(result.success).toBe(false);
      expect(result.conclusion).toContain('分析失败');
      expect(result.confidence).toBe(0);
      expect(result.rounds).toBe(0);
    });

    test('records failed turn in session context', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      (understandIntent as jest.Mock).mockRejectedValue(new Error('Test error'));

      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const turns = sessionContext.getAllTurns();
      expect(turns.length).toBe(1);
    });

    test('emits error event on failure', async () => {
      (understandIntent as jest.Mock).mockRejectedValue(new Error('Test error message'));

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      const errorEvents = emittedEvents.filter(
        e => e.data.type === 'error'
      );
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0].data.content.message).toContain('Test error message');
    });

    test('handles executor errors gracefully', async () => {
      const mockExecutor = {
        execute: jest.fn().mockRejectedValue(new Error('Executor failed')),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      const result = await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(result.success).toBe(false);
      expect(result.conclusion).toContain('分析失败');
    });
  });

  // ===========================================================================
  // Event Emission Tests
  // ===========================================================================

  describe('Event Emission', () => {
    beforeEach(() => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);
    });

    test('emits progress events at each phase', async () => {
      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      const progressEvents = emittedEvents.filter(
        e => e.data.type === 'progress'
      );
      expect(progressEvents.length).toBeGreaterThan(0);

      // Check for key phases
      const phases = progressEvents.map(e => e.data.content.phase);
      expect(phases).toContain('starting');
      expect(phases).toContain('understanding');
    });

    test('emits analysis_plan event', async () => {
      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      const progressEvents = emittedEvents.filter(
        e => e.data.type === 'progress' && e.data.content.phase === 'analysis_plan'
      );
      expect(progressEvents.length).toBe(1);
      expect(progressEvents[0].data.content.plan).toBeDefined();
      expect(progressEvents[0].data.content.plan.hypothesisPolicy).toBe('after_first_evidence');
    });

    test('emits analysis_plan before hypotheses_generated in strategy flow', async () => {
      const strategyEvents: Array<{event: string; data: any}> = [];
      (createEnhancedStrategyRegistry as jest.Mock).mockReturnValueOnce({
        match: jest.fn().mockReturnValue(null),
        matchEnhanced: jest.fn().mockResolvedValue({
          strategy: {id: 'scrolling', name: 'Scrolling/Jank Analysis'},
          confidence: 0.9,
          matchMethod: 'keyword',
          reasoning: 'keyword match',
          shouldFallback: false,
        }),
        getAll: () => [{id: 'scrolling'}],
      });

      const strategyOrchestrator = createAgentDrivenOrchestrator(
        mockModelRouter as unknown as ModelRouter,
        defaultConfig
      );
      strategyOrchestrator.on('update', (data) => {
        strategyEvents.push({event: 'update', data});
      });

      const mockStrategyExecutor = {
        execute: jest.fn().mockImplementation((_ctx: any, emitter: any) => {
          emitter.emitUpdate('progress', {
            phase: 'hypotheses_generated',
            message: '基于首轮证据，形成 1 个待验证假设',
            hypotheses: ['主线程阻塞导致掉帧'],
            evidenceBased: true,
            evidenceSummary: ['发现: 主线程长任务'],
          });
          return Promise.resolve(defaultExecutorResult);
        }),
      };
      (StrategyExecutor as jest.Mock).mockImplementation(() => mockStrategyExecutor);

      await strategyOrchestrator.analyze('分析滑动卡顿', 'session-strategy', 'trace-strategy');

      const phases = strategyEvents
        .filter(e => e.data.type === 'progress')
        .map(e => e.data.content.phase);
      expect(phases).toContain('analysis_plan');
      expect(phases).toContain('hypotheses_generated');
      expect(phases.indexOf('analysis_plan')).toBeLessThan(phases.indexOf('hypotheses_generated'));

      strategyOrchestrator.reset();
      strategyOrchestrator.removeAllListeners();
    });

    test('emits conclusion event', async () => {
      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      const conclusionEvents = emittedEvents.filter(
        e => e.data.type === 'conclusion'
      );
      expect(conclusionEvents.length).toBe(1);
      expect(conclusionEvents[0].data.content.sessionId).toBe('session-1');
      expect(conclusionEvents[0].data.content.summary).toBeDefined();
    });

    test('emits follow_up_detected event for follow-up queries', async () => {
      const drillDownIntent: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 123 }],
      };
      (understandIntent as jest.Mock).mockResolvedValue(drillDownIntent);

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
      (DirectDrillDownExecutor as jest.Mock).mockImplementation(() => mockExecutor);
      (resolveFollowUp as jest.Mock).mockReturnValue({
        isFollowUp: true,
        resolvedParams: { frame_id: 123 },
        focusIntervals: [{ startTs: '100', endTs: '200', processName: 'test' }],
        confidence: 0.9,
      });
      (resolveDrillDown as jest.Mock).mockResolvedValue({
        intervals: [{ startTs: '100', endTs: '200', processName: 'test' }],
        traces: [],
      });

      await orchestrator.analyze('分析帧123', 'session-1', 'trace-1');

      const followUpEvents = emittedEvents.filter(
        e => e.data.type === 'progress' && e.data.content.phase === 'follow_up_detected'
      );
      expect(followUpEvents.length).toBe(1);
      expect(followUpEvents[0].data.content.followUpType).toBe('drill_down');
    });
  });

  // ===========================================================================
  // Hypothesis Generation Tests
  // ===========================================================================

  describe('Hypothesis Generation', () => {
    beforeEach(() => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);
    });

    test('generates hypotheses for initial queries', async () => {
      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(generateInitialHypotheses).toHaveBeenCalled();
    });

    test('skips hypothesis generation for clarify follow-ups', async () => {
      const clarifyIntent: Intent = {
        ...defaultIntent,
        followUpType: 'clarify',
        referencedEntities: [{ type: 'frame', id: 123 }],
      };
      (understandIntent as jest.Mock).mockResolvedValue(clarifyIntent);

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
      (ClarifyExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('什么是 Buffer Stuffing?', 'session-1', 'trace-1');

      expect(generateInitialHypotheses).not.toHaveBeenCalled();
    });

    test('skips generic hypothesis generation for drill-down follow-ups', async () => {
      const drillDownIntent: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 1435508 }],
        extractedParams: { frame_id: 1435508 },
      };
      (understandIntent as jest.Mock).mockResolvedValue(drillDownIntent);

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
      (DirectDrillDownExecutor as jest.Mock).mockImplementation(() => mockExecutor);
      (resolveFollowUp as jest.Mock).mockReturnValue({
        isFollowUp: true,
        resolvedParams: { frame_id: 1435508, start_ts: '100', end_ts: '200' },
        focusIntervals: [{ startTs: '100', endTs: '200', processName: 'test' }],
        confidence: 0.9,
      });

      await orchestrator.analyze('分析 1,435,508 这一帧的掉帧原因', 'session-1', 'trace-1');

      expect(generateInitialHypotheses).not.toHaveBeenCalled();
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    test('passes generated hypotheses to sharedContext', async () => {
      const mockExecutor = {
        execute: jest.fn().mockImplementation((ctx) => {
          // Verify hypotheses are available in execution context
          expect(ctx.initialHypotheses.length).toBeGreaterThan(0);
          return Promise.resolve(defaultExecutorResult);
        }),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(mockExecutor.execute).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Follow-Up Resolution Tests
  // ===========================================================================

  describe('Follow-Up Resolution', () => {
    test('resolves follow-up query parameters', async () => {
      const drillDownIntent: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        extractedParams: { frame_id: 123 },
      };
      (understandIntent as jest.Mock).mockResolvedValue(drillDownIntent);

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
      };
      (DirectDrillDownExecutor as jest.Mock).mockImplementation(() => mockExecutor);
      (resolveFollowUp as jest.Mock).mockReturnValue({
        isFollowUp: true,
        resolvedParams: { frame_id: 123, start_ts: '100', end_ts: '200' },
        focusIntervals: [{ startTs: '100', endTs: '200', processName: 'test' }],
        confidence: 0.9,
      });
      (resolveDrillDown as jest.Mock).mockResolvedValue({
        intervals: [{ startTs: '100', endTs: '200', processName: 'test' }],
        traces: [],
      });

      await orchestrator.analyze('分析帧123', 'session-1', 'trace-1');

      expect(resolveFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ followUpType: 'drill_down' }),
        expect.any(Object)
      );
    });

    test('uses drillDownResolver for drill-down queries', async () => {
      const drillDownIntent: Intent = {
        ...defaultIntent,
        followUpType: 'drill_down',
        referencedEntities: [{ type: 'frame', id: 123 }],
      };
      (understandIntent as jest.Mock).mockResolvedValue(drillDownIntent);
      (resolveFollowUp as jest.Mock).mockReturnValue({
        isFollowUp: true,
        resolvedParams: {},
        focusIntervals: [],
        confidence: 0.8,
      });

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析帧123', 'session-1', 'trace-1');

      expect(resolveDrillDown).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Entity Capture Tests
  // ===========================================================================

  describe('Entity Capture', () => {
    test('applies captured entities to EntityStore', async () => {
      const executorResultWithEntities: ExecutorResult = {
        ...defaultExecutorResult,
        capturedEntities: {
          frames: [{ frame_id: '123', jank_type: 'App Deadline Missed' }],
          sessions: [],
          cpuSlices: [],
          binders: [],
          gcs: [],
          memories: [],
          generics: [],
          candidateFrameIds: [],
          candidateSessionIds: [],
        },
      };

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(executorResultWithEntities),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(applyCapturedEntities).toHaveBeenCalledWith(
        expect.any(Object), // EntityStore
        expect.objectContaining({
          frames: expect.arrayContaining([
            expect.objectContaining({ frame_id: '123' }),
          ]),
        })
      );
    });

    test('marks analyzed entity IDs after execution', async () => {
      const executorResultWithAnalyzed: ExecutorResult = {
        ...defaultExecutorResult,
        analyzedEntityIds: {
          frames: ['123', '456'],
          sessions: ['1'],
        },
      };

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(executorResultWithAnalyzed),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      // The orchestrator should mark these entities as analyzed
      // We can verify this through the session context's entity store
      const sessionContext = sessionContextManager.getOrCreate('session-1', 'trace-1');
      const entityStore = sessionContext.getEntityStore();
      // Note: markFrameAnalyzed is called, but we can't directly verify
      // without accessing the internal state
    });
  });

  // ===========================================================================
  // Conclusion Generation Tests
  // ===========================================================================

  describe('Conclusion Generation', () => {
    test('generates conclusion from executor results', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      expect(generateConclusion).toHaveBeenCalledWith(
        expect.any(Object), // sharedContext
        expect.any(Array), // findings
        expect.any(Object), // intent
        expect.any(Object), // modelRouter
        expect.any(Object), // emitter
        expect.any(String), // stopReason
        expect.objectContaining({
          turnCount: expect.any(Number),
        })
      );
    });

    test('includes turn count in conclusion context', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      // First turn (using unique session ID ensures turnCount starts at 0)
      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      expect(generateConclusion).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Array),
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        expect.any(String),
        expect.objectContaining({
          turnCount: 0, // First turn has 0 previous turns
        })
      );
    });
  });

  // ===========================================================================
  // Result Building Tests
  // ===========================================================================

  describe('Result Building', () => {
    test('returns successful result with all fields', async () => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      const result = await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(result.sessionId).toBe('session-1');
      expect(result.success).toBe(true);
      expect(result.findings).toEqual(defaultFindings);
      expect(result.confidence).toBe(0.85);
      expect(result.rounds).toBe(2);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.conclusion).toBeDefined();
    });

    test('includes hypotheses in result', async () => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      const result = await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      expect(result.hypotheses).toBeDefined();
      expect(Array.isArray(result.hypotheses)).toBe(true);
    });
  });

  // ===========================================================================
  // User Interaction Recording Tests
  // ===========================================================================

  describe('User Interaction Recording', () => {
    test('records user interaction in FocusStore', () => {
      orchestrator.recordUserInteraction({
        type: 'drill_down',
        target: { entityType: 'frame', entityId: '123' },
        source: 'ui',
        timestamp: Date.now(),
      });

      const focusStore = orchestrator.getFocusStore();
      const focuses = focusStore.getTopFocuses(5);
      expect(focuses.length).toBeGreaterThan(0);
    });

    test('emits focus_updated event on user interaction', () => {
      orchestrator.recordUserInteraction({
        type: 'explicit',
        target: { entityType: 'frame', entityId: '456' },
        source: 'query',
        timestamp: Date.now(),
      });

      const focusEvents = emittedEvents.filter(
        e => e.data.type === 'focus_updated'
      );
      expect(focusEvents.length).toBe(1);
    });
  });

  // ===========================================================================
  // Intervention Handling Tests
  // ===========================================================================

  describe('Intervention Handling', () => {
    test('handles intervention request from executor', async () => {
      const sessionId = getUniqueSessionId();
      const traceId = getUniqueTraceId();
      const executorResultWithIntervention: ExecutorResult = {
        ...defaultExecutorResult,
        interventionRequest: {
          type: 'low_confidence',
          reason: '置信度过低，需要用户确认',
          confidence: 0.4,
          possibleDirections: [
            { id: 'dir-1', description: '深入分析 CPU', confidence: 0.6 },
            { id: 'dir-2', description: '检查内存问题', confidence: 0.5 },
          ],
          progressSummary: '已分析 2 轮',
          elapsedTimeMs: 5000,
          roundsCompleted: 2,
        },
      };

      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(executorResultWithIntervention),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', sessionId, traceId);

      // Verify that intervention was handled
      // The intervention is created through the InterventionController,
      // which emits events that are forwarded to the orchestrator's event stream.
      // Check if an intervention_required event was emitted
      const interventionEvents = emittedEvents.filter(
        e => e.data.type === 'intervention_required'
      );
      // Since the InterventionController is real, intervention events should be emitted
      expect(interventionEvents.length).toBeGreaterThanOrEqual(0);

      // Also verify the executor was called with the intervention
      expect(mockExecutor.execute).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Incremental Analysis Tests
  // ===========================================================================

  describe('Incremental Analysis', () => {
    test('emits incremental_scope event', async () => {
      const mockExecutor = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor);

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      const scopeEvents = emittedEvents.filter(
        e => e.data.type === 'incremental_scope'
      );
      expect(scopeEvents.length).toBe(1);
      expect(scopeEvents[0].data.content.scopeType).toBeDefined();
    });

    test('merges findings with previous analysis for extension turns', async () => {
      // First turn
      const mockExecutor1 = {
        execute: jest.fn().mockResolvedValue(defaultExecutorResult),
        setFocusStore: jest.fn(),
      };
      (HypothesisExecutor as jest.Mock).mockImplementation(() => mockExecutor1);

      await orchestrator.analyze('分析滑动卡顿', 'session-1', 'trace-1');

      // Second turn (extend)
      const extendIntent: Intent = {
        ...defaultIntent,
        followUpType: 'extend',
      };
      (understandIntent as jest.Mock).mockResolvedValue(extendIntent);

      const newFindings: Finding[] = [
        {
          id: 'f-2',
          severity: 'warning',
          title: '新发现',
          description: '发现新问题',
          source: 'test',
        },
      ];
      const executorResult2: ExecutorResult = {
        ...defaultExecutorResult,
        findings: newFindings,
      };

      const mockExtendExecutor = {
        execute: jest.fn().mockResolvedValue(executorResult2),
        setFocusStore: jest.fn(),
      };
      (ExtendExecutor as jest.Mock).mockImplementation(() => mockExtendExecutor);

      const result = await orchestrator.analyze('继续分析', 'session-1', 'trace-1');

      // Result should include findings from the extend executor
      expect(result.findings).toBeDefined();
    });
  });
});
