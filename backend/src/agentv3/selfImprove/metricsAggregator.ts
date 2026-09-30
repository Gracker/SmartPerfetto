// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Self-Improving observability dashboard aggregator.
 *
 * Pulls counts from each persisted store (pattern memory, supersede markers,
 * review outbox, skill notes, feedback log) into a single JSON snapshot the
 * admin dashboard can poll at `GET /api/admin/self-improve/metrics`.
 *
 * Every data source is opened lazily and failures are logged-and-swallowed
 * so a single corrupt file doesn't take the dashboard down. The endpoint is
 * intentionally read-only — no side effects, no implicit migrations.
 *
 * Pattern memory is counted through its own module, so the store (DB or
 * file), the caller's scope and the admission rule are the ones runs read by.
 *
 * See docs/architecture/self-improving-design.md "运维入口" — these counts
 * power both the dashboard and the trend regression suite.
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReviewOutboxReadOnly } from './reviewOutbox';
import {
  openSupersedeStoreReadOnly,
  type SupersedeState,
} from './supersedeStore';
import { runSnapshots } from './strategyFingerprint';
import { runtimeSkillNotesDir } from './skillNotesWriter';
import type { JobState } from './reviewOutbox';
import type { PatternStatus } from '../types';
import { backendLogPath } from '../../runtimePaths';
import {readPatternBucketCensus, type PatternBucketId} from '../analysisPatternMemory';
import {
  getSelfEvolutionLifecycleSnapshot,
} from '../../services/selfEvolution/selfEvolutionLifecycle';
import {
  collectSelfEvolutionAdminOperationalMetrics,
} from '../../services/selfEvolution/selfEvolutionAdminRuntime';
import type {
  SelfEvolutionLifecycleSnapshot,
  SelfEvolutionMetrics,
} from '../../types/selfEvolution';
import {
  FeedbackEventStore,
  publicFeedbackIndexPath,
} from '../../services/selfEvolution/feedbackEventStore';
import {
  resolveKnowledgeScope,
  type KnowledgeScope,
} from '../../services/scopedKnowledgeStore';

const CURATED_SKILL_NOTES_DIR = path.resolve(__dirname, '..', '..', '..', 'skills', 'curated_skill_notes');

/** One bucket of the caller's scope: what its runs read, and what they never will. */
export interface PatternMetrics {
  /** Admitted entries, the live memory. */
  total: number;
  byStatus: Record<PatternStatus | 'legacy', number>;
  /** Entries without a learning admission, aging out unread. */
  quarantined: number;
}

export interface SkillNotesMetrics {
  runtimeFiles: number;
  runtimeNotes: number;
  curatedFiles: number;
  curatedNotes: number;
}

export interface FeedbackMetrics {
  total: number;
  positive: number;
  negative: number;
}

export type SelfEvolutionOperationalMetrics = ReturnType<
  typeof collectSelfEvolutionAdminOperationalMetrics
>;

export interface SelfImproveMetrics {
  collectedAt: number;
  patterns: {
    positive: PatternMetrics;
    negative: PatternMetrics;
    quick: PatternMetrics;
  };
  outbox: {
    byState: Record<JobState, number>;
    dailyJobs: number;
  };
  supersede: Record<SupersedeState, number>;
  skillNotes: SkillNotesMetrics;
  feedback: FeedbackMetrics;
  /** Active analyze() snapshots — surfaced so memory leaks are visible. */
  activeRunSnapshots: number;
  selfEvolution: SelfEvolutionMetrics & {
    operational: SelfEvolutionOperationalMetrics | null;
  };
  /** Errors that happened during aggregation. Empty array on a clean run. */
  warnings: string[];
}

export function collectSelfImproveMetrics(opts: {
  feedbackFile?: string;
  feedbackStore?: Pick<FeedbackEventStore, 'effectiveStats' | 'close'>;
  knowledgeScope?: KnowledgeScope;
  skillNotesDir?: string;
  curatedSkillNotesDir?: string;
  reviewOutboxDbPath?: string;
  supersedeDbPath?: string;
  selfEvolutionSnapshot?: SelfEvolutionLifecycleSnapshot;
  selfEvolutionOperationalMetrics?:
    () => SelfEvolutionOperationalMetrics;
} = {}): SelfImproveMetrics {
  const warnings: string[] = [];

  const outboxMetrics = readStore(
    () => openReviewOutboxReadOnly({dbPath: opts.reviewOutboxDbPath}),
    (outbox) => ({
      byState: outbox.countByState(),
      dailyJobs: outbox.dailyJobCount(),
    }),
    {
      byState: {pending: 0, leased: 0, done: 0, failed: 0},
      dailyJobs: 0,
    },
    warnings,
    'outbox',
  );

  const supersedeCounts = readStore(
    () => openSupersedeStoreReadOnly({dbPath: opts.supersedeDbPath}),
    (supersede) => supersede.countByState(),
    {
      pending_review: 0, active_canary: 0, active: 0,
      failed: 0, rejected: 0, drifted: 0, reverted: 0,
    },
    warnings,
    'supersede',
  );

  const skillNotes = countSkillNotes(
    opts.skillNotesDir ?? runtimeSkillNotesDir(),
    opts.curatedSkillNotesDir ?? CURATED_SKILL_NOTES_DIR,
    warnings,
  );
  const feedback = opts.feedbackFile
    ? countFeedback(opts.feedbackFile, warnings)
    : countEffectiveFeedback(
        opts.feedbackStore,
        opts.knowledgeScope,
        warnings,
      );

  return {
    collectedAt: Date.now(),
    patterns: {
      positive: countPatternBucket('positive', opts.knowledgeScope, warnings),
      negative: countPatternBucket('negative', opts.knowledgeScope, warnings),
      quick: countPatternBucket('quick', opts.knowledgeScope, warnings),
    },
    outbox: outboxMetrics,
    supersede: supersedeCounts,
    skillNotes,
    feedback,
    activeRunSnapshots: runSnapshots.size(),
    selfEvolution: {
      ...selfEvolutionMetrics(
        opts.selfEvolutionSnapshot ?? getSelfEvolutionLifecycleSnapshot(),
      ),
      operational: readSelfEvolutionOperationalMetrics(
        opts.selfEvolutionOperationalMetrics,
        opts.knowledgeScope,
        warnings,
      ),
    },
    warnings,
  };
}

function readSelfEvolutionOperationalMetrics(
  injected: (() => SelfEvolutionOperationalMetrics) | undefined,
  knowledgeScope: KnowledgeScope | undefined,
  warnings: string[],
): SelfEvolutionOperationalMetrics | null {
  try {
    if (injected) return injected();
    const scope = resolveKnowledgeScope(knowledgeScope);
    return collectSelfEvolutionAdminOperationalMetrics({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    warnings.push(
      `failed to read self-evolution operations: ${
        (error as Error).message
      }`,
    );
    return null;
  }
}

function countEffectiveFeedback(
  injectedStore: Pick<FeedbackEventStore, 'effectiveStats' | 'close'> | undefined,
  knowledgeScope: KnowledgeScope | undefined,
  warnings: string[],
): FeedbackMetrics {
  if (!injectedStore && !fs.existsSync(publicFeedbackIndexPath())) {
    return countFeedback(backendLogPath('feedback', 'feedback.jsonl'), warnings);
  }
  let store = injectedStore;
  const close = !store;
  try {
    if (!store) {
      const scope = resolveKnowledgeScope(knowledgeScope);
      store = new FeedbackEventStore({
        scope: {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
        },
      });
    }
    const stats = store.effectiveStats();
    return {
      total: stats.totalPositive + stats.totalNegative,
      positive: stats.totalPositive,
      negative: stats.totalNegative,
    };
  } catch (err) {
    warnings.push(`failed to read effective feedback: ${(err as Error).message}`);
    return {total: 0, positive: 0, negative: 0};
  } finally {
    if (close) {
      try { store?.close(); } catch { /* ignore */ }
    }
  }
}

function selfEvolutionMetrics(
  snapshot: SelfEvolutionLifecycleSnapshot,
): SelfEvolutionMetrics {
  return {
    requested: {...snapshot.requestedConfig},
    effective: {...snapshot.effectiveConfig},
    persistence: snapshot.persistence.persistence,
    ...(snapshot.persistence.reason
      ? {persistenceReason: snapshot.persistence.reason}
      : {}),
    migration: snapshot.migration.status,
    ...(snapshot.migration.errorCode
      ? {migrationErrorCode: snapshot.migration.errorCode}
      : {}),
    buildIdentityState: snapshot.buildIdentityState.status,
    currentBuildIdentity: snapshot.currentBuildIdentity,
    lastReconciledBuildIdentity:
      snapshot.buildIdentityState.record?.lastReconciledBuildIdentity ?? null,
    warnings: [...snapshot.warnings],
    errors: [...snapshot.errors],
  };
}

function readStore<TStore extends {close(): void}, TResult>(
  open: () => TStore | null,
  read: (store: TStore) => TResult,
  fallback: TResult,
  warnings: string[],
  label: string,
): TResult {
  let store: TStore | null = null;
  try {
    store = open();
    return store ? read(store) : fallback;
  } catch (err) {
    warnings.push(`failed to read ${label}: ${(err as Error).message}`);
    return fallback;
  } finally {
    try {
      store?.close();
    } catch (err) {
      warnings.push(`failed to close ${label}: ${(err as Error).message}`);
    }
  }
}

function countPatternBucket(
  bucket: PatternBucketId,
  knowledgeScope: KnowledgeScope | undefined,
  warnings: string[],
): PatternMetrics {
  try {
    const {admitted, quarantined} = readPatternBucketCensus(bucket, knowledgeScope);
    return bucketByStatus(admitted, quarantined);
  } catch (err) {
    warnings.push(`failed to read ${bucket} pattern memory: ${(err as Error).message}`);
    return bucketByStatus([], 0);
  }
}

function bucketByStatus(entries: ReadonlyArray<{ status?: PatternStatus }>, quarantined: number): PatternMetrics {
  const result: PatternMetrics = {
    total: entries.length,
    quarantined,
    byStatus: {
      provisional: 0,
      confirmed: 0,
      rejected: 0,
      disputed: 0,
      disputed_late: 0,
      legacy: 0,
    },
  };
  for (const e of entries) {
    if (e.status) result.byStatus[e.status] += 1;
    else result.byStatus.legacy += 1;
  }
  return result;
}

function countSkillNotes(
  runtimeDir: string,
  curatedDir: string,
  warnings: string[],
): SkillNotesMetrics {
  return {
    runtimeFiles: countNotesFiles(runtimeDir, warnings).files,
    runtimeNotes: countNotesFiles(runtimeDir, warnings).notes,
    curatedFiles: countNotesFiles(curatedDir, warnings).files,
    curatedNotes: countNotesFiles(curatedDir, warnings).notes,
  };
}

function countNotesFiles(dir: string, warnings: string[]): { files: number; notes: number } {
  if (!fs.existsSync(dir)) return { files: 0, notes: 0 };
  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.notes.json'));
    let notes = 0;
    for (const f of entries) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (Array.isArray(parsed.notes)) notes += parsed.notes.length;
      } catch {
        warnings.push(`failed to parse ${path.join(dir, f)}`);
      }
    }
    return { files: entries.length, notes };
  } catch (err) {
    warnings.push(`failed to list ${dir}: ${(err as Error).message}`);
    return { files: 0, notes: 0 };
  }
}

function countFeedback(file: string, warnings: string[]): FeedbackMetrics {
  const result: FeedbackMetrics = { total: 0, positive: 0, negative: 0 };
  if (!fs.existsSync(file)) return result;
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(line => line.trim().length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        result.total += 1;
        if (entry.rating === 'positive') result.positive += 1;
        else if (entry.rating === 'negative') result.negative += 1;
      } catch {
        // Skip bad line; surface a single warning per file rather than per line.
      }
    }
  } catch (err) {
    warnings.push(`failed to read ${file}: ${(err as Error).message}`);
  }
  return result;
}
