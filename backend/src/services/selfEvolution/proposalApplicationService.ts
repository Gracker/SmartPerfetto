// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AppliedProposalRevisionV1,
  CurationProposalV1,
  EvolutionOverlayArtifactV1,
  EvolutionRollbackReceiptV1,
  ProposalCandidateMaterializationV1,
  ProposalActionRecordV1,
  RunManifestScope,
} from '../../types/selfEvolution';
import {canonicalContentHash} from './canonicalJson';
import {
  createEvolutionRollbackReceiptV1,
  createEvolutionOverlayPayloadFromTreatmentEntry,
  parseEvolutionOverlayArtifactV1,
} from './evolutionOverlayContract';
import {
  evaluationFullTreatmentContractHash,
  parseEvaluationTreatmentArtifact,
  resolveEvaluationRoleVariant,
  type EvaluationTreatmentArtifactV1,
} from './evaluationTreatment';
import {EvolutionOverlayArtifactStore} from './evolutionOverlayArtifactStore';
import {EvolutionOverlayRegistry} from './evolutionOverlayRegistry';
import type {OverlayReconciler} from './overlayReconciler';
import {
  parseProposalCandidateMaterializationV1,
} from './proposalGateContract';
import type {ProposalStore} from './proposalStore';

export type ProposalApplicationPermission =
  | 'self_evolution:apply'
  | 'self_evolution:revert';

export interface ProposalApplicationMaterializationV1 {
  candidate: ProposalCandidateMaterializationV1;
  treatment: EvaluationTreatmentArtifactV1;
  artifacts: EvolutionOverlayArtifactV1[];
}

export interface ProposalApplicationServiceOptions {
  proposalStore: ProposalStore;
  overlayRegistry: EvolutionOverlayRegistry;
  artifactStore: EvolutionOverlayArtifactStore;
  reconciler: OverlayReconciler;
  authorize(
    permission: ProposalApplicationPermission,
    context: {scope: RunManifestScope; userId?: string},
  ): void;
  materializeArtifacts(
    proposal: CurationProposalV1,
  ): ProposalApplicationMaterializationV1
    | Promise<ProposalApplicationMaterializationV1>;
  now?: () => number;
}

export class ProposalApplicationService {
  private readonly now: () => number;

  constructor(private readonly options: ProposalApplicationServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async apply(input: {
    actionId: string;
    scope: RunManifestScope;
    proposalId: string;
    actor: {userId?: string};
  }): Promise<AppliedProposalRevisionV1> {
    this.options.authorize('self_evolution:apply', {
      scope: input.scope,
      ...input.actor,
    });
    const proposal = this.options.proposalStore.get(
      input.scope,
      input.proposalId,
    );
    if (!proposal) throw new Error('curation_proposal_not_found');
    if (proposal.tier === 'T4' || proposal.tier === 'T5a') {
      throw new Error('proposal_runtime_apply_forbidden');
    }
    const materialization =
      await this.options.materializeArtifacts(proposal);
    const artifacts = materialization.artifacts
      .map(parseEvolutionOverlayArtifactV1);
    if (artifacts.length === 0) {
      throw new Error('proposal_overlay_artifact_missing');
    }
    assertMaterializationBoundToGate({
      materialization,
      artifacts,
      proposal,
      proposalStore: this.options.proposalStore,
    });
    for (const artifact of artifacts) {
      assertArtifactBoundToProposal(artifact, proposal);
      this.options.artifactStore.put(artifact);
    }
    const action = this.options.proposalStore.reserveAction({
      actionId: input.actionId,
      scope: input.scope,
      proposalId: input.proposalId,
      kind: 'apply',
      sideEffectKind: 'runtime_overlay',
      artifactContentHashes: artifacts.map(artifact => artifact.contentHash),
      now: this.now(),
    });
    return this.runApplyAction(action, input.actor);
  }

  async revert(input: {
    actionId: string;
    scope: RunManifestScope;
    proposalId: string;
    actor: {userId?: string};
  }): Promise<AppliedProposalRevisionV1> {
    this.options.authorize('self_evolution:revert', {
      scope: input.scope,
      ...input.actor,
    });
    const action = this.options.proposalStore.reserveAction({
      actionId: input.actionId,
      scope: input.scope,
      proposalId: input.proposalId,
      kind: 'revert',
      sideEffectKind: 'runtime_overlay',
      now: this.now(),
    });
    return this.runRevertAction(action, input.actor);
  }

  async recoverPendingActions(): Promise<AppliedProposalRevisionV1[]> {
    const recovered: AppliedProposalRevisionV1[] = [];
    for (const action of this.options.proposalStore.listRecoverableActions()) {
      const active = action.state === 'failed'
        ? this.options.proposalStore.retryAction(action.actionId, this.now())
        : action;
      recovered.push(active.kind === 'apply'
        ? await this.runApplyAction(active, {})
        : await this.runRevertAction(active, {}));
    }
    return recovered;
  }

  private async runApplyAction(
    initial: ProposalActionRecordV1,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1> {
    let action = initial;
    let sideEffectStarted = false;
    try {
      if (action.state === 'pending') {
        action = this.options.proposalStore.markActionExecuting(
          action.actionId,
          this.now(),
        );
      }
      if (action.state !== 'executing') {
        throw new Error('proposal_action_not_executing');
      }
      const proposal = this.options.proposalStore.get(
        action.scope,
        action.proposalId,
      );
      if (!proposal) throw new Error('curation_proposal_not_found');
      if (
        proposal.status === 'applied'
        && proposal.revision === 4
      ) {
        return this.finishRecoveredApply(action, actor);
      }
      const artifacts = action.artifactContentHashes.map(contentHash =>
        this.options.artifactStore.load(contentHash));
      if (artifacts.length === 0) {
        throw new Error('proposal_overlay_artifact_missing');
      }
      for (const artifact of artifacts) {
        assertArtifactBoundToProposal(artifact, proposal);
        this.options.overlayRegistry.stageEntry({
          entryId: `entry:${artifact.contentHash}`,
          overlayId: artifact.provenance.overlayId,
          overlayKind: artifact.provenance.overlayKind,
          scope: proposal.scope,
          proposalId: proposal.proposalId,
          proposalRevision: 3,
          artifactContentHash: artifact.contentHash,
          actionId: action.actionId,
          baseRelation: 'unchanged',
          validationState: 'pending',
          userDisabled: false,
          createdAt: this.now(),
          provenance: artifact.provenance,
        });
      }
      sideEffectStarted = true;
      this.options.overlayRegistry.commitAction(action.actionId);
      const reconciliation = await this.options.reconciler.reconcile(
        action.scope,
        {deferRuntimePublish: true},
      );
      const effectiveOverlayIds = new Set(
        this.options.overlayRegistry.listEffectiveEntries(action.scope)
          .filter(entry => entry.actionId === action.actionId)
          .map(entry => entry.overlayId),
      );
      if (
        artifacts.some(artifact =>
          !effectiveOverlayIds.has(artifact.provenance.overlayId))
      ) {
        throw new Error('proposal_overlay_validation_failed');
      }
      action = this.options.proposalStore.recordActionSideEffectReceipt(
        action.actionId,
        reconciliation.report.contentHash,
        this.now(),
      );
      const applied = this.options.proposalStore.commitAppliedRevision({
        actionId: action.actionId,
        generation: reconciliation.snapshot.overlayGeneration,
        overlayIds: artifacts.map(artifact => artifact.provenance.overlayId),
        receiptContentHashes: [
          ...artifacts.map(artifact => artifact.contentHash),
          reconciliation.report.contentHash,
        ],
        actor,
        now: this.now(),
      });
      this.options.reconciler.publishRuntimeSnapshot(reconciliation.snapshot);
      this.options.proposalStore.finalizeActionRecord(
        action.actionId,
        this.now(),
      );
      return applied;
    } catch (error) {
      this.recordFailure(action, error, sideEffectStarted);
      throw error;
    }
  }

  private async finishRecoveredApply(
    action: ProposalActionRecordV1,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1> {
    const reconciliation = await this.options.reconciler.reconcile(
      action.scope,
      {deferRuntimePublish: true},
    );
    const overlays = this.options.overlayRegistry.listEntries(action.scope)
      .filter(entry => entry.actionId === action.actionId)
      .map(entry => entry.overlayId);
    const applied = this.options.proposalStore.commitAppliedRevision({
      actionId: action.actionId,
      generation: reconciliation.snapshot.overlayGeneration,
      overlayIds: overlays,
      receiptContentHashes: [reconciliation.report.contentHash],
      actor,
      now: this.now(),
    });
    this.options.reconciler.publishRuntimeSnapshot(reconciliation.snapshot);
    this.options.proposalStore.finalizeActionRecord(action.actionId, this.now());
    return applied;
  }

  private async runRevertAction(
    initial: ProposalActionRecordV1,
    actor: {userId?: string},
  ): Promise<AppliedProposalRevisionV1> {
    let action = initial;
    let sideEffectStarted = false;
    try {
      if (action.state === 'pending') {
        action = this.options.proposalStore.markActionExecuting(
          action.actionId,
          this.now(),
        );
      }
      const prior = [...this.options.proposalStore.listAppliedRevisions(
        action.proposalId,
      )].reverse().find(revision => revision.proposalRevision === 4);
      if (!prior) throw new Error('applied_proposal_revision_missing');
      const receipts: EvolutionRollbackReceiptV1[] = [];
      for (const entry of this.options.overlayRegistry.listEntries(action.scope)
        .filter(candidate => prior.overlayIds.includes(candidate.overlayId))) {
        sideEffectStarted = true;
        this.options.overlayRegistry.reconcileEntry({
          scope: action.scope,
          entryId: entry.entryId,
          baseRelation: entry.baseRelation,
          validationState: entry.validationState,
          userDisabled: true,
          validationReason: 'user_reverted',
          reconciledAt: this.now(),
        });
        const receipt = createEvolutionRollbackReceiptV1({
          actionId: action.actionId,
          scope: action.scope,
          kind: entry.overlayKind === 'skill_note'
            ? 'skill_note_disabled'
            : 'local_overlay_reverted',
          targetId: entry.overlayId,
          idempotent: true,
          sideEffectContentHash: entry.artifactContentHash,
          createdAt: action.createdAt,
        });
        this.options.overlayRegistry.saveRollbackReceipt(receipt);
        receipts.push(receipt);
      }
      const reconciliation = await this.options.reconciler.reconcile(
        action.scope,
        {deferRuntimePublish: true},
      );
      this.options.proposalStore.recordActionSideEffectReceipt(
        action.actionId,
        canonicalContentHash(receipts),
        this.now(),
      );
      const reverted = this.options.proposalStore.commitAppliedRevision({
        actionId: action.actionId,
        generation: reconciliation.snapshot.overlayGeneration,
        overlayIds: prior.overlayIds,
        receiptContentHashes: [
          ...receipts.map(receipt => receipt.contentHash),
          reconciliation.report.contentHash,
        ],
        actor,
        now: this.now(),
      });
      this.options.reconciler.publishRuntimeSnapshot(reconciliation.snapshot);
      this.options.proposalStore.finalizeActionRecord(
        action.actionId,
        this.now(),
      );
      return reverted;
    } catch (error) {
      this.recordFailure(action, error, sideEffectStarted);
      throw error;
    }
  }

  private recordFailure(
    action: ProposalActionRecordV1,
    error: unknown,
    sideEffectStarted: boolean,
  ): void {
    const current = this.options.proposalStore.getAction(action.actionId);
    if (!current || !['pending', 'executing'].includes(current.state)) return;
    this.options.proposalStore.failAction({
      actionId: action.actionId,
      failureClass: sideEffectStarted
        ? 'recovery_required_after_side_effect'
        : 'retryable_before_side_effect',
      errorCode: error instanceof Error ? error.message : String(error),
      now: this.now(),
    });
  }
}

function assertArtifactBoundToProposal(
  artifact: EvolutionOverlayArtifactV1,
  proposal: CurationProposalV1,
): void {
  if (
    artifact.provenance.proposalId !== proposal.proposalId
    || artifact.provenance.proposalRevision !== 3
    || artifact.provenance.scope.tenantId !== proposal.scope.tenantId
    || artifact.provenance.scope.workspaceId !== proposal.scope.workspaceId
    || artifact.provenance.gateVerdict !== 'passed'
  ) {
    throw new Error('proposal_overlay_artifact_binding_invalid');
  }
}

function assertMaterializationBoundToGate(input: {
  materialization: ProposalApplicationMaterializationV1;
  artifacts: EvolutionOverlayArtifactV1[];
  proposal: CurationProposalV1;
  proposalStore: ProposalStore;
}): void {
  const candidate = parseProposalCandidateMaterializationV1(
    input.materialization.candidate,
  );
  const treatment = parseEvaluationTreatmentArtifact(
    input.materialization.treatment,
  );
  const evidence = input.proposalStore.getApplicationGateEvidence(
    input.proposal.scope,
    input.proposal.proposalId,
  );
  const roleVariant = resolveEvaluationRoleVariant({
    artifact: treatment,
    scope: input.proposal.scope,
    baseSkillRegistryFingerprint:
      treatment.baseSkillRegistryFingerprint,
    baseStrategyRegistryFingerprint:
      treatment.baseStrategyRegistryFingerprint,
  });
  if (
    candidate.contentHash !== evidence.candidate.contentHash
    || treatment.sourceCandidateContentHash !== candidate.contentHash
    || treatment.contentHash
      !== evidence.pairedReplayProof.treatmentArtifactContentHash
    || roleVariant.materializedInputHash
      !== evidence.pairedReplayProof.materializedInputHash
    || evaluationFullTreatmentContractHash(roleVariant)
      !== evidence.pairedReplayProof.fullTreatmentContractHash
  ) {
    throw new Error('proposal_application_gate_binding_mismatch');
  }
  const expectedPayloadHashes = treatment.entries
    .map(createEvolutionOverlayPayloadFromTreatmentEntry)
    .map(canonicalContentHash)
    .sort();
  const actualPayloadHashes = input.artifacts
    .map(artifact => canonicalContentHash(artifact.payload))
    .sort();
  if (
    expectedPayloadHashes.length !== actualPayloadHashes.length
    || expectedPayloadHashes.some(
      (value, index) => value !== actualPayloadHashes[index],
    )
  ) {
    throw new Error('proposal_application_treatment_payload_mismatch');
  }
}
