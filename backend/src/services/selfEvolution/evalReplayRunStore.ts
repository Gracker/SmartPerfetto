// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import type {
  EvalPinnedEnvironmentV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {__testing as evalContractTesting} from './evalContracts';

export type ReplayTaskRole = 'baseline' | 'candidate';
export type ReplayTaskState =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'inconclusive'
  | 'cancelled';

export interface ReplayTaskUsageV1 {
  schemaVersion: 1;
  tokens: number;
  toolCalls: number;
  wallclockMs: number;
  traceProcessorCpuMs: number;
}

/**
 * Immutable content binding for the candidate actually injected by a replay.
 * Keeping this on both the run spec and every task prevents a task/result from
 * being detached from the proposal materialization it is supposed to test.
 */
export interface ReplayTreatmentBindingV1 {
  candidateContentHash: string;
  treatmentArtifactContentHash: string;
  materializedInputHash: string;
  fullTreatmentContractHash: string;
}

export interface ReplayTaskRecordV1 {
  schemaVersion: 1;
  taskId: string;
  runId: string;
  runSpecHash: string;
  scope: RunManifestScope;
  caseId: string;
  role: ReplayTaskRole;
  pinned: EvalPinnedEnvironmentV1;
  candidateId?: string;
  treatmentBinding: ReplayTreatmentBindingV1;
  state: ReplayTaskState;
  attempt: number;
  executionToken: string | null;
  completedExecutionToken?: string;
  leaseExpiresAt: number | null;
  absoluteDeadlineAt: number;
  retryCount: number;
  nextEligibleAt: number;
  forcedBaselineRefreshUsed: boolean;
  usage: ReplayTaskUsageV1;
  resultRef?: string;
  inconclusiveReason?: string;
  updatedAt: number;
  contentHash: string;
}

export interface ReplayRunSpecV1 {
  schemaVersion: 1;
  runId: string;
  scope: RunManifestScope;
  caseFingerprints: Array<{
    caseId: string;
    contentHash: string;
  }>;
  pinned: EvalPinnedEnvironmentV1;
  candidateId: string;
  treatmentBinding: ReplayTreatmentBindingV1;
  executionPolicy: {
    concurrency: number;
    taskTimeoutMs: number;
    absoluteRunTimeoutMs: number;
    maxRetries: number;
    rateLimitBackoffMs: number[];
    leaseMs: number;
    abortTimeoutMs: number;
    tolerancePresetContentHash: string;
    executionContractFingerprint: string;
  };
  createdAt: number;
  absoluteDeadlineAt: number;
  contentHash: string;
}

export interface EvalReplayRunStoreOptions {
  persistence: SelfEvolutionPersistenceCapability;
  databasePath?: string;
  openDatabase?: (databasePath: string) => Database.Database;
}

interface ReplayTaskRow {
  task_json: string;
}

interface ReplayRunSpecRow {
  spec_json: string;
}

const ZERO_USAGE: ReplayTaskUsageV1 = {
  schemaVersion: 1,
  tokens: 0,
  toolCalls: 0,
  wallclockMs: 0,
  traceProcessorCpuMs: 0,
};
const TASK_STATES = new Set<ReplayTaskState>([
  'queued',
  'running',
  'pausing',
  'paused',
  'completed',
  'inconclusive',
  'cancelled',
]);

function scopeKey(scope: RunManifestScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

function taskKey(scope: RunManifestScope, taskId: string): string {
  return `${scopeKey(scope)}\0${taskId}`;
}

function contentHash(
  value: Omit<ReplayTaskRecordV1, 'contentHash'>,
): string {
  return canonicalContentHash(value);
}

export function parseReplayTreatmentBindingV1(
  value: ReplayTreatmentBindingV1,
): ReplayTreatmentBindingV1 {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).some(key => ![
      'candidateContentHash',
      'treatmentArtifactContentHash',
      'materializedInputHash',
      'fullTreatmentContractHash',
    ].includes(key))
    || Object.values(value).some(hash =>
      typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
  ) {
    throw new Error('eval_replay_treatment_binding_invalid');
  }
  return immutableCanonicalSnapshot({
    candidateContentHash: value.candidateContentHash,
    treatmentArtifactContentHash: value.treatmentArtifactContentHash,
    materializedInputHash: value.materializedInputHash,
    fullTreatmentContractHash: value.fullTreatmentContractHash,
  });
}

function snapshotTask(
  value: Omit<ReplayTaskRecordV1, 'contentHash'>,
): ReplayTaskRecordV1 {
  const {contentHash: _staleContentHash, ...withoutHash} =
    value as ReplayTaskRecordV1;
  return parseTask(immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: contentHash(withoutHash),
  }));
}

function parseTask(value: unknown): ReplayTaskRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('eval_replay_task_invalid');
  }
  const task = value as ReplayTaskRecordV1;
  const allowedKeys = new Set([
    'schemaVersion',
    'taskId',
    'runId',
    'runSpecHash',
    'scope',
    'caseId',
    'role',
    'pinned',
    'candidateId',
    'treatmentBinding',
    'state',
    'attempt',
    'executionToken',
    'completedExecutionToken',
    'leaseExpiresAt',
    'absoluteDeadlineAt',
    'retryCount',
    'nextEligibleAt',
    'forcedBaselineRefreshUsed',
    'usage',
    'resultRef',
    'inconclusiveReason',
    'updatedAt',
    'contentHash',
  ]);
  const {contentHash: hash, ...withoutHash} = task;
  if (
    task.schemaVersion !== 1
    || Object.keys(task).some(key => !allowedKeys.has(key))
    || !/^[0-9a-f]{64}$/.test(hash)
    || contentHash(withoutHash) !== hash
  ) {
    throw new Error('eval_replay_task_hash_mismatch');
  }
  evalContractTesting.parseScope(task.scope);
  evalContractTesting.parsePinned(task.pinned);
  parseReplayTreatmentBindingV1(task.treatmentBinding);
  const strings = [
    task.taskId,
    task.runId,
    task.runSpecHash,
    task.caseId,
    ...(task.candidateId === undefined ? [] : [task.candidateId]),
    ...(task.resultRef === undefined ? [] : [task.resultRef]),
    ...(task.completedExecutionToken === undefined
      ? []
      : [task.completedExecutionToken]),
    ...(task.inconclusiveReason === undefined
      ? []
      : [task.inconclusiveReason]),
  ];
  const integerNumbers = [
    task.attempt,
    task.absoluteDeadlineAt,
    task.retryCount,
    task.nextEligibleAt,
    task.updatedAt,
    task.usage?.tokens,
    task.usage?.toolCalls,
  ];
  const durationNumbers = [
    task.usage?.wallclockMs,
    task.usage?.traceProcessorCpuMs,
  ];
  if (
    strings.some(entry => typeof entry !== 'string' || !entry.trim())
    || (task.role !== 'baseline' && task.role !== 'candidate')
    || !/^[0-9a-f]{64}$/.test(task.runSpecHash)
    || !TASK_STATES.has(task.state)
    || (task.role === 'candidate' && !task.candidateId)
    || !integerNumbers.every(number =>
      Number.isSafeInteger(number) && (number as number) >= 0)
    || !durationNumbers.every(number =>
      typeof number === 'number'
      && Number.isFinite(number)
      && number >= 0)
    || task.absoluteDeadlineAt <= task.updatedAt
      && (
        task.state === 'queued'
        || task.state === 'running'
        || task.state === 'pausing'
        || task.state === 'paused'
      )
    || task.usage?.schemaVersion !== 1
    || typeof task.forcedBaselineRefreshUsed !== 'boolean'
    || (
      task.executionToken !== null
      && (
        typeof task.executionToken !== 'string'
        || !task.executionToken.trim()
      )
    )
    || (
      task.leaseExpiresAt !== null
      && (
        !Number.isSafeInteger(task.leaseExpiresAt)
        || task.leaseExpiresAt < 0
      )
    )
    || (
      (task.state === 'running' || task.state === 'pausing')
        ? !task.executionToken || task.leaseExpiresAt === null
        : task.executionToken !== null || task.leaseExpiresAt !== null
    )
    || (task.state === 'completed' && !task.resultRef)
    || (
      task.state === 'completed'
        ? !task.completedExecutionToken
        : task.completedExecutionToken !== undefined
    )
    || (task.state === 'inconclusive' && !task.inconclusiveReason)
  ) {
    throw new Error('eval_replay_task_invalid');
  }
  return immutableCanonicalSnapshot(task);
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function normalizeRunSpec(
  value: Omit<ReplayRunSpecV1, 'schemaVersion' | 'contentHash'>,
): ReplayRunSpecV1 {
  const caseFingerprints = [...value.caseFingerprints].sort(
    (left, right) => left.caseId.localeCompare(right.caseId),
  );
  const policy = value.executionPolicy;
  if (
    !value.runId.trim()
    || !value.candidateId.trim()
    || !value.treatmentBinding
    || caseFingerprints.length === 0
    || new Set(caseFingerprints.map(entry => entry.caseId)).size
      !== caseFingerprints.length
    || caseFingerprints.some(entry =>
      !entry.caseId.trim() || !/^[0-9a-f]{64}$/.test(entry.contentHash))
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.absoluteDeadlineAt)
    || value.createdAt < 0
    || value.absoluteDeadlineAt <= value.createdAt
    || value.absoluteDeadlineAt
      !== value.createdAt + policy.absoluteRunTimeoutMs
    || !Number.isSafeInteger(policy.concurrency)
    || policy.concurrency < 1
    || !Number.isSafeInteger(policy.taskTimeoutMs)
    || policy.taskTimeoutMs < 1
    || !Number.isSafeInteger(policy.absoluteRunTimeoutMs)
    || policy.absoluteRunTimeoutMs < 1
    || !Number.isSafeInteger(policy.maxRetries)
    || policy.maxRetries < 0
    || !Array.isArray(policy.rateLimitBackoffMs)
    || policy.rateLimitBackoffMs.some(duration =>
      !Number.isSafeInteger(duration) || duration < 0)
    || !Number.isSafeInteger(policy.leaseMs)
    || policy.leaseMs < 1
    || !Number.isSafeInteger(policy.abortTimeoutMs)
    || policy.abortTimeoutMs < 1
    || !/^[0-9a-f]{64}$/.test(policy.tolerancePresetContentHash)
    || !/^[0-9a-f]{64}$/.test(policy.executionContractFingerprint)
  ) {
    throw new Error('eval_replay_run_spec_invalid');
  }
  const withoutHash = immutableCanonicalSnapshot({
    schemaVersion: 1 as const,
    runId: value.runId,
    scope: evalContractTesting.parseScope(value.scope),
    caseFingerprints,
    pinned: evalContractTesting.parsePinned(value.pinned),
    candidateId: value.candidateId,
    treatmentBinding: parseReplayTreatmentBindingV1(value.treatmentBinding),
    executionPolicy: {
      concurrency: policy.concurrency,
      taskTimeoutMs: policy.taskTimeoutMs,
      absoluteRunTimeoutMs: policy.absoluteRunTimeoutMs,
      maxRetries: policy.maxRetries,
      rateLimitBackoffMs: [...policy.rateLimitBackoffMs],
      leaseMs: policy.leaseMs,
      abortTimeoutMs: policy.abortTimeoutMs,
      tolerancePresetContentHash: policy.tolerancePresetContentHash,
      executionContractFingerprint: policy.executionContractFingerprint,
    },
    createdAt: value.createdAt,
    absoluteDeadlineAt: value.absoluteDeadlineAt,
  });
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseReplayRunSpecV1(value: unknown): ReplayRunSpecV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('eval_replay_run_spec_invalid');
  }
  const spec = value as ReplayRunSpecV1;
  const normalized = normalizeRunSpec({
    runId: spec.runId,
    scope: spec.scope,
    caseFingerprints: spec.caseFingerprints,
    pinned: spec.pinned,
    candidateId: spec.candidateId,
    treatmentBinding: spec.treatmentBinding,
    executionPolicy: spec.executionPolicy,
    createdAt: spec.createdAt,
    absoluteDeadlineAt: spec.absoluteDeadlineAt,
  });
  if (
    spec.schemaVersion !== 1
    || Object.keys(spec).some(key => ![
      'schemaVersion',
      'runId',
      'scope',
      'caseFingerprints',
      'pinned',
      'candidateId',
      'treatmentBinding',
      'executionPolicy',
      'createdAt',
      'absoluteDeadlineAt',
      'contentHash',
    ].includes(key))
    || spec.contentHash !== normalized.contentHash
  ) {
    throw new Error('eval_replay_run_spec_hash_mismatch');
  }
  return normalized;
}

export class EvalReplayRunStore {
  private readonly persistence: SelfEvolutionPersistenceCapability;
  private readonly databasePath: string;
  private readonly openDatabase: NonNullable<
    EvalReplayRunStoreOptions['openDatabase']
  >;
  private readonly ephemeral = new Map<string, string>();
  private readonly ephemeralRunSpecs = new Map<string, string>();
  private database: Database.Database | undefined;

  constructor(options: EvalReplayRunStoreOptions) {
    this.persistence = options.persistence;
    this.databasePath = options.databasePath
      ?? userDataPath('self_improve', 'eval.db');
    this.openDatabase = options.openDatabase
      ?? (databasePath => new Database(databasePath));
  }

  get storageMode(): 'sqlite' | 'ephemeral' {
    return this.persistence.persistence === 'available'
      ? 'sqlite'
      : 'ephemeral';
  }

  putRunSpec(
    input: Omit<ReplayRunSpecV1, 'schemaVersion' | 'contentHash'>,
  ): ReplayRunSpecV1 {
    const spec = normalizeRunSpec(input);
    const payload = canonicalJsonString(spec);
    if (this.storageMode === 'sqlite') {
      const existing = this.db().prepare(`
        SELECT spec_json
        FROM evaluation_replay_run_specs
        WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?
      `).get(
        spec.scope.tenantId,
        spec.scope.workspaceId,
        spec.runId,
      ) as ReplayRunSpecRow | undefined;
      if (existing) {
        const parsed = parseReplayRunSpecV1(JSON.parse(existing.spec_json));
        if (parsed.contentHash !== spec.contentHash) {
          throw new Error('eval_replay_run_spec_conflict');
        }
        return parsed;
      }
      this.db().prepare(`
        INSERT INTO evaluation_replay_run_specs (
          tenant_id,
          workspace_id,
          run_id,
          spec_json,
          content_hash
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        spec.scope.tenantId,
        spec.scope.workspaceId,
        spec.runId,
        payload,
        spec.contentHash,
      );
      return spec;
    }
    const key = `${scopeKey(spec.scope)}\0${spec.runId}`;
    const existing = this.ephemeralRunSpecs.get(key);
    if (existing) {
      const parsed = parseReplayRunSpecV1(JSON.parse(existing));
      if (parsed.contentHash !== spec.contentHash) {
        throw new Error('eval_replay_run_spec_conflict');
      }
      return parsed;
    }
    this.ephemeralRunSpecs.set(key, payload);
    return spec;
  }

  getRunSpec(
    scope: RunManifestScope,
    runId: string,
  ): ReplayRunSpecV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT spec_json
        FROM evaluation_replay_run_specs
        WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?
      `).get(scope.tenantId, scope.workspaceId, runId) as
        | ReplayRunSpecRow
        | undefined;
    return row ? parseReplayRunSpecV1(JSON.parse(row.spec_json)) : undefined;
    }
    const payload = this.ephemeralRunSpecs.get(
      `${scopeKey(scope)}\0${runId}`,
    );
    return payload ? parseReplayRunSpecV1(JSON.parse(payload)) : undefined;
  }

  enqueue(input: {
    runId: string;
    runSpecHash: string;
    scope: RunManifestScope;
    caseId: string;
    role: ReplayTaskRole;
    pinned: EvalPinnedEnvironmentV1;
    candidateId?: string;
    treatmentBinding: ReplayTreatmentBindingV1;
    absoluteDeadlineAt: number;
    initialInconclusiveReason?: string;
    now?: number;
  }): ReplayTaskRecordV1 {
    const now = input.now ?? Date.now();
    if (
      !input.runId
      || !input.caseId
      || !/^[0-9a-f]{64}$/.test(input.runSpecHash)
      || (
        input.initialInconclusiveReason !== undefined
        && !input.initialInconclusiveReason.trim()
      )
      || !Number.isFinite(input.absoluteDeadlineAt)
      || (
        !input.initialInconclusiveReason
        && input.absoluteDeadlineAt <= now
      )
    ) {
      throw new Error('eval_replay_task_input_invalid');
    }
    const runSpec = this.getRunSpec(input.scope, input.runId);
    if (
      !runSpec
      || runSpec.contentHash !== input.runSpecHash
      || canonicalJsonString(runSpec.pinned)
        !== canonicalJsonString(input.pinned)
      || runSpec.candidateId !== input.candidateId
      || canonicalJsonString(runSpec.treatmentBinding)
        !== canonicalJsonString(
          parseReplayTreatmentBindingV1(input.treatmentBinding),
        )
      || runSpec.absoluteDeadlineAt !== input.absoluteDeadlineAt
      || !runSpec.caseFingerprints.some(entry => entry.caseId === input.caseId)
    ) {
      throw new Error('eval_replay_task_run_spec_mismatch');
    }
    const task = snapshotTask({
      schemaVersion: 1,
      taskId: canonicalContentHash({
        runId: input.runId,
        scope: input.scope,
        caseId: input.caseId,
        role: input.role,
      }),
      runId: input.runId,
      runSpecHash: input.runSpecHash,
      scope: {...input.scope},
      caseId: input.caseId,
      role: input.role,
      pinned: immutableCanonicalSnapshot(input.pinned),
      ...(input.candidateId ? {candidateId: input.candidateId} : {}),
      treatmentBinding: parseReplayTreatmentBindingV1(input.treatmentBinding),
      state: input.initialInconclusiveReason ? 'inconclusive' : 'queued',
      attempt: 0,
      executionToken: null,
      leaseExpiresAt: null,
      absoluteDeadlineAt: input.absoluteDeadlineAt,
      retryCount: 0,
      nextEligibleAt: now,
      forcedBaselineRefreshUsed: false,
      usage: {...ZERO_USAGE},
      ...(input.initialInconclusiveReason
        ? {inconclusiveReason: input.initialInconclusiveReason}
        : {}),
      updatedAt: now,
    });
    this.putNew(task);
    return task;
  }

  get(
    scope: RunManifestScope,
    taskId: string,
  ): ReplayTaskRecordV1 | undefined {
    if (this.storageMode === 'sqlite') {
      const row = this.db().prepare(`
        SELECT task_json
        FROM evaluation_replay_tasks
        WHERE tenant_id = ? AND workspace_id = ? AND task_id = ?
      `).get(scope.tenantId, scope.workspaceId, taskId) as
        | ReplayTaskRow
        | undefined;
      return row ? parseTask(JSON.parse(row.task_json)) : undefined;
    }
    const payload = this.ephemeral.get(taskKey(scope, taskId));
    return payload ? parseTask(JSON.parse(payload)) : undefined;
  }

  list(
    scope: RunManifestScope,
    runId?: string,
  ): ReplayTaskRecordV1[] {
    if (this.storageMode === 'sqlite') {
      const rows = (runId
        ? this.db().prepare(`
            SELECT task_json
            FROM evaluation_replay_tasks
            WHERE tenant_id = ? AND workspace_id = ? AND run_id = ?
            ORDER BY task_id
          `).all(scope.tenantId, scope.workspaceId, runId)
        : this.db().prepare(`
            SELECT task_json
            FROM evaluation_replay_tasks
            WHERE tenant_id = ? AND workspace_id = ?
            ORDER BY run_id, task_id
          `).all(scope.tenantId, scope.workspaceId)) as ReplayTaskRow[];
      return rows.map(row => parseTask(JSON.parse(row.task_json)));
    }
    return [...this.ephemeral.values()]
      .map(payload => parseTask(JSON.parse(payload)))
      .filter(task =>
        sameScope(task.scope, scope) && (!runId || task.runId === runId))
      .sort((left, right) =>
        left.runId.localeCompare(right.runId)
        || left.caseId.localeCompare(right.caseId)
        || left.role.localeCompare(right.role)
        || left.taskId.localeCompare(right.taskId));
  }

  claimNext(input: {
    scope: RunManifestScope;
    runId: string;
    leaseMs: number;
    maxConcurrent: number;
    now?: number;
  }): ReplayTaskRecordV1 | undefined {
    const now = input.now ?? Date.now();
    const claim = () => {
      const tasks = this.list(input.scope, input.runId);
      if (
        tasks.filter(task =>
          task.state === 'running' || task.state === 'pausing').length
        >= Math.max(1, Math.floor(input.maxConcurrent))
      ) {
        return undefined;
      }
      const candidates = tasks.filter(task =>
        task.state === 'queued'
        && task.nextEligibleAt <= now
        && task.absoluteDeadlineAt > now);
      for (const candidate of candidates) {
        try {
          return this.compareAndSwap(candidate, {
            ...candidate,
            state: 'running',
            attempt: candidate.attempt + 1,
            executionToken: randomUUID(),
            leaseExpiresAt: Math.min(
              candidate.absoluteDeadlineAt,
              now + Math.max(1, input.leaseMs),
            ),
            updatedAt: now,
          });
        } catch (error) {
          if (
            error instanceof Error
            && error.message === 'eval_replay_task_cas_conflict'
          ) {
            continue;
          }
          throw error;
        }
      }
      return undefined;
    };
    return this.storageMode === 'sqlite'
      ? this.db().transaction(claim).immediate()
      : claim();
  }

  heartbeat(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    leaseMs: number;
    usage?: Partial<Omit<ReplayTaskUsageV1, 'schemaVersion'>>;
    now?: number;
  }): ReplayTaskRecordV1 {
    const current = this.requireOwned(input);
    const now = input.now ?? Date.now();
    return this.compareAndSwap(current, {
      ...current,
      leaseExpiresAt: Math.min(
        current.absoluteDeadlineAt,
        now + Math.max(1, input.leaseMs),
      ),
      usage: {
        schemaVersion: 1,
        tokens: input.usage?.tokens ?? current.usage.tokens,
        toolCalls: input.usage?.toolCalls ?? current.usage.toolCalls,
        wallclockMs: input.usage?.wallclockMs ?? current.usage.wallclockMs,
        traceProcessorCpuMs:
          input.usage?.traceProcessorCpuMs
          ?? current.usage.traceProcessorCpuMs,
      },
      updatedAt: now,
    });
  }

  complete(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    resultRef: string;
    usage: ReplayTaskUsageV1;
    now?: number;
  }): ReplayTaskRecordV1 {
    const current = this.requireOwned(input);
    const {
      inconclusiveReason: _inconclusiveReason,
      ...active
    } = current;
    return this.compareAndSwap(current, {
      ...active,
      state: 'completed',
      executionToken: null,
      completedExecutionToken: input.executionToken,
      leaseExpiresAt: null,
      usage: immutableCanonicalSnapshot(input.usage),
      resultRef: input.resultRef,
      updatedAt: input.now ?? Date.now(),
    });
  }

  inconclusive(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    reason: string;
    usage?: ReplayTaskUsageV1;
    now?: number;
  }): ReplayTaskRecordV1 {
    const current = this.requireOwned(input);
    return this.compareAndSwap(current, {
      ...current,
      state: 'inconclusive',
      executionToken: null,
      leaseExpiresAt: null,
      usage: input.usage ?? current.usage,
      inconclusiveReason: input.reason,
      updatedAt: input.now ?? Date.now(),
    });
  }

  retry(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    nextEligibleAt: number;
    forcedBaselineRefreshUsed?: boolean;
    usage?: ReplayTaskUsageV1;
    now?: number;
  }): ReplayTaskRecordV1 {
    const current = this.requireOwned(input);
    if (input.nextEligibleAt >= current.absoluteDeadlineAt) {
      return this.inconclusive({
        ...input,
        reason: 'retry_deadline_exhausted',
      });
    }
    return this.compareAndSwap(current, {
      ...current,
      state: 'queued',
      executionToken: null,
      leaseExpiresAt: null,
      retryCount: current.retryCount + 1,
      nextEligibleAt: input.nextEligibleAt,
      usage: input.usage ?? current.usage,
      forcedBaselineRefreshUsed:
        input.forcedBaselineRefreshUsed
        ?? current.forcedBaselineRefreshUsed,
      updatedAt: input.now ?? Date.now(),
    });
  }

  pauseRun(
    scope: RunManifestScope,
    runId: string,
    now = Date.now(),
  ): ReplayTaskRecordV1[] {
    return this.transitionRun(scope, runId, now, task => {
      if (task.state !== 'queued' && task.state !== 'running') return task;
      return {
        ...task,
        state: task.state === 'running' ? 'pausing' : 'paused',
      };
    });
  }

  settlePausing(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    cleanupConfirmed: boolean;
    usage: ReplayTaskUsageV1;
    now?: number;
  }): ReplayTaskRecordV1 {
    const current = this.get(input.scope, input.taskId);
    if (!current) throw new Error('eval_replay_task_not_found');
    if (
      current.state !== 'pausing'
      || current.executionToken !== input.executionToken
    ) {
      throw new Error('eval_replay_execution_fence_lost');
    }
    const now = input.now ?? Date.now();
    const deadlineExhausted = current.absoluteDeadlineAt <= now;
    return this.compareAndSwap(current, {
      ...current,
      state: !input.cleanupConfirmed || deadlineExhausted
        ? 'inconclusive'
        : 'paused',
      executionToken: null,
      leaseExpiresAt: null,
      usage: immutableCanonicalSnapshot(input.usage),
      nextEligibleAt: now,
      ...(!input.cleanupConfirmed
        ? {inconclusiveReason: 'evaluation_attempt_cleanup_timeout'}
        : deadlineExhausted
          ? {inconclusiveReason: 'absolute_deadline_exhausted'}
          : {}),
      updatedAt: now,
    });
  }

  resumeRun(
    scope: RunManifestScope,
    runId: string,
    now = Date.now(),
  ): ReplayTaskRecordV1[] {
    return this.transitionRun(
      scope,
      runId,
      now,
      task => {
        if (task.state !== 'paused') return task;
        return {
          ...task,
          state: task.absoluteDeadlineAt <= now ? 'inconclusive' : 'queued',
          nextEligibleAt: now,
          ...(task.absoluteDeadlineAt <= now
            ? {inconclusiveReason: 'absolute_deadline_exhausted'}
            : {}),
        };
      },
      tasks => {
        if (tasks.some(task => task.state === 'pausing')) {
          throw new Error('evaluation_run_pause_cleanup_pending');
        }
      },
    );
  }

  cancelRun(
    scope: RunManifestScope,
    runId: string,
    now = Date.now(),
  ): ReplayTaskRecordV1[] {
    return this.transitionRun(scope, runId, now, task => {
      if (
        task.state === 'completed'
        || task.state === 'inconclusive'
        || task.state === 'cancelled'
      ) {
        return task;
      }
      return {
        ...task,
        state: 'cancelled',
        executionToken: null,
        leaseExpiresAt: null,
      };
    });
  }

  recoverExpired(
    scope: RunManifestScope,
    now = Date.now(),
  ): ReplayTaskRecordV1[] {
    const recover = () => this.list(scope).flatMap(task => {
      if (
        (task.state !== 'running' && task.state !== 'pausing')
        || task.leaseExpiresAt === null
        || task.leaseExpiresAt > now
      ) {
        return [];
      }
      return [this.compareAndSwap(task, {
        ...task,
        state: 'inconclusive',
        executionToken: null,
        leaseExpiresAt: null,
        inconclusiveReason: task.absoluteDeadlineAt <= now
          ? 'absolute_deadline_exhausted'
          : task.state === 'pausing'
            ? 'evaluation_pause_cleanup_unconfirmed'
            : 'evaluation_execution_cleanup_unconfirmed',
        updatedAt: now,
      })];
    });
    return this.storageMode === 'sqlite'
      ? this.db().transaction(recover).immediate()
      : recover();
  }

  expireDeadlines(
    scope: RunManifestScope,
    runId: string,
    now = Date.now(),
  ): ReplayTaskRecordV1[] {
    return this.transitionRun(scope, runId, now, task => {
      if (
        task.absoluteDeadlineAt > now
        || (
          task.state !== 'queued'
          && task.state !== 'paused'
          && task.state !== 'running'
          && task.state !== 'pausing'
        )
      ) {
        return task;
      }
      return {
        ...task,
        state: 'inconclusive',
        executionToken: null,
        leaseExpiresAt: null,
        inconclusiveReason: 'absolute_deadline_exhausted',
      };
    });
  }

  isAuthoritative(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
  }): boolean {
    const current = this.get(input.scope, input.taskId);
    return Boolean(
      current
      && current.state === 'running'
      && current.executionToken === input.executionToken,
    );
  }

  isPublicationCommitted(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
    resultRef: string;
  }): boolean {
    const current = this.get(input.scope, input.taskId);
    return Boolean(
      current
      && current.state === 'completed'
      && current.resultRef === input.resultRef
      && current.executionToken === null
      && current.completedExecutionToken === input.executionToken,
    );
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private requireOwned(input: {
    scope: RunManifestScope;
    taskId: string;
    executionToken: string;
  }): ReplayTaskRecordV1 {
    const current = this.get(input.scope, input.taskId);
    if (!current) throw new Error('eval_replay_task_not_found');
    if (
      current.state !== 'running'
      || current.executionToken !== input.executionToken
    ) {
      throw new Error('eval_replay_execution_fence_lost');
    }
    return current;
  }

  private transitionRun(
    scope: RunManifestScope,
    runId: string,
    now: number,
    transition: (
      task: ReplayTaskRecordV1,
    ) => Omit<ReplayTaskRecordV1, 'contentHash'>,
    validate?: (tasks: readonly ReplayTaskRecordV1[]) => void,
  ): ReplayTaskRecordV1[] {
    const applyTransitions = () => {
      const tasks = this.list(scope, runId);
      validate?.(tasks);
      return tasks.map(task => {
        const changed = transition(task);
        if (canonicalJsonString(changed) === canonicalJsonString(task)) {
          return task;
        }
        return this.compareAndSwap(task, {...changed, updatedAt: now});
      });
    };
    return this.storageMode === 'sqlite'
      ? this.db().transaction(applyTransitions).immediate()
      : applyTransitions();
  }

  private putNew(task: ReplayTaskRecordV1): void {
    const payload = canonicalJsonString(task);
    if (this.storageMode === 'sqlite') {
      try {
        this.db().prepare(`
          INSERT INTO evaluation_replay_tasks (
            tenant_id,
            workspace_id,
            task_id,
            run_id,
            state,
            next_eligible_at,
            task_json,
            content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.scope.tenantId,
          task.scope.workspaceId,
          task.taskId,
          task.runId,
          task.state,
          task.nextEligibleAt,
          payload,
          task.contentHash,
        );
      } catch (error) {
        if ((error as {code?: string}).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new Error('eval_replay_task_conflict');
        }
        throw error;
      }
      return;
    }
    const key = taskKey(task.scope, task.taskId);
    if (this.ephemeral.has(key)) throw new Error('eval_replay_task_conflict');
    this.ephemeral.set(key, payload);
  }

  private compareAndSwap(
    expected: ReplayTaskRecordV1,
    nextValue: Omit<ReplayTaskRecordV1, 'contentHash'>,
  ): ReplayTaskRecordV1 {
    const next = snapshotTask(nextValue);
    if (this.storageMode === 'sqlite') {
      const result = this.db().prepare(`
        UPDATE evaluation_replay_tasks
        SET state = ?, next_eligible_at = ?, task_json = ?, content_hash = ?
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND task_id = ?
          AND content_hash = ?
      `).run(
        next.state,
        next.nextEligibleAt,
        canonicalJsonString(next),
        next.contentHash,
        expected.scope.tenantId,
        expected.scope.workspaceId,
        expected.taskId,
        expected.contentHash,
      );
      if (result.changes !== 1) throw new Error('eval_replay_task_cas_conflict');
      return next;
    }
    const key = taskKey(expected.scope, expected.taskId);
    const current = this.ephemeral.get(key);
    if (!current || parseTask(JSON.parse(current)).contentHash !== expected.contentHash) {
      throw new Error('eval_replay_task_cas_conflict');
    }
    this.ephemeral.set(key, canonicalJsonString(next));
    return next;
  }

  private db(): Database.Database {
    if (this.database) return this.database;
    fs.mkdirSync(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.database = this.openDatabase(this.databasePath);
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_replay_run_specs (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS evaluation_replay_tasks (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        next_eligible_at INTEGER NOT NULL,
        task_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_evaluation_replay_ready
        ON evaluation_replay_tasks (
          tenant_id,
          workspace_id,
          run_id,
          state,
          next_eligible_at
        );
    `);
    return this.database;
  }
}
