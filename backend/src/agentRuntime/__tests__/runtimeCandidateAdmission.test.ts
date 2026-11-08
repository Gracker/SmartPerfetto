// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  isRuntimeCandidateAdmitted,
  parseAdmittedRuntimeCandidates,
  RUNTIME_CANDIDATE_IDS,
  SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV,
} from '../runtimeCandidateAdmission';

describe('runtime candidate admission', () => {
  it.each([
    undefined,
    '',
    ' ',
    'task4, task5',
    'task4,',
    ',task4',
    'task4,task4',
    'task4,unknown',
    // The OpenCode/Qoder candidates were retired with their engines.
    'task5,task8',
    'task9',
    'TASK4',
  ])('fails the complete value closed for invalid input: %p', raw => {
    const env = raw === undefined ? {} : {
      [SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV]: raw,
    };
    expect([...parseAdmittedRuntimeCandidates(env)]).toEqual([]);
    expect(RUNTIME_CANDIDATE_IDS.every(candidate => !isRuntimeCandidateAdmitted(candidate, env)))
      .toBe(true);
  });

  it('admits only exact candidate IDs from one valid maintainer value', () => {
    const env = {
      [SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV]: 'task4,task6,task7',
    };
    expect([...parseAdmittedRuntimeCandidates(env)]).toEqual(['task4', 'task6', 'task7']);
    expect(isRuntimeCandidateAdmitted('task4', env)).toBe(true);
    expect(isRuntimeCandidateAdmitted('task5', env)).toBe(false);
    expect(isRuntimeCandidateAdmitted('task7', env)).toBe(true);
  });
});
