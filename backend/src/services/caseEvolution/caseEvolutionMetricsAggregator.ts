// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import { backendDataPath, backendLogPath } from '../../runtimePaths';
import type { CaseCandidateState } from '../../types/caseEvolution';
import { CaseLibrary } from '../caseLibrary';
import {
  openCaseCandidateOutbox,
  type CaseCandidateOutboxHandle,
} from './caseCandidateOutbox';
import { LEARNED_CASE_SOURCE } from './caseCandidateIngester';
import { loadCaseEvolutionConfig } from './caseEvolutionConfig';
import { getCaseEvolutionRuntimeMetrics } from './caseEvolutionRuntimeMetrics';
import {
  FeedbackEventStore,
  publicFeedbackIndexPath,
} from '../selfEvolution/feedbackEventStore';
import {
  resolveKnowledgeScope,
  type KnowledgeScope,
} from '../scopedKnowledgeStore';

const DEFAULT_DB_PATH = backendDataPath('self_improve', 'case_evolution.db');
const DEFAULT_SIDECAR_DIR = backendLogPath('case_candidates');

export interface CaseEvolutionMetrics {
  collectedAt: number;
  candidates: {
    byState: Record<CaseCandidateState, number>;
    supported: number;
    learnedCasesInLibrary: number;
    privateRetained: number;
  };
  outbox: {
    todayEnqueued: number;
    todayReviewed: number;
    todayIngested: number;
    todayFailed: number;
    dailyBudgetUsed: number;
    dailyBudgetLimit: number;
  };
  worker: {
    running: boolean;
    lastPollAt: number | null;
    attemptsHistogram: Record<number, number>;
  };
  sidecars: {
    files: number;
  };
  feedback: {
    totalPositive: number;
    totalNegative: number;
    distinctSessions: number;
  };
  retriever: {
    todayQueries: number;
    todayStrongHits: number;
    todayPruned: number;
    avgLatencyMs: number;
  };
  prompt: {
    todaySegmentsBuilt: number;
    todayDroppedForBudget: number;
  };
  flags: ReturnType<typeof loadCaseEvolutionConfig>;
  warnings: string[];
}

export interface CollectCaseEvolutionMetricsOptions {
  dbPath?: string;
  sidecarDir?: string;
  caseLibraryPath?: string;
  caseLibrary?: Pick<CaseLibrary, 'listCases'>;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  knowledgeScope?: KnowledgeScope;
  feedbackStore?: Pick<FeedbackEventStore, 'effectiveStats' | 'close'>;
  outbox?: Pick<
    CaseCandidateOutboxHandle,
    'countCandidatesByState' | 'countSupported' | 'dailyCounts' | 'workerHealth' | 'close'
  >;
}

export function collectCaseEvolutionMetrics(
  opts: CollectCaseEvolutionMetricsOptions = {},
): CaseEvolutionMetrics {
  const warnings: string[] = [];
  const flags = loadCaseEvolutionConfig(opts.env as NodeJS.ProcessEnv | undefined);
  const now = Date.now();
  const outbox = opts.outbox ?? openOutboxIfPresent(
    opts.dbPath ?? DEFAULT_DB_PATH,
    warnings,
  );
  const closeOutbox = !opts.outbox && !!outbox;

  let byState = zeroStateCounts();
  let supported = 0;
  let daily = {todayEnqueued: 0, todayReviewed: 0, todayIngested: 0, todayFailed: 0};
  let workerHealth = {pending: 0, leased: 0, attemptsHistogram: {} as Record<number, number>};
  let feedback = {totalPositive: 0, totalNegative: 0, distinctSessions: 0};
  if (outbox) {
    try {
      byState = outbox.countCandidatesByState();
      supported = outbox.countSupported();
      daily = outbox.dailyCounts(now);
      workerHealth = outbox.workerHealth();
    } catch (err) {
      warnings.push(`failed to read case_evolution outbox: ${errorMessage(err)}`);
    } finally {
      if (closeOutbox) {
        try { outbox.close(); } catch { /* ignore */ }
      }
    }
  }

  const feedbackStore = opts.feedbackStore ?? openFeedbackStoreIfPresent(
    opts.knowledgeScope,
    warnings,
  );
  const closeFeedbackStore = !opts.feedbackStore && !!feedbackStore;
  if (feedbackStore) {
    try {
      feedback = feedbackStore.effectiveStats('case_candidate');
    } catch (err) {
      warnings.push(`failed to read effective feedback: ${errorMessage(err)}`);
    } finally {
      if (closeFeedbackStore) {
        try { feedbackStore.close(); } catch { /* ignore */ }
      }
    }
  }

  const sidecars = countSidecars(opts.sidecarDir ?? DEFAULT_SIDECAR_DIR, warnings);
  const learnedCounts = countLearnedCases(
    opts.caseLibrary,
    opts.caseLibraryPath ?? backendLogPath('case_library.json'),
    warnings,
  );
  const runtimeMetrics = getCaseEvolutionRuntimeMetrics(now);
  const dailyBudgetUsed = daily.todayReviewed + daily.todayFailed;

  return {
    collectedAt: now,
    candidates: {
      byState,
      supported,
      learnedCasesInLibrary: learnedCounts.learnedCasesInLibrary,
      privateRetained: learnedCounts.privateRetained,
    },
    outbox: {
      todayEnqueued: daily.todayEnqueued,
      todayReviewed: daily.todayReviewed,
      todayIngested: daily.todayIngested,
      todayFailed: daily.todayFailed,
      dailyBudgetUsed,
      dailyBudgetLimit: flags.dailyBudget,
    },
    worker: {
      running: runtimeMetrics.worker.running,
      lastPollAt: runtimeMetrics.worker.lastPollAt,
      attemptsHistogram: workerHealth.attemptsHistogram,
    },
    sidecars,
    feedback,
    retriever: runtimeMetrics.retriever,
    prompt: runtimeMetrics.prompt,
    flags,
    warnings,
  };
}

function openFeedbackStoreIfPresent(
  knowledgeScope: KnowledgeScope | undefined,
  warnings: string[],
): FeedbackEventStore | null {
  if (!fs.existsSync(publicFeedbackIndexPath())) return null;
  try {
    const scope = resolveKnowledgeScope(knowledgeScope);
    return new FeedbackEventStore({
      scope: {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      },
    });
  } catch (err) {
    warnings.push(`failed to open feedback projection: ${errorMessage(err)}`);
    return null;
  }
}

function countLearnedCases(
  caseLibrary: Pick<CaseLibrary, 'listCases'> | undefined,
  caseLibraryPath: string,
  warnings: string[],
): {learnedCasesInLibrary: number; privateRetained: number} {
  try {
    const library = caseLibrary ?? (fs.existsSync(caseLibraryPath) ? new CaseLibrary(caseLibraryPath) : null);
    if (!library) return {learnedCasesInLibrary: 0, privateRetained: 0};
    let learnedCasesInLibrary = 0;
    let privateRetained = 0;
    for (const caseNode of library.listCases({})) {
      if (caseNode.source !== LEARNED_CASE_SOURCE) continue;
      if (caseNode.status === 'private') privateRetained++;
      else learnedCasesInLibrary++;
    }
    return {learnedCasesInLibrary, privateRetained};
  } catch (err) {
    warnings.push(`failed to read learned cases: ${errorMessage(err)}`);
    return {learnedCasesInLibrary: 0, privateRetained: 0};
  }
}

function openOutboxIfPresent(
  dbPath: string,
  warnings: string[],
): CaseCandidateOutboxHandle | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return openCaseCandidateOutbox({dbPath});
  } catch (err) {
    warnings.push(`failed to open case_evolution outbox: ${errorMessage(err)}`);
    return null;
  }
}

function countSidecars(
  sidecarDir: string,
  warnings: string[],
): {files: number} {
  if (!fs.existsSync(sidecarDir)) return {files: 0};
  let files = 0;
  try {
    for (const entry of fs.readdirSync(sidecarDir)) {
      if (!entry.endsWith('.json')) continue;
      files += 1;
      const filePath = path.join(sidecarDir, entry);
      try {
        JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        warnings.push(`failed to parse case candidate sidecar ${filePath}: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`failed to read case candidate sidecar dir ${sidecarDir}: ${errorMessage(err)}`);
  }
  return {files};
}

function zeroStateCounts(): Record<CaseCandidateState, number> {
  return {
    pending_review: 0,
    reviewed: 0,
    rejected: 0,
    archived: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
