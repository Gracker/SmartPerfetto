// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {
  EvalPinnedEnvironmentV1,
  RunInjectionAttribution,
  RunInjectionCategory,
  RunManifestScope,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {
  assertEvaluationExposureMatchesContract,
  type EvaluationExposureReceiptV1,
  type EvaluationInjectionRefV1,
  type EvaluationRole,
  type EvaluationRoleInjectionContractV1,
} from './evaluationInjectionContext';
import {
  parseEvaluationEnvironmentProof,
  type EvaluationEnvironmentProofV1,
} from './evaluationEnvironmentProof';

export interface EvaluationMaterializationProofV1 {
  schemaVersion: 1;
  artifactId: string;
  sourceCandidateContentHash: string;
  treatmentArtifactContentHash: string;
  materializedInputHash: string;
  baseRegistryContentHash: string;
  persistentOverlayGeneration: string;
  treatmentGeneration: string;
  materializedRefs: EvaluationInjectionRefV1[];
  materializedHash: string;
  effectiveSkillRegistryFingerprint: string;
  effectiveStrategyRegistryFingerprint: string;
  contentHash: string;
}

export interface EvaluationRoleProofV2 {
  schemaVersion: 2;
  proofId: string;
  role: EvaluationRole;
  scope: RunManifestScope;
  runId: string;
  runManifestId: string;
  pinned: EvalPinnedEnvironmentV1;
  providerSnapshotHash: string;
  providerMutationGenerationFingerprint: string;
  commonBaseRegistryContentHash: string;
  roleContractHash: string;
  baseEnvironmentProofContentHash: string;
  materialization: EvaluationMaterializationProofV1;
  exposureReceipt: EvaluationExposureReceiptV1;
  ambientObserved: EvaluationInjectionRefV1[];
  ambientObservedHash: string;
  environmentFingerprint: string;
  capturedAt: string;
  contentHash: string;
}

export interface EvaluationPairAttestationV1 {
  schemaVersion: 1;
  attestationId: string;
  scope: RunManifestScope;
  fullTreatmentContractHash: string;
  baselineProofContentHash: string;
  candidateProofContentHash: string;
  commonPinnedFingerprint: string;
  commonProviderSnapshotHash: string;
  commonBaseRegistryContentHash: string;
  ambientObservedHash: string;
  capturedAt: string;
  contentHash: string;
}

function refKey(ref: EvaluationInjectionRefV1): string {
  return `${ref.category}\0${ref.id}\0${ref.contentHash}`;
}

function normalizeRefs(
  values: readonly EvaluationInjectionRefV1[],
): EvaluationInjectionRefV1[] {
  const refs = values.map(ref => ({
    category: ref.category,
    id: ref.id,
    contentHash: ref.contentHash,
  })).sort((left, right) => refKey(left).localeCompare(refKey(right)));
  if (
    refs.some(ref =>
      !/^[0-9a-f]{64}$/.test(ref.contentHash)
      || !ref.id)
    || new Set(refs.map(refKey)).size !== refs.length
  ) {
    throw new Error('evaluation_pair_ref_invalid');
  }
  return refs;
}

function materializationHash(
  value: Omit<EvaluationMaterializationProofV1, 'contentHash'>,
): string {
  return canonicalContentHash(value);
}

export function createEvaluationMaterializationProof(input: Omit<
  EvaluationMaterializationProofV1,
  'schemaVersion' | 'materializedHash' | 'contentHash'
>): EvaluationMaterializationProofV1 {
  for (const hash of [
    input.sourceCandidateContentHash,
    input.treatmentArtifactContentHash,
    input.materializedInputHash,
  ]) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('evaluation_materialization_binding_invalid');
    }
  }
  const materializedRefs = normalizeRefs(input.materializedRefs);
  const withoutContentHash = {
    schemaVersion: 1 as const,
    ...input,
    materializedRefs,
    materializedHash: canonicalContentHash(materializedRefs),
  };
  return immutableCanonicalSnapshot({
    ...withoutContentHash,
    contentHash: materializationHash(withoutContentHash),
  });
}

export function parseEvaluationMaterializationProof(
  value: EvaluationMaterializationProofV1,
): EvaluationMaterializationProofV1 {
  if (
    !value
    || value.schemaVersion !== 1
    || value.materializedHash
      !== canonicalContentHash(normalizeRefs(value.materializedRefs))
  ) {
    throw new Error('evaluation_materialization_proof_invalid');
  }
  const normalized = immutableCanonicalSnapshot({
    ...value,
    materializedRefs: normalizeRefs(value.materializedRefs),
  });
  const {contentHash, ...withoutHash} = normalized;
  if (contentHash !== materializationHash(withoutHash)) {
    throw new Error('evaluation_materialization_proof_hash_mismatch');
  }
  return normalized;
}

function allManifestRefs(
  injections: RunInjectionAttribution,
): EvaluationInjectionRefV1[] {
  return (Object.keys(injections) as RunInjectionCategory[]).flatMap(
    category => injections[category].map(ref => ({...ref, category})),
  );
}

function roleProofHash(
  value: Omit<EvaluationRoleProofV2, 'contentHash'>,
): string {
  return canonicalContentHash(value);
}

export function createEvaluationRoleProofV2(input: {
  role: EvaluationRole;
  baseProof: EvaluationEnvironmentProofV1;
  contract: EvaluationRoleInjectionContractV1;
  materialization: EvaluationMaterializationProofV1;
  exposureReceipt: EvaluationExposureReceiptV1;
  commonBaseRegistryContentHash: string;
  proofId?: string;
  capturedAt?: string;
}): EvaluationRoleProofV2 {
  const baseProof = parseEvaluationEnvironmentProof(input.baseProof);
  if (
    input.contract.role !== input.role
    || input.exposureReceipt.role !== input.role
  ) {
    throw new Error('evaluation_role_proof_role_mismatch');
  }
  if (
    input.materialization.baseRegistryContentHash
      !== input.commonBaseRegistryContentHash
    || input.materialization.persistentOverlayGeneration
      !== baseProof.pinned.overlayGeneration
  ) {
    throw new Error('evaluation_role_proof_base_registry_mismatch');
  }
  const expectedMaterialized = normalizeRefs(
    input.contract.expectedMaterializedRefs,
  );
  if (
    canonicalJsonString(expectedMaterialized)
      !== canonicalJsonString(input.materialization.materializedRefs)
  ) {
    throw new Error('evaluation_materialization_contract_mismatch');
  }
  assertEvaluationExposureMatchesContract({
    contract: input.contract,
    receipt: input.exposureReceipt,
  });
  const reservedLogical = new Set(
    input.contract.reservedTreatmentNamespace.map(
      ref => `${ref.category}\0${ref.id}`,
    ),
  );
  const ambientObserved = normalizeRefs(
    allManifestRefs(baseProof.injections).filter(ref =>
      !reservedLogical.has(`${ref.category}\0${ref.id}`)),
  );
  const ambientObservedHash = canonicalContentHash(ambientObserved);
  const environmentFingerprint = canonicalContentHash({
    pinned: baseProof.pinned,
    providerSnapshotHash: baseProof.providerSnapshotHash,
    providerMutationGenerationFingerprint:
      baseProof.providerMutationGenerationFingerprint,
    commonBaseRegistryContentHash: input.commonBaseRegistryContentHash,
    roleContractHash: input.contract.contractHash,
    treatmentGeneration: input.materialization.treatmentGeneration,
  });
  const withoutHash: Omit<EvaluationRoleProofV2, 'contentHash'> = {
    schemaVersion: 2,
    proofId: input.proofId ?? randomUUID(),
    role: input.role,
    scope: baseProof.scope,
    runId: baseProof.runId,
    runManifestId: baseProof.runManifestId,
    pinned: baseProof.pinned,
    providerSnapshotHash: baseProof.providerSnapshotHash,
    providerMutationGenerationFingerprint:
      baseProof.providerMutationGenerationFingerprint,
    commonBaseRegistryContentHash: input.commonBaseRegistryContentHash,
    roleContractHash: input.contract.contractHash,
    baseEnvironmentProofContentHash: baseProof.contentHash,
    materialization: input.materialization,
    exposureReceipt: input.exposureReceipt,
    ambientObserved,
    ambientObservedHash,
    environmentFingerprint,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: roleProofHash(withoutHash),
  });
}

export function parseEvaluationRoleProofV2(
  value: EvaluationRoleProofV2,
): EvaluationRoleProofV2 {
  if (
    !value
    || value.schemaVersion !== 2
    || (value.role !== 'baseline' && value.role !== 'candidate')
    || !Number.isFinite(Date.parse(value.capturedAt))
  ) {
    throw new Error('evaluation_role_proof_invalid');
  }
  const normalized = immutableCanonicalSnapshot({
    ...value,
    materialization: parseEvaluationMaterializationProof(
      value.materialization,
    ),
    ambientObserved: normalizeRefs(value.ambientObserved),
  });
  if (
    normalized.ambientObservedHash
      !== canonicalContentHash(normalized.ambientObserved)
  ) {
    throw new Error('evaluation_role_proof_ambient_hash_mismatch');
  }
  const {contentHash, ...withoutHash} = normalized;
  if (contentHash !== roleProofHash(withoutHash)) {
    throw new Error('evaluation_role_proof_hash_mismatch');
  }
  return normalized;
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

export function attestEvaluationPair(input: {
  baseline: EvaluationRoleProofV2;
  candidate: EvaluationRoleProofV2;
  baselineContract: EvaluationRoleInjectionContractV1;
  candidateContract: EvaluationRoleInjectionContractV1;
  fullTreatmentContractHash: string;
  attestationId?: string;
  capturedAt?: string;
}): EvaluationPairAttestationV1 {
  const {baseline, candidate} = input;
  if (!/^[0-9a-f]{64}$/.test(input.fullTreatmentContractHash)) {
    throw new Error('evaluation_pair_treatment_contract_hash_invalid');
  }
  const baselineProof = parseEvaluationRoleProofV2(baseline);
  const candidateProof = parseEvaluationRoleProofV2(candidate);
  if (
    baselineProof.role !== 'baseline'
    || candidateProof.role !== 'candidate'
    || !sameScope(baselineProof.scope, candidateProof.scope)
  ) {
    throw new Error('evaluation_pair_role_mismatch');
  }
  if (
    canonicalJsonString(baselineProof.pinned)
      !== canonicalJsonString(candidateProof.pinned)
    || baselineProof.providerSnapshotHash
      !== candidateProof.providerSnapshotHash
    || baselineProof.providerMutationGenerationFingerprint
      !== candidateProof.providerMutationGenerationFingerprint
    || baselineProof.commonBaseRegistryContentHash
      !== candidateProof.commonBaseRegistryContentHash
  ) {
    throw new Error('evaluation_pair_common_environment_mismatch');
  }
  if (
    baselineProof.roleContractHash !== input.baselineContract.contractHash
    || candidateProof.roleContractHash !== input.candidateContract.contractHash
    || baselineProof.materialization.artifactId
      !== `baseline:${candidateProof.materialization.artifactId}`
  ) {
    throw new Error('evaluation_pair_contract_hash_mismatch');
  }
  assertEvaluationExposureMatchesContract({
    contract: input.baselineContract,
    receipt: baselineProof.exposureReceipt,
  });
  assertEvaluationExposureMatchesContract({
    contract: input.candidateContract,
    receipt: candidateProof.exposureReceipt,
  });
  if (
    baselineProof.ambientObservedHash
    !== candidateProof.ambientObservedHash
  ) {
    throw new Error('evaluation_pair_ambient_injections_mismatch');
  }
  const commonPinnedFingerprint = canonicalContentHash(baselineProof.pinned);
  const withoutHash: Omit<EvaluationPairAttestationV1, 'contentHash'> = {
    schemaVersion: 1,
    attestationId: input.attestationId ?? randomUUID(),
    scope: baselineProof.scope,
    fullTreatmentContractHash: input.fullTreatmentContractHash,
    baselineProofContentHash: baselineProof.contentHash,
    candidateProofContentHash: candidateProof.contentHash,
    commonPinnedFingerprint,
    commonProviderSnapshotHash: baselineProof.providerSnapshotHash,
    commonBaseRegistryContentHash:
      baselineProof.commonBaseRegistryContentHash,
    ambientObservedHash: baselineProof.ambientObservedHash,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}
