// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'fs';

import {CodeGrader} from '../codeGrader';
import {
  ProcessGrader,
  type ProcessEvidence,
  type ProcessEvidenceProvider,
} from '../processGrader';
import {
  getDefaultScenariosDir,
  loadAllScenarios,
} from '../scenarioLoader';
import type {AgentResponse, TestScenario} from '../types';

function scenario(
  overrides: Partial<TestScenario> = {},
): TestScenario {
  return {
    id: 'scenario-a',
    description: 'Scenario A',
    category: 'general',
    priority: 'high',
    input: {
      traceFile: 'trace.pftrace',
      query: 'Analyze',
      mode: 'agent',
    },
    expectations: {
      code: {
        shouldSucceed: true,
      },
    },
    ...overrides,
  };
}

function response(
  overrides: Partial<AgentResponse> = {},
): AgentResponse {
  return {
    sessionId: 'session-a',
    success: true,
    answer: 'A'.repeat(120),
    executionTimeMs: 10,
    ...overrides,
  };
}

describe('shared self-evolution evaluator', () => {
  it('loads the repository scenario catalog after extraction from tests', async () => {
    expect(fs.existsSync(getDefaultScenariosDir())).toBe(true);
    const scenarios = await loadAllScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it('rejects executable legacy custom assertions without evaluating them', async () => {
    const mutationKey = '__smartperfetto_evaluator_injection_canary__';
    delete (globalThis as Record<string, unknown>)[mutationKey];
    const result = await new CodeGrader().grade(
      response(),
      scenario({
        expectations: {
          code: {
            shouldSucceed: true,
            customAssertions: [
              `globalThis.${mutationKey} = true`,
            ],
          },
        },
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.errors?.join('\n')).toContain(
      'executable expressions are disabled',
    );
    expect((globalThis as Record<string, unknown>)[mutationKey]).toBeUndefined();
  });

  it('grades only structured evidence supplied by an injected provider', async () => {
    const load = jest.fn<Promise<ProcessEvidence>, [string]>(async () => ({
      conversationSteps: [
        {
          eventId: 'event-1',
          ordinal: 1,
          phase: 'tool',
          role: 'agent',
          text: 'invoke_skill',
          timestamp: 1,
        },
      ],
      plan: {phases: [{id: 'p1'}]},
      planHistory: [],
      hypotheses: [],
      notes: [],
      uncertaintyFlags: [],
      errorCount: 0,
      toolCallCount: 1,
    }));
    const provider: ProcessEvidenceProvider = {
      load,
    };
    const result = await new ProcessGrader({
      evidenceProvider: provider,
    }).grade(response(), scenario());

    expect(load).toHaveBeenCalledWith('session-a');
    expect(result.passed).toBe(true);
  });
});
