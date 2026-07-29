// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  ProposalCandidateMaterializationV1,
  ProposalMaterializationPlanV1,
} from '../../types/selfEvolution';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';
import {
  createProposalCandidateMaterializationV1,
  parseProposalMaterializationPlanV1,
  proposalDraftContentHash,
} from './proposalGateContract';
import {parseM6DraftProposal} from './proposalContract';

export interface ProposalBaseSnapshotV1 {
  targetId: string;
  contentHash: string;
  content?: string;
  anchorContent?: string;
  registryFingerprint: string;
  skillRegistryFingerprint: string;
  strategyRegistryFingerprint: string;
  overlayGeneration: string;
}

export function materializeProposalCandidate(input: {
  proposal: CurationProposalV1;
  plan: ProposalMaterializationPlanV1;
  base: ProposalBaseSnapshotV1;
}): ProposalCandidateMaterializationV1 {
  const proposal = parseM6DraftProposal(input.proposal);
  const plan = parseProposalMaterializationPlanV1(input.plan);
  const draftContentHash = proposalDraftContentHash(proposal);
  const delta = proposal.deltas[0];
  if (
    plan.proposalId !== proposal.proposalId
    || plan.draftContentHash !== draftContentHash
    || plan.targetKind !== delta.targetKind
    || input.base.targetId !== delta.targetId
    || input.base.contentHash !== delta.baseContentHash
    || input.base.registryFingerprint !== proposal.expectedRegistryFingerprint
    || input.base.overlayGeneration !== proposal.expectedOverlayGeneration
  ) {
    throw new Error('proposal_semantic_base_binding_mismatch');
  }
  if (
    delta.before !== undefined
    && input.base.content !== undefined
    && delta.before !== input.base.content
  ) {
    throw new Error('proposal_semantic_before_mismatch');
  }
  if (
    proposal.kind === 'skill_sql'
    && (
      input.base.anchorContent === undefined
      || delta.before === undefined
      || input.base.anchorContent !== delta.before
    )
  ) {
    throw new Error('proposal_semantic_anchor_content_mismatch');
  }
  const serializedContent = serializeProposalCandidateContent(proposal);
  const artifactId = [
    'proposal',
    proposal.proposalId,
    proposal.revision,
    draftContentHash,
    plan.contentHash,
  ].join(':');
  return createProposalCandidateMaterializationV1({
    proposalId: proposal.proposalId,
    proposalRevision: 1,
    draftContentHash,
    planContentHash: plan.contentHash,
    artifactId,
    targetKind: delta.targetKind,
    serializedContent,
  });
}

export function serializeProposalCandidateContent(
  proposal: CurationProposalV1,
): string {
  const delta = proposal.deltas[0];
  if (proposal.kind === 'skill_sql') {
    if (delta.op === 'remove' || !delta.after?.trim()) {
      throw new Error('proposal_semantic_skill_sql_invalid');
    }
    return delta.after;
  }
  if (proposal.kind === 'new_skill_draft') {
    if (delta.op !== 'add' || !delta.after?.trim()) {
      throw new Error('proposal_semantic_new_skill_invalid');
    }
    return delta.after;
  }
  if (proposal.kind === 'strategy_section') {
    if (delta.op === 'remove' || !delta.after?.trim()) {
      throw new Error('proposal_semantic_strategy_section_invalid');
    }
    return delta.after;
  }
  if (proposal.kind === 'skill_overlay_delta') {
    if (delta.op !== 'add' || !delta.after?.trim()) {
      throw new Error('proposal_semantic_skill_overlay_invalid');
    }
    return delta.after;
  }
  return canonicalJsonString({
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    tier: proposal.tier,
    operation: {
      op: delta.op,
      targetKind: delta.targetKind,
      targetId: delta.targetId,
      operationId: delta.operationId,
      anchor: delta.anchor,
      baseContentHash: delta.baseContentHash,
      ...(delta.before !== undefined ? {before: delta.before} : {}),
      ...(delta.after !== undefined ? {after: delta.after} : {}),
    },
  });
}
