// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {parseStrategyContribution} from '../../agentv3/strategyLoader';
import type {
  CurationProposalV1,
  ProposalCandidateMaterializationV1,
} from '../../types/selfEvolution';
import {parseSkillOverlayDeltaV1} from './effectiveSkillComposer';
import {
  createEvaluationTreatmentArtifact,
  resolveEvaluationRoleVariant,
  type EvaluationRoleVariantV1,
  type EvaluationTreatmentArtifactV1,
  type EvaluationTreatmentEntryV1,
} from './evaluationTreatment';
import {
  parseProposalCandidateMaterializationV1,
  proposalDraftContentHash,
} from './proposalGateContract';
import {parseM6DraftProposal} from './proposalContract';

export interface ProposalTreatmentBaseV1 {
  skillRegistryFingerprint: string;
  strategyRegistryFingerprint: string;
}

export interface ProposalTreatmentMaterializationV1 {
  artifact: EvaluationTreatmentArtifactV1;
  roleVariant: EvaluationRoleVariantV1;
}

export function materializeProposalTreatment(input: {
  proposal: CurationProposalV1;
  candidate: ProposalCandidateMaterializationV1;
  base: ProposalTreatmentBaseV1;
}): ProposalTreatmentMaterializationV1 | undefined {
  const proposal = parseM6DraftProposal(input.proposal);
  const candidate = parseProposalCandidateMaterializationV1(input.candidate);
  if (
    candidate.proposalId !== proposal.proposalId
    || candidate.draftContentHash !== proposalDraftContentHash(proposal)
  ) {
    throw new Error('proposal_treatment_candidate_binding_mismatch');
  }
  if (proposal.tier === 'T4' || proposal.tier === 'T5a') return undefined;
  const artifact = createEvaluationTreatmentArtifact({
    artifactId: candidate.artifactId,
    sourceCandidateContentHash: candidate.contentHash,
    scope: proposal.scope,
    baseSkillRegistryFingerprint: input.base.skillRegistryFingerprint,
    baseStrategyRegistryFingerprint: input.base.strategyRegistryFingerprint,
    entries: [materializeEntry(proposal)],
    createdAt: proposal.createdAt,
  });
  const roleVariant = resolveEvaluationRoleVariant({
    artifact,
    scope: proposal.scope,
    baseSkillRegistryFingerprint: input.base.skillRegistryFingerprint,
    baseStrategyRegistryFingerprint: input.base.strategyRegistryFingerprint,
  });
  return {artifact, roleVariant};
}

function materializeEntry(
  proposal: CurationProposalV1,
): EvaluationTreatmentEntryV1 {
  const delta = proposal.deltas[0];
  switch (proposal.kind) {
    case 'phase_hint': {
      const match =
        /^injections\.phaseHints\[scene=("(?:\\.|[^"\\])*")\]\[id=("(?:\\.|[^"\\])*")\]$/
          .exec(delta.anchor);
      if (!match) throw new Error('proposal_treatment_phase_hint_anchor_invalid');
      const scene = parseJsonString(match[1]);
      const hintId = parseJsonString(match[2]);
      const after = delta.after === undefined
        ? undefined
        : JSON.parse(delta.after);
      return {
        kind: 'phase_hint_delta',
        op: delta.op,
        scene,
        hintId,
        ...(delta.op === 'add'
          ? {}
          : {beforeContentHash: delta.baseContentHash}),
        ...(after === undefined ? {} : {after}),
      };
    }
    case 'skill_note':
      return {
        kind: 'skill_note',
        op: delta.op,
        skillId: delta.targetId,
        noteId: delta.operationId,
        ...(delta.op === 'add'
          ? {}
          : {beforeContentHash: delta.baseContentHash}),
        ...(delta.after === undefined
          ? {}
          : {
              after: {
                schemaVersion: 1,
                noteId: delta.operationId,
                content: delta.after,
                keywords: [],
              },
            }),
      };
    case 'strategy_section': {
      const contribution = parseStrategyContribution(
        JSON.parse(delta.after ?? ''),
      );
      if (
        contribution.contributionId !== delta.operationId
        || contribution.scene !== delta.targetId
        || contribution.baseStrategyFingerprint !== delta.baseContentHash
        || contribution.createdAt !== proposal.createdAt
        || contribution.scope.tenantId !== proposal.scope.tenantId
        || contribution.scope.workspaceId !== proposal.scope.workspaceId
        || contribution.operations.length !== 1
        || contribution.operations[0].operationId !== delta.operationId
      ) {
        throw new Error('proposal_treatment_strategy_binding_mismatch');
      }
      return {kind: 'strategy_contribution', contribution};
    }
    case 'skill_overlay_delta': {
      const parsed = parseSkillOverlayDeltaV1(JSON.parse(delta.after ?? ''));
      if (!parsed.ok) {
        throw new Error('proposal_treatment_skill_overlay_invalid');
      }
      const overlay = parsed.value;
      if (
        overlay.proposalId !== proposal.proposalId
        || overlay.baseSkillId !== delta.targetId
        || overlay.baseFingerprint !== delta.baseContentHash
        || overlay.createdAt !== proposal.createdAt
        || overlay.scope.tenantId !== proposal.scope.tenantId
        || overlay.scope.workspaceId !== proposal.scope.workspaceId
        || overlay.operations.length !== 1
        || overlay.operations[0].operationId !== delta.operationId
      ) {
        throw new Error('proposal_treatment_skill_overlay_binding_mismatch');
      }
      return {kind: 'skill_overlay_delta', overlay};
    }
    case 'retire_injection': {
      const match = /^injections\.(phaseHints|skillNotes)\[id=(.+)\]$/.exec(
        delta.anchor,
      );
      if (!match) throw new Error('proposal_treatment_retire_anchor_invalid');
      return {
        kind: 'retire_injection',
        category: match[1] as 'phaseHints' | 'skillNotes',
        id: parseJsonString(match[2]),
        contentHash: delta.baseContentHash,
        injectionContentHash: delta.baseContentHash,
      };
    }
    case 'skill_sql':
    case 'new_skill_draft':
      throw new Error('proposal_treatment_forbidden_by_tier');
  }
}

function parseJsonString(value: string): string {
  const parsed = JSON.parse(value);
  if (typeof parsed !== 'string' || JSON.stringify(parsed) !== value) {
    throw new Error('proposal_treatment_anchor_not_canonical');
  }
  return parsed;
}
