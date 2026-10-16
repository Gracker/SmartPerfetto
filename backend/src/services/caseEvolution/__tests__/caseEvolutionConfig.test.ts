// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  caseEvolutionStartupWarnings,
  isCaseBackgroundInjectionEnabled,
  loadCaseEvolutionConfig,
} from '../caseEvolutionConfig';

describe('loadCaseEvolutionConfig', () => {
  it('reads only retrieval and background injection, both off by default', () => {
    expect(loadCaseEvolutionConfig({})).toEqual({
      retrieveEnabled: false,
      promptInjectEnabled: false,
    });
    expect(loadCaseEvolutionConfig({
      CASE_EVOLUTION_RETRIEVE_ENABLED: 'yes',
      CASE_EVOLUTION_PROMPT_INJECT_ENABLED: 'TRUE',
    })).toEqual({retrieveEnabled: true, promptInjectEnabled: true});
  });

  it('injects background only when retrieval is on too', () => {
    expect(isCaseBackgroundInjectionEnabled(loadCaseEvolutionConfig({
      CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
    }))).toBe(false);
    expect(isCaseBackgroundInjectionEnabled(loadCaseEvolutionConfig({
      CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
      CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1',
    }))).toBe(true);
  });
});

describe('caseEvolutionStartupWarnings', () => {
  it('names each retired learned-case setting that is still set, whatever its value', () => {
    expect(caseEvolutionStartupWarnings({
      CASE_EVOLUTION_CAPTURE_ENABLED: '1',
      CASE_EVOLUTION_WORKER_CONCURRENCY: 'not-a-number',
      CASE_EVOLUTION_DAILY_BUDGET: '',
      CASE_EVOLUTION_RETRIEVE_ENABLED: '1',
    })).toEqual([
      'CASE_EVOLUTION_CAPTURE_ENABLED is ignored: learned cases are retired',
      'CASE_EVOLUTION_WORKER_CONCURRENCY is ignored: learned cases are retired',
    ]);
    expect(caseEvolutionStartupWarnings({})).toEqual([]);
  });

  it('says that injection without retrieval stays off', () => {
    expect(caseEvolutionStartupWarnings({CASE_EVOLUTION_PROMPT_INJECT_ENABLED: '1'})).toEqual([
      'CASE_EVOLUTION_PROMPT_INJECT_ENABLED requires CASE_EVOLUTION_RETRIEVE_ENABLED; case background injection stays off',
    ]);
  });
});
