// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisPlanV3, PlanPhase } from './types';
import {
  findCompletedPhaseEvidenceGaps,
  type PlanEvidenceGap,
} from './planToolCallRecorder';
import {isSourceLookupToolName} from '../services/codebase/sourceLookupTools';

export interface AnalysisPlanCompletionStatus {
  complete: boolean;
  hasPlan: boolean;
  pendingPhases: PlanPhase[];
  evidenceGaps?: PlanEvidenceGap[];
  sourceUseDecisionPending?: true;
}

export function hasAdequateClosedPhaseSummary(
  phase: PlanPhase,
  minSummaryChars: number,
): boolean {
  if (phase.status !== 'completed' && phase.status !== 'skipped') return false;
  return typeof phase.summary === 'string' && phase.summary.trim().length >= minSummaryChars;
}

export function getAnalysisPlanCompletionStatus(
  plan: AnalysisPlanV3 | null | undefined,
  options: {
    minSummaryChars: number;
    quickMode?: boolean;
  },
): AnalysisPlanCompletionStatus {
  if (options.quickMode) {
    return { complete: true, hasPlan: false, pendingPhases: [] };
  }
  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    return { complete: false, hasPlan: false, pendingPhases: [] };
  }

  const evidenceGaps = findCompletedPhaseEvidenceGaps(plan);
  const evidenceGapPhaseIds = new Set(evidenceGaps.map(gap => gap.phase.id));
  const pendingPhaseIds = new Set(plan.phases.filter(phase =>
    !hasAdequateClosedPhaseSummary(phase, options.minSummaryChars) ||
    evidenceGapPhaseIds.has(phase.id),
  ).map(phase => phase.id));
  const sourceUseDecisionPending = plan.sourceUseDecisionStatus === 'pending' ||
    plan.sourceUseDecisionStatus === 'attempted';
  if (sourceUseDecisionPending) {
    const sourcePhases = plan.phases.filter(phase => [
      ...(phase.expectedTools ?? []),
      ...(phase.expectedCalls ?? []).map(call => call.tool),
    ].some(isSourceLookupToolName));
    if (sourcePhases.length > 0) {
      sourcePhases.forEach(phase => pendingPhaseIds.add(phase.id));
    } else if (pendingPhaseIds.size === 0) {
      pendingPhaseIds.add(plan.phases[0].id);
    }
  }
  const pendingPhases = plan.phases.filter(phase => pendingPhaseIds.has(phase.id));
  return {
    complete: pendingPhases.length === 0 && !sourceUseDecisionPending,
    hasPlan: true,
    pendingPhases,
    ...(evidenceGaps.length > 0 ? { evidenceGaps } : {}),
    ...(sourceUseDecisionPending ? {sourceUseDecisionPending: true as const} : {}),
  };
}
