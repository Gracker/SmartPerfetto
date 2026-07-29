// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  parseStrategyContribution,
  type PhaseHint,
} from '../../agentv3/strategyLoader';
import {isProductionAgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import type {ApplicationBuildIdentity} from '../applicationUpdate/types';
import type {
  AppliedProposalRevisionV1,
  EvolutionBaseRelation,
  EvolutionOverlayActivationState,
  EvolutionOverlayArtifactV1,
  EvolutionOverlayPayloadV1,
  EvolutionOverlayProvenanceV1,
  EvolutionOverlayRegistryEntryV1,
  EvolutionRollbackReceiptV1,
  EvolutionOverlayValidationState,
  EvolutionDegradationAlertV1,
  EvolutionSkillNoteV1,
  EvolutionSkillNoteDeltaV1,
  EvolutionStrategyDeltaV1,
  EvolutionValidationBoundInputsV1,
  ContributionBundleArtifactV1,
  ProposalChannelArtifactRevisionV1,
  RepositoryPatchArtifactV1,
  UpgradeReconciliationReportV1,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {parseSkillOverlayDeltaV1} from './effectiveSkillComposer';
import type {EvaluationTreatmentEntryV1} from './evaluationTreatment';

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,255}$/;
export const EVOLUTION_OVERLAY_VALIDATOR_VERSION =
  'evolution-overlay-validator-v1';
export const EVOLUTION_OVERLAY_LOADER_SCHEMA_VERSION =
  'effective-runtime-registry-v1';

export function evolutionValidationInputFingerprint(
  value: EvolutionValidationBoundInputsV1,
): string {
  return canonicalContentHash(parseValidationBoundInputs(value));
}

export function deriveEvolutionOverlayActivationState(input: {
  userDisabled: boolean;
  baseRelation: EvolutionBaseRelation;
  validationState: EvolutionOverlayValidationState;
}): {
  activationState: EvolutionOverlayActivationState;
  effectiveEnabled: boolean;
} {
  let activationState: EvolutionOverlayActivationState;
  if (input.userDisabled) {
    activationState = 'disabled';
  } else if (
    input.baseRelation === 'missing'
    || input.baseRelation === 'incompatible'
    || input.validationState === 'failed'
    || input.validationState === 'error'
  ) {
    activationState = 'quarantined';
  } else if (input.validationState === 'pending') {
    activationState = 'inactive';
  } else if (input.baseRelation === 'absorbed') {
    activationState = 'obsolete';
  } else {
    activationState = 'active';
  }
  return {
    activationState,
    effectiveEnabled: activationState === 'active',
  };
}

export function createEvolutionOverlayPayloadFromTreatmentEntry(
  entry: EvaluationTreatmentEntryV1,
): EvolutionOverlayPayloadV1 {
  switch (entry.kind) {
    case 'skill_overlay_delta':
      return parseEvolutionOverlayPayloadV1({
        schemaVersion: 1,
        payloadKind: 'skill_delta',
        skillOverlay: entry.overlay,
      });
    case 'strategy_contribution':
      return parseEvolutionOverlayPayloadV1({
        schemaVersion: 1,
        payloadKind: 'strategy_delta',
        strategyDelta: {
          kind: 'strategy_contribution',
          contribution: entry.contribution,
        },
      });
    case 'phase_hint_delta':
      return parseEvolutionOverlayPayloadV1({
        schemaVersion: 1,
        payloadKind: 'strategy_delta',
        strategyDelta: entry,
      });
    case 'skill_note':
      return parseEvolutionOverlayPayloadV1({
        schemaVersion: 1,
        payloadKind: 'skill_note',
        skillNoteDelta: {
          kind: 'skill_note_delta',
          op: entry.op,
          skillId: entry.skillId,
          noteId: entry.noteId,
          ...(entry.beforeContentHash
            ? {beforeContentHash: entry.beforeContentHash}
            : {}),
          ...(entry.after ? {after: entry.after} : {}),
        },
      });
    case 'retire_injection':
      return entry.category === 'phaseHints'
        ? parseEvolutionOverlayPayloadV1({
            schemaVersion: 1,
            payloadKind: 'strategy_delta',
            strategyDelta: {
              kind: 'retire_phase_hint',
              hintId: entry.id,
              contentHash: entry.contentHash,
              ...(entry.scene ? {scene: entry.scene} : {}),
            },
          })
        : parseEvolutionOverlayPayloadV1({
            schemaVersion: 1,
            payloadKind: 'skill_note',
            skillNoteDelta: {
              kind: 'retire_skill_note',
              noteId: entry.id,
              contentHash: entry.contentHash,
            },
          });
  }
}

export function parseEvolutionOverlayPayloadV1(
  value: unknown,
): EvolutionOverlayPayloadV1 {
  const payload = record(value, 'evolution_overlay_payload_invalid');
  exactKeys(payload, ['schemaVersion', 'payloadKind', payloadField(payload)]);
  if (payload.schemaVersion !== 1) {
    fail('evolution_overlay_payload_schema_unsupported');
  }
  if (payload.payloadKind === 'skill_delta') {
    const parsed = parseSkillOverlayDeltaV1(payload.skillOverlay);
    if (!parsed.ok) fail('evolution_overlay_skill_delta_invalid');
    return immutableCanonicalSnapshot({
      schemaVersion: 1,
      payloadKind: 'skill_delta',
      skillOverlay: parsed.value,
    });
  }
  if (payload.payloadKind === 'strategy_delta') {
    return immutableCanonicalSnapshot({
      schemaVersion: 1,
      payloadKind: 'strategy_delta',
      strategyDelta: parseEvolutionStrategyDelta(payload.strategyDelta),
    });
  }
  if (payload.payloadKind === 'skill_note') {
    return immutableCanonicalSnapshot({
      schemaVersion: 1,
      payloadKind: 'skill_note',
      skillNoteDelta: parseEvolutionSkillNoteDelta(payload.skillNoteDelta),
    });
  }
  fail('evolution_overlay_payload_kind_invalid');
}

export function createEvolutionOverlayArtifactV1(input: {
  artifactId: string;
  payload: EvolutionOverlayPayloadV1;
  provenance: EvolutionOverlayProvenanceV1;
}): EvolutionOverlayArtifactV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    artifactId: input.artifactId,
    payload: parseEvolutionOverlayPayloadV1(input.payload),
    provenance: parseEvolutionOverlayProvenanceV1(input.provenance),
  };
  return parseEvolutionOverlayArtifactV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseEvolutionOverlayArtifactV1(
  value: unknown,
): EvolutionOverlayArtifactV1 {
  const artifact = record(value, 'evolution_overlay_artifact_invalid');
  exactKeys(artifact, [
    'schemaVersion',
    'artifactId',
    'payload',
    'provenance',
    'contentHash',
  ]);
  if (
    artifact.schemaVersion !== 1
    || !nonEmpty(artifact.artifactId)
    || !ID.test(artifact.artifactId)
    || !hash(artifact.contentHash)
  ) {
    fail('evolution_overlay_artifact_invalid');
  }
  const payload = parseEvolutionOverlayPayloadV1(artifact.payload);
  const provenance = parseEvolutionOverlayProvenanceV1(artifact.provenance);
  if (
    provenance.overlayContentHash !== canonicalContentHash(payload)
    || provenance.overlayKind !== payloadKindToOverlayKind(payload.payloadKind)
    || (
      payload.payloadKind === 'skill_delta'
      && provenance.overlayId !== payload.skillOverlay.overlayId
    )
  ) {
    fail('evolution_overlay_artifact_binding_invalid');
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    artifactId: artifact.artifactId as string,
    payload,
    provenance,
  };
  if (canonicalContentHash(withoutHash) !== artifact.contentHash) {
    fail('evolution_overlay_artifact_hash_mismatch');
  }
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: artifact.contentHash as string,
  });
}

export function parseEvolutionOverlayProvenanceV1(
  value: unknown,
): EvolutionOverlayProvenanceV1 {
  const provenance = record(value, 'evolution_overlay_provenance_invalid');
  exactKeys(provenance, [
    'schemaVersion',
    'overlayId',
    'overlayKind',
    'overlayContentHash',
    'deltaSchemaVersion',
    'proposalId',
    'proposalRevision',
    'gateVerdict',
    'evalFingerprints',
    'derivedFrom',
    'dependencyFingerprints',
    'producedUnder',
    'compatibility',
    'supersedesOverlayId',
    'validation',
    'createdAt',
    'appliedAt',
    'reconciledAt',
    'actor',
    'scope',
  ], [
    'evalFingerprints',
    'supersedesOverlayId',
    'validation',
    'appliedAt',
    'reconciledAt',
  ]);
  if (
    provenance.schemaVersion !== 1
    || !nonEmpty(provenance.overlayId)
    || !['skill_delta', 'strategy_delta', 'skill_note'].includes(
      String(provenance.overlayKind),
    )
    || !hash(provenance.overlayContentHash)
    || !positiveInteger(provenance.deltaSchemaVersion)
    || !nonEmpty(provenance.proposalId)
    || !positiveInteger(provenance.proposalRevision)
    || !['passed', 'failed', 'inconclusive'].includes(
      String(provenance.gateVerdict),
    )
    || !nonNegativeInteger(provenance.createdAt)
  ) {
    fail('evolution_overlay_provenance_invalid');
  }
  const derivedFrom = parseDerivedFrom(provenance.derivedFrom);
  const dependencyFingerprints = parseDependencyFingerprints(
    provenance.dependencyFingerprints,
  );
  const producedUnder = parseProducedUnder(provenance.producedUnder);
  const compatibility = parseCompatibility(provenance.compatibility);
  const scope = parseScope(provenance.scope);
  const actorValue = record(
    provenance.actor,
    'evolution_overlay_actor_invalid',
  );
  exactKeys(actorValue, ['userId'], ['userId']);
  if (actorValue.userId !== undefined && !nonEmpty(actorValue.userId)) {
    fail('evolution_overlay_actor_invalid');
  }
  const actor = actorValue.userId === undefined
    ? {}
    : {userId: actorValue.userId as string};
  const optionalTimes: Record<string, number> = {};
  for (const key of ['appliedAt', 'reconciledAt'] as const) {
    const found = provenance[key];
    if (found !== undefined) {
      if (!nonNegativeInteger(found)) {
        fail('evolution_overlay_provenance_time_invalid');
      }
      optionalTimes[key] = found;
    }
  }
  const validation = provenance.validation === undefined
    ? undefined
    : parseValidation(provenance.validation);
  const evalFingerprints = provenance.evalFingerprints === undefined
    ? undefined
    : parseEvalFingerprints(provenance.evalFingerprints);
  if (
    provenance.supersedesOverlayId !== undefined
    && !nonEmpty(provenance.supersedesOverlayId)
  ) {
    fail('evolution_overlay_supersedes_invalid');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    overlayId: provenance.overlayId as string,
    overlayKind:
      provenance.overlayKind as EvolutionOverlayProvenanceV1['overlayKind'],
    overlayContentHash: provenance.overlayContentHash as string,
    deltaSchemaVersion: provenance.deltaSchemaVersion as number,
    proposalId: provenance.proposalId as string,
    proposalRevision: provenance.proposalRevision as number,
    gateVerdict:
      provenance.gateVerdict as EvolutionOverlayProvenanceV1['gateVerdict'],
    ...(evalFingerprints ? {evalFingerprints} : {}),
    derivedFrom,
    dependencyFingerprints,
    producedUnder,
    compatibility,
    ...(provenance.supersedesOverlayId === undefined
      ? {}
      : {supersedesOverlayId: provenance.supersedesOverlayId as string}),
    ...(validation ? {validation} : {}),
    createdAt: provenance.createdAt as number,
    ...optionalTimes,
    actor,
    scope,
  });
}

export function createUpgradeReconciliationReportV1(
  input: Omit<UpgradeReconciliationReportV1, 'schemaVersion' | 'contentHash'>,
): UpgradeReconciliationReportV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    ...input,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseUpgradeReconciliationReportV1(
  value: unknown,
): UpgradeReconciliationReportV1 {
  const report = record(value, 'upgrade_reconciliation_report_invalid');
  exactKeys(report, [
    'schemaVersion',
    'reportId',
    'scope',
    'previousBuildIdentity',
    'currentBuildIdentity',
    'candidateGeneration',
    'publishedGeneration',
    'byBaseRelation',
    'byValidationState',
    'byActivationState',
    'issues',
    'createdAt',
    'contentHash',
  ]);
  if (
    report.schemaVersion !== 1
    || !nonEmpty(report.reportId)
    || !nonEmpty(report.candidateGeneration)
    || !nonEmpty(report.publishedGeneration)
    || !nonNegativeInteger(report.createdAt)
    || !hash(report.contentHash)
  ) {
    fail('upgrade_reconciliation_report_invalid');
  }
  const scope = parseScope(report.scope);
  const previousBuildIdentity = report.previousBuildIdentity === null
    ? null
    : parseReportBuildIdentity(report.previousBuildIdentity);
  const currentBuildIdentity =
    parseReportBuildIdentity(report.currentBuildIdentity);
  const byBaseRelation = parseReportGrouping(
    report.byBaseRelation,
    ['unchanged', 'changed', 'absorbed', 'missing', 'incompatible'],
  ) as UpgradeReconciliationReportV1['byBaseRelation'];
  const byValidationState = parseReportGrouping(
    report.byValidationState,
    ['pending', 'passed', 'failed', 'error'],
  ) as UpgradeReconciliationReportV1['byValidationState'];
  const byActivationState = parseReportGrouping(
    report.byActivationState,
    ['active', 'inactive', 'quarantined', 'obsolete', 'disabled'],
  ) as UpgradeReconciliationReportV1['byActivationState'];
  if (!Array.isArray(report.issues)) {
    fail('upgrade_reconciliation_report_invalid');
  }
  const issues = report.issues.map(parseReconciliationIssue);
  const withoutHash = {...report};
  delete withoutHash.contentHash;
  if (canonicalContentHash(withoutHash) !== report.contentHash) {
    fail('upgrade_reconciliation_report_hash_mismatch');
  }
  return immutableCanonicalSnapshot({
    ...report,
    scope,
    previousBuildIdentity,
    currentBuildIdentity,
    byBaseRelation,
    byValidationState,
    byActivationState,
    issues,
  }) as unknown as UpgradeReconciliationReportV1;
}

export function createEvolutionOverlayRegistryEntryV1(
  input: Omit<
    EvolutionOverlayRegistryEntryV1,
    | 'schemaVersion'
    | 'activationState'
    | 'effectiveEnabled'
  >,
): EvolutionOverlayRegistryEntryV1 {
  const activation = deriveEvolutionOverlayActivationState(input);
  return parseEvolutionOverlayRegistryEntryV1({
    schemaVersion: 1,
    ...input,
    ...activation,
  });
}

export function parseEvolutionOverlayRegistryEntryV1(
  value: unknown,
): EvolutionOverlayRegistryEntryV1 {
  const entry = record(value, 'evolution_overlay_registry_entry_invalid');
  exactKeys(entry, [
    'schemaVersion',
    'entryId',
    'overlayId',
    'overlayKind',
    'scope',
    'proposalId',
    'proposalRevision',
    'artifactContentHash',
    'actionId',
    'actionState',
    'baseRelation',
    'validationState',
    'activationState',
    'effectiveEnabled',
    'userDisabled',
    'validationReason',
    'createdAt',
    'reconciledAt',
    'provenance',
  ], ['validationReason', 'reconciledAt']);
  if (
    entry.schemaVersion !== 1
    || !nonEmpty(entry.entryId)
    || !nonEmpty(entry.overlayId)
    || !['skill_delta', 'strategy_delta', 'skill_note'].includes(
      String(entry.overlayKind),
    )
    || !nonEmpty(entry.proposalId)
    || ![3, 4, 5].includes(Number(entry.proposalRevision))
    || !hash(entry.artifactContentHash)
    || !nonEmpty(entry.actionId)
    || !['staged', 'committed', 'aborted'].includes(
      String(entry.actionState),
    )
    || !['unchanged', 'changed', 'absorbed', 'missing', 'incompatible']
      .includes(String(entry.baseRelation))
    || !['pending', 'passed', 'failed', 'error']
      .includes(String(entry.validationState))
    || !['active', 'inactive', 'quarantined', 'obsolete', 'disabled']
      .includes(String(entry.activationState))
    || typeof entry.effectiveEnabled !== 'boolean'
    || typeof entry.userDisabled !== 'boolean'
    || !nonNegativeInteger(entry.createdAt)
    || (
      entry.reconciledAt !== undefined
      && !nonNegativeInteger(entry.reconciledAt)
    )
    || (
      entry.validationReason !== undefined
      && !nonEmpty(entry.validationReason)
    )
  ) {
    fail('evolution_overlay_registry_entry_invalid');
  }
  const scope = parseScope(entry.scope);
  const provenance = parseEvolutionOverlayProvenanceV1(entry.provenance);
  const derived = deriveEvolutionOverlayActivationState({
    userDisabled: entry.userDisabled,
    baseRelation: entry.baseRelation as EvolutionBaseRelation,
    validationState:
      entry.validationState as EvolutionOverlayValidationState,
  });
  if (
    derived.activationState !== entry.activationState
    || derived.effectiveEnabled !== entry.effectiveEnabled
    || provenance.overlayId !== entry.overlayId
    || provenance.overlayKind !== entry.overlayKind
    || provenance.proposalId !== entry.proposalId
  ) {
    fail('evolution_overlay_registry_entry_binding_invalid');
  }
  return immutableCanonicalSnapshot({
    ...entry,
    scope,
    provenance,
  }) as unknown as EvolutionOverlayRegistryEntryV1;
}

export function createEvolutionRollbackReceiptV1(
  input: Omit<EvolutionRollbackReceiptV1, 'schemaVersion' | 'contentHash'>,
): EvolutionRollbackReceiptV1 {
  const withoutHash = {schemaVersion: 1 as const, ...input};
  return parseEvolutionRollbackReceiptV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function createAppliedProposalRevisionV1(
  input: Omit<AppliedProposalRevisionV1, 'schemaVersion' | 'contentHash'>,
): AppliedProposalRevisionV1 {
  const withoutHash = {schemaVersion: 1 as const, ...input};
  return parseAppliedProposalRevisionV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseAppliedProposalRevisionV1(
  value: unknown,
): AppliedProposalRevisionV1 {
  const revision = record(value, 'applied_proposal_revision_invalid');
  exactKeys(revision, [
    'schemaVersion',
    'ordinal',
    'proposalId',
    'proposalRevision',
    'actionId',
    'kind',
    'scope',
    'overlayIds',
    'generation',
    'receiptContentHashes',
    'actor',
    'createdAt',
    'contentHash',
  ]);
  const actor = record(revision.actor, 'applied_proposal_revision_invalid');
  exactKeys(actor, ['userId'], ['userId']);
  if (
    revision.schemaVersion !== 1
    || !positiveInteger(revision.ordinal)
    || !nonEmpty(revision.proposalId)
    || !nonEmpty(revision.actionId)
    || !['apply', 'revert'].includes(String(revision.kind))
    || (
      revision.proposalRevision
      !== (revision.kind === 'apply' ? 4 : 5)
    )
    || !Array.isArray(revision.overlayIds)
    || !revision.overlayIds.every(nonEmpty)
    || new Set(revision.overlayIds).size !== revision.overlayIds.length
    || !nonEmpty(revision.generation)
    || !Array.isArray(revision.receiptContentHashes)
    || !revision.receiptContentHashes.every(hash)
    || new Set(revision.receiptContentHashes).size
      !== revision.receiptContentHashes.length
    || (actor.userId !== undefined && !nonEmpty(actor.userId))
    || !nonNegativeInteger(revision.createdAt)
    || !hash(revision.contentHash)
  ) {
    fail('applied_proposal_revision_invalid');
  }
  const scope = parseScope(revision.scope);
  return verifyHashedRecord(
    {...revision, scope, actor},
    'applied_proposal_revision_hash_mismatch',
  ) as unknown as AppliedProposalRevisionV1;
}

export function parseEvolutionRollbackReceiptV1(
  value: unknown,
): EvolutionRollbackReceiptV1 {
  const receipt = record(value, 'evolution_rollback_receipt_invalid');
  exactKeys(receipt, [
    'schemaVersion',
    'actionId',
    'scope',
    'kind',
    'targetId',
    'idempotent',
    'sideEffectContentHash',
    'createdAt',
    'contentHash',
  ]);
  if (
    receipt.schemaVersion !== 1
    || !nonEmpty(receipt.actionId)
    || ![
      'local_overlay_reverted',
      'repository_patch_revoked',
      'case_retracted',
      'skill_note_disabled',
    ].includes(String(receipt.kind))
    || !nonEmpty(receipt.targetId)
    || typeof receipt.idempotent !== 'boolean'
    || !hash(receipt.sideEffectContentHash)
    || !nonNegativeInteger(receipt.createdAt)
    || !hash(receipt.contentHash)
  ) {
    fail('evolution_rollback_receipt_invalid');
  }
  const scope = parseScope(receipt.scope);
  return verifyHashedRecord(
    {...receipt, scope},
    'evolution_rollback_receipt_hash_mismatch',
  ) as unknown as EvolutionRollbackReceiptV1;
}

export function createEvolutionDegradationAlertV1(
  input: Omit<EvolutionDegradationAlertV1, 'schemaVersion' | 'contentHash'>,
): EvolutionDegradationAlertV1 {
  const withoutHash = {schemaVersion: 1 as const, ...input};
  return parseEvolutionDegradationAlertV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseEvolutionDegradationAlertV1(
  value: unknown,
): EvolutionDegradationAlertV1 {
  const alert = record(value, 'evolution_degradation_alert_invalid');
  exactKeys(alert, [
    'schemaVersion',
    'alertId',
    'scope',
    'overlayIds',
    'observedGeneration',
    'reasonCode',
    'evidenceContentHashes',
    'autoRollback',
    'createdAt',
    'contentHash',
  ]);
  if (
    alert.schemaVersion !== 1
    || !nonEmpty(alert.alertId)
    || !Array.isArray(alert.overlayIds)
    || !alert.overlayIds.every(nonEmpty)
    || !nonEmpty(alert.observedGeneration)
    || !nonEmpty(alert.reasonCode)
    || !Array.isArray(alert.evidenceContentHashes)
    || !alert.evidenceContentHashes.every(hash)
    || alert.autoRollback !== false
    || !nonNegativeInteger(alert.createdAt)
    || !hash(alert.contentHash)
  ) {
    fail('evolution_degradation_alert_invalid');
  }
  parseScope(alert.scope);
  return verifyHashedRecord(
    alert,
    'evolution_degradation_alert_hash_mismatch',
  ) as unknown as EvolutionDegradationAlertV1;
}

export function createRepositoryPatchArtifactV1(
  input: Omit<RepositoryPatchArtifactV1, 'schemaVersion' | 'contentHash'>,
): RepositoryPatchArtifactV1 {
  const withoutHash = {schemaVersion: 1 as const, ...input};
  return parseRepositoryPatchArtifactV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseRepositoryPatchArtifactV1(
  value: unknown,
): RepositoryPatchArtifactV1 {
  const artifact = record(value, 'repository_patch_artifact_invalid');
  exactKeys(artifact, [
    'schemaVersion',
    'artifactId',
    'proposalId',
    'gateAttemptId',
    'gateAttemptOrdinal',
    'targetBindingContentHash',
    'patch',
    'patchContentHash',
    'reversePatch',
    'reversePatchContentHash',
    'applyCheck',
    'sourceMaintainer',
    'gitCapability',
    'createdAt',
    'contentHash',
  ]);
  if (
    artifact.schemaVersion !== 1
    || !nonEmpty(artifact.artifactId)
    || !nonEmpty(artifact.proposalId)
    || !nonEmpty(artifact.gateAttemptId)
    || !positiveInteger(artifact.gateAttemptOrdinal)
    || !hash(artifact.targetBindingContentHash)
    || typeof artifact.patch !== 'string'
    || !artifact.patch
    || artifact.patchContentHash !== canonicalContentHash(artifact.patch)
    || typeof artifact.reversePatch !== 'string'
    || !artifact.reversePatch
    || artifact.reversePatchContentHash
      !== canonicalContentHash(artifact.reversePatch)
    || artifact.applyCheck !== 'passed'
    || artifact.sourceMaintainer !== true
    || artifact.gitCapability !== 'available'
    || !nonNegativeInteger(artifact.createdAt)
    || !hash(artifact.contentHash)
  ) {
    fail('repository_patch_artifact_invalid');
  }
  return verifyHashedRecord(
    artifact,
    'repository_patch_artifact_hash_mismatch',
  ) as unknown as RepositoryPatchArtifactV1;
}

export function createContributionBundleArtifactV1(
  input: Omit<ContributionBundleArtifactV1, 'schemaVersion' | 'contentHash'>,
): ContributionBundleArtifactV1 {
  const withoutHash = {schemaVersion: 1 as const, ...input};
  return parseContributionBundleArtifactV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseContributionBundleArtifactV1(
  value: unknown,
): ContributionBundleArtifactV1 {
  const artifact = record(value, 'contribution_bundle_artifact_invalid');
  exactKeys(artifact, [
    'schemaVersion',
    'artifactId',
    'proposalId',
    'gateAttemptId',
    'gateAttemptOrdinal',
    'archivePath',
    'archiveContentHash',
    'entryContentHashes',
    'deidentified',
    'createdAt',
    'contentHash',
  ]);
  if (
    artifact.schemaVersion !== 1
    || !nonEmpty(artifact.artifactId)
    || !nonEmpty(artifact.proposalId)
    || !nonEmpty(artifact.gateAttemptId)
    || !positiveInteger(artifact.gateAttemptOrdinal)
    || !nonEmpty(artifact.archivePath)
    || !hash(artifact.archiveContentHash)
    || !Array.isArray(artifact.entryContentHashes)
    || artifact.entryContentHashes.some(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return true;
      }
      const item = entry as Record<string, unknown>;
      return Object.keys(item).some(key => !['path', 'contentHash'].includes(key))
        || !safeArchivePath(item.path)
        || !hash(item.contentHash);
    })
    || artifact.deidentified !== true
    || !nonNegativeInteger(artifact.createdAt)
    || !hash(artifact.contentHash)
  ) {
    fail('contribution_bundle_artifact_invalid');
  }
  return verifyHashedRecord(
    artifact,
    'contribution_bundle_artifact_hash_mismatch',
  ) as unknown as ContributionBundleArtifactV1;
}

export function createProposalChannelArtifactRevisionV1(
  input: Omit<
    ProposalChannelArtifactRevisionV1,
    'schemaVersion' | 'contentHash'
  >,
): ProposalChannelArtifactRevisionV1 {
  const withoutHash = {schemaVersion: 1 as const, ...input};
  return parseProposalChannelArtifactRevisionV1({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function parseProposalChannelArtifactRevisionV1(
  value: unknown,
): ProposalChannelArtifactRevisionV1 {
  const revision = record(value, 'proposal_channel_revision_invalid');
  exactKeys(revision, [
    'schemaVersion',
    'proposalId',
    'ordinal',
    'channel',
    'gateAttemptId',
    'gateAttemptOrdinal',
    'gateResultContentHash',
    'artifactId',
    'artifactContentHash',
    'state',
    'createdAt',
    'contentHash',
  ]);
  if (
    revision.schemaVersion !== 1
    || !nonEmpty(revision.proposalId)
    || !positiveInteger(revision.ordinal)
    || !['repository_patch', 'contribution_bundle']
      .includes(String(revision.channel))
    || !nonEmpty(revision.gateAttemptId)
    || !positiveInteger(revision.gateAttemptOrdinal)
    || !hash(revision.gateResultContentHash)
    || !nonEmpty(revision.artifactId)
    || !hash(revision.artifactContentHash)
    || !['active', 'revoked'].includes(String(revision.state))
    || !nonNegativeInteger(revision.createdAt)
    || !hash(revision.contentHash)
  ) {
    fail('proposal_channel_revision_invalid');
  }
  return verifyHashedRecord(
    revision,
    'proposal_channel_revision_hash_mismatch',
  ) as unknown as ProposalChannelArtifactRevisionV1;
}

function safeArchivePath(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  return !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[A-Za-z]:/.test(value)
    && !value.includes('\0')
    && value.split(/[\\/]/).every(segment =>
      segment !== '' && segment !== '.' && segment !== '..');
}

function verifyHashedRecord(
  value: Record<string, unknown>,
  mismatchCode: string,
): Readonly<Record<string, unknown>> {
  const withoutHash = {...value};
  delete withoutHash.contentHash;
  if (canonicalContentHash(withoutHash) !== value.contentHash) {
    fail(mismatchCode);
  }
  return immutableCanonicalSnapshot(value);
}

function parseEvolutionStrategyDelta(value: unknown): EvolutionStrategyDeltaV1 {
  const delta = record(value, 'evolution_strategy_delta_invalid');
  if (delta.kind === 'strategy_contribution') {
    exactKeys(delta, ['kind', 'contribution']);
    return {
      kind: 'strategy_contribution',
      contribution: parseStrategyContribution(delta.contribution),
    };
  }
  if (delta.kind === 'phase_hint_delta') {
    exactKeys(delta, [
      'kind',
      'op',
      'scene',
      'hintId',
      'beforeContentHash',
      'after',
    ], ['beforeContentHash', 'after']);
    if (
      !['add', 'modify', 'remove'].includes(String(delta.op))
      || !nonEmpty(delta.scene)
      || !nonEmpty(delta.hintId)
      || (delta.op !== 'add' && !hash(delta.beforeContentHash))
      || (delta.op === 'remove' && delta.after !== undefined)
      || (delta.op !== 'remove' && !validPhaseHint(delta.after, delta.hintId))
    ) {
      fail('evolution_strategy_phase_hint_delta_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'phase_hint_delta',
      op: delta.op as 'add' | 'modify' | 'remove',
      scene: delta.scene as string,
      hintId: delta.hintId as string,
      ...(delta.beforeContentHash
        ? {beforeContentHash: delta.beforeContentHash as string}
        : {}),
      ...(delta.after ? {after: delta.after as PhaseHint} : {}),
    });
  }
  if (delta.kind === 'retire_phase_hint') {
    exactKeys(delta, [
      'kind',
      'hintId',
      'contentHash',
      'scene',
    ], ['scene']);
    if (
      !nonEmpty(delta.hintId)
      || !hash(delta.contentHash)
      || (delta.scene !== undefined && !nonEmpty(delta.scene))
    ) {
      fail('evolution_strategy_retire_hint_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'retire_phase_hint',
      hintId: delta.hintId as string,
      contentHash: delta.contentHash as string,
      ...(delta.scene ? {scene: delta.scene as string} : {}),
    });
  }
  fail('evolution_strategy_delta_kind_invalid');
}

function parseEvolutionSkillNoteDelta(
  value: unknown,
): EvolutionSkillNoteDeltaV1 {
  const delta = record(value, 'evolution_skill_note_delta_invalid');
  if (delta.kind === 'skill_note_delta') {
    exactKeys(delta, [
      'kind',
      'op',
      'skillId',
      'noteId',
      'beforeContentHash',
      'after',
    ], ['beforeContentHash', 'after']);
    if (
      !['add', 'modify', 'remove'].includes(String(delta.op))
      || !nonEmpty(delta.skillId)
      || !nonEmpty(delta.noteId)
      || (delta.op !== 'add' && !hash(delta.beforeContentHash))
      || (delta.op === 'remove' && delta.after !== undefined)
      || (delta.op !== 'remove' && !validSkillNote(delta.after, delta.noteId))
    ) {
      fail('evolution_skill_note_delta_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'skill_note_delta',
      op: delta.op as 'add' | 'modify' | 'remove',
      skillId: delta.skillId as string,
      noteId: delta.noteId as string,
      ...(delta.beforeContentHash
        ? {beforeContentHash: delta.beforeContentHash as string}
        : {}),
      ...(delta.after
        ? {after: delta.after as EvolutionSkillNoteV1}
        : {}),
    });
  }
  if (delta.kind === 'retire_skill_note') {
    exactKeys(delta, [
      'kind',
      'noteId',
      'contentHash',
      'skillId',
    ], ['skillId']);
    if (
      !nonEmpty(delta.noteId)
      || !hash(delta.contentHash)
      || (delta.skillId !== undefined && !nonEmpty(delta.skillId))
    ) {
      fail('evolution_skill_note_retire_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'retire_skill_note',
      noteId: delta.noteId as string,
      contentHash: delta.contentHash as string,
      ...(delta.skillId ? {skillId: delta.skillId as string} : {}),
    });
  }
  fail('evolution_skill_note_delta_kind_invalid');
}

function parseValidation(value: unknown):
EvolutionOverlayProvenanceV1['validation'] {
  const validation = record(value, 'evolution_overlay_validation_invalid');
  exactKeys(validation, [
    'result',
    'validatorVersion',
    'at',
    'validationInputFingerprint',
    'boundInputs',
  ]);
  const boundInputs = parseValidationBoundInputs(validation.boundInputs);
  if (
    !['passed', 'failed', 'error'].includes(String(validation.result))
    || !nonEmpty(validation.validatorVersion)
    || !nonNegativeInteger(validation.at)
    || !hash(validation.validationInputFingerprint)
    || evolutionValidationInputFingerprint(boundInputs)
      !== validation.validationInputFingerprint
  ) {
    fail('evolution_overlay_validation_invalid');
  }
  return {
    result: validation.result as 'passed' | 'failed' | 'error',
    validatorVersion: validation.validatorVersion as string,
    at: validation.at as number,
    validationInputFingerprint:
      validation.validationInputFingerprint as string,
    boundInputs,
  };
}

function parseValidationBoundInputs(
  value: unknown,
): EvolutionValidationBoundInputsV1 {
  const inputs = record(value, 'evolution_validation_inputs_invalid');
  exactKeys(inputs, [
    'overlayContentHash',
    'validatedAgainstBaseFingerprint',
    'skillRegistryFingerprint',
    'strategyRegistryFingerprint',
    'fragmentsFingerprint',
    'toolAllowlistFingerprint',
    'promptTemplatesFingerprint',
    'loaderSchemaVersion',
    'buildIdentityFingerprint',
    'overlayGeneration',
  ], [
    'strategyRegistryFingerprint',
    'fragmentsFingerprint',
    'toolAllowlistFingerprint',
    'promptTemplatesFingerprint',
  ]);
  for (const key of [
    'overlayContentHash',
    'validatedAgainstBaseFingerprint',
    'skillRegistryFingerprint',
    'buildIdentityFingerprint',
  ] as const) {
    if (!hash(inputs[key])) fail('evolution_validation_inputs_invalid');
  }
  for (const key of [
    'strategyRegistryFingerprint',
    'fragmentsFingerprint',
    'toolAllowlistFingerprint',
    'promptTemplatesFingerprint',
  ] as const) {
    if (inputs[key] !== undefined && !hash(inputs[key])) {
      fail('evolution_validation_inputs_invalid');
    }
  }
  if (!nonEmpty(inputs.loaderSchemaVersion) || !nonEmpty(inputs.overlayGeneration)) {
    fail('evolution_validation_inputs_invalid');
  }
  return immutableCanonicalSnapshot(inputs) as unknown as
    EvolutionValidationBoundInputsV1;
}

function parseDerivedFrom(
  value: unknown,
): EvolutionOverlayProvenanceV1['derivedFrom'] {
  const derived = record(value, 'evolution_overlay_derived_from_invalid');
  exactKeys(derived, [
    'baseKind',
    'baseId',
    'baseVersion',
    'baseContentFingerprint',
    'baseOrigin',
    'basePackId',
    'basePackVersion',
    'baseTrustState',
  ], ['basePackId', 'basePackVersion', 'baseTrustState']);
  if (
    !['skill', 'strategy'].includes(String(derived.baseKind))
    || !nonEmpty(derived.baseId)
    || !nonEmpty(derived.baseVersion)
    || !hash(derived.baseContentFingerprint)
    || !['built_in', 'external_pack'].includes(String(derived.baseOrigin))
  ) {
    fail('evolution_overlay_derived_from_invalid');
  }
  return immutableCanonicalSnapshot(derived) as unknown as
    EvolutionOverlayProvenanceV1['derivedFrom'];
}

function parseDependencyFingerprints(
  value: unknown,
): EvolutionOverlayProvenanceV1['dependencyFingerprints'] {
  const dependencies = record(
    value,
    'evolution_overlay_dependencies_invalid',
  );
  exactKeys(dependencies, [
    'fragments',
    'toolAllowlist',
    'promptTemplates',
    'loaderSchemaVersion',
  ], ['fragments', 'toolAllowlist', 'promptTemplates']);
  for (const key of ['fragments', 'toolAllowlist', 'promptTemplates']) {
    if (dependencies[key] !== undefined && !hash(dependencies[key])) {
      fail('evolution_overlay_dependencies_invalid');
    }
  }
  if (!nonEmpty(dependencies.loaderSchemaVersion)) {
    fail('evolution_overlay_dependencies_invalid');
  }
  return immutableCanonicalSnapshot(dependencies) as unknown as
    EvolutionOverlayProvenanceV1['dependencyFingerprints'];
}

function parseProducedUnder(
  value: unknown,
): EvolutionOverlayProvenanceV1['producedUnder'] {
  const produced = record(value, 'evolution_overlay_produced_under_invalid');
  exactKeys(produced, [
    'buildIdentity',
    'traceProcessorVersion',
    'perfettoStdlibFingerprint',
    'testedMatrix',
  ], ['perfettoStdlibFingerprint']);
  const identity = record(
    produced.buildIdentity,
    'evolution_overlay_build_identity_invalid',
  );
  exactKeys(identity, [
    'distribution',
    'channel',
    'version',
    'commit',
    'target',
  ], ['commit', 'target']);
  if (
    !nonEmpty(identity.distribution)
    || !nonEmpty(identity.channel)
    || !nonEmpty(identity.version)
    || (identity.commit !== undefined && !nonEmpty(identity.commit))
    || (identity.target !== undefined && !nonEmpty(identity.target))
    || !nonEmpty(produced.traceProcessorVersion)
    || (
      produced.perfettoStdlibFingerprint !== undefined
      && !hash(produced.perfettoStdlibFingerprint)
    )
    || !Array.isArray(produced.testedMatrix)
  ) {
    fail('evolution_overlay_produced_under_invalid');
  }
  const testedMatrix = produced.testedMatrix.map(item => {
    const row = record(item, 'evolution_overlay_tested_matrix_invalid');
    exactKeys(row, ['runtime', 'providerId', 'model'], ['providerId', 'model']);
    if (
      !isProductionAgentRuntimeKind(row.runtime)
      || (row.providerId !== undefined && !nonEmpty(row.providerId))
      || (row.model !== undefined && !nonEmpty(row.model))
    ) {
      fail('evolution_overlay_tested_matrix_invalid');
    }
    return row;
  });
  return immutableCanonicalSnapshot({
    buildIdentity: identity,
    traceProcessorVersion: produced.traceProcessorVersion,
    ...(produced.perfettoStdlibFingerprint
      ? {perfettoStdlibFingerprint: produced.perfettoStdlibFingerprint}
      : {}),
    testedMatrix,
  }) as unknown as EvolutionOverlayProvenanceV1['producedUnder'];
}

function parseCompatibility(
  value: unknown,
): EvolutionOverlayProvenanceV1['compatibility'] {
  const compatibility = record(
    value,
    'evolution_overlay_compatibility_invalid',
  );
  exactKeys(compatibility, [
    'smartPerfettoMinVersion',
    'smartPerfettoMaxVersionTested',
  ]);
  if (
    !semver(compatibility.smartPerfettoMinVersion)
    || !semver(compatibility.smartPerfettoMaxVersionTested)
    || compareSemver(
      compatibility.smartPerfettoMinVersion,
      compatibility.smartPerfettoMaxVersionTested,
    ) > 0
  ) {
    fail('evolution_overlay_compatibility_invalid');
  }
  return compatibility as unknown as
    EvolutionOverlayProvenanceV1['compatibility'];
}

function parseReportGrouping(
  value: unknown,
  keys: readonly string[],
): Record<string, string[]> {
  const grouping = record(value, 'upgrade_reconciliation_report_invalid');
  exactKeys(grouping, keys);
  const parsed: Record<string, string[]> = {};
  for (const key of keys) {
    const ids = grouping[key];
    if (
      !Array.isArray(ids)
      || !ids.every(nonEmpty)
      || new Set(ids).size !== ids.length
    ) {
      fail('upgrade_reconciliation_report_invalid');
    }
    parsed[key] = [...ids];
  }
  return parsed;
}

function parseReconciliationIssue(value: unknown): unknown {
  const issue = record(value, 'upgrade_reconciliation_report_invalid');
  exactKeys(issue, [
    'schemaVersion',
    'issueId',
    'source',
    'kind',
    'sourcePath',
    'overlayId',
    'baseId',
    'reasonCode',
    'message',
  ], ['sourcePath', 'overlayId', 'baseId']);
  if (
    issue.schemaVersion !== 1
    || !nonEmpty(issue.issueId)
    || !['overlay', 'vendor_override'].includes(String(issue.source))
    || ![
      'orphan',
      'parse_failure',
      'validation_failure',
      'validation_error',
      'generation_publish_failure',
    ].includes(String(issue.kind))
    || !nonEmpty(issue.reasonCode)
    || !nonEmpty(issue.message)
    || ['sourcePath', 'overlayId', 'baseId'].some(key =>
      issue[key] !== undefined && !nonEmpty(issue[key]))
  ) {
    fail('upgrade_reconciliation_report_invalid');
  }
  return issue;
}

function parseReportBuildIdentity(value: unknown): ApplicationBuildIdentity {
  const identity = record(value, 'upgrade_reconciliation_report_invalid');
  exactKeys(identity, [
    'distribution',
    'channel',
    'version',
    'commit',
    'target',
    'signingMode',
  ], ['commit']);
  const target = record(
    identity.target,
    'upgrade_reconciliation_report_invalid',
  );
  exactKeys(target, ['os', 'arch', 'id'], ['id']);
  if (
    !['source', 'docker', 'portable', 'npm'].includes(
      String(identity.distribution),
    )
    || !['stable', 'nightly'].includes(String(identity.channel))
    || !nonEmpty(identity.version)
    || (
      identity.commit !== undefined
      && (
        !nonEmpty(identity.commit)
        || !/^[a-f0-9]{40}$/i.test(identity.commit)
      )
    )
    || (
      (identity.distribution === 'source' || identity.channel === 'nightly')
      && identity.commit === undefined
    )
    || ![
      'source-checkout',
      'container',
      'npm-registry',
      'unsigned',
      'macos-adhoc',
      'macos-developer-id',
      'macos-developer-id-notarized',
    ].includes(String(identity.signingMode))
    || !nonEmpty(target.os)
    || !nonEmpty(target.arch)
    || (target.id !== undefined && !nonEmpty(target.id))
  ) {
    fail('upgrade_reconciliation_report_invalid');
  }
  return identity as unknown as ApplicationBuildIdentity;
}

function compareSemver(left: unknown, right: unknown): number {
  const parse = (value: unknown): number[] =>
    String(value).split('-', 1)[0].split('.').map(Number);
  const l = parse(left);
  const r = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (l[index] !== r[index]) return l[index] - r[index];
  }
  return 0;
}

function parseEvalFingerprints(
  value: unknown,
): NonNullable<EvolutionOverlayProvenanceV1['evalFingerprints']> {
  const evals = record(value, 'evolution_overlay_eval_fingerprints_invalid');
  exactKeys(evals, ['evalSetId', 'baselineHash', 'candidateHash']);
  if (
    !nonEmpty(evals.evalSetId)
    || !hash(evals.baselineHash)
    || !hash(evals.candidateHash)
  ) {
    fail('evolution_overlay_eval_fingerprints_invalid');
  }
  return evals as unknown as
    NonNullable<EvolutionOverlayProvenanceV1['evalFingerprints']>;
}

function parseScope(value: unknown): {tenantId: string; workspaceId: string} {
  const scope = record(value, 'evolution_overlay_scope_invalid');
  exactKeys(scope, ['tenantId', 'workspaceId']);
  if (!nonEmpty(scope.tenantId) || !nonEmpty(scope.workspaceId)) {
    fail('evolution_overlay_scope_invalid');
  }
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  };
}

function validPhaseHint(value: unknown, hintId: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hint = value as Record<string, unknown>;
  return (
    Object.keys(hint).every(key =>
      ['id', 'keywords', 'constraints', 'criticalTools', 'critical'].includes(key))
    && hint.id === hintId
    && Array.isArray(hint.keywords)
    && hint.keywords.every(nonEmpty)
    && nonEmpty(hint.constraints)
    && Array.isArray(hint.criticalTools)
    && hint.criticalTools.every(nonEmpty)
    && typeof hint.critical === 'boolean'
  );
}

function validSkillNote(value: unknown, noteId: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const note = value as Record<string, unknown>;
  return (
    Object.keys(note).every(key =>
      ['schemaVersion', 'noteId', 'content', 'keywords'].includes(key))
    && note.schemaVersion === 1
    && note.noteId === noteId
    && nonEmpty(note.content)
    && Array.isArray(note.keywords)
    && note.keywords.every(nonEmpty)
  );
}

function payloadField(payload: Record<string, unknown>): string {
  switch (payload.payloadKind) {
    case 'skill_delta':
      return 'skillOverlay';
    case 'strategy_delta':
      return 'strategyDelta';
    case 'skill_note':
      return 'skillNoteDelta';
    default:
      return 'invalid';
  }
}

function payloadKindToOverlayKind(
  kind: EvolutionOverlayPayloadV1['payloadKind'],
): EvolutionOverlayProvenanceV1['overlayKind'] {
  return kind;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const required = allowed.filter(key => !optional.includes(key));
  if (
    Object.keys(value).some(key => !allowedSet.has(key))
    || required.some(key => !(key in value))
  ) {
    fail('evolution_overlay_unknown_or_missing_field');
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

function semver(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function fail(code: string): never {
  throw new Error(code);
}
