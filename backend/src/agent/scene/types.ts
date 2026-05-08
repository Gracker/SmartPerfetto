// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { DataEnvelope } from '../../types/dataContract';

/**
 * Scene Story Pipeline — Data Contract Types.
 *
 * Two-layer scene model:
 *  - DisplayedScene: the full scene list shown in the frontend timeline,
 *    covering every step output from the scene_reconstruction skill
 *    (app_launches / user_gestures / inertial_scrolls / idle_periods /
 *     screen_state_changes / scroll_initiation / top_app_changes /
 *     jank_events fallback).
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
  durationMs: number;
  /** Only set when the skill ran through Claude SDK */
  costUsd?: number;
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
  cachePolicy: 'disk_7d' | 'memory_session';
  /** null for memory_session (expires on process restart) */
  expiresAt: number | null;
  createdAt: number;

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

  /** Cross-scene structured insights (optional, empty array if Stage3 skipped) */
  insights: SceneInsight[];

  /** true if cancelled or has any failed jobs */
  partialReport: boolean;

  totalDurationMs: number;
  totalCostUsd?: number;

  generatedBy: {
    runtime: 'claude-sdk' | 'legacy';
    model?: string;
    pipelineVersion: 'v2';
  };
}

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

// =============================================================================
// SSE Event Types — registered into StreamingUpdate.type union in agent/types.ts
// =============================================================================

/**
 * Scene Story pipeline SSE event types.
 *
 * Prefix convention: `scene_story_` strictly distinguishes these events
 * from the legacy `scene_detected` / `track_data` names so that
 * singular-vs-plural event-listener collisions cannot happen.
 *
 * Emitted directly via broadcastToAgentDrivenClients — these do NOT pass
 * through claudeSseBridge, which is reserved for SDK message translation.
 */
export type SceneStreamEventType =
  | 'scene_story_detected'           // Stage1 完成,displayedScenes 就绪
  | 'scene_story_queued'             // 某 job 入 JobRunner 队列
  | 'scene_story_started'            // 某 job 开始执行
  | 'scene_story_retrying'           // 某 job 失败进入 retry (attempt → 1)
  | 'scene_story_completed'          // 某 job 成功完成
  | 'scene_story_failed'             // 某 job retry 后仍失败
  | 'scene_story_cancelled'          // 某 job 在 queued 状态被 cancel
  | 'scene_story_dropped'            // 某 job 结果在 cancel 后迟到 (仅日志)
  | 'scene_story_report_ready';      // 最终 SceneReport 持久化完成
