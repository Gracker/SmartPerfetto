// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from './outputLanguage';

/**
 * Plan phase transitions come from two different places, and the analysis
 * timeline has to tell them apart.
 *
 * `model` transitions are the model calling `update_plan_phase`; the tool
 * dispatch line already narrates those, so repeating them duplicates a line.
 * `auto` transitions are the runtime inferring progress from collected
 * evidence, and nothing else in the stream reports them — before this contract
 * existed they were emitted, delivered, and then dropped on the floor.
 *
 * The origin is an explicit field rather than a text prefix check: the
 * summaries are localized, and matching on Chinese wording breaks under
 * `SMARTPERFETTO_OUTPUT_LANGUAGE=en`.
 */
export type PlanPhaseUpdateOrigin = 'model' | 'auto';

/** Every status `update_plan_phase` and the auto-transitions can produce. */
export type PlanPhaseUpdateStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface PlanPhaseUpdateContent {
  phaseId: string;
  phaseName?: string;
  status: string;
  summary?: string;
  origin: PlanPhaseUpdateOrigin;
}

/**
 * Build the `plan_phase_updated` payload. Going through this helper is what
 * keeps `origin` from being forgotten at one of the nine emit sites.
 */
export function planPhaseUpdatedContent(input: PlanPhaseUpdateContent): PlanPhaseUpdateContent {
  return {
    phaseId: input.phaseId,
    ...(input.phaseName ? { phaseName: input.phaseName } : {}),
    status: input.status,
    summary: input.summary ?? '',
    origin: input.origin,
  };
}

export function normalizePlanPhaseUpdateStatus(value: unknown): PlanPhaseUpdateStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'skipped'
    ? value
    : undefined;
}

export function readPlanPhaseUpdateOrigin(value: unknown): PlanPhaseUpdateOrigin | undefined {
  return value === 'model' || value === 'auto' ? value : undefined;
}

/**
 * One timeline line for a plan phase transition.
 *
 * Unknown statuses get a neutral sentence instead of being forced into
 * "entered" or "completed"; mislabelling a rollback as progress would be worse
 * than saying less.
 */
export function formatPlanPhaseTransition(
  input: { phaseName?: string; phaseId: string; status: string; summary?: string },
  language: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string {
  const label = (input.phaseName || '').trim() || input.phaseId;
  const summary = (input.summary || '').trim();
  const detail = summary ? `：${summary}` : '';
  const detailEn = summary ? `: ${summary}` : '';

  switch (normalizePlanPhaseUpdateStatus(input.status)) {
    case 'in_progress':
      // The summary of an entry transition is the tool call that triggered it,
      // and that call is narrated on the line immediately before this one.
      // Repeating it here printed the same sentence twice in a row.
      return localize(language, `进入阶段「${label}」`, `Entering phase "${label}"`);
    case 'completed':
      return localize(language, `完成阶段「${label}」${detail}`, `Completed phase "${label}"${detailEn}`);
    case 'pending':
      return localize(
        language,
        `阶段「${label}」退回待补证${detail}`,
        `Phase "${label}" returned to pending${detailEn}`,
      );
    case 'skipped':
      return localize(language, `跳过阶段「${label}」${detail}`, `Skipped phase "${label}"${detailEn}`);
    default:
      return localize(
        language,
        `阶段「${label}」状态更新为 ${input.status}${detail}`,
        `Phase "${label}" status changed to ${input.status}${detailEn}`,
      );
  }
}
