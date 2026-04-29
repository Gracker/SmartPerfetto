// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Active-phase reminder — a one-line restatement of the *current*
 * phase's constraint, appended to high-risk tool responses so the
 * agent doesn't drift off-plan when it's busy parsing a large payload.
 *
 * Codex review A.5 of the v2.1 plan called out that injecting a phase
 * reminder into every data tool is noise for SmartPerfetto's typical
 * 20-25 turn sessions. Phase 3-4 narrows the injection to **high-risk
 * paths only** — `fetch_artifact(level=full|rows)` is the canonical
 * case because its payload is large and the agent often forgets the
 * active phase while skimming the rows.
 *
 * The reminder's content reuses `phaseHintMatcher` (Phase 4) so the
 * matched phase_hint here is the same one `update_plan_phase` would
 * have injected on a transition. Both sources stay consistent.
 *
 * Phase 3-3 (orchestrator wiring) will additionally reuse this from
 * the post-compact fallback path so the first tool result after a
 * recovery cycle gets a free reminder.
 */

import { matchPhaseHintForNextPhase } from './phaseHintMatcher';
import { getPhaseHints } from './strategyLoader';
import type { AnalysisPlanV3 } from './types';
import type { SceneType } from './sceneClassifier';

export const REMINDER_PREFIX = '\n\n[计划提醒]';

/**
 * Render the active-phase reminder string. Returns an empty string
 * when there is nothing useful to inject (no plan, no in-progress /
 * pending phase, or the scene has no phase_hints configured).
 *
 * Pure function: takes the plan + sceneType and returns a string.
 */
export function buildActivePhaseReminder(
  plan: AnalysisPlanV3 | null | undefined,
  sceneType?: SceneType,
): string {
  if (!plan || !sceneType) return '';

  const activePhase = plan.phases.find(
    p => p.status === 'in_progress' || p.status === 'pending',
  );
  if (!activePhase) return '';

  const hints = getPhaseHints(sceneType);
  if (hints.length === 0) {
    // No phase_hints — fall back to a short pointer at the active phase.
    return `${REMINDER_PREFIX} 当前阶段「${activePhase.name}」: ${activePhase.goal}`.slice(0, 200);
  }

  const matched = matchPhaseHintForNextPhase({
    hints,
    nextPhase: { name: activePhase.name, goal: activePhase.goal },
    finishedPhases: plan.phases.map(p => ({
      name: p.name,
      goal: p.goal,
      summary: p.summary,
      status: p.status,
    })),
  });
  if (!matched) {
    return `${REMINDER_PREFIX} 当前阶段「${activePhase.name}」: ${activePhase.goal}`.slice(0, 200);
  }

  // Trim aggressively — this string lives at the tail of every full/rows
  // fetch_artifact response, and we'd rather drop the criticalTools list
  // than blow past 200 chars.
  const constraint = matched.constraints.length > 140
    ? matched.constraints.slice(0, 137) + '...'
    : matched.constraints;
  const tools = matched.criticalTools.length > 0
    ? ` 关键工具: ${matched.criticalTools.slice(0, 3).join(', ')}`
    : '';
  return `${REMINDER_PREFIX} 当前阶段「${activePhase.name}」约束: ${constraint}${tools}`;
}
