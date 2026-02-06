/**
 * Orchestrator Types, Constants, and Interfaces
 *
 * Shared definitions used across orchestrator sub-modules:
 * - Config types and defaults
 * - Task graph structures
 * - Domain alias mappings
 * - Unified executor interface (AnalysisExecutor pattern)
 * - Progress emitter (decouples EventEmitter dependency)
 */

import {
  Intent,
  Finding,
  StreamingUpdate,
  Evaluation,
} from '../types';
import {
  AgentTask,
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
} from '../types/agentProtocol';
import {
  StrategyDecision,
} from '../agents/iterationStrategyPlanner';
import type { AgentMessageBus } from '../communication';
import type { CircuitBreaker } from './circuitBreaker';
import type { ModelRouter } from './modelRouter';
import type { FocusInterval } from '../strategies/types';
import type { AdbCollaborationConfig, AdbContext } from '../../services/adb';
import type { IncrementalScope } from './incrementalAnalyzer';
import type { EnhancedSessionContext } from '../context/enhancedSessionContext';

// =============================================================================
// Agent ID Constants
// =============================================================================

export const AGENT_IDS = {
  FRAME: 'frame_agent',
  CPU: 'cpu_agent',
  MEMORY: 'memory_agent',
  BINDER: 'binder_agent',
  STARTUP: 'startup_agent',
  INTERACTION: 'interaction_agent',
  ANR: 'anr_agent',
  SYSTEM: 'system_agent',
} as const;

// =============================================================================
// Configuration
// =============================================================================

export interface AgentDrivenOrchestratorConfig {
  /** Maximum analysis rounds */
  maxRounds: number;
  /**
   * Preferred maximum rounds (soft budget).
   * Executors may choose to stop after reaching this budget *if* results are already "good enough".
   * This should never be treated as a hard cap (use maxRounds for safety limits).
   */
  softMaxRounds?: number;
  /** Maximum concurrent agent tasks */
  maxConcurrentTasks: number;
  /** Confidence threshold to conclude */
  confidenceThreshold: number;
  /** Stop after consecutive rounds with no new evidence */
  maxNoProgressRounds: number;
  /** Stop after consecutive rounds with mostly failed tasks */
  maxFailureRounds: number;
  /** Enable logging */
  enableLogging: boolean;
  /** Streaming callback */
  streamingCallback?: (update: StreamingUpdate) => void;
}

export const DEFAULT_CONFIG: AgentDrivenOrchestratorConfig = {
  maxRounds: 5,
  maxConcurrentTasks: 3,
  confidenceThreshold: 0.7,
  maxNoProgressRounds: 2,
  maxFailureRounds: 2,
  enableLogging: true,
};

// =============================================================================
// Task Graph Types
// =============================================================================

export interface TaskGraphNode {
  id: string;
  domain: string;
  description: string;
  evidenceNeeded: string[];
  timeRange?: { start: number | string; end: number | string };
  dependsOn?: string[];
}

export interface TaskGraphPlan {
  nodes: TaskGraphNode[];
}

// =============================================================================
// Domain Mappings
// =============================================================================

export const DOMAIN_ALIASES: Record<string, string> = {
  gpu: 'frame',
  render: 'frame',
  rendering: 'frame',
  surfaceflinger: 'frame',
  sf: 'frame',
  choreographer: 'frame',
  ui: 'frame',
  input: 'interaction',
  touch: 'interaction',
  interaction: 'interaction',
  binder: 'binder',
  ipc: 'binder',
  lock: 'binder',
  memory: 'memory',
  gc: 'memory',
  art: 'memory',
  startup: 'startup',
  launch: 'startup',
  coldstart: 'startup',
  anr: 'anr',
  systemserver: 'system',
  system: 'system',
  thermal: 'system',
  io: 'system',
  power: 'system',
};

export const DEFAULT_EVIDENCE: Record<string, string[]> = {
  frame: ['jank frames', 'frame durations', 'fps', 'frame timeline'],
  cpu: ['cpu load', 'runqueue latency', 'cpu frequency', 'thread hotspots'],
  binder: ['binder call latency', 'thread blocking', 'lock contention'],
  memory: ['heap usage', 'gc pauses', 'allocation spikes', 'lmk events'],
  startup: ['cold start duration', 'main thread blocking', 'io latency'],
  interaction: ['input latency', 'dispatch delay', 'response time'],
  anr: ['anr traces', 'blocked main thread', 'binder waits'],
  system: ['thermal throttling', 'io stalls', 'system_server workload'],
};

// =============================================================================
// Analysis Result
// =============================================================================

export interface AnalysisResult {
  sessionId: string;
  success: boolean;
  findings: Finding[];
  hypotheses: Hypothesis[];
  conclusion: string;
  confidence: number;
  rounds: number;
  totalDurationMs: number;
}

// =============================================================================
// Analysis Options (passed from route layer)
// =============================================================================

export interface AnalysisOptions {
  traceProcessorService?: any;
  packageName?: string;
  timeRange?: { start: number | string; end: number | string };
  /**
   * Optional ADB collaboration configuration.
   * - off: do not use ADB
   * - auto: enable read-only only when trace↔device match is confident
   * - read_only/full: explicit opt-in regardless of match
   */
  adb?: AdbCollaborationConfig;
  /**
   * Resolved ADB context (computed at runtime, best-effort).
   * Tools can use this for gating and device selection.
   */
  adbContext?: AdbContext;

  /**
   * Parameters resolved from follow-up queries
   * Contains enriched params (frame_id with start_ts/end_ts, etc.)
   * populated by resolveFollowUp()
   */
  resolvedFollowUpParams?: Record<string, any>;

  /**
   * Pre-built focus intervals for drill-down follow-ups
   * These bypass the normal interval extraction and go directly to per-interval stages
   */
  prebuiltIntervals?: FocusInterval[];

  /**
   * Optional strategy hint (computed by registry match) for hypothesis-driven planning.
   * When default loop mode prefers hypothesis+experiments, we still surface the best-matching
   * strategy so the planner can reuse its structure without forcing the deterministic pipeline.
   */
  suggestedStrategy?: {
    id: string;
    name: string;
    confidence?: number;
    matchMethod?: 'keyword' | 'llm' | 'none';
    reasoning?: string;
  };
}

// =============================================================================
// First-Turn Analysis Plan Types
// =============================================================================

export type AnalysisPlanMode =
  | 'strategy'
  | 'hypothesis'
  | 'clarify'
  | 'compare'
  | 'extend'
  | 'drill_down';

export interface AnalysisPlanStep {
  order: number;
  title: string;
  action: string;
}

export interface AnalysisPlanStrategyHint {
  id: string;
  name: string;
  confidence?: number;
  selectionMethod?: 'keyword' | 'llm' | 'none';
}

export interface AnalysisPlanPayload {
  mode: AnalysisPlanMode;
  objective: string;
  steps: AnalysisPlanStep[];
  evidence: string[];
  hypothesisPolicy: 'after_first_evidence';
  strategy?: AnalysisPlanStrategyHint;
}

// =============================================================================
// Typed Event Payloads (compile-time safety for new events)
// =============================================================================

export interface StreamingEventPayloads {
  degraded: { module: string; fallback: string; error?: string };
  stage_transition: {
    stageIndex: number;
    totalStages: number;
    stageName: string;
    intervalCount: number;
    skipped?: boolean;
    skipReason?: string;
  };
  circuit_breaker: { agentId: string; reason: string };
  conclusion: { sessionId: string; summary: string; confidence: number; rounds: number };
  finding: { round: number; findings: Finding[] };
  error: { message: string };

  // New intervention-related events
  intervention_required: InterventionRequiredPayload;
  intervention_resolved: InterventionResolvedPayload;
  intervention_timeout: InterventionTimeoutPayload;

  // Strategy selection events
  strategy_selected: StrategySelectedPayload;
  strategy_fallback: StrategyFallbackPayload;

  // SQL generation events
  sql_generated: SQLGeneratedPayload;
  sql_validation_failed: SQLValidationFailedPayload;

  // Focus tracking events
  focus_updated: FocusUpdatedPayload;
  incremental_scope: IncrementalScopePayload;
}

// =============================================================================
// Intervention Event Payloads
// =============================================================================

/**
 * Payload for intervention_required event
 */
export interface InterventionRequiredPayload {
  interventionId: string;
  type: 'low_confidence' | 'ambiguity' | 'timeout' | 'agent_request' | 'circuit_breaker' | 'validation_required';
  options: InterventionOptionPayload[];
  context: {
    confidence: number;
    elapsedTimeMs: number;
    roundsCompleted: number;
    progressSummary: string;
    triggerReason: string;
    findingsCount: number;
  };
  timeout: number;
}

export interface InterventionOptionPayload {
  id: string;
  label: string;
  description: string;
  action: 'continue' | 'focus' | 'abort' | 'custom' | 'select_option';
  recommended?: boolean;
}

/**
 * Payload for intervention_resolved event
 */
export interface InterventionResolvedPayload {
  interventionId: string;
  action: string;
  sessionId: string;
  directive?: {
    action: 'continue' | 'focus' | 'abort' | 'restart';
    reason: string;
  };
}

/**
 * Payload for intervention_timeout event
 */
export interface InterventionTimeoutPayload {
  interventionId: string;
  sessionId: string;
  defaultAction: string;
  timeoutMs: number;
}

// =============================================================================
// Strategy Selection Event Payloads
// =============================================================================

/**
 * Payload for strategy_selected event
 */
export interface StrategySelectedPayload {
  strategyId: string;
  strategyName: string;
  confidence: number;
  reasoning: string;
  selectionMethod: 'llm' | 'keyword' | 'default';
}

/**
 * Payload for strategy_fallback event
 */
export interface StrategyFallbackPayload {
  reason: string;
  candidatesEvaluated: number;
  topCandidateConfidence?: number;
  fallbackTo: 'hypothesis_driven' | 'default_strategy';
}

// =============================================================================
// SQL Generation Event Payloads
// =============================================================================

/**
 * Payload for sql_generated event
 */
export interface SQLGeneratedPayload {
  sql: string;
  explanation: string;
  riskLevel: 'safe' | 'moderate' | 'high';
  objective: string;
  agentId: string;
}

/**
 * Payload for sql_validation_failed event
 */
export interface SQLValidationFailedPayload {
  sql: string;
  errors: string[];
  agentId: string;
}

// =============================================================================
// Focus Tracking Event Payloads
// =============================================================================

/**
 * Payload for focus_updated event
 */
export interface FocusUpdatedPayload {
  focusType: 'entity' | 'timeRange' | 'metric' | 'question';
  target: {
    entityType?: string;
    entityId?: string;
    timeRange?: { start: string; end: string };
    metricName?: string;
    question?: string;
  };
  weight: number;
  interactionType: string;
}

/**
 * Payload for incremental_scope event
 */
export interface IncrementalScopePayload {
  scopeType: 'entity' | 'timeRange' | 'question' | 'full';
  entitiesCount: number;
  timeRangesCount: number;
  isExtension: boolean;
  reason: string;
  relevantAgents: string[];
}

type StreamingEventType = StreamingUpdate['type'];

/**
 * Resolves the payload type for a given event type.
 * Typed events get compile-time safety; untyped events fall back to `any`.
 */
export type PayloadFor<T extends StreamingEventType> =
  T extends keyof StreamingEventPayloads ? StreamingEventPayloads[T] : any;

// =============================================================================
// Progress Emitter (decouples EventEmitter from sub-modules)
// =============================================================================

export interface ProgressEmitter {
  emitUpdate<T extends StreamingEventType>(type: T, content: PayloadFor<T>): void;
  log(message: string): void;
}

// =============================================================================
// Analysis Services (aggregate dependency — reduces God Dependency on ModelRouter)
// =============================================================================

import type { EmittedEnvelopeRegistry } from './emittedEnvelopeRegistry';

export interface AnalysisServices {
  modelRouter: ModelRouter;
  messageBus: AgentMessageBus;
  circuitBreaker: CircuitBreaker;
  /** Session-scoped registry for deduplicating emitted DataEnvelopes */
  emittedEnvelopeRegistry?: EmittedEnvelopeRegistry;
}

// =============================================================================
// Execution Context (immutable context passed to executors)
// =============================================================================

export interface ExecutionContext {
  query: string;
  sessionId: string;
  traceId: string;
  intent: Intent;
  initialHypotheses: Hypothesis[];
  sharedContext: SharedAgentContext;
  options: AnalysisOptions;
  /**
   * Session-scoped multi-turn context (v2.0).
   * Provides access to durable per-trace state (EntityStore, FocusStore-derived state, TraceAgentState).
   */
  sessionContext?: EnhancedSessionContext;
  /**
   * Incremental analysis scope hint (v2.0).
   * When present, executors should prefer analyzing only what is new/relevant
   * instead of re-running full analysis on every turn.
   */
  incrementalScope?: IncrementalScope;
  config: AgentDrivenOrchestratorConfig;
}

// =============================================================================
// Executor Result (accumulated output from any executor)
// =============================================================================

import type { CapturedEntities } from './entityCapture';

/**
 * Intervention request from executor for orchestrator to handle.
 * When set, the orchestrator will pause execution and request user intervention.
 */
export interface InterventionRequest {
  type: 'low_confidence' | 'ambiguity' | 'timeout' | 'agent_request';
  reason: string;
  confidence: number;
  possibleDirections: Array<{
    id: string;
    description: string;
    confidence: number;
  }>;
  progressSummary: string;
  elapsedTimeMs: number;
  roundsCompleted: number;
}

export interface ExecutorResult {
  findings: Finding[];
  lastStrategy: StrategyDecision | null;
  confidence: number;
  informationGaps: string[];
  rounds: number;
  stopReason: string | null;

  /**
   * Captured entities from this execution (frames, sessions).
   * Applied to EntityStore by orchestrator after execution.
   */
  capturedEntities?: CapturedEntities;

  /**
   * Entity IDs that were analyzed in this execution.
   * Used to mark entities as analyzed in EntityStore for extend support.
   */
  analyzedEntityIds?: {
    frames?: string[];
    sessions?: string[];
  };

  /**
   * Intervention request from executor (v2.0).
   * When set, orchestrator will pause and wait for user decision before proceeding.
   */
  interventionRequest?: InterventionRequest;

  /**
   * Indicates whether execution was paused due to intervention.
   * The orchestrator can resume with user's directive when this is true.
   */
  pausedForIntervention?: boolean;
}

// =============================================================================
// Utility
// =============================================================================

export function normalizeDomain(domain: string): string {
  const normalized = domain.toLowerCase();
  return DOMAIN_ALIASES[normalized] || normalized;
}

export function concludeDecision(confidence: number, reasoning: string): StrategyDecision {
  return { strategy: 'conclude', confidence, reasoning };
}

export function translateStrategy(strategy: string): string {
  const translations: Record<string, string> = {
    'continue': '继续分析',
    'deep_dive': '深入分析',
    'pivot': '转向新方向',
    'conclude': '生成结论',
  };
  return translations[strategy] || strategy;
}
