// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveTraceCase} from '../../../../utils/traceCorpus';
import {EvaluationRunner} from '../../../../../tests/agent-eval/evaluationRunner';
import {loadAllScenarios} from '../../../../../tests/agent-eval/scenarioLoader';
import {CodeGrader} from '../codeGrader';
import type {AgentResponse, TestScenario} from '../types';

const response: AgentResponse = {
  sessionId: 'session-a',
  success: true,
  answer: 'A long answer that contains no verified golden contract.'.repeat(4),
  confidence: 0.99,
  executionTimeMs: 1,
};

function scenario(
  overrides: Partial<TestScenario> = {},
): TestScenario {
  return {
    id: 'legacy-case',
    description: 'Legacy fail-closed case.',
    category: 'general',
    priority: 'high',
    input: {
      traceFile: 'general-runtime-contracts',
      query: 'Analyze.',
      mode: 'agent',
    },
    expectations: {
      code: {shouldSucceed: true},
    },
    ...overrides,
  };
}

describe('legacy agent evaluation fail-closed boundary', () => {
  it('does not pass code grading without ground truth', async () => {
    await expect(new CodeGrader().grade(response, scenario()))
      .resolves.toMatchObject({passed: false, score: 0});
  });

  it('cannot average away a failing ground-truth assertion', async () => {
    await expect(new CodeGrader().grade(response, scenario({
      expectations: {
        code: {
          shouldSucceed: true,
          minConfidence: 0.5,
          maxExecutionTimeMs: 10,
          requiredFields: ['answer'],
        },
        groundTruth: {
          summary: 'A verified conclusion that is absent.',
          keyFacts: ['A required fact that is absent.'],
        },
      },
    }))).resolves.toMatchObject({passed: false});
  });

  it('does not pass aggregation when no grader ran', () => {
    const runner = new EvaluationRunner() as unknown as {
      aggregateGrades: (grades: []) => {score: number; passed: boolean};
    };
    expect(runner.aggregateGrades([])).toEqual({score: 0, passed: false});
  });

  it('keeps every retained legacy scenario on a resolvable catalog selector', async () => {
    const scenarios = await loadAllScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    for (const item of scenarios) {
      expect(() => resolveTraceCase(item.input.traceFile)).not.toThrow();
    }
  });
});
