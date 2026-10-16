// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SceneAnalysisJobRunner — concurrent per-scene analysis runner.
 *
 * Drives the Stage 2 portion of the Scene Story pipeline: takes the
 * AnalysisInterval[] selected by buildAnalysisIntervals() and runs each one
 * through a SkillExecutor with bounded concurrency and single-retry semantics.
 *
 * Concurrency: legacy mode stays globally concurrent. Smart Analysis Mode can
 * pass runExecution to add an opt-in per-trace SQL gate without changing the
 * legacy product decision of "3-way parallel analysis".
 *
 * Cancel semantics: cancel() drains the queued jobs to 'cancelled' state
 * immediately, but running jobs keep executing (SkillExecutor has no abort
 * hook). When they finish after cancel, their result is marked 'dropped'
 * rather than 'completed' — callers can still inspect it via getJobs() for
 * telemetry, but it is not emitted as a real completion.
 */

import {
  AnalysisInterval,
  SceneAnalysisJob,
  SceneAnalysisJobState,
  SceneJobResult,
} from './types';

const PROJECTION_SAMPLE_LIMIT = 3;
const PROJECTION_MAX_BYTES = 50 * 1024;
const SAMPLE_STRING_LIMIT = 4096;

// ---------------------------------------------------------------------------
// External dependencies: minimal interfaces so the runner stays unit-testable
// ---------------------------------------------------------------------------

export interface SceneSkillExecutor {
  execute(
    skillId: string,
    traceId: string,
    params: Record<string, any>,
    inherited?: Record<string, any>,
  ): Promise<SceneSkillExecutionResult>;
}

export interface SceneSkillExecutionResult {
  success: boolean;
  displayResults?: any[];
  executionTimeMs?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Events emitted by the runner
// ---------------------------------------------------------------------------

export type JobRunnerEvent =
  | { type: 'job_queued'; job: SceneAnalysisJob }
  | { type: 'job_started'; job: SceneAnalysisJob }
  | { type: 'job_retrying'; job: SceneAnalysisJob; error: string }
  | { type: 'job_completed'; job: SceneAnalysisJob; result: SceneJobResult }
  | { type: 'job_failed'; job: SceneAnalysisJob; error: string }
  | { type: 'job_cancelled'; job: SceneAnalysisJob }
  | { type: 'job_dropped'; job: SceneAnalysisJob; reason: 'late_after_cancel' }
  | { type: 'all_done'; jobs: SceneAnalysisJob[] };

export interface SceneAnalysisJobRunnerOptions {
  /** Max jobs running concurrently. Product decision: 3. */
  concurrency: number;
  /** Retries after initial failure. Product decision: 1. */
  maxRetries: number;
  /** Trace id shared by every job produced by this runner. */
  traceId: string;
  /** Analysis id used to scope job ids. */
  analysisId: string;
  /** Skill executor used to run the per-interval skill. */
  skillExecutor: SceneSkillExecutor;
  /** Optional smart-only execution gate around per-job SQL-heavy skill calls. */
  runExecution?: (fn: () => Promise<SceneSkillExecutionResult>) => Promise<SceneSkillExecutionResult>;
  /** Optional projection input for replay/debug artifacts. */
  toDataEnvelopes?: (
    result: SceneSkillExecutionResult,
    traceId: string,
    job: SceneAnalysisJob,
  ) => unknown[];
  /** Receives every state transition for SSE fanout and telemetry. */
  onEvent: (event: JobRunnerEvent) => void;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class SceneAnalysisJobRunner {
  private readonly opts: SceneAnalysisJobRunnerOptions;
  private readonly jobs: Map<string, SceneAnalysisJob> = new Map();
  private readonly queue: string[] = [];
  private readonly running: Set<string> = new Set();
  private cancelled = false;
  private allDoneResolvers: Array<() => void> = [];
  private allDoneEmitted = false;

  constructor(opts: SceneAnalysisJobRunnerOptions) {
    if (opts.concurrency < 1) {
      throw new Error('concurrency must be >= 1');
    }
    if (opts.maxRetries < 0) {
      throw new Error('maxRetries must be >= 0');
    }
    this.opts = opts;
  }

  /** Wraps onEvent so a misbehaving listener cannot break the runner state. */
  private emit(event: JobRunnerEvent): void {
    try {
      this.opts.onEvent(event);
    } catch (err) {
      console.warn(
        '[SceneAnalysisJobRunner] onEvent listener threw, continuing:',
        (err as Error)?.message ?? err,
      );
    }
  }

  /**
   * Add a batch of analysis intervals as jobs and start executing.
   * Safe to call multiple times; each call appends to the queue.
   */
  enqueue(intervals: AnalysisInterval[]): void {
    if (this.cancelled) {
      // Discard silently: post-cancel enqueue is a caller mistake but not
      // worth throwing for.
      return;
    }

    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      const jobId = `${this.opts.analysisId}-job-${this.jobs.size}`;
      const job: SceneAnalysisJob = {
        jobId,
        analysisId: this.opts.analysisId,
        interval,
        attempt: 0,
        state: 'queued',
      };
      this.jobs.set(jobId, job);
      this.queue.push(jobId);
      this.emit({ type: 'job_queued', job });
    }

    this.pump();
    // No intervals were enqueued and nothing is running — resolve immediately.
    if (intervals.length === 0 && this.running.size === 0) {
      this.maybeSignalAllDone();
    }
  }

  /**
   * Request cancellation. Queued jobs transition to 'cancelled' immediately;
   * running jobs are left to finish but their results will be dropped.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    // Drain queue → cancelled.
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;
      this.transitionJob(job, 'cancelled');
      this.emit({ type: 'job_cancelled', job });
    }

    // If nothing is running either, we're immediately done.
    this.maybeSignalAllDone();
  }

  /**
   * Resolves when every job has reached a terminal state (completed / failed /
   * cancelled / dropped). Safe to await after cancel(); will resolve once any
   * in-flight jobs finish.
   */
  waitForAllDone(): Promise<void> {
    if (this.allDoneEmitted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.allDoneResolvers.push(resolve);
    });
  }

  getJobs(): SceneAnalysisJob[] {
    return Array.from(this.jobs.values());
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private pump(): void {
    while (
      !this.cancelled &&
      this.running.size < this.opts.concurrency &&
      this.queue.length > 0
    ) {
      const jobId = this.queue.shift()!;
      this.running.add(jobId);
      this.runJob(jobId)
        .catch((err) => {
          // runJob already handles failures internally; a throw here would
          // only surface a bug in the runner itself.
          console.error('[SceneAnalysisJobRunner] unexpected runJob error:', err);
        })
        .finally(() => {
          this.running.delete(jobId);
          if (!this.cancelled) this.pump();
          this.maybeSignalAllDone();
        });
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.state = 'running';
    job.startedAt = Date.now();
    this.emit({ type: 'job_started', job });

    let skillResult: SceneSkillExecutionResult | undefined;
    let thrown: unknown;
    try {
      const execute = () => this.opts.skillExecutor.execute(
        job.interval.skillId,
        this.opts.traceId,
        job.interval.params,
      );
      skillResult = this.opts.runExecution
        ? await this.opts.runExecution(execute)
        : await execute();
    } catch (err) {
      thrown = err;
    }

    // Cancelled while we were running: drop whatever came back.
    if (this.cancelled) {
      this.transitionJob(job, 'dropped');
      this.emit({ type: 'job_dropped', job, reason: 'late_after_cancel' });
      return;
    }

    // Skill execution failed synchronously (throw) or returned success:false.
    const failureMessage =
      thrown != null
        ? (thrown as Error)?.message ?? String(thrown)
        : skillResult && !skillResult.success
          ? skillResult.error ?? 'skill execution returned success=false'
          : null;

    if (failureMessage != null) {
      if (job.attempt < this.opts.maxRetries) {
        job.attempt += 1;
        this.emit({ type: 'job_retrying', job, error: failureMessage });
        // Put back at the front so retries run before newly enqueued work.
        this.queue.unshift(jobId);
        return;
      }
      job.endedAt = Date.now();
      job.error = { message: failureMessage };
      this.transitionJob(job, 'failed');
      this.emit({ type: 'job_failed', job, error: failureMessage });
      return;
    }

    // Success path.
    job.endedAt = Date.now();
    const displayResults = skillResult!.displayResults ?? [];
    const dataEnvelopes = this.buildDataEnvelopes(skillResult!, job);
    const result: SceneJobResult = {
      jobId: job.jobId,
      displayedSceneId: job.interval.displayedSceneId,
      skillId: job.interval.skillId,
      displayResults,
      dataEnvelopes,
      projection: buildJobProjection(job, displayResults),
      durationMs: skillResult!.executionTimeMs ?? (job.endedAt - (job.startedAt ?? job.endedAt)),
    };
    job.result = result;
    this.transitionJob(job, 'completed');
    this.emit({ type: 'job_completed', job, result });
  }

  private buildDataEnvelopes(result: SceneSkillExecutionResult, job: SceneAnalysisJob): unknown[] {
    if (!this.opts.toDataEnvelopes) return [];
    try {
      return this.opts.toDataEnvelopes(result, this.opts.traceId, job);
    } catch (err) {
      console.warn(
        '[SceneAnalysisJobRunner] toDataEnvelopes failed, continuing without envelopes:',
        (err as Error)?.message ?? err,
      );
      return [];
    }
  }

  private transitionJob(job: SceneAnalysisJob, next: SceneAnalysisJobState): void {
    job.state = next;
  }

  private maybeSignalAllDone(): void {
    if (this.allDoneEmitted) return;
    if (this.running.size > 0) return;
    if (!this.cancelled && this.queue.length > 0) return;

    this.allDoneEmitted = true;
    this.emit({ type: 'all_done', jobs: this.getJobs() });
    const resolvers = this.allDoneResolvers;
    this.allDoneResolvers = [];
    for (const r of resolvers) r();
  }
}

function buildJobProjection(job: SceneAnalysisJob, displayResults: unknown[]): SceneJobResult['projection'] {
  let topRowsSample = displayResults
    .slice(0, PROJECTION_SAMPLE_LIMIT)
    .map((row) => truncateProjectionValue(row));
  while (topRowsSample.length > 0 && projectionByteLength(job, displayResults.length, topRowsSample) > PROJECTION_MAX_BYTES) {
    topRowsSample = topRowsSample.slice(0, -1);
  }
  return {
    sceneId: job.interval.displayedSceneId,
    skillId: job.interval.skillId,
    routeId: job.interval.routeRuleId,
    metrics: {
      display_result_count: displayResults.length,
      duration_ms: Math.max(0, (job.endedAt ?? Date.now()) - (job.startedAt ?? Date.now())),
    },
    evidenceRefs: [`data:scene_job:${job.jobId}`],
    topRowsSample,
    omittedRowCount: Math.max(0, displayResults.length - topRowsSample.length),
  };
}

function projectionByteLength(
  job: SceneAnalysisJob,
  displayResultCount: number,
  topRowsSample: unknown[],
): number {
  return Buffer.byteLength(JSON.stringify({
    sceneId: job.interval.displayedSceneId,
    skillId: job.interval.skillId,
    routeId: job.interval.routeRuleId,
    metrics: {
      display_result_count: displayResultCount,
      duration_ms: Math.max(0, (job.endedAt ?? Date.now()) - (job.startedAt ?? Date.now())),
    },
    evidenceRefs: [`data:scene_job:${job.jobId}`],
    topRowsSample,
    omittedRowCount: Math.max(0, displayResultCount - topRowsSample.length),
  }), 'utf8');
}

function truncateProjectionValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > SAMPLE_STRING_LIMIT
      ? `${value.slice(0, SAMPLE_STRING_LIMIT)}...[truncated ${value.length - SAMPLE_STRING_LIMIT} chars]`
      : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated nested object]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => truncateProjectionValue(item, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).slice(0, 40)
    .map(([key, item]) => [key, truncateProjectionValue(item, depth + 1)]));
}
