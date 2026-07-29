// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SelfEvolutionPersistenceCapability} from '../../../types/selfEvolution';
import {EvalReplayRunStore} from '../evalReplayRunStore';
import {EvaluationReplayPublisher} from '../evaluationReplayPublisher';
import {
  createEvaluationReplayService,
} from '../evaluationReplayService';
import {OrchestratorReplayExecutor} from '../orchestratorReplayExecutor';
import {ReplayRunner} from '../replayRunner';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/evaluation-replay-service-tests',
  packageRoot: '/app',
  checkedAt: 1,
};

describe('createEvaluationReplayService', () => {
  it('assembles the production executor, durable runner, and fenced publisher', () => {
    const service = createEvaluationReplayService({
      persistence: persistenceUnavailable,
      evalCaseStore: {} as never,
      traceProcessorService: {} as never,
      providerService: {} as never,
      runManifestStore: {} as never,
      resolveRolePlan: () => {
        throw new Error('not_invoked_during_construction');
      },
      resolveBudgetLimits: () => {
        throw new Error('not_invoked_during_construction');
      },
      resolveBaselineContext: () => {
        throw new Error('not_invoked_during_construction');
      },
      executionContractFingerprint: 'a'.repeat(64),
      concurrency: 2,
      taskTimeoutMs: 1_000,
      absoluteRunTimeoutMs: 10_000,
    });

    expect(service.store).toBeInstanceOf(EvalReplayRunStore);
    expect(service.executor).toBeInstanceOf(OrchestratorReplayExecutor);
    expect(service.publisher).toBeInstanceOf(EvaluationReplayPublisher);
    expect(service.runner).toBeInstanceOf(ReplayRunner);
    service.close();
  });
});
