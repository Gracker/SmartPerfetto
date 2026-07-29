// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import {
  EvalReplayRunStore,
  type ReplayTaskRecordV1,
  type ReplayTaskRole,
  type ReplayTaskUsageV1,
} from './evalReplayRunStore';
import {
  scoreFrozenEvaluationArtifacts,
  type FrozenEvaluationArtifactsV1,
} from './evalScorer';
import {
  attestEvaluationPair,
  type EvaluationPairAttestationV1,
  type EvaluationRoleProofV2,
} from './evaluationPairAttestation';
import type {
  EvaluationRoleInjectionContractV1,
} from './evaluationInjectionContext';
import type {EvaluationEnvironmentProofV1} from './evaluationEnvironmentProof';
import {
  evaluationUsageReceiptFromError,
  type EvaluationUsageReceiptV1,
} from './evaluationTelemetry';
import {
  FRESH_LLM_TOLERANCE_PRESET_V1,
  normalizeEvalReplayTolerancePreset,
  paretoCompareEvalScores,
  type EvalParetoResult,
  type EvalReplayTolerancePresetV1,
} from './paretoCompare';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';

const TRANSIENT_ERROR_CODES = new Set([
  'provider_rate_limited',
  'provider_unavailable',
  'trace_processor_temporarily_unavailable',
  'evaluation_worker_interrupted',
]);

export interface ReplayExecutorInput {
  replayRunId: string;
  evalCase: EvalCaseV1;
  role: ReplayTaskRole;
  candidateId?: string;
  pinned: EvalPinnedEnvironmentV1;
  attempt: number;
  priorUsage: ReplayTaskUsageV1;
  signal: AbortSignal;
  isAuthoritative: () => boolean;
}

export interface ReplayExecutorResult {
  artifacts: FrozenEvaluationArtifactsV1;
  environmentProof: EvaluationEnvironmentProofV1;
  roleProof: EvaluationRoleProofV2;
  roleContract: EvaluationRoleInjectionContractV1;
  fullTreatmentContractHash: string;
}

export interface PublishedReplayResult {
  score: EvalScoreV1;
  roleProof: EvaluationRoleProofV2;
  roleContract: EvaluationRoleInjectionContractV1;
  fullTreatmentContractHash: string;
}

export interface EvaluationPublicationFenceV1 {
  taskId: string;
  executionToken: string;
}

export interface ReplayExecutor {
  execute(input: ReplayExecutorInput): Promise<ReplayExecutorResult>;
  abort?(input: {
    runId: string;
    caseId: string;
    role: ReplayTaskRole;
  }): void | Promise<void>;
}

export interface ReplayResultPublisher {
  lookupBaseline?(input: {
    evalCase: EvalCaseV1;
    pinned: EvalPinnedEnvironmentV1;
    candidateId: string;
  }): Promise<{
    score: EvalScoreV1;
    environmentProof: EvaluationEnvironmentProofV1;
    roleProof: EvaluationRoleProofV2;
    roleContract: EvaluationRoleInjectionContractV1;
    fullTreatmentContractHash: string;
    resultRef: string;
  } | undefined>;
  publish(input: {
    score: EvalScoreV1;
    environmentProof: EvaluationEnvironmentProofV1;
    roleProof: EvaluationRoleProofV2;
    roleContract: EvaluationRoleInjectionContractV1;
    fullTreatmentContractHash: string;
    frozenArtifactsHash: string;
    executionFence: EvaluationPublicationFenceV1;
    isAuthoritative: () => boolean;
  }): Promise<string>;
  commitPublication?(input: {
    scope: RunManifestScope;
    resultRef: string;
  }): Promise<void>;
  loadPublished?(input: {
    scope: RunManifestScope;
    resultRef: string;
  }): Promise<PublishedReplayResult | undefined>;
}

export interface ReplayRunnerOptions {
  store: EvalReplayRunStore;
  executor: ReplayExecutor;
  publisher: ReplayResultPublisher;
  concurrency: number;
  taskTimeoutMs: number;
  absoluteRunTimeoutMs: number;
  maxRetries?: number;
  rateLimitBackoffMs?: readonly number[];
  leaseMs?: number;
  abortTimeoutMs?: number;
  tolerancePreset?: EvalReplayTolerancePresetV1;
  executionContractFingerprint: string;
  now?: () => number;
  resolveEvalCase?: (
    scope: RunManifestScope,
    caseId: string,
  ) => EvalCaseV1 | undefined | Promise<EvalCaseV1 | undefined>;
}

export interface ReplayRunInput {
  scope: RunManifestScope;
  cases: EvalCaseV1[];
  pinned: EvalPinnedEnvironmentV1;
  candidateId: string;
}

export interface ReplayRunResult {
  runId: string;
  tasks: ReplayTaskRecordV1[];
  comparisons: Record<string, EvalParetoResult>;
  attestations: Record<string, EvaluationPairAttestationV1>;
}

interface RoleProofRecord {
  proof: EvaluationRoleProofV2;
  contract: EvaluationRoleInjectionContractV1;
  fullTreatmentContractHash: string;
}

function errorCode(error: unknown): string {
  if (
    error
    && typeof error === 'object'
    && 'status' in error
    && error.status === 429
  ) {
    return 'provider_rate_limited';
  }
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    const code = error.code.toLowerCase();
    if (code.includes('rate') || code === '429') {
      return 'provider_rate_limited';
    }
    if (
      code === 'econnreset'
      || code === 'etimedout'
      || code === 'econnrefused'
      || code === 'ehostunreach'
      || code === 'enetwork'
    ) {
      return 'provider_unavailable';
    }
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes('rate limit')
    || normalized.includes('too many requests')
    || /\b429\b/.test(normalized)
  ) {
    return 'provider_rate_limited';
  }
  if (
    normalized.includes('provider')
    && (
      normalized.includes('unavailable')
      || normalized.includes('connection')
      || normalized.includes('timeout')
    )
  ) {
    return 'provider_unavailable';
  }
  if (
    normalized.includes('trace')
    && (
      normalized.includes('missing')
      || normalized.includes('not found')
      || normalized.includes('corrupt')
    )
  ) {
    return 'trace_missing';
  }
  return message.split(':', 1)[0];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForBoundedAbort(
  abort: void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(abort).catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sameScope(
  left: RunManifestScope,
  right: RunManifestScope,
): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function assertResolvedCase(
  task: Pick<ReplayTaskRecordV1, 'caseId' | 'scope'>,
  evalCase: EvalCaseV1,
  expectedContentHash: string,
): EvalCaseV1 {
  if (
    evalCase.caseId !== task.caseId
    || !sameScope(evalCase.scope, task.scope)
    || canonicalContentHash(evalCase) !== expectedContentHash
  ) {
    throw new Error('evaluation_case_resolution_mismatch');
  }
  return evalCase;
}

export class ReplayRunner {
  private readonly store: EvalReplayRunStore;
  private readonly executor: ReplayExecutor;
  private readonly publisher: ReplayResultPublisher;
  private readonly concurrency: number;
  private readonly taskTimeoutMs: number;
  private readonly absoluteRunTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimitBackoffMs: readonly number[];
  private readonly leaseMs: number;
  private readonly abortTimeoutMs: number;
  private readonly tolerancePreset: EvalReplayTolerancePresetV1;
  private readonly executionContractFingerprint: string;
  private readonly now: () => number;
  private readonly resolveEvalCase?: ReplayRunnerOptions['resolveEvalCase'];
  private readonly controllers = new Map<string, AbortController>();
  private readonly casesByRun = new Map<string, Map<string, EvalCaseV1>>();
  private readonly scoresByRun = new Map<string, Map<string, EvalScoreV1>>();
  private readonly proofsByRun = new Map<string, Map<string, RoleProofRecord>>();

  constructor(options: ReplayRunnerOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.publisher = options.publisher;
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.taskTimeoutMs = Math.max(1, options.taskTimeoutMs);
    this.absoluteRunTimeoutMs = Math.max(1, options.absoluteRunTimeoutMs);
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.rateLimitBackoffMs = options.rateLimitBackoffMs
      ?? [1_000, 5_000, 15_000];
    this.leaseMs = Math.max(this.taskTimeoutMs + 1_000, options.leaseMs ?? 60_000);
    this.abortTimeoutMs = Math.max(1, options.abortTimeoutMs ?? 2_000);
    this.tolerancePreset = normalizeEvalReplayTolerancePreset(
      options.tolerancePreset ?? FRESH_LLM_TOLERANCE_PRESET_V1,
    );
    if (!/^[0-9a-f]{64}$/.test(options.executionContractFingerprint)) {
      throw new Error('evaluation_execution_contract_fingerprint_invalid');
    }
    this.executionContractFingerprint = options.executionContractFingerprint;
    this.now = options.now ?? Date.now;
    this.resolveEvalCase = options.resolveEvalCase;
  }

  private executionPolicy() {
    return {
      concurrency: this.concurrency,
      taskTimeoutMs: this.taskTimeoutMs,
      absoluteRunTimeoutMs: this.absoluteRunTimeoutMs,
      maxRetries: this.maxRetries,
      rateLimitBackoffMs: [...this.rateLimitBackoffMs],
      leaseMs: this.leaseMs,
      abortTimeoutMs: this.abortTimeoutMs,
      tolerancePresetContentHash: this.tolerancePreset.contentHash,
      executionContractFingerprint: this.executionContractFingerprint,
    };
  }

  async run(input: ReplayRunInput): Promise<ReplayRunResult> {
    if (input.cases.length === 0) throw new Error('evaluation_cases_empty');
    if (!input.candidateId.trim()) {
      throw new Error('evaluation_candidate_id_missing');
    }
    const caseIds = input.cases.map(evalCase => evalCase.caseId);
    if (
      new Set(caseIds).size !== caseIds.length
      || input.cases.some(evalCase => !sameScope(evalCase.scope, input.scope))
    ) {
      throw new Error('evaluation_cases_scope_or_identity_invalid');
    }
    const runId = randomUUID();
    const createdAt = this.now();
    const deadline = createdAt + this.absoluteRunTimeoutMs;
    const runSpec = this.store.putRunSpec({
      runId,
      scope: input.scope,
      caseFingerprints: input.cases.map(evalCase => ({
        caseId: evalCase.caseId,
        contentHash: canonicalContentHash(evalCase),
      })),
      pinned: input.pinned,
      candidateId: input.candidateId,
      executionPolicy: this.executionPolicy(),
      createdAt,
      absoluteDeadlineAt: deadline,
    });
    this.casesByRun.set(
      runId,
      new Map(input.cases.map(evalCase => [evalCase.caseId, evalCase])),
    );
    this.scoresByRun.set(runId, new Map());
    this.proofsByRun.set(runId, new Map());
    for (const evalCase of input.cases) {
      this.store.enqueue({
        runId,
        runSpecHash: runSpec.contentHash,
        scope: input.scope,
        caseId: evalCase.caseId,
        role: 'baseline',
        pinned: input.pinned,
        candidateId: input.candidateId,
        absoluteDeadlineAt: deadline,
        now: this.now(),
      });
    }
    return this.processRun(input.scope, runId);
  }

  async resume(
    scope: RunManifestScope,
    runId: string,
  ): Promise<ReplayRunResult> {
    const tasks = this.store.list(scope, runId);
    if (tasks.length === 0) throw new Error('evaluation_run_not_found');
    const runSpec = this.store.getRunSpec(scope, runId);
    if (
      !runSpec
      || canonicalJsonString(runSpec.executionPolicy)
        !== canonicalJsonString(this.executionPolicy())
      || tasks.some(task => task.runSpecHash !== runSpec.contentHash)
    ) {
      throw new Error('evaluation_run_spec_resume_mismatch');
    }
    if (tasks.some(task => task.state === 'pausing')) {
      throw new Error('evaluation_run_pause_cleanup_pending');
    }
    this.store.resumeRun(scope, runId, this.now());
    this.scoresByRun.set(runId, new Map());
    this.proofsByRun.set(runId, new Map());
    return this.processRun(scope, runId);
  }

  pause(scope: RunManifestScope, runId: string): void {
    this.store.pauseRun(scope, runId, this.now());
    this.abortControllers(scope, runId, 'evaluation_paused');
  }

  cancel(scope: RunManifestScope, runId: string): void {
    this.store.cancelRun(scope, runId, this.now());
    this.abortControllers(scope, runId, 'evaluation_cancelled');
    this.cleanupRunContext(runId);
  }

  private async processRun(
    scope: RunManifestScope,
    runId: string,
  ): Promise<ReplayRunResult> {
    this.store.recoverExpired(scope, this.now());
    this.store.expireDeadlines(scope, runId, this.now());
    await this.drainWorkers(scope, runId);
    let tasks = this.store.list(scope, runId);
    await this.loadCompletedScores(scope, runId, tasks);
    if (await this.enqueueCandidatePhase(scope, runId, tasks)) {
      await this.drainWorkers(scope, runId);
      tasks = this.store.list(scope, runId);
      await this.loadCompletedScores(scope, runId, tasks);
    }
    const scoreMap = this.scoresByRun.get(runId) ?? new Map();
    const comparisons: Record<string, EvalParetoResult> = {};
    const attestations: Record<string, EvaluationPairAttestationV1> = {};
    const proofMap = this.proofsByRun.get(runId) ?? new Map();
    const caseIds = [...new Set(tasks.map(task => task.caseId))].sort();
    for (const caseId of caseIds) {
      const baselineProof = proofMap.get(`${caseId}\0baseline`);
      const candidateProof = proofMap.get(`${caseId}\0candidate`);
      if (!baselineProof || !candidateProof) {
        comparisons[caseId] = {
          status: 'inconclusive',
          reason: 'pair_attestation_unavailable',
        };
        continue;
      }
      try {
        if (
          baselineProof.fullTreatmentContractHash
          !== candidateProof.fullTreatmentContractHash
        ) {
          throw new Error('evaluation_pair_treatment_contract_mismatch');
        }
        attestations[caseId] = attestEvaluationPair({
          baseline: baselineProof.proof,
          candidate: candidateProof.proof,
          baselineContract: baselineProof.contract,
          candidateContract: candidateProof.contract,
          fullTreatmentContractHash:
            baselineProof.fullTreatmentContractHash,
        });
        comparisons[caseId] = paretoCompareEvalScores({
          baseline: scoreMap.get(`${caseId}\0baseline`),
          candidate: scoreMap.get(`${caseId}\0candidate`),
          tolerances: this.tolerancePreset.tolerances,
        });
      } catch (error) {
        comparisons[caseId] = {
          status: 'inconclusive',
          reason: errorCode(error),
        };
      }
    }
    if (tasks.every(task =>
      task.state === 'completed'
      || task.state === 'inconclusive'
      || task.state === 'cancelled')) {
      this.cleanupRunContext(runId);
    }
    return {runId, tasks, comparisons, attestations};
  }

  private async drainWorkers(
    scope: RunManifestScope,
    runId: string,
  ): Promise<void> {
    await Promise.all(
      Array.from({length: this.concurrency}, () =>
        this.worker(scope, runId)),
    );
  }

  private async enqueueCandidatePhase(
    scope: RunManifestScope,
    runId: string,
    tasks: readonly ReplayTaskRecordV1[],
  ): Promise<boolean> {
    const candidateCaseIds = new Set(
      tasks.filter(task => task.role === 'candidate').map(task => task.caseId),
    );
    const scoreMap = this.scoresByRun.get(runId) ?? new Map();
    let added = false;
    for (const baseline of tasks.filter(task => task.role === 'baseline')) {
      if (candidateCaseIds.has(baseline.caseId)) continue;
      if (
        baseline.state !== 'completed'
        && baseline.state !== 'inconclusive'
        && baseline.state !== 'cancelled'
      ) {
        continue;
      }
      const score = scoreMap.get(`${baseline.caseId}\0baseline`);
      const l0Passed = score?.availability === 'available'
        && Object.values(score.l0).every(Boolean);
      const runnable = baseline.state === 'completed'
        && l0Passed
        && baseline.absoluteDeadlineAt > this.now();
      try {
        this.store.enqueue({
          runId,
          runSpecHash: baseline.runSpecHash,
          scope,
          caseId: baseline.caseId,
          role: 'candidate',
          pinned: baseline.pinned,
          candidateId: baseline.candidateId,
          absoluteDeadlineAt: baseline.absoluteDeadlineAt,
          ...(runnable
            ? {}
            : {
                initialInconclusiveReason: l0Passed
                  ? 'absolute_deadline_exhausted'
                  : 'baseline_l0_early_stop',
              }),
          now: this.now(),
        });
        added = true;
      } catch (error) {
        if (
          !(error instanceof Error)
          || error.message !== 'eval_replay_task_conflict'
        ) {
          throw error;
        }
      }
    }
    return added;
  }

  private async worker(
    scope: RunManifestScope,
    runId: string,
  ): Promise<void> {
    for (;;) {
      this.store.expireDeadlines(scope, runId, this.now());
      const task = this.store.claimNext({
        scope,
        runId,
        leaseMs: this.leaseMs,
        maxConcurrent: this.concurrency,
        now: this.now(),
      });
      if (!task) {
        const remaining = this.store.list(scope, runId).filter(candidate =>
          candidate.state === 'queued' || candidate.state === 'running');
        if (remaining.length === 0) return;
        const next = remaining
          .filter(candidate => candidate.state === 'queued')
          .reduce(
            (minimum, candidate) =>
              Math.min(minimum, candidate.nextEligibleAt),
            Number.POSITIVE_INFINITY,
          );
        await delay(
          Number.isFinite(next)
            ? Math.max(1, Math.min(50, next - this.now()))
            : 10,
        );
        continue;
      }
      await this.executeTask(task);
    }
  }

  private async executeTask(task: ReplayTaskRecordV1): Promise<void> {
    const token = task.executionToken;
    if (!token) throw new Error('eval_replay_execution_token_missing');
    const settlePausingIfNeeded = (
      usage: ReplayTaskUsageV1,
      cleanupConfirmed = true,
    ): boolean => {
      const current = this.store.get(task.scope, task.taskId);
      if (
        current?.state !== 'pausing'
        || current.executionToken !== token
      ) {
        return false;
      }
      try {
        this.store.settlePausing({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
          cleanupConfirmed,
          usage,
          now: this.now(),
        });
        return true;
      } catch (error) {
        if (
          error instanceof Error
          && error.message === 'eval_replay_execution_fence_lost'
        ) {
          return false;
        }
        throw error;
      }
    };
    let evalCase: EvalCaseV1 | undefined;
    try {
      evalCase = await this.resolveCase(task);
    } catch (error) {
      if (
        settlePausingIfNeeded(task.usage)
        || !this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        })
      ) {
        return;
      }
      this.store.inconclusive({
        scope: task.scope,
        taskId: task.taskId,
        executionToken: token,
        reason: errorCode(error),
        now: this.now(),
      });
      return;
    }
    if (
      settlePausingIfNeeded(task.usage)
      || !this.store.isAuthoritative({
        scope: task.scope,
        taskId: task.taskId,
        executionToken: token,
      })
    ) {
      return;
    }
    if (!evalCase) {
      this.store.inconclusive({
        scope: task.scope,
        taskId: task.taskId,
        executionToken: token,
        reason: 'evaluation_run_context_missing',
        now: this.now(),
      });
      return;
    }
    if (task.role === 'baseline' && this.publisher.lookupBaseline) {
      const cached = await this.publisher.lookupBaseline({
        evalCase,
        pinned: task.pinned,
        candidateId: task.candidateId ?? '',
      });
      if (
        settlePausingIfNeeded(task.usage)
        || !this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        })
      ) {
        return;
      }
      if (cached) {
        this.store.complete({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
          resultRef: cached.resultRef,
          usage: {
            schemaVersion: 1,
            tokens: 0,
            toolCalls: 0,
            wallclockMs: 0,
            traceProcessorCpuMs: 0,
          },
          now: this.now(),
        });
        this.scoresByRun.get(task.runId)?.set(
          `${task.caseId}\0baseline`,
          cached.score,
        );
        this.proofsByRun.get(task.runId)?.set(
          `${task.caseId}\0baseline`,
          {
            proof: cached.roleProof,
            contract: cached.roleContract,
            fullTreatmentContractHash: cached.fullTreatmentContractHash,
          },
        );
        return;
      }
    }
    const controller = new AbortController();
    this.controllers.set(task.taskId, controller);
    const timeoutMs = Math.max(
      1,
      Math.min(this.taskTimeoutMs, task.absoluteDeadlineAt - this.now()),
    );
    const timeout = setTimeout(
      () => controller.abort('evaluation_timeout'),
      timeoutMs,
    );
    timeout.unref?.();
    let abortHookPromise: Promise<void> | undefined;
    let currentAttemptUsage = task.usage;
    const requestExecutorAbort = () => {
      abortHookPromise ??= Promise.resolve()
        .then(() => this.executor.abort?.({
          runId: task.runId,
          caseId: task.caseId,
          role: task.role,
        }))
        .then(() => undefined, () => undefined);
      return abortHookPromise;
    };
    try {
      const result = await awaitExecutionSettlement(this.executor.execute({
        replayRunId: task.runId,
        evalCase,
        role: task.role,
        ...(task.candidateId ? {candidateId: task.candidateId} : {}),
        pinned: task.pinned,
        attempt: task.attempt,
        priorUsage: task.usage,
        signal: controller.signal,
        isAuthoritative: () => this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        }),
      }), controller.signal, this.abortTimeoutMs, () => {
        void requestExecutorAbort();
      });
      currentAttemptUsage = usageFromArtifacts(result.artifacts, task.usage);
      if (
        settlePausingIfNeeded(currentAttemptUsage)
        || !this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        })
      ) {
        return;
      }
      const scored = scoreFrozenEvaluationArtifacts(result.artifacts);
      if (scored.status === 'inconclusive') {
        this.store.inconclusive({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
          reason: scored.reason,
          usage: currentAttemptUsage,
          now: this.now(),
        });
        return;
      }
      const resultRef = await this.publisher.publish({
        score: scored.score,
        environmentProof: result.environmentProof,
        roleProof: result.roleProof,
        roleContract: result.roleContract,
        fullTreatmentContractHash: result.fullTreatmentContractHash,
        frozenArtifactsHash: scored.frozenArtifactsHash,
        executionFence: {
          taskId: task.taskId,
          executionToken: token,
        },
        isAuthoritative: () => this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        }),
      });
      if (
        settlePausingIfNeeded(currentAttemptUsage)
        || !this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        })
      ) {
        return;
      }
      this.store.complete({
        scope: task.scope,
        taskId: task.taskId,
        executionToken: token,
        resultRef,
        usage: currentAttemptUsage,
        now: this.now(),
      });
      await this.publisher.commitPublication?.({
        scope: task.scope,
        resultRef,
      });
      this.scoresByRun.get(task.runId)?.set(
        `${task.caseId}\0${task.role}`,
        scored.score,
      );
      this.proofsByRun.get(task.runId)?.set(
        `${task.caseId}\0${task.role}`,
        {
          proof: result.roleProof,
          contract: result.roleContract,
          fullTreatmentContractHash: result.fullTreatmentContractHash,
        },
      );
    } catch (error) {
      const failureReceipt = evaluationUsageReceiptFromError(error);
      const accumulatedUsage = failureReceipt
        ? usageFromReceipt(failureReceipt, task.usage)
        : currentAttemptUsage;
      if (settlePausingIfNeeded(
        accumulatedUsage,
        abortCleanupConfirmed(error),
      )) {
        return;
      }
      const current = this.store.get(task.scope, task.taskId);
      if (
        current?.state === 'completed'
        && current.completedExecutionToken === token
      ) {
        throw error;
      }
      if (
        !this.store.isAuthoritative({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
        })
      ) {
        return;
      }
      const code = !abortCleanupConfirmed(error)
        ? 'evaluation_attempt_cleanup_timeout'
        : controller.signal.aborted
        ? String(controller.signal.reason ?? 'evaluation_cancelled')
        : errorCode(error);
      if (
        TRANSIENT_ERROR_CODES.has(code)
        && task.retryCount < this.maxRetries
      ) {
        const backoff = this.rateLimitBackoffMs[
          Math.min(task.retryCount, this.rateLimitBackoffMs.length - 1)
        ] ?? 15_000;
        this.store.retry({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
          nextEligibleAt: this.now() + backoff,
          usage: accumulatedUsage,
          now: this.now(),
        });
      } else {
        this.store.inconclusive({
          scope: task.scope,
          taskId: task.taskId,
          executionToken: token,
          reason: code,
          usage: accumulatedUsage,
          now: this.now(),
        });
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(task.taskId);
      if (controller.signal.aborted) {
        await waitForBoundedAbort(
          requestExecutorAbort(),
          this.abortTimeoutMs,
        );
      }
    }
  }

  private async resolveCase(
    task: ReplayTaskRecordV1,
  ): Promise<EvalCaseV1 | undefined> {
    const evalCase = this.casesByRun.get(task.runId)?.get(task.caseId)
      ?? await this.resolveEvalCase?.(task.scope, task.caseId);
    if (!evalCase) return undefined;
    const expected = this.store.getRunSpec(task.scope, task.runId)
      ?.caseFingerprints.find(entry => entry.caseId === task.caseId);
    if (!expected) throw new Error('evaluation_run_spec_case_missing');
    return assertResolvedCase(task, evalCase, expected.contentHash);
  }

  private async loadCompletedScores(
    scope: RunManifestScope,
    runId: string,
    tasks: readonly ReplayTaskRecordV1[],
  ): Promise<void> {
    if (!this.publisher.loadPublished) return;
    const scoreMap = this.scoresByRun.get(runId) ?? new Map();
    this.scoresByRun.set(runId, scoreMap);
    for (const task of tasks) {
      if (
        task.state !== 'completed'
        || !task.resultRef
        || scoreMap.has(`${task.caseId}\0${task.role}`)
      ) {
        continue;
      }
      const score = await this.publisher.loadPublished({
        scope,
        resultRef: task.resultRef,
      });
      if (score) {
        scoreMap.set(`${task.caseId}\0${task.role}`, score.score);
        this.proofsByRun.get(runId)?.set(
          `${task.caseId}\0${task.role}`,
          {
            proof: score.roleProof,
            contract: score.roleContract,
            fullTreatmentContractHash: score.fullTreatmentContractHash,
          },
        );
      }
    }
  }

  private abortControllers(
    scope: RunManifestScope,
    runId: string,
    reason: string,
  ): void {
    for (const task of this.store.list(scope, runId)) {
      this.controllers.get(task.taskId)?.abort(reason);
    }
  }

  private cleanupRunContext(runId: string): void {
    this.casesByRun.delete(runId);
    this.scoresByRun.delete(runId);
    this.proofsByRun.delete(runId);
  }
}

function usageFromArtifacts(
  artifacts: FrozenEvaluationArtifactsV1,
  previous: ReplayTaskUsageV1,
): ReplayTaskUsageV1 {
  return {
    schemaVersion: 1,
    tokens: previous.tokens + artifacts.usageReceipt.tokens.used,
    toolCalls: previous.toolCalls + artifacts.usageReceipt.toolCalls.used,
    wallclockMs: previous.wallclockMs + artifacts.usageReceipt.wallclock.usedMs,
    traceProcessorCpuMs:
      previous.traceProcessorCpuMs
      + artifacts.usageReceipt.traceProcessorCpu.usedMs,
  };
}

function usageFromReceipt(
  receipt: EvaluationUsageReceiptV1,
  previous: ReplayTaskUsageV1,
): ReplayTaskUsageV1 {
  return {
    schemaVersion: 1,
    tokens: previous.tokens + receipt.tokens.used,
    toolCalls: previous.toolCalls + receipt.toolCalls.used,
    wallclockMs: previous.wallclockMs + receipt.wallclock.usedMs,
    traceProcessorCpuMs:
      previous.traceProcessorCpuMs + receipt.traceProcessorCpu.usedMs,
  };
}

function awaitExecutionSettlement(
  promise: Promise<ReplayExecutorResult>,
  signal: AbortSignal,
  abortTimeoutMs: number,
  onAbortRequested: () => void,
): Promise<ReplayExecutorResult> {
  return new Promise<ReplayExecutorResult>((resolve, reject) => {
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const handleAbort = () => {
      if (settled || abortTimer) return;
      onAbortRequested();
      abortTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', handleAbort);
        reject(markAbortCleanup(
          new Error('evaluation_attempt_cleanup_timeout'),
          false,
        ));
      }, abortTimeoutMs);
      abortTimer.unref?.();
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      if (abortTimer) clearTimeout(abortTimer);
      callback();
    };
    signal.addEventListener('abort', handleAbort, {once: true});
    if (signal.aborted) handleAbort();
    promise.then(
      value => {
        settle(() => {
          if (!signal.aborted) {
            resolve(value);
            return;
          }
          reject(markAbortCleanup(attachUsageReceipt(
            new Error(String(signal.reason ?? 'evaluation_cancelled')),
            value.artifacts.usageReceipt,
          ), true));
        });
      },
      error => {
        settle(() => reject(signal.aborted
          ? markAbortCleanup(normalizeError(error), true)
          : error));
      },
    );
  });
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  const receipt = evaluationUsageReceiptFromError(error);
  return receipt ? attachUsageReceipt(normalized, receipt) : normalized;
}

function attachUsageReceipt(
  error: Error,
  receipt: EvaluationUsageReceiptV1,
): Error {
  Object.defineProperty(error, 'evaluationUsageReceipt', {
    configurable: true,
    enumerable: false,
    value: receipt,
  });
  return error;
}

function markAbortCleanup(error: Error, confirmed: boolean): Error {
  Object.defineProperty(error, 'evaluationAbortCleanupConfirmed', {
    configurable: true,
    enumerable: false,
    value: confirmed,
  });
  return error;
}

function abortCleanupConfirmed(error: unknown): boolean {
  return !(
    error
    && typeof error === 'object'
    && 'evaluationAbortCleanupConfirmed' in error
    && (
      error as {evaluationAbortCleanupConfirmed?: unknown}
    ).evaluationAbortCleanupConfirmed === false
  );
}
