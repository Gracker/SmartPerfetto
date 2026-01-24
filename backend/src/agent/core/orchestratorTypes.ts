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
}

// =============================================================================
// Typed Event Payloads (compile-time safety for new events)
// =============================================================================

export interface StreamingEventPayloads {
  degraded: { module: string; fallback: string; error?: string };
  stage_transition: { stageIndex: number; totalStages: number; stageName: string; intervalCount: number };
  circuit_breaker: { agentId: string; reason: string };
  conclusion: { sessionId: string; summary: string; confidence: number; rounds: number };
  finding: { round: number; findings: Finding[] };
  error: { message: string };
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

export interface AnalysisServices {
  modelRouter: ModelRouter;
  messageBus: AgentMessageBus;
  circuitBreaker: CircuitBreaker;
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
  config: AgentDrivenOrchestratorConfig;
}

// =============================================================================
// Executor Result (accumulated output from any executor)
// =============================================================================

export interface ExecutorResult {
  findings: Finding[];
  lastStrategy: StrategyDecision | null;
  confidence: number;
  informationGaps: string[];
  rounds: number;
  stopReason: string | null;
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
