// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Agent Protocol Types
 *
 * Phase 2: Agent-ification with Skills as Tools
 *
 * This file defines the core types for the AI Agents system.
 * Agents wrap existing Skills as "tools" they can invoke through AI reasoning.
 */

import { Finding } from '../types';
import { DataEnvelope } from '../../types/dataContract';

/**
 * Result from tool execution
 */
export interface AgentToolResult {
  success: boolean;
  data?: any;
  findings?: Finding[];
  error?: string;
  executionTimeMs: number;
  /** Layered result data from skill execution */
  layeredResult?: any;
  /** DataEnvelope(s) for SSE data events */
  dataEnvelopes?: DataEnvelope[];
  /** Optional metadata for debugging/tracking (e.g., dynamic SQL details) */
  metadata?: Record<string, any>;
}

// =============================================================================
// Hypothesis Types
// =============================================================================

/**
 * A hypothesis about the performance issue
 */
export interface Hypothesis {
  /** Unique hypothesis ID */
  id: string;
  /** Hypothesis description */
  description: string;
  /** Confidence level (0-1) */
  confidence: number;
  /** Status */
  status: 'proposed' | 'investigating' | 'confirmed' | 'rejected';
  /** Evidence supporting this hypothesis */
  supportingEvidence: Evidence[];
  /** Evidence against this hypothesis */
  contradictingEvidence: Evidence[];
  /** Agent that proposed this hypothesis */
  proposedBy: string;
  /** Agents relevant to investigating this hypothesis */
  relevantAgents?: string[];
  /** Timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/**
 * Evidence for or against a hypothesis
 */
export interface Evidence {
  /** Evidence ID */
  id: string;
  /** Description of the evidence */
  description: string;
  /** Source (finding ID, tool result, etc.) */
  source: string;
  /** Type of evidence */
  type: 'finding' | 'metric' | 'observation' | 'inference';
  /** Strength of evidence (0-1) */
  strength: number;
  /** Timestamp of the evidence */
  timestamp?: number;
}

// =============================================================================
// Agent Response Types
// =============================================================================

/**
 * Response from an agent after completing a task
 */
export interface AgentResponse {
  /** Agent ID that produced this response */
  agentId: string;
  /** Task ID this response is for */
  taskId: string;
  /** Whether the task was successful */
  success: boolean;
  /** Findings discovered */
  findings: Finding[];
  /** Hypothesis updates */
  hypothesisUpdates?: HypothesisUpdate[];
  /** Questions for other agents */
  questionsForAgents?: InterAgentQuestion[];
  /** Suggestions for further investigation */
  suggestions?: string[];
  /** Confidence in the response */
  confidence: number;
  /** Execution time in ms */
  executionTimeMs: number;
  /** Raw data from tool executions */
  toolResults?: AgentToolResult[];
  /** Reasoning trace */
  reasoning?: ReasoningStep[];
}

/**
 * Update to a hypothesis
 */
export interface HypothesisUpdate {
  hypothesisId: string;
  action: 'support' | 'contradict' | 'confirm' | 'reject' | 'update_confidence';
  evidence?: Evidence;
  newConfidence?: number;
  reason: string;
}

/**
 * Question from one agent to another
 */
export interface InterAgentQuestion {
  /** From agent */
  fromAgent: string;
  /** Target agent */
  toAgent: string;
  /** Question */
  question: string;
  /** Context for the question */
  context?: Record<string, any>;
  /** Priority */
  priority: number;
}

/**
 * A step in the agent's reasoning process
 */
export interface ReasoningStep {
  step: number;
  type: 'observation' | 'analysis' | 'decision' | 'action';
  content: string;
  confidence: number;
  timestamp: number;
}
