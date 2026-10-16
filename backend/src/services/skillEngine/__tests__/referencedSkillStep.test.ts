// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {exposedStepResult, selectReferencedSkillStep, selectedStepResult} from '../referencedSkillStep';
import type {StepResult} from '../types';

const step = (stepId: string, data?: unknown): StepResult =>
  ({stepId, stepType: 'atomic', success: true, executionTimeMs: 0, ...(data === undefined ? {} : {data})}) as StepResult;

const skillResult = (steps: StepResult[], displayed: string[] = []) => ({
  skillId: 'child',
  success: true,
  rawResults: Object.fromEntries(steps.map(entry => [entry.stepId, entry])),
  displayResults: displayed.map(stepId => ({stepId})),
});

const pick = (value: unknown) => selectReferencedSkillStep(value)?.stepId;

describe('selectReferencedSkillStep', () => {
  it('takes the root step whenever its data is defined, even when empty or null', () => {
    const rows = step('rows', [{v: 1}]);
    expect(pick(skillResult([step('root', []), rows], ['rows']))).toBe('root');
    expect(pick(skillResult([step('root', null), rows], ['rows']))).toBe('root');
    expect(pick(skillResult([step('root'), rows], ['rows']))).toBe('rows');
  });

  it('prefers displayed steps in display order over raw step order', () => {
    const value = skillResult([step('setup', []), step('first', [{v: 1}]), step('second', [{v: 2}])],
      ['__synthesize_summary__', 'second', 'first']);
    expect(pick(value)).toBe('second');
  });

  it('never matches the generated synthesize summary to a raw step of the same id', () => {
    const value = skillResult([step('__synthesize_summary__', [{v: 0}]), step('ordinary', [{v: 1}])],
      ['__synthesize_summary__', 'ordinary']);
    expect(pick(value)).toBe('ordinary');
  });

  it('skips a displayed step without meaningful data', () => {
    const value = skillResult([step('setup', [{v: 0}]), step('shown', [])], ['shown']);
    expect(pick(value)).toBe('setup');
  });

  it('counts 0 and false as meaningful but not empty strings, rows or objects', () => {
    // The meaningful step comes first, so the last-step fallback cannot pick it by accident.
    expect(pick(skillResult([step('zero', 0), step('blank', '  ')]))).toBe('zero');
    expect(pick(skillResult([step('no', false), step('emptyRows', {rows: []})]))).toBe('no');
    expect(pick(skillResult([step('emptyObject', {}), step('emptyDiagnostics', {diagnostics: []}),
      step('one', {diagnostics: [{}]})]))).toBe('one');
  });

  // A Skill result always carries `diagnostics`, so a nested reference step is
  // meaningful only when its grandchild produced diagnostics, never merely as a
  // non-empty object: a setup reference cannot outrank the real read step.
  it('judges a nested Skill result by its diagnostics, not as a non-empty object', () => {
    const nested = (diagnostics: unknown[]) => ({...step('setup'), stepType: 'skill',
      data: {skillId: 'grandchild', success: true, diagnostics, displayResults: [], rawResults: {x: step('x', [{v: 1}])}}});
    expect(pick(skillResult([nested([]) as StepResult, step('read', [{v: 2}])]))).toBe('read');
    expect(pick(skillResult([nested([]) as StepResult, step('read', [])]))).toBe('read');
    expect(pick(skillResult([nested([{diagnosis: 'x'}]) as StepResult, step('read', [{v: 2}])]))).toBe('setup');
  });

  it('falls back to the last step holding data when none is meaningful', () => {
    expect(pick(skillResult([step('a', []), step('noData'), step('b', [])]))).toBe('b');
  });

  it('selects nothing without a step holding data or without rawResults', () => {
    expect(pick(skillResult([step('noData')]))).toBeUndefined();
    expect(pick({skillId: 'child', success: false, error: 'failed early'})).toBeUndefined();
    expect(pick([{v: 1}])).toBeUndefined();
    expect(pick(null)).toBeUndefined();
  });
});

describe('selectedStepResult', () => {
  it('returns a non-reference step unchanged', () => {
    const atomic = step('rows', [{v: 1}]);
    expect(selectedStepResult(atomic)).toBe(atomic);
  });

  it('returns the exposed child step of a Skill reference, else the reference itself', () => {
    const rows = step('rows', [{v: 1}]);
    const reference = {...step('ref'), stepType: 'skill', data: skillResult([step('setup', []), rows], ['rows'])};
    expect(selectedStepResult(reference as StepResult)).toBe(rows);
    const skipped = {...step('ref', []), stepType: 'skill', code: 'condition_not_met'};
    expect(selectedStepResult(skipped as StepResult)).toBe(skipped);
  });
});

describe('exposedStepResult', () => {
  it('exposes nothing for a failed Skill reference, even with partial child rows', () => {
    const partial = {...step('ref'), stepType: 'skill', success: false,
      data: skillResult([step('rows', [{v: 1}])], ['rows'])};
    expect(exposedStepResult(partial as StepResult)).toBeUndefined();
  });

  it('exposes a failed non-reference step itself and a successful reference its selected step', () => {
    const failedAtomic = {...step('q', []), success: false};
    expect(exposedStepResult(failedAtomic as StepResult)).toBe(failedAtomic);
    const rows = step('rows', [{v: 1}]);
    const reference = {...step('ref'), stepType: 'skill', data: skillResult([step('setup', []), rows], ['rows'])};
    expect(exposedStepResult(reference as StepResult)).toBe(rows);
  });
});
