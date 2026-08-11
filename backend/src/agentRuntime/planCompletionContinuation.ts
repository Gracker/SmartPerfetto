// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {AnalysisPlanCompletionStatus} from '../agentv3/planCompletionStatus';
import type {Hypothesis} from '../agentv3/types';

export function loadRuntimePlanCompletionContinuationPrompt(input: {
  planStatus: AnalysisPlanCompletionStatus;
  unresolvedHypotheses: readonly Hypothesis[];
  outputLanguage: OutputLanguage;
}): string {
  const planStatusJson = JSON.stringify({
    hasPlan: input.planStatus.hasPlan,
    pendingPhases: input.planStatus.pendingPhases.map(phase => ({
      id: phase.id,
      name: phase.name,
      goal: phase.goal,
      status: phase.status,
      expectedTools: phase.expectedTools ?? [],
      expectedCalls: phase.expectedCalls ?? [],
    })),
    evidenceGaps: (input.planStatus.evidenceGaps ?? []).map(gap => ({
      phaseId: gap.phase.id,
      phaseName: gap.phase.name,
      missingExpectedCalls: gap.missingExpectedCalls,
      missingGenericToolEvidence: Boolean(gap.missingGenericToolEvidence),
    })),
    unresolvedHypotheses: input.unresolvedHypotheses.map(hypothesis => ({
      id: hypothesis.id,
      statement: hypothesis.statement,
      basis: hypothesis.basis,
      status: hypothesis.status,
    })),
  }, null, 2);
  return renderRequiredLocalizedStrategyTemplate(
    'prompt-plan-completion-continuation',
    input.outputLanguage,
    {plan_status_json: planStatusJson},
  );
}
