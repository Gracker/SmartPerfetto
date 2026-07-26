// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import { generateAiComparisonConclusion } from '../comparisonAiConclusionService';
import { buildDeterministicComparisonResult } from '../comparisonResultService';

function snapshot(
  id: string,
  values: {
    startupMs: number;
    fps: number;
    jankRate: number;
  },
): AnalysisResultSnapshot {
  return {
    id,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: `trace-${id}`,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    createdBy: 'user-a',
    visibility: 'workspace',
    sceneType: 'startup',
    title: id,
    userQuery: 'analyze',
    traceLabel: id,
    traceMetadata: {},
    summary: { headline: 'ok' },
    metrics: [
      {
        key: 'startup.total_ms',
        label: 'Startup total duration',
        group: 'startup',
        value: values.startupMs,
        unit: 'ms',
        direction: 'lower_is_better',
        aggregation: 'single',
        confidence: 0.9,
        source: { type: 'skill' },
      },
      {
        key: 'scrolling.avg_fps',
        label: 'Average FPS',
        group: 'fps',
        value: values.fps,
        unit: 'fps',
        direction: 'higher_is_better',
        aggregation: 'avg',
        confidence: 0.9,
        source: { type: 'skill' },
      },
      {
        key: 'scrolling.jank_rate_pct',
        label: 'Jank rate',
        group: 'jank',
        value: values.jankRate,
        unit: '%',
        direction: 'lower_is_better',
        aggregation: 'avg',
        confidence: 0.9,
        source: { type: 'skill' },
      },
    ],
    evidenceRefs: [],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
  };
}

function comparisonResult() {
  return buildDeterministicComparisonResult(
    [
      snapshot('baseline', { startupMs: 1200, fps: 55, jankRate: 8 }),
      snapshot('candidate', { startupMs: 900, fps: 60, jankRate: 3 }),
    ],
    {
      baselineSnapshotId: 'baseline',
      metricKeys: [
        'startup.total_ms',
        'scrolling.avg_fps',
        'scrolling.jank_rate_pct',
      ],
    },
  );
}

describe('generateAiComparisonConclusion', () => {
  test('parses AI conclusion JSON from an injected client', async () => {
    const prompts: string[] = [];
    const conclusion = await generateAiComparisonConclusion({
      result: comparisonResult(),
      query: 'compare startup and smoothness',
      client: {
        async complete(input) {
          prompts.push(input.prompt);
          return {
            model: 'mock-light-model',
            text: JSON.stringify({
              verifiedFacts: ['Candidate startup is 300 ms faster than baseline.'],
              inferences: ['Candidate is likely better for the tested startup path.'],
              recommendations: ['Inspect the startup changes that reduced total duration.'],
              uncertainty: ['Only normalized snapshot metrics were compared.'],
            }),
          };
        },
      },
    });

    expect(prompts[0]).toContain('compare startup and smoothness');
    expect(prompts[0]).toContain('"startup.total_ms"');
    expect(conclusion).toMatchObject({
      source: 'ai',
      model: 'mock-light-model',
      verifiedFacts: ['Candidate startup is 300 ms faster than baseline.'],
      inferences: ['Candidate is likely better for the tested startup path.'],
      recommendations: ['Inspect the startup changes that reduced total duration.'],
    });
    expect(conclusion.uncertainty).toContain('Only normalized snapshot metrics were compared.');
  });

  test('falls back to deterministic conclusion when AI output is not parseable', async () => {
    const result = comparisonResult();
    const conclusion = await generateAiComparisonConclusion({
      result,
      query: 'compare startup',
      client: {
        async complete() {
          return { text: 'not json' };
        },
      },
    });

    expect(conclusion.source).toBe('deterministic');
    expect(conclusion.verifiedFacts).toEqual(result.conclusion.verifiedFacts);
    expect(conclusion.uncertainty).toContain(
      'AI comparison conclusion was not generated: AI response did not contain valid conclusion JSON',
    );
  });

  test('uses max_completion_tokens for a GPT-5.6 Chat Completions provider', async () => {
    const envKeys = [
      'SMARTPERFETTO_AGENT_RUNTIME',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'OPENAI_LIGHT_MODEL',
      'OPENAI_AGENTS_PROTOCOL',
    ] as const;
    const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> = {};

    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.OPENAI_MODEL = 'gpt-5.6-sol';
    process.env.OPENAI_LIGHT_MODEL = 'openai/gpt-5.6-sol';
    process.env.OPENAI_AGENTS_PROTOCOL = 'chat_completions';
    globalThis.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              verifiedFacts: ['Candidate startup is faster.'],
              inferences: [],
              recommendations: [],
              uncertainty: [],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const conclusion = await generateAiComparisonConclusion({
        result: comparisonResult(),
        query: 'compare startup',
        providerId: null,
      });

      expect(conclusion.source).toBe('ai');
      expect(requestBody.max_completion_tokens).toBe(1200);
      expect(requestBody).not.toHaveProperty('max_tokens');
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        const originalValue = originalEnv.get(key);
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }
  });
});
