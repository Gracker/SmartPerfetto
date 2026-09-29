// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { DataEnvelope } from '../../types/dataContract';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import type {SceneTimelineAssessment} from './sceneTimelineContract';
import type {SceneTimelineView} from './sceneTimelineProjection';

/**
 * Scene Story Pipeline — Data Contract Types.
 *
 * Two-layer scene model:
 *  - DisplayedScene: the scene list shown in the frontend timeline. It is
 *    built from user-visible scene steps and enriched with Android runtime
 *    context/evidence from the broader scene_reconstruction output.
 *  - AnalysisInterval: the priority-truncated subset that enters
 *    SceneAnalysisJobRunner for per-scene Agent analysis.
 */

// =============================================================================
// DisplayedScene — Full timeline layer (no truncation)
// =============================================================================

/**
 * DisplayedScene 的分析状态 — 让前端不需要反查 jobs[] 就能知道某 scene 的分析情况
 *
 * 生命周期: not_planned → (queued → running → completed | failed | cancelled | dropped)
 *
 * 由 SceneAnalysisJobRunner 在 job 状态变化时同步更新对应 DisplayedScene.analysisState。
 */
export type DisplayedSceneAnalysisState =
  | 'not_planned'   // 未被选入 AnalysisInterval (优先级截断后被过滤)
  | 'queued'        // 已入 JobRunner 队列待执行
  | 'running'       // Job 正在执行
  | 'completed'     // Job 成功完成
  | 'failed'        // Job retry 后仍失败
  | 'cancelled'     // 用户 cancel,job 在 queued 时被取消
  | 'dropped';      // Cancel 后迟到的 result (仅后端日志,前端不再展示)

export type DisplayedSceneRole =
  | 'action'   // 用户可感知、可作为深钻候选的动作区间
  | 'marker'   // 零时长或辅助定位标记，例如 scroll_start
  | 'context'; // 前台应用/空闲/设备状态等上下文，不直接深钻

export type SceneConfidenceLevel = 'high' | 'medium' | 'low';

export interface SceneEvidenceRef {
  sourceStepId: string;
  eventId?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  role?: 'primary' | 'supporting' | 'context' | 'conflict';
  note?: string;
}

export interface SceneConflict {
  type:
    | 'app_mismatch'
    | 'type_mismatch'
    | 'invalid_timing'
    | 'duplicate_candidate'
    | 'ambiguous_boundary';
  severity: 'warning' | 'bad';
  message: string;
  evidenceRefs?: SceneEvidenceRef[];
}

export interface SceneRuntimeContext {
  cleanTimeline?: Array<Record<string, unknown>>;
  operationChain?: Array<Record<string, unknown>>;
  activityLifecycle?: Array<Record<string, unknown>>;
  appState?: Array<Record<string, unknown>>;
  deviceState?: Array<Record<string, unknown>>;
}

export interface SceneReconstructionVerification {
  status: 'passed' | 'needs_review' | 'skipped' | 'failed';
  /** Stage1 checks structure; it cannot attest raw evidence or whole-trace coverage. */
  scope?: 'structure';
  evidenceStatus?: 'not_checked';
  verifier: 'deterministic' | 'llm' | 'deterministic+llm';
  summary: string;
  checkedSceneCount: number;
  lowConfidenceSceneIds: string[];
  conflictSceneIds: string[];
  issues: Array<{
    severity: 'info' | 'warning' | 'bad';
    sceneId?: string;
    type: string;
    message: string;
  }>;
  llm?: {
    status: 'not_needed' | 'skipped' | 'passed' | 'needs_review' | 'failed';
    summary?: string;
    raw?: string;
    error?: string;
  };
}

export interface SmartScenePreviewPayload {
  reportId: string;
  scenes: DisplayedScene[];
  sceneVerification?: SceneReconstructionVerification;
  eligibleSceneCount: number;
  sceneTypeCounts: Record<string, number>;
}

/**
 * 展示用全量场景 — 时间轴上每个用户可感知的动作
 *
 * The display layer MUST carry every detected scene (scroll_start /
 * screen_unlock / idle etc.) so they render on the timeline; the analysis
 * layer then selects a priority-truncated subset for Agent deep-dive. Merging
 * the two would silently drop non-problem scene types from the timeline.
 */
export interface DisplayedScene {
  /** Stable id: `${sourceStepId}-${index}` */
  id: string;
  /**
   * Scene category, e.g. 'cold_start' / 'warm_start' / 'hot_start' / 'scroll' /
   * 'inertial_scroll' / 'scroll_start' / 'tap' / 'long_press' / 'idle' /
   * 'screen_on' / 'screen_off' / 'screen_unlock' / 'app_switch' / 'navigation' /
   * 'jank_region'
   */
  sceneType: string;
  /** Source step id from scene_reconstruction.skill.yaml (for provenance) */
  sourceStepId: string;
  /** BigInt ns timestamp as string (avoid JS number precision loss) */
  startTs: string;
  /** BigInt ns timestamp as string */
  endTs: string;
  /** Convenience: (endTs - startTs) / 1_000_000, computed once */
  durationMs: number;
  /** App package name or process name, when available */
  processName?: string;
  /** Display label e.g. "冷启动 (1240ms)" */
  label: string;
  /** Original row fields (for deep-dive parameter building and detail display) */
  metadata: Record<string, any>;
  /** Rule-based severity (no LLM): green / yellow / red / unknown */
  severity: 'good' | 'warning' | 'bad' | 'unknown';
  /** Display semantics used by Smart routing and UI explanation. */
  sceneRole?: DisplayedSceneRole;
  /** Explicit deep-dive gate. `false` wins over route matches. */
  analysisEligible?: boolean;
  /** Numeric confidence for UI/report math; avoid using `confidence` name. */
  confidenceScore?: number;
  confidenceLevel?: SceneConfidenceLevel;
  confidenceReasons?: string[];
  evidenceRefs?: SceneEvidenceRef[];
  conflicts?: SceneConflict[];
  context?: SceneRuntimeContext;
  parentSceneId?: string;
  childSceneIds?: string[];
  /** Analysis lifecycle state — updated by JobRunner as jobs progress */
  analysisState: DisplayedSceneAnalysisState;
  /** Set when analysisState !== 'not_planned' */
  analysisJobId?: string;
}

// =============================================================================
// AnalysisInterval — Priority-truncated analysis queue input
// =============================================================================

/**
 * 分析用截断区间 — 由 DisplayedScene 按优先级排序后截断而来
 * 这是 SceneAnalysisJobRunner 的输入。
 *
 * 截断上限遵循现有动态公式:
 *   max(5, min(20, ceil(traceDurationSec / 10)))
 */
export interface AnalysisInterval {
  /** Links back to DisplayedScene.id */
  displayedSceneId: string;
  /** 50/75/90 — higher = more problematic, computed by severity + duration thresholds */
  priority: number;
  /** Matched sceneReconstructionRoute id from domainManifest (for audit) */
  routeRuleId: string;
  /** Resolved skill id from the matched route */
  skillId: string;
  /** Resolved skill params from route.paramMapping applied to DisplayedScene */
  params: Record<string, any>;
}

// =============================================================================
// SceneAnalysisJob — JobRunner state machine
// =============================================================================

export type SceneAnalysisJobState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'dropped';

/**
 * JobRunner 内部 job 状态
 */
export interface SceneAnalysisJob {
  /** `${analysisId}-job-${index}` */
  jobId: string;
  analysisId: string;
  interval: AnalysisInterval;
  /** 0 = first try, 1 = retry (SCENE_JOB_MAX_RETRIES default) */
  attempt: number;
  state: SceneAnalysisJobState;
  startedAt?: number;
  endedAt?: number;
  result?: SceneJobResult;
  error?: { message: string; stack?: string };
}

/**
 * 单个 job 的成功产出
 */
export interface SceneJobResult {
  jobId: string;
  displayedSceneId: string;
  skillId: string;
  /** DisplayResult[] from skillEngine — opaque here to avoid circular dep */
  displayResults: unknown[];
  /** DataEnvelope[] from skillEngine — opaque here */
  dataEnvelopes: unknown[];
  /** Bounded replay-safe projection for smart chat/report rendering. */
  projection?: SceneJobProjection;
  durationMs: number;
  /** Only set when the skill ran through Claude SDK */
  costUsd?: number;
}

export interface SceneJobProjection {
  sceneId: string;
  skillId: string;
  routeId: string;
  metrics: Record<string, number>;
  evidenceRefs: string[];
  topRowsSample: unknown[];
  omittedRowCount: number;
  artifactRef?: {
    artifactId: string;
    artifactType: 'scene_job_envelopes';
    sizeBytes: number;
    checksum: string;
  };
}

export type SceneAnalysisSelectionScope = 'all' | 'scene_types' | 'scene_ids';

export interface SceneAnalysisSelection {
  scope: SceneAnalysisSelectionScope;
  sceneTypes?: string[];
  sceneIds?: string[];
  label?: string;
  /** SceneReport id returned by Smart preview; used to bind selection to that snapshot. */
  reportId?: string;
  /** Alias kept for older frontend builds that named the same concept snapshotId. */
  sceneSnapshotId?: string;
}

// =============================================================================
// SceneReport — Final persisted artifact
// =============================================================================

/**
 * 最终报告 — 持久化到 SceneReportStore,也是 GET /scene-reconstruct/report/:id 的返回
 *
 * Cache strategy depends on trace source:
 *  - file-backed trace → disk store, 7-day TTL (SCENE_REPORT_TTL_MS).
 *  - external RPC trace → in-memory LRU (SCENE_REPORT_MEMORY_CACHE_MAX).
 *    No content hash is available for this kind of trace, so the cache is
 *    process-local and resets on backend restart.
 */
export interface SceneReport {
  /** uuid v4 */
  reportId: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  /** sha256 of trace file content; null for external RPC (no content access) */
  traceHash: string | null;
  /** Backend ephemeral trace id */
  traceId: string;
  /** Determines cache strategy */
  traceOrigin: 'file' | 'external_rpc';
  /** 'disk_7d' for file-backed, 'memory_session' for external RPC */
  cachePolicy: 'disk_7d' | 'memory_session' | 'evidence_archive';
  /** v3 archive expiry is provided by its authoritative manifest; null until archived. */
  expiresAt: number | null;
  createdAt: number;
  /** Structural pipeline phase; avoids overloading localized summary text. */
  phase?: 'selection_preview' | 'analyzed';

  /** Trace metadata snapshot */
  traceMeta: {
    device?: string;
    app?: string;
    durationSec: number;
    androidVersion?: string;
    capturedAt?: number;
  };

  /** Full scene list, including scenes not selected for analysis */
  displayedScenes: DisplayedScene[];

  /** Stage1 reconstruction self-check result; optional for old cached reports. */
  sceneVerification?: SceneReconstructionVerification;

  /**
   * Stage1 DataEnvelopes captured verbatim so cache-hit replays can
   * recreate the same lane overlays the cold-path emits via `data` SSE
   * events.
   */
  cachedDataEnvelopes: DataEnvelope[];

  /** Analysis jobs, one per AnalysisInterval (may include cancelled/failed states) */
  jobs: SceneAnalysisJob[];

  /**
   * Cross-scene narrative produced by the Stage3 summary pass.
   * null when Stage3 is skipped (e.g. cancelled before all jobs terminate)
   * or errors; callers must handle null rather than assume a string.
   */
  summary: string | null;

  /** Locale-complete Stage3 narratives generated from the same evidence. */
  summaries?: {
    'zh-CN'?: string;
    en?: string;
  };

  /** v3 preserves the actual narrative language; UI localization never translates its meaning. */
  outputLanguage?: OutputLanguage;
  /** v3 canonical run/revision; browser projection omits original audit evidence rows. */
  sessionId?: string;
  runId?: string;
  sceneTimeline?: SceneTimelineAssessment | SceneTimelineView;

  /** Cross-scene structured insights (optional, empty array if Stage3 skipped) */
  insights: SceneInsight[];

  /** true if cancelled or has any failed jobs */
  partialReport: boolean;

  totalDurationMs: number;
  totalCostUsd?: number;

  generatedBy: {
    runtime: 'claude-sdk' | 'legacy' | 'agent-runtime';
    runtimeKind?: string;
    providerId?: string | null;
    registryFingerprint?: string;
    model?: string;
    pipelineVersion: 'v2' | 'v3';
  };
}

/** Canonical v3 archive report; it is a historical record, never a live proof capability. */
export interface SceneTimelineReport extends SceneReport {
  cachePolicy: 'evidence_archive';
  sessionId: string;
  runId: string;
  outputLanguage: OutputLanguage;
  summary: string;
  sceneTimeline: SceneTimelineAssessment;
  generatedBy: {
    runtime: 'agent-runtime';
    runtimeKind?: string;
    providerId?: string | null;
    registryFingerprint?: string;
    model?: string;
    pipelineVersion: 'v3';
  };
}

export type SceneTimelineReportView = Omit<SceneTimelineReport, 'sceneTimeline'> & {
  sceneTimeline: SceneTimelineView;
};

/**
 * 跨场景洞察 — Stage3 产出 (可选)
 */
export interface SceneInsight {
  /** Short title, e.g. "冷启动 JIT 影响了首屏滑动" */
  title: string;
  /** Markdown body */
  body: string;
  /** DisplayedScene.id references */
  relatedDisplayedSceneIds: string[];
}
