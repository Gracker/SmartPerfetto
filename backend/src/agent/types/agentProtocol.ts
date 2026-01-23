/**
 * SmartPerfetto Agent Protocol Types
 *
 * Phase 2: Agent-ification with Skills as Tools
 *
 * This file defines the core types for the AI Agents system.
 * Agents wrap existing Skills as "tools" they can invoke through AI reasoning.
 */

import { Finding } from '../types';
import { SkillDefinition, SkillExecutionResult, SkillExecutor } from '../../services/skillEngine';
import { DataEnvelope } from '../../types/dataContract';

// =============================================================================
// Agent Tool Types
// =============================================================================

/**
 * AgentTool - Wraps a Skill as a tool that an Agent can invoke
 *
 * Instead of replacing Skills, we wrap them as tools that Agents can reason about
 * and decide when to invoke.
 */
export interface AgentTool {
  /** Unique tool name */
  name: string;
  /** Human-readable description for LLM to understand when to use this tool */
  description: string;
  /** Optional skill ID this tool maps to */
  skillId?: string;
  /** Tool category for organization */
  category: 'frame' | 'cpu' | 'memory' | 'binder' | 'startup' | 'interaction' | 'system' | 'general';
  /** Required parameters */
  parameters?: AgentToolParameter[];
  /** Execute the tool */
  execute: (params: Record<string, any>, context: AgentToolContext) => Promise<AgentToolResult>;
}

/**
 * Tool parameter definition
 */
export interface AgentToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp' | 'duration' | 'array';
  required: boolean;
  description: string;
  default?: any;
}

/**
 * Context passed to tools during execution
 */
export interface AgentToolContext {
  sessionId: string;
  traceId: string;
  traceProcessorService?: any;
  /** AI service for AI-powered tools */
  aiService?: {
    chat: (prompt: string) => Promise<string>;
  };
  /** Package name being analyzed */
  packageName?: string;
  /** Time range for analysis */
  timeRange?: {
    start: number;
    end: number;
  };
  /** Additional context data */
  additionalContext?: Record<string, any>;
}

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
}

// =============================================================================
// Agent Task Types
// =============================================================================

/**
 * Task assigned to an agent
 */
export interface AgentTask {
  /** Unique task ID */
  id: string;
  /** Task description */
  description: string;
  /** Agent ID to handle this task */
  targetAgentId: string;
  /** Priority (1 = highest) */
  priority: number;
  /** Task context */
  context: AgentTaskContext;
  /** Dependencies - task IDs that must complete first */
  dependencies: string[];
  /** Task timeout in ms */
  timeout?: number;
  /** Created timestamp */
  createdAt: number;
}

/**
 * Context for a task
 */
export interface AgentTaskContext {
  /** Original user query */
  query: string;
  /** Parsed intent */
  intent?: {
    primaryGoal: string;
    aspects: string[];
  };
  /** Domain of the task */
  domain?: string;
  /** Evidence or metrics required */
  evidenceNeeded?: string[];
  /** Hypothesis to investigate */
  hypothesis?: Hypothesis;
  /** Time range to focus on */
  timeRange?: {
    start: number;
    end: number;
  };
  /** Previous findings relevant to this task */
  relevantFindings?: Finding[];
  /** Additional context data */
  additionalData?: Record<string, any>;
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

// =============================================================================
// Agent Configuration Types
// =============================================================================

/**
 * Base configuration for all agents
 */
export interface AgentConfig {
  /** Unique agent ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Agent domain */
  domain: string;
  /** Description of agent capabilities */
  description: string;
  /** Tools available to this agent */
  tools: AgentTool[];
  /** Maximum iterations for reasoning loop */
  maxIterations: number;
  /** Confidence threshold for conclusions */
  confidenceThreshold: number;
  /** Whether this agent can delegate to other agents */
  canDelegate: boolean;
  /** Agents this agent can delegate to */
  delegateTo?: string[];
}

// =============================================================================
// Agent Message Bus Types
// =============================================================================

/**
 * Message sent between agents
 */
export interface AgentMessage {
  /** Unique message ID */
  id: string;
  /** Message type */
  type: 'task' | 'response' | 'question' | 'broadcast' | 'event';
  /** Sender agent ID */
  from: string;
  /** Recipient agent ID (or 'all' for broadcast) */
  to: string;
  /** Message payload */
  payload: any;
  /** Correlation ID for request-response patterns */
  correlationId?: string;
  /** Priority */
  priority: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Broadcast message to all agents
 */
export interface BroadcastMessage {
  /** Message type */
  type: 'hypothesis_proposed' | 'evidence_found' | 'conclusion_reached' | 'focus_shift';
  /** Payload */
  payload: any;
  /** Sender agent ID */
  from: string;
  /** Timestamp */
  timestamp: number;
}

// =============================================================================
// Shared Context Types
// =============================================================================

/**
 * Shared context accessible by all agents in a session
 */
export interface SharedAgentContext {
  /** Session ID */
  sessionId: string;
  /** Trace ID */
  traceId: string;
  /** All proposed hypotheses */
  hypotheses: Map<string, Hypothesis>;
  /** Confirmed findings from all agents */
  confirmedFindings: Finding[];
  /** Current focus time range */
  focusedTimeRange?: {
    start: number;
    end: number;
  };
  /** Investigation path - trace of agent interactions */
  investigationPath: InvestigationStep[];
  /** Global metrics and statistics */
  globalMetrics?: Record<string, any>;
  /** User-provided context */
  userContext?: Record<string, any>;
}

/**
 * A step in the investigation path
 */
export interface InvestigationStep {
  stepNumber: number;
  agentId: string;
  action: string;
  timestamp: number;
  result: 'success' | 'partial' | 'failed';
  summary: string;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an AgentTool from a SkillDefinition
 */
export function createToolFromSkill(
  skill: SkillDefinition,
  category: AgentTool['category'],
  executor: (skillId: string, params: Record<string, any>, context: AgentToolContext) => Promise<SkillExecutionResult>
): AgentTool {
  return {
    name: `analyze_${skill.name.replace(/_/g, '_')}`,
    description: skill.meta?.description || `Execute ${skill.name} analysis`,
    skillId: skill.name,
    category,
    parameters: skill.inputs?.map((input: any) => ({
      name: input.name,
      type: input.type as any,
      required: input.required,
      description: input.description || `Parameter ${input.name}`,
      default: input.default,
    })),
    execute: async (params, context) => {
      const startTime = Date.now();
      try {
        const result = await executor(skill.name, params, context);

        // Extract data from displayResults or rawResults
        let data: any = null;
        if (result.displayResults && result.displayResults.length > 0) {
          data = {};
          for (const dr of result.displayResults) {
            data[dr.stepId] = dr.data;
          }
        } else if (result.rawResults) {
          data = {};
          for (const [stepId, stepResult] of Object.entries(result.rawResults)) {
            data[stepId] = stepResult.data;
          }
        }

        // Extract findings from diagnostics
        const findings: Finding[] = [];
        if (result.diagnostics && result.diagnostics.length > 0) {
          for (const diag of result.diagnostics) {
            findings.push({
              id: `${skill.name}_${Date.now()}_${findings.length}`,
              category: category,
              severity: diag.severity,
              title: diag.diagnosis,
              description: diag.suggestions?.join('; ') || diag.diagnosis,
              source: skill.name,
              confidence: typeof diag.confidence === 'number' ? diag.confidence : 0.8,
              details: diag.evidence,
            });
          }
        }

        const dataEnvelopes = SkillExecutor.toDataEnvelopes(result);

        return {
          success: result.success,
          data,
          findings,
          dataEnvelopes: dataEnvelopes.length > 0 ? dataEnvelopes : undefined,
          error: result.error,
          executionTimeMs: Date.now() - startTime,
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          executionTimeMs: Date.now() - startTime,
        };
      }
    },
  };
}

/**
 * Create a unique task ID
 */
export function createTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a unique hypothesis ID
 */
export function createHypothesisId(): string {
  return `hypo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a unique message ID
 */
export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
