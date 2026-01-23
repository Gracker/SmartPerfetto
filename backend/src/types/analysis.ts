/**
 * Analysis System Type Definitions
 *
 * Core types for the AI-powered trace analysis system
 */

// ============================================================================
// Enums
// ============================================================================

/**
 * Analysis state machine states
 */
export enum AnalysisState {
  IDLE = 'idle',
  GENERATING_SQL = 'generating_sql',
  EXECUTING_SQL = 'executing_sql',
  VALIDATING_RESULT = 'validating_result',
  RETRYING = 'retrying',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * SQL execution result status
 */
export enum SQLResultStatus {
  SUCCESS = 'success',
  SYNTAX_ERROR = 'syntax_error',
  RUNTIME_ERROR = 'runtime_error',
  EMPTY_RESULT = 'empty_result',
  TIMEOUT = 'timeout',
}

/**
 * Result completeness evaluation
 */
export enum CompletenessLevel {
  INSUFFICIENT = 'insufficient',  // Need more data
  PARTIAL = 'partial',            // Have some data but need more
  COMPLETE = 'complete',          // Fully answered
  UNCERTAIN = 'uncertain',        // AI cannot determine
}

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Query result from trace processor
 */
export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  durationMs: number;
  error?: string;
  status?: SQLResultStatus;
}

/**
 * Single message in conversation history
 */
export interface AnalysisMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  sql?: string;
  queryResult?: QueryResult;
  stepNumber?: number;
}

/**
 * Collected SQL result with AI insight
 */
export interface CollectedResult {
  sql: string;
  result: QueryResult;
  insight: string;
  timestamp: number;
  stepNumber: number;
}

/**
 * Analysis session - stores full conversation and state
 */
export interface AnalysisSession {
  id: string;
  traceId: string;
  userId?: string;
  status: AnalysisState;
  createdAt: Date;
  updatedAt: Date;

  // Original question
  question: string;

  // Conversation history
  messages: AnalysisMessage[];

  // Current loop state
  currentIteration: number;
  maxIterations: number;

  // Accumulated analysis results
  collectedResults: CollectedResult[];

  // Final answer (when completed)
  finalAnswer?: string;

  // Error (if failed)
  error?: string;

  // Progress tracking
  stepsCompleted: number;
  totalSteps?: number;

  // Skill Engine result (for HTML report generation)
  skillEngineResult?: {
    skillId: string;
    skillName: string;
    sections: Record<string, any>;
    diagnostics: Array<{
      id: string;
      severity: string;
      message: string;
      suggestions?: string[];
    }>;
    vendor?: string;
    executionTimeMs: number;
    directAnswer?: string;
    summary?: string;
    questionType?: string;
    answerConfidence?: 'high' | 'medium' | 'low';
    layeredResult?: any;
  };
}

/**
 * Request to create a new analysis session
 */
export interface CreateAnalysisRequest {
  traceId: string;
  question: string;
  userId?: string;
  maxIterations?: number;
}

/**
 * Request to add a follow-up question
 */
export interface FollowupRequest {
  question: string;
}

/**
 * Session status response
 */
export interface SessionStatusResponse {
  sessionId: string;
  traceId: string;
  status: AnalysisState;
  currentIteration: number;
  maxIterations: number;
  currentStep?: string;
  progress: {
    current: number;
    total?: number;
  };
  messages: AnalysisMessage[];
  finalAnswer?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Final analysis result
 */
export interface AnalysisResult {
  sessionId: string;
  answer: string;
  sqlQueries: Array<{
    sql: string;
    result: QueryResult;
    insight: string;
  }>;
  steps: Array<{
    stepNumber: number;
    type: string;
    content: string;
    timestamp: number;
  }>;
  metrics: {
    totalDuration: number;
    iterationsCount: number;
    sqlQueriesCount: number;
  };
}

// ============================================================================
// SSE Event Types
// ============================================================================

/**
 * SSE Event Type Enum
 *
 * Centralized definition of all SSE event types to avoid string literals
 * scattered across the codebase. This improves type safety and makes
 * refactoring easier.
 *
 * Usage:
 *   import { SSEEventType } from '../types/analysis';
 *   emitSSE(sessionId, { type: SSEEventType.PROGRESS, ... });
 */
export enum SSEEventType {
  // === Connection Events ===
  CONNECTED = 'connected',

  // === Progress Events ===
  PROGRESS = 'progress',

  // === SQL Events ===
  SQL_GENERATED = 'sql_generated',
  SQL_EXECUTED = 'sql_executed',

  // === Step Events ===
  STEP_COMPLETED = 'step_completed',

  // === Skill Events ===
  SKILL_SECTION = 'skill_section',
  SKILL_DIAGNOSTICS = 'skill_diagnostics',
  SKILL_LAYERED_RESULT = 'skill_layered_result',
  /** @deprecated Use SKILL_LAYERED_RESULT instead */
  SKILL_DATA = 'skill_data',

  // === Agent Events ===
  WORKER_THOUGHT = 'worker_thought',
  THOUGHT = 'thought',
  FINDING = 'finding',
  CONCLUSION = 'conclusion',

  // === Circuit Breaker Events ===
  CIRCUIT_BREAKER = 'circuit_breaker',

  // === Terminal Events ===
  ANALYSIS_COMPLETED = 'analysis_completed',
  ERROR = 'error',

  // === v2.0 DataEnvelope Events ===
  DATA = 'data',
}

/**
 * Streaming update types from AgentDrivenOrchestrator
 * These are internal event types before SSE conversion
 */
export enum StreamingUpdateType {
  PROGRESS = 'progress',
  FINDING = 'finding',
  SKILL_LAYERED_RESULT = 'skill_layered_result',
  /** @deprecated Use SKILL_LAYERED_RESULT instead. Will be removed in v3.0 */
  SKILL_DATA = 'skill_data',
  DATA = 'data',
  CONCLUSION = 'conclusion',
  ERROR = 'error',
  WORKER_THOUGHT = 'worker_thought',
  THOUGHT = 'thought',
}

/**
 * Base SSE event
 */
export interface SSEEvent {
  type: SSEEventType | string;  // Allow string for backward compatibility
  timestamp: number;
  data: any;
}

/**
 * SQL generated event
 */
export interface SQLGeneratedEvent extends SSEEvent {
  type: 'sql_generated';
  data: {
    stepNumber: number;
    sql: string;
    explanation?: string;
  };
}

/**
 * SQL executed event
 */
export interface SQLExecutedEvent extends SSEEvent {
  type: 'sql_executed';
  data: {
    stepNumber: number;
    sql: string;
    result: QueryResult;
  };
}

/**
 * Step completed event
 */
export interface StepCompletedEvent extends SSEEvent {
  type: 'step_completed';
  data: {
    stepNumber: number;
    stepType: string;
    content: string;
  };
}

/**
 * Analysis completed event
 */
export interface AnalysisCompletedEvent extends SSEEvent {
  type: 'analysis_completed';
  data: {
    sessionId: string;
    answer: string;
    metrics: {
      totalDuration: number;
      iterationsCount: number;
      sqlQueriesCount: number;
    };
    reportUrl?: string;  // URL to detailed HTML report
  };
}

/**
 * Error event
 */
export interface ErrorEvent extends SSEEvent {
  type: 'error';
  data: {
    stepNumber?: number;
    error: string;
    recoverable: boolean;
  };
}

/**
 * Progress update event
 */
export interface ProgressEvent extends SSEEvent {
  type: 'progress';
  data: {
    current?: number;
    total?: number;
    step?: string;      // Step name (e.g., 'generating_sql', 'executing_sql')
    message: string;
    // Extended fields for agent/worker thought events
    agent?: string;     // Agent name (e.g., 'AnalysisWorker', 'planner', 'evaluator')
    skillId?: string;   // Skill being executed
  };
}

/**
 * Skill section event - emits data for each skill analysis step
 */
export interface SkillSectionEvent extends SSEEvent {
  type: 'skill_section';
  data: {
    sectionId: string;
    sectionTitle: string;
    sectionIndex: number;
    totalSections: number;
    columns: string[];
    rows: any[][];
    rowCount: number;
    sql?: string;
  };
}

/**
 * Skill diagnostics event - emits diagnostic results from skill analysis
 */
export interface SkillDiagnosticsEvent extends SSEEvent {
  type: 'skill_diagnostics';
  data: {
    diagnostics: Array<{
      id: string;
      severity: string;
      message: string;
      suggestions?: string[];
    }>;
  };
}

/**
 * Skill layered result event - emits interactive layered view results
 */
export interface SkillLayeredResultEvent extends SSEEvent {
  type: 'skill_layered_result';
  data: {
    result: {
      layers: {
        overview?: Record<string, any>;
        list?: Record<string, any>;
        session?: Record<string, Record<string, any>>;
        deep?: Record<string, Record<string, any>>;
      };
      defaultExpanded: ('overview' | 'list' | 'session' | 'deep')[];
      metadata: {
        skillName: string;
        version: string;
        executedAt: string;
      };
      /** Root cause conclusion (Phase 4) */
      conclusion?: {
        category: 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';
        component: string;
        confidence: number;
        summary: string;
        evidence: string[];
        suggestion?: string;
      };
    };
    summary?: string;
  };
}

export interface DataEvent extends SSEEvent {
  type: SSEEventType.DATA | 'data';
  data: {
    id?: string;
    envelope: any;
    timestamp?: number;
  };
}

export type AnalysisSSEEvent =
  | SQLGeneratedEvent
  | SQLExecutedEvent
  | StepCompletedEvent
  | AnalysisCompletedEvent
  | ErrorEvent
  | ProgressEvent
  | SkillSectionEvent
  | SkillDiagnosticsEvent
  | SkillLayeredResultEvent
  | DataEvent;

// ============================================================================
// Orchestrator Types
// ============================================================================

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  maxIterations: number;
  sqlTimeout: number;
  aiService: 'openai' | 'claude' | 'deepseek';
  enableRetry: boolean;
  enableAutoEvaluation: boolean;
}

/**
 * SQL fix strategy
 */
export interface SQLFixStrategy {
  errorType: string;
  canFix: boolean;
  fixPrompt: (error: string, sql: string) => string;
}

/**
 * Result evaluation
 */
export interface ResultEvaluation {
  completeness: CompletenessLevel;
  confidence: number;  // 0-1
  needsMoreData: boolean;
  suggestedNextSteps?: string[];
}

/**
 * AI response for SQL generation
 */
export interface AISQLResponse {
  sql: string;
  explanation: string;
  thoughts?: string;
  skillEngineResult?: {
    skillId: string;
    skillName: string;
    sections: Record<string, any>;
    diagnostics: Array<{
      id: string;
      severity: string;
      message: string;
      suggestions?: string[];
    }>;
    vendor?: string;
    executionTimeMs: number;
    // v2 skill engine 新增字段
    directAnswer?: string;
    summary?: string;
    questionType?: string;
    // 分层结果
    layeredResult?: {
      layers: {
        overview?: Record<string, any>;
        list?: Record<string, any>;
        session?: Record<string, Record<string, any>>;
        deep?: Record<string, Record<string, any>>;
      };
      defaultExpanded: ('overview' | 'list' | 'session' | 'deep')[];
      metadata: {
        skillName: string;
        version: string;
        executedAt: string;
      };
    };
    answerConfidence?: 'high' | 'medium' | 'low';
    // 事件流
    executionEvents?: Array<{
      type: string;
      timestamp: number;
      skillId: string;
      stepId?: string;
      data?: any;
    }>;
    eventSummary?: {
      totalEvents: number;
      totalDurationMs: number;
      completedSteps: number;
      failedSteps: number;
      hasAICall: boolean;
      aiCallCount: number;
    };
  };
}

/**
 * AI response for result evaluation
 */
export interface AIEvaluationResponse {
  isSufficient: boolean;
  confidence: string;
  reasoning: string;
  needsMoreData: boolean;
}

// ============================================================================
// Root Cause Classification Types (Phase 4)
// ============================================================================

/**
 * Problem category classification
 */
export type ProblemCategory = 'APP' | 'SYSTEM' | 'MIXED' | 'UNKNOWN';

/**
 * Problem component classification
 */
export type ProblemComponent =
  | 'MAIN_THREAD'
  | 'RENDER_THREAD'
  | 'SURFACE_FLINGER'
  | 'BINDER'
  | 'CPU_SCHEDULING'
  | 'CPU_AFFINITY'
  | 'GPU'
  | 'MEMORY'
  | 'IO'
  | 'MAIN_THREAD_BLOCKING'
  | 'UNKNOWN';

/**
 * Root cause conclusion from analysis
 * This is the structured output from root_cause_classification steps
 */
export interface RootCauseConclusion {
  /** Problem category: APP / SYSTEM / MIXED */
  category: ProblemCategory;
  /** Specific component responsible for the issue */
  component: ProblemComponent;
  /** Confidence score 0-1 */
  confidence: number;
  /** Human-readable summary of the root cause */
  summary: string;
  /** Evidence supporting the conclusion */
  evidence: string[];
  /** Suggested optimization or fix */
  suggestion?: string;
}

/**
 * Layered result with optional conclusion
 * Enhanced to support Phase 4 root cause classification
 */
export interface LayeredResultWithConclusion {
  layers: {
    overview?: Record<string, any>;
    list?: Record<string, any>;
    session?: Record<string, Record<string, any>>;
    deep?: Record<string, Record<string, any>>;
  };
  defaultExpanded: ('overview' | 'list' | 'session' | 'deep')[];
  metadata: {
    skillName: string;
    version: string;
    executedAt: string;
  };
  /** Root cause conclusion from analysis (Phase 4) */
  conclusion?: RootCauseConclusion;
}
