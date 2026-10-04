// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Analysis Pattern Memory — cross-session long-term memory for analysis insights.
 *
 * After each successful analysis, extracts trace feature fingerprints and key insights,
 * then persists them to disk. On new analyses, matches similar patterns and injects
 * relevant insights into the system prompt.
 *
 * P1 enhancements:
 * - Weighted tag matching (arch/scene weighted higher than finding titles)
 * - Confidence decay over time (exponential decay, not binary TTL)
 * - Negative memory: records what strategies FAILED for similar traces
 *
 * Storage: backend/logs/analysis_patterns.json (200 entry max, 60-day TTL)
 * Negative: backend/logs/analysis_negative_patterns.json (100 entry max, 90-day TTL)
 * Matching: Weighted Jaccard similarity on trace features
 * Admission: only entries a proven-public run wrote are read or merged into
 * (services/security/durableLearning.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Finding } from '../agent/types';
import { backendLogPath } from '../runtimePaths';
import type {
  AnalysisPatternEntry,
  NegativePatternEntry,
  FailedApproach,
  PatternStatus,
  PatternProvenance,
} from './types';
import {
  openSupersedeStore,
  openSupersedeStoreReadOnly,
  injectionWeightForSupersede,
  type SupersedeStoreReadHandle,
  type SupersedeStoreHandle,
} from './selfImprove/supersedeStore';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  getScopedKnowledgeRecord,
  legacyKnowledgeFilesystemWritesEnabled,
  listScopedKnowledgePartitions,
  mutateScopedKnowledgeRecord,
  type KnowledgeScope,
  resolveKnowledgeScope,
  type ScopedKnowledgeRecord,
} from '../services/scopedKnowledgeStore';
import {withFilesystemRegistryLockAsync} from '../services/filesystemRegistryLock';
import {
  admitLearnedEntry,
  isAdmittedLearning,
  type DurableLearningPermission,
} from '../services/security/durableLearning';
import {canonicalContentHash} from '../services/selfEvolution/canonicalJson';
import {currentRunManifestAttributionSink} from '../services/selfEvolution/runManifestLifecycle';
import {
  isEvaluationInjectionAllowed,
  registerEvaluationInjection,
} from '../services/selfEvolution/evaluationInjectionContext';
import { bucketPackageDomain } from '../services/caseEvolution/domainBucket';
import type {EffectiveFeedbackV1} from '../types/selfEvolution';
import {parseStoredJson} from '../utils/storedData';

export const PATTERN_BUCKET_KNOWLEDGE_KIND = 'analysis_pattern_bucket';
const PATTERN_BUCKET_ROW_SCOPE_PREFIX = 'pattern-memory:';
const MAX_PATTERNS = 200;
const MAX_NEGATIVE_PATTERNS = 100;
const MAX_QUICK_PATTERNS = 100;
const PATTERN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const NEGATIVE_PATTERN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — negative memory persists longer
const QUICK_PATTERN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — quick-path bucket is short-lived
const MIN_MATCH_SCORE = 0.25; // Minimum weighted similarity to consider a match
const MAX_MATCHED_PATTERNS = 3; // Max patterns to inject into prompt
const MAX_MATCHED_NEGATIVE = 3; // Max negative patterns to inject

/**
 * Status-weighted multiplier applied at injection time. `confirmed` is full
 * weight; `provisional` (no feedback yet) is half; disputed entries are deeply
 * downweighted but still injected as a soft signal. `rejected` is excluded
 * entirely. Quick-path bucket entries get an additional 0.3× multiplier
 * (applied separately) so they only surface as fallbacks.
 */
const INJECTION_WEIGHTS: Record<PatternStatus, number> = {
  confirmed: 1.0,
  provisional: 0.5,
  disputed: 0.2,
  disputed_late: 0.2,
  rejected: 0,
};
const QUICK_BUCKET_WEIGHT = 0.3;

const TEN_SECONDS_MS = 10 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Provisional → confirmed promotion when no negative feedback within this window. */
const AUTO_CONFIRM_AFTER_MS = ONE_DAY_MS;

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface PatternStoreCache<T> {
  lastGood: T[];
  retainLastGoodOnMissing?: boolean;
  /** Store the entries were read from; another root never inherits them. */
  filePath?: string;
}

interface PatternBucketSpec<T> {
  externalId: 'positive' | 'negative' | 'quick';
  /** Resolved on each read: the CLI sets its log root after import. */
  readonly filePath: string;
  label: string;
  cache: PatternStoreCache<T>;
}

interface PatternBucketMutation<T, TResult> {
  entries: T[];
  result: TResult;
}

export interface AutoConfirmSweepResult {
  positivePromoted: number;
  negativePromoted: number;
  totalPromoted: number;
}

export interface PatternMemoryAutoConfirmSweepHandle {
  stop(): void;
  trigger(): Promise<AutoConfirmSweepResult>;
}

interface PatternMemoryAutoConfirmSweepOptions {
  intervalMs?: number;
  sweep?: () => Promise<AutoConfirmSweepResult>;
  logger?: Pick<typeof console, 'error'>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const patternStoreMutex = new Mutex();
const patternStoreLogger = {
  error: (...args: unknown[]) => console.error(...args),
};
const positivePatternCache: PatternStoreCache<AnalysisPatternEntry> = { lastGood: [] };
const negativePatternCache: PatternStoreCache<NegativePatternEntry> = { lastGood: [] };
const quickPatternCache: PatternStoreCache<AnalysisPatternEntry> = { lastGood: [] };
const AUTO_CONFIRM_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function cloneStoreEntries<T>(entries: T[]): T[] {
  return JSON.parse(JSON.stringify(entries)) as T[];
}

function patternBucketRowScope(externalId: PatternBucketSpec<unknown>['externalId']): string {
  return `${PATTERN_BUCKET_ROW_SCOPE_PREFIX}${externalId}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function uniqueTempPath(filePath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${filePath}.tmp-${suffix}`;
}

function backupCorruptStore(filePath: string, label: string, err: unknown): void {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, backupPath);
    patternStoreLogger.error(
      `[PatternMemory] Failed to parse ${label}; backed up corrupt store`,
      { filePath, backupPath, error: errorMessage(err) },
    );
  } catch (backupErr) {
    patternStoreLogger.error(
      `[PatternMemory] Failed to parse ${label}; corrupt backup failed`,
      {
        filePath,
        backupPath,
        error: errorMessage(err),
        backupError: errorMessage(backupErr),
      },
    );
  }
}

/** Parse one store file; a missing file is empty, an unreadable one throws. */
function readPatternStoreFile<T>(filePath: string, label: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = parseStoredJson(fs.readFileSync(filePath, 'utf-8'), `${label} store`);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} store root must be an array`);
  }
  return parsed as T[];
}

function loadPatternStore<T>(
  filePath: string,
  label: string,
  cache: PatternStoreCache<T>,
): T[] {
  if (cache.filePath !== filePath) {
    cache.filePath = filePath;
    cache.lastGood = [];
    cache.retainLastGoodOnMissing = false;
  }
  if (!fs.existsSync(filePath)) {
    if (cache.retainLastGoodOnMissing && cache.lastGood.length > 0) {
      return cloneStoreEntries(cache.lastGood);
    }
    cache.lastGood = [];
    cache.retainLastGoodOnMissing = false;
    return [];
  }

  try {
    const entries = readPatternStoreFile<T>(filePath, label);
    cache.lastGood = cloneStoreEntries(entries);
    cache.retainLastGoodOnMissing = false;
    return cloneStoreEntries(entries);
  } catch (err) {
    backupCorruptStore(filePath, label, err);
    cache.retainLastGoodOnMissing = cache.lastGood.length > 0;
    return cloneStoreEntries(cache.lastGood);
  }
}

/** Write the store file; a failed write rejects with the file error as its cause. */
async function writePatternStore<T>(
  filePath: string,
  patterns: T[],
  cache: PatternStoreCache<T>,
): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = uniqueTempPath(filePath);
    await fs.promises.writeFile(tmpFile, JSON.stringify(patterns, null, 2));
    await fs.promises.rename(tmpFile, filePath);
  } catch (err) {
    throw Object.assign(new Error('analysis_pattern_store_write_unavailable'), {cause: err});
  }
  cache.lastGood = cloneStoreEntries(patterns);
  cache.retainLastGoodOnMissing = false;
}

/**
 * Tag category weights for weighted Jaccard similarity.
 * Higher weight = more influence on similarity score.
 *
 * Rationale: arch + scene determine the analysis path (highest weight).
 * Domain (app family) moderately matters. Finding categories are medium.
 * Individual finding titles have low weight (too specific, may not generalize).
 */
const TAG_WEIGHTS: Record<string, number> = {
  'arch': 3.0,    // Architecture type is the strongest signal
  'scene': 3.0,   // Scene type is equally strong
  'domain': 2.0,  // App family (tencent/google/etc.)
  'cat': 1.5,     // Finding categories (GPU, CPU, etc.)
  'finding': 0.5, // Individual finding titles (too specific)
};
const DEFAULT_WEIGHT = 1.0;

/** Extract the category prefix from a tag (e.g., "arch:FLUTTER" → "arch"). */
function tagCategory(tag: string): string {
  const idx = tag.indexOf(':');
  return idx > 0 ? tag.substring(0, idx) : '';
}

/** Get the weight for a tag based on its category. */
function tagWeight(tag: string): number {
  return TAG_WEIGHTS[tagCategory(tag)] ?? DEFAULT_WEIGHT;
}

/**
 * Confidence decay factor based on pattern age.
 * Uses exponential decay with a half-life of 30 days.
 * A 60-day-old pattern retains 25% of its original confidence.
 */
function confidenceDecay(createdAt: number): number {
  const ageMs = Date.now() - createdAt;
  const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * P1-G10: Combined eviction score for pattern retention.
 * Balances recency (confidence decay) with frequency (match count).
 * A highly-matched old pattern retains priority over a new single-match pattern.
 *
 * Score examples (matchCount, age → score):
 *   (0, 0d) → 1.0,  (10, 0d) → 4.46,  (0, 30d) → 0.5,  (10, 30d) → 2.23
 */
function evictionScore(p: { createdAt: number; matchCount: number }): number {
  return confidenceDecay(p.createdAt) * (1 + Math.log2(1 + p.matchCount));
}

interface PatternStatusProjection {
  status?: PatternStatus;
  intrinsicStatus?: PatternStatus;
  feedbackProjectionStatus?: PatternStatus;
  migrationSource?: 'legacy_frozen' | 'native_v2';
}

/** Legacy entries (without split fields) preserve their current status. */
function getEffectiveStatus(p: PatternStatusProjection): PatternStatus {
  return p.feedbackProjectionStatus ??
    p.intrinsicStatus ??
    p.status ??
    'confirmed';
}

function getStatusWeight(p: PatternStatusProjection): number {
  return INJECTION_WEIGHTS[getEffectiveStatus(p)];
}

function freezeLegacyPatternStatus(p: PatternStatusProjection): boolean {
  if (p.intrinsicStatus && p.migrationSource) return false;
  const frozen = getEffectiveStatus(p);
  p.intrinsicStatus = frozen;
  p.feedbackProjectionStatus = undefined;
  p.migrationSource = 'legacy_frozen';
  p.status = frozen;
  return true;
}

/**
 * Promote a `provisional` pattern to `confirmed` if it has aged past the
 * auto-confirm window without picking up negative feedback. Mutates and
 * returns true if a transition happened — caller is responsible for
 * persisting.
 */
function autoConfirmIfRipe(
  p: AnalysisPatternEntry | NegativePatternEntry,
  now: number,
): boolean {
  freezeLegacyPatternStatus(p);
  if (p.intrinsicStatus !== 'provisional') return false;
  if (now - p.createdAt < AUTO_CONFIRM_AFTER_MS) return false;
  p.intrinsicStatus = 'confirmed';
  p.status = getEffectiveStatus(p);
  return true;
}

/**
 * Two separate supersede handles so the recall path
 * (`getSupersedeWeight`, backing the `recall_patterns` MCP tool) can
 * never silently mkdir or migrate the supersede DB on first call —
 * the writable factory is reached only by `checkAndRecordRecurrence`.
 * This is what lets the recall path stay zero-write so the MCP tool
 * can be classified `public-readonly`.
 *
 * Read handles are intentionally short-lived snapshots. Reusing one
 * would make later marker promotions, reverts, and recurrence failures
 * invisible until process restart. The writable handle remains cached
 * because it is the live store connection used by the mutation path.
 */
let supersedeReadDisabledForTesting = false;
let supersedeWriteHandle: SupersedeStoreHandle | null | undefined;

function openSupersedeReadHandle(): SupersedeStoreReadHandle | null {
  if (supersedeReadDisabledForTesting) return null;
  try {
    return openSupersedeStoreReadOnly();
  } catch (err) {
    console.warn('[PatternMemory] supersede read store unavailable:', (err as Error).message);
    return null;
  }
}

function getSupersedeWeight(
  failureModeHash: string | undefined,
  handle: SupersedeStoreReadHandle | null,
): number {
  if (!failureModeHash || !handle) return 1.0;
  return injectionWeightForSupersede(handle.findActiveByHash(failureModeHash));
}

function ensureSupersedeWriteHandle(): SupersedeStoreHandle | null {
  if (supersedeWriteHandle === undefined) {
    try {
      supersedeWriteHandle = openSupersedeStore();
    } catch (err) {
      console.warn('[PatternMemory] supersede write store unavailable:', (err as Error).message);
      supersedeWriteHandle = null;
    }
  }
  return supersedeWriteHandle;
}

/**
 * @internal
 * Test-only: disable the live supersede store. Both handles snap to
 * their disabled state so neither path will attempt an adapter open. This is the
 * primitive existing fs-mocked tests use to keep production sqlite
 * out of the test process.
 *
 * Use `resetSupersedeHandlesForTesting()` instead when a test needs
 * to observe which adapter factory the production code calls.
 */
export function setSupersedeStoreForTesting(handle: null): void {
  supersedeReadDisabledForTesting = true;
  supersedeWriteHandle = handle;
}

/**
 * @internal
 * Test-only: re-enable snapshot reads and clear the writable handle so
 * the next access triggers the appropriate adapter factory.
 */
export function resetSupersedeHandlesForTesting(): void {
  supersedeReadDisabledForTesting = false;
  supersedeWriteHandle = undefined;
}

/** Metadata a save stores with the entry it writes. */
export interface PatternSaveExtras {
  /** The writing run's durable-learning grant; nothing is saved without one. */
  learning: DurableLearningPermission;
  /** Defaults to 'provisional' on save. */
  status?: PatternStatus;
  failureModeHash?: string;
  provenance?: PatternProvenance;
  bucketKey?: string;
  /** Enterprise tenant/workspace scope for learned pattern isolation. */
  knowledgeScope?: KnowledgeScope;
}

function withKnowledgeScopeProvenance(
  provenance: PatternProvenance | undefined,
  scope: KnowledgeScope | undefined,
): PatternProvenance | undefined {
  if (!enterpriseKnowledgeStoreEnabled() && !enterpriseKnowledgeDbWritesEnabled() && !scope) {
    return provenance;
  }
  const resolved = resolveKnowledgeScope(scope);
  return {
    ...(provenance ?? {}),
    sourceTenantId: resolved.tenantId,
    sourceWorkspaceId: resolved.workspaceId,
    sourceRunId: resolved.sourceRunId ?? provenance?.analysisRunId,
  };
}

function patternMatchesKnowledgeScope(
  pattern: {provenance?: PatternProvenance},
  scope: KnowledgeScope | undefined,
): boolean {
  if (!enterpriseKnowledgeStoreEnabled() && !scope) return true;
  const resolved = resolveKnowledgeScope(scope);
  return (
    pattern.provenance?.sourceTenantId === resolved.tenantId &&
    pattern.provenance?.sourceWorkspaceId === resolved.workspaceId
  );
}

const POSITIVE_PATTERN_BUCKET: PatternBucketSpec<AnalysisPatternEntry> = {
  externalId: 'positive',
  get filePath() { return backendLogPath('analysis_patterns.json'); },
  label: 'analysis patterns',
  cache: positivePatternCache,
};
const NEGATIVE_PATTERN_BUCKET: PatternBucketSpec<NegativePatternEntry> = {
  externalId: 'negative',
  get filePath() { return backendLogPath('analysis_negative_patterns.json'); },
  label: 'negative analysis patterns',
  cache: negativePatternCache,
};
const QUICK_PATTERN_BUCKET: PatternBucketSpec<AnalysisPatternEntry> = {
  externalId: 'quick',
  get filePath() { return backendLogPath('analysis_quick_patterns.json'); },
  label: 'quick analysis patterns',
  cache: quickPatternCache,
};

interface PatternBucketEntries {
  positive: AnalysisPatternEntry;
  negative: NegativePatternEntry;
  quick: AnalysisPatternEntry;
}
export type PatternBucketId = keyof PatternBucketEntries;
const PATTERN_BUCKETS: {[K in PatternBucketId]: PatternBucketSpec<PatternBucketEntries[K]>} = {
  positive: POSITIVE_PATTERN_BUCKET,
  negative: NEGATIVE_PATTERN_BUCKET,
  quick: QUICK_PATTERN_BUCKET,
};

function patternBucketIsPartitioned(scope: KnowledgeScope | undefined): boolean {
  return Boolean(
    scope || enterpriseKnowledgeStoreEnabled() || enterpriseKnowledgeDbWritesEnabled(),
  );
}

function selectPatternBucketScope<T>(
  entries: T[],
  scope: KnowledgeScope | undefined,
): T[] {
  if (!patternBucketIsPartitioned(scope)) return entries;
  return entries.filter(entry => patternMatchesKnowledgeScope(
    entry as {provenance?: PatternProvenance},
    scope,
  ));
}

function replacePatternBucketScope<T>(
  allEntries: T[],
  scope: KnowledgeScope | undefined,
  scopedEntries: T[],
): T[] {
  if (!patternBucketIsPartitioned(scope)) return scopedEntries;
  const otherScopes = allEntries.filter(entry => !patternMatchesKnowledgeScope(
    entry as {provenance?: PatternProvenance},
    scope,
  ));
  return [...otherScopes, ...scopedEntries];
}

/**
 * One scope's bucket in the DB, freshly parsed over a read-only connection, so
 * recall never creates, migrates or writes it (the `recall_patterns` read-only
 * contract). A missing database or row reads as empty; a database without the
 * knowledge table, or an undecodable row, reads as empty for a run and is
 * reported by an inspection.
 */
function readPatternBucketRecord<T>(
  spec: PatternBucketSpec<T>,
  scope: KnowledgeScope | undefined,
  mode: 'run' | 'inspect',
): T[] {
  const inspect = mode === 'inspect';
  let row: ScopedKnowledgeRecord<unknown> | undefined;
  try {
    row = getScopedKnowledgeRecord<unknown>(PATTERN_BUCKET_KNOWLEDGE_KIND, spec.externalId, scope,
      {readOnly: true, requireReadable: inspect});
  } catch (err) {
    throw errorMessage(err) === 'knowledge_record_unreadable' ? unreadablePartition(spec, scope) : err;
  }
  if (!row) return [];
  if (Array.isArray(row.record)) return row.record as T[];
  if (inspect) throw unreadablePartition(spec, scope);
  return [];
}

function unreadablePartition(spec: PatternBucketSpec<unknown>, scope: KnowledgeScope | undefined): Error {
  const {tenantId, workspaceId} = resolveKnowledgeScope(scope);
  return new Error(`${spec.label} store has an unreadable partition (${tenantId}/${workspaceId})`);
}

function loadPatternBucket<T>(
  spec: PatternBucketSpec<T>,
  scope?: KnowledgeScope,
): T[] {
  return enterpriseKnowledgeStoreEnabled()
    ? readPatternBucketRecord(spec, scope, 'run')
    : loadPatternStore(spec.filePath, spec.label, spec.cache);
}

/**
 * What a mutation visits: one scope, or every partition of the bucket. The
 * legacy file is one store whatever its partitions, so "every partition" is
 * one pass over all its entries there, and one pass per partition in the DB.
 */
type PatternBucketTarget = {scope: KnowledgeScope | undefined} | 'every_partition';

/**
 * Mutate on each store a save writes; the results are the authoritative
 * store's. When the authoritative file cannot be written the mutation rejects
 * before the DB copy changes, so a caller never reports a write that did not
 * happen.
 */
async function mutatePatternBucketTarget<T, TResult>(
  spec: PatternBucketSpec<T>,
  target: PatternBucketTarget,
  mutate: (entries: T[]) => PatternBucketMutation<T, TResult>,
): Promise<TResult[]> {
  return patternStoreMutex.runExclusive(async () => {
    const databaseIsAuthoritative = enterpriseKnowledgeStoreEnabled();
    const filesystemResults: TResult[] = [];
    const databaseResults: TResult[] = [];
    let filesystemWritten = false;
    let databaseWritten = false;

    if (legacyKnowledgeFilesystemWritesEnabled()) {
      const filePath = spec.filePath;
      filesystemResults.push(await withFilesystemRegistryLockAsync(
        filePath,
        'analysis_pattern_store_busy',
        async lease => {
          lease.assertHeld();
          const allEntries = loadPatternStore(filePath, spec.label, spec.cache);
          const scope = target === 'every_partition' ? undefined : target.scope;
          const currentScope = target === 'every_partition'
            ? allEntries
            : selectPatternBucketScope(allEntries, scope);
          const outcome = mutate(cloneStoreEntries(currentScope));
          const nextEntries = target === 'every_partition'
            ? outcome.entries
            : replacePatternBucketScope(allEntries, scope, outcome.entries);
          await writePatternStore(filePath, nextEntries, spec.cache);
          lease.assertHeld();
          return outcome.result;
        },
      ));
      filesystemWritten = true;
    }
    if (!databaseIsAuthoritative && !filesystemWritten) {
      throw new Error('analysis_pattern_store_write_unavailable');
    }

    if (enterpriseKnowledgeDbWritesEnabled()) {
      const scopes = target === 'every_partition'
        ? listScopedKnowledgePartitions([patternBucketRowScope(spec.externalId)])
        : [target.scope];
      for (const scope of scopes) {
        mutateScopedKnowledgeRecord<T[]>(
          PATTERN_BUCKET_KNOWLEDGE_KIND,
          spec.externalId,
          scope,
          current => {
            const entries = Array.isArray(current) ? cloneStoreEntries(current) : [];
            const outcome = mutate(entries);
            databaseResults.push(outcome.result);
            return outcome.entries;
          },
          {
            rowScope: patternBucketRowScope(spec.externalId),
            updatedAt: Date.now(),
          },
        );
      }
      databaseWritten = true;
    }

    if (databaseIsAuthoritative && !databaseWritten) {
      throw new Error('analysis_pattern_store_write_unavailable');
    }
    return databaseIsAuthoritative ? databaseResults : filesystemResults;
  });
}

async function mutatePatternBucket<T, TResult>(
  spec: PatternBucketSpec<T>,
  scope: KnowledgeScope | undefined,
  mutate: (entries: T[]) => PatternBucketMutation<T, TResult>,
): Promise<TResult> {
  const [result] = await mutatePatternBucketTarget(spec, {scope}, mutate);
  return result;
}

/**
 * A maintainer's read of the authoritative store that changes nothing: no
 * cache, no corrupt-store backup, and no database created, migrated or written.
 */
function inspectPatternBucket<T>(spec: PatternBucketSpec<T>, scope?: KnowledgeScope): T[] {
  return enterpriseKnowledgeStoreEnabled()
    ? readPatternBucketRecord(spec, scope, 'inspect')
    : readPatternStoreFile<T>(spec.filePath, spec.label);
}

/** Every partition of a bucket in the authoritative store, read without side effects. */
function readEveryPatternPartition<T>(spec: PatternBucketSpec<T>): T[][] {
  if (!enterpriseKnowledgeStoreEnabled()) return [inspectPatternBucket(spec)];
  return listScopedKnowledgePartitions([patternBucketRowScope(spec.externalId)], {readOnly: true, requireReadable: true})
    .map(scope => inspectPatternBucket(spec, scope));
}

/**
 * A pattern bucket row for tenant export. The bucket holds entries of many
 * runs, and only an admitted entry proves a public run wrote it, so the row
 * carries its admitted entries whichever run wrote it last; a bucket in any
 * other shape carries nothing.
 */
export function projectPatternBucketForExport(envelope: {record?: unknown}): Record<string, unknown> | undefined {
  const {record} = envelope;
  return Array.isArray(record) ? {...envelope, record: record.filter(isAdmittedLearning)} : undefined;
}

/** Every read of learned entries: an entry without an admission is never read. */
function loadAdmittedPatternBucket<T>(spec: PatternBucketSpec<T>, scope?: KnowledgeScope): T[] {
  return loadPatternBucket(spec, scope).filter(isAdmittedLearning);
}

/** What a scope's bucket holds, split by the admission rule. */
export interface PatternBucketCensus<T> {
  /** Entries a run of this scope may read (TTL still applies at match time). */
  admitted: T[];
  /** Entries without an admission: never read or exported, aging out with their TTL. */
  quarantined: number;
}

/**
 * A maintainer's view of one bucket: the storage and scope rule a run's read
 * uses, with unadmitted entries only counted. Unlike a run's read it has no
 * side effect: it neither caches nor moves a corrupt store aside (it throws),
 * and it neither creates nor migrates the database.
 */
export function readPatternBucketCensus<K extends PatternBucketId>(
  bucket: K,
  scope?: KnowledgeScope,
): PatternBucketCensus<PatternBucketEntries[K]> {
  const entries = inspectPatternBucket(PATTERN_BUCKETS[bucket], scope);
  const inScope = entries.filter(entry => patternMatchesKnowledgeScope(entry, scope));
  const admitted = inScope.filter(isAdmittedLearning);
  return {admitted, quarantined: inScope.length - admitted.length};
}

/**
 * A maintenance pass over every partition of a bucket, on every store a save
 * writes. `mutate` sees one partition's admitted entries and how many
 * unadmitted ones it holds, and must return as many admitted entries, which
 * replace them in place; unadmitted entries are kept untouched and never
 * shown. A dry run reads the authoritative store as inspectPatternBucket does
 * and writes nothing; a rewrite rejects when the authoritative store could
 * not be written. Results are the authoritative store's, one per partition it
 * visited.
 */
export async function mutateEveryAdmittedPatternPartition<K extends PatternBucketId, TResult>(
  bucket: K,
  mutate: (admitted: PatternBucketEntries[K][], quarantined: number) =>
    PatternBucketMutation<PatternBucketEntries[K], TResult>,
  opts: {dryRun: boolean},
): Promise<TResult[]> {
  const rewrite = (entries: PatternBucketEntries[K][]) => {
    const admitted = entries.filter(isAdmittedLearning);
    const outcome = mutate(admitted, entries.length - admitted.length);
    if (outcome.entries.length !== admitted.length) {
      throw new Error('pattern_bucket_rewrite_changed_entry_count');
    }
    let next = 0;
    return {
      entries: entries.map(entry => isAdmittedLearning(entry) ? outcome.entries[next++] : entry),
      result: outcome.result,
    };
  };
  const spec = PATTERN_BUCKETS[bucket];
  return opts.dryRun
    ? readEveryPatternPartition(spec).map(entries => rewrite(entries).result)
    : mutatePatternBucketTarget(spec, 'every_partition', rewrite);
}

/**
 * Every save of a learned entry. `save` sees only admitted entries, so a new
 * observation never merges into an unadmitted one; the bucket then keeps its
 * live entries within capacity, evicting unadmitted ones first (P1-G10:
 * frequency-aware eviction within each group).
 */
async function saveAdmittedPatternEntry<T extends {createdAt: number; matchCount: number}>(
  spec: PatternBucketSpec<T>,
  scope: KnowledgeScope | undefined,
  limits: {now: number; ttlMs: number; maxEntries: number},
  save: (admitted: T[]) => void,
): Promise<void> {
  await mutatePatternBucket(spec, scope, entries => {
    const admitted = entries.filter(isAdmittedLearning);
    save(admitted);
    const live = (group: T[]) => group
      .filter(entry => entry.createdAt >= limits.now - limits.ttlMs)
      .sort((a, b) => evictionScore(b) - evictionScore(a));
    const unadmitted = entries.filter(entry => !isAdmittedLearning(entry));
    return {entries: [...live(admitted), ...live(unadmitted)].slice(0, limits.maxEntries), result: undefined};
  });
}

/** Load the admitted patterns from the authoritative migration surface. */
function loadPatterns(scope?: KnowledgeScope): AnalysisPatternEntry[] {
  return loadAdmittedPatternBucket(POSITIVE_PATTERN_BUCKET, scope);
}

/** Load the admitted negative patterns from the authoritative migration surface. */
function loadNegativePatterns(scope?: KnowledgeScope): NegativePatternEntry[] {
  return loadAdmittedPatternBucket(NEGATIVE_PATTERN_BUCKET, scope);
}

/**
 * Weighted Jaccard similarity between two tag sets.
 * Each tag contributes its category weight to the intersection/union calculation.
 */
function weightedJaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map(s => s.toLowerCase()));
  const setB = new Set(b.map(s => s.toLowerCase()));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionWeight = 0;
  let unionWeight = 0;

  const allTags = new Set([...setA, ...setB]);
  for (const tag of allTags) {
    const w = tagWeight(tag);
    const inA = setA.has(tag);
    const inB = setB.has(tag);
    unionWeight += w;
    if (inA && inB) intersectionWeight += w;
  }

  return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
}

/**
 * Extract trace feature fingerprint from analysis context.
 * Used for similarity matching across sessions.
 */
export function extractTraceFeatures(context: {
  architectureType?: string;
  sceneType?: string;
  packageName?: string;
  findingTitles?: string[];
  findingCategories?: string[];
}): string[] {
  const features: string[] = [];

  if (context.architectureType) features.push(`arch:${context.architectureType}`);
  if (context.sceneType) features.push(`scene:${context.sceneType}`);
  if (context.packageName) {
    features.push(`domain:${bucketPackageDomain(context.packageName)}`);
  }

  // Add finding categories and key titles as features
  if (context.findingCategories) {
    for (const cat of new Set(context.findingCategories)) {
      features.push(`cat:${cat}`);
    }
  }
  if (context.findingTitles) {
    for (const title of context.findingTitles.slice(0, 5)) {
      // Normalize: take first significant words
      const normalized = title.replace(/[^\w\u4e00-\u9fff]/g, ' ').trim().substring(0, 30);
      if (normalized) features.push(`finding:${normalized}`);
    }
  }

  return features;
}

/**
 * Extract key insights from analysis findings and conclusion.
 * These are the patterns worth remembering across sessions.
 */
export function extractKeyInsights(
  findings: Finding[],
  conclusion: string,
): string[] {
  const insights: string[] = [];

  // Extract CRITICAL/HIGH findings with root cause as insights
  const important = findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  for (const f of important.slice(0, 5)) {
    const insight = `${f.title}: ${f.description?.substring(0, 150) || ''}`;
    insights.push(insight);
  }

  // Extract key patterns from conclusion (look for root cause statements)
  const rootCauseMatch = conclusion.match(/根因[：:]\s*([^\n]{10,150})/);
  if (rootCauseMatch) {
    insights.push(`根因: ${rootCauseMatch[1]}`);
  }

  return insights;
}

/**
 * Save an analysis pattern to persistent storage.
 * Call after a successful analysis to build long-term memory.
 */
export async function saveAnalysisPattern(
  features: string[],
  insights: string[],
  sceneType: string,
  architectureType: string | undefined,
  confidence: number | undefined,
  extras: PatternSaveExtras,
): Promise<void> {
  const now = Date.now();
  const learningAdmission = admitLearnedEntry(extras.learning, now);
  if (features.length === 0 || insights.length === 0 || !learningAdmission) return;

  const id = `pat-${now}-${Math.random().toString(36).substring(2, 6)}`;
  const provenance = withKnowledgeScopeProvenance(
    extras.provenance,
    extras.knowledgeScope,
  );
  await saveAdmittedPatternEntry(POSITIVE_PATTERN_BUCKET, extras.knowledgeScope,
    {now, ttlMs: PATTERN_TTL_MS, maxEntries: MAX_PATTERNS}, patterns => {
    // Deduplicate: check if a very similar pattern already exists (>70% similarity)
    const existing = patterns.find(p => weightedJaccardSimilarity(p.traceFeatures, features) > 0.7);

    if (existing) {
      // Update existing pattern: merge insights, bump match count
      freezeLegacyPatternStatus(existing);
      const uniqueInsights = new Set([...existing.keyInsights, ...insights]);
      existing.keyInsights = Array.from(uniqueInsights).slice(0, 10);
      existing.matchCount++;
      existing.createdAt = now; // Refresh timestamp
      if (confidence !== undefined) existing.confidence = confidence;
      if (extras.failureModeHash) existing.failureModeHash = extras.failureModeHash;
      if (extras.bucketKey) existing.bucketKey = extras.bucketKey;
      if (provenance) existing.provenance = provenance;
      // Re-saves don't downgrade status — a provisional pattern that has
      // already auto-confirmed must not slip back to provisional.
    } else {
      patterns.push({
        id,
        traceFeatures: features,
        sceneType,
        keyInsights: insights.slice(0, 10),
        architectureType,
        confidence: confidence ?? 0.5,
        createdAt: now,
        matchCount: 0,
        status: extras.status ?? 'provisional',
        intrinsicStatus: extras.status ?? 'provisional',
        migrationSource: 'native_v2',
        failureModeHash: extras.failureModeHash,
        bucketKey: extras.bucketKey,
        provenance,
        learningAdmission,
      });
    }
  });
}

/**
 * Save a negative pattern — records what strategies FAILED for similar traces.
 * Call after watchdog triggers, verification failures, or persistent tool errors.
 */
export async function saveNegativePattern(
  features: string[],
  failedApproaches: FailedApproach[],
  sceneType: string,
  architectureType: string | undefined,
  extras: PatternSaveExtras,
): Promise<void> {
  const now = Date.now();
  const learningAdmission = admitLearnedEntry(extras.learning, now);
  if (features.length === 0 || failedApproaches.length === 0 || !learningAdmission) return;

  // Recurrence detection: a fresh negative on a hash that's currently being
  // canary-watched means the alleged fix didn't work. Fire-and-forget.
  if (extras.failureModeHash) {
    checkAndRecordRecurrence(extras.failureModeHash);
  }

  const id = `neg-${now}-${Math.random().toString(36).substring(2, 6)}`;
  const provenance = withKnowledgeScopeProvenance(
    extras.provenance,
    extras.knowledgeScope,
  );
  await saveAdmittedPatternEntry(NEGATIVE_PATTERN_BUCKET, extras.knowledgeScope,
    {now, ttlMs: NEGATIVE_PATTERN_TTL_MS, maxEntries: MAX_NEGATIVE_PATTERNS}, patterns => {
    // Deduplicate: merge into existing pattern if >70% similar
    const existing = patterns.find(p => weightedJaccardSimilarity(p.traceFeatures, features) > 0.7);

    if (existing) {
      freezeLegacyPatternStatus(existing);
      const existingKeys = new Set(existing.failedApproaches.map(a => `${a.type}:${a.approach}`));
      for (const approach of failedApproaches) {
        const key = `${approach.type}:${approach.approach}`;
        if (!existingKeys.has(key)) {
          existing.failedApproaches.push(approach);
          existingKeys.add(key);
        }
      }
      existing.failedApproaches = existing.failedApproaches.slice(-10);
      existing.matchCount++;
      existing.createdAt = now;
      if (extras.failureModeHash) existing.failureModeHash = extras.failureModeHash;
      if (extras.bucketKey) existing.bucketKey = extras.bucketKey;
      if (provenance) existing.provenance = provenance;
    } else {
      patterns.push({
        id,
        traceFeatures: features,
        sceneType,
        failedApproaches: failedApproaches.slice(0, 10),
        architectureType,
        createdAt: now,
        matchCount: 0,
        status: extras.status ?? 'provisional',
        intrinsicStatus: extras.status ?? 'provisional',
        migrationSource: 'native_v2',
        failureModeHash: extras.failureModeHash,
        bucketKey: extras.bucketKey,
        provenance,
        learningAdmission,
      });
    }
  });
}

/**
 * Find patterns similar to the current trace features.
 * Returns matched patterns sorted by effective score (similarity × decay).
 */
export function matchPatterns(
  features: string[],
  scope?: KnowledgeScope,
): Array<AnalysisPatternEntry & { score: number }> {
  if (features.length === 0) return [];

  const patterns = loadPatterns(scope);
  const cutoff = Date.now() - PATTERN_TTL_MS;

  return patterns
    .filter(p => p.createdAt >= cutoff)
    .filter(p => patternMatchesKnowledgeScope(p, scope))
    .filter(p => getEffectiveStatus(p) !== 'rejected')
    .map(p => {
      const rawSimilarity = weightedJaccardSimilarity(p.traceFeatures, features);
      const decay = confidenceDecay(p.createdAt);
      // log2(1 + matchCount): 0→1.0, 1→1.0, 2→1.58, 5→2.58, 10→3.46
      const frequencyGain = 1 + Math.log2(1 + p.matchCount) * 0.1;
      const statusWeight = getStatusWeight(p);
      return {
        ...p,
        score: rawSimilarity * decay * frequencyGain * statusWeight,
      };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_PATTERNS);
}

/**
 * Find negative patterns similar to the current trace features.
 * Negative patterns persist longer (90 days) and use the same weighted matching.
 */
export function matchNegativePatterns(
  features: string[],
  scope?: KnowledgeScope,
): Array<NegativePatternEntry & { score: number }> {
  if (features.length === 0) return [];

  const patterns = loadNegativePatterns(scope);
  const cutoff = Date.now() - NEGATIVE_PATTERN_TTL_MS;
  const supersedeHandle = openSupersedeReadHandle();
  let supersedeReadFailed = false;
  try {
    return patterns
      .filter(p => p.createdAt >= cutoff)
      .filter(p => patternMatchesKnowledgeScope(p, scope))
      .filter(p => getEffectiveStatus(p) !== 'rejected')
      .map(p => {
        const frequencyGain = 1 + Math.log2(1 + p.matchCount) * 0.1;
        const statusWeight = getStatusWeight(p);
        let supersedeWeight = 1.0;
        if (!supersedeReadFailed) {
          try {
            supersedeWeight = getSupersedeWeight(
              p.failureModeHash,
              supersedeHandle,
            );
          } catch (err) {
            supersedeReadFailed = true;
            console.warn(
              '[PatternMemory] supersede read store unavailable:',
              (err as Error).message,
            );
          }
        }
        return {
          ...p,
          score:
            weightedJaccardSimilarity(p.traceFeatures, features) *
            confidenceDecay(p.createdAt) *
            frequencyGain *
            statusWeight *
            supersedeWeight,
        };
      })
      .filter(p => p.score >= MIN_MATCH_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED_NEGATIVE);
  } finally {
    try {
      supersedeHandle?.close();
    } catch (err) {
      console.warn('[PatternMemory] supersede read store close failed:', (err as Error).message);
    }
  }
}

/**
 * Recurrence detection: when a new negative pattern arrives whose
 * failureModeHash already has an `active_canary` supersede marker, that's
 * the signal that the alleged fix didn't work — flip the marker to `failed`
 * so subsequent injections restore full weight.
 */
export function checkAndRecordRecurrence(failureModeHash: string | undefined): void {
  if (!failureModeHash) return;
  const handle = ensureSupersedeWriteHandle();
  if (!handle) return;
  try {
    handle.recordRecurrence(failureModeHash);
  } catch (err) {
    console.warn('[PatternMemory] recurrence record failed:', (err as Error).message);
  }
}

// =============================================================================
// Quick-path bucket — short TTL fallback memory for analyzeQuick() runs
// =============================================================================

/** Load the admitted entries from the 7-day quick-path bucket. */
function loadQuickPatterns(scope?: KnowledgeScope): AnalysisPatternEntry[] {
  return loadAdmittedPatternBucket(QUICK_PATTERN_BUCKET, scope);
}

/**
 * Save a pattern derived from a quick-path analysis. Quick-path conclusions
 * are weaker (10-turn budget, no verifier) so they go into a separate bucket
 * with a 7-day TTL and only surface as fallbacks (×0.3 weight) when no
 * full-path pattern matches the same features.
 */
export async function saveQuickPathPattern(
  features: string[],
  insights: string[],
  sceneType: string,
  architectureType: string | undefined,
  extras: PatternSaveExtras,
): Promise<void> {
  const now = Date.now();
  const learningAdmission = admitLearnedEntry(extras.learning, now);
  if (features.length === 0 || insights.length === 0 || !learningAdmission) return;

  const id = `qp-${now}-${Math.random().toString(36).substring(2, 6)}`;
  const provenance = withKnowledgeScopeProvenance(
    extras.provenance,
    extras.knowledgeScope,
  );
  await saveAdmittedPatternEntry(QUICK_PATTERN_BUCKET, extras.knowledgeScope,
    {now, ttlMs: QUICK_PATTERN_TTL_MS, maxEntries: MAX_QUICK_PATTERNS}, patterns => {
    patterns.push({
      id,
      traceFeatures: features,
      sceneType,
      keyInsights: insights.slice(0, 5),
      architectureType,
      confidence: 0.3,
      createdAt: now,
      matchCount: 0,
      status: extras.status ?? 'provisional',
      intrinsicStatus: extras.status ?? 'provisional',
      migrationSource: 'native_v2',
      failureModeHash: extras.failureModeHash,
      bucketKey: extras.bucketKey,
      provenance,
      learningAdmission,
    });
  });
}

/**
 * Match quick-path patterns as a fallback. Only used when `matchPatterns()`
 * came back empty for the current features — surfaces with ×0.3 weight on
 * top of the usual scoring chain so a stronger long-term match always wins.
 */
export function matchQuickPatternsAsBackup(
  features: string[],
  scope?: KnowledgeScope,
): Array<AnalysisPatternEntry & { score: number }> {
  if (features.length === 0) return [];
  const patterns = loadQuickPatterns(scope);
  const cutoff = Date.now() - QUICK_PATTERN_TTL_MS;
  return patterns
    .filter(p => p.createdAt >= cutoff)
    .filter(p => patternMatchesKnowledgeScope(p, scope))
    .filter(p => getEffectiveStatus(p) !== 'rejected')
    .map(p => {
      const rawSimilarity = weightedJaccardSimilarity(p.traceFeatures, features);
      const statusWeight = getStatusWeight(p);
      return { ...p, score: rawSimilarity * statusWeight * QUICK_BUCKET_WEIGHT };
    })
    .filter(p => p.score >= MIN_MATCH_SCORE * QUICK_BUCKET_WEIGHT)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED_PATTERNS);
}

// =============================================================================
// FeedbackEvent-driven reversible projection
// =============================================================================

export type FeedbackRating = 'positive' | 'negative';

/**
 * Recompute one pattern from its intrinsic status plus every currently active
 * FeedbackEvent row. The event projection is the only production writer.
 */
export async function applyEffectiveFeedbackProjection(
  patternId: string,
  feedback: readonly EffectiveFeedbackV1[],
  scope: KnowledgeScope,
): Promise<PatternStatus | null> {
  const applyToBucket = <T extends AnalysisPatternEntry | NegativePatternEntry>(
    spec: PatternBucketSpec<T>,
  ) => mutatePatternBucket(spec, scope, entries => {
    const target = entries.find(entry => entry.id === patternId);
    if (!target) return {entries, result: null};
    freezeLegacyPatternStatus(target);
    const projected = projectPatternFeedbackStatus(
      target.intrinsicStatus!,
      feedback,
    );
    target.feedbackProjectionStatus = projected.feedbackProjectionStatus;
    target.firstFeedbackAt = projected.firstFeedbackAt;
    target.lastFeedbackAt = projected.lastFeedbackAt;
    target.status = projected.effectiveStatus;
    return {entries, result: projected.effectiveStatus};
  });

  const positive = await applyToBucket(POSITIVE_PATTERN_BUCKET);
  if (positive !== null) return positive;
  const quick = await applyToBucket(QUICK_PATTERN_BUCKET);
  if (quick !== null) return quick;
  return applyToBucket(NEGATIVE_PATTERN_BUCKET);
}

export function patternExistsForFeedback(
  patternId: string,
  scope: KnowledgeScope,
): boolean {
  return [
    ...loadPatternBucket(POSITIVE_PATTERN_BUCKET, scope),
    ...loadPatternBucket(QUICK_PATTERN_BUCKET, scope),
    ...loadPatternBucket(NEGATIVE_PATTERN_BUCKET, scope),
  ].some(entry => entry.id === patternId &&
    patternMatchesKnowledgeScope(entry, scope));
}

export interface ProjectedPatternFeedbackStatus {
  effectiveStatus: PatternStatus;
  feedbackProjectionStatus?: PatternStatus;
  firstFeedbackAt?: number;
  lastFeedbackAt?: number;
}

export function projectPatternFeedbackStatus(
  intrinsicStatus: PatternStatus,
  feedback: readonly Pick<
    EffectiveFeedbackV1,
    'rating' | 'sequence' | 'timestamp' | 'currentEventId'
  >[],
): ProjectedPatternFeedbackStatus {
  const ordered = [...feedback].sort((left, right) =>
    (left.sequence ?? Number.MIN_SAFE_INTEGER) -
      (right.sequence ?? Number.MIN_SAFE_INTEGER) ||
    left.currentEventId.localeCompare(right.currentEventId));
  if (ordered.length === 0) return {effectiveStatus: intrinsicStatus};

  let current = intrinsicStatus;
  const firstFeedbackAt = Date.parse(ordered[0].timestamp);
  if (!Number.isFinite(firstFeedbackAt)) {
    throw new Error('feedback_projection_timestamp_invalid');
  }
  let lastFeedbackAt = firstFeedbackAt;
  for (const row of ordered) {
    const observedAt = Date.parse(row.timestamp);
    if (!Number.isFinite(observedAt)) {
      throw new Error('feedback_projection_timestamp_invalid');
    }
    current = transitionStatus(
      current,
      row.rating,
      firstFeedbackAt,
      observedAt,
    );
    lastFeedbackAt = observedAt;
  }
  return {
    effectiveStatus: current,
    feedbackProjectionStatus: current,
    firstFeedbackAt,
    lastFeedbackAt,
  };
}

function transitionStatus(
  current: PatternStatus,
  rating: FeedbackRating,
  firstFeedbackAt: number,
  now: number,
): PatternStatus {
  if (current === 'rejected') return 'rejected';

  const targetForRating: PatternStatus = rating === 'positive' ? 'confirmed' : 'rejected';

  // Same direction or first-time feedback on a provisional/confirmed entry.
  if (current === targetForRating) return current;
  if (current === 'provisional') return targetForRating;
  if (current === 'confirmed' && rating === 'positive') return 'confirmed';

  // Reverse feedback — choose disputed window by elapsed time since first feedback.
  const elapsed = now - firstFeedbackAt;
  if (elapsed < TEN_SECONDS_MS) {
    // Treat as misclick: last-write-wins, no audit trail expansion.
    return targetForRating;
  }
  if (elapsed <= ONE_DAY_MS) {
    return 'disputed';
  }
  return 'disputed_late';
}

export interface PatternStatusMigrationResult {
  migrated: number;
  positive: number;
  negative: number;
  quick: number;
}

/** Count what `visit` changes per entry, summed over the partitions a target covers. */
async function countPerEntry<T>(
  spec: PatternBucketSpec<T>,
  target: PatternBucketTarget,
  visit: (entry: T) => boolean,
): Promise<number> {
  const results = await mutatePatternBucketTarget(spec, target, entries => ({
    entries,
    result: entries.filter(visit).length,
  }));
  return results.reduce((sum, count) => sum + count, 0);
}

export async function migrateAllLegacyPatternStatuses(): Promise<PatternStatusMigrationResult> {
  const target = 'every_partition';
  const positive = await countPerEntry(POSITIVE_PATTERN_BUCKET, target, freezeLegacyPatternStatus);
  const negative = await countPerEntry(NEGATIVE_PATTERN_BUCKET, target, freezeLegacyPatternStatus);
  const quick = await countPerEntry(QUICK_PATTERN_BUCKET, target, freezeLegacyPatternStatus);
  return {migrated: positive + negative + quick, positive, negative, quick};
}

// =============================================================================
// Auto-confirm sweep — promote ripe provisional entries on the next prompt build
// =============================================================================

/**
 * Sweep each on-disk bucket and promote any provisional entries past the
 * auto-confirm window. The background interval runs this globally; manual
 * admin repair can pass a scope so one workspace cannot promote another
 * workspace's provisional patterns.
 */
export function sweepAutoConfirm(
  now: number = Date.now(),
  scope?: KnowledgeScope,
): Promise<AutoConfirmSweepResult> {
  return sweepPatternMemory(now, {scope});
}

/** Sweep every partition of each bucket; see `PatternBucketTarget`. */
export function sweepAllPatternMemoryPartitions(
  now: number = Date.now(),
): Promise<AutoConfirmSweepResult> {
  return sweepPatternMemory(now, 'every_partition');
}

async function sweepPatternMemory(now: number, target: PatternBucketTarget): Promise<AutoConfirmSweepResult> {
  const promote = (entry: AnalysisPatternEntry | NegativePatternEntry) => autoConfirmIfRipe(entry, now);
  const positivePromoted = await countPerEntry(POSITIVE_PATTERN_BUCKET, target, promote);
  const negativePromoted = await countPerEntry(NEGATIVE_PATTERN_BUCKET, target, promote);
  return {
    positivePromoted,
    negativePromoted,
    totalPromoted: positivePromoted + negativePromoted,
  };
}

export function startPatternMemoryAutoConfirmSweep(
  opts: PatternMemoryAutoConfirmSweepOptions = {},
): PatternMemoryAutoConfirmSweepHandle {
  const intervalMs = opts.intervalMs ?? AUTO_CONFIRM_SWEEP_INTERVAL_MS;
  const sweep = opts.sweep ?? (() => sweepAllPatternMemoryPartitions());
  const logger = opts.logger ?? patternStoreLogger;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;

  const tick = (): void => {
    void sweep().catch(err => {
      logger.error('[PatternMemory] auto-confirm sweep failed:', errorMessage(err));
    });
  };

  const timer = setIntervalFn(tick, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearIntervalFn(timer);
    },
    trigger: sweep,
  };
}

/**
 * Build a system prompt section from matched patterns.
 * Provides cross-session context to Claude.
 */
export function buildPatternContextSection(
  features: string[],
  scope?: KnowledgeScope,
): string | undefined {
  let matches = matchPatterns(features, scope);
  if (matches.length === 0) {
    matches = matchQuickPatternsAsBackup(features, scope);
  }
  if (matches.length === 0) return undefined;

  const entries = matches.map((m, i) => {
    const insightText = m.keyInsights.slice(0, 3).map(ins => `  - ${ins}`).join('\n');
    const decayPct = (confidenceDecay(m.createdAt) * 100).toFixed(0);
    const line = `${i + 1}. **${m.sceneType}${m.architectureType ? ` (${m.architectureType})` : ''}** (相似度 ${(m.score * 100).toFixed(0)}%, 信心 ${decayPct}%, 匹配 ${m.matchCount + 1} 次)\n${insightText}`;
    return {match: m, line, contentHash: canonicalContentHash(line)};
  }).filter(entry => isEvaluationInjectionAllowed({
    category: 'patterns',
    id: entry.match.id,
    contentHash: entry.contentHash,
  }));
  if (entries.length === 0) return undefined;
  const sink = currentRunManifestAttributionSink();
  for (const entry of entries) {
    registerEvaluationInjection({
      category: 'patterns',
      id: entry.match.id,
      contentHash: entry.contentHash,
      placement: 'system_prompt:pattern_memory',
    });
    sink?.recordInjection(
      'patterns',
      entry.match.id,
      entry.contentHash,
    );
  }

  return `## 历史分析经验（跨会话记忆）

以下是过往类似 trace 的分析经验，供参考（不一定适用于当前 trace）：

${entries.map(entry => entry.line).join('\n\n')}

> 这些经验来自之前的分析会话。如果当前 trace 的数据与历史经验矛盾，以当前数据为准。`;
}

/**
 * Build a system prompt section from matched negative patterns.
 * Warns Claude about strategies that previously FAILED for similar traces.
 */
export function buildNegativePatternSection(
  features: string[],
  scope?: KnowledgeScope,
): string | undefined {
  const matches = matchNegativePatterns(features, scope);
  if (matches.length === 0) return undefined;
  const uniqueLines: string[] = [];
  const seenLines = new Set<string>();
  const attributedLines = new Map<string, string[]>();
  for (const m of matches) {
    for (const a of m.failedApproaches.slice(0, 3)) {
      const workaround = a.workaround ? ` → 替代方案: ${a.workaround}` : '';
      const line = `- **避免**: ${a.approach} — ${a.reason}${workaround}`;
      if (seenLines.has(line) || uniqueLines.length >= 6) continue;
      seenLines.add(line);
      uniqueLines.push(line);
      const matchLines = attributedLines.get(m.id) ?? [];
      matchLines.push(line);
      attributedLines.set(m.id, matchLines);
    }
  }

  if (uniqueLines.length === 0) return undefined;
  const sink = currentRunManifestAttributionSink();
  const allowedLines = new Set<string>();
  for (const [id, lines] of attributedLines) {
    const contentHash = canonicalContentHash(lines.join('\n'));
    if (!isEvaluationInjectionAllowed({
      category: 'patterns',
      id,
      contentHash,
    })) {
      continue;
    }
    for (const line of lines) allowedLines.add(line);
    registerEvaluationInjection({
      category: 'patterns',
      id,
      contentHash,
      placement: 'system_prompt:negative_pattern_memory',
    });
    sink?.recordInjection('patterns', id, contentHash);
  }
  const filteredLines = uniqueLines.filter(line => allowedLines.has(line));
  if (filteredLines.length === 0) return undefined;

  return `## 历史踩坑记录（避免重复失败）

以下策略在类似 trace 的分析中**失败过**，请优先尝试其他方案：

${filteredLines.join('\n')}

> 这些是跨会话积累的失败经验。如果没有替代方案，可以谨慎尝试，但请准备 fallback 策略。`;
}
