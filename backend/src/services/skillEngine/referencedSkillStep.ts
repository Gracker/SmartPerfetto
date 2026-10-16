// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { StepResult } from './types';

export function hasMeaningfulData(value: any): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return true;
  if (typeof value === 'object') {
    if (Array.isArray((value as any).rows)) return (value as any).rows.length > 0;
    if (Array.isArray((value as any).diagnostics)) return (value as any).diagnostics.length > 0;
    return Object.keys(value).length > 0;
  }
  return false;
}

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
/** The step id of the display entry a Skill generates from its synthesize data. */
export const SYNTHESIZE_SUMMARY_STEP_ID = '__synthesize_summary__';

/**
 * The one child step a referenced Skill's result exposes to its parent, the
 * same for a default `save_as`, a read by step id, `.data` unwrapping and
 * layered display: the root step, else the first displayed step with
 * meaningful data, else the first step with meaningful data, else the last
 * step holding data. Step-based child Skills often begin with DDL/setup steps
 * that correctly return [], so the read step wins over a setup step's empty
 * result. Undefined for anything that is not a Skill result with rawResults.
 */
export function selectReferencedSkillStep(skillResult: unknown): StepResult | undefined {
  const {rawResults, displayResults} = (skillResult ?? {}) as {rawResults?: unknown; displayResults?: unknown};
  if (!rawResults || typeof rawResults !== 'object') return undefined;
  const steps = rawResults as Record<string, any>;
  const holdsData = (step: any) => step && typeof step === 'object' && hasOwn(step, 'data');

  if (steps.root?.data !== undefined) return steps.root;
  for (const displayResult of Array.isArray(displayResults) ? displayResults : []) {
    const stepId = displayResult?.stepId;
    // The generated synthesize summary shares no data with a step that happens to use its id.
    const displayedStep = typeof stepId === 'string' && stepId !== SYNTHESIZE_SUMMARY_STEP_ID ? steps[stepId] : undefined;
    if (holdsData(displayedStep) && hasMeaningfulData(displayedStep.data)) return displayedStep;
  }
  const dataSteps = Object.values(steps).filter(holdsData);
  return dataSteps.find((step) => hasMeaningfulData(step.data)) ?? dataSteps[dataSteps.length - 1];
}

/** A step's own result, or for a Skill reference the child step it exposes. */
export function selectedStepResult(stepResult: StepResult): StepResult {
  if (stepResult.stepType !== 'skill') return stepResult;
  return selectReferencedSkillStep(stepResult.data) ?? stepResult;
}

/**
 * What a read of a step by its id sees: the step a default `save_as` of it
 * would bind. A failed Skill reference binds no save_as, so it exposes no
 * step, not even the partial rows its child returned before failing.
 */
export function exposedStepResult(stepResult: StepResult): StepResult | undefined {
  return stepResult.stepType === 'skill' && !stepResult.success ? undefined : selectedStepResult(stepResult);
}
