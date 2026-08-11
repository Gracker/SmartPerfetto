// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisPlanV3, PlanPhase} from '../agentv3/types';
import {getAnalysisPlanCompletionStatus} from '../agentv3/planCompletionStatus';
import {isConclusionLikePlanPhase} from '../agentv3/planPhaseSemantics';
import {findMissingExpectedCallsForPhase} from '../agentv3/planToolCallRecorder';

export interface FinalReportPhaseReconciliationInput {
  plan: AnalysisPlanV3 | null | undefined;
  conclusion: string;
  minSummaryChars: number;
  isDeliverableReport: (conclusion: string) => boolean;
  buildSummary: (conclusion: string) => string;
  now?: () => number;
}

/**
 * Reconcile provider output with the plan state only when the provider has
 * actually delivered the sole remaining conclusion phase. Evidence phases,
 * unresolved plan requirements, and structured expected-call gaps are never
 * auto-closed here.
 */
export function reconcileDeliveredFinalReportPhase(
  input: FinalReportPhaseReconciliationInput,
): PlanPhase | undefined {
  const plan = input.plan;
  if (!plan?.phases?.length || plan.unresolvedAspects?.length) return undefined;

  const status = getAnalysisPlanCompletionStatus(plan, {
    minSummaryChars: input.minSummaryChars,
  });
  if (status.complete || status.pendingPhases.length !== 1 || status.evidenceGaps?.length) {
    return undefined;
  }

  const [phase] = status.pendingPhases;
  if (
    (phase.status !== 'pending' && phase.status !== 'in_progress') ||
    !isConclusionLikePlanPhase(phase)
  ) return undefined;
  if (findMissingExpectedCallsForPhase(phase, plan.toolCallLog ?? []).length > 0) return undefined;

  const conclusion = input.conclusion.trim();
  if (!input.isDeliverableReport(conclusion)) return undefined;
  const summary = input.buildSummary(conclusion).trim();
  if (summary.length < input.minSummaryChars) return undefined;

  phase.status = 'completed';
  phase.completedAt = (input.now ?? Date.now)();
  phase.summary = summary;
  return phase;
}
