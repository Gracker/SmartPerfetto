// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ArchitectureInfo } from '../agent/detectors/types';
import type { Finding } from '../agent/types';
import type { DetectedFocusApp } from './focusAppDetector';
import type { SceneType } from './sceneClassifier';
import type { OutputLanguage } from './outputLanguage';

// =============================================================================
// Query Complexity Classification
// =============================================================================

/** Query complexity level — determines which analysis pipeline to use. */
export type QueryComplexity = 'quick' | 'full';

/** Input signals for the complexity classifier. */
export interface ComplexityClassifierInput {
  query: string;
  /** Scene type already classified by keyword matcher */
  sceneType: SceneType;
  /** Whether user selected a time range or slice in Perfetto UI */
  hasSelectionContext: boolean;
  /** Whether a reference trace is loaded for comparison */
  hasReferenceTrace: boolean;
  /** Whether prior turns have produced findings (drill-down context) */
  hasExistingFindings: boolean;
  /** Whether the session already has a full analysis in a prior turn */
  hasPriorFullAnalysis: boolean;
}

export interface SqlSchemaEntry {
  id: string;
  name: string;
  category: string;
  type: 'function' | 'view' | 'table';
  description: string;
  /** Column definitions for tables/views (when available in the schema index) */
  columns?: Array<{ name: string; type?: string; description?: string }>;
  /** Parameter definitions for functions (when available in the schema index) */
  params?: Array<{ name: string; type?: string; description?: string }>;
}

export interface SqlSchemaIndex {
  version: string;
  generatedAt: string;
  templates: SqlSchemaEntry[];
}

/** Context assembled before calling Claude, injected into the system prompt. */
export interface ClaudeAnalysisContext {
  query: string;
  architecture?: ArchitectureInfo;
  packageName?: string;
  focusApps?: DetectedFocusApp[];
  /** Detection method used for focus apps — affects display labels */
  focusMethod?: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'none';
  previousFindings?: Finding[];
  conversationSummary?: string;
  /** Perfetto SQL knowledge context matched to the user query (from ExtendedSqlKnowledgeBase) */
  knowledgeBaseContext?: string;
  /** Compact entity context from previous turns for drill-down / clarify resolution */
  entityContext?: string;
  /** Classified scene type for progressive prompt disclosure */
  sceneType?: SceneType;
  /** Structured analysis notes persisted by Claude via write_analysis_note tool */
  analysisNotes?: AnalysisNote[];
  /** Names of available sub-agents (when sub-agent mode is enabled) */
  availableAgents?: string[];
  /** Past SQL error-fix pairs for in-context learning */
  sqlErrorFixPairs?: Array<{ errorSql: string; errorMessage: string; fixedSql: string }>;
  /** Cross-session analysis pattern context (P2-2: Long-term memory) */
  patternContext?: string;
  /** Cross-session negative pattern context (P1: 负面记忆) */
  negativePatternContext?: string;
  /** Previous turn's analysis plan for multi-turn context (P1-G12) */
  previousPlan?: AnalysisPlanV3;
  /** Recent plan history (max 3) for deeper cross-turn context (P1-B1) */
  planHistory?: AnalysisPlanV3[];
  /** User's Perfetto UI selection context — scopes analysis to a time range or single slice */
  selectionContext?: SelectionContext;
  /** Comparison mode — when present, a reference trace is available for dual-trace analysis */
  comparison?: ComparisonContext;
  /** Trace data completeness diagnosis — injected at session init, informs data gap guidance */
  traceCompleteness?: TraceCompleteness;
  /** User-facing output language for answers, reports, and insight text. */
  outputLanguage?: OutputLanguage;
}

// =============================================================================
// Comparison Context (dual-trace analysis)
// =============================================================================

/** Discriminator for which trace data belongs to in comparison mode. */
export type TraceSource = 'current' | 'reference';

/** Context for dual-trace comparison mode. Orthogonal to scene type. */
export interface ComparisonContext {
  referenceTraceId: string;
  referencePackageName?: string;
  referenceFocusApps?: DetectedFocusApp[];
  referenceArchitecture?: ArchitectureInfo;
  /** Intersection of stdlib capabilities available on both trace processors */
  commonCapabilities: string[];
  /** Capabilities available on only one side — informs Claude about analysis limitations */
  capabilityDiff?: { currentOnly: string[]; referenceOnly: string[] };
  /** Alignment anchor for cross-trace time normalization */
  compareAnchor?: CompareAnchor;
}

/** How to align time ranges between two traces for meaningful comparison. */
export interface CompareAnchor {
  /** Alignment strategy: by analysis phase, by user interaction window, or by relative time */
  type: 'phase' | 'interaction_window' | 'relative_time';
  currentRange?: { startNs: number; endNs: number };
  referenceRange?: { startNs: number; endNs: number };
}

// =============================================================================
// Trace Data Completeness (data source availability diagnosis)
// =============================================================================

/** Status of a single analysis capability's data availability. */
export type CapabilityStatus =
  | 'available'                    // Data present, analysis possible
  | 'missing_config_suspected'     // Schema missing or empty — likely trace config issue
  | 'not_applicable'               // Architecture/version mismatch — not a config issue
  | 'insufficient_or_scene_absent'; // Sparse data — short trace or scene didn't occur

/** A single capability probe result. */
export interface CapabilityProbeResult {
  id: string;
  displayName: string;
  status: CapabilityStatus;
  /** Primary table probed */
  primaryTable: string;
  /** Approximate row count (only when status is 'available' or 'insufficient_or_scene_absent') */
  rowEstimate?: number;
  /** Human-readable reason when not available */
  reason?: string;
}

/** Complete trace data availability diagnosis. */
export interface TraceCompleteness {
  /** Capabilities with data ready for analysis */
  available: CapabilityProbeResult[];
  /** Capabilities missing due to suspected config issues — actionable */
  missingConfig: CapabilityProbeResult[];
  /** Capabilities not applicable to this trace's architecture/version */
  notApplicable: CapabilityProbeResult[];
  /** Capabilities with sparse data — ambiguous cause */
  insufficient: CapabilityProbeResult[];
  /** Timestamp of diagnosis */
  diagnosedAt: number;
}

// =============================================================================
// User Selection Context (from Perfetto UI)
// Mirror types exist in perfetto/ui/.../com.smartperfetto.AIAssistant/types.ts.
// Keep both in sync when modifying.
// =============================================================================

/** Area selection — user pressed M key to mark a time range. */
export interface AreaSelectionContext {
  kind: 'area';
  startNs: number;
  endNs: number;
  durationNs?: number;
  tracks?: SelectionTrackInfo[];
  trackCount?: number;
}

/** Single slice selection — user clicked a slice in the timeline. */
export interface TrackEventSelectionContext {
  kind: 'track_event';
  trackUri?: string;
  eventId: number;
  ts: number;
  dur?: number;
  // Pre-queried metadata from frontend (avoids first SQL turn)
  name?: string;
  threadName?: string;
  processName?: string;
  depth?: number;
  childCount?: number;
}

/** Discriminated union: either an area or a single-slice selection from Perfetto UI. */
export type SelectionContext = AreaSelectionContext | TrackEventSelectionContext;

/** Human-readable metadata for a track in an area selection. */
export interface SelectionTrackInfo {
  uri: string;
  threadName?: string;
  processName?: string;
  tid?: number;
  pid?: number;
  cpu?: number;
  kind?: string;
}

/** A structured note written by Claude during analysis for cross-turn persistence. */
export interface AnalysisNote {
  section: 'hypothesis' | 'finding' | 'observation' | 'next_step';
  content: string;
  priority: 'high' | 'medium' | 'low';
  timestamp: number;
  /** In comparison mode, which trace this note pertains to (provenance tracking) */
  sourceTrace?: TraceSource;
}

// =============================================================================
// Planning Types (P0-1: Explicit planning capability)
// =============================================================================

/**
 * A more precise alternative to a bare tool-name match. When present on a
 * phase, the plan adherence matcher requires both the tool short-name AND
 * (when set) the matching `skillId`, so two `invoke_skill` calls targeting
 * different skills are no longer interchangeable.
 */
export interface ExpectedCall {
  /** Short tool name without the MCP prefix (e.g. `invoke_skill`, `execute_sql`). */
  tool: string;
  /** For `invoke_skill`, the required skillId. Other tools should leave this unset. */
  skillId?: string;
}

/** A phase in Claude's analysis plan, submitted via submit_plan tool. */
export interface PlanPhase {
  id: string;
  name: string;
  goal: string;
  /** Expected tool names this phase will use (for adherence tracking) */
  expectedTools: string[];
  /**
   * Optional structured matchers — preferred over `expectedTools` when set.
   * Lets a phase require a specific skillId for `invoke_skill` rather than
   * accepting any invocation. Phase 0.6 of the v2.1 refactor introduces
   * this; existing strategies continue to use `expectedTools` until they
   * opt in.
   */
  expectedCalls?: ExpectedCall[];
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  completedAt?: number;
  /** Reasoning summary provided when completing/skipping this phase (P2-1) */
  summary?: string;
}

/**
 * Agent-declared waiver for a scene-template mandatory aspect. The agent
 * uses this to opt out of an aspect (e.g. "trace lacks input timeline so
 * input event detection is impossible") with an explicit justification.
 * The hard-gate accepts the plan only when `reason` is substantial.
 */
export interface PlanAspectWaiver {
  aspectId: string;
  reason: string;
}

/** Structured analysis plan submitted by Claude before starting analysis. */
export interface AnalysisPlanV3 {
  phases: PlanPhase[];
  successCriteria: string;
  submittedAt: number;
  /** Tool calls matched to phases during execution */
  toolCallLog: ToolCallRecord[];
  /** History of plan revisions (P1-3: Dynamic replan) */
  revisionHistory?: PlanRevision[];
  /** Agent-declared waivers for mandatory plan-template aspects. */
  waivers?: PlanAspectWaiver[];
  /**
   * Mandatory aspects the agent failed to cover *and* did not waive after
   * the hard-gate gave up enforcing (max attempts reached). Surfaced by
   * `verifyPlanAdherence` as an error so the final verifier still flags
   * the gap rather than letting it disappear silently.
   */
  unresolvedAspects?: string[];
}

/** Record of a plan revision for audit trail. */
export interface PlanRevision {
  /** Timestamp of the revision */
  revisedAt: number;
  /** Why the plan was revised */
  reason: string;
  /** Snapshot of phases before revision */
  previousPhases: PlanPhase[];
}

/**
 * Predicate testing whether a logged tool call satisfies a phase's
 * expectations. `expectedCalls` (when set) trumps `expectedTools`; otherwise
 * the legacy "any call with the right tool name" semantics apply. Tool
 * names are normalised by stripping the MCP prefix on both sides.
 */
export function phaseMatchesCall(phase: PlanPhase, record: ToolCallRecord): boolean {
  const MCP_PREFIX = 'mcp__smartperfetto__';
  const shortTool = record.toolName.startsWith(MCP_PREFIX)
    ? record.toolName.slice(MCP_PREFIX.length)
    : record.toolName;
  if (phase.expectedCalls && phase.expectedCalls.length > 0) {
    return phase.expectedCalls.some(call => {
      if (call.tool !== shortTool) return false;
      if (call.skillId && call.skillId !== record.skillId) return false;
      return true;
    });
  }
  return phase.expectedTools.includes(shortTool);
}

/** Flatten a phase's expectations to plain tool names for log/UI rendering. */
export function expectedToolNames(phase: PlanPhase): string[] {
  if (phase.expectedCalls && phase.expectedCalls.length > 0) {
    return phase.expectedCalls.map(c => c.skillId ? `${c.tool}(${c.skillId})` : c.tool);
  }
  return phase.expectedTools;
}

/** Record of a tool call for plan adherence tracking. */
export interface ToolCallRecord {
  toolName: string;
  timestamp: number;
  /** Phase ID this tool call was matched to (if any) */
  matchedPhaseId?: string;
  /**
   * One-line, human-readable digest of the tool's input. Used by plan
   * adherence checks to confirm the *right* call was made, not just any call
   * with the right tool name (e.g. distinguishing different `invoke_skill`
   * targets).
   */
  inputSummary?: string;
  /** For `invoke_skill`: the skillId argument, lifted out for direct matching. */
  skillId?: string;
  /** sha256(input) prefix — stable identifier across runs for the same call. */
  paramsHash?: string;
}

// =============================================================================
// Analysis Pattern Memory Types (P2-2: Long-term memory)
// =============================================================================

/**
 * Lifecycle state of a pattern. Controls injection weight and whether the
 * pattern participates in supersede actions. Older entries that pre-date the
 * state machine implicitly behave as `confirmed` for backward compatibility.
 */
export type PatternStatus =
  | 'provisional'      // freshly saved, no feedback yet
  | 'confirmed'        // positive feedback OR auto-promoted after 24h without negatives
  | 'rejected'         // user explicitly rejected the conclusion
  | 'disputed'         // reverse feedback within 10s–24h window
  | 'disputed_late';   // reverse feedback >24h after first feedback

/**
 * Provenance fields linking an entry to the run that produced it.
 * Per-turn primary key allows future feedback to map back to the right entry
 * without ambiguity when a session has multiple turns.
 */
export interface PatternProvenance {
  analysisRunId?: string;
  sessionId?: string;
  turnIndex?: number;
  /** sha256 of trace file content (NOT the upload UUID — see scene/traceHash.ts). */
  traceContentHash?: string;
}

/** A persistent analysis pattern learned from previous sessions. */
export interface AnalysisPatternEntry {
  id: string;
  /** Trace feature fingerprint for similarity matching */
  traceFeatures: string[];
  /** Scene type of the analysis */
  sceneType: string;
  /** Key insights discovered */
  keyInsights: string[];
  /** Architecture type */
  architectureType?: string;
  /** Confidence of the original analysis */
  confidence: number;
  /** Timestamp of creation */
  createdAt: number;
  /** Number of times this pattern was matched */
  matchCount: number;
  /**
   * Stable failure-mode hash. Populated by the migration for historical
   * entries and by L1 pattern saving for new ones. Optional so older entries
   * on disk parse cleanly; injection logic treats absence as "unknown" and
   * skips cross-artifact deduplication.
   */
  failureModeHash?: string;
  /** Lifecycle state. Defaults to 'confirmed' when absent (legacy entries). */
  status?: PatternStatus;
  /** First feedback timestamp — used to choose the `disputed` vs `disputed_late` window. */
  firstFeedbackAt?: number;
  /** Most recent feedback timestamp. */
  lastFeedbackAt?: number;
  /** Provenance fields tying this entry to the originating run. */
  provenance?: PatternProvenance;
  /**
   * Bucket key for quota-fair eviction. Format depends on bucket type:
   * positive = `${sceneType}::${archType}::${domainHash}`,
   * negative = `${sceneType}::${archType}::${failureModeHash}`.
   */
  bucketKey?: string;
}

/** A negative pattern — records what strategies/approaches FAILED for similar traces. */
export interface NegativePatternEntry {
  id: string;
  /** Trace feature fingerprint for similarity matching */
  traceFeatures: string[];
  /** Scene type of the analysis */
  sceneType: string;
  /** What failed: specific strategy, tool, SQL pattern */
  failedApproaches: FailedApproach[];
  /** Architecture type */
  architectureType?: string;
  /** Timestamp of creation */
  createdAt: number;
  /** Number of times this negative pattern was matched */
  matchCount: number;
  /** Stable failure-mode hash. See AnalysisPatternEntry.failureModeHash. */
  failureModeHash?: string;
  /** Lifecycle state. Defaults to 'confirmed' when absent (legacy entries). */
  status?: PatternStatus;
  firstFeedbackAt?: number;
  lastFeedbackAt?: number;
  /** Provenance fields tying this entry to the originating run. */
  provenance?: PatternProvenance;
  /** Bucket key for quota-fair eviction (negative form: scene::arch::failureModeHash). */
  bucketKey?: string;
}

/** A specific approach that failed during analysis. */
export interface FailedApproach {
  /** Category: 'tool_failure' | 'strategy_failure' | 'verification_failure' | 'sql_error' */
  type: 'tool_failure' | 'strategy_failure' | 'verification_failure' | 'sql_error';
  /** What was attempted (tool name, SQL pattern, strategy description) */
  approach: string;
  /** Why it failed */
  reason: string;
  /** What worked instead (if known) */
  workaround?: string;
  /** Stable failure-mode hash for this specific approach (optional, see PR4). */
  failureModeHash?: string;
}

// =============================================================================
// Hypothesis Types (P0-G4: Explicit hypothesis-verify cycle)
// =============================================================================

/** Status of a hypothesis in the hypothesis-verify cycle. */
export type HypothesisStatus = 'formed' | 'confirmed' | 'rejected';

/** A structured hypothesis formed during analysis that must be resolved before concluding. */
export interface Hypothesis {
  id: string;
  /** The hypothesis statement (e.g., "RenderThread blocked by Binder causing jank") */
  statement: string;
  status: HypothesisStatus;
  /** What observation or data prompted this hypothesis */
  basis?: string;
  /** Evidence for confirmation/rejection */
  evidence?: string;
  formedAt: number;
  resolvedAt?: number;
}

// =============================================================================
// Uncertainty Flag Types (P1-G1: Mid-analysis human interaction)
// =============================================================================

/** An uncertainty flag raised by Claude during analysis when making assumptions. */
export interface UncertaintyFlag {
  /** What aspect Claude is uncertain about */
  topic: string;
  /** What assumption Claude is making to proceed */
  assumption: string;
  /** What question Claude would ask the user if it could */
  question: string;
  timestamp: number;
}

/** Result of conclusion verification (heuristic + optional LLM). */
export interface VerificationResult {
  passed: boolean;
  heuristicIssues: VerificationIssue[];
  llmIssues?: VerificationIssue[];
  durationMs: number;
}

export interface VerificationIssue {
  type: 'missing_evidence' | 'too_many_criticals' | 'known_misdiagnosis' | 'severity_mismatch' | 'missing_check' | 'plan_deviation' | 'missing_reasoning' | 'unresolved_hypothesis' | 'truncation';
  severity: 'warning' | 'error';
  message: string;
}
