// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { localize, parseOutputLanguage } from '../../agentv3/outputLanguage';
import type { DisplayResult, StepResult } from './types';

export type StepExecutionState = Pick<DisplayResult, 'executionStatus' | 'executionMessage' | 'executionError'>;

/**
 * Public execution state for a step that produced no observation: the exact
 * scope was unavailable, an optional query failed, or the step's condition was
 * not met so its query never ran. Returns undefined for an executed step, whose
 * state (`observed` / `empty`) depends on the rows it returned.
 */
export function nonObservedStepState(stepResult: StepResult): StepExecutionState | undefined {
  switch (stepResult.code) {
    case 'exact_scope_unavailable':
      return { executionStatus: 'unavailable', executionMessage: stepResult.error };
    case 'optional_query_error':
      return { executionStatus: 'optional_error', executionError: stepResult.error };
    case 'condition_not_met':
      return { executionStatus: 'skipped', executionMessage: conditionSkippedMessage(stepResult.skippedCondition) };
    default:
      return undefined;
  }
}

function conditionSkippedMessage(condition: string | undefined): string {
  const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const text = condition?.trim() || '?';
  return localize(language,
    `该步骤未执行：条件不满足（${text}），查询没有运行，不代表数据为空。`,
    `Step skipped: its condition was not met (${text}); the query did not run, so this is not an empty result.`);
}
