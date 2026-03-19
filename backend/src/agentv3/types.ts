import type { ArchitectureInfo } from '../agent/detectors/types';
import type { Finding } from '../agent/types';
import type { DetectedFocusApp } from './focusAppDetector';
import type { SceneType } from './sceneClassifier';

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
}

// =============================================================================
// Planning Types (P0-1: Explicit planning capability)
// =============================================================================

/** A phase in Claude's analysis plan, submitted via submit_plan tool. */
export interface PlanPhase {
  id: string;
  name: string;
  goal: string;
  /** Expected tool names this phase will use (for adherence tracking) */
  expectedTools: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  completedAt?: number;
  /** Reasoning summary provided when completing/skipping this phase (P2-1) */
  summary?: string;
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

/** Record of a tool call for plan adherence tracking. */
export interface ToolCallRecord {
  toolName: string;
  timestamp: number;
  /** Phase ID this tool call was matched to (if any) */
  matchedPhaseId?: string;
}

// =============================================================================
// Analysis Pattern Memory Types (P2-2: Long-term memory)
// =============================================================================

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
