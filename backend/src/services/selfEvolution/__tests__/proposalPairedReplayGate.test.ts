// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunInjectionAttribution,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {EvalCaseStore} from '../evalCaseStore';
import {EvalReplayRunStore} from '../evalReplayRunStore';
import {
  commitEvaluationExposureSince,
  createEvaluationRoleInjectionContract,
  evaluationExposureCursor,
  registerEvaluationInjection,
  sealEvaluationExposureReceipt,
  withEvaluationInjectionContext,
} from '../evaluationInjectionContext';
import {
  attestEvaluationPair,
  createEvaluationMaterializationProof,
  createEvaluationRoleProofV2,
} from '../evaluationPairAttestation';
import {
  __testing as environmentTesting,
  normalizeEvaluationInjectionSelector,
  type EvaluationEnvironmentProofV1,
} from '../evaluationEnvironmentProof';
import {
  EvaluationReplayPublisher,
} from '../evaluationReplayPublisher';
import {
  createProposalCandidateMaterializationV1,
  proposalDraftContentHash,
} from '../proposalGateContract';
import {evaluateProposalPairedReplay} from '../proposalPairedReplayGate';
import {materializeProposalTreatment} from '../proposalTreatmentMaterializer';
import {
  evaluationFullTreatmentContractHash,
  evaluationRoleVariantRefs,
  type EvaluationRoleVariantRefsV1,
} from '../evaluationTreatment';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a'};
const EMPTY_INJECTIONS: RunInjectionAttribution = {
  patterns: [],
  skillNotes: [],
  cases: [],
  phaseHints: [],
  knowledgeDocs: [],
};
const pinned: EvalPinnedEnvironmentV1 = {
  runtime: 'openai-agents-sdk',
  providerId: null,
  model: 'gpt-eval',
  outputLanguage: 'zh-CN',
  toolAllowlistHash: canonicalContentHash(['query_trace']),
  injections: 'on',
  overlayGeneration: 'builtin:registry-a',
};
const gateAttempt = {
  attemptId: 'gate-attempt-a',
  ordinal: 1,
  gatePolicyFingerprint: canonicalContentHash('gate-policy-a'),
};
const persistence = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/proposal-paired-replay',
  packageRoot: '/app',
  checkedAt: 1,
} as const;

describe('M7 paired replay proof binding', () => {
  it('passes bound validation and holdout evidence, then rejects L1 decline', async () => {
    const proposal = draftProposal();
    const planContentHash = canonicalContentHash('plan-a');
    const candidate = createProposalCandidateMaterializationV1({
      proposalId: proposal.proposalId,
      proposalRevision: 1,
      draftContentHash: proposalDraftContentHash(proposal),
      planContentHash,
      artifactId: [
        'proposal',
        proposal.proposalId,
        1,
        proposalDraftContentHash(proposal),
        planContentHash,
      ].join(':'),
      targetKind: 'skill_note',
      serializedContent: '{"safe":true}',
    });
    const treatment = treatmentFor(proposal, candidate);
    const cases = [
      evalCase('validation-a', 'validation'),
      evalCase('holdout-a', 'holdout'),
    ];
    const good = await replayEvidence(
      cases,
      candidate,
      treatment,
      'replay-run-good',
      {
        claimVerifiedRatio: 0.89,
        unsupportedClaims: 1,
        evidenceAnchors: 4,
      },
    );
    try {
      const proof = await evaluateProposalPairedReplay({
        proposal,
        candidate,
        treatment,
        gateAttempt,
        replay: good.replay,
        cases,
        store: good.store,
        publisher: good.publisher,
      });
      expect(proof).toMatchObject({
        verdict: 'passed',
        splitSummaries: [
          {split: 'validation', verdict: 'passed'},
          {split: 'holdout', verdict: 'passed'},
        ],
      });

      const bad = await replayEvidence(
        cases,
        candidate,
        treatment,
        'replay-run-bad',
        {
        claimVerifiedRatio: 0.95,
        unsupportedClaims: 2,
        evidenceAnchors: 10,
        },
      );
      try {
        expect((await evaluateProposalPairedReplay({
          proposal,
          candidate,
          treatment,
          gateAttempt,
          replay: bad.replay,
          cases,
          store: bad.store,
          publisher: bad.publisher,
        })).verdict).toBe('failed');
      } finally {
        bad.close();
      }

      const emptyContract = await replayEvidence(
        cases,
        candidate,
        treatment,
        'replay-run-empty-contract',
        {
          claimVerifiedRatio: 0.9,
          unsupportedClaims: 1,
          evidenceAnchors: 4,
        },
        true,
      );
      try {
        await expect(evaluateProposalPairedReplay({
          proposal,
          candidate,
          treatment,
          gateAttempt,
          replay: emptyContract.replay,
          cases,
          store: emptyContract.store,
          publisher: emptyContract.publisher,
        })).rejects.toThrow(
          'paired_replay_role_contract_not_derived_from_treatment',
        );
      } finally {
        emptyContract.close();
      }

      const injectionModeMismatch = await replayEvidence(
        cases,
        candidate,
        treatment,
        'replay-run-injection-mode-mismatch',
        {
          claimVerifiedRatio: 0.9,
          unsupportedClaims: 1,
          evidenceAnchors: 4,
        },
        false,
        'off',
      );
      try {
        await expect(evaluateProposalPairedReplay({
          proposal,
          candidate,
          treatment,
          gateAttempt,
          replay: injectionModeMismatch.replay,
          cases,
          store: injectionModeMismatch.store,
          publisher: injectionModeMismatch.publisher,
        })).rejects.toThrow(
          'paired_replay_role_contract_mode_mismatch',
        );
      } finally {
        injectionModeMismatch.close();
      }
    } finally {
      good.close();
    }
  });

  it('rejects a replay whose run spec is not bound to the materialization', async () => {
    const proposal = draftProposal();
    const candidate = createProposalCandidateMaterializationV1({
      proposalId: proposal.proposalId,
      proposalRevision: 1,
      draftContentHash: proposalDraftContentHash(proposal),
      planContentHash: canonicalContentHash('plan-a'),
      artifactId: 'proposal:wrong-artifact',
      targetKind: 'skill_note',
      serializedContent: '{"safe":true}',
    });
    const treatment = treatmentFor(proposal, candidate);
    const evidence = await replayEvidence(
      [
        evalCase('validation-wrong', 'validation'),
        evalCase('holdout-wrong', 'holdout'),
      ],
      candidate,
      treatment,
      'replay-run-wrong',
      {
        claimVerifiedRatio: 0.9,
        unsupportedClaims: 1,
        evidenceAnchors: 4,
      },
    );
    const otherCandidate = createProposalCandidateMaterializationV1({
      proposalId: proposal.proposalId,
      proposalRevision: 1,
      draftContentHash: proposalDraftContentHash(proposal),
      planContentHash: canonicalContentHash('plan-b'),
      artifactId: 'proposal:different-artifact',
      targetKind: 'skill_note',
      serializedContent: '{"safe":true}',
    });
    try {
      await expect(evaluateProposalPairedReplay({
        proposal,
        candidate: otherCandidate,
        treatment,
        gateAttempt,
        replay: evidence.replay,
        cases: [
          evalCase('validation-wrong', 'validation'),
          evalCase('holdout-wrong', 'holdout'),
        ],
        store: evidence.store,
        publisher: evidence.publisher,
      })).rejects.toThrow('paired_replay_candidate_binding_mismatch');
    } finally {
      evidence.close();
    }
  });
});

async function replayEvidence(
  cases: readonly EvalCaseV1[],
  materialization: ReturnType<
    typeof createProposalCandidateMaterializationV1
  >,
  treatment: NonNullable<ReturnType<typeof materializeProposalTreatment>>,
  runId: string,
  candidateL1: EvalScoreV1['l1'],
  useEmptyTreatmentContracts = false,
  roleContractMode: EvalPinnedEnvironmentV1['injections'] = pinned.injections,
) {
  const treatmentBinding = bindingFor(materialization, treatment);
  const store = new EvalReplayRunStore({persistence});
  const runSpec = store.putRunSpec({
    runId,
    scope,
    caseFingerprints: cases.map(item => ({
      caseId: item.caseId,
      contentHash: canonicalContentHash(item),
    })),
    pinned,
    candidateId: materialization.artifactId,
    treatmentBinding,
    executionPolicy: {
      concurrency: 1,
      taskTimeoutMs: 10_000,
      absoluteRunTimeoutMs: 60_000,
      maxRetries: 0,
      rateLimitBackoffMs: [],
      leaseMs: 10_000,
      abortTimeoutMs: 1_000,
      tolerancePresetContentHash: canonicalContentHash('tolerance'),
      executionContractFingerprint: canonicalContentHash('execution'),
    },
    createdAt: 1_000,
    absoluteDeadlineAt: 61_000,
  });
  const evalCaseStore = new EvalCaseStore({persistence});
  cases.forEach(item => evalCaseStore.putCase(scope, item));
  const publisher = new EvaluationReplayPublisher({
    persistence,
    evalCaseStore,
    resolveBaselineContext: () => {
      throw new Error('test_baseline_lookup_not_expected');
    },
    isPublicationCommitted: input =>
      store.isPublicationCommitted(input),
  });
  const attestations: Record<string, ReturnType<typeof attestEvaluationPair>> =
    {};
  const treatmentRefs = {
    baseline: evaluationRoleVariantRefs({
      variant: treatment.roleVariant,
      role: 'baseline',
      resolveBaselinePhaseHint: () => undefined,
    }),
    candidate: evaluationRoleVariantRefs({
      variant: treatment.roleVariant,
      role: 'candidate',
      resolveBaselinePhaseHint: () => undefined,
    }),
  };
  for (const item of cases) {
    const baselineContract = roleContract(
      'baseline',
      treatmentRefs.baseline,
      useEmptyTreatmentContracts,
      roleContractMode,
    );
    const candidateContract = roleContract(
      'candidate',
      treatmentRefs.candidate,
      useEmptyTreatmentContracts,
      roleContractMode,
    );
    const baselineEnvironment = environmentProof(item.caseId, 'baseline');
    const candidateEnvironment = environmentProof(item.caseId, 'candidate');
    const baselineReceipt = await withEvaluationInjectionContext({
      contract: baselineContract,
    }, async () => exposureReceipt(baselineContract.expectedObservedRefs));
    const candidateReceipt = await withEvaluationInjectionContext({
      contract: candidateContract,
    }, async () => exposureReceipt(candidateContract.expectedObservedRefs));
    const commonBaseHash = canonicalContentHash('common-base');
    const baselineProof = createEvaluationRoleProofV2({
      role: 'baseline',
      baseProof: baselineEnvironment,
      contract: baselineContract,
      materialization: createEvaluationMaterializationProof({
        artifactId: `baseline:${materialization.artifactId}`,
        sourceCandidateContentHash:
          treatmentBinding.candidateContentHash,
        treatmentArtifactContentHash:
          treatmentBinding.treatmentArtifactContentHash,
        materializedInputHash: treatmentBinding.materializedInputHash,
        baseRegistryContentHash: commonBaseHash,
        persistentOverlayGeneration: pinned.overlayGeneration,
        treatmentGeneration:
          `evaluation:baseline:${treatment.roleVariant.treatmentGeneration}`,
        materializedRefs: baselineContract.expectedMaterializedRefs,
        effectiveSkillRegistryFingerprint:
          treatment.roleVariant.baseSkillRegistryFingerprint,
        effectiveStrategyRegistryFingerprint:
          treatment.roleVariant.baseStrategyRegistryFingerprint,
      }),
      exposureReceipt: baselineReceipt,
      commonBaseRegistryContentHash: commonBaseHash,
      proofId: `proof-${item.caseId}-baseline`,
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
    const candidateProof = createEvaluationRoleProofV2({
      role: 'candidate',
      baseProof: candidateEnvironment,
      contract: candidateContract,
      materialization: createEvaluationMaterializationProof({
        artifactId: materialization.artifactId,
        sourceCandidateContentHash:
          treatmentBinding.candidateContentHash,
        treatmentArtifactContentHash:
          treatmentBinding.treatmentArtifactContentHash,
        materializedInputHash: treatmentBinding.materializedInputHash,
        baseRegistryContentHash: commonBaseHash,
        persistentOverlayGeneration: pinned.overlayGeneration,
        treatmentGeneration: candidateTreatmentGeneration(treatment),
        materializedRefs: candidateContract.expectedMaterializedRefs,
        effectiveSkillRegistryFingerprint:
          treatment.roleVariant.baseSkillRegistryFingerprint,
        effectiveStrategyRegistryFingerprint:
          treatment.roleVariant.baseStrategyRegistryFingerprint,
      }),
      exposureReceipt: candidateReceipt,
      commonBaseRegistryContentHash: commonBaseHash,
      proofId: `proof-${item.caseId}-candidate`,
      capturedAt: '2026-07-29T00:00:01.000Z',
    });
    await publishCompletedRole({
      item,
      role: 'baseline',
      environmentProof: baselineEnvironment,
      roleProof: baselineProof,
      roleContract: baselineContract,
      score: score(item, 'baseline', baselineEnvironment, {
        claimVerifiedRatio: 0.9,
        unsupportedClaims: 1,
        evidenceAnchors: 4,
      }),
    });
    await publishCompletedRole({
      item,
      role: 'candidate',
      environmentProof: candidateEnvironment,
      roleProof: candidateProof,
      roleContract: candidateContract,
      score: score(
        item,
        'candidate',
        candidateEnvironment,
        candidateL1,
        materialization.artifactId,
      ),
    });
    attestations[item.caseId] = attestEvaluationPair({
      baseline: baselineProof,
      candidate: candidateProof,
      baselineContract,
      candidateContract,
      fullTreatmentContractHash:
        treatmentBinding.fullTreatmentContractHash,
      attestationId: `attestation-${item.caseId}`,
      capturedAt: '2026-07-29T00:00:02.000Z',
    });
  }
  const tasks = store.list(scope, runSpec.runId);
  return {
    store,
    replay: {
      runId: runSpec.runId,
      tasks,
      comparisons: {},
      attestations,
    },
    publisher,
    close: () => {
      publisher.close();
      evalCaseStore.close();
      store.close();
    },
  };

  async function publishCompletedRole(input: {
    item: EvalCaseV1;
    role: 'baseline' | 'candidate';
    score: EvalScoreV1;
    environmentProof: EvaluationEnvironmentProofV1;
    roleProof: ReturnType<typeof createEvaluationRoleProofV2>;
    roleContract: ReturnType<typeof createEvaluationRoleInjectionContract>;
  }): Promise<void> {
    const queued = store.enqueue({
      runId: runSpec.runId,
      runSpecHash: runSpec.contentHash,
      scope,
      caseId: input.item.caseId,
      role: input.role,
      pinned,
      candidateId: materialization.artifactId,
      treatmentBinding,
      absoluteDeadlineAt: runSpec.absoluteDeadlineAt,
      now: 2_000,
    });
    const claimed = store.claimNext({
      scope,
      runId: runSpec.runId,
      leaseMs: 10_000,
      maxConcurrent: 1,
      now: 2_001,
    });
    if (
      !claimed
      || claimed.taskId !== queued.taskId
      || !claimed.executionToken
    ) {
      throw new Error('test_replay_task_not_claimed');
    }
    const resultRef = await publisher.publish({
      score: input.score,
      environmentProof: input.environmentProof,
      roleProof: input.roleProof,
      roleContract: input.roleContract,
      treatmentBinding,
      fullTreatmentContractHash:
        treatmentBinding.fullTreatmentContractHash,
      frozenArtifactsHash: canonicalContentHash(
        `${input.item.caseId}:${input.role}:frozen`,
      ),
      executionFence: {
        taskId: claimed.taskId,
        executionToken: claimed.executionToken,
      },
      isAuthoritative: () => store.isAuthoritative({
        scope,
        taskId: claimed.taskId,
        executionToken: claimed.executionToken!,
      }),
    });
    store.complete({
      scope,
      taskId: claimed.taskId,
      executionToken: claimed.executionToken,
      resultRef,
      usage: {
        schemaVersion: 1,
        tokens: 1,
        toolCalls: 1,
        wallclockMs: 1,
        traceProcessorCpuMs: 1,
      },
      now: 2_002,
    });
  }
}

function roleContract(
  role: 'baseline' | 'candidate',
  refs: EvaluationRoleVariantRefsV1,
  empty: boolean,
  mode: EvalPinnedEnvironmentV1['injections'] = pinned.injections,
) {
  const expectedMaterializedRefs = empty ? [] : refs.materializedRefs;
  const expectedObserved = mode === 'on' ? expectedMaterializedRefs : [];
  const expectedKeys = new Set(expectedObserved.map(refKey));
  return createEvaluationRoleInjectionContract({
    role,
    mode,
    selected: EMPTY_INJECTIONS,
    reservedTreatmentNamespace: empty ? [] : refs.treatmentNamespaceRefs,
    expectedMaterializedRefs,
    expectedObservedRefs: expectedObserved.map(ref => ({
      ref,
      minimumGuarantee: 'provider_request_observed',
    })),
    forbiddenObservedRefs: empty
      ? []
      : refs.treatmentNamespaceRefs.filter(ref => !expectedKeys.has(refKey(ref))),
  });
}

async function exposureReceipt(
  expected: ReturnType<typeof roleContract>['expectedObservedRefs'],
) {
  for (const entry of expected) {
    const cursor = evaluationExposureCursor();
    registerEvaluationInjection({
      ...entry.ref,
      placement: 'test-provider-request',
    });
    commitEvaluationExposureSince(cursor, 'provider_request_observed');
  }
  return sealEvaluationExposureReceipt();
}

function candidateTreatmentGeneration(
  treatment: NonNullable<ReturnType<typeof materializeProposalTreatment>>,
): string {
  return `evaluation:${canonicalContentHash({
    declared: treatment.roleVariant.treatmentGeneration,
    materializedInputHash: treatment.roleVariant.materializedInputHash,
    effectiveSkillRegistryFingerprint:
      treatment.roleVariant.baseSkillRegistryFingerprint,
    effectiveStrategyRegistryFingerprint:
      treatment.roleVariant.baseStrategyRegistryFingerprint,
  })}`;
}

function refKey(ref: {
  category: string;
  id: string;
  contentHash: string;
}): string {
  return `${ref.category}\0${ref.id}\0${ref.contentHash}`;
}

function environmentProof(
  caseId: string,
  role: 'baseline' | 'candidate',
): EvaluationEnvironmentProofV1 {
  const generation = {
    schemaVersion: 1 as const,
    entries: [{
      scope: {
        level: 'workspace' as const,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        userId: null,
      },
      revision: 0,
      inFlight: 0,
    }],
  };
  const generationFingerprint = canonicalContentHash(generation);
  const selector = normalizeEvaluationInjectionSelector({
    schemaVersion: 1,
    mode: pinned.injections,
    selected: EMPTY_INJECTIONS,
  });
  const withoutHash: Omit<EvaluationEnvironmentProofV1, 'contentHash'> = {
    schemaVersion: 1,
    proofId: `environment-${caseId}-${role}`,
    runId: `analysis-${caseId}-${role}`,
    runManifestId: `manifest-${caseId}-${role}`,
    evaluationStartContentHash: canonicalContentHash(
      `start-${caseId}-${role}`,
    ),
    scope,
    pinned,
    providerSnapshotHash: canonicalContentHash('provider'),
    providerMutationGeneration: generation,
    providerMutationGenerationFingerprint: generationFingerprint,
    injections: EMPTY_INJECTIONS,
    injectionSetHash: canonicalContentHash(EMPTY_INJECTIONS),
    injectionSelectorConfigFingerprint: canonicalContentHash(selector),
    environmentFingerprint: environmentTesting.environmentFingerprint({
      pinned,
      providerSnapshotHash: canonicalContentHash('provider'),
      providerMutationGenerationFingerprint: generationFingerprint,
      injectionSelectorConfigFingerprint: canonicalContentHash(selector),
    }),
    capturedAt: '2026-07-29T00:00:00.000Z',
  };
  return {
    ...withoutHash,
    contentHash: environmentTesting.proofContentHash(withoutHash),
  };
}

function score(
  item: EvalCaseV1,
  role: 'baseline' | 'candidate',
  environment: EvaluationEnvironmentProofV1,
  l1: EvalScoreV1['l1'],
  candidateId?: string,
): EvalScoreV1 {
  return {
    schemaVersion: 1,
    caseId: item.caseId,
    evalSetId: item.evalSetId,
    runId: environment.runId,
    runManifestId: environment.runManifestId,
    attempt: 1,
    role,
    ...(role === 'candidate'
      ? {candidateId: candidateId!}
      : {}),
    scope,
    pinned,
    availability: 'available',
    l0: {
      runOk: true,
      sqlErrorFree: true,
      reportContractPass: true,
      skillCrashFree: true,
    },
    l1,
    l3: {
      turns: 1,
      wallclockMs: 1,
      estimatedTokens: 1,
      toolCalls: 1,
    },
  };
}

function treatmentFor(
  proposal: CurationProposalV1,
  candidate: ReturnType<typeof createProposalCandidateMaterializationV1>,
) {
  const treatment = materializeProposalTreatment({
    proposal,
    candidate,
    base: {
      skillRegistryFingerprint: canonicalContentHash('skills'),
      strategyRegistryFingerprint: canonicalContentHash('strategies'),
    },
  });
  if (!treatment) throw new Error('test_treatment_missing');
  return treatment;
}

function bindingFor(
  candidate: ReturnType<typeof createProposalCandidateMaterializationV1>,
  treatment: NonNullable<ReturnType<typeof materializeProposalTreatment>>,
) {
  return {
    candidateContentHash: candidate.contentHash,
    treatmentArtifactContentHash: treatment.artifact.contentHash,
    materializedInputHash: treatment.roleVariant.materializedInputHash,
    fullTreatmentContractHash:
      evaluationFullTreatmentContractHash(treatment.roleVariant),
  };
}

function evalCase(
  caseId: string,
  split: 'validation' | 'holdout',
): EvalCaseV1 {
  return {
    schemaVersion: 1,
    caseId,
    evalSetId: 'set-a',
    origin: 'manual_golden',
    scope,
    traces: [{
      role: 'current',
      corpusId: canonicalContentHash(`${caseId}:corpus`),
      contentHash: canonicalContentHash(`${caseId}:trace`),
    }],
    query: `Analyze ${caseId}.`,
    analysisMode: 'full',
    split,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function draftProposal(): CurationProposalV1 {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-paired-gate',
    revision: 1,
    idempotencyKey: canonicalContentHash('proposal-paired-gate'),
    kind: 'skill_note',
    tier: 'T1',
    title: 'Improve evidence',
    rationale: 'Three negative runs share one failure.',
    deltas: [{
      op: 'add',
      targetKind: 'skill_note',
      targetId: 'skill-a',
      operationId: 'operation-a',
      anchor: 'skillNotes[skillId="skill-a"]',
      baseContentHash: canonicalContentHash('skill-a'),
      after: 'Collect a bounded fallback.',
    }],
    expectedRegistryFingerprint: canonicalContentHash('registry-a'),
    expectedOverlayGeneration: 'builtin:registry-a',
    evidence: {
      negativeRunIds: ['run-0', 'run-1', 'run-2'],
      positiveRunIds: ['run-3', 'run-4', 'run-5', 'run-6', 'run-7'],
      labeledCount: 8,
      negativeCount: 3,
      distinctTraceCount: 1,
      distinctSessionCount: 8,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: 'not_run',
    expectedEffect: 'Improve evidence.',
    riskLevel: 'low',
    status: 'draft',
    scope,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}
