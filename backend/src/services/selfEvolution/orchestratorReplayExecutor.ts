// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {
  AnalysisResult,
  IOrchestrator,
} from '../../agent/core/orchestratorTypes';
import type {StreamingUpdate} from '../../agent/types';
import {createAgentOrchestrator} from '../../agentRuntime';
import {parseOutputLanguage} from '../../agentv3/outputLanguage';
import {assessFinalReportContractCompleteness} from '../finalReportContractGate';
import type {ProviderService} from '../providerManager/providerService';
import type {ProviderScope} from '../providerManager/types';
import type {TraceProcessorService} from '../traceProcessorService';
import {TraceProcessorFactory} from '../workingTraceProcessor';
import {runClaimVerification} from '../verifier/claimVerificationRunner';
import {
  validateDataEnvelope,
  type DataEnvelope,
} from '../../types/dataContract';
import type {
  RunManifestScope,
  SkillOverlayDeltaV1,
} from '../../types/selfEvolution';
import type {StrategyRegistryContribution} from '../../agentv3/strategyLoader';
import {
  buildEffectiveRuntimeRegistrySnapshot,
  type BuildEffectiveRuntimeRegistrySnapshotInput,
} from './effectiveRuntimeRegistryProvider';
import type {EffectiveRuntimeRegistrySnapshot} from './effectiveRuntimeRegistryContext';
import {
  buildRunManifestFeatureFlagSnapshot,
  createRunManifestLifecycle,
  withRunManifestLifecycle,
} from './runManifestLifecycle';
import type {RunManifestStore} from './runManifestStore';
import {buildSkillRegistryAttribution} from './skillFingerprint';
import {
  captureEvaluationEnvironmentStart,
  evaluationEnvironmentManifestBinding,
  finalizeEvaluationEnvironmentProof,
  type EvaluationEnvironmentStartV1,
} from './evaluationEnvironmentProof';
import {
  createEvaluationMaterializationProof,
  createEvaluationRoleProofV2,
} from './evaluationPairAttestation';
import {
  sealEvaluationExposureReceipt,
  withEvaluationInjectionContext,
  type EvaluationRoleInjectionContractV1,
} from './evaluationInjectionContext';
import {
  checkEvaluationBudgets,
  normalizeEvaluationBudgetLimits,
  preflightEvaluationBudgets,
  recordTraceProcessorCpuSample,
  snapshotEvaluationUsageReceipt,
  withEvaluationTelemetry,
  type EvaluationBudgetLimitsV1,
  type EvaluationRuntimeCapabilitiesV1,
} from './evaluationTelemetry';
import {evaluationRuntimeCapabilities} from './evaluationRuntimeCapabilities';
import {
  evaluationFullTreatmentContractHash,
  evaluationRoleVariantRefs,
  withEvaluationRoleVariant,
  type EvaluationRoleVariantV1,
} from './evaluationTreatment';
import {
  materializeEvaluationTraces,
  type EvaluationCatalogAliasResolver,
} from './evaluationTraceMaterializer';
import {
  TraceProcessorCpuSampler,
  type TraceProcessorCpuSamplerOptions,
} from './traceProcessorCpuSampler';
import {
  freezeEvaluationArtifacts,
} from './evalScorer';
import type {
  ReplayExecutor,
  ReplayExecutorInput,
  ReplayExecutorResult,
} from './replayRunner';
import {
  canonicalContentHash,
  canonicalJsonString,
} from './canonicalJson';
import type {EvalCaseStore} from './evalCaseStore';

export interface EvaluationReplayRolePlan {
  roleVariant: EvaluationRoleVariantV1;
  injectionContract: EvaluationRoleInjectionContractV1;
  fullTreatmentContractHash: string;
}

export interface PersistentEvaluationRegistryInputs {
  skillOverlays?: readonly SkillOverlayDeltaV1[];
  strategyContributions?: readonly StrategyRegistryContribution[];
  workspaceOptions?: BuildEffectiveRuntimeRegistrySnapshotInput['workspaceOptions'];
}

export interface OrchestratorReplayExecutorOptions {
  evalCaseStore: EvalCaseStore;
  traceProcessorService: TraceProcessorService;
  providerService: ProviderService;
  runManifestStore: RunManifestStore;
  resolveRolePlan(input: {
    replay: ReplayExecutorInput;
    commonRegistry: EffectiveRuntimeRegistrySnapshot;
  }): EvaluationReplayRolePlan | Promise<EvaluationReplayRolePlan>;
  resolveBudgetLimits(input: ReplayExecutorInput): EvaluationBudgetLimitsV1;
  resolveProviderScope?(
    scope: RunManifestScope,
  ): ProviderScope | undefined;
  resolvePersistentRegistryInputs?(
    scope: RunManifestScope,
  ): PersistentEvaluationRegistryInputs
    | Promise<PersistentEvaluationRegistryInputs>;
  aliasResolver?: EvaluationCatalogAliasResolver;
  budgetMode?: 'strict' | 'diagnostic';
  cleanupTimeoutMs?: number;
  createOrchestrator?: typeof createAgentOrchestrator;
  buildRegistrySnapshot?: typeof buildEffectiveRuntimeRegistrySnapshot;
  resolveCapabilities?(
    input: ReplayExecutorInput,
  ): EvaluationRuntimeCapabilitiesV1;
  createCpuSampler?(
    options: TraceProcessorCpuSamplerOptions,
  ): Pick<TraceProcessorCpuSampler, 'start' | 'stop'>;
}

interface ActiveReplay {
  orchestrator: IOrchestrator;
  sessionId: string;
  referenceTraceId?: string;
}

function activeKey(input: {
  replayRunId: string;
  caseId: string;
  role: string;
}): string {
  return `${input.replayRunId}\0${input.caseId}\0${input.role}`;
}

function dataEnvelopesFromUpdate(
  update: StreamingUpdate,
): {valid: DataEnvelope[]; invalid: number} {
  if (update.type !== 'data') return {valid: [], invalid: 0};
  const values = Array.isArray(update.content)
    ? update.content
    : [update.content];
  const valid: DataEnvelope[] = [];
  let invalid = 0;
  for (const value of values) {
    if (validateDataEnvelope(value).length === 0) {
      valid.push(value as DataEnvelope);
    } else {
      invalid += 1;
    }
  }
  return {valid, invalid};
}

export function assertRolePlan(
  replay: ReplayExecutorInput,
  plan: EvaluationReplayRolePlan,
  commonRegistry: EffectiveRuntimeRegistrySnapshot,
): void {
  const roleRefs = evaluationRoleVariantRefs({
    variant: plan.roleVariant,
    role: replay.role,
    resolveBaselinePhaseHint: (scene, hintId) =>
      commonRegistry.strategyRegistry.getStrategy(scene)?.phaseHints.find(
        hint => hint.id === hintId,
      ),
  });
  const refKey = (ref: {
    category: string;
    id: string;
    contentHash: string;
  }) => `${ref.category}\0${ref.id}\0${ref.contentHash}`;
  const selectedKeys = new Set(
    Object.entries(plan.injectionContract.selected as unknown as Record<
      string,
      Array<{id: string; contentHash: string}>
    >).flatMap(
      ([category, refs]) => refs.map(ref => refKey({...ref, category})),
    ),
  );
  const expectedObserved = plan.injectionContract.mode === 'on'
    ? roleRefs.materializedRefs
    : plan.injectionContract.mode === 'selective'
      ? roleRefs.materializedRefs.filter(ref => selectedKeys.has(refKey(ref)))
      : [];
  const expectedObservedKeys = new Set(expectedObserved.map(refKey));
  const expectedForbidden = roleRefs.treatmentNamespaceRefs.filter(
    ref => !expectedObservedKeys.has(refKey(ref)),
  );
  if (
    plan.injectionContract.role !== replay.role
    || plan.injectionContract.mode !== replay.pinned.injections
    || plan.fullTreatmentContractHash
      !== evaluationFullTreatmentContractHash(plan.roleVariant)
    || plan.roleVariant.sourceCandidateContentHash
      !== replay.treatmentBinding.candidateContentHash
    || plan.roleVariant.treatmentArtifactContentHash
      !== replay.treatmentBinding.treatmentArtifactContentHash
    || plan.roleVariant.materializedInputHash
      !== replay.treatmentBinding.materializedInputHash
    || plan.fullTreatmentContractHash
      !== replay.treatmentBinding.fullTreatmentContractHash
    || plan.roleVariant.artifactId !== replay.candidateId
    || canonicalJsonString(roleRefs.materializedRefs)
      !== canonicalJsonString(
        plan.injectionContract.expectedMaterializedRefs,
      )
    || canonicalJsonString(roleRefs.treatmentNamespaceRefs)
      !== canonicalJsonString(
        plan.injectionContract.reservedTreatmentNamespace,
      )
    || canonicalJsonString(expectedObserved.map(refKey))
      !== canonicalJsonString(
        plan.injectionContract.expectedObservedRefs.map(
          entry => refKey(entry.ref),
        ),
      )
    || canonicalJsonString(expectedForbidden.map(refKey))
      !== canonicalJsonString(
        plan.injectionContract.forbiddenObservedRefs.map(refKey),
      )
  ) {
    throw new Error('evaluation_role_plan_invalid');
  }
}

async function withHardWallclockBudget<T>(input: {
  maxWallclockMs: number;
  onTimeout: () => void;
  callback: () => Promise<T>;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      input.onTimeout();
      reject(new Error('evaluation_budget_exceeded:wallclock'));
    }, input.maxWallclockMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([input.callback(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForBoundedCleanup(
  cleanup: void | Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(cleanup).catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function commonEvaluationRegistryContentHash(
  snapshot: EffectiveRuntimeRegistrySnapshot,
): string {
  return canonicalContentHash({
    scope: snapshot.scope,
    baseSkillRegistryFingerprint: snapshot.baseSkillRegistryFingerprint,
    baseStrategyRegistryFingerprint: snapshot.baseStrategyRegistryFingerprint,
    persistentOverlayGeneration: snapshot.overlayGeneration,
    commonSkillRegistryFingerprint: snapshot.skillRegistry.registryFingerprint,
    commonStrategyRegistryFingerprint:
      snapshot.strategyRegistry.registryFingerprint,
  });
}

function remainingBudgetLimits(
  limits: EvaluationBudgetLimitsV1,
  replay: ReplayExecutorInput,
): EvaluationBudgetLimitsV1 {
  const remaining = {
    schemaVersion: 1 as const,
    maxTokens: limits.maxTokens - replay.priorUsage.tokens,
    maxToolCalls: limits.maxToolCalls - replay.priorUsage.toolCalls,
    maxWallclockMs: limits.maxWallclockMs - replay.priorUsage.wallclockMs,
    maxTraceProcessorCpuMs:
      limits.maxTraceProcessorCpuMs
      - replay.priorUsage.traceProcessorCpuMs,
  };
  const exhausted = Object.entries(remaining).find(
    ([key, value]) => key !== 'schemaVersion' && value <= 0,
  );
  if (exhausted) {
    throw new Error(`evaluation_budget_exhausted:${exhausted[0]}`);
  }
  return normalizeEvaluationBudgetLimits(remaining);
}

export class OrchestratorReplayExecutor implements ReplayExecutor {
  private readonly options: OrchestratorReplayExecutorOptions;
  private readonly active = new Map<string, ActiveReplay>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: OrchestratorReplayExecutorOptions) {
    this.options = options;
  }

  async execute(
    replay: ReplayExecutorInput,
  ): Promise<ReplayExecutorResult> {
    const key = activeKey({
      replayRunId: replay.replayRunId,
      caseId: replay.evalCase.caseId,
      role: replay.role,
    });
    const previousAttempt = this.inFlight.get(key);
    if (previousAttempt) {
      await waitForBoundedCleanup(
        previousAttempt,
        this.options.cleanupTimeoutMs ?? 2_000,
      );
      if (this.inFlight.get(key) === previousAttempt) {
        throw new Error('evaluation_previous_attempt_still_active');
      }
    }
    if (replay.signal.aborted) throw new Error('evaluation_cancelled');
    if (!replay.isAuthoritative()) {
      throw new Error('evaluation_execution_fence_lost');
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(
      replay.signal.reason ?? 'evaluation_cancelled',
    );
    if (replay.signal.aborted) {
      forwardAbort();
    } else {
      replay.signal.addEventListener('abort', forwardAbort, {once: true});
    }
    const scopedReplay: ReplayExecutorInput = {
      ...replay,
      signal: controller.signal,
    };
    try {
      const capabilities = this.options.resolveCapabilities?.(scopedReplay)
        ?? evaluationRuntimeCapabilities({runtime: replay.pinned.runtime});
      const fullLimits = normalizeEvaluationBudgetLimits(
        this.options.resolveBudgetLimits(scopedReplay),
      );
      const budgetLimits = remainingBudgetLimits(fullLimits, scopedReplay);
      const preflight = preflightEvaluationBudgets({
        capabilities,
        strict: (this.options.budgetMode ?? 'diagnostic') === 'strict',
      });
      if (preflight.status === 'inconclusive') {
        const error = new Error(
          `evaluation_budget_preflight_inconclusive:${preflight.reasons.join(',')}`,
        ) as Error & {code: string};
        error.code = 'evaluation_budget_preflight_inconclusive';
        throw error;
      }
      return await withEvaluationTelemetry({
        limits: budgetLimits,
        capabilities,
        signal: controller.signal,
        isAuthoritative: scopedReplay.isAuthoritative,
      }, () => {
        const attempt = this.executeAttempt(
          scopedReplay,
          capabilities,
          budgetLimits,
        );
        this.inFlight.set(key, attempt);
        void attempt.then(
          () => {
            if (this.inFlight.get(key) === attempt) {
              this.inFlight.delete(key);
            }
          },
          () => {
            if (this.inFlight.get(key) === attempt) {
              this.inFlight.delete(key);
            }
          },
        );
        return withHardWallclockBudget({
          maxWallclockMs: budgetLimits.maxWallclockMs,
          onTimeout: () => {
            try {
              checkEvaluationBudgets();
            } catch {
              // The telemetry receipt preserves the exceeded dimension.
            }
            controller.abort('evaluation_budget_exceeded:wallclock');
            void this.abort({
              runId: replay.replayRunId,
              caseId: replay.evalCase.caseId,
              role: replay.role,
            });
          },
          callback: () => attempt,
        });
      });
    } finally {
      replay.signal.removeEventListener('abort', forwardAbort);
    }
  }

  private async executeAttempt(
    replay: ReplayExecutorInput,
    capabilities: EvaluationRuntimeCapabilitiesV1,
    budgetLimits: EvaluationBudgetLimitsV1,
  ): Promise<ReplayExecutorResult> {
    if (!replay.candidateId) {
      throw new Error('evaluation_candidate_id_missing');
    }
    if (
      parseOutputLanguage(replay.pinned.outputLanguage)
      !== replay.pinned.outputLanguage
    ) {
      throw new Error('evaluation_pinned_output_language_noncanonical');
    }
    const providerScope = this.options.resolveProviderScope?.(
      replay.evalCase.scope,
    );
    const registryInputs =
      await this.options.resolvePersistentRegistryInputs?.(
        replay.evalCase.scope,
      ) ?? {};
    const buildRegistry = this.options.buildRegistrySnapshot
      ?? buildEffectiveRuntimeRegistrySnapshot;
    const registryScope = {
      tenantId: replay.evalCase.scope.tenantId,
      workspaceId: replay.evalCase.scope.workspaceId,
      ...(providerScope?.userId ? {userId: providerScope.userId} : {}),
    };
    const commonRegistry = await buildRegistry({
      scope: registryScope,
      ...registryInputs,
    });
    if (commonRegistry.overlayGeneration !== replay.pinned.overlayGeneration) {
      throw new Error('evaluation_pinned_overlay_generation_mismatch');
    }
    const rolePlan = await this.options.resolveRolePlan({
      replay,
      commonRegistry,
    });
    assertRolePlan(replay, rolePlan, commonRegistry);
    const roleRegistry = replay.role === 'candidate'
      ? await buildRegistry({
          scope: registryScope,
          ...registryInputs,
          evaluationRoleVariant: rolePlan.roleVariant,
        })
      : commonRegistry;
    const environmentStart = captureEvaluationEnvironmentStart({
      providerService: this.options.providerService,
      scope: replay.evalCase.scope,
      providerScope,
      pinned: replay.pinned,
      selector: {
        schemaVersion: 1,
        mode: replay.pinned.injections,
        selected: rolePlan.injectionContract.selected,
      },
    });
    const traces = materializeEvaluationTraces({
      evalCaseStore: this.options.evalCaseStore,
      aliasResolver: this.options.aliasResolver,
      evalCase: replay.evalCase,
    });
    const currentTrace = traces.traces.find(trace => trace.role === 'current');
    const referenceTrace = traces.traces.find(
      trace => trace.role === 'reference',
    );
    if (!currentTrace) {
      traces.cleanup();
      throw new Error('trace_missing:current');
    }
    const traceService = this.options.traceProcessorService;
    const registeredTraceIds: string[] = [];
    const lifecycle = createRunManifestLifecycle({
      runId: randomUUID(),
      sessionId: randomUUID(),
      scope: replay.evalCase.scope,
      runtime: replay.pinned.runtime,
      providerId: replay.pinned.providerId,
      providerSnapshotHash: environmentStart.providerSnapshotHash,
      ...(replay.pinned.model ? {model: replay.pinned.model} : {}),
      outputLanguage: replay.pinned.outputLanguage,
      analysisMode: replay.evalCase.analysisMode,
      resolvedMode: replay.evalCase.analysisMode === 'fast' ? 'quick' : 'full',
      ...(referenceTrace ? {referenceTraceId: referenceTrace.traceId} : {}),
      featureFlagSnapshot: {
        ...buildRunManifestFeatureFlagSnapshot(),
        ...evaluationEnvironmentManifestBinding(environmentStart),
      },
      skillRegistry: buildSkillRegistryAttribution(
        roleRegistry.skillRegistry,
      ),
      runtimeRegistrySnapshot: roleRegistry,
      store: this.options.runManifestStore,
    });
    const sessionId = lifecycle.identity.sessionId;
    const activeReplayKey = activeKey({
      replayRunId: replay.replayRunId,
      caseId: replay.evalCase.caseId,
      role: replay.role,
    });
    const traceLeaseIds = new Set(traces.traces.map(trace => trace.leaseId));
    const sampler = (this.options.createCpuSampler
      ?? (options => new TraceProcessorCpuSampler(options)))({
      resolvePids: () => TraceProcessorFactory.getStats().processors
        .filter(processor =>
          processor.pid
          && traceLeaseIds.has(processor.leaseId ?? ''))
        .map(processor => processor.pid as number),
      recordSample: (cumulativeCpuMs, metadata) => {
        recordTraceProcessorCpuSample({
          cumulativeCpuMs,
          ...metadata,
        });
      },
      countNewProcessesFromZero: true,
      onError: () => {
        void this.abort({
          runId: replay.replayRunId,
          caseId: replay.evalCase.caseId,
          role: replay.role,
        });
      },
    });
    let samplerStarted = false;
    try {
      sampler.start();
      samplerStarted = true;
      for (const trace of traces.traces) {
        traceService.registerStoredTrace({
          id: trace.traceId,
          filename: `${trace.role}.pftrace`,
          size: trace.sizeBytes,
          filePath: trace.filePath,
        });
        registeredTraceIds.push(trace.traceId);
        await traceService.ensureProcessorForLease(
          trace.traceId,
          trace.leaseId,
          'isolated',
          providerScope ?? replay.evalCase.scope,
        );
      }
      const leaseContexts = traces.traces.map(trace => ({
        traceId: trace.traceId,
        leaseId: trace.leaseId,
        mode: 'isolated' as const,
        leaseScope: providerScope ?? replay.evalCase.scope,
      }));
      return await traceService.runWithLeases(
        leaseContexts,
        () => this.runOrchestrator({
          replay,
          providerScope,
          rolePlan,
          commonRegistry,
          roleRegistry,
          environmentStart,
          lifecycle,
          currentTraceId: currentTrace.traceId,
          referenceTraceId: referenceTrace?.traceId,
          stopCpuSampler: () => {
            if (!samplerStarted) return;
            sampler.stop();
            samplerStarted = false;
          },
          activeReplayKey,
          sessionId,
        }),
      );
    } finally {
      if (samplerStarted) {
        try {
          sampler.stop();
        } catch {
          // Preserve the primary failure while still completing trace cleanup.
        } finally {
          samplerStarted = false;
        }
      }
      this.active.delete(activeReplayKey);
      lifecycle.dispose();
      for (const trace of traces.traces) {
        traceService.cleanupLeaseProcessor(
          trace.traceId,
          trace.leaseId,
          'isolated',
        );
      }
      for (const traceId of registeredTraceIds) {
        await traceService.deleteTrace(traceId).catch(() => undefined);
      }
      traces.cleanup();
    }
  }

  async abort(input: {
    runId: string;
    caseId: string;
    role: 'baseline' | 'candidate';
  }): Promise<void> {
    const active = this.active.get(activeKey({
      replayRunId: input.runId,
      caseId: input.caseId,
      role: input.role,
    }));
    if (!active) return;
    await Promise.resolve(active.orchestrator.abortSession?.(
      active.sessionId,
      active.referenceTraceId,
    ));
  }

  private async runOrchestrator(input: {
    replay: ReplayExecutorInput;
    providerScope?: ProviderScope;
    rolePlan: EvaluationReplayRolePlan;
    commonRegistry: EffectiveRuntimeRegistrySnapshot;
    roleRegistry: EffectiveRuntimeRegistrySnapshot;
    environmentStart: EvaluationEnvironmentStartV1;
    lifecycle: ReturnType<typeof createRunManifestLifecycle>;
    currentTraceId: string;
    referenceTraceId?: string;
    stopCpuSampler(): void;
    activeReplayKey: string;
    sessionId: string;
  }): Promise<ReplayExecutorResult> {
    const {
      replay,
      rolePlan,
      roleRegistry,
      lifecycle,
    } = input;
    const createOrchestrator = this.options.createOrchestrator
      ?? createAgentOrchestrator;
    const orchestrator = createOrchestrator({
      traceProcessorService: this.options.traceProcessorService,
      providerId: replay.pinned.providerId,
      runtimeOverride: replay.pinned.runtime,
      providerScope: input.providerScope,
      aiFeature: 'agent_analyze',
    });
    this.active.set(input.activeReplayKey, {
      orchestrator,
      sessionId: input.sessionId,
      ...(input.referenceTraceId
        ? {referenceTraceId: input.referenceTraceId}
        : {}),
    });
    const abortHandler = () => {
      void Promise.resolve(orchestrator.abortSession?.(
        input.sessionId,
        input.referenceTraceId,
      ));
    };
    replay.signal.addEventListener('abort', abortHandler, {once: true});
    try {
      return await withEvaluationInjectionContext({
        contract: rolePlan.injectionContract,
      }, () => {
        const runWithRole = (callback: () => Promise<ReplayExecutorResult>) =>
          replay.role === 'candidate'
            ? withEvaluationRoleVariant(rolePlan.roleVariant, callback)
            : callback();
        return runWithRole(() => withRunManifestLifecycle(
            lifecycle,
            async () => {
            const dataEnvelopes: DataEnvelope[] = [];
            let invalidDataEnvelopeCount = 0;
            const updateHandler = (update: StreamingUpdate) => {
              const projected = dataEnvelopesFromUpdate(update);
              dataEnvelopes.push(...projected.valid);
              invalidDataEnvelopeCount += projected.invalid;
            };
            orchestrator.on('update', updateHandler);
            let result: AnalysisResult;
            try {
              result = await orchestrator.analyze(
                replay.evalCase.query,
                input.sessionId,
                input.currentTraceId,
                {
                  providerId: replay.pinned.providerId,
                  outputLanguage: parseOutputLanguage(
                    replay.pinned.outputLanguage,
                  ),
                  analysisMode: replay.evalCase.analysisMode,
                  ...(input.referenceTraceId
                    ? {referenceTraceId: input.referenceTraceId}
                    : {}),
                  tenantId: replay.evalCase.scope.tenantId,
                  workspaceId: replay.evalCase.scope.workspaceId,
                  ...(input.providerScope?.userId
                    ? {userId: input.providerScope.userId}
                    : {}),
                  runId: lifecycle.identity.runId,
                  runManifestAttributionSink: lifecycle.builder,
                },
              );
            } finally {
              orchestrator.off('update', updateHandler);
            }
            input.stopCpuSampler();
            checkEvaluationBudgets();
            const verification = result.claimVerificationResult
              ?? runClaimVerification({
                conclusionContract: result.conclusionContract,
                dataEnvelopes,
                policy: 'record_only',
              }).claimVerificationResult;
            const reportContractPass =
              invalidDataEnvelopeCount === 0
              && !assessFinalReportContractCompleteness({
                conclusion: result.conclusion,
                query: replay.evalCase.query,
              });
            const exposureReceipt = sealEvaluationExposureReceipt();
            const usageReceipt = snapshotEvaluationUsageReceipt();
            const manifest = lifecycle.sealOnceAndPersist({
              turnCount:
                Number.isSafeInteger(result.rounds) && result.rounds >= 0
                  ? result.rounds
                  : 0,
              closePendingSkillInvocationsAsErrors: true,
            });
            const environmentProof = finalizeEvaluationEnvironmentProof({
              providerService: this.options.providerService,
              providerScope: input.providerScope,
              runManifestStore: this.options.runManifestStore,
              start: input.environmentStart,
              runManifestId: manifest.runManifestId,
            });
            const commonBaseRegistryContentHash =
              commonEvaluationRegistryContentHash(input.commonRegistry);
            const materialization = createEvaluationMaterializationProof({
              artifactId: replay.role === 'candidate'
                ? rolePlan.roleVariant.artifactId
                : `baseline:${rolePlan.roleVariant.artifactId}`,
              sourceCandidateContentHash:
                rolePlan.roleVariant.sourceCandidateContentHash,
              treatmentArtifactContentHash:
                rolePlan.roleVariant.treatmentArtifactContentHash,
              materializedInputHash:
                rolePlan.roleVariant.materializedInputHash,
              baseRegistryContentHash: commonBaseRegistryContentHash,
              persistentOverlayGeneration:
                input.commonRegistry.overlayGeneration,
              treatmentGeneration:
                roleRegistry.evaluationTreatment?.treatmentGeneration
                ?? `evaluation:baseline:${rolePlan.roleVariant.treatmentGeneration}`,
              materializedRefs:
                rolePlan.injectionContract.expectedMaterializedRefs,
              effectiveSkillRegistryFingerprint:
                roleRegistry.skillRegistry.registryFingerprint,
              effectiveStrategyRegistryFingerprint:
                roleRegistry.strategyRegistry.registryFingerprint,
            });
            const roleProof = createEvaluationRoleProofV2({
              role: replay.role,
              baseProof: environmentProof,
              contract: rolePlan.injectionContract,
              materialization,
              exposureReceipt,
              commonBaseRegistryContentHash,
            });
            return {
              artifacts: freezeEvaluationArtifacts({
                schemaVersion: 1,
                evalCase: replay.evalCase,
                runManifest: manifest,
                pinned: replay.pinned,
                role: replay.role,
                attempt: replay.attempt,
                ...(replay.role === 'candidate'
                  ? {candidateId: replay.candidateId}
                  : {}),
                runOk: result.success && !replay.signal.aborted,
                reportContractPass,
                claimVerificationResult: verification,
                usageReceipt,
              }),
              environmentProof,
              roleProof,
              roleContract: rolePlan.injectionContract,
              fullTreatmentContractHash:
                rolePlan.fullTreatmentContractHash,
            };
            },
          ));
      });
    } finally {
      replay.signal.removeEventListener('abort', abortHandler);
      await waitForBoundedCleanup(
        orchestrator.cleanupSession?.(input.sessionId),
        this.options.cleanupTimeoutMs ?? 2_000,
      );
    }
  }
}
