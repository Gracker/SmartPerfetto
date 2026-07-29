// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ProviderService} from '../providerManager/providerService';
import type {TraceProcessorService} from '../traceProcessorService';
import type {SelfEvolutionPersistenceCapability} from '../../types/selfEvolution';
import type {EvalCaseStore} from './evalCaseStore';
import {EvalReplayRunStore} from './evalReplayRunStore';
import {
  EvaluationReplayPublisher,
  type EvaluationReplayPublisherOptions,
} from './evaluationReplayPublisher';
import {
  OrchestratorReplayExecutor,
  type OrchestratorReplayExecutorOptions,
} from './orchestratorReplayExecutor';
import {
  ReplayRunner,
  type ReplayRunnerOptions,
} from './replayRunner';
import type {RunManifestStore} from './runManifestStore';

export interface EvaluationReplayServiceOptions {
  persistence: SelfEvolutionPersistenceCapability;
  evalCaseStore: EvalCaseStore;
  traceProcessorService: TraceProcessorService;
  providerService: ProviderService;
  runManifestStore: RunManifestStore;
  resolveRolePlan: OrchestratorReplayExecutorOptions['resolveRolePlan'];
  resolveBudgetLimits:
    OrchestratorReplayExecutorOptions['resolveBudgetLimits'];
  resolveBaselineContext:
    EvaluationReplayPublisherOptions['resolveBaselineContext'];
  executionContractFingerprint: string;
  concurrency: number;
  taskTimeoutMs: number;
  absoluteRunTimeoutMs: number;
  databasePath?: string;
  maxRetries?: number;
  rateLimitBackoffMs?: readonly number[];
  leaseMs?: number;
  abortTimeoutMs?: number;
  tolerancePreset?: ReplayRunnerOptions['tolerancePreset'];
  resolveEvalCase?: ReplayRunnerOptions['resolveEvalCase'];
  resolveProviderScope?:
    OrchestratorReplayExecutorOptions['resolveProviderScope'];
  resolvePersistentRegistryInputs?:
    OrchestratorReplayExecutorOptions['resolvePersistentRegistryInputs'];
  aliasResolver?: OrchestratorReplayExecutorOptions['aliasResolver'];
  budgetMode?: OrchestratorReplayExecutorOptions['budgetMode'];
  cleanupTimeoutMs?: number;
}

export interface EvaluationReplayService {
  runner: ReplayRunner;
  store: EvalReplayRunStore;
  executor: OrchestratorReplayExecutor;
  publisher: EvaluationReplayPublisher;
  close(): void;
}

export function createEvaluationReplayService(
  options: EvaluationReplayServiceOptions,
): EvaluationReplayService {
  const store = new EvalReplayRunStore({
    persistence: options.persistence,
    ...(options.databasePath ? {databasePath: options.databasePath} : {}),
  });
  const executor = new OrchestratorReplayExecutor({
    evalCaseStore: options.evalCaseStore,
    traceProcessorService: options.traceProcessorService,
    providerService: options.providerService,
    runManifestStore: options.runManifestStore,
    resolveRolePlan: options.resolveRolePlan,
    resolveBudgetLimits: options.resolveBudgetLimits,
    ...(options.resolveProviderScope
      ? {resolveProviderScope: options.resolveProviderScope}
      : {}),
    ...(options.resolvePersistentRegistryInputs
      ? {
          resolvePersistentRegistryInputs:
            options.resolvePersistentRegistryInputs,
        }
      : {}),
    ...(options.aliasResolver ? {aliasResolver: options.aliasResolver} : {}),
    ...(options.budgetMode ? {budgetMode: options.budgetMode} : {}),
    ...(options.cleanupTimeoutMs
      ? {cleanupTimeoutMs: options.cleanupTimeoutMs}
      : {}),
  });
  const publisher = new EvaluationReplayPublisher({
    persistence: options.persistence,
    evalCaseStore: options.evalCaseStore,
    resolveBaselineContext: options.resolveBaselineContext,
    isPublicationCommitted: input => store.isPublicationCommitted(input),
    ...(options.databasePath ? {databasePath: options.databasePath} : {}),
  });
  const runner = new ReplayRunner({
    store,
    executor,
    publisher,
    concurrency: options.concurrency,
    taskTimeoutMs: options.taskTimeoutMs,
    absoluteRunTimeoutMs: options.absoluteRunTimeoutMs,
    executionContractFingerprint: options.executionContractFingerprint,
    ...(options.maxRetries === undefined
      ? {}
      : {maxRetries: options.maxRetries}),
    ...(options.rateLimitBackoffMs
      ? {rateLimitBackoffMs: options.rateLimitBackoffMs}
      : {}),
    ...(options.leaseMs === undefined ? {} : {leaseMs: options.leaseMs}),
    ...(options.abortTimeoutMs === undefined
      ? {}
      : {abortTimeoutMs: options.abortTimeoutMs}),
    ...(options.tolerancePreset
      ? {tolerancePreset: options.tolerancePreset}
      : {}),
    ...(options.resolveEvalCase
      ? {resolveEvalCase: options.resolveEvalCase}
      : {}),
  });
  return {
    runner,
    store,
    executor,
    publisher,
    close: () => {
      publisher.close();
      store.close();
    },
  };
}
