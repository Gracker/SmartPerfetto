// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {
  evalPinnedFingerprint,
  evalScoreKey,
  parseEvalCase,
  parseEvalScore,
  semanticEvalCaseFingerprint,
} from './evalContracts';
import {
  assertEvaluationProofMatchesScore,
  parseEvaluationEnvironmentStart,
  parseEvaluationEnvironmentProof,
  type EvaluationEnvironmentStartV1,
  type EvaluationEnvironmentProofV1,
} from './evaluationEnvironmentProof';
import {getSelfEvolutionLifecycleSnapshot} from './selfEvolutionLifecycle';

const DEFAULT_EPHEMERAL_CAPACITY = 256;
const DEFAULT_EPHEMERAL_CORPUS_MAX_BYTES = 512 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface EvalCaseStoreOptions {
  persistence: SelfEvolutionPersistenceCapability;
  databasePath?: string;
  corpusRoot?: string;
  ephemeralCapacity?: number;
  ephemeralCorpusMaxBytes?: number;
  openDatabase?: (databasePath: string) => Database.Database;
  beforeCorpusMetadataWrite?: () => void;
}

export interface PutEvalCaseResult {
  evalCase: EvalCaseV1;
  storage: 'sqlite' | 'ephemeral';
  idempotent: boolean;
}

export interface StoreEvalScoreResult {
  score: EvalScoreV1;
  proof: EvaluationEnvironmentProofV1;
  scoreKey: string;
  storage: 'sqlite' | 'ephemeral';
  idempotent: boolean;
}

export interface StoredEvalScore {
  scoreKey: string;
  score: EvalScoreV1;
  proof: EvaluationEnvironmentProofV1;
}

export interface ListEvalScoresFilter {
  caseId?: string;
  evalSetId?: string;
  role?: EvalScoreV1['role'];
  candidateId?: string;
}

export interface ManagedTraceCorpusRecordV1 {
  schemaVersion: 1;
  corpusId: string;
  scope: RunManifestScope;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}

export interface OpenedManagedTraceCorpus {
  record: ManagedTraceCorpusRecordV1;
  fileDescriptor: number;
  close: () => void;
}

export interface ImportManagedTraceInput {
  scope: RunManifestScope;
  sourcePath: string;
  expectedContentHash?: string;
  createdAt?: string;
}

export interface BaselineCacheLookupTokenV1 {
  schemaVersion: 1;
  cacheKey: string;
  scope: RunManifestScope;
  semanticCaseFingerprint: string;
  pinnedFingerprint: string;
  baselineScoreKey: string;
  baselineProofId: string;
  environmentFingerprint: string;
  issuedAt: string;
  contentHash: string;
}

export interface BaselineCacheHit {
  score: EvalScoreV1;
  proof: EvaluationEnvironmentProofV1;
  token: BaselineCacheLookupTokenV1;
}

interface EvalCaseRow {
  case_json: string;
}

interface EvalScoreRow {
  score_json: string;
  proof_id: string;
}

interface ProofRow {
  proof_json: string;
}

interface BaselinePointerRow {
  cache_key: string;
  semantic_case_fingerprint: string;
  pinned_fingerprint: string;
  score_key: string;
  proof_id: string;
  environment_fingerprint: string;
}

interface CorpusRow {
  corpus_id: string;
  content_hash: string;
  size_bytes: number;
  relative_path: string;
  created_at: string;
}

interface EphemeralScoreEntry {
  scorePayload: string;
  proofPayload: string;
}

interface EphemeralBaselinePointer {
  cacheKey: string;
  caseKey: string;
  semanticCaseFingerprint: string;
  pinnedFingerprint: string;
  scoreKey: string;
  proofId: string;
  environmentFingerprint: string;
}

function scopeKey(scope: RunManifestScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

function caseKey(scope: RunManifestScope, caseId: string): string {
  return `${scopeKey(scope)}\0${caseId}`;
}

function scopedScoreKey(scope: RunManifestScope, scoreKey: string): string {
  return `${scopeKey(scope)}\0${scoreKey}`;
}

function proofKey(scope: RunManifestScope, proofId: string): string {
  return `${scopeKey(scope)}\0${proofId}`;
}

function corpusKey(scope: RunManifestScope, corpusId: string): string {
  return `${scopeKey(scope)}\0${corpusId}`;
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function assertScope(
  expected: RunManifestScope,
  actual: RunManifestScope,
  error: string,
): void {
  if (!sameScope(expected, actual)) throw new Error(error);
}

function baselineCacheKey(
  scope: RunManifestScope,
  semanticCaseFingerprint: string,
  pinnedFingerprint: string,
): string {
  return canonicalContentHash({
    scope,
    semanticCaseFingerprint,
    pinnedFingerprint,
  });
}

function parsePayload<T>(
  payload: string,
  parser: (value: unknown) => T,
): T {
  return parser(JSON.parse(payload));
}

function touchMapValue<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
}

function validateContentHash(value: string, error: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(error);
  return value;
}

function corpusRelativePath(
  scope: RunManifestScope,
  contentHash: string,
): string {
  const scopedDirectory = canonicalContentHash(scope);
  return path.join(scopedDirectory, 'objects', `${contentHash}.pftrace`);
}

function isRegularFile(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink();
}

function openReadNoFollow(filePath: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  return fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
}

function hashFileDescriptor(fileDescriptor: number): {
  contentHash: string;
  sizeBytes: number;
} {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let sizeBytes = 0;
  let bytesRead: number;
  do {
    bytesRead = fs.readSync(
      fileDescriptor,
      buffer,
      0,
      buffer.length,
      sizeBytes,
    );
    if (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } while (bytesRead > 0);
  return {contentHash: hash.digest('hex'), sizeBytes};
}

function hashRegularFile(filePath: string): {
  contentHash: string;
  sizeBytes: number;
} {
  const lstat = fs.lstatSync(filePath);
  if (!isRegularFile(lstat)) throw new Error('eval_corpus_object_not_regular');
  const fileDescriptor = openReadNoFollow(filePath);
  try {
    const stat = fs.fstatSync(fileDescriptor);
    if (!isRegularFile(stat)) throw new Error('eval_corpus_object_not_regular');
    return hashFileDescriptor(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function pathIsInside(parent: string, candidate: string): boolean {
  return candidate === parent
    || candidate.startsWith(`${parent}${path.sep}`);
}

function ensureDirectoryWithoutSymlinks(directoryPath: string): string {
  const absolutePath = path.resolve(directoryPath);
  try {
    const existing = fs.lstatSync(absolutePath);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('eval_corpus_directory_not_safe');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(absolutePath, {recursive: true, mode: 0o700});
    const created = fs.lstatSync(absolutePath);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error('eval_corpus_directory_not_safe');
    }
  }
  fs.chmodSync(absolutePath, 0o700);
  return fs.realpathSync(absolutePath);
}

function ensureCorpusObjectsDirectory(
  corpusRoot: string,
  scope: RunManifestScope,
): {root: string; objects: string} {
  const lexicalRoot = path.resolve(corpusRoot);
  const root = ensureDirectoryWithoutSymlinks(lexicalRoot);
  let current = lexicalRoot;
  for (const segment of [canonicalContentHash(scope), 'objects']) {
    current = path.join(current, segment);
    try {
      const existing = fs.lstatSync(current);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error('eval_corpus_directory_not_safe');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(current, {mode: 0o700});
      const created = fs.lstatSync(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error('eval_corpus_directory_not_safe');
      }
    }
    fs.chmodSync(current, 0o700);
    const realCurrent = fs.realpathSync(current);
    if (!pathIsInside(root, realCurrent)) {
      throw new Error('eval_corpus_path_escape');
    }
    current = realCurrent;
  }
  return {root, objects: current};
}

function fsyncDirectory(directoryPath: string): void {
  let directory: number | undefined;
  try {
    directory = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
      throw error;
    }
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

function sameSourceIdentity(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function baselineTokenContentHash(
  token: Omit<BaselineCacheLookupTokenV1, 'contentHash'>,
): string {
  return canonicalContentHash(token);
}

function makeBaselineToken(
  pointer: {
    cacheKey: string;
    semanticCaseFingerprint: string;
    pinnedFingerprint: string;
    scoreKey: string;
    proofId: string;
    environmentFingerprint: string;
  },
  scope: RunManifestScope,
  issuedAt = new Date().toISOString(),
): BaselineCacheLookupTokenV1 {
  const withoutHash: Omit<BaselineCacheLookupTokenV1, 'contentHash'> = {
    schemaVersion: 1,
    cacheKey: pointer.cacheKey,
    scope: {...scope},
    semanticCaseFingerprint: pointer.semanticCaseFingerprint,
    pinnedFingerprint: pointer.pinnedFingerprint,
    baselineScoreKey: pointer.scoreKey,
    baselineProofId: pointer.proofId,
    environmentFingerprint: pointer.environmentFingerprint,
    issuedAt,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: baselineTokenContentHash(withoutHash),
  });
}

export function parseBaselineCacheLookupToken(
  value: unknown,
): BaselineCacheLookupTokenV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('baseline_cache_token_invalid');
  }
  const token = value as BaselineCacheLookupTokenV1;
  const keys = [
    'schemaVersion',
    'cacheKey',
    'scope',
    'semanticCaseFingerprint',
    'pinnedFingerprint',
    'baselineScoreKey',
    'baselineProofId',
    'environmentFingerprint',
    'issuedAt',
    'contentHash',
  ];
  if (
    token.schemaVersion !== 1
    || Object.keys(token).some(key => !keys.includes(key))
    || !token.scope
    || typeof token.scope !== 'object'
    || Array.isArray(token.scope)
    || Object.keys(token.scope).some(
      key => key !== 'tenantId' && key !== 'workspaceId',
    )
  ) {
    throw new Error('baseline_cache_token_schema_invalid');
  }
  if (
    typeof token.scope.tenantId !== 'string'
    || typeof token.scope.workspaceId !== 'string'
    || typeof token.baselineProofId !== 'string'
    || typeof token.issuedAt !== 'string'
  ) {
    throw new Error('baseline_cache_token_invalid');
  }
  const normalized: BaselineCacheLookupTokenV1 = {
    schemaVersion: 1,
    cacheKey: validateContentHash(token.cacheKey, 'baseline_cache_key_invalid'),
    scope: {
      tenantId: token.scope.tenantId,
      workspaceId: token.scope.workspaceId,
    },
    semanticCaseFingerprint: validateContentHash(
      token.semanticCaseFingerprint,
      'baseline_cache_case_fingerprint_invalid',
    ),
    pinnedFingerprint: validateContentHash(
      token.pinnedFingerprint,
      'baseline_cache_pinned_fingerprint_invalid',
    ),
    baselineScoreKey: validateContentHash(
      token.baselineScoreKey,
      'baseline_cache_score_key_invalid',
    ),
    baselineProofId: token.baselineProofId,
    environmentFingerprint: validateContentHash(
      token.environmentFingerprint,
      'baseline_cache_environment_fingerprint_invalid',
    ),
    issuedAt: token.issuedAt,
    contentHash: validateContentHash(
      token.contentHash,
      'baseline_cache_token_hash_invalid',
    ),
  };
  if (
    !normalized.scope.tenantId
    || !normalized.scope.workspaceId
    || !normalized.baselineProofId
    || !Number.isFinite(Date.parse(normalized.issuedAt))
  ) {
    throw new Error('baseline_cache_token_invalid');
  }
  const {contentHash, ...withoutHash} = normalized;
  if (contentHash !== baselineTokenContentHash(withoutHash)) {
    throw new Error('baseline_cache_token_hash_mismatch');
  }
  return immutableCanonicalSnapshot(normalized);
}

export function assertBaselineCacheTokenComparable(
  tokenValue: BaselineCacheLookupTokenV1,
  input: {
    evalCase: EvalCaseV1;
    pinned: EvalPinnedEnvironmentV1;
    candidateProof: EvaluationEnvironmentProofV1;
  },
): void {
  const token = parseBaselineCacheLookupToken(tokenValue);
  const evalCase = parseEvalCase(input.evalCase);
  const candidateProof = parseEvaluationEnvironmentProof(
    input.candidateProof,
  );
  const semanticFingerprint = semanticEvalCaseFingerprint(evalCase);
  const pinnedFingerprint = evalPinnedFingerprint(input.pinned);
  if (
    !sameScope(token.scope, evalCase.scope)
    || !sameScope(token.scope, candidateProof.scope)
    || token.cacheKey !== baselineCacheKey(
      token.scope,
      semanticFingerprint,
      pinnedFingerprint,
    )
    || token.semanticCaseFingerprint !== semanticFingerprint
    || token.pinnedFingerprint !== pinnedFingerprint
    || canonicalJsonString(input.pinned)
      !== canonicalJsonString(candidateProof.pinned)
    || token.environmentFingerprint !== candidateProof.environmentFingerprint
  ) {
    throw new Error('baseline_cache_token_environment_changed');
  }
}

export class EvalCaseStore {
  private readonly persistence: SelfEvolutionPersistenceCapability;
  private readonly databasePath: string;
  private readonly corpusRoot: string;
  private readonly ownsCorpusRoot: boolean;
  private readonly ephemeralCapacity: number;
  private readonly ephemeralCorpusMaxBytes: number;
  private readonly openDatabase: NonNullable<EvalCaseStoreOptions['openDatabase']>;
  private readonly beforeCorpusMetadataWrite?: () => void;
  private readonly ephemeralCases = new Map<string, string>();
  private readonly ephemeralScores = new Map<string, EphemeralScoreEntry>();
  private readonly ephemeralProofs = new Map<string, string>();
  private readonly ephemeralBaselinePointers =
    new Map<string, EphemeralBaselinePointer>();
  private readonly ephemeralCorpus = new Map<string, ManagedTraceCorpusRecordV1>();
  private ephemeralCorpusBytes = 0;
  private database: Database.Database | undefined;

  constructor(options: EvalCaseStoreOptions) {
    this.persistence = options.persistence;
    this.databasePath = options.databasePath
      ?? userDataPath('self_improve', 'eval.db');
    this.ownsCorpusRoot = this.storageMode === 'ephemeral' && !options.corpusRoot;
    this.corpusRoot = options.corpusRoot
      ?? (this.storageMode === 'sqlite'
        ? userDataPath('self_improve', 'eval-corpus')
        : fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-eval-corpus-')));
    this.ephemeralCapacity = Math.max(
      1,
      options.ephemeralCapacity ?? DEFAULT_EPHEMERAL_CAPACITY,
    );
    this.ephemeralCorpusMaxBytes = Math.max(
      1,
      options.ephemeralCorpusMaxBytes ?? DEFAULT_EPHEMERAL_CORPUS_MAX_BYTES,
    );
    this.openDatabase = options.openDatabase
      ?? (databasePath => new Database(databasePath));
    this.beforeCorpusMetadataWrite = options.beforeCorpusMetadataWrite;
  }

  get storageMode(): 'sqlite' | 'ephemeral' {
    return this.persistence.persistence === 'available'
      ? 'sqlite'
      : 'ephemeral';
  }

  get corpusStorageRoot(): string {
    return this.corpusRoot;
  }

  putCase(
    scope: RunManifestScope,
    value: EvalCaseV1,
  ): PutEvalCaseResult {
    const evalCase = parseEvalCase(value);
    assertScope(scope, evalCase.scope, 'eval_case_scope_mismatch');
    const payload = canonicalJsonString(evalCase);
    return this.storageMode === 'sqlite'
      ? this.putCaseSqlite(scope, evalCase, payload)
      : this.putCaseEphemeral(scope, evalCase, payload);
  }

  getCase(
    scope: RunManifestScope,
    caseId: string,
  ): EvalCaseV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT case_json
        FROM eval_cases
        WHERE tenant_id = ? AND workspace_id = ? AND case_id = ?
      `).get(scope.tenantId, scope.workspaceId, caseId) as EvalCaseRow | undefined;
      return row ? parsePayload(row.case_json, parseEvalCase) : undefined;
    }
    const key = caseKey(scope, caseId);
    const payload = this.ephemeralCases.get(key);
    if (!payload) return undefined;
    touchMapValue(this.ephemeralCases, key, payload);
    return parsePayload(payload, parseEvalCase);
  }

  listCases(
    scope: RunManifestScope,
    evalSetId?: string,
  ): EvalCaseV1[] {
    if (this.storageMode === 'sqlite') {
      const rows = (evalSetId
        ? this.db().prepare(`
            SELECT case_json
            FROM eval_cases
            WHERE tenant_id = ? AND workspace_id = ? AND eval_set_id = ?
            ORDER BY created_at, case_id
          `).all(scope.tenantId, scope.workspaceId, evalSetId)
        : this.db().prepare(`
            SELECT case_json
            FROM eval_cases
            WHERE tenant_id = ? AND workspace_id = ?
            ORDER BY created_at, case_id
          `).all(scope.tenantId, scope.workspaceId)) as EvalCaseRow[];
      return rows.map(row => parsePayload(row.case_json, parseEvalCase));
    }
    return [...this.ephemeralCases.values()]
      .map(payload => parsePayload(payload, parseEvalCase))
      .filter(evalCase =>
        sameScope(evalCase.scope, scope)
        && (!evalSetId || evalCase.evalSetId === evalSetId))
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.caseId.localeCompare(right.caseId));
  }

  storeScoreWithProof(
    scope: RunManifestScope,
    scoreValue: EvalScoreV1,
    proofValue: EvaluationEnvironmentProofV1,
  ): StoreEvalScoreResult {
    const score = parseEvalScore(scoreValue);
    assertScope(scope, score.scope, 'eval_score_scope_mismatch');
    const proof = assertEvaluationProofMatchesScore(score, proofValue);
    const evalCase = this.getCase(scope, score.caseId);
    if (!evalCase) throw new Error('eval_score_case_not_found');
    if (evalCase.evalSetId !== score.evalSetId) {
      throw new Error('eval_score_eval_set_mismatch');
    }
    const key = evalScoreKey(score);
    const scorePayload = canonicalJsonString(score);
    const proofPayload = canonicalJsonString(proof);
    return this.storageMode === 'sqlite'
      ? this.storeScoreSqlite(
          scope,
          score,
          proof,
          key,
          scorePayload,
          proofPayload,
        )
      : this.storeScoreEphemeral(
          scope,
          score,
          proof,
          key,
          scorePayload,
          proofPayload,
        );
  }

  getScore(
    scope: RunManifestScope,
    key: string,
  ): EvalScoreV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT score_json, proof_id
        FROM eval_scores
        WHERE tenant_id = ? AND workspace_id = ? AND score_key = ?
      `).get(scope.tenantId, scope.workspaceId, key) as EvalScoreRow | undefined;
      return row ? parsePayload(row.score_json, parseEvalScore) : undefined;
    }
    const scopedKey = scopedScoreKey(scope, key);
    const entry = this.ephemeralScores.get(scopedKey);
    if (!entry) return undefined;
    touchMapValue(this.ephemeralScores, scopedKey, entry);
    return parsePayload(entry.scorePayload, parseEvalScore);
  }

  getProof(
    scope: RunManifestScope,
    proofId: string,
  ): EvaluationEnvironmentProofV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT proof_json
        FROM evaluation_environment_proofs
        WHERE tenant_id = ? AND workspace_id = ? AND proof_id = ?
      `).get(scope.tenantId, scope.workspaceId, proofId) as ProofRow | undefined;
      return row
        ? parsePayload(row.proof_json, parseEvaluationEnvironmentProof)
        : undefined;
    }
    const key = proofKey(scope, proofId);
    const payload = this.ephemeralProofs.get(key);
    if (!payload) return undefined;
    touchMapValue(this.ephemeralProofs, key, payload);
    return parsePayload(payload, parseEvaluationEnvironmentProof);
  }

  getScoreWithProof(
    scope: RunManifestScope,
    key: string,
  ): StoredEvalScore | undefined {
    const score = this.getScore(scope, key);
    if (!score) return undefined;
    const proof = this.getProofForScore(scope, key);
    if (!proof) throw new Error('eval_score_proof_missing');
    assertEvaluationProofMatchesScore(score, proof);
    return {scoreKey: key, score, proof};
  }

  listScores(
    scope: RunManifestScope,
    filter: ListEvalScoresFilter = {},
  ): StoredEvalScore[] {
    const records = this.storageMode === 'sqlite'
      ? (this.db().prepare(`
          SELECT score_key AS scoreKey
          FROM eval_scores
          WHERE tenant_id = ? AND workspace_id = ?
          ORDER BY case_id, attempt, role, run_id, score_key
        `).all(scope.tenantId, scope.workspaceId) as Array<{scoreKey: string}>)
        .map(row => this.getScoreWithProof(scope, row.scoreKey))
        .filter((entry): entry is StoredEvalScore => entry !== undefined)
      : [...this.ephemeralScores.keys()]
        .filter(key => key.startsWith(`${scopeKey(scope)}\0`))
        .map(key => key.slice(scopeKey(scope).length + 1))
        .map(key => this.getScoreWithProof(scope, key))
        .filter((entry): entry is StoredEvalScore => entry !== undefined)
        .sort((left, right) =>
          left.score.caseId.localeCompare(right.score.caseId)
          || left.score.attempt - right.score.attempt
          || left.score.role.localeCompare(right.score.role)
          || left.score.runId.localeCompare(right.score.runId)
          || left.scoreKey.localeCompare(right.scoreKey));
    return records.filter(({score}) =>
      (!filter.caseId || score.caseId === filter.caseId)
      && (!filter.evalSetId || score.evalSetId === filter.evalSetId)
      && (!filter.role || score.role === filter.role)
      && (
        filter.candidateId === undefined
        || score.candidateId === filter.candidateId
      ));
  }

  publishBaseline(
    scope: RunManifestScope,
    caseId: string,
    key: string,
  ): void {
    const evalCase = this.getCase(scope, caseId);
    if (!evalCase) throw new Error('baseline_cache_case_not_found');
    const score = this.getScore(scope, key);
    if (!score || score.caseId !== caseId) {
      throw new Error('baseline_cache_score_not_found');
    }
    if (score.role !== 'baseline' || score.availability !== 'available') {
      throw new Error('baseline_cache_score_not_publishable');
    }
    const proof = this.getProofForScore(scope, key);
    if (!proof) throw new Error('baseline_cache_proof_not_found');
    assertEvaluationProofMatchesScore(score, proof);
    const semanticFingerprint = semanticEvalCaseFingerprint(evalCase);
    const pinnedFingerprint = evalPinnedFingerprint(score.pinned);
    const cacheKey = baselineCacheKey(
      scope,
      semanticFingerprint,
      pinnedFingerprint,
    );
    if (this.storageMode === 'sqlite') {
      this.db().prepare(`
        INSERT INTO baseline_cache (
          cache_key,
          tenant_id,
          workspace_id,
          semantic_case_fingerprint,
          pinned_fingerprint,
          score_key,
          proof_id,
          environment_fingerprint,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, workspace_id, cache_key) DO UPDATE SET
          score_key = excluded.score_key,
          proof_id = excluded.proof_id,
          environment_fingerprint = excluded.environment_fingerprint,
          updated_at = excluded.updated_at
      `).run(
        cacheKey,
        scope.tenantId,
        scope.workspaceId,
        semanticFingerprint,
        pinnedFingerprint,
        key,
        proof.proofId,
        proof.environmentFingerprint,
        Date.now(),
      );
      return;
    }
    const pointer: EphemeralBaselinePointer = {
      cacheKey,
      caseKey: caseKey(scope, caseId),
      semanticCaseFingerprint: semanticFingerprint,
      pinnedFingerprint,
      scoreKey: key,
      proofId: proof.proofId,
      environmentFingerprint: proof.environmentFingerprint,
    };
    touchMapValue(this.ephemeralBaselinePointers, cacheKey, pointer);
    this.evictOldest(this.ephemeralBaselinePointers);
  }

  lookupBaseline(input: {
    scope: RunManifestScope;
    evalCase: EvalCaseV1;
    pinned: EvalPinnedEnvironmentV1;
    currentEnvironmentStart: EvaluationEnvironmentStartV1;
    issuedAt?: string;
  }): BaselineCacheHit | undefined {
    const evalCase = parseEvalCase(input.evalCase);
    assertScope(input.scope, evalCase.scope, 'baseline_cache_scope_mismatch');
    const currentStart = parseEvaluationEnvironmentStart(
      input.currentEnvironmentStart,
    );
    assertScope(
      input.scope,
      currentStart.scope,
      'baseline_cache_start_scope_mismatch',
    );
    if (
      canonicalJsonString(input.pinned)
      !== canonicalJsonString(currentStart.pinned)
    ) {
      throw new Error('baseline_cache_current_start_pinned_mismatch');
    }
    const semanticFingerprint = semanticEvalCaseFingerprint(evalCase);
    const pinnedFingerprint = evalPinnedFingerprint(input.pinned);
    const cacheKey = baselineCacheKey(
      input.scope,
      semanticFingerprint,
      pinnedFingerprint,
    );
    const pointer = this.getBaselinePointer(input.scope, cacheKey);
    if (!pointer) return undefined;
    if (
      pointer.semanticCaseFingerprint !== semanticFingerprint
      || pointer.pinnedFingerprint !== pinnedFingerprint
      || pointer.environmentFingerprint !== currentStart.environmentFingerprint
    ) {
      return undefined;
    }
    const score = this.getScore(input.scope, pointer.scoreKey);
    const proof = this.getProof(input.scope, pointer.proofId);
    if (!score || !proof) return undefined;
    if (
      score.role !== 'baseline'
      || score.availability !== 'available'
      || proof.environmentFingerprint !== pointer.environmentFingerprint
    ) {
      return undefined;
    }
    assertEvaluationProofMatchesScore(score, proof);
    if (proof.environmentFingerprint !== currentStart.environmentFingerprint) {
      return undefined;
    }
    return {
      score,
      proof,
      token: makeBaselineToken(pointer, input.scope, input.issuedAt),
    };
  }

  importTrace(input: ImportManagedTraceInput): ManagedTraceCorpusRecordV1 {
    const sourcePath = path.resolve(input.sourcePath);
    const sourceLstat = fs.lstatSync(sourcePath);
    if (!isRegularFile(sourceLstat)) throw new Error('eval_corpus_source_not_regular');
    const expectedHash = input.expectedContentHash === undefined
      ? undefined
      : validateContentHash(
          input.expectedContentHash,
          'eval_corpus_expected_hash_invalid',
        );
    const sourceDescriptor = openReadNoFollow(sourcePath);
    let temporaryPath: string | undefined;
    let ephemeralPreflight: {
      contentHash: string;
      sizeBytes: number;
    } | undefined;
    try {
      const sourceBefore = fs.fstatSync(sourceDescriptor);
      if (!isRegularFile(sourceBefore)) {
        throw new Error('eval_corpus_source_not_regular');
      }
      if (this.storageMode === 'ephemeral') {
        const preflight = hashFileDescriptor(sourceDescriptor);
        ephemeralPreflight = preflight;
        const sourceAfterPreflight = fs.fstatSync(sourceDescriptor);
        const pathAfterPreflight = fs.lstatSync(sourcePath);
        if (
          !isRegularFile(pathAfterPreflight)
          || !sameSourceIdentity(sourceBefore, sourceAfterPreflight)
          || !sameSourceIdentity(sourceAfterPreflight, pathAfterPreflight)
        ) {
          throw new Error('eval_corpus_source_changed_during_import');
        }
        if (
          expectedHash
          && preflight.contentHash !== expectedHash
        ) {
          throw new Error('eval_corpus_content_hash_mismatch');
        }
        const existing = this.getCorpusMetadata(
          input.scope,
          preflight.contentHash,
        );
        if (existing) {
          if (existing.record.sizeBytes !== preflight.sizeBytes) {
            throw new Error('eval_corpus_metadata_conflict');
          }
          const opened = this.openTrace(input.scope, existing.record.corpusId);
          if (!opened) throw new Error('eval_corpus_metadata_conflict');
          opened.close();
          return existing.record;
        }
        if (
          this.ephemeralCorpusBytes + preflight.sizeBytes
          > this.ephemeralCorpusMaxBytes
        ) {
          throw new Error('eval_corpus_ephemeral_capacity_exceeded');
        }
      }
      const corpusDirectories = ensureCorpusObjectsDirectory(
        this.corpusRoot,
        input.scope,
      );
      const stagingDirectory = corpusDirectories.objects;
      temporaryPath = path.join(
        stagingDirectory,
        `.import-${randomUUID()}.tmp`,
      );
      const targetDescriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let sizeBytes = 0;
      try {
        let bytesRead: number;
        do {
          bytesRead = fs.readSync(
            sourceDescriptor,
            buffer,
            0,
            buffer.length,
            null,
          );
          if (bytesRead > 0) {
            if (
              this.storageMode === 'ephemeral'
              && this.ephemeralCorpusBytes + sizeBytes + bytesRead
                > this.ephemeralCorpusMaxBytes
            ) {
              throw new Error('eval_corpus_source_changed_during_import');
            }
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            let offset = 0;
            while (offset < bytesRead) {
              offset += fs.writeSync(
                targetDescriptor,
                chunk,
                offset,
                bytesRead - offset,
              );
            }
            sizeBytes += bytesRead;
          }
        } while (bytesRead > 0);
        fs.fsyncSync(targetDescriptor);
      } finally {
        fs.closeSync(targetDescriptor);
      }
      const sourceAfter = fs.fstatSync(sourceDescriptor);
      const pathAfter = fs.lstatSync(sourcePath);
      if (
        !isRegularFile(pathAfter)
        || !sameSourceIdentity(sourceBefore, sourceAfter)
        || !sameSourceIdentity(sourceAfter, pathAfter)
      ) {
        throw new Error('eval_corpus_source_changed_during_import');
      }

      const contentHash = hash.digest('hex');
      if (
        ephemeralPreflight
        && (
          ephemeralPreflight.contentHash !== contentHash
          || ephemeralPreflight.sizeBytes !== sizeBytes
        )
      ) {
        throw new Error('eval_corpus_source_changed_during_import');
      }
      if (expectedHash && contentHash !== expectedHash) {
        throw new Error('eval_corpus_content_hash_mismatch');
      }
      const existingMetadata = this.getCorpusMetadata(
        input.scope,
        contentHash,
      );
      if (
        this.storageMode === 'ephemeral'
        && !existingMetadata
        && this.ephemeralCorpusBytes + sizeBytes
          > this.ephemeralCorpusMaxBytes
      ) {
        throw new Error('eval_corpus_ephemeral_capacity_exceeded');
      }
      const relativePath = corpusRelativePath(input.scope, contentHash);
      const finalPath = path.join(stagingDirectory, `${contentHash}.pftrace`);
      if (path.dirname(finalPath) !== stagingDirectory) {
        throw new Error('eval_corpus_path_invariant_failed');
      }
      const importPath = temporaryPath;
      try {
        fs.linkSync(importPath, finalPath);
        fs.chmodSync(finalPath, 0o400);
        fs.unlinkSync(importPath);
        temporaryPath = undefined;
        fsyncDirectory(stagingDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = hashRegularFile(finalPath);
        if (
          existing.contentHash !== contentHash
          || existing.sizeBytes !== sizeBytes
        ) {
          throw new Error('eval_corpus_existing_object_conflict');
        }
        fs.chmodSync(finalPath, 0o400);
        fs.unlinkSync(importPath);
        temporaryPath = undefined;
      }

      if (existingMetadata) {
        if (
          existingMetadata.record.sizeBytes !== sizeBytes
          || existingMetadata.relativePath !== relativePath
        ) {
          throw new Error('eval_corpus_metadata_conflict');
        }
        return existingMetadata.record;
      }
      const record = immutableCanonicalSnapshot<ManagedTraceCorpusRecordV1>({
        schemaVersion: 1,
        corpusId: contentHash,
        scope: {...input.scope},
        contentHash,
        sizeBytes,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      this.beforeCorpusMetadataWrite?.();
      this.putCorpusMetadata(record, relativePath);
      return record;
    } finally {
      fs.closeSync(sourceDescriptor);
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // Best effort cleanup. The unpublished unique temp is never metadata-visible.
        }
      }
    }
  }

  openTrace(
    scope: RunManifestScope,
    corpusId: string,
  ): OpenedManagedTraceCorpus | undefined {
    const metadata = this.getCorpusMetadata(scope, corpusId);
    if (!metadata) return undefined;
    const expectedRelativePath = corpusRelativePath(
      scope,
      metadata.record.contentHash,
    );
    if (metadata.relativePath !== expectedRelativePath) {
      throw new Error('eval_corpus_metadata_path_invalid');
    }
    const {objects} = ensureCorpusObjectsDirectory(this.corpusRoot, scope);
    const absolutePath = path.join(
      objects,
      `${metadata.record.contentHash}.pftrace`,
    );
    const fileDescriptor = openReadNoFollow(absolutePath);
    try {
      const before = fs.lstatSync(absolutePath);
      const opened = fs.fstatSync(fileDescriptor);
      if (
        !isRegularFile(before)
        || !isRegularFile(opened)
        || !sameSourceIdentity(before, opened)
      ) {
        throw new Error('eval_corpus_object_not_regular');
      }
      const resolved = hashFileDescriptor(fileDescriptor);
      if (
        resolved.contentHash !== metadata.record.contentHash
        || resolved.sizeBytes !== metadata.record.sizeBytes
      ) {
        throw new Error('eval_corpus_object_corrupt');
      }
      let closed = false;
      return {
        record: metadata.record,
        fileDescriptor,
        close: () => {
          if (closed) return;
          closed = true;
          fs.closeSync(fileDescriptor);
        },
      };
    } catch (error) {
      fs.closeSync(fileDescriptor);
      throw error;
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    if (this.ownsCorpusRoot) {
      fs.rmSync(this.corpusRoot, {recursive: true, force: true});
    }
  }

  private putCaseSqlite(
    scope: RunManifestScope,
    evalCase: EvalCaseV1,
    payload: string,
  ): PutEvalCaseResult {
    const database = this.db();
    const put = database.transaction(() => {
      const existing = database.prepare(`
        SELECT case_json
        FROM eval_cases
        WHERE tenant_id = ? AND workspace_id = ? AND case_id = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        evalCase.caseId,
      ) as EvalCaseRow | undefined;
      if (existing) {
        if (existing.case_json !== payload) {
          throw new Error(`eval_case_conflict:${evalCase.caseId}`);
        }
        return true;
      }
      database.prepare(`
        INSERT INTO eval_cases (
          tenant_id,
          workspace_id,
          case_id,
          eval_set_id,
          semantic_fingerprint,
          split,
          created_at,
          case_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.workspaceId,
        evalCase.caseId,
        evalCase.evalSetId,
        semanticEvalCaseFingerprint(evalCase),
        evalCase.split,
        evalCase.createdAt,
        payload,
      );
      return false;
    });
    return {
      evalCase,
      storage: 'sqlite',
      idempotent: put.immediate(),
    };
  }

  private putCaseEphemeral(
    scope: RunManifestScope,
    evalCase: EvalCaseV1,
    payload: string,
  ): PutEvalCaseResult {
    const key = caseKey(scope, evalCase.caseId);
    const existing = this.ephemeralCases.get(key);
    if (existing) {
      if (existing !== payload) {
        throw new Error(`eval_case_conflict:${evalCase.caseId}`);
      }
      touchMapValue(this.ephemeralCases, key, payload);
      return {evalCase, storage: 'ephemeral', idempotent: true};
    }
    this.ephemeralCases.set(key, payload);
    this.evictCases();
    return {evalCase, storage: 'ephemeral', idempotent: false};
  }

  private storeScoreSqlite(
    scope: RunManifestScope,
    score: EvalScoreV1,
    proof: EvaluationEnvironmentProofV1,
    key: string,
    scorePayload: string,
    proofPayload: string,
  ): StoreEvalScoreResult {
    const database = this.db();
    const store = database.transaction(() => {
      const existingProof = database.prepare(`
        SELECT proof_json
        FROM evaluation_environment_proofs
        WHERE tenant_id = ? AND workspace_id = ? AND proof_id = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        proof.proofId,
      ) as ProofRow | undefined;
      if (existingProof && existingProof.proof_json !== proofPayload) {
        throw new Error(`evaluation_environment_proof_conflict:${proof.proofId}`);
      }
      const existingScore = database.prepare(`
        SELECT score_json, proof_id
        FROM eval_scores
        WHERE tenant_id = ? AND workspace_id = ? AND score_key = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        key,
      ) as EvalScoreRow | undefined;
      if (existingScore) {
        if (
          existingScore.score_json !== scorePayload
          || existingScore.proof_id !== proof.proofId
        ) {
          throw new Error(`eval_score_conflict:${key}`);
        }
        return true;
      }
      if (!existingProof) {
        database.prepare(`
          INSERT INTO evaluation_environment_proofs (
            proof_id,
            tenant_id,
            workspace_id,
            environment_fingerprint,
            content_hash,
            proof_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          proof.proofId,
          scope.tenantId,
          scope.workspaceId,
          proof.environmentFingerprint,
          proof.contentHash,
          proofPayload,
        );
      }
      database.prepare(`
        INSERT INTO eval_scores (
          score_key,
          tenant_id,
          workspace_id,
          case_id,
          eval_set_id,
          run_id,
          run_manifest_id,
          attempt,
          role,
          candidate_id,
          pinned_fingerprint,
          proof_id,
          score_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key,
        scope.tenantId,
        scope.workspaceId,
        score.caseId,
        score.evalSetId,
        score.runId,
        score.runManifestId,
        score.attempt,
        score.role,
        score.candidateId ?? null,
        evalPinnedFingerprint(score.pinned),
        proof.proofId,
        scorePayload,
      );
      return false;
    });
    return {
      score,
      proof,
      scoreKey: key,
      storage: 'sqlite',
      idempotent: store.immediate(),
    };
  }

  private storeScoreEphemeral(
    scope: RunManifestScope,
    score: EvalScoreV1,
    proof: EvaluationEnvironmentProofV1,
    key: string,
    scorePayload: string,
    proofPayload: string,
  ): StoreEvalScoreResult {
    const scopedKey = scopedScoreKey(scope, key);
    const existing = this.ephemeralScores.get(scopedKey);
    if (existing) {
      if (
        existing.scorePayload !== scorePayload
        || existing.proofPayload !== proofPayload
      ) {
        throw new Error(`eval_score_conflict:${key}`);
      }
      touchMapValue(this.ephemeralScores, scopedKey, existing);
      return {
        score,
        proof,
        scoreKey: key,
        storage: 'ephemeral',
        idempotent: true,
      };
    }
    const scopedProofKey = proofKey(scope, proof.proofId);
    const existingProof = this.ephemeralProofs.get(scopedProofKey);
    if (existingProof && existingProof !== proofPayload) {
      throw new Error(`evaluation_environment_proof_conflict:${proof.proofId}`);
    }
    this.ephemeralProofs.set(scopedProofKey, proofPayload);
    this.ephemeralScores.set(scopedKey, {scorePayload, proofPayload});
    this.evictScores();
    return {
      score,
      proof,
      scoreKey: key,
      storage: 'ephemeral',
      idempotent: false,
    };
  }

  private getProofForScore(
    scope: RunManifestScope,
    key: string,
  ): EvaluationEnvironmentProofV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT proof_id
        FROM eval_scores
        WHERE tenant_id = ? AND workspace_id = ? AND score_key = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        key,
      ) as {proof_id: string} | undefined;
      return row ? this.getProof(scope, row.proof_id) : undefined;
    }
    const entry = this.ephemeralScores.get(scopedScoreKey(scope, key));
    return entry
      ? parsePayload(entry.proofPayload, parseEvaluationEnvironmentProof)
      : undefined;
  }

  private getBaselinePointer(
    scope: RunManifestScope,
    key: string,
  ): {
    cacheKey: string;
    semanticCaseFingerprint: string;
    pinnedFingerprint: string;
    scoreKey: string;
    proofId: string;
    environmentFingerprint: string;
  } | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT *
        FROM baseline_cache
        WHERE tenant_id = ? AND workspace_id = ? AND cache_key = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        key,
      ) as BaselinePointerRow | undefined;
      return row
        ? {
            cacheKey: row.cache_key,
            semanticCaseFingerprint: row.semantic_case_fingerprint,
            pinnedFingerprint: row.pinned_fingerprint,
            scoreKey: row.score_key,
            proofId: row.proof_id,
            environmentFingerprint: row.environment_fingerprint,
          }
        : undefined;
    }
    return this.ephemeralBaselinePointers.get(key);
  }

  private putCorpusMetadata(
    record: ManagedTraceCorpusRecordV1,
    relativePath: string,
  ): void {
    if (this.storageMode === 'sqlite') {
      const database = this.db();
      const put = database.transaction(() => {
        const existing = database.prepare(`
          SELECT *
          FROM eval_trace_corpus
          WHERE tenant_id = ? AND workspace_id = ? AND corpus_id = ?
        `).get(
          record.scope.tenantId,
          record.scope.workspaceId,
          record.corpusId,
        ) as CorpusRow | undefined;
        if (existing) {
          if (
            existing.content_hash !== record.contentHash
            || existing.size_bytes !== record.sizeBytes
            || existing.relative_path !== relativePath
          ) {
            throw new Error('eval_corpus_metadata_conflict');
          }
          return;
        }
        database.prepare(`
          INSERT INTO eval_trace_corpus (
            tenant_id,
            workspace_id,
            corpus_id,
            content_hash,
            size_bytes,
            relative_path,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.scope.tenantId,
          record.scope.workspaceId,
          record.corpusId,
          record.contentHash,
          record.sizeBytes,
          relativePath,
          record.createdAt,
        );
      });
      put.immediate();
      return;
    }
    const key = corpusKey(record.scope, record.corpusId);
    const existing = this.ephemeralCorpus.get(key);
    if (existing) {
      if (
        existing.contentHash !== record.contentHash
        || existing.sizeBytes !== record.sizeBytes
      ) {
        throw new Error('eval_corpus_metadata_conflict');
      }
      return;
    }
    this.ephemeralCorpus.set(key, record);
    this.ephemeralCorpusBytes += record.sizeBytes;
  }

  private getCorpusMetadata(
    scope: RunManifestScope,
    corpusId: string,
  ): {
    record: ManagedTraceCorpusRecordV1;
    relativePath: string;
  } | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT *
        FROM eval_trace_corpus
        WHERE tenant_id = ? AND workspace_id = ? AND corpus_id = ?
      `).get(
        scope.tenantId,
        scope.workspaceId,
        corpusId,
      ) as CorpusRow | undefined;
      if (!row) return undefined;
      return {
        record: immutableCanonicalSnapshot({
          schemaVersion: 1,
          corpusId: row.corpus_id,
          scope: {...scope},
          contentHash: row.content_hash,
          sizeBytes: row.size_bytes,
          createdAt: row.created_at,
        }),
        relativePath: row.relative_path,
      };
    }
    const record = this.ephemeralCorpus.get(corpusKey(scope, corpusId));
    return record
      ? {
          record,
          relativePath: corpusRelativePath(scope, record.contentHash),
        }
      : undefined;
  }

  private evictCases(): void {
    while (this.ephemeralCases.size > this.ephemeralCapacity) {
      const oldest = this.ephemeralCases.keys().next().value as string | undefined;
      if (!oldest) break;
      const payload = this.ephemeralCases.get(oldest);
      this.ephemeralCases.delete(oldest);
      if (payload) {
        const evalCase = parsePayload(payload, parseEvalCase);
        for (const [key, entry] of this.ephemeralScores) {
          const score = parsePayload(entry.scorePayload, parseEvalScore);
          if (
            sameScope(score.scope, evalCase.scope)
            && score.caseId === evalCase.caseId
          ) {
            this.removeEphemeralScore(key, entry);
          }
        }
      }
      for (const [key, pointer] of this.ephemeralBaselinePointers) {
        if (pointer.caseKey === oldest) this.ephemeralBaselinePointers.delete(key);
      }
    }
  }

  private evictScores(): void {
    while (this.ephemeralScores.size > this.ephemeralCapacity) {
      const oldest = this.ephemeralScores.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.ephemeralScores.get(oldest);
      if (entry) this.removeEphemeralScore(oldest, entry);
    }
  }

  private removeEphemeralScore(
    key: string,
    entry: EphemeralScoreEntry,
  ): void {
    this.ephemeralScores.delete(key);
    const proof = parsePayload(
      entry.proofPayload,
      parseEvaluationEnvironmentProof,
    );
    const proofStillReferenced = [...this.ephemeralScores.values()].some(
      candidate => {
        const candidateProof = parsePayload(
          candidate.proofPayload,
          parseEvaluationEnvironmentProof,
        );
        return candidateProof.proofId === proof.proofId
          && sameScope(candidateProof.scope, proof.scope);
      },
    );
    if (!proofStillReferenced) {
      this.ephemeralProofs.delete(proofKey(proof.scope, proof.proofId));
    }
    for (const [pointerKey, pointer] of this.ephemeralBaselinePointers) {
      if (scopedScoreKey(proof.scope, pointer.scoreKey) === key) {
        this.ephemeralBaselinePointers.delete(pointerKey);
      }
    }
  }

  private evictOldest<T>(map: Map<string, T>): void {
    while (map.size > this.ephemeralCapacity) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) break;
      map.delete(oldest);
    }
  }

  private db(): Database.Database {
    if (this.database) return this.database;
    if (this.persistence.persistence !== 'available') {
      throw new Error('eval_case_sqlite_persistence_unavailable');
    }
    fs.mkdirSync(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.database = this.openDatabase(this.databasePath);
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS eval_cases (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        eval_set_id TEXT NOT NULL,
        semantic_fingerprint TEXT NOT NULL,
        split TEXT NOT NULL,
        created_at TEXT NOT NULL,
        case_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, case_id)
      );
      CREATE INDEX IF NOT EXISTS idx_eval_cases_scope_set
        ON eval_cases (tenant_id, workspace_id, eval_set_id, split, created_at);

      CREATE TABLE IF NOT EXISTS evaluation_environment_proofs (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        proof_id TEXT NOT NULL,
        environment_fingerprint TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        proof_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, proof_id)
      );
      CREATE INDEX IF NOT EXISTS idx_eval_environment_scope_fingerprint
        ON evaluation_environment_proofs (
          tenant_id,
          workspace_id,
          environment_fingerprint
        );

      CREATE TABLE IF NOT EXISTS eval_scores (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        score_key TEXT NOT NULL,
        case_id TEXT NOT NULL,
        eval_set_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_manifest_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        role TEXT NOT NULL,
        candidate_id TEXT,
        pinned_fingerprint TEXT NOT NULL,
        proof_id TEXT NOT NULL,
        score_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, score_key),
        FOREIGN KEY (tenant_id, workspace_id, case_id)
          REFERENCES eval_cases(tenant_id, workspace_id, case_id)
          ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, workspace_id, proof_id)
          REFERENCES evaluation_environment_proofs(
            tenant_id,
            workspace_id,
            proof_id
          )
      );
      CREATE INDEX IF NOT EXISTS idx_eval_scores_scope_case
        ON eval_scores (
          tenant_id,
          workspace_id,
          case_id,
          role,
          attempt
        );

      CREATE TABLE IF NOT EXISTS baseline_cache (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        semantic_case_fingerprint TEXT NOT NULL,
        pinned_fingerprint TEXT NOT NULL,
        score_key TEXT NOT NULL,
        proof_id TEXT NOT NULL,
        environment_fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, cache_key),
        UNIQUE (
          tenant_id,
          workspace_id,
          semantic_case_fingerprint,
          pinned_fingerprint
        ),
        FOREIGN KEY (tenant_id, workspace_id, score_key)
          REFERENCES eval_scores(tenant_id, workspace_id, score_key),
        FOREIGN KEY (tenant_id, workspace_id, proof_id)
          REFERENCES evaluation_environment_proofs(
            tenant_id,
            workspace_id,
            proof_id
          )
      );

      CREATE TABLE IF NOT EXISTS eval_trace_corpus (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        corpus_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, corpus_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_trace_corpus_scope_hash
        ON eval_trace_corpus (tenant_id, workspace_id, content_hash);
    `);
    return this.database;
  }
}

let defaultStore: EvalCaseStore | undefined;
let defaultStoreKey: string | undefined;

export function getEvalCaseStore(): EvalCaseStore {
  const persistence = getSelfEvolutionLifecycleSnapshot().persistence;
  const key = canonicalJsonString({
    persistence: persistence.persistence,
    reason: persistence.reason ?? null,
    dataRoot: persistence.dataRoot,
  });
  if (!defaultStore || defaultStoreKey !== key) {
    defaultStore?.close();
    defaultStore = new EvalCaseStore({persistence});
    defaultStoreKey = key;
  }
  return defaultStore;
}

export function resetEvalCaseStoreForTests(): void {
  defaultStore?.close();
  defaultStore = undefined;
  defaultStoreKey = undefined;
}

export const __testing = {
  DEFAULT_EPHEMERAL_CAPACITY,
  DEFAULT_EPHEMERAL_CORPUS_MAX_BYTES,
  baselineCacheKey,
  baselineTokenContentHash,
  caseKey,
  corpusRelativePath,
  proofKey,
  scopeKey,
  scopedScoreKey,
};
