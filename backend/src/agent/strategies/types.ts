/**
 * Staged Analysis Strategy Types
 *
 * Defines the generic Strategy Pattern interfaces for multi-stage analysis.
 * Each strategy declares:
 * - A trigger function (when to activate)
 * - A sequence of stages with task templates
 * - Optional interval extraction logic between stages
 */

import { AgentResponse } from '../types/agentProtocol';

// =============================================================================
// Focus Interval
// =============================================================================

/**
 * A time interval identified during analysis that subsequent stages should focus on.
 * Extracted from earlier stage results (e.g., scroll sessions with jank frames).
 */
export interface FocusInterval {
  /** Unique identifier within this analysis session */
  id: number;
  /** Target process/package name */
  processName: string;
  /** Range start in nanoseconds (string to preserve precision for values > 2^53) */
  startTs: string;
  /** Range end in nanoseconds (string to preserve precision for values > 2^53) */
  endTs: string;
  /** Priority for analysis ordering (higher = analyze first) */
  priority: number;
  /** Human-readable label for this interval */
  label?: string;
  /** Additional metadata from interval extraction */
  metadata?: Record<string, any>;
}

// =============================================================================
// Helper Interface (passed to extractIntervals)
// =============================================================================

/**
 * Utility functions available to extractIntervals implementations.
 * These are injected by the orchestrator so strategies don't import from it.
 */
export interface IntervalHelpers {
  /** Convert columnar { columns, rows } payload to array of row objects */
  payloadToObjectRows: (payload: any) => Array<Record<string, any>>;
  /** Heuristic: does this look like an app process (not system daemon)? */
  isLikelyAppProcessName: (name: string) => boolean;
  /** Format ns range as human-readable relative time label */
  formatNsRangeLabel: (startTs: string | number, endTs: string | number, referenceNs?: string | number) => string;
}

// =============================================================================
// Stage Task Template
// =============================================================================

/**
 * A template for generating AgentTasks within a stage.
 * The orchestrator expands these into concrete tasks based on scope and intervals.
 */
export interface StageTaskTemplate {
  /** Which agent to dispatch to (e.g., 'frame_agent', 'cpu_agent') */
  agentId: string;
  /** Domain label for context (e.g., 'frame', 'cpu') */
  domain: string;
  /** Scope determines task multiplicity:
   *  - 'global': one task for the entire trace
   *  - 'per_interval': one task per FocusInterval */
  scope: 'global' | 'per_interval';
  /** Task priority (lower number = higher priority) */
  priority?: number;
  /** Evidence types this task should collect */
  evidenceNeeded?: string[];
  /** Restrict agent to specific tools */
  focusTools?: string[];
  /** Parameters passed through to skill execution */
  skillParams?: Record<string, any>;
  /** Task description template. Supports {{scopeLabel}} placeholder */
  descriptionTemplate: string;

  /**
   * Execution mode for this task:
   * - 'agent' (default): dispatches to full agent LLM loop
   * - 'direct_skill': bypasses agent, executes skill directly (zero LLM overhead for deterministic SQL)
   */
  executionMode?: 'agent' | 'direct_skill';
  /** Skill ID to execute when executionMode is 'direct_skill' */
  directSkillId?: string;
  /**
   * Maps interval fields to skill parameter names.
   * Keys are skill param names, values are interval field names or special values:
   * - 'startTs' / 'endTs' / 'processName': from FocusInterval
   * - 'duration': computed as endTs - startTs
   */
  paramMapping?: Record<string, string>;
}

// =============================================================================
// Direct Skill Task (built from per_interval templates with executionMode: 'direct_skill')
// =============================================================================

/**
 * A concrete task for DirectSkillExecutor - one per (template × interval) pair.
 */
export interface DirectSkillTask {
  /** The template that generated this task */
  template: StageTaskTemplate;
  /** The focus interval this task targets */
  interval: FocusInterval;
  /** Pre-built scope label for display */
  scopeLabel: string;
}

// =============================================================================
// Stage Definition
// =============================================================================

/**
 * A single stage in a multi-stage analysis strategy.
 */
export interface StageDefinition {
  /** Stage identifier (e.g., 'overview', 'interval_metrics') */
  name: string;
  /** Human-readable description of this stage's purpose */
  description: string;
  /** Progress message template. Supports {{stageIndex}}/{{totalStages}} */
  progressMessageTemplate: string;
  /** Task templates to generate for this stage */
  tasks: StageTaskTemplate[];
  /**
   * Extract focus intervals from this stage's responses.
   * Only needed for "discovery" stages that identify intervals for later stages.
   */
  extractIntervals?: (
    responses: AgentResponse[],
    helpers: IntervalHelpers
  ) => FocusInterval[];
  /**
   * Check whether to stop the pipeline early after this stage.
   * For example, if no intervals were found.
   */
  shouldStop?: (intervals: FocusInterval[]) => { stop: boolean; reason: string };
}

// =============================================================================
// Strategy Definition
// =============================================================================

/**
 * A complete staged analysis strategy.
 * Encapsulates all domain-specific knowledge for a particular analysis scenario.
 */
export interface StagedAnalysisStrategy {
  /** Unique strategy identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Determines if this strategy should handle the given query */
  trigger: (query: string) => boolean;
  /** Ordered sequence of analysis stages */
  stages: StageDefinition[];
  /** Default configuration values for this strategy */
  defaults?: Record<string, any>;
}

// =============================================================================
// Strategy Execution State
// =============================================================================

/**
 * Runtime state tracked during strategy execution.
 * Maintained by the orchestrator as it progresses through stages.
 */
export interface StrategyExecutionState {
  /** Which strategy is running */
  strategyId: string;
  /** Current stage index (0-based) */
  currentStageIndex: number;
  /** Focus intervals discovered so far */
  focusIntervals: FocusInterval[];
  /** Accumulated confidence from agent responses */
  confidence: number;
}
