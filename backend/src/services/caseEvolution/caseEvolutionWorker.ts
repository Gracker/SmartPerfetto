// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { CaseEvolutionConfig } from '../../types/caseEvolution';
import { backendLogPath } from '../../runtimePaths';
import { CaseGraph } from '../caseGraph';
import { CaseLibrary } from '../caseLibrary';
import { getDefaultRagStore } from '../ragStore';
import type { LeasedCaseCandidate, CaseCandidateOutboxHandle } from './caseCandidateOutbox';
import { loadCaseEvolutionConfig } from './caseEvolutionConfig';
import { validateCaseEvolutionConfig } from './caseEvolutionConfig';
import type {CaseCandidateReviewValidatorDeps} from './caseCandidateReviewValidator';
import {
  writeCaseCandidateSidecar,
  type WriteCaseCandidateSidecarResult,
} from './caseCandidateSidecar';
import {
  executeCaseCandidateReviewViaSdk,
  type CaseCandidateReviewExecutionResult,
} from './caseCandidateReviewAgentSdk';
import {
  ingestReviewedCaseCandidate,
  type IngestReviewedCaseCandidateOptions,
  type IngestReviewedCaseCandidateResult,
} from './caseCandidateIngester';
import {
  recordCaseEvolutionWorkerPoll,
  recordCaseEvolutionWorkerRunning,
} from './caseEvolutionRuntimeMetrics';
import {caseCandidateKnowledgeScope} from './caseCandidateBuilder';
import {projectCaseCandidateReviewArtifact} from './caseCandidateArtifactProjection';
import {
  ScopedLeaseLostError,
  type ScopedLeaseFence,
} from '../evolutionLifecycle/scopedOutbox';

export type CaseCandidateReviewExecutor =
  (candidate: LeasedCaseCandidate['candidate']) => Promise<CaseCandidateReviewExecutionResult>;

export interface CaseEvolutionWorkerOptions {
  outbox: CaseCandidateOutboxHandle;
  executeReview?: CaseCandidateReviewExecutor;
  ingestReviewedCandidate?: (input: IngestReviewedCaseCandidateOptions) => IngestReviewedCaseCandidateResult;
  config?: Partial<CaseEvolutionConfig>;
  validatorDeps?: CaseCandidateReviewValidatorDeps;
  notesDir?: string;
  workerOwner?: string;
  clock?: () => number;
}

export interface CaseEvolutionWorkerStats {
  attempted: number;
  reviewed: number;
  rejected: number;
  failedTransient: number;
  failedPermanent: number;
  budgetExhausted: number;
  staleLeasesExpired: number;
  lastPollAt?: number;
}

export interface CaseEvolutionWorkerSnapshot extends CaseEvolutionWorkerStats {
  running: boolean;
  concurrency: number;
}

const MAX_CONCURRENCY = 2;

export class CaseEvolutionWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly outbox: CaseCandidateOutboxHandle;
  private readonly executeReview: CaseCandidateReviewExecutor;
  private readonly ingestReviewedCandidate: (input: IngestReviewedCaseCandidateOptions) => IngestReviewedCaseCandidateResult;
  private readonly config: CaseEvolutionConfig;
  private readonly validatorDeps?: CaseCandidateReviewValidatorDeps;
  private readonly notesDir?: string;
  private readonly workerOwner: string;
  private readonly clock: () => number;
  private readonly concurrency: number;
  readonly stats: CaseEvolutionWorkerStats = {
    attempted: 0,
    reviewed: 0,
    rejected: 0,
    failedTransient: 0,
    failedPermanent: 0,
    budgetExhausted: 0,
    staleLeasesExpired: 0,
  };

  constructor(opts: CaseEvolutionWorkerOptions) {
    this.outbox = opts.outbox;
    this.executeReview = opts.executeReview ?? executeCaseCandidateReviewViaSdk;
    this.ingestReviewedCandidate = opts.ingestReviewedCandidate ?? defaultIngestReviewedCandidate;
    const config = {
      ...loadCaseEvolutionConfig(),
      ...(opts.config ?? {}),
    };
    const validation = validateCaseEvolutionConfig(config);
    for (const warning of validation.warnings) {
      console.warn(`[CaseEvolutionWorker] ${warning}`);
    }
    for (const error of validation.errors) {
      console.error(`[CaseEvolutionWorker] ${error}`);
    }
    this.config = validation.effectiveConfig;
    this.validatorDeps = opts.validatorDeps;
    this.notesDir = opts.notesDir;
    this.workerOwner = opts.workerOwner ?? `case-evolution-${process.pid}`;
    this.clock = opts.clock ?? Date.now;
    this.concurrency = clamp(this.config.workerConcurrency, 1, MAX_CONCURRENCY);
  }

  start(): boolean {
    if (this.timer) return true;
    if (!this.config.reviewEnabled) {
      recordCaseEvolutionWorkerRunning(false);
      return false;
    }
    this.timer = setInterval(() => {
      this.tick().catch(err => {
        console.warn('[CaseEvolutionWorker] tick failed:', err instanceof Error ? err.message : String(err));
      });
    }, this.config.pollIntervalMs);
    recordCaseEvolutionWorkerRunning(true);
    return true;
  }

  stop(): void {
    if (!this.timer) {
      recordCaseEvolutionWorkerRunning(false);
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    recordCaseEvolutionWorkerRunning(false);
  }

  async tick(): Promise<void> {
    if (!this.config.reviewEnabled) return;
    const now = this.clock();
    this.stats.lastPollAt = now;
    recordCaseEvolutionWorkerPoll(now);
    this.stats.staleLeasesExpired += this.outbox.expireStaleLeases(now);

    const jobs: LeasedCaseCandidate[] = [];
    while (jobs.length < this.concurrency) {
      if (this.dailyBudgetUsed(now) >= this.config.dailyBudget) {
        this.stats.budgetExhausted += 1;
        break;
      }
      const job = this.outbox.leaseNext({
        workerOwner: this.workerOwner,
        leaseDurationMs: this.config.leaseMs,
        maxAttempts: this.config.maxAttempts,
        now,
      });
      if (!job) break;
      jobs.push(job);
    }

    await Promise.all(jobs.map(job => this.processJob(job)));
  }

  snapshot(): CaseEvolutionWorkerSnapshot {
    return {
      ...this.stats,
      running: !!this.timer,
      concurrency: this.concurrency,
    };
  }

  private dailyBudgetUsed(now: number): number {
    const daily = this.outbox.dailyCounts(now);
    return daily.todayReviewed + daily.todayFailed;
  }

  private async processJob(job: LeasedCaseCandidate): Promise<void> {
    this.stats.attempted += 1;
    let fence = job.lease;
    if (!fence) {
      this.stats.failedPermanent += 1;
      throw new Error(`case_worker_missing_lease:${job.candidateId}`);
    }
    try {
      const knowledgeScope = caseCandidateKnowledgeScope(job.candidate);
      if (!knowledgeScope) {
        this.outbox.rejectLease(
          fence,
          'candidate is missing a valid immutable origin scope',
          this.clock(),
        );
        this.stats.rejected += 1;
        return;
      }
      const result = await this.executeReview(job.candidate);
      if (!result.ok) {
        this.markTransientFailure(
          job,
          fence,
          `${result.reason}: ${result.details}`,
        );
        return;
      }
      fence = this.renewForSideEffect(fence);

      const projection = projectCaseCandidateReviewArtifact({
        value: result.review,
        candidate: job.candidate,
        validatorDeps: this.validatorDeps,
      });
      if (!projection.ok) {
        this.outbox.rejectLease(
          fence,
          projection.errors.join('; '),
          this.clock(),
        );
        this.stats.rejected += 1;
        return;
      }

      const cleanReview = projection.artifact;
      const reviewWarnings = projection.warnings;

      if (this.config.notesWriteEnabled) {
        fence = this.renewForSideEffect(fence);
      }
      const notePath = this.config.notesWriteEnabled
        ? this.writeSidecar(job, cleanReview, reviewWarnings)
        : null;
      if (notePath && !notePath.ok) {
        if (notePath.reason === 'io_error') {
          this.markTransientFailure(
            job,
            fence,
            `sidecar ${notePath.reason}: ${notePath.details}`,
          );
        } else {
          this.outbox.rejectLease(
            fence,
            `sidecar ${notePath.reason}: ${notePath.details}`,
            this.clock(),
          );
          this.stats.rejected += 1;
        }
        return;
      }

      if (cleanReview.decision !== 'promote') {
        this.outbox.rejectLease(
          fence,
          `review decision: ${cleanReview.decision}`,
          this.clock(),
        );
        this.stats.rejected += 1;
        return;
      }

      let learnedCaseId: string | null = null;
      if (this.config.ingestEnabled) {
        fence = this.renewForSideEffect(fence);
        try {
          const ingestResult = this.ingestReviewedCandidate({
            candidate: job.candidate,
            review: cleanReview,
            library: new CaseLibrary(backendLogPath('case_library.json')),
            graph: new CaseGraph(backendLogPath('case_graph.json')),
            ragStore: getDefaultRagStore(),
            sidecarRelativePath: notePath?.path,
            knowledgeScope,
          });
          learnedCaseId = ingestResult.learnedCaseId;
        } catch (err) {
          this.markTransientFailure(
            job,
            fence,
            `ingest failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }

      this.outbox.completeReviewedLease(fence, {
        review: cleanReview,
        notePath: notePath?.path ?? null,
        learnedCaseId,
      }, this.clock());
      this.stats.reviewed += 1;
    } catch (err) {
      if (err instanceof ScopedLeaseLostError) {
        this.stats.failedTransient += 1;
        return;
      }
      this.markTransientFailure(
        job,
        fence,
        `unhandled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private writeSidecar(
    job: LeasedCaseCandidate,
    review: LeasedCaseCandidate['review'] & NonNullable<LeasedCaseCandidate['review']>,
    warnings: string[],
  ): WriteCaseCandidateSidecarResult {
    return writeCaseCandidateSidecar(job.candidate, review, {
      notesDir: this.notesDir,
      warnings,
      now: this.clock(),
    });
  }

  private renewForSideEffect(fence: ScopedLeaseFence): ScopedLeaseFence {
    return this.outbox.renewLease(
      fence,
      this.config.leaseMs,
      this.clock(),
    );
  }

  private markTransientFailure(
    job: LeasedCaseCandidate,
    fence: ScopedLeaseFence,
    reason: string,
  ): void {
    this.stats.failedTransient += 1;
    try {
      this.outbox.failLease(
        fence,
        reason,
        this.config.maxAttempts,
        this.clock(),
      );
    } catch (error) {
      if (error instanceof ScopedLeaseLostError) return;
      throw error;
    }
    const row = this.outbox.getCandidate(job.candidateId);
    if (row?.state === 'rejected') this.stats.failedPermanent += 1;
  }
}

function defaultIngestReviewedCandidate(
  input: IngestReviewedCaseCandidateOptions,
): IngestReviewedCaseCandidateResult {
  return ingestReviewedCaseCandidate(input);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export const __testing = {MAX_CONCURRENCY};
