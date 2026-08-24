// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  EvalCaseV1,
  EvalScoreV1,
  ProposalCandidateMaterializationV1,
  ProposalPairedReplayProofV1,
  ProposalPairedReplaySplitSummaryV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import type {PhaseHint} from '../../agentv3/strategyLoader';
import {
  attestEvaluationPair,
  type EvaluationPairAttestationV1,
} from './evaluationPairAttestation';
import {
  EvaluationReplayPublisher,
  type EvaluationReplayPublishedRecordV1,
} from './evaluationReplayPublisher';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import {parseEvalCase} from './evalContracts';
import {
  EvalReplayRunStore,
  type ReplayRunSpecV1,
  type ReplayTaskRecordV1,
} from './evalReplayRunStore';
import {
  createProposalPairedReplayProofV1,
  parseProposalCandidateMaterializationV1,
  proposalDraftContentHash,
} from './proposalGateContract';
import {parseM6DraftProposal} from './proposalContract';
import type {ReplayRunResult} from './replayRunner';
import type {
  EvaluationRoleInjectionContractV1,
} from './evaluationInjectionContext';
import {
  evaluationFullTreatmentContractHash,
  evaluationRoleVariantRefs,
  type EvaluationRoleVariantV1,
  type EvaluationRoleVariantRefsV1,
  type EvaluationTreatmentArtifactV1,
} from './evaluationTreatment';

const EPSILON = 0.02;
const trustedPairedReplayProofs = new WeakSet<object>();

interface Pair {
  evalCase: EvalCaseV1;
  baseline: EvaluationReplayPublishedRecordV1;
  candidate: EvaluationReplayPublishedRecordV1;
  attestation: EvaluationPairAttestationV1;
}

export async function evaluateProposalPairedReplay(input: {
  proposal: CurationProposalV1;
  candidate: ProposalCandidateMaterializationV1;
  gateAttempt: {
    attemptId: string;
    ordinal: number;
    gatePolicyFingerprint: string;
  };
  treatment: {
    artifact: EvaluationTreatmentArtifactV1;
    roleVariant: EvaluationRoleVariantV1;
  };
  replay: ReplayRunResult;
  cases: readonly EvalCaseV1[];
  store: EvalReplayRunStore;
  publisher: EvaluationReplayPublisher;
  resolveBaselinePhaseHint?(
    scene: string,
    hintId: string,
  ): PhaseHint | undefined;
}): Promise<ProposalPairedReplayProofV1> {
  const proposal = parseM6DraftProposal(input.proposal);
  const candidate = parseProposalCandidateMaterializationV1(input.candidate);
  if (
    !(input.store instanceof EvalReplayRunStore)
    || !(input.publisher instanceof EvaluationReplayPublisher)
  ) {
    throw new Error('paired_replay_evidence_reader_not_authoritative');
  }
  const runSpec = input.store.getRunSpec(proposal.scope, input.replay.runId);
  if (!runSpec) throw new Error('paired_replay_run_spec_unavailable');
  assertRunSpecBinding(proposal, candidate, input.treatment, runSpec);
  const cases = input.cases.map(parseEvalCase).sort(
    (left, right) => left.caseId.localeCompare(right.caseId),
  );
  assertCaseBindings(proposal.scope, cases, runSpec);
  const expectedRoleRefs = {
    baseline: evaluationRoleVariantRefs({
      variant: input.treatment.roleVariant,
      role: 'baseline',
      resolveBaselinePhaseHint: (scene, hintId) =>
        input.resolveBaselinePhaseHint?.(scene, hintId),
    }),
    candidate: evaluationRoleVariantRefs({
      variant: input.treatment.roleVariant,
      role: 'candidate',
      resolveBaselinePhaseHint: (scene, hintId) =>
        input.resolveBaselinePhaseHint?.(scene, hintId),
    }),
  };
  const trustedTasks = input.store.list(proposal.scope, runSpec.runId);
  assertFreshReplayResult(input.replay, trustedTasks);
  const pairs: Pair[] = [];
  for (const evalCase of cases) {
    if (evalCase.split === 'train') continue;
    pairs.push(await loadPair({
      evalCase,
      candidate,
      runSpec,
      tasks: trustedTasks,
      attestation: input.replay.attestations[evalCase.caseId],
      publisher: input.publisher,
      scope: proposal.scope,
      roleVariant: input.treatment.roleVariant,
      expectedRoleRefs,
    }));
  }
  const splitSummaries = (['validation', 'holdout'] as const).map(split =>
    summarizeSplit(split, pairs.filter(pair => pair.evalCase.split === split)));
  const verdict = splitSummaries.some(summary => summary.verdict === 'failed')
    ? 'failed'
    : splitSummaries.some(summary => summary.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'passed';
  const proof = createProposalPairedReplayProofV1({
    proposalId: proposal.proposalId,
    proposalRevision: 1,
    gateAttemptId: input.gateAttempt.attemptId,
    gateAttemptOrdinal: input.gateAttempt.ordinal,
    gatePolicyFingerprint: input.gateAttempt.gatePolicyFingerprint,
    draftContentHash: proposalDraftContentHash(proposal),
    candidateArtifactId: candidate.artifactId,
    candidateMaterializationContentHash: candidate.contentHash,
    runId: runSpec.runId,
    runSpecContentHash: runSpec.contentHash,
    pinnedContentHash: canonicalContentHash(runSpec.pinned),
    ...runSpec.treatmentBinding,
    caseContentHashes: cases.map(evalCase => ({
      caseId: evalCase.caseId,
      split: evalCase.split,
      contentHash: canonicalContentHash(evalCase),
    })),
    publishedRecords: pairs.flatMap(pair => [
      {
        caseId: pair.evalCase.caseId,
        role: 'baseline' as const,
        resultRef: pair.baseline.resultRef,
        contentHash: pair.baseline.contentHash,
      },
      {
        caseId: pair.evalCase.caseId,
        role: 'candidate' as const,
        resultRef: pair.candidate.resultRef,
        contentHash: pair.candidate.contentHash,
      },
    ]).sort((left, right) =>
      left.caseId.localeCompare(right.caseId)
      || left.role.localeCompare(right.role)),
    attestationContentHashes: pairs
      .map(pair => pair.attestation.contentHash)
      .sort(),
    splitSummaries,
    epsilon: EPSILON,
    verdict,
  });
  trustedPairedReplayProofs.add(proof);
  return proof;
}

export function assertTrustedProposalPairedReplayProof(
  value: ProposalPairedReplayProofV1,
): void {
  if (!trustedPairedReplayProofs.has(value)) {
    throw new Error('curation_gate_paired_evidence_not_authoritative');
  }
}

function assertRunSpecBinding(
  proposal: CurationProposalV1,
  candidate: ProposalCandidateMaterializationV1,
  treatment: {
    artifact: EvaluationTreatmentArtifactV1;
    roleVariant: EvaluationRoleVariantV1;
  },
  runSpec: ReplayRunSpecV1,
): void {
  if (
    runSpec.candidateId !== candidate.artifactId
    || candidate.proposalId !== proposal.proposalId
    || candidate.draftContentHash !== proposalDraftContentHash(proposal)
    || runSpec.treatmentBinding.candidateContentHash !== candidate.contentHash
    || treatment.artifact.sourceCandidateContentHash !== candidate.contentHash
    || treatment.roleVariant.sourceCandidateContentHash !== candidate.contentHash
    || runSpec.treatmentBinding.treatmentArtifactContentHash
      !== treatment.artifact.contentHash
    || runSpec.treatmentBinding.treatmentArtifactContentHash
      !== treatment.roleVariant.treatmentArtifactContentHash
    || runSpec.treatmentBinding.materializedInputHash
      !== treatment.roleVariant.materializedInputHash
    || runSpec.treatmentBinding.fullTreatmentContractHash
      !== evaluationFullTreatmentContractHash(treatment.roleVariant)
    || !sameScope(runSpec.scope, proposal.scope)
  ) {
    throw new Error('paired_replay_candidate_binding_mismatch');
  }
}

function assertCaseBindings(
  scope: RunManifestScope,
  cases: readonly EvalCaseV1[],
  runSpec: ReplayRunSpecV1,
): void {
  if (
    cases.length !== runSpec.caseFingerprints.length
    || new Set(cases.map(evalCase => evalCase.caseId)).size !== cases.length
    || !cases.some(evalCase => evalCase.split === 'validation')
    || !cases.some(evalCase => evalCase.split === 'holdout')
    || cases.some(evalCase => !sameScope(evalCase.scope, scope))
  ) {
    throw new Error('paired_replay_case_set_invalid');
  }
  const expected = new Map(
    runSpec.caseFingerprints.map(item => [item.caseId, item.contentHash]),
  );
  if (cases.some(evalCase =>
    expected.get(evalCase.caseId) !== canonicalContentHash(evalCase))) {
    throw new Error('paired_replay_case_hash_mismatch');
  }
}

function assertFreshReplayResult(
  replay: ReplayRunResult,
  trustedTasks: readonly ReplayTaskRecordV1[],
): void {
  const replayHashes = replay.tasks.map(task => task.contentHash).sort();
  const trustedHashes = trustedTasks.map(task => task.contentHash).sort();
  if (
    replay.runId !== trustedTasks[0]?.runId
    || canonicalJsonString(replayHashes) !== canonicalJsonString(trustedHashes)
  ) {
    throw new Error('paired_replay_result_not_fresh');
  }
}

async function loadPair(input: {
  evalCase: EvalCaseV1;
  candidate: ProposalCandidateMaterializationV1;
  runSpec: ReplayRunSpecV1;
  tasks: readonly ReplayTaskRecordV1[];
  attestation?: EvaluationPairAttestationV1;
  publisher: EvaluationReplayPublisher;
  scope: RunManifestScope;
  roleVariant: EvaluationRoleVariantV1;
  expectedRoleRefs: Record<
    'baseline' | 'candidate',
    EvaluationRoleVariantRefsV1
  >;
}): Promise<Pair> {
  const baselineTask = uniqueTask(input.tasks, input.evalCase.caseId, 'baseline');
  const candidateTask = uniqueTask(input.tasks, input.evalCase.caseId, 'candidate');
  if (
    baselineTask.state !== 'completed'
    || candidateTask.state !== 'completed'
    || !baselineTask.resultRef
    || !candidateTask.resultRef
    || baselineTask.runSpecHash !== input.runSpec.contentHash
    || candidateTask.runSpecHash !== input.runSpec.contentHash
    || candidateTask.candidateId !== input.candidate.artifactId
    || canonicalJsonString(baselineTask.treatmentBinding)
      !== canonicalJsonString(input.runSpec.treatmentBinding)
    || canonicalJsonString(candidateTask.treatmentBinding)
      !== canonicalJsonString(input.runSpec.treatmentBinding)
  ) {
    throw new Error('paired_replay_task_incomplete');
  }
  const baseline = await input.publisher.loadPublishedRecord({
    scope: input.scope,
    resultRef: baselineTask.resultRef,
  });
  const candidate = await input.publisher.loadPublishedRecord({
    scope: input.scope,
    resultRef: candidateTask.resultRef,
  });
  if (!baseline || !candidate) {
    throw new Error('paired_replay_published_record_unavailable');
  }
  assertPublishedBinding(
    input.evalCase,
    input.runSpec,
    input.candidate,
    baselineTask,
    candidateTask,
    baseline,
    candidate,
    input.roleVariant,
    input.expectedRoleRefs,
  );
  if (!input.attestation) {
    throw new Error('paired_replay_attestation_unavailable');
  }
  const recomputed = attestEvaluationPair({
    baseline: baseline.roleProof,
    candidate: candidate.roleProof,
    baselineContract: baseline.roleContract,
    candidateContract: candidate.roleContract,
    fullTreatmentContractHash: candidate.fullTreatmentContractHash,
    attestationId: input.attestation.attestationId,
    capturedAt: input.attestation.capturedAt,
  });
  if (
    recomputed.contentHash !== input.attestation.contentHash
    || canonicalJsonString(recomputed)
      !== canonicalJsonString(input.attestation)
  ) {
    throw new Error('paired_replay_attestation_mismatch');
  }
  return {
    evalCase: input.evalCase,
    baseline,
    candidate,
    attestation: recomputed,
  };
}

function assertPublishedBinding(
  evalCase: EvalCaseV1,
  runSpec: ReplayRunSpecV1,
  materialization: ProposalCandidateMaterializationV1,
  baselineTask: ReplayTaskRecordV1,
  candidateTask: ReplayTaskRecordV1,
  baseline: EvaluationReplayPublishedRecordV1,
  candidate: EvaluationReplayPublishedRecordV1,
  roleVariant: EvaluationRoleVariantV1,
  expectedRoleRefs: Record<
    'baseline' | 'candidate',
    EvaluationRoleVariantRefsV1
  >,
): void {
  assertRoleContractDerivedFromTreatment(
    baseline.roleContract,
    expectedRoleRefs.baseline,
    runSpec.pinned.injections,
  );
  assertRoleContractDerivedFromTreatment(
    candidate.roleContract,
    expectedRoleRefs.candidate,
    runSpec.pinned.injections,
  );
  assertMaterializedTreatmentExecution({
    baseline,
    candidate,
    roleVariant,
    expectedRoleRefs,
  });
  if (
    baseline.score.caseId !== evalCase.caseId
    || candidate.score.caseId !== evalCase.caseId
    || baseline.score.role !== 'baseline'
    || candidate.score.role !== 'candidate'
    || candidate.score.candidateId !== materialization.artifactId
    || canonicalJsonString(baseline.score.pinned)
      !== canonicalJsonString(runSpec.pinned)
    || canonicalJsonString(candidate.score.pinned)
      !== canonicalJsonString(runSpec.pinned)
    || baseline.executionFence.taskId !== baselineTask.taskId
    || candidate.executionFence.taskId !== candidateTask.taskId
    || baseline.roleProof.materialization.artifactId
      !== `baseline:${materialization.artifactId}`
    || candidate.roleProof.materialization.artifactId
      !== materialization.artifactId
    || canonicalJsonString(baseline.treatmentBinding)
      !== canonicalJsonString(runSpec.treatmentBinding)
    || canonicalJsonString(candidate.treatmentBinding)
      !== canonicalJsonString(runSpec.treatmentBinding)
    || baseline.roleProof.materialization.sourceCandidateContentHash
      !== runSpec.treatmentBinding.candidateContentHash
    || candidate.roleProof.materialization.sourceCandidateContentHash
      !== runSpec.treatmentBinding.candidateContentHash
    || baseline.roleProof.materialization.treatmentArtifactContentHash
      !== runSpec.treatmentBinding.treatmentArtifactContentHash
    || candidate.roleProof.materialization.treatmentArtifactContentHash
      !== runSpec.treatmentBinding.treatmentArtifactContentHash
    || baseline.roleProof.materialization.materializedInputHash
      !== runSpec.treatmentBinding.materializedInputHash
    || candidate.roleProof.materialization.materializedInputHash
      !== runSpec.treatmentBinding.materializedInputHash
    || baseline.fullTreatmentContractHash
      !== runSpec.treatmentBinding.fullTreatmentContractHash
    || candidate.fullTreatmentContractHash
      !== runSpec.treatmentBinding.fullTreatmentContractHash
  ) {
    throw new Error('paired_replay_published_binding_mismatch');
  }
}

function assertRoleContractDerivedFromTreatment(
  contract: EvaluationRoleInjectionContractV1,
  refs: EvaluationRoleVariantRefsV1,
  expectedMode: ReplayRunSpecV1['pinned']['injections'],
): void {
  if (contract.mode !== expectedMode) {
    throw new Error('paired_replay_role_contract_mode_mismatch');
  }
  const selectedKeys = new Set(
    Object.entries(contract.selected as unknown as Record<
      string,
      Array<{id: string; contentHash: string}>
    >).flatMap(([category, selected]) =>
      selected.map(ref => refKey({...ref, category}))),
  );
  const expectedObserved = contract.mode === 'on'
    ? refs.materializedRefs
    : contract.mode === 'selective'
      ? refs.materializedRefs.filter(ref => selectedKeys.has(refKey(ref)))
      : [];
  const expectedObservedKeys = new Set(expectedObserved.map(refKey));
  const expectedForbidden = refs.treatmentNamespaceRefs.filter(
    ref => !expectedObservedKeys.has(refKey(ref)),
  );
  if (
    canonicalJsonString(contract.expectedMaterializedRefs)
      !== canonicalJsonString(refs.materializedRefs)
    || canonicalJsonString(contract.reservedTreatmentNamespace)
      !== canonicalJsonString(refs.treatmentNamespaceRefs)
    || canonicalJsonString(
      contract.expectedObservedRefs.map(entry => refKey(entry.ref)),
    ) !== canonicalJsonString(expectedObserved.map(refKey))
    || canonicalJsonString(contract.forbiddenObservedRefs.map(refKey))
      !== canonicalJsonString(expectedForbidden.map(refKey))
  ) {
    throw new Error('paired_replay_role_contract_not_derived_from_treatment');
  }
}

function assertMaterializedTreatmentExecution(input: {
  baseline: EvaluationReplayPublishedRecordV1;
  candidate: EvaluationReplayPublishedRecordV1;
  roleVariant: EvaluationRoleVariantV1;
  expectedRoleRefs: Record<
    'baseline' | 'candidate',
    EvaluationRoleVariantRefsV1
  >;
}): void {
  const baselineMaterialization = input.baseline.roleProof.materialization;
  const candidateMaterialization = input.candidate.roleProof.materialization;
  const candidateTreatmentGeneration = `evaluation:${canonicalContentHash({
    declared: input.roleVariant.treatmentGeneration,
    materializedInputHash: input.roleVariant.materializedInputHash,
    effectiveSkillRegistryFingerprint:
      candidateMaterialization.effectiveSkillRegistryFingerprint,
    effectiveStrategyRegistryFingerprint:
      candidateMaterialization.effectiveStrategyRegistryFingerprint,
  })}`;
  const mutatesSkillRegistry = input.roleVariant.skillOverlays.length > 0;
  const mutatesStrategyRegistry =
    input.roleVariant.strategyContributions.length > 0
    || input.roleVariant.phaseHintDeltas.length > 0;
  if (
    baselineMaterialization.treatmentGeneration
      !== `evaluation:baseline:${input.roleVariant.treatmentGeneration}`
    || candidateMaterialization.treatmentGeneration
      !== candidateTreatmentGeneration
    || baselineMaterialization.effectiveSkillRegistryFingerprint
      !== input.roleVariant.baseSkillRegistryFingerprint
    || baselineMaterialization.effectiveStrategyRegistryFingerprint
      !== input.roleVariant.baseStrategyRegistryFingerprint
    || canonicalJsonString(baselineMaterialization.materializedRefs)
      !== canonicalJsonString(input.expectedRoleRefs.baseline.materializedRefs)
    || canonicalJsonString(candidateMaterialization.materializedRefs)
      !== canonicalJsonString(input.expectedRoleRefs.candidate.materializedRefs)
    || (
      mutatesSkillRegistry
        ? candidateMaterialization.effectiveSkillRegistryFingerprint
          === input.roleVariant.baseSkillRegistryFingerprint
        : candidateMaterialization.effectiveSkillRegistryFingerprint
          !== input.roleVariant.baseSkillRegistryFingerprint
    )
    || (
      mutatesStrategyRegistry
        ? candidateMaterialization.effectiveStrategyRegistryFingerprint
          === input.roleVariant.baseStrategyRegistryFingerprint
        : candidateMaterialization.effectiveStrategyRegistryFingerprint
          !== input.roleVariant.baseStrategyRegistryFingerprint
    )
  ) {
    throw new Error('paired_replay_treatment_execution_mismatch');
  }
}

function refKey(
  ref: {category: string; id: string; contentHash: string},
): string {
  return `${ref.category}\0${ref.id}\0${ref.contentHash}`;
}

function uniqueTask(
  tasks: readonly ReplayTaskRecordV1[],
  caseId: string,
  role: 'baseline' | 'candidate',
): ReplayTaskRecordV1 {
  const matches = tasks.filter(task =>
    task.caseId === caseId && task.role === role);
  if (matches.length !== 1) throw new Error('paired_replay_task_set_invalid');
  return matches[0];
}

function summarizeSplit(
  split: 'validation' | 'holdout',
  pairs: readonly Pair[],
): ProposalPairedReplaySplitSummaryV1 {
  return summarizeScorePairs(
    split,
    pairs.map(pair => ({
      baseline: pair.baseline.score,
      candidate: pair.candidate.score,
    })),
  );
}

function summarizeScorePairs(
  split: 'validation' | 'holdout',
  pairs: ReadonlyArray<{baseline: EvalScoreV1; candidate: EvalScoreV1}>,
): ProposalPairedReplaySplitSummaryV1 {
  if (pairs.length === 0) {
    throw new Error(`paired_replay_${split}_missing`);
  }
  const availabilityMissing = pairs.some(pair =>
    pair.baseline.availability !== 'available'
    || pair.candidate.availability !== 'available');
  const baselineL0Missing = pairs.some(pair => !l0Passed(pair.baseline));
  const l0Regression = pairs.some(pair =>
    l0Passed(pair.baseline) && !l0Passed(pair.candidate));
  const baselineClaimVerifiedRatioMean = mean(
    pairs.map(pair => pair.baseline.l1.claimVerifiedRatio),
  );
  const candidateClaimVerifiedRatioMean = mean(
    pairs.map(pair => pair.candidate.l1.claimVerifiedRatio),
  );
  const baselineUnsupportedClaims = sum(
    pairs.map(pair => pair.baseline.l1.unsupportedClaims),
  );
  const candidateUnsupportedClaims = sum(
    pairs.map(pair => pair.candidate.l1.unsupportedClaims),
  );
  const baselineEvidenceAnchors = sum(
    pairs.map(pair => pair.baseline.l1.evidenceAnchors),
  );
  const candidateEvidenceAnchors = sum(
    pairs.map(pair => pair.candidate.l1.evidenceAnchors),
  );
  const l1Regression =
    candidateClaimVerifiedRatioMean < baselineClaimVerifiedRatioMean - EPSILON
    || candidateUnsupportedClaims > baselineUnsupportedClaims
    || candidateEvidenceAnchors < baselineEvidenceAnchors;
  const verdict = availabilityMissing || baselineL0Missing
    ? 'inconclusive'
    : l0Regression || l1Regression
      ? 'failed'
      : 'passed';
  return {
    split,
    caseCount: pairs.length,
    baselineClaimVerifiedRatioMean,
    candidateClaimVerifiedRatioMean,
    baselineUnsupportedClaims,
    candidateUnsupportedClaims,
    baselineEvidenceAnchors,
    candidateEvidenceAnchors,
    verdict,
  };
}

function l0Passed(score: EvalScoreV1): boolean {
  return Object.values(score.l0).every(Boolean)
    && (score.golden?.passed ?? true);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sameScope(
  left: RunManifestScope,
  right: RunManifestScope,
): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

export const proposalPairedReplayGateTesting = {
  summarizeScorePairs,
};
