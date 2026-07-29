// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  EffectiveFeedbackV1,
  FeedbackNegativeDimension,
  RunManifestV1,
} from '../../types/selfEvolution';
import type {FailureAttributionResult} from './curationContracts';

const DIMENSION_CATEGORY = new Map<
  FeedbackNegativeDimension,
  'skill_empty_result' | 'tool_repeated_failure'
>([
  ['insufficient_evidence', 'skill_empty_result'],
  ['too_shallow', 'skill_empty_result'],
  ['too_slow', 'tool_repeated_failure'],
]);

/**
 * Conservative, manifest-backed failure attribution.
 *
 * Comments never participate. Unknown, conflicting, tied, or merely textual
 * signals stay inconclusive and therefore cannot produce a proposal.
 */
export function attributeFailure(input: {
  feedback: EffectiveFeedbackV1;
  manifest: RunManifestV1;
}): FailureAttributionResult {
  const {feedback, manifest} = input;
  if (feedback.rating !== 'negative') {
    return {status: 'inconclusive', reason: 'feedback_not_negative'};
  }
  if (
    feedback.runId !== manifest.runId ||
    feedback.runManifestId !== manifest.runManifestId ||
    feedback.scope.tenantId !== manifest.scope.tenantId ||
    feedback.scope.workspaceId !== manifest.scope.workspaceId
  ) {
    return {status: 'inconclusive', reason: 'feedback_manifest_mismatch'};
  }
  const mapped = feedback.dimensions.flatMap(dimension => {
    const category = DIMENSION_CATEGORY.get(
      dimension as FeedbackNegativeDimension,
    );
    return category ? [{dimension, category}] : [];
  });
  if (mapped.length !== 1) {
    return {
      status: 'inconclusive',
      reason: 'dimension_not_uniquely_mapped',
    };
  }
  const [{dimension, category}] = mapped;
  const candidates = manifest.skills.filter(skill =>
    skill.invocations > 0 &&
    (category === 'skill_empty_result'
      ? skill.emptyResultCount > 0
      : skill.errorCount >= 2));
  if (candidates.length === 0) {
    return {status: 'inconclusive', reason: 'technical_signal_missing'};
  }
  if (candidates.length !== 1) {
    return {status: 'inconclusive', reason: 'technical_signal_ambiguous'};
  }
  const skill = candidates[0];
  return {
    status: 'attributed',
    category,
    skillId: skill.skillId,
    skillContentFingerprint: skill.contentFingerprint,
    dimension: dimension as
      | 'insufficient_evidence'
      | 'too_shallow'
      | 'too_slow',
    reason: category === 'skill_empty_result'
      ? 'unique_skill_empty_result'
      : 'unique_skill_repeated_failure',
  };
}
