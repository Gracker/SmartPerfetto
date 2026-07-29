// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {EvalReplayRunStore} from '../evalReplayRunStore';
import {ReplayRunner, type ReplayExecutor} from '../replayRunner';
import {evaluationRuntimeCapabilities} from '../evaluationRuntimeCapabilities';
import {
  recordEvaluationObservedTokenDelta,
  withEvaluationTelemetry,
} from '../evaluationTelemetry';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/eval-replay-run-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const persistenceAvailable: SelfEvolutionPersistenceCapability = {
  ...persistenceUnavailable,
  persistence: 'available',
  reason: undefined,
  writable: true,
};
const scope: RunManifestScope = {
  tenantId: 'local',
  workspaceId: 'local',
};
const pinned: EvalPinnedEnvironmentV1 = {
  runtime: 'openai-agents-sdk',
  providerId: null,
  model: 'gpt-eval',
  outputLanguage: 'zh-CN',
  toolAllowlistHash: canonicalContentHash(['query_trace']),
  injections: 'off',
  overlayGeneration: 'builtin:registry',
};
const executionContractFingerprint = 'f'.repeat(64);

function putRunSpec(
  store: EvalReplayRunStore,
  runId: string,
  cases: EvalCaseV1[],
) {
  return store.putRunSpec({
    runId,
    scope,
    caseFingerprints: cases.map(value => ({
      caseId: value.caseId,
      contentHash: canonicalContentHash(value),
    })),
    pinned,
    candidateId: 'candidate-a',
    executionPolicy: {
      concurrency: 1,
      taskTimeoutMs: 100,
      absoluteRunTimeoutMs: 1_000,
      maxRetries: 1,
      rateLimitBackoffMs: [10],
      leaseMs: 100,
      abortTimeoutMs: 10,
      tolerancePresetContentHash: 'e'.repeat(64),
      executionContractFingerprint,
    },
    createdAt: 0,
    absoluteDeadlineAt: 1_000,
  });
}

function evalCase(caseId: string): EvalCaseV1 {
  return {
    schemaVersion: 1,
    caseId,
    evalSetId: 'set-a',
    origin: 'synthetic_seed',
    scope,
    traces: [{
      role: 'current',
      corpusId: 'a'.repeat(64),
      contentHash: 'a'.repeat(64),
    }],
    query: 'Analyze startup latency.',
    analysisMode: 'full',
    split: 'validation',
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function publisher() {
  return {
    publish: jest.fn(async () => {
      throw new Error('unexpected_publish');
    }),
  };
}

describe('EvalReplayRunStore and ReplayRunner', () => {
  it('fences leases, persists retry backoff, and recovers expired work', () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    const runSpec = putRunSpec(store, 'run-a', [evalCase('case-a')]);
    store.enqueue({
      runId: 'run-a',
      runSpecHash: runSpec.contentHash,
      scope,
      caseId: 'case-a',
      role: 'candidate',
      candidateId: 'candidate-a',
      pinned,
      absoluteDeadlineAt: 1_000,
      now: 0,
    });
    const first = store.claimNext({
      scope,
      runId: 'run-a',
      leaseMs: 100,
      maxConcurrent: 1,
      now: 10,
    })!;
    expect(first.attempt).toBe(1);
    expect(first.executionToken).toBeTruthy();
    const retry = store.retry({
      scope,
      taskId: first.taskId,
      executionToken: first.executionToken!,
      nextEligibleAt: 50,
      usage: {
        schemaVersion: 1,
        tokens: 3,
        toolCalls: 1,
        wallclockMs: 1.25,
        traceProcessorCpuMs: 0.5,
      },
      now: 20,
    });
    expect(retry).toMatchObject({
      state: 'queued',
      retryCount: 1,
      nextEligibleAt: 50,
      usage: {
        wallclockMs: 1.25,
        traceProcessorCpuMs: 0.5,
      },
    });
    expect(store.claimNext({
      scope,
      runId: 'run-a',
      leaseMs: 100,
      maxConcurrent: 1,
      now: 49,
    })).toBeUndefined();
    const second = store.claimNext({
      scope,
      runId: 'run-a',
      leaseMs: 100,
      maxConcurrent: 1,
      now: 50,
    })!;
    expect(second.executionToken).not.toBe(first.executionToken);
    expect(() => store.complete({
      scope,
      taskId: first.taskId,
      executionToken: first.executionToken!,
      resultRef: 'stale',
      usage: {
        schemaVersion: 1,
        tokens: 0,
        toolCalls: 0,
        wallclockMs: 0,
        traceProcessorCpuMs: 0,
      },
      now: 60,
    })).toThrow('eval_replay_execution_fence_lost');
    expect(store.recoverExpired(scope, 151)[0]).toMatchObject({
      state: 'inconclusive',
      retryCount: 1,
      inconclusiveReason: 'evaluation_execution_cleanup_unconfirmed',
    });
    store.close();
  });

  it('enforces the concurrency ceiling across two SQLite store instances', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-store-'));
    const databasePath = path.join(directory, 'eval.sqlite');
    const firstStore = new EvalReplayRunStore({
      persistence: persistenceAvailable,
      databasePath,
    });
    const secondStore = new EvalReplayRunStore({
      persistence: persistenceAvailable,
      databasePath,
    });
    try {
      const cases = [evalCase('case-a'), evalCase('case-b')];
      const spec = putRunSpec(firstStore, 'run-sqlite', cases);
      for (const value of cases) {
        firstStore.enqueue({
          runId: spec.runId,
          runSpecHash: spec.contentHash,
          scope,
          caseId: value.caseId,
          role: 'candidate',
          candidateId: spec.candidateId,
          pinned,
          absoluteDeadlineAt: spec.absoluteDeadlineAt,
          now: 0,
        });
      }

      const claimed = firstStore.claimNext({
        scope,
        runId: spec.runId,
        leaseMs: 100,
        maxConcurrent: 1,
        now: 10,
      });
      expect(claimed).toBeDefined();
      expect(secondStore.claimNext({
        scope,
        runId: spec.runId,
        leaseMs: 100,
        maxConcurrent: 1,
        now: 10,
      })).toBeUndefined();

      secondStore.pauseRun(scope, spec.runId, 20);
      expect(() => firstStore.resumeRun(scope, spec.runId, 21))
        .toThrow('evaluation_run_pause_cleanup_pending');
      expect(firstStore.list(scope, spec.runId).map(task => task.state).sort())
        .toEqual(['paused', 'pausing']);

      expect(secondStore.recoverExpired(scope, 111)).toHaveLength(1);
      secondStore.resumeRun(scope, spec.runId, 112);
      expect(firstStore.list(scope, spec.runId).map(task => task.state).sort())
        .toEqual(['inconclusive', 'queued']);
    } finally {
      firstStore.close();
      secondStore.close();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('accumulates failed-attempt usage before a retry', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    const priorTokens: number[] = [];
    const executor: ReplayExecutor = {
      execute: jest.fn(async input => {
        priorTokens.push(input.priorUsage.tokens);
        return withEvaluationTelemetry({
          limits: {
            schemaVersion: 1,
            maxTokens: 100,
            maxToolCalls: 10,
            maxWallclockMs: 1_000,
            maxTraceProcessorCpuMs: 1_000,
          },
          capabilities: evaluationRuntimeCapabilities({
            runtime: pinned.runtime,
          }),
          signal: input.signal,
          isAuthoritative: input.isAuthoritative,
        }, async () => {
          recordEvaluationObservedTokenDelta(7);
          throw new Error('provider connection unavailable');
        });
      }),
    };
    const runner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 1,
      taskTimeoutMs: 500,
      absoluteRunTimeoutMs: 2_000,
      maxRetries: 1,
      rateLimitBackoffMs: [0],
      executionContractFingerprint,
    });

    const result = await runner.run({
      scope,
      cases: [evalCase('case-retry')],
      pinned,
      candidateId: 'candidate-a',
    });

    expect(priorTokens).toEqual([0, 7]);
    expect(result.tasks.find(task => task.role === 'baseline')?.usage.tokens)
      .toBe(14);
    store.close();
  });

  it('rejects duplicate case ids and out-of-scope cases before enqueueing', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    const runner = new ReplayRunner({
      store,
      executor: {
        execute: jest.fn(async () => {
          throw new Error('unexpected_execute');
        }),
      },
      publisher: publisher(),
      concurrency: 1,
      taskTimeoutMs: 100,
      absoluteRunTimeoutMs: 1_000,
      maxRetries: 0,
      executionContractFingerprint,
    });
    const duplicate = evalCase('case-duplicate');
    await expect(runner.run({
      scope,
      cases: [duplicate, duplicate],
      pinned,
      candidateId: 'candidate-a',
    })).rejects.toThrow('evaluation_cases_scope_or_identity_invalid');
    await expect(runner.run({
      scope,
      cases: [{
        ...evalCase('case-other-scope'),
        scope: {tenantId: 'other', workspaceId: 'local'},
      }],
      pinned,
      candidateId: 'candidate-a',
    })).rejects.toThrow('evaluation_cases_scope_or_identity_invalid');
    store.close();
  });

  it('runs with a concurrency ceiling and maps provider/trace failures to inconclusive', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    let active = 0;
    let maximum = 0;
    const executor: ReplayExecutor = {
      execute: jest.fn(async input => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        const error = new Error(
          input.evalCase.caseId === 'case-provider'
            ? 'provider connection unavailable'
            : 'trace not found',
        );
        throw error;
      }),
    };
    const runner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 2,
      taskTimeoutMs: 500,
      absoluteRunTimeoutMs: 2_000,
      maxRetries: 0,
      executionContractFingerprint,
    });
    const result = await runner.run({
      scope,
      cases: [evalCase('case-provider'), evalCase('case-trace')],
      pinned,
      candidateId: 'candidate-a',
    });
    expect(maximum).toBeLessThanOrEqual(2);
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.every(task => task.state === 'inconclusive')).toBe(true);
    expect(new Set(result.tasks.map(task => task.inconclusiveReason)))
      .toEqual(new Set([
        'provider_unavailable',
        'trace_missing',
        'baseline_l0_early_stop',
      ]));
    expect(Object.values(result.comparisons).every(
      comparison => comparison.status === 'inconclusive',
    )).toBe(true);
    store.close();
  });

  it('times out an uncooperative executor and calls its abort hook', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    const abort = jest.fn();
    const executor: ReplayExecutor = {
      execute: jest.fn(() => new Promise(() => undefined)),
      abort,
    };
    const runner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 2,
      taskTimeoutMs: 10,
      absoluteRunTimeoutMs: 1_000,
      maxRetries: 0,
      abortTimeoutMs: 10,
      executionContractFingerprint,
    });
    const result = await runner.run({
      scope,
      cases: [evalCase('case-timeout')],
      pinned,
      candidateId: 'candidate-a',
    });
    expect(new Set(result.tasks.map(task => task.inconclusiveReason)))
      .toEqual(new Set([
        'evaluation_attempt_cleanup_timeout',
        'baseline_l0_early_stop',
      ]));
    expect(abort).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('pauses running work and resumes it from persisted task context', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    let resumed = false;
    const executor: ReplayExecutor = {
      execute: jest.fn(async input => {
        if (resumed) throw new Error('trace not found');
        return withEvaluationTelemetry({
          limits: {
            schemaVersion: 1,
            maxTokens: 100,
            maxToolCalls: 10,
            maxWallclockMs: 10_000,
            maxTraceProcessorCpuMs: 1_000,
          },
          capabilities: evaluationRuntimeCapabilities({
            runtime: pinned.runtime,
          }),
          signal: input.signal,
          isAuthoritative: input.isAuthoritative,
        }, async () => {
          recordEvaluationObservedTokenDelta(5);
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => {
              reject(new Error('evaluation_worker_interrupted'));
            }, {once: true});
          });
          throw new Error('unexpected_pause_continuation');
        });
      }),
    };
    const runner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 2,
      taskTimeoutMs: 5_000,
      absoluteRunTimeoutMs: 10_000,
      maxRetries: 0,
      executionContractFingerprint,
      resolveEvalCase: (_scope, caseId) => evalCase(caseId),
    });
    const running = runner.run({
      scope,
      cases: [evalCase('case-pause')],
      pinned,
      candidateId: 'candidate-a',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const runId = store.list(scope)[0].runId;
    runner.pause(scope, runId);
    const paused = await running;
    expect(paused.tasks).toHaveLength(1);
    expect(paused.tasks[0].state).toBe('paused');
    expect(paused.tasks[0].usage.tokens).toBe(5);

    const incompatibleRunner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 1,
      taskTimeoutMs: 5_001,
      absoluteRunTimeoutMs: 10_000,
      maxRetries: 0,
      executionContractFingerprint,
      resolveEvalCase: (_scope, caseId) => evalCase(caseId),
    });
    await expect(incompatibleRunner.resume(scope, runId))
      .rejects.toThrow('evaluation_run_spec_resume_mismatch');

    resumed = true;
    const resumeRunner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 2,
      taskTimeoutMs: 5_000,
      absoluteRunTimeoutMs: 10_000,
      maxRetries: 0,
      executionContractFingerprint,
      resolveEvalCase: (_scope, caseId) => evalCase(caseId),
    });
    const completed = await resumeRunner.resume(scope, runId);
    expect(completed.tasks.every(task => task.state === 'inconclusive'))
      .toBe(true);
    expect(new Set(completed.tasks.map(task => task.inconclusiveReason)))
      .toEqual(new Set(['trace_missing', 'baseline_l0_early_stop']));
    store.close();
  });

  it('never resumes an attempt whose abort cleanup was not confirmed', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    const executor: ReplayExecutor = {
      execute: jest.fn(() => new Promise(() => undefined)),
    };
    const runner = new ReplayRunner({
      store,
      executor,
      publisher: publisher(),
      concurrency: 1,
      taskTimeoutMs: 5_000,
      absoluteRunTimeoutMs: 10_000,
      maxRetries: 0,
      abortTimeoutMs: 10,
      executionContractFingerprint,
      resolveEvalCase: (_scope, caseId) => evalCase(caseId),
    });
    const running = runner.run({
      scope,
      cases: [evalCase('case-unconfirmed-pause')],
      pinned,
      candidateId: 'candidate-a',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const runId = store.list(scope)[0].runId;
    runner.pause(scope, runId);
    const paused = await running;

    expect(paused.tasks[0]).toMatchObject({
      state: 'inconclusive',
      attempt: 1,
      inconclusiveReason: 'evaluation_attempt_cleanup_timeout',
    });
    const resumed = await runner.resume(scope, runId);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(resumed.tasks.find(task => task.role === 'baseline')).toMatchObject({
      state: 'inconclusive',
      attempt: 1,
      inconclusiveReason: 'evaluation_attempt_cleanup_timeout',
    });
    store.close();
  });

  it('fails closed when a resumed case resolver returns changed content', async () => {
    const store = new EvalReplayRunStore({
      persistence: persistenceUnavailable,
    });
    const blockingExecutor: ReplayExecutor = {
      execute: jest.fn(input => new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          reject(new Error('evaluation_worker_interrupted'));
        }, {once: true});
      })),
    };
    const initialRunner = new ReplayRunner({
      store,
      executor: blockingExecutor,
      publisher: publisher(),
      concurrency: 1,
      taskTimeoutMs: 5_000,
      absoluteRunTimeoutMs: 10_000,
      maxRetries: 0,
      executionContractFingerprint,
    });
    const running = initialRunner.run({
      scope,
      cases: [evalCase('case-resolver')],
      pinned,
      candidateId: 'candidate-a',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const runId = store.list(scope)[0].runId;
    initialRunner.pause(scope, runId);
    await running;

    const resumedExecutor = {
      execute: jest.fn(async () => {
        throw new Error('unexpected_execute');
      }),
    };
    const resumeRunner = new ReplayRunner({
      store,
      executor: resumedExecutor,
      publisher: publisher(),
      concurrency: 1,
      taskTimeoutMs: 5_000,
      absoluteRunTimeoutMs: 10_000,
      maxRetries: 0,
      executionContractFingerprint,
      resolveEvalCase: (_scope, caseId) => ({
        ...evalCase(caseId),
        query: 'Tampered after the run spec was persisted.',
      }),
    });
    const result = await resumeRunner.resume(scope, runId);

    expect(resumedExecutor.execute).not.toHaveBeenCalled();
    expect(new Set(result.tasks.map(task => task.inconclusiveReason)))
      .toEqual(new Set([
        'evaluation_case_resolution_mismatch',
        'baseline_l0_early_stop',
      ]));
    store.close();
  });
});
