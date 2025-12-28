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
 * Base SSE event
 */
export interface SSEEvent {
  type: string;
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
  };
}

export type AnalysisSSEEvent =
  | SQLGeneratedEvent
  | SQLExecutedEvent
  | StepCompletedEvent
  | AnalysisCompletedEvent
  | ErrorEvent
  | ProgressEvent;

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
