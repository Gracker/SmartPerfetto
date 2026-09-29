// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Orchestrator Types
 *
 * Shared runtime contracts: the IOrchestrator interface, analysis
 * options/results, streaming payloads, and the progress emitter.
 */

import type { Finding, StreamingUpdate } from '../types';
import type { Hypothesis } from '../types/agentProtocol';
import type { SmartScenePreviewPayload } from '../scene/types';
import type { AdbCollaborationConfig, AdbContext } from '../../services/adb';
import type { ConclusionContract } from './conclusionContract';
import type { ClaimSupportV1 } from '../../types/evidenceContract';
import type { ClaimVerificationResult } from '../../types/claimVerification';
import type { IdentityResolutionV1 } from '../../types/identityContract';
import type { CodeAwareMode } from '../../services/codebase/codeAwareFeature';
import type { AnalysisReceipt, UiActionProposalV1 } from '../../types/dataContract';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import type {AnalysisTurnIntent} from '../../agentRuntime/analysisTurnIntent';
import type {
  AnalysisCompletion,
  AnalysisDeliveryAssurance,
  AnalysisOutputOrigin,
  AnalysisRuntimeAppendix,
  FinalReportAssessment,
} from '../../types/analysisDelivery';

// =============================================================================
// IOrchestrator — Shared interface for ClaudeRuntime and OpenAIRuntime
// =============================================================================

/**
 * Minimal orchestrator contract that both runtime implementations satisfy.
 * Used in session management and route layers so SDK-specific implementations
 * stay behind the same backend contract.
 *
 * Runtime implementations extend EventEmitter and implement this interface.
 */
export interface IOrchestrator {
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  removeAllListeners(event?: string): this;
  analyze(query: string, sessionId: string, traceId: string, options?: AnalysisOptions): Promise<AnalysisResult>;
  reset(): void;
  /** Best-effort, idempotent cancellation for a specific in-flight session. */
  abortSession?(sessionId: string, referenceTraceId?: string): void | Promise<void>;
  /** Clean up all session-scoped state for a specific session (agentv3: artifacts, notes, session map). */
  cleanupSession?(sessionId: string): void;
  /** Historical focus-store hook. Guard with: typeof orchestrator.getFocusStore === 'function'. */
  getFocusStore?(): any;
  /** Optional focus-tracking hook for frontend interaction capture. */
  recordUserInteraction?(interaction: any): void;
  /** SDK session ID for runtimes that expose one. */
  getSdkSessionId?(sessionId: string, referenceTraceId?: string): string | undefined;
  /**
   * @deprecated P1-7: Dead code — sessionMap is loaded from `claude_session_map.json` at construction.
   * Kept for backward compatibility but never called from route layer.
   */
  restoreSessionMapping?(sessionId: string, sdkSessionId: string, referenceTraceId?: string): void;
  /** Restore a cached architecture result from persistence (agentv3). */
  restoreArchitectureCache?(traceId: string, architecture: any): void;
  /** Get cached architecture for persistence (agentv3). */
  getCachedArchitecture?(traceId: string): any;
  /** P1-R3: Get session analysis notes for report generation (agentv3). */
  getSessionNotes?(sessionId: string): any[];
  /** P1-R3: Get current session analysis plan for report generation (agentv3). */
  getSessionPlan?(sessionId: string): any;
  /** P1-R3: Get session uncertainty flags for report generation (agentv3). */
  getSessionUncertaintyFlags?(sessionId: string): any[];
  /** Take a unified snapshot of all session state for atomic persistence (agentv3). */
  takeSnapshot?(sessionId: string, traceId: string, sessionFields: any): any;
  /** Restore all session state from a unified snapshot (agentv3). */
  restoreFromSnapshot?(sessionId: string, traceId: string, snapshot: any): void;
}

// =============================================================================
// Analysis Result
// =============================================================================

export type AnalysisTerminationReason =
  | 'max_turns'
  | 'max_budget_usd'
  | 'max_structured_output_retries'
  | 'execution_error'
  | 'timeout'
  | 'quality_gate_failed'
  | 'plan_incomplete'
  /** A delivered answer whose review stop did not settle in time; stored unverified. */
  | 'review_not_finished';

export interface AnalysisResult {
  sessionId: string;
  success: boolean;
  findings: Finding[];
  hypotheses: Hypothesis[];
  conclusion: string;
  /** Server-owned metadata. Deserializing these fields does not attest a new turn. */
  turnIntent?: AnalysisTurnIntent;
  completion?: AnalysisCompletion;
  outputOrigin?: AnalysisOutputOrigin;
  runtimeAppendix?: AnalysisRuntimeAppendix;
  reportAssessment?: FinalReportAssessment;
  investigationAssessment?: import('../../types/analysisInvestigationAssessment').FinalInvestigationAssessment;
  /** Product-finalized timeline. Stored copies carry historical checks only. */
  sceneTimeline?: import('../scene/sceneTimelineContract').SceneTimelineAssessment;
  sceneReport?: import('../../types/sceneTimeline').SceneReportReference;
  deliveryAssurance?: AnalysisDeliveryAssurance;
  conclusionContract?: ConclusionContract;
  claimSupport?: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
  sourceUseDecision?: import('../../services/codebase/sourceUseDecision').SourceUseDecisionV1;
  sourceReferences?: import('../../services/codebase/sourceUseDecision').SourceReferenceV1[];
  sourceClaimVerificationResult?: import('../../services/codebase/sourceClaimVerifier').SourceClaimVerificationResult;
  identityResolutions?: IdentityResolutionV1[];
  confidence: number;
  rounds: number;
  totalDurationMs: number;
  /** True when the result is usable but incomplete (for example SDK max-turn exhaustion). */
  partial?: boolean;
  terminationReason?: AnalysisTerminationReason;
  terminationMessage?: string;
  /** Structured Smart Stage1 preview for the frontend main chat surface. */
  smartScenePreview?: SmartScenePreviewPayload;
  /** User-visible quick-mode run receipt. Metadata only; never claim support evidence. */
  quickRun?: QuickRunReceipt;
  analysisReceipt?: AnalysisReceipt;
  uiActionProposals?: UiActionProposalV1[];
}

export type AgentRuntimeAnalysisResult = AnalysisResult;

// =============================================================================
// Analysis Options (passed from route layer)
// =============================================================================

export interface AnalysisOptions {
  /** Internal, run-scoped attribution sink. Never sourced from request JSON. */
  runManifestAttributionSink?: RunManifestAttributionSink;
  /** Request/session-pinned presentation language. */
  outputLanguage?: import('../../agentv3/outputLanguage').OutputLanguage;
  traceProcessorService?: any;
  packageName?: string;
  timeRange?: { start: number | string; end: number | string };
  /** Optional per-task timeout override (ms) */
  taskTimeoutMs?: number;
  /**
   * Optional ADB collaboration configuration.
   * - off: do not use ADB
   * - auto: enable read-only only when trace↔device match is confident
   * - read_only/full: explicit opt-in regardless of match
   */
  adb?: AdbCollaborationConfig;
  /**
   * Resolved ADB context (computed at runtime, best-effort).
   * Tools can use this for gating and device selection.
   */
  adbContext?: AdbContext;

  /**
   * Optional strategy deny-list enforced by the route layer: matched
   * strategies in this list are treated as no-match.
   */
  blockedStrategyIds?: string[];

  /**
   * User's Perfetto UI selection context (area range or single slice).
   * Passed from the frontend so the analysis can be scoped to the selected region.
   */
  selectionContext?: import('../../agentv3/types').SelectionContext;

  /**
   * Reference trace ID for comparison mode.
   * When provided, enables dual-trace analysis with comparison-specific MCP tools.
   */
  referenceTraceId?: string;

  tracePairContext?: import('../../agentv3/types').TracePairContext;

  /**
   * Analysis mode override from UI/CLI.
   * - 'fast': force quick path (target 5 turns, hard-cap protected)
   * - 'full': force full pipeline (verifier, optional sub-agents)
   * - 'auto' or undefined: defer to queryComplexityClassifier
   */
  analysisMode?: 'fast' | 'full' | 'auto';
  /** Internal surface hint; dedicated conversation routes never accept this from request JSON. */
  assistantSurface?: 'conversation';
  /** Whether the dedicated conversation has a real Trace attached. */
  conversationTraceAttached?: boolean;
  /** UI/backend preset selector. Smart preset is dispatched by route layer. */
  preset?: 'smart';

  /** Provider override for this analysis session. When set, env vars are sourced
   *  from this provider instead of the global active provider. */
  providerId?: string | null;

  /**
   * Code-aware analysis mode for registered local/app source.
   * - off: do not expose codebase MCP tools
   * - metadata_only: expose CodeRef metadata, never snippets
   * - provider_send: snippets may be sent only when the codebase consent also permits it
   */
  codeAwareMode?: CodeAwareMode;
  /** Explicit codebase allowlist for this analysis session. */
  codebaseIds?: string[];
  /** Explicit external knowledge-source allowlist for this analysis session. */
  knowledgeSourceIds?: string[];
  /** Internal source phase and optional hard tool budget. */
  sourceUsePolicy?: {
    phase: 'explicit' | 'automatic_enrichment' | 'deep_enrichment';
    maxSearchCalls?: number;
    maxReadCalls?: number;
    maxDurationMs?: number;
  };
  /** Internal non-secret partition for source/RAG capability continuity. */
  analysisContextFingerprint?: string;
  /** Internal immutable public Knowledge Pack identity pinned to this session. */
  androidInternalsPackPin?: import('../../services/androidInternalsPack/types').AndroidInternalsPackIdentity;

  /**
   * Enterprise persistence scope supplied by the route layer.
   * These fields are internal to backend runtime persistence and are not accepted
   * directly from untrusted request bodies.
   */
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  runId?: string;

  /**
   * Pre-queried trace datasets from the frontend (populated by quick-action buttons).
   * Injected into the AI prompt as Markdown tables so the AI can analyze immediately
   * without spending turns on basic SQL queries.
   */
  traceContext?: TraceDataset[];
}

/** A pre-queried dataset sent from the frontend alongside the analysis request. */
export interface TraceDataset {
  label: string;
  columns: string[];
  rows: unknown[][];
  evidenceRefId?: string;
  sourceToolCallId?: string;
  queryHash?: string;
  traceSide?: 'current' | 'reference';
  paneSide?: import('../../agentv3/types').TracePaneSide;
  traceId?: string;
}

export type QuickRunRequestedMode = 'fast' | 'auto' | 'full';
export type QuickRunResolvedMode = 'quick' | 'full';
export type QuickRunProfile = 'normal' | 'extended' | 'triage';
export type QuickRunBudgetEnforcement = 'turn_cap' | 'timeout_only' | 'not_available';
export type QuickRunStopReason =
  | 'answered'
  | 'needs_full'
  | 'extended_answered'
  | 'hard_cap'
  | 'timeout'
  | 'partial';
export type QuickRunVerifierStatus = 'passed' | 'issues' | 'not_checked' | 'failed';

export interface QuickRunTurnBudget {
  targetTurns: number;
  hardCapTurns: number;
  extended: boolean;
  enforcement: QuickRunBudgetEnforcement;
}

export interface QuickRunEvidenceCounts {
  frontendPrequeryInjected: number;
  frontendPrequeryCited: number;
  currentRunDataEnvelopes: number;
  citedEvidenceRefs: number;
}

export interface QuickRunContextInjectedCounts {
  conversationTurns: number;
  recentSqlResults: number;
  sqlPitfallPairs: number;
  patternHints: number;
  negativePatternHints: number;
  caseBackgroundCases: number;
}

export interface QuickRunReceipt {
  requestedMode: QuickRunRequestedMode;
  resolvedMode: QuickRunResolvedMode;
  profile: QuickRunProfile;
  targetTurns: number;
  hardCapTurns: number;
  actualTurns: number;
  elapsedMs: number;
  enforcement: QuickRunBudgetEnforcement;
  stopReason: QuickRunStopReason;
  evidence: QuickRunEvidenceCounts;
  contextInjected: QuickRunContextInjectedCounts;
  verifierStatus: QuickRunVerifierStatus;
  /**
   * How the mode was decided. `ai_unavailable` means `full` was a fallback
   * because classification could not run — a misconfigured light model pins
   * every question to full, and that failure is otherwise invisible in a
   * delivered run. Carries no provider, model, or usage detail.
   */
  modeDecision?: 'hard_rule' | 'ai' | 'ai_unavailable';
  adaptiveRouting?: import('../../types/adaptiveRouting').AdaptiveRoutingReceiptV1;
}

// =============================================================================
// First-Turn Analysis Plan Types
// =============================================================================

export type AnalysisPlanMode =
  | 'strategy'
  | 'hypothesis'
  | 'clarify'
  | 'compare'
  | 'extend'
  | 'drill_down';

export interface AnalysisPlanStep {
  order: number;
  title: string;
  action: string;
}

export interface AnalysisPlanStrategyHint {
  id: string;
  name: string;
  confidence?: number;
  selectionMethod?: 'keyword' | 'llm' | 'none';
}

export interface AnalysisPlanPayload {
  mode: AnalysisPlanMode;
  objective: string;
  steps: AnalysisPlanStep[];
  evidence: string[];
  hypothesisPolicy: 'after_first_evidence';
  strategy?: AnalysisPlanStrategyHint;
}

// =============================================================================
// Typed Event Payloads (compile-time safety for new events)
// =============================================================================

export interface StreamingEventPayloads {
  degraded: {
    module: string;
    fallback: string;
    error?: string;
    message?: string;
    partial?: boolean;
    terminationReason?: AnalysisTerminationReason;
  };
  answer_token: AnswerTokenPayload;
  answer_segment_reset: {runId: string; attempt: number};
  stage_transition: {
    stageIndex: number;
    totalStages: number;
    stageName: string;
    intervalCount: number;
    skipped?: boolean;
    skipReason?: string;
  };
  circuit_breaker: { agentId: string; reason: string };
  conclusion: { sessionId: string; summary: string; confidence: number; rounds: number };
  finding: { round: number; findings: Finding[] };
  error: { message: string };

  // Strategy selection events
  strategy_selected: StrategySelectedPayload;
  strategy_fallback: StrategyFallbackPayload;

  // SQL generation events
  sql_generated: SQLGeneratedPayload;
  sql_validation_failed: SQLValidationFailedPayload;

  // Focus tracking events
  focus_updated: FocusUpdatedPayload;
  incremental_scope: IncrementalScopePayload;
}

// =============================================================================
// Strategy Selection Event Payloads
// =============================================================================

/**
 * Payload for strategy_selected event
 */
export interface StrategySelectedPayload {
  strategyId: string;
  strategyName: string;
  confidence: number;
  reasoning: string;
  selectionMethod: 'llm' | 'keyword' | 'default';
}

/**
 * Payload for strategy_fallback event
 */
export interface StrategyFallbackPayload {
  reason: string;
  candidatesEvaluated: number;
  topCandidateConfidence?: number;
  fallbackTo: 'hypothesis_driven' | 'default_strategy';
}

// =============================================================================
// SQL Generation Event Payloads
// =============================================================================

/**
 * Payload for sql_generated event
 */
export interface SQLGeneratedPayload {
  sql: string;
  explanation: string;
  riskLevel: 'safe' | 'moderate' | 'high';
  objective: string;
  agentId: string;
}

/**
 * Payload for sql_validation_failed event
 */
export interface SQLValidationFailedPayload {
  sql: string;
  errors: string[];
  agentId: string;
}

// =============================================================================
// Focus Tracking Event Payloads
// =============================================================================

/**
 * Payload for focus_updated event
 */
export interface FocusUpdatedPayload {
  focusType: 'entity' | 'timeRange' | 'metric' | 'question';
  target: {
    entityType?: string;
    entityId?: string;
    timeRange?: { start: string; end: string };
    metricName?: string;
    question?: string;
  };
  weight: number;
  interactionType: string;
}

/**
 * Payload for incremental_scope event
 */
export interface IncrementalScopePayload {
  scopeType: 'entity' | 'timeRange' | 'question' | 'full';
  entitiesCount: number;
  timeRangesCount: number;
  isExtension: boolean;
  reason: string;
  relevantAgents: string[];
}

/**
 * Payload for answer_token event: display-only answer draft text. Runtimes
 * with draft streaming stamp each token with its run and segment (see
 * agentRuntime/answerDraftStream.ts); tokens without them are not forwarded.
 */
export interface AnswerTokenPayload {
  token?: string;
  done?: boolean;
  totalChars?: number;
  runId?: string;
  attempt?: number;
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
