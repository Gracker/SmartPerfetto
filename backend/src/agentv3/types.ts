// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ArchitectureInfo } from '../agent/detectors/types';
import type { Finding } from '../agent/types';
import type { DetectedFocusApp } from './focusAppDetector';
import type { SceneType } from './sceneClassifier';
import type { OutputLanguage } from './outputLanguage';
import type { CodeAwareMode } from '../services/codebase/codeAwareFeature';

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
  /** Structured Perfetto UI selection, when present. Used to keep scoped slice/range lookups lightweight. */
  selectionContext?: SelectionContext;
  /** Whether a reference trace is loaded for comparison */
  hasReferenceTrace: boolean;
  /** Whether prior turns have produced findings (drill-down context) */
  hasExistingFindings: boolean;
  /** Whether the session already has a full analysis in a prior turn */
  hasPriorFullAnalysis: boolean;
  /** Recent user queries in this session, oldest to newest. Used by semantic intent classification. */
  previousQueries?: string[];
  /** Compact recent finding summaries from the same recent window as previousQueries. */
  previousFindings?: string[];
}

export interface SqlSchemaEntry {
  id: string;
  name: string;
  category: string;
  type: 'function' | 'view' | 'table' | 'table_function' | 'macro' | string;
  description: string;
  /** Perfetto stdlib module that defines this symbol, when known. */
  module?: string;
  /** INCLUDE statement required to load the defining module. */
  include?: string;
  /** Direct module includes declared by the defining stdlib module. */
  moduleIncludes?: string[];
  /** Transitive module includes resolved from stdlib docs / pfsql lineage. */
  transitiveIncludes?: string[];
  /** Tags emitted by upstream stdlib_docs.json. */
  tags?: string[];
  /** Source SQL file path relative to the repo root, when known. */
  sourcePath?: string;
  /** Legacy/generated source SQL file path relative to its source root, when known. */
  filePath?: string;
  /** SQL module or metric dependencies required before this entity is queryable. */
  dependencies?: string[];
  /** Metric SQL path that must be materialized before querying this metric-created entity. */
  requiredMetric?: string;
  /** Ready-to-run setup statement for metric-created entities. */
  setupSql?: string;
  /** Column definitions for tables/views (when available in the schema index) */
  columns?: Array<{ name: string; type?: string; description?: string }>;
  /** Parameter definitions for functions (when available in the schema index) */
  params?: Array<{ name: string; type?: string; description?: string }>;
  returnType?: string;
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
  /** Background-only case library hints; must be evidence-verified before use */
  caseBackgroundContext?: string;
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
  /** Detected trace OS — determines knowledge injection and SQL dialect */
  traceOs?: 'android' | 'harmonyos' | 'unknown';
  /** Detected trace format */
  traceFormat?: 'perfetto_protobuf' | 'systrace_text' | 'atrace_text' | 'unknown';
  /** User-facing output language for answers, reports, and insight text. */
  outputLanguage?: OutputLanguage;
  /** Codebase-aware analysis mode for source lookup and output discipline. */
  codeAwareMode?: CodeAwareMode;
  /** Explicitly whitelisted codebase ids for this session. */
  codebaseIds?: string[];
}

// =============================================================================
// Comparison Context (dual-trace analysis)
// =============================================================================

/** Discriminator for which trace data belongs to in comparison mode. */
export type TraceSource = 'current' | 'reference';

export type TracePaneSide = 'left' | 'right' | 'top' | 'bottom';

export type TracePairLayout = 'horizontal' | 'vertical';

export interface TracePairPaneContext {
  side: TracePaneSide;
  traceSide: TraceSource;
  traceId: string;
  traceName?: string;
  traceFingerprint?: string;
  active?: boolean;
  visualState?: 'live' | 'context_only';
}

export interface TracePairContext {
  schemaVersion: 1;
  layout: TracePairLayout;
  primarySide: TracePaneSide;
  referenceSide: TracePaneSide;
  activeSide?: TracePaneSide;
  workspaceOpen?: boolean;
  splitPercent?: number;
  maximizedTraceSide?: TraceSource;
  minimizedTraceSides?: TraceSource[];
  aliases?: Record<string, TraceSource>;
  panes: TracePairPaneContext[];
}

/** Context for dual-trace comparison mode. Orthogonal to scene type. */
export interface ComparisonContext {
  referenceTraceId: string;
  tracePairContext?: TracePairContext;
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

/** Area selection — user marked a time or track range in Perfetto, or the UI used the current viewport as a range scope. */
export interface AreaSelectionContext {
  kind: 'area';
  source?: 'area_selection' | 'visible_window';
  startNs: number;
  endNs: number;
  durationNs?: number;
  tracks?: SelectionTrackInfo[];
  trackCount?: number;
}

/** Single slice selection — user clicked a slice in the timeline. */
export interface TrackEventSelectionContext {
  kind: 'track_event';
  source?: 'track_event_selection';
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
  utid?: number;
  upid?: number;
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
  /** For skill-like tools such as `invoke_skill` and `compare_skill`, the required skillId. */
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
   * Optional structured matchers for calls that need a specific skillId.
   * These narrow matching for the same tool name (for example, only
   * `invoke_skill(startup_slow_reasons)`), while `expectedTools` can still
   * declare generic support tools such as `execute_sql` or `fetch_artifact`.
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
 * expectations. `expectedCalls` narrows matching for the same tool name,
 * while `expectedTools` can still declare generic support tools such as
 * `execute_sql` or `fetch_artifact`. Tool names are normalised by stripping
 * the MCP prefix on both sides.
 */
function shortToolName(toolName: string): string {
  const MCP_PREFIX = 'mcp__smartperfetto__';
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
}

const INFORMATIONAL_TOOL_NAMES = new Set([
  'lookup_strategy_detail',
  // Persists reasoning across turns; it does not collect trace evidence and
  // cannot stand in for producing the final report.
  'write_analysis_note',
]);

export function isInformationalToolName(toolName: string): boolean {
  return INFORMATIONAL_TOOL_NAMES.has(shortToolName(toolName));
}

export function isEvidenceCapableToolName(toolName: string): boolean {
  return !isInformationalToolName(toolName);
}

const ATTRIBUTION_SUPPORT_SKILL_IDS = new Set([
  // Identity resolution supports the current phase after the process gate reports
  // ambiguous/blocked identity, but it must not satisfy the phase's key skill.
  'process_identity_resolver',
]);

export function formatExpectedCall(call: ExpectedCall): string {
  const tool = shortToolName(call.tool);
  return call.skillId ? `${tool}(${call.skillId})` : tool;
}

export function expectedCallMatchesRecord(call: ExpectedCall, record: ToolCallRecord): boolean {
  if (record.success === false) return false;
  const shortTool = shortToolName(record.toolName);
  if (!isEvidenceCapableToolName(call.tool) || !isEvidenceCapableToolName(shortTool)) return false;
  if (shortToolName(call.tool) !== shortTool) return false;
  if (call.skillId && call.skillId !== record.skillId) return false;
  return true;
}

export function phaseMatchesExpectedCall(phase: PlanPhase, record: ToolCallRecord): boolean {
  return (phase.expectedCalls ?? []).some(call => expectedCallMatchesRecord(call, record));
}

export function phaseMatchesCall(phase: PlanPhase, record: ToolCallRecord): boolean {
  if (record.success === false) return false;
  const shortTool = shortToolName(record.toolName);
  if (!isEvidenceCapableToolName(shortTool)) return false;
  const expectedToolSet = new Set(phase.expectedTools.map(shortToolName));
  const structuredCallsForTool = (phase.expectedCalls ?? [])
    .filter(call => shortToolName(call.tool) === shortTool);
  if (structuredCallsForTool.length > 0) {
    if (shortTool === 'invoke_skill' &&
      record.skillId &&
      ATTRIBUTION_SUPPORT_SKILL_IDS.has(record.skillId) &&
      expectedToolSet.has(shortTool)) {
      return true;
    }
    return structuredCallsForTool.some(call => {
      if (call.skillId && call.skillId !== record.skillId) return false;
      return true;
    });
  }
  return expectedToolSet.has(shortTool);
}

/** Flatten a phase's expectations to plain tool names for log/UI rendering. */
export function expectedToolNames(phase: PlanPhase): string[] {
  const structured = (phase.expectedCalls ?? [])
    .map(formatExpectedCall);
  const structuredTools = new Set((phase.expectedCalls ?? []).map(c => shortToolName(c.tool)));
  const generic = phase.expectedTools
    .map(shortToolName)
    .filter(tool => !structuredTools.has(tool));
  return [...structured, ...generic];
}

/** Record of a tool call for plan adherence tracking. */
export interface ToolCallRecord {
  toolName: string;
  timestamp: number;
  /** Explicit execution outcome when the runtime result exposed one. Failed calls remain auditable but never satisfy evidence gates. */
  success?: boolean;
  /** True only when a source lookup returned at least one locatable CodeRef; no source content is persisted here. */
  returnedCodeReferences?: boolean;
  /** Phase ID this tool call was matched to (if any) */
  matchedPhaseId?: string;
  /**
   * One-line, human-readable digest of the tool's input. Used by plan
   * adherence checks to confirm the *right* call was made, not just any call
   * with the right tool name (e.g. distinguishing different `invoke_skill`
   * targets).
   */
  inputSummary?: string;
  /** For skill-like tools: the skillId argument, lifted out for direct matching. */
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

export type PatternStatusMigrationSource = 'legacy_frozen' | 'native_v2';

/**
 * Provenance fields linking an entry to the run that produced it.
 * Per-turn primary key allows future feedback to map back to the right entry
 * without ambiguity when a session has multiple turns.
 */
export interface PatternProvenance {
  analysisRunId?: string;
  sessionId?: string;
  turnIndex?: number;
  /** Enterprise scope for learned memory isolation. */
  sourceTenantId?: string;
  sourceWorkspaceId?: string;
  sourceRunId?: string;
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
  /** Deprecated effective-state mirror for compatibility with older readers. */
  status?: PatternStatus;
  /** Lifecycle state owned by creation and auto-confirm, never by feedback. */
  intrinsicStatus?: PatternStatus;
  /** Reversible state derived from active FeedbackEvent rows. */
  feedbackProjectionStatus?: PatternStatus;
  /** Whether intrinsic state was frozen from legacy storage or created native. */
  migrationSource?: PatternStatusMigrationSource;
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
  /** Deprecated effective-state mirror for compatibility with older readers. */
  status?: PatternStatus;
  intrinsicStatus?: PatternStatus;
  feedbackProjectionStatus?: PatternStatus;
  migrationSource?: PatternStatusMigrationSource;
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
  readonly id: string;
  /** Immutable claim whose original causal meaning is resolved by status. */
  readonly statement: string;
  status: HypothesisStatus;
  /** What observation or data prompted this hypothesis */
  basis?: string;
  /** Evidence for confirmation/rejection */
  evidence?: string;
  readonly formedAt: number;
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
  severity: 'warning' | 'error' | 'info';
  message: string;
}
