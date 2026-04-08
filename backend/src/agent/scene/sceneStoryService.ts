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
}

export interface SceneStoryStartArgs {
  sessionId: string;
  traceId: string;
  /** Per-request SkillExecutor — must already have its registry loaded. */
  skillExecutor: SkillExecutor;
  options?: SceneStoryStartOptions;
}

export interface SceneStoryStartOptions {
  /** Override the analysis cap; defaults to a heuristic based on trace length. */
  analysisCap?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SceneStoryService {
  private readonly runners: Map<string, SceneAnalysisJobRunner> = new Map();
  private readonly inProgress: Set<string> = new Set();
  private readonly toEnvelopes: (result: SkillExecutionResult) => DataEnvelope[];

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
    const { sessionId, traceId, skillExecutor } = args;
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

    try {
      this.deps.broadcast(sessionId, {
        type: 'progress',
        content: { phase: 'detecting', message: '场景检测中' },
        timestamp: Date.now(),
      });

      // ── Stage 1: scene_reconstruction skill ──────────────────────────────
      const stage1 = await new SceneStage1Runner({
        execute: (skillId, tid, params) => skillExecutor.execute(skillId, tid, params),
        toEnvelopes: this.toEnvelopes,
      }).run(traceId, (env) => {
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
      const cap = args.options?.analysisCap ?? defaultAnalysisCap(traceDurationSec);
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
        await this.finalize({
          sessionId,
          traceId,
          session,
          scenes,
          jobs: [],
          summary: null,
          cancelled: false,
          traceDurationSec,
        });
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

      // ── Stage 4: finalise + persist (in-memory) ─────────────────────────
      await this.finalize({
        sessionId,
        traceId,
        session,
        scenes,
        jobs,
        summary,
        cancelled,
        traceDurationSec,
      });
    } catch (err) {
      pipelineError = err as Error;
      session.status = 'failed';
      session.error = pipelineError.message;
      this.deps.broadcast(sessionId, {
        type: 'error',
        content: { message: pipelineError.message },
        timestamp: Date.now(),
      });
    } finally {
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
  }): Promise<void> {
    const report = buildSceneReport({
      analysisId: args.sessionId,
      traceId: args.traceId,
      createdAt: args.session.createdAt,
      scenes: args.scenes,
      jobs: args.jobs,
      summary: args.summary,
      cancelled: args.cancelled,
      traceDurationSec: args.traceDurationSec,
    });

    args.session.sceneStoryReport = report;
    args.session.status = args.cancelled ? 'cancelled' : 'completed';
    args.session.lastActivityAt = Date.now();

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
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultAnalysisCap(traceDurationSec: number): number {
  // Mirrors the legacy strategy: ~1 deep-dive per 10s of trace, [5..20].
  const computed = Math.ceil((traceDurationSec || 0) / 10);
  return Math.min(Math.max(5, computed), 20);
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
  createdAt: number;
  scenes: DisplayedScene[];
  jobs: SceneAnalysisJob[];
  summary: string | null;
  cancelled: boolean;
  traceDurationSec: number;
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

  return {
    reportId: uuidv4(),
    // Report the in-memory weak-cache state until a persistent store for
    // file-backed traces exists; this keeps traceOrigin and cachePolicy
    // internally consistent.
    traceHash: null,
    traceId: args.traceId,
    traceOrigin: 'external_rpc',
    cachePolicy: 'memory_session',
    expiresAt: null,
    createdAt: args.createdAt,
    traceMeta: { durationSec: args.traceDurationSec },
    displayedScenes: args.scenes,
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
