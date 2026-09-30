// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisPlanV3, PlanPhase } from './types';
import {
  findCompletedPhaseEvidenceGaps,
  getPhaseToolEvidenceStatus,
  type PlanEvidenceGap,
} from './planToolCallRecorder';
import {hasValidPlanSkipDisposition} from './planPhaseSemantics';

export interface AnalysisPlanCompletionStatus {
  complete: boolean;
  hasPlan: boolean;
  pendingPhases: PlanPhase[];
  evidenceGaps?: PlanEvidenceGap[];
  /** Closed skips retain unfulfilled declarations for delivery/coverage review. */
  unresolvedExpectations?: PlanEvidenceGap[];
}

export function getAnalysisPlanCompletionStatus(
  plan: AnalysisPlanV3 | null | undefined,
): AnalysisPlanCompletionStatus {
  if (plan === null || plan === undefined) {
    return { complete: true, hasPlan: false, pendingPhases: [] };
  }
  if (!Array.isArray(plan.phases) || plan.phases.length === 0 ||
    new Set(plan.phases.map(phase => phase?.id)).size !== plan.phases.length || plan.phases.some(phase =>
    !phase || typeof phase !== 'object' ||
    typeof phase.id !== 'string' || !phase.id.trim() ||
    typeof phase.name !== 'string' || !phase.name.trim() ||
    typeof phase.goal !== 'string' || !phase.goal.trim() ||
    (phase.expectedTools !== undefined && (!Array.isArray(phase.expectedTools) ||
      phase.expectedTools.some(tool => typeof tool !== 'string' || !tool.trim()))) ||
    (phase.expectedCalls !== undefined && (!Array.isArray(phase.expectedCalls) ||
      phase.expectedCalls.some(call => !call || typeof call.tool !== 'string' || !call.tool.trim()))),
  )) {
    return { complete: false, hasPlan: true, pendingPhases: [] };
  }

  const evidenceGaps = findCompletedPhaseEvidenceGaps(plan);
  const evidenceGapPhaseIds = new Set(evidenceGaps.map(gap => gap.phase.id));
  const pendingPhases = plan.phases.filter(phase =>
    (phase.status !== 'completed' && !(phase.status === 'skipped' && hasValidPlanSkipDisposition(plan, phase))) ||
    evidenceGapPhaseIds.has(phase.id));
  const unresolvedExpectations = plan.phases.flatMap(phase => {
    if (phase.status !== 'skipped') return [];
    const status = getPhaseToolEvidenceStatus(plan, phase);
    return status.satisfied ? [] : [{phase, matchedCalls: status.matchedCalls,
      missingExpectedCalls: status.missingExpectedCalls, missingExpectedTools: status.missingExpectedTools,
      missingGenericToolEvidence: status.missingGenericToolEvidence}];
  });
  return {
    complete: pendingPhases.length === 0,
    hasPlan: true,
    pendingPhases,
    ...(evidenceGaps.length > 0 ? { evidenceGaps } : {}),
    ...(unresolvedExpectations.length > 0 ? {unresolvedExpectations} : {}),
  };
}
