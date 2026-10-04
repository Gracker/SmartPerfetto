// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
