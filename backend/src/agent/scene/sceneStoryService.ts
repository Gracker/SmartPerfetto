// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneStoryService — the entry point for the Scene Story pipeline.
 *
 * Drives the four stages of /scene-reconstruct end-to-end without ever
 * touching runAgentDrivenAnalysis or session.orchestrator.analyze:
 *
 *   Stage 1  scene_reconstruction skill (no LLM)
 *   Stage 2  per-interval Agent deep-dive via SceneAnalysisJobRunner
 *   Stage 3  Haiku cross-scene narrative summary
 *   Stage 4  SceneReport persistence (currently kept on the in-memory session)
 *
 * SSE event flow uses the new scene_story_* event names. The legacy
 * track_data event is also emitted once after Stage 1 so the existing
 * frontend keeps painting timelines until story_controller migrates to
 * the new event names.
 *
 * Cancel semantics:
 *  - cancel() flips a runner-level flag immediately
 *  - queued jobs transition to 'cancelled'
 *  - running jobs keep executing (SkillExecutor has no abort) but their
 *    results land as 'dropped' rather than 'completed'
 *  - waitForAllDone() resolves once nothing is in flight
 *  - the service then finalises with a partial SceneReport and emits a
 *    terminal event so the SSE stream can close cleanly
 */

import { v4 as uuidv4 } from 'uuid';
import { SkillExecutor } from '../../services/skillEngine/skillExecutor';
import { SkillExecutionResult } from '../../services/skillEngine/types';
import { DataEnvelope } from '../../types/dataContract';
import { StreamingUpdate } from '../types';
import { sceneStoryConfig } from '../../config';
import { ownersMatch, type ResourceOwnerFields } from '../../services/resourceOwnership';
import { estimateSceneStoryCost, type CostEstimate } from './sceneCostEstimator';
import {
  buildAnalysisIntervals,
  buildDisplayedScenes,
} from './sceneIntervalBuilder';
import {
  JobRunnerEvent,
  SceneAnalysisJobRunner,
} from './sceneAnalysisJobRunner';
import { SceneStage1Runner } from './sceneStage1Runner';
import { runStage3Summary } from './sceneStage3Summarizer';
import type { SceneReportStore } from '../../services/sceneReport/sceneReportStore';
import type { SceneReportMemoryCache } from '../../services/sceneReport/sceneReportMemoryCache';
import {
  AnalysisInterval,
  DisplayedScene,
  DisplayedSceneAnalysisState,
  SceneAnalysisJob,
  SceneInsight,
  SceneReport,
} from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal session shape sceneStoryService cares about. Concrete sessions
 * (SceneReconstructSession) extend this with many more fields, but we
 * intentionally only touch the ones we own.
 */
export interface SceneStorySession {
  sessionId: string;
  status: string;
  lastActivityAt: number;
  createdAt: number;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  scenes?: any[];
  trackEvents?: any[];
  error?: string;
  /** Set by sceneStoryService once Stage 4 finishes. */
  sceneStoryReport?: SceneReport;
}

export interface SceneStoryServiceDeps {
  /** Per-session SSE broadcast (sessionId, update) → void. */
  broadcast: (sessionId: string, update: StreamingUpdate) => void;
  /** Session lookup. */
  getSession: (sessionId: string) => SceneStorySession | undefined;
  /** Wraps the static SkillExecutor.toDataEnvelopes for unit testability. */
  toEnvelopes?: (result: SkillExecutionResult) => DataEnvelope[];

  /** Disk cache for file-backed traces (sha256 → SceneReport, 7d TTL). */
  reportStore: SceneReportStore;
  /** Process-memory weak cache for external-RPC traces (no content hash). */
  memoryCache: SceneReportMemoryCache;
  /**
   * Compute the trace's content hash. Returns null when the trace has no
   * file backing it (external RPC). DI'd so tests can stub without a real
   * TraceProcessorService.
   */
  computeHash: (traceId: string) => Promise<string | null>;
  /**
   * Probe the trace duration in seconds for the preview endpoint. Returns 0
   * on any failure; callers feed that into the cost estimator which clamps
   * to MIN_EXPECTED_SCENES.
   */
  probeDuration: (traceId: string) => Promise<number>;
}

export interface SceneStoryStartArgs {
  sessionId: string;
  traceId: string;
  owner?: ResourceOwnerFields;
  /** Per-request SkillExecutor — must already have its registry loaded. */
  skillExecutor: SkillExecutor;
  options?: SceneStoryStartOptions;
}

export interface SceneStoryStartOptions {
  /** Override the analysis cap; defaults to a heuristic based on trace length. */
  analysisCap?: number;
  /** Skip cache lookup and run a fresh pipeline. */
  forceRefresh?: boolean;
}

/**
 * Result of `previewOnly`. When `cached` is set the front-end can short-cut
 * to "show me this report" without ever firing /scene-reconstruct.
 */
export interface SceneStoryPreviewResult {
  estimate: CostEstimate;
  cached: SceneReport | null;
  traceDurationSec: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SceneStoryService {
  private readonly runners: Map<string, SceneAnalysisJobRunner> = new Map();
  private readonly inProgress: Set<string> = new Set();
  private readonly toEnvelopes: (result: SkillExecutionResult) => DataEnvelope[];

  /**
   * Concurrent-request dedupe: while a pipeline for an owner-scoped
   * `traceHash` is running, peer requests for the same owner + hash await the
   * in-flight promise instead of starting a duplicate pipeline. RPC traces
   * have no hash key, so duplicate concurrent requests there fall through and
   * run their own pipeline (rare and harmless).
   */
  private readonly pendingByHash: Map<string, Promise<SceneReport>> = new Map();

  constructor(private readonly deps: SceneStoryServiceDeps) {
    this.toEnvelopes = deps.toEnvelopes ?? ((result) => SkillExecutor.toDataEnvelopes(result));
  }

  /**
   * Run the full Scene Story pipeline for a session. Resolves when the
   * pipeline reaches a terminal state (completed / failed / cancelled).
   *
   * Errors thrown inside the pipeline are caught and surfaced via SSE so
   * the caller does not need its own try/catch (the route handler still
   * wraps it for safety).
   */
  async start(args: SceneStoryStartArgs): Promise<void> {
    const { sessionId, traceId, skillExecutor, options } = args;
    const forceRefresh = options?.forceRefresh ?? false;
    const session = this.deps.getSession(sessionId);
    if (!session) {
      throw new Error(`SceneStoryService.start: session ${sessionId} not found`);
    }
    if (this.inProgress.has(sessionId)) {
      throw new Error(`SceneStoryService.start: session ${sessionId} is already running`);
    }

    this.inProgress.add(sessionId);
    session.status = 'running';
    session.lastActivityAt = Date.now();

    let scenes: DisplayedScene[] = [];
    let intervals: AnalysisInterval[] = [];
    let runner: SceneAnalysisJobRunner | undefined;
    let traceDurationSec = 0;
    let pipelineError: Error | undefined;
    let traceHash: string | null = null;
    let resolvePending: ((r: SceneReport) => void) | undefined;
    let rejectPending: ((err: unknown) => void) | undefined;

    try {
      // ── Cache check ─────────────────────────────────────────────────────
      // Done before any expensive work so a returning user gets a sub-second
      // response on the same trace. Hashing reads the file (~5-10s for 1GB);
      // RPC traces skip the hash and check the memory cache by traceId.
      traceHash = await this.deps.computeHash(traceId);

      if (!forceRefresh) {
        // Disk (by hash) or memory (by traceId) cache lookup.
        const cached = await this.lookupCachedReport(traceHash, traceId, args.owner);
        if (cached) {
          this.emitCachedReport(sessionId, session, cached);
          return;
        }
      }

      // 3) In-flight pipeline dedupe — only file-backed traces have a hash
      // key, so concurrent RPC requests fall through and run independently.
      const pendingKey = traceHash ? buildOwnerScopedCacheKey(traceHash, args.owner) : null;
      if (pendingKey && !forceRefresh) {
        const inFlight = this.pendingByHash.get(pendingKey);
        if (inFlight) {
          const shared = await inFlight;
          this.emitCachedReport(sessionId, session, shared);
          return;
        }
        // Register a deferred promise so peer requests can wait on us.
        const pending = new Promise<SceneReport>((res, rej) => {
          resolvePending = res;
          rejectPending = rej;
        });
        this.pendingByHash.set(pendingKey, pending);
        // Swallow unhandled-rejection — peer awaiters that come and go later
        // will see the rejection through their own await.
        pending.catch(() => undefined);
      }

      this.deps.broadcast(sessionId, {
        type: 'progress',
        content: { phase: 'detecting', message: '场景检测中' },
        timestamp: Date.now(),
      });

      // ── Stage 1: scene_reconstruction skill ──────────────────────────────
      // We also capture each envelope into a local array so the finalised
      // SceneReport can persist them for cache-hit replay; without this,
      // re-opening a cached trace would lose the lane-overlay state.
      const stage1Envelopes: DataEnvelope[] = [];
      const stage1 = await new SceneStage1Runner({
        execute: (skillId, tid, params) => skillExecutor.execute(skillId, tid, params),
        toEnvelopes: this.toEnvelopes,
      }).run(traceId, (env) => {
        stage1Envelopes.push(env);
        // Forward each envelope as a `data` SSE event so the existing
        // track_overlay frontend code keeps populating state lanes.
        this.deps.broadcast(sessionId, {
          type: 'data',
          content: env,
          timestamp: Date.now(),
        });
      });

      scenes = stage1.scenes;
      traceDurationSec = stage1.traceDurationSec;
      const cap = args.options?.analysisCap ??
        estimateSceneStoryCost({ traceDurationSec }).expectedScenes;
      intervals = buildAnalysisIntervals(scenes, { cap });

      // Mark which scenes were selected for analysis.
      const selectedSceneIds = new Set(intervals.map((i) => i.displayedSceneId));
      for (const scene of scenes) {
        if (selectedSceneIds.has(scene.id)) {
          scene.analysisState = 'queued';
        }
      }

      // Sync to legacy session.scenes / session.trackEvents so the legacy
      // frontend that listens to `track_data` keeps working until C5 lands.
      session.scenes = scenes.map(toLegacySceneShape);
      session.trackEvents = scenes.map(toLegacyTrackEventShape);

      this.deps.broadcast(sessionId, {
        type: 'scene_story_detected',
        content: { scenes, analysisIntervals: intervals.length },
        timestamp: Date.now(),
      });

      // Legacy `track_data` event for the rollout period.
      this.deps.broadcast(sessionId, {
        type: 'track_data',
        content: { tracks: session.trackEvents, scenes: session.scenes },
        timestamp: Date.now(),
      });

      // Skip Stage 2 entirely if nothing matched a route.
      if (intervals.length === 0) {
        const emptyReport = await this.finalize({
          sessionId,
          traceId,
          session,
          scenes,
          jobs: [],
          summary: null,
          cancelled: false,
          traceDurationSec,
          traceHash,
          stage1Envelopes,
        });
        resolvePending?.(emptyReport);
        return;
      }

      // ── Stage 2: per-interval Agent deep-dive ────────────────────────────
      runner = new SceneAnalysisJobRunner({
        concurrency: sceneStoryConfig.analysisConcurrency,
        maxRetries: sceneStoryConfig.jobMaxRetries,
        traceId,
        analysisId: sessionId,
        skillExecutor,
        onEvent: (event) => this.handleJobEvent(sessionId, scenes, event),
      });
      this.runners.set(sessionId, runner);

      runner.enqueue(intervals);
      await runner.waitForAllDone();

      const jobs = runner.getJobs();
      const cancelled = runner.isCancelled();

      // ── Stage 3: cross-scene narrative summary ──────────────────────────
      let summary: string | null = null;
      if (!cancelled) {
        this.deps.broadcast(sessionId, {
          type: 'progress',
          content: { phase: 'summarizing', message: '生成整体叙述' },
          timestamp: Date.now(),
        });
        summary = await runStage3Summary({ scenes, jobs });
      }

      // ── Stage 4: finalise + persist ──────────────────────────────────────
      const finalReport = await this.finalize({
        sessionId,
        traceId,
        session,
        scenes,
        jobs,
        summary,
        cancelled,
        traceDurationSec,
        traceHash,
        stage1Envelopes,
      });
      resolvePending?.(finalReport);
    } catch (err) {
      pipelineError = err as Error;
      session.status = 'failed';
      session.error = pipelineError.message;
      this.deps.broadcast(sessionId, {
        type: 'error',
        content: { message: pipelineError.message },
        timestamp: Date.now(),
      });
      // Wake any peer requests that were awaiting this hash so they propagate
      // the same failure on their own SSE channels (instead of hanging).
      rejectPending?.(pipelineError);
    } finally {
      if (traceHash) this.pendingByHash.delete(buildOwnerScopedCacheKey(traceHash, args.owner));
      this.runners.delete(sessionId);
      this.inProgress.delete(sessionId);
    }
  }

  /**
   * Request cancellation of an in-flight scene story run. The pipeline keeps
   * running until its in-flight jobs settle, then transitions to 'cancelled'
   * and emits the terminal events itself — callers do not need to wait.
   *
   * Returns true when a runner was found and cancelled; false otherwise
   * (already settled or never started).
   */
  cancel(sessionId: string): boolean {
    const runner = this.runners.get(sessionId);
    if (!runner) return false;

    runner.cancel();
    // Session-scope cancel — distinct from per-job cancel which uses
    // scope: 'job'. Frontend dispatchers must inspect content.scope.
    this.deps.broadcast(sessionId, {
      type: 'scene_story_cancelled',
      content: { scope: 'session', reason: 'user_requested', sessionId },
      timestamp: Date.now(),
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private handleJobEvent(
    sessionId: string,
    scenes: DisplayedScene[],
    event: JobRunnerEvent,
  ): void {
    if (event.type !== 'all_done' && 'job' in event && event.job) {
      const job = event.job;
      const scene = scenes.find((s) => s.id === job.interval.displayedSceneId);
      if (scene) {
        scene.analysisState = jobStateToAnalysisState(event.type) ?? scene.analysisState;
        scene.analysisJobId = job.jobId;
      }
    }

    const sseType = mapJobEventToSseType(event.type);
    if (!sseType) return;

    const content: any = {};
    // Mark every job-derived event explicitly so the frontend can tell
    // them apart from the session-level scene_story_cancelled emitted by
    // SceneStoryService.cancel().
    if (sseType === 'scene_story_cancelled') content.scope = 'job';
    if ('job' in event && event.job) {
      content.jobId = event.job.jobId;
      content.displayedSceneId = event.job.interval.displayedSceneId;
      content.skillId = event.job.interval.skillId;
      content.attempt = event.job.attempt;
      content.state = event.job.state;
    }
    if (event.type === 'job_completed' && event.result) {
      content.result = {
        durationMs: event.result.durationMs,
        displayResultCount: event.result.displayResults.length,
      };
    }
    if (event.type === 'job_failed' || event.type === 'job_retrying') {
      content.error = event.error;
    }

    this.deps.broadcast(sessionId, {
      type: sseType,
      content,
      timestamp: Date.now(),
    });
  }

  private async finalize(args: {
    sessionId: string;
    traceId: string;
    session: SceneStorySession;
    scenes: DisplayedScene[];
    jobs: SceneAnalysisJob[];
    summary: string | null;
    cancelled: boolean;
    traceDurationSec: number;
    /** sha256 of trace content; null for external RPC traces. */
    traceHash: string | null;
    /** Stage1 envelopes captured during the cold run, for cache-hit replay. */
    stage1Envelopes: DataEnvelope[];
  }): Promise<SceneReport> {
    const report = buildSceneReport({
      analysisId: args.sessionId,
      traceId: args.traceId,
      tenantId: args.session.tenantId,
      workspaceId: args.session.workspaceId,
      userId: args.session.userId,
      createdAt: args.session.createdAt,
      scenes: args.scenes,
      jobs: args.jobs,
      summary: args.summary,
      cancelled: args.cancelled,
      traceDurationSec: args.traceDurationSec,
      traceHash: args.traceHash,
      stage1Envelopes: args.stage1Envelopes,
    });

    args.session.sceneStoryReport = report;
    args.session.status = args.cancelled ? 'cancelled' : 'completed';
    args.session.lastActivityAt = Date.now();

    // Persist BEFORE broadcasting scene_story_report_ready so any client
    // that immediately calls GET /scene-reconstruct/report/:id is guaranteed
    // to find the report rather than racing the disk write.
    await this.persistReport(report, args.traceId);

    this.deps.broadcast(args.sessionId, {
      type: 'scene_story_report_ready',
      content: {
        reportId: report.reportId,
        partial: report.partialReport,
        summary: report.summary,
        sceneCount: report.displayedScenes.length,
        jobCount: report.jobs.length,
      },
      timestamp: Date.now(),
    });

    // Final progress event so the legacy frontend has a clean terminal signal.
    this.deps.broadcast(args.sessionId, {
      type: 'progress',
      content: {
        phase: args.cancelled ? 'cancelled' : 'completed',
        message: args.cancelled ? '场景还原已取消' : '场景还原完成',
      },
      timestamp: Date.now(),
    });

    return report;
  }

  /**
   * Persist a finalised SceneReport to whichever cache layer matches the
   * trace's origin. File-backed traces go into the disk store with the
   * configured TTL; external RPC traces fall into the in-memory LRU keyed
   * by traceId.
   *
   * Errors propagate. The contract that `scene_story_report_ready` only
   * fires after a successful persist depends on this — silently swallowing
   * a save failure would let peer requests get a `reportId` they can't
   * subsequently load via `GET /scene-reconstruct/report/:id`.
   */
  private async persistReport(report: SceneReport, traceId: string): Promise<void> {
    if (report.traceOrigin === 'file' && report.traceHash) {
      await this.deps.reportStore.save(report);
    } else {
      this.deps.memoryCache.set(traceId, report);
    }
  }

  /**
   * Replay a cached SceneReport on a new session's SSE channel. Used by both
   * the disk-cache and memory-cache hit paths and by peer-request dedupe
   * after awaiting a sibling pipeline.
   *
   * The emitted event sequence collapses Stage 1/2/3 into a single
   * scene_story_report_ready terminal:
   *   progress {phase:'cached'}
   *   → scene_story_detected
   *   → track_data (legacy)
   *   → scene_story_report_ready
   *   → progress {phase:'completed'}
   *
   * Frontend story_controller already treats scene_story_report_ready as
   * terminal, so this fast path renders correctly without any extra
   * frontend changes.
   */
  private emitCachedReport(
    sessionId: string,
    session: SceneStorySession,
    report: SceneReport,
  ): void {
    const now = Date.now();
    session.sceneStoryReport = report;
    session.scenes = report.displayedScenes.map(toLegacySceneShape);
    session.trackEvents = report.displayedScenes.map(toLegacyTrackEventShape);
    session.status = 'completed';
    session.lastActivityAt = now;

    this.deps.broadcast(sessionId, {
      type: 'progress',
      content: { phase: 'cached', message: '已命中缓存,加载历史报告' },
      timestamp: now,
    });

    // Replay Stage1 DataEnvelopes so lane overlays / state-timeline tracks
    // render the same way they would on a cold run. Without this, cache hits
    // would show the scene list but no lane overlays.
    for (const env of report.cachedDataEnvelopes) {
      this.deps.broadcast(sessionId, {
        type: 'data',
        content: env,
        timestamp: now,
      });
    }

    this.deps.broadcast(sessionId, {
      type: 'scene_story_detected',
      content: {
        scenes: report.displayedScenes,
        analysisIntervals: report.jobs.length,
      },
      timestamp: now,
    });

    // Legacy track_data so the existing track_overlay code keeps painting
    // lanes for cache hits as well.
    this.deps.broadcast(sessionId, {
      type: 'track_data',
      content: { tracks: session.trackEvents, scenes: session.scenes },
      timestamp: now,
    });

    this.deps.broadcast(sessionId, {
      type: 'scene_story_report_ready',
      content: {
        reportId: report.reportId,
        partial: report.partialReport,
        summary: report.summary,
        sceneCount: report.displayedScenes.length,
        jobCount: report.jobs.length,
        cached: true,
      },
      timestamp: now,
    });

    this.deps.broadcast(sessionId, {
      type: 'progress',
      content: { phase: 'completed', message: '场景还原完成 (缓存)' },
      timestamp: now,
    });
  }

  // -------------------------------------------------------------------------
  // Public preview / report endpoints
  // -------------------------------------------------------------------------

  /**
   * Cheap preview for the /scene-reconstruct/preview endpoint. Computes the
   * trace's content hash, checks both cache layers, and falls through to a
   * formula-based ETA + USD estimate. Never starts the heavy pipeline.
   *
   * Latency profile:
   *   - cached + file-backed: hash + index lookup (~10s for 1GB; <100ms for small)
   *   - cached + RPC: O(1) Map lookup
   *   - cold:        hash + trace_bounds SQL probe (~50ms)
   */
  async previewOnly(args: { traceId: string; owner?: ResourceOwnerFields }): Promise<SceneStoryPreviewResult> {
    const { traceId, owner } = args;

    // Hash and probe are independent — run in parallel. Hash dominates for
    // large files (5-10s for 1GB), probe is ~50ms. Parallelising cuts cold
    // preview latency from `hash + probe` to `max(hash, probe)`.
    const [hash, probedDurationSec] = await Promise.all([
      this.deps.computeHash(traceId),
      this.deps.probeDuration(traceId),
    ]);

    const cached = await this.lookupCachedReport(hash, traceId, owner);
    if (cached) {
      const dur = cached.traceMeta.durationSec;
      return {
        estimate: estimateSceneStoryCost({ traceDurationSec: dur }),
        cached,
        traceDurationSec: dur,
      };
    }

    return {
      estimate: estimateSceneStoryCost({ traceDurationSec: probedDurationSec }),
      cached: null,
      traceDurationSec: probedDurationSec,
    };
  }

  /**
   * GET /scene-reconstruct/report/:reportId — direct lookup by reportId.
   * Returns null if the report has been evicted (TTL expired) or never
   * existed; the route handler maps null to a 404.
   */
  async getReport(reportId: string): Promise<SceneReport | null> {
    return this.deps.reportStore.loadById(reportId);
  }

  /**
   * Unified cache lookup: file-backed traces go via the disk store by hash;
   * external RPC traces go via the in-memory LRU by traceId. Used by both
   * start() (cache check) and previewOnly() so the lookup strategy is
   * defined in exactly one place.
   */
  private async lookupCachedReport(
    hash: string | null,
    traceId: string,
    owner?: ResourceOwnerFields,
  ): Promise<SceneReport | null> {
    const report = hash
      ? await this.deps.reportStore.loadByHash(hash)
      : this.deps.memoryCache.get(traceId) ?? null;
    if (!report) return null;
    return owner ? (ownersMatch(report, owner) ? report : null) : report;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOwnerScopedCacheKey(hash: string, owner?: ResourceOwnerFields): string {
  if (!owner) return `${hash}:legacy`;
  return `${hash}:${owner.tenantId || ''}:${owner.workspaceId || ''}:${owner.userId || owner.ownerUserId || ''}`;
}

function jobStateToAnalysisState(
  jobEventType: JobRunnerEvent['type'],
): DisplayedSceneAnalysisState | null {
  switch (jobEventType) {
    case 'job_queued':    return 'queued';
    case 'job_started':   return 'running';
    case 'job_completed': return 'completed';
    case 'job_failed':    return 'failed';
    case 'job_cancelled': return 'cancelled';
    case 'job_dropped':   return 'dropped';
    default: return null;
  }
}

function mapJobEventToSseType(
  type: JobRunnerEvent['type'],
): StreamingUpdate['type'] | null {
  switch (type) {
    case 'job_queued':    return 'scene_story_queued';
    case 'job_started':   return 'scene_story_started';
    case 'job_retrying':  return 'scene_story_retrying';
    case 'job_completed': return 'scene_story_completed';
    case 'job_failed':    return 'scene_story_failed';
    case 'job_cancelled': return 'scene_story_cancelled';
    case 'job_dropped':   return 'scene_story_dropped';
    default: return null;
  }
}

function buildSceneReport(args: {
  analysisId: string;
  traceId: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  createdAt: number;
  scenes: DisplayedScene[];
  jobs: SceneAnalysisJob[];
  summary: string | null;
  cancelled: boolean;
  traceDurationSec: number;
  /** sha256 of trace content; null for external RPC traces. */
  traceHash: string | null;
  /** Stage1 envelopes captured during cold run, persisted for cache replay. */
  stage1Envelopes: DataEnvelope[];
}): SceneReport {
  const failedCount = args.jobs.filter((j) => j.state === 'failed').length;
  const partial = args.cancelled || failedCount > 0;
  const totalDurationMs = Date.now() - args.createdAt;

  const insights: SceneInsight[] = [];
  if (args.summary && args.scenes.length > 0) {
    insights.push({
      title: '整体叙述',
      body: args.summary,
      relatedDisplayedSceneIds: args.scenes.map((s) => s.id),
    });
  }

  // Hash presence is the source of truth for the trace's origin: a file
  // we can read deterministically (and hence cache by content) vs an
  // ephemeral external RPC connection that resets when the backend
  // restarts.
  const isFileBacked = args.traceHash !== null;
  const traceOrigin: SceneReport['traceOrigin'] = isFileBacked ? 'file' : 'external_rpc';
  const cachePolicy: SceneReport['cachePolicy'] = isFileBacked
    ? 'disk_7d'
    : 'memory_session';
  const expiresAt: number | null = isFileBacked
    ? Date.now() + sceneStoryConfig.reportTtlMs
    : null;

  return {
    reportId: uuidv4(),
    tenantId: args.tenantId,
    workspaceId: args.workspaceId,
    userId: args.userId,
    traceHash: args.traceHash,
    traceId: args.traceId,
    traceOrigin,
    cachePolicy,
    expiresAt,
    createdAt: args.createdAt,
    traceMeta: { durationSec: args.traceDurationSec },
    displayedScenes: args.scenes,
    cachedDataEnvelopes: args.stage1Envelopes,
    jobs: args.jobs,
    summary: args.summary,
    insights,
    partialReport: partial,
    totalDurationMs,
    generatedBy: {
      runtime: 'claude-sdk',
      pipelineVersion: 'v2',
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy session shape conversion
// ---------------------------------------------------------------------------

/**
 * Convert a DisplayedScene to the loose shape that legacy frontend code
 * expects on session.scenes (uses `type` and `appPackage` field names).
 * The frontend's session.scenes is `any[]`, so a structural shim is enough.
 */
function toLegacySceneShape(scene: DisplayedScene): Record<string, any> {
  return {
    id: scene.id,
    type: scene.sceneType,
    sceneType: scene.sceneType,
    sourceStepId: scene.sourceStepId,
    startTs: scene.startTs,
    endTs: scene.endTs,
    durationMs: scene.durationMs,
    appPackage: scene.processName,
    metadata: scene.metadata,
    severity: scene.severity,
  };
}

function toLegacyTrackEventShape(scene: DisplayedScene): Record<string, any> {
  return {
    id: scene.id,
    type: scene.sceneType,
    label: scene.label,
    startTs: scene.startTs,
    endTs: scene.endTs,
    durationMs: scene.durationMs,
    processName: scene.processName,
  };
}
