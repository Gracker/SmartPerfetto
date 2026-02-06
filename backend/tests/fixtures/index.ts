/**
 * Test Fixtures - Mock Factories for SmartPerfetto Backend Tests
 *
 * Provides reusable mock factories for common test dependencies:
 * - ModelRouter
 * - EnhancedSessionContext
 * - AgentMessageBus
 * - ProgressEmitter
 * - CircuitBreaker
 * - DomainAgentRegistry
 * - Common data structures (Intent, Finding, Hypothesis)
 */

import type { ModelRouter } from '../../src/agent/core/modelRouter';
import type { EnhancedSessionContext } from '../../src/agent/context/enhancedSessionContext';
import type { AgentMessageBus } from '../../src/agent/communication/agentMessageBus';
import type { ProgressEmitter } from '../../src/agent/core/orchestratorTypes';
import type { CircuitBreaker } from '../../src/agent/core/circuitBreaker';
import type { Intent, Finding, CircuitBreakerConfig, ModelCallResult } from '../../src/agent/types';
import type { Hypothesis, AgentResponse, AgentTask, SharedAgentContext } from '../../src/agent/types/agentProtocol';
import type { EntityStore } from '../../src/agent/context/entityStore';

// =============================================================================
// ModelRouter Mock
// =============================================================================

export interface MockModelRouterOptions {
  /**
   * Default response for callWithFallback
   * Can be a string, object (for JSON responses), or a function for dynamic responses
   */
  defaultResponse?: string | Record<string, any> | ((prompt: string) => string | Record<string, any>);
  /**
   * Should callWithFallback succeed by default
   */
  shouldSucceed?: boolean;
  /**
   * Default model ID to return
   */
  modelId?: string;
  /**
   * Default usage stats
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  };
  /**
   * Default latency in ms
   */
  latencyMs?: number;
}

/**
 * Creates a mock ModelRouter with configurable callWithFallback behavior
 */
export function createMockModelRouter(
  options: MockModelRouterOptions = {}
): jest.Mocked<Partial<ModelRouter>> {
  const {
    defaultResponse = 'Mock LLM response',
    shouldSucceed = true,
    modelId = 'test-model',
    usage = { inputTokens: 100, outputTokens: 50, totalCost: 0.001 },
    latencyMs = 100,
  } = options;

  const mockRouter: jest.Mocked<Partial<ModelRouter>> = {
    callWithFallback: jest.fn().mockImplementation(async (prompt: string) => {
      if (!shouldSucceed) {
        throw new Error('Mock LLM error');
      }

      let response: string;
      if (typeof defaultResponse === 'function') {
        const result = defaultResponse(prompt);
        response = typeof result === 'string' ? result : JSON.stringify(result);
      } else if (typeof defaultResponse === 'string') {
        response = defaultResponse;
      } else {
        response = JSON.stringify(defaultResponse);
      }

      const result: ModelCallResult = {
        success: true,
        response,
        modelId,
        usage,
        latencyMs,
      };
      return result;
    }),
  };

  return mockRouter;
}

// =============================================================================
// EnhancedSessionContext Mock
// =============================================================================

export interface MockSessionContextOptions {
  sessionId?: string;
  traceId?: string;
  turnCount?: number;
  findings?: Finding[];
}

/**
 * Creates a mock EnhancedSessionContext
 *
 * Note: The actual EnhancedSessionContext uses getAllTurns().length for turn count
 */
export function createMockSessionContext(
  options: MockSessionContextOptions = {}
): jest.Mocked<Partial<EnhancedSessionContext>> {
  const {
    sessionId = 'test-session-001',
    traceId = 'test-trace-001',
    turnCount = 0,
    findings = [],
  } = options;

  const mockFindingsMap = new Map<string, Finding>();
  findings.forEach(f => mockFindingsMap.set(f.id, f));

  // Create mock turns array
  const mockTurns: any[] = [];
  for (let i = 0; i < turnCount; i++) {
    mockTurns.push({
      id: `turn-${i}`,
      timestamp: Date.now(),
      query: `Mock query ${i}`,
      intent: { primaryGoal: 'test', aspects: [], expectedOutputType: 'diagnosis', complexity: 'moderate' },
      findings: [],
      turnIndex: i,
      completed: true,
    });
  }

  const mockEntityStore: Partial<EntityStore> = {
    getAllFrames: jest.fn().mockReturnValue([]),
    getAllSessions: jest.fn().mockReturnValue([]),
    getFrame: jest.fn().mockReturnValue(undefined),
    getSession: jest.fn().mockReturnValue(undefined),
    getLastCandidateFrames: jest.fn().mockReturnValue([]),
    getLastCandidateSessions: jest.fn().mockReturnValue([]),
    setLastCandidateFrames: jest.fn(),
    setLastCandidateSessions: jest.fn(),
    upsertFrame: jest.fn(),
    upsertSession: jest.fn(),
  };

  const contextSummary = {
    turnCount,
    conversationSummary: 'Mock conversation summary',
    keyFindings: findings.map(f => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      turnIndex: 0,
    })),
    topicsDiscussed: [] as string[],
    openQuestions: [] as string[],
  };

  const mockContext: jest.Mocked<Partial<EnhancedSessionContext>> = {
    getAllTurns: jest.fn().mockReturnValue(mockTurns),
    getRecentTurns: jest.fn().mockImplementation((n: number) => mockTurns.slice(-n)),
    getAllFindings: jest.fn().mockReturnValue(findings),
    getFinding: jest.fn().mockImplementation((id: string) => mockFindingsMap.get(id)),
    getFindingsFromTurn: jest.fn().mockReturnValue([]),
    generateContextSummary: jest.fn().mockReturnValue(contextSummary),
    generatePromptContext: jest.fn().mockReturnValue('Mock prompt context'),
    getEntityStore: jest.fn().mockReturnValue(mockEntityStore as EntityStore),
    addTurn: jest.fn().mockReturnValue({
      id: `turn-${turnCount}`,
      timestamp: Date.now(),
      query: 'New turn',
      intent: { primaryGoal: 'test', aspects: [], expectedOutputType: 'diagnosis', complexity: 'moderate' },
      findings: [],
      turnIndex: turnCount,
      completed: false,
    }),
    completeTurn: jest.fn(),
    getTraceAgentState: jest.fn().mockReturnValue(null),
    getOrCreateTraceAgentState: jest.fn().mockReturnValue({
      version: 1,
      sessionId,
      traceId,
      userGoal: '',
      currentHypotheses: [],
      experiments: [],
      memorySnapshots: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    getSessionId: jest.fn().mockReturnValue(sessionId),
    getTraceId: jest.fn().mockReturnValue(traceId),
    extractReferenceableEntities: jest.fn().mockReturnValue([]),
  };

  return mockContext;
}

// =============================================================================
// AgentMessageBus Mock
// =============================================================================

export interface MockMessageBusOptions {
  /** Pre-registered agent IDs */
  registeredAgents?: string[];
}

/**
 * Creates a mock AgentMessageBus
 *
 * Note: The actual AgentMessageBus.registerAgent takes a BaseAgent, not a string.
 * This mock simplifies for testing by tracking agent IDs.
 */
export function createMockMessageBus(
  options: MockMessageBusOptions = {}
): jest.Mocked<Partial<AgentMessageBus>> & {
  // Additional helper methods for testing
  _getRegisteredAgentIds: () => string[];
  _isAgentIdRegistered: (id: string) => boolean;
} {
  const { registeredAgents = [] } = options;
  const agentIds = new Set(registeredAgents);

  const mockBus: any = {
    // Actual AgentMessageBus methods
    registerAgent: jest.fn().mockImplementation((agent: any) => {
      // agent can be BaseAgent (has config.id) or string (for simplified testing)
      const id = typeof agent === 'string' ? agent : agent?.config?.id;
      if (id) agentIds.add(id);
    }),
    unregisterAgent: jest.fn().mockImplementation((agentId: string) => {
      agentIds.delete(agentId);
    }),
    dispatchTask: jest.fn().mockResolvedValue(undefined),
    dispatchTasks: jest.fn().mockResolvedValue([]),
    broadcast: jest.fn(),
    setSharedContext: jest.fn(),
    getSharedContext: jest.fn().mockReturnValue(null),
    on: jest.fn().mockReturnThis(),
    off: jest.fn().mockReturnThis(),
    once: jest.fn().mockReturnThis(),
    emit: jest.fn().mockReturnValue(true),
    removeAllListeners: jest.fn().mockReturnThis(),

    // Helper methods for test assertions
    _getRegisteredAgentIds: () => Array.from(agentIds),
    _isAgentIdRegistered: (id: string) => agentIds.has(id),
  };

  return mockBus;
}

// =============================================================================
// ProgressEmitter Mock
// =============================================================================

export interface MockProgressEmitterOptions {
  /** Capture emitted updates for inspection */
  captureUpdates?: boolean;
  /** Capture log messages for inspection */
  captureLogs?: boolean;
}

export interface MockProgressEmitterResult {
  emitter: ProgressEmitter;
  emittedUpdates: Array<{ type: string; content: any }>;
  logs: string[];
}

/**
 * Creates a mock ProgressEmitter that optionally captures all emitted updates
 */
export function createMockProgressEmitter(
  options: MockProgressEmitterOptions = {}
): MockProgressEmitterResult {
  const { captureUpdates = true, captureLogs = true } = options;

  const emittedUpdates: Array<{ type: string; content: any }> = [];
  const logs: string[] = [];

  const emitter: ProgressEmitter = {
    emitUpdate: (type, content) => {
      if (captureUpdates) {
        emittedUpdates.push({ type, content });
      }
    },
    log: (message) => {
      if (captureLogs) {
        logs.push(message);
      }
    },
  };

  return { emitter, emittedUpdates, logs };
}

// =============================================================================
// CircuitBreaker Mock
// =============================================================================

export interface MockCircuitBreakerOptions {
  /** Initial state */
  state?: 'closed' | 'open' | 'half-open';
  /** Should canExecute return continue */
  canExecute?: boolean;
  /** Force close call count */
  forceCloseCallCount?: number;
}

/**
 * Creates a mock CircuitBreaker
 */
export function createMockCircuitBreaker(
  options: MockCircuitBreakerOptions = {}
): jest.Mocked<Partial<CircuitBreaker>> {
  const {
    state = 'closed',
    canExecute = true,
    forceCloseCallCount = 0,
  } = options;

  const mockBreaker: jest.Mocked<Partial<CircuitBreaker>> = {
    canExecute: jest.fn().mockReturnValue({
      action: canExecute ? 'continue' : 'ask_user',
      reason: canExecute ? undefined : 'Circuit breaker tripped',
    }),
    recordFailure: jest.fn().mockReturnValue({ action: 'retry' }),
    recordSuccess: jest.fn(),
    recordIteration: jest.fn().mockReturnValue({ action: 'continue' }),
    forceClose: jest.fn().mockReturnValue(true),
    handleUserResponse: jest.fn().mockReturnValue({ action: 'continue' }),
    reset: jest.fn(),
    getDiagnostics: jest.fn().mockReturnValue({
      agentId: 'test-agent',
      failureCount: 0,
      iterationCount: 0,
      state,
      recentErrors: [],
      lastAttemptTime: Date.now(),
    }),
    getAllDiagnostics: jest.fn().mockReturnValue({
      failureCount: 0,
      iterationCount: 0,
      state,
    }),
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  };

  // Getters as properties
  Object.defineProperty(mockBreaker, 'circuitState', { get: () => state });
  Object.defineProperty(mockBreaker, 'isClosed', { get: () => state === 'closed' });
  Object.defineProperty(mockBreaker, 'isTripped', { get: () => state === 'open' });
  Object.defineProperty(mockBreaker, 'isHalfOpen', { get: () => state === 'half-open' });
  Object.defineProperty(mockBreaker, 'forceCloseCallCount', { get: () => forceCloseCallCount });
  Object.defineProperty(mockBreaker, 'isForceCloseLimitReached', { get: () => forceCloseCallCount >= 5 });

  return mockBreaker;
}

// =============================================================================
// DomainAgentRegistry Mock
// =============================================================================

export interface MockAgentRegistryOptions {
  /** Agent IDs to register */
  agentIds?: string[];
}

/**
 * Creates a mock DomainAgentRegistry
 */
export function createMockAgentRegistry(
  options: MockAgentRegistryOptions = {}
): Record<string, any> {
  const { agentIds = ['frame_agent', 'cpu_agent', 'memory_agent', 'binder_agent'] } = options;

  const mockAgents: Record<string, any> = {};

  for (const agentId of agentIds) {
    mockAgents[agentId] = {
      id: agentId,
      name: agentId.replace('_', ' '),
      domain: agentId.replace('_agent', ''),
      execute: jest.fn().mockResolvedValue({
        agentId,
        taskId: 'mock-task',
        success: true,
        findings: [],
        confidence: 0.8,
        executionTimeMs: 100,
        toolResults: [],
      }),
      getTools: jest.fn().mockReturnValue([]),
      canHandle: jest.fn().mockReturnValue(true),
    };
  }

  return {
    getAgent: jest.fn().mockImplementation((id: string) => mockAgents[id]),
    getAllAgents: jest.fn().mockReturnValue(Object.values(mockAgents)),
    getAgentIds: jest.fn().mockReturnValue(agentIds),
    hasAgent: jest.fn().mockImplementation((id: string) => id in mockAgents),
    ...mockAgents,
  };
}

// =============================================================================
// Intent Mock
// =============================================================================

export interface MockIntentOptions {
  primaryGoal?: string;
  aspects?: string[];
  expectedOutputType?: 'diagnosis' | 'comparison' | 'timeline' | 'summary';
  complexity?: 'simple' | 'moderate' | 'complex';
  followUpType?: 'initial' | 'drill_down' | 'clarify' | 'extend' | 'compare';
}

/**
 * Creates a mock Intent object
 */
export function createMockIntent(options: MockIntentOptions = {}): Intent {
  const {
    primaryGoal = '分析滑动卡顿的根因',
    aspects = ['jank', 'frame'],
    expectedOutputType = 'diagnosis',
    complexity = 'moderate',
    followUpType = 'initial',
  } = options;

  return {
    primaryGoal,
    aspects,
    expectedOutputType,
    complexity,
    followUpType,
  };
}

// =============================================================================
// Finding Mock
// =============================================================================

export interface MockFindingOptions {
  id?: string;
  severity?: 'info' | 'warning' | 'critical' | 'low' | 'medium' | 'high';
  title?: string;
  description?: string;
  source?: string;
  confidence?: number;
  details?: Record<string, any>;
  category?: string;
}

/**
 * Creates a mock Finding object
 */
export function createMockFinding(options: MockFindingOptions = {}): Finding {
  const {
    id = `finding_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    severity = 'warning',
    title = 'Mock Finding',
    description = 'This is a mock finding for testing',
    source = 'test',
    confidence = 0.8,
    details = {},
    category = 'frame',
  } = options;

  return {
    id,
    severity,
    title,
    description,
    source,
    confidence,
    details,
    category,
  };
}

// =============================================================================
// Hypothesis Mock
// =============================================================================

export interface MockHypothesisOptions {
  id?: string;
  description?: string;
  confidence?: number;
  status?: 'proposed' | 'investigating' | 'confirmed' | 'rejected';
  proposedBy?: string;
  relevantAgents?: string[];
}

/**
 * Creates a mock Hypothesis object
 */
export function createMockHypothesis(options: MockHypothesisOptions = {}): Hypothesis {
  const {
    id = `hypo_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    description = 'Mock hypothesis for testing',
    confidence = 0.6,
    status = 'proposed',
    proposedBy = 'test',
    relevantAgents = ['frame_agent'],
  } = options;

  const now = Date.now();

  return {
    id,
    description,
    confidence,
    status,
    supportingEvidence: [],
    contradictingEvidence: [],
    proposedBy,
    relevantAgents,
    createdAt: now,
    updatedAt: now,
  };
}

// =============================================================================
// SharedAgentContext Mock
// =============================================================================

export interface MockSharedContextOptions {
  sessionId?: string;
  traceId?: string;
  hypotheses?: Hypothesis[];
  confirmedFindings?: Finding[];
}

/**
 * Creates a mock SharedAgentContext
 */
export function createMockSharedContext(
  options: MockSharedContextOptions = {}
): SharedAgentContext {
  const {
    sessionId = 'test-session-001',
    traceId = 'test-trace-001',
    hypotheses = [],
    confirmedFindings = [],
  } = options;

  const hypothesesMap = new Map<string, Hypothesis>();
  hypotheses.forEach(h => hypothesesMap.set(h.id, h));

  return {
    sessionId,
    traceId,
    hypotheses: hypothesesMap,
    confirmedFindings,
    investigationPath: [],
  };
}

// =============================================================================
// AgentResponse Mock
// =============================================================================

export interface MockAgentResponseOptions {
  agentId?: string;
  taskId?: string;
  success?: boolean;
  findings?: Finding[];
  confidence?: number;
  executionTimeMs?: number;
}

/**
 * Creates a mock AgentResponse
 */
export function createMockAgentResponse(
  options: MockAgentResponseOptions = {}
): AgentResponse {
  const {
    agentId = 'frame_agent',
    taskId = `task_${Date.now()}`,
    success = true,
    findings = [],
    confidence = 0.8,
    executionTimeMs = 100,
  } = options;

  return {
    agentId,
    taskId,
    success,
    findings,
    confidence,
    executionTimeMs,
    toolResults: [],
  };
}

// =============================================================================
// Common LLM Response Fixtures
// =============================================================================

/**
 * Pre-defined LLM response fixtures for common test scenarios
 */
export const mockLLMResponses = {
  /**
   * Simple conclusion response
   */
  simpleConclusion: '基于分析，主要问题是主线程阻塞导致的掉帧。',

  /**
   * Structured 4-section conclusion
   */
  structuredConclusion: `## 结论（按可能性排序）
1. 主线程阻塞（置信度: 85%）
   - 观察到多次长时间 Runnable/Running 状态

## 证据链（对应上述结论）
- C1: frame_agent 检测到 45ms 的主线程阻塞

## 不确定性与反例
- 需要进一步排查 RenderThread 的影响

## 下一步（最高信息增益）
- 针对关键帧做 CPU 调度分析`,

  /**
   * Intent understanding JSON response
   */
  intentUnderstanding: JSON.stringify({
    primaryGoal: '分析滑动卡顿问题',
    aspects: ['jank', 'frame', 'cpu'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
    followUpType: 'initial',
  }),

  /**
   * Hypothesis generation JSON response
   */
  hypothesisGeneration: JSON.stringify({
    hypotheses: [
      {
        id: 'hypo_001',
        description: '主线程长时间阻塞导致掉帧',
        confidence: 0.7,
        relevantAgents: ['frame_agent', 'cpu_agent'],
      },
      {
        id: 'hypo_002',
        description: 'Binder 调用延迟影响渲染',
        confidence: 0.5,
        relevantAgents: ['binder_agent', 'frame_agent'],
      },
    ],
  }),

  /**
   * Task planning JSON response
   */
  taskPlanning: JSON.stringify({
    tasks: [
      {
        agentId: 'frame_agent',
        description: '分析掉帧情况',
        priority: 1,
      },
      {
        agentId: 'cpu_agent',
        description: '分析 CPU 调度',
        priority: 2,
      },
    ],
  }),

  /**
   * Empty/no findings response
   */
  noFindings: '未发现明显问题，trace 数据正常。',

  /**
   * Error response
   */
  error: '分析过程中遇到错误，无法完成分析。',
};

// =============================================================================
// AgentTask Mock
// =============================================================================

export interface MockAgentTaskOptions {
  id?: string;
  description?: string;
  targetAgentId?: string;
  priority?: number;
  query?: string;
  hypothesis?: Hypothesis;
}

/**
 * Creates a mock AgentTask
 */
export function createMockAgentTask(options: MockAgentTaskOptions = {}): AgentTask {
  const {
    id = `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    description = 'Mock task for testing',
    targetAgentId = 'frame_agent',
    priority = 1,
    query = '分析滑动卡顿',
    hypothesis,
  } = options;

  return {
    id,
    description,
    targetAgentId,
    priority,
    context: {
      query,
      hypothesis,
    },
    dependencies: [],
    createdAt: Date.now(),
  };
}
