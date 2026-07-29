// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import os from 'os';
import path from 'path';

import {skillNoteContentHash} from '../../agentv3/selfImprove/skillNotesInjector';
import {
  canonicalContentHash,
  canonicalJsonString,
} from './canonicalJson';
import type {
  CurationProposalV1,
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvolutionOverlayPayloadV1,
  EvolutionOverlayProvenanceV1,
  RunInjectionAttribution,
  RunManifestScope,
  RunManifestV1,
  SelfEvolutionPersistenceCapability,
} from '../../types/selfEvolution';
import {getProviderService} from '../providerManager';
import type {ProviderScope} from '../providerManager/types';
import type {SkillOriginMetadata} from '../skillPacks/skillPackTypes';
import {getTraceProcessorService} from '../traceProcessorService';
import {ContributionBundleChannel} from './contributionBundleChannel';
import {CurationService} from './curationService';
import {
  buildEffectiveRuntimeRegistrySnapshot,
} from './effectiveRuntimeRegistryProvider';
import type {
  EffectiveRuntimeRegistrySnapshot,
} from './effectiveRuntimeRegistryContext';
import {getEvalCaseStore} from './evalCaseStore';
import {
  captureEvaluationEnvironmentStart,
} from './evaluationEnvironmentProof';
import {
  createEvaluationRoleInjectionContract,
} from './evaluationInjectionContext';
import {
  createEvaluationReplayService,
  type EvaluationReplayService,
} from './evaluationReplayService';
import {
  evaluationFullTreatmentContractHash,
  evaluationPhaseHintInjectionContentHash,
  evaluationRoleVariantRefs,
  type EvaluationRoleVariantV1,
} from './evaluationTreatment';
import {
  createEvolutionOverlayArtifactV1,
  createEvolutionOverlayPayloadFromTreatmentEntry,
  EVOLUTION_OVERLAY_LOADER_SCHEMA_VERSION,
} from './evolutionOverlayContract';
import {EvolutionOverlayArtifactStore} from './evolutionOverlayArtifactStore';
import {EvolutionOverlayRegistry} from './evolutionOverlayRegistry';
import {PublicFeedbackCurationSource} from './feedbackEventStore';
import {OverlayReconciler} from './overlayReconciler';
import {
  ProposalApplicationService,
  type ProposalApplicationMaterializationV1,
} from './proposalApplicationService';
import {
  ProposalGateService,
} from './proposalGateService';
import {
  ProposalMaterializationPlanner,
  ProposalMaterializationRegistry,
} from './proposalMaterializationPlanner';
import {
  materializeProposalCandidate,
  type ProposalBaseSnapshotV1,
} from './proposalSemanticGate';
import {
  materializeProposalTreatment,
  type ProposalTreatmentMaterializationV1,
} from './proposalTreatmentMaterializer';
import {ProposalStore} from './proposalStore';
import {getRunManifestStore} from './runManifestStore';
import {
  getSelfEvolutionLifecycleSnapshot,
} from './selfEvolutionLifecycle';
import {
  SelfEvolutionAdminService,
  type SelfEvolutionAdminDependencies,
} from './selfEvolutionAdminService';
import {fingerprintSkillDefinition} from './skillFingerprint';

const EMPTY_INJECTIONS: RunInjectionAttribution = {
  patterns: [],
  skillNotes: [],
  cases: [],
  phaseHints: [],
  knowledgeDocs: [],
};

const REPLAY_BUDGET = Object.freeze({
  schemaVersion: 1 as const,
  maxTokens: 100_000,
  maxToolCalls: 256,
  maxWallclockMs: 10 * 60 * 1000,
  maxTraceProcessorCpuMs: 5 * 60 * 1000,
});

const REPLAY_POLICY = Object.freeze({
  concurrency: 1,
  taskTimeoutMs: 10 * 60 * 1000,
  absoluteRunTimeoutMs: 30 * 60 * 1000,
  maxRetries: 1,
  rateLimitBackoffMs: [1_000, 5_000] as const,
});

class ProductionSelfEvolutionAdminDependencies
implements SelfEvolutionAdminDependencies {
  private readonly proposalStore: ProposalStore;
  private readonly overlayRegistry: EvolutionOverlayRegistry | null;
  private readonly artifactStore: EvolutionOverlayArtifactStore | null;
  private readonly reconciler: OverlayReconciler | null;
  private readonly persistence: SelfEvolutionPersistenceCapability;
  private readonly materializationPlanner: ProposalMaterializationPlanner;

  constructor() {
    const lifecycle = getSelfEvolutionLifecycleSnapshot();
    this.persistence = lifecycle.persistence;
    this.proposalStore = new ProposalStore({
      ...(this.persistence.persistence === 'available'
        ? {}
        : {databasePath: ':memory:'}),
    });
    if (this.persistence.persistence === 'available') {
      this.overlayRegistry = new EvolutionOverlayRegistry({
        persistence: this.persistence,
      });
      this.artifactStore = new EvolutionOverlayArtifactStore({
        persistence: this.persistence,
      });
      this.reconciler = new OverlayReconciler({
        registry: this.overlayRegistry,
        artifactStore: this.artifactStore,
        persistence: this.persistence,
        buildIdentity: lifecycle.currentBuildIdentity,
        traceProcessorVersion: traceProcessorVersion(),
      });
    } else {
      this.overlayRegistry = null;
      this.artifactStore = null;
      this.reconciler = null;
    }
    this.materializationPlanner = new ProposalMaterializationPlanner(
      this.persistence.persistence === 'available'
        ? ProposalMaterializationRegistry.production()
        : ProposalMaterializationRegistry.forTesting(
            path.join(
              os.tmpdir(),
              `smartperfetto-self-evolution-${process.pid}`,
            ),
          ),
    );
  }

  lifecycle() {
    return getSelfEvolutionLifecycleSnapshot();
  }

  listProposals(scope: RunManifestScope) {
    return this.proposalStore.list(scope);
  }

  getProposal(scope: RunManifestScope, proposalId: string) {
    return this.proposalStore.get(scope, proposalId);
  }

  latestGateAttempt(scope: RunManifestScope, proposalId: string) {
    return this.proposalStore.getLatestGateAttempt(scope, proposalId);
  }

  listAppliedRevisions(proposalId: string) {
    return this.proposalStore.listAppliedRevisions(proposalId);
  }

  listOverlays(scope: RunManifestScope) {
    return this.overlayRegistry?.listEntries(scope) ?? [];
  }

  generationHead(scope: RunManifestScope) {
    return this.overlayRegistry?.generationHead(scope) ?? null;
  }

  latestReconciliation(scope: RunManifestScope) {
    return this.overlayRegistry?.latestReport(scope) ?? null;
  }

  async curate(scope: RunManifestScope) {
    const source = PublicFeedbackCurationSource.open({scope});
    try {
      return await new CurationService({
        manifests: getRunManifestStore(),
        evalCases: getEvalCaseStore(),
        proposals: this.proposalStore,
      }).runExplicit({
        scope,
        source,
      });
    } finally {
      source.close();
    }
  }

  async gate(
    scope: RunManifestScope,
    proposalId: string,
    actor: {userId?: string},
  ) {
    const proposal = this.proposalStore.get(scope, proposalId);
    if (!proposal) throw new Error('curation_proposal_not_found');
    const sourceManifest = proposalSourceManifest(proposal);
    const cases = selectPairedReplayCases(
      proposal,
      sourceManifest,
      getEvalCaseStore().listCases(scope),
    );
    const pinned: EvalPinnedEnvironmentV1 = {
      runtime: sourceManifest.runtime,
      providerId: sourceManifest.providerId,
      ...(sourceManifest.model ? {model: sourceManifest.model} : {}),
      outputLanguage: sourceManifest.outputLanguage,
      toolAllowlistHash: sourceManifest.toolAllowlistHash,
      injections: 'on',
      overlayGeneration: proposal.expectedOverlayGeneration,
    };
    const providerScope: ProviderScope = {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      ...(actor.userId ? {userId: actor.userId} : {}),
    };
    let replayService: EvaluationReplayService | undefined;
    try {
      const snapshot = await buildEffectiveRuntimeRegistrySnapshot({scope});
      const origins = new Map<string, SkillOriginMetadata>();
      for (const skill of snapshot.skillRegistry.getAllSkills()) {
        const origin = snapshot.skillRegistry.getSkillOrigin(skill.name);
        if (origin) origins.set(skill.name, origin);
      }
      const staticValidation = {
        validationPolicyFingerprint: canonicalContentHash({
          schemaVersion: 1,
          validator: 'self-evolution-admin-gate-v1',
          skillRegistryFingerprint:
            snapshot.skillRegistry.registryFingerprint,
          strategyRegistryFingerprint:
            snapshot.strategyRegistry.registryFingerprint,
        }),
        skillSnapshot: {
          definitions: snapshot.skillRegistry.getAllSkills(),
          fragments: snapshot.skillRegistry.getFragmentCache(),
          origins,
          existingOverlays: [],
        },
        strategySnapshot: {
          existingContributions: [],
          knownSkillIds: new Set(
            snapshot.skillRegistry.getAllSkills().map(skill => skill.name),
          ),
        },
      };
      const treatmentByProposal = new Map<
        string,
        ProposalTreatmentMaterializationV1
      >();
      replayService = createEvaluationReplayService({
        persistence: this.persistence,
        evalCaseStore: getEvalCaseStore(),
        traceProcessorService: getTraceProcessorService(),
        providerService: getProviderService(),
        runManifestStore: getRunManifestStore(),
        resolveRolePlan: async ({replay, commonRegistry}) => {
          const treatment = treatmentByProposal.get(replay.candidateId ?? '');
          if (!treatment) {
            throw new Error('evaluation_treatment_unavailable');
          }
          return rolePlan({
            role: replay.role,
            treatment: treatment.roleVariant,
            commonRegistry,
            selected: sourceManifest.injections,
          });
        },
        resolveBudgetLimits: () => REPLAY_BUDGET,
        resolveBaselineContext: async input => {
          const treatment = treatmentByProposal.get(input.candidateId);
          if (!treatment) {
            throw new Error('evaluation_treatment_unavailable');
          }
          const commonRegistry =
            await buildEffectiveRuntimeRegistrySnapshot({scope});
          const plan = rolePlan({
            role: 'baseline',
            treatment: treatment.roleVariant,
            commonRegistry,
            selected: sourceManifest.injections,
          });
          return {
            environmentStart: captureEvaluationEnvironmentStart({
              providerService: getProviderService(),
              providerScope,
              scope,
              pinned: input.pinned,
              selector: {
                schemaVersion: 1,
                mode: input.pinned.injections,
                selected: plan.injectionContract.selected,
              },
            }),
            roleContract: plan.injectionContract,
            fullTreatmentContractHash:
              plan.fullTreatmentContractHash,
          };
        },
        resolveProviderScope: () => providerScope,
        executionContractFingerprint: canonicalContentHash({
          schemaVersion: 1,
          component: 'self-evolution-admin-replay',
          budget: REPLAY_BUDGET,
          policy: REPLAY_POLICY,
        }),
        concurrency: REPLAY_POLICY.concurrency,
        taskTimeoutMs: REPLAY_POLICY.taskTimeoutMs,
        absoluteRunTimeoutMs: REPLAY_POLICY.absoluteRunTimeoutMs,
        maxRetries: REPLAY_POLICY.maxRetries,
        rateLimitBackoffMs: REPLAY_POLICY.rateLimitBackoffMs,
      });
      const gate = new ProposalGateService({
        store: this.proposalStore,
        planner: this.materializationPlanner,
        resolveBaseSnapshot: value => resolveProposalBaseSnapshot(value),
        staticValidation,
        runPairedReplay: async (
          value,
          _candidate,
          treatment,
          treatmentBinding,
        ) => {
          treatmentByProposal.set(
            treatment.artifact.artifactId,
            treatment,
          );
          const replay = await replayService!.runner.run({
            scope,
            cases,
            pinned,
            candidateId: treatment.artifact.artifactId,
            treatmentBinding,
          });
          return {
            replay,
            cases,
            store: replayService!.store,
            publisher: replayService!.publisher,
            resolveBaselinePhaseHint: (scene, hintId) =>
              snapshot.strategyRegistry.getStrategy(scene)?.phaseHints.find(
                hint => hint.id === hintId,
              ),
          };
        },
      });
      return await gate.gate({scope, proposalId});
    } finally {
      replayService?.close();
    }
  }

  accept(scope: RunManifestScope, proposalId: string) {
    return this.proposalStore.accept(scope, proposalId);
  }

  reject(scope: RunManifestScope, proposalId: string) {
    return this.proposalStore.reject(scope, proposalId);
  }

  async exportContribution(
    scope: RunManifestScope,
    proposalId: string,
    actor: {userId?: string},
  ) {
    const source = PublicFeedbackCurationSource.open({scope});
    try {
      return await new ContributionBundleChannel({
        proposalStore: this.proposalStore,
        persistence: this.persistence,
        authorize: () => undefined,
        assertContributionEvidencePublic: async proposal => {
          const publicRunIds = new Set(
            (await source.listEffective()).flatMap(feedback =>
              feedback.runId ? [feedback.runId] : []),
          );
          const evidenceRunIds = [
            ...proposal.evidence.negativeRunIds,
            ...proposal.evidence.positiveRunIds,
          ];
          if (
            evidenceRunIds.length === 0
            || evidenceRunIds.some(runId => !publicRunIds.has(runId))
          ) {
            throw new Error('contribution_evidence_not_public');
          }
        },
      }).create({scope, proposalId, actor});
    } finally {
      source.close();
    }
  }

  async apply(
    scope: RunManifestScope,
    proposalId: string,
    actionId: string,
    actor: {userId?: string},
  ) {
    const runtime = this.requirePersistentRuntime();
    return new ProposalApplicationService({
      proposalStore: this.proposalStore,
      overlayRegistry: runtime.overlayRegistry,
      artifactStore: runtime.artifactStore,
      reconciler: runtime.reconciler,
      authorize: () => undefined,
      materializeArtifacts: proposal =>
        materializeOverlayArtifacts(proposal, actor),
    }).apply({scope, proposalId, actionId, actor});
  }

  async revert(
    scope: RunManifestScope,
    proposalId: string,
    actionId: string,
    actor: {userId?: string},
  ) {
    const runtime = this.requirePersistentRuntime();
    return new ProposalApplicationService({
      proposalStore: this.proposalStore,
      overlayRegistry: runtime.overlayRegistry,
      artifactStore: runtime.artifactStore,
      reconciler: runtime.reconciler,
      authorize: () => undefined,
      materializeArtifacts: () => {
        throw new Error('revert_does_not_materialize_artifacts');
      },
    }).revert({scope, proposalId, actionId, actor});
  }

  close(): void {
    this.overlayRegistry?.close();
    this.proposalStore.close();
  }

  private requirePersistentRuntime(): {
    overlayRegistry: EvolutionOverlayRegistry;
    artifactStore: EvolutionOverlayArtifactStore;
    reconciler: OverlayReconciler;
  } {
    if (!this.overlayRegistry || !this.artifactStore || !this.reconciler) {
      throw new Error('self_evolution_persistence_unavailable');
    }
    return {
      overlayRegistry: this.overlayRegistry,
      artifactStore: this.artifactStore,
      reconciler: this.reconciler,
    };
  }
}

let defaultService: SelfEvolutionAdminService | undefined;

export function getSelfEvolutionAdminService(): SelfEvolutionAdminService {
  if (!defaultService) {
    defaultService = new SelfEvolutionAdminService(
      new ProductionSelfEvolutionAdminDependencies(),
    );
  }
  return defaultService;
}

export function closeSelfEvolutionAdminService(): void {
  defaultService?.close();
  defaultService = undefined;
}

export function collectSelfEvolutionAdminOperationalMetrics(
  scope: RunManifestScope,
) {
  return getSelfEvolutionAdminService().operationalMetrics(scope);
}

function proposalSourceManifest(
  proposal: CurationProposalV1,
): RunManifestV1 {
  const runIds = [...new Set([
    ...proposal.evidence.negativeRunIds,
    ...proposal.evidence.positiveRunIds,
  ])].sort();
  if (runIds.length === 0) {
    throw new Error('paired_replay_source_manifest_unavailable');
  }
  const store = getRunManifestStore();
  const manifests = runIds.map(runId =>
    store.getByRunId(proposal.scope, runId));
  if (manifests.some(manifest => !manifest)) {
    throw new Error('paired_replay_source_manifest_unavailable');
  }
  return selectCompatibleEvidenceManifest(
    proposal,
    manifests as RunManifestV1[],
  );
}

function selectCompatibleEvidenceManifest(
  proposal: CurationProposalV1,
  manifests: readonly RunManifestV1[],
): RunManifestV1 {
  const source = manifests[0];
  if (!source) {
    throw new Error('paired_replay_source_manifest_unavailable');
  }
  for (const manifest of manifests) {
    if (
      manifest.skillRegistryFingerprint
        !== proposal.expectedRegistryFingerprint
      || manifest.evolutionOverlayGeneration
        !== proposal.expectedOverlayGeneration
    ) {
      throw new Error('paired_replay_source_manifest_mismatch');
    }
  }
  const sourceEnvironment = evidenceEnvironmentFingerprint(source);
  if (manifests.some(manifest =>
    evidenceEnvironmentFingerprint(manifest) !== sourceEnvironment)) {
    throw new Error(
      'paired_replay_source_manifest_environment_mismatch',
    );
  }
  return source;
}

function evidenceEnvironmentFingerprint(manifest: RunManifestV1): string {
  return canonicalContentHash({
    sceneType: manifest.sceneType,
    runtime: manifest.runtime,
    providerId: manifest.providerId ?? null,
    model: manifest.model ?? null,
    outputLanguage: manifest.outputLanguage,
    toolAllowlistHash: manifest.toolAllowlistHash,
    injections: manifest.injections,
    skillRegistryFingerprint: manifest.skillRegistryFingerprint,
    evolutionOverlayGeneration: manifest.evolutionOverlayGeneration,
  });
}

function selectPairedReplayCases(
  proposal: CurationProposalV1,
  sourceManifest: RunManifestV1,
  cases: readonly EvalCaseV1[],
): EvalCaseV1[] {
  const relevant = cases.filter(evalCase =>
    evalCase.scope.tenantId === proposal.scope.tenantId
    && evalCase.scope.workspaceId === proposal.scope.workspaceId
    && (
      evalCase.expectedScene === undefined
      || evalCase.expectedScene === sourceManifest.sceneType
    ));
  const validation = relevant
    .filter(evalCase => evalCase.split === 'validation')
    .sort((left, right) => left.caseId.localeCompare(right.caseId))
    .slice(0, 3);
  const holdout = relevant
    .filter(evalCase => evalCase.split === 'holdout')
    .sort((left, right) => left.caseId.localeCompare(right.caseId))
    .slice(0, 2);
  if (validation.length === 0 || holdout.length === 0) {
    throw new Error('paired_replay_cases_unavailable');
  }
  return [...validation, ...holdout].slice(0, 5);
}

function rolePlan(input: {
  role: 'baseline' | 'candidate';
  treatment: EvaluationRoleVariantV1;
  commonRegistry: EffectiveRuntimeRegistrySnapshot;
  selected?: RunInjectionAttribution;
}) {
  const refs = evaluationRoleVariantRefs({
    variant: input.treatment,
    role: input.role,
    resolveBaselinePhaseHint: (scene, hintId) =>
      input.commonRegistry.strategyRegistry
        .getStrategy(scene)?.phaseHints.find(hint => hint.id === hintId),
  });
  const expectedKeys = new Set(refs.materializedRefs.map(injectionRefKey));
  return {
    roleVariant: input.treatment,
    injectionContract: createEvaluationRoleInjectionContract({
      role: input.role,
      mode: 'on',
      selected: input.selected ?? EMPTY_INJECTIONS,
      reservedTreatmentNamespace: refs.treatmentNamespaceRefs,
      expectedMaterializedRefs: refs.materializedRefs,
      expectedObservedRefs: refs.materializedRefs.map(ref => ({
        ref,
        minimumGuarantee: 'sdk_handoff_observed',
      })),
      forbiddenObservedRefs: refs.treatmentNamespaceRefs.filter(
        ref => !expectedKeys.has(injectionRefKey(ref)),
      ),
    }),
    fullTreatmentContractHash:
      evaluationFullTreatmentContractHash(input.treatment),
  };
}

async function resolveProposalBaseSnapshot(
  proposal: CurationProposalV1,
): Promise<ProposalBaseSnapshotV1> {
  return (await resolveProposalBaseContext(proposal)).base;
}

async function resolveProposalBaseContext(
  proposal: CurationProposalV1,
): Promise<{
  base: ProposalBaseSnapshotV1;
  origin?: SkillOriginMetadata;
}> {
  const snapshot = await buildEffectiveRuntimeRegistrySnapshot({
    scope: proposal.scope,
  });
  const delta = proposal.deltas[0];
  const skill = snapshot.skillRegistry.getSkill(delta.targetId);
  if (skill) {
    const contentHash = fingerprintSkillDefinition(
      skill,
      snapshot.skillRegistry.getFragmentCache(),
    );
    return {
      base: {
        targetId: delta.targetId,
        contentHash,
        content: canonicalJsonString(skill),
        registryFingerprint: snapshot.skillRegistry.registryFingerprint,
        skillRegistryFingerprint:
          snapshot.skillRegistry.registryFingerprint,
        strategyRegistryFingerprint:
          snapshot.strategyRegistry.registryFingerprint,
        overlayGeneration: snapshot.overlayGeneration,
      },
      origin: snapshot.skillRegistry.getSkillOrigin(delta.targetId),
    };
  }
  const injection = findInjection(snapshot, delta.targetId);
  if (!injection) throw new Error('proposal_semantic_base_unavailable');
  return {
    base: {
      targetId: delta.targetId,
      contentHash: injection.contentHash,
      content: injection.content,
      registryFingerprint: snapshot.skillRegistry.registryFingerprint,
      skillRegistryFingerprint: snapshot.skillRegistry.registryFingerprint,
      strategyRegistryFingerprint:
        snapshot.strategyRegistry.registryFingerprint,
      overlayGeneration: snapshot.overlayGeneration,
    },
  };
}

function findInjection(
  snapshot: EffectiveRuntimeRegistrySnapshot,
  targetId: string,
): {contentHash: string; content: string} | undefined {
  for (const strategy of snapshot.strategyRegistry.getAllStrategies()) {
    const hint = strategy.phaseHints.find(candidate =>
      candidate.id === targetId);
    if (hint) {
      return {
        contentHash: evaluationPhaseHintInjectionContentHash(hint),
        content: canonicalJsonString(hint),
      };
    }
  }
  for (const skillId of snapshot.skillNotes.getSkillIds()) {
    const note = snapshot.skillNotes.getSkillNotes(skillId).find(candidate =>
      candidate.id === targetId);
    if (note) {
      return {
        contentHash: skillNoteContentHash(note),
        content: canonicalJsonString(note),
      };
    }
  }
  return undefined;
}

async function materializeOverlayArtifacts(
  accepted: CurationProposalV1,
  actor: {userId?: string},
): Promise<ProposalApplicationMaterializationV1> {
  if (accepted.status !== 'accepted' || accepted.revision !== 3) {
    throw new Error('proposal_not_eligible_for_apply');
  }
  const draft = asDraftProposal(accepted);
  const planner = new ProposalMaterializationPlanner(
    ProposalMaterializationRegistry.production(),
  );
  const plan = planner.plan(draft);
  const {base, origin} = await resolveProposalBaseContext(draft);
  const candidate = materializeProposalCandidate({
    proposal: draft,
    plan,
    base,
  });
  const treatment = materializeProposalTreatment({
    proposal: draft,
    candidate,
    base: {
      skillRegistryFingerprint: base.skillRegistryFingerprint,
      strategyRegistryFingerprint: base.strategyRegistryFingerprint,
    },
  });
  if (!treatment) {
    throw new Error('proposal_runtime_treatment_unavailable');
  }
  const sourceManifest = proposalSourceManifest(accepted);
  const artifacts = treatment.artifact.entries.map((entry, index) => {
    const payload = createEvolutionOverlayPayloadFromTreatmentEntry(entry);
    const provenance = overlayProvenance({
      proposal: accepted,
      payload,
      base,
      origin,
      sourceManifest,
      actor,
      overlayId: overlayIdFor(payload, accepted, index),
    });
    return createEvolutionOverlayArtifactV1({
      artifactId:
        `artifact:${accepted.proposalId}:${accepted.revision}:${index}`,
      payload,
      provenance,
    });
  });
  return {
    candidate,
    treatment: treatment.artifact,
    artifacts,
  };
}

function asDraftProposal(
  proposal: CurationProposalV1,
): CurationProposalV1 {
  const {
    gateResult: _gateResult,
    pairedGateVerdict: _pairedGateVerdict,
    activeActionId: _activeActionId,
    ...base
  } = proposal;
  return {
    ...base,
    revision: 1,
    pairedGateVerdict: 'not_run',
    status: 'draft',
  };
}

function overlayProvenance(input: {
  proposal: CurationProposalV1;
  payload: EvolutionOverlayPayloadV1;
  base: ProposalBaseSnapshotV1;
  origin?: SkillOriginMetadata;
  sourceManifest: RunManifestV1;
  actor: {userId?: string};
  overlayId: string;
}): EvolutionOverlayProvenanceV1 {
  const lifecycle = getSelfEvolutionLifecycleSnapshot();
  const identity = lifecycle.currentBuildIdentity;
  const overlayKind = input.payload.payloadKind === 'skill_delta'
    ? 'skill_delta'
    : input.payload.payloadKind === 'strategy_delta'
      ? 'strategy_delta'
      : 'skill_note';
  const baseKind = overlayKind === 'strategy_delta' ? 'strategy' : 'skill';
  const baseVersion = baseKind === 'skill'
    ? input.sourceManifest.skills.find(skill =>
        skill.skillId === input.proposal.deltas[0].targetId)?.version
      ?? identity.version
    : identity.version;
  return {
    schemaVersion: 1,
    overlayId: input.overlayId,
    overlayKind,
    overlayContentHash: canonicalContentHash(input.payload),
    deltaSchemaVersion: 1,
    proposalId: input.proposal.proposalId,
    proposalRevision: 3,
    gateVerdict: 'passed',
    derivedFrom: {
      baseKind,
      baseId: input.proposal.deltas[0].targetId,
      baseVersion,
      baseContentFingerprint:
        input.proposal.deltas[0].baseContentHash,
      baseOrigin: input.origin?.origin ?? 'built_in',
      ...(input.origin?.packId
        ? {basePackId: input.origin.packId}
        : {}),
      ...(input.origin?.packVersion
        ? {basePackVersion: input.origin.packVersion}
        : {}),
      ...(input.origin?.trustState
        ? {baseTrustState: input.origin.trustState}
        : {}),
    },
    dependencyFingerprints: {
      loaderSchemaVersion: EVOLUTION_OVERLAY_LOADER_SCHEMA_VERSION,
    },
    producedUnder: {
      buildIdentity: {
        distribution: identity.distribution,
        channel: identity.channel,
        version: identity.version,
        ...(identity.commit ? {commit: identity.commit} : {}),
        target: identity.target.id,
      },
      traceProcessorVersion: traceProcessorVersion(),
      testedMatrix: [{
        runtime: input.sourceManifest.runtime,
        ...(input.sourceManifest.providerId
          ? {providerId: input.sourceManifest.providerId}
          : {}),
        ...(input.sourceManifest.model
          ? {model: input.sourceManifest.model}
          : {}),
      }],
    },
    compatibility: {
      smartPerfettoMinVersion: identity.version,
      smartPerfettoMaxVersionTested: identity.version,
    },
    createdAt: Date.parse(input.proposal.createdAt),
    actor: input.actor.userId ? {userId: input.actor.userId} : {},
    scope: input.proposal.scope,
  };
}

function overlayIdFor(
  payload: EvolutionOverlayPayloadV1,
  proposal: CurationProposalV1,
  index: number,
): string {
  if (payload.payloadKind === 'skill_delta') {
    return payload.skillOverlay.overlayId;
  }
  return `evo_${canonicalContentHash({
    proposalId: proposal.proposalId,
    proposalRevision: proposal.revision,
    index,
    payload,
  }).slice(0, 32)}`;
}

function injectionRefKey(ref: {
  category: string;
  id: string;
  contentHash: string;
}): string {
  return `${ref.category}\0${ref.id}\0${ref.contentHash}`;
}

function traceProcessorVersion(): string {
  return process.env.SMARTPERFETTO_TRACE_PROCESSOR_VERSION?.trim()
    || 'unknown';
}

export const __testing = {
  selectPairedReplayCases,
  selectCompatibleEvidenceManifest,
};
