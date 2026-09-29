// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import { renderComparisonHtmlReport } from '../comparisonHtmlReportService';
import { buildDeterministicComparisonResult } from '../comparisonResultService';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

function snapshot(id: string, startupMs: number): AnalysisResultSnapshot {
  return {
    id,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: `trace-${id}`,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    createdBy: 'user-a',
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'startup',
    title: `${id}<script>`,
    userQuery: 'analyze',
    traceLabel: id,
    traceMetadata: {},
    summary: { headline: 'ok' },
    metrics: [{
      key: 'startup.total_ms',
      label: 'Startup total duration',
      group: 'startup',
      value: startupMs,
      unit: 'ms',
      direction: 'lower_is_better',
      aggregation: 'single',
      confidence: 0.9,
      source: { type: 'skill' },
    }],
    evidenceRefs: [],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
  };
}

describe('renderComparisonHtmlReport', () => {
  test('renders escaped snapshot labels and delta matrix', () => {
    const result = buildDeterministicComparisonResult(
      [
        snapshot('baseline', 1200),
        snapshot('candidate', 900),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: ['startup.total_ms'],
      },
    );
    result.conclusion = {
      source: 'ai',
      verifiedFacts: ['Candidate is 300 ms faster.'],
      inferences: [],
      recommendations: [],
      uncertainty: [],
    };

    const html = renderComparisonHtmlReport({
      comparisonId: 'comparison-a',
      query: 'compare <startup>',
      result,
    });

    expect(html).toContain('data-comparison-id="comparison-a"');
    expect(html).toContain('compare &lt;startup&gt;');
    expect(html).toContain('baseline&lt;script&gt;');
    expect(html).toContain('Startup total duration');
    expect(html).toContain('<details class="metric-group" open>');
    expect(html).toContain('<span>startup</span>');
    expect(html).toContain('-300');
    expect(html).toContain('Candidate is 300 ms faster.');
    expect(html).toContain('System investigation coverage: Not checked');
    expect(html).not.toContain('<script>');
  });

  test('renders more than one candidate column pair', () => {
    const result = buildDeterministicComparisonResult(
      [
        snapshot('baseline', 1200),
        snapshot('candidate-fast', 900),
        snapshot('candidate-slow', 1500),
      ],
      {
        baselineSnapshotId: 'baseline',
        metricKeys: ['startup.total_ms'],
      },
    );

    const html = renderComparisonHtmlReport({
      comparisonId: 'comparison-n',
      query: 'compare three startups',
      result,
    });

    expect(html).toContain('candidate-fast&lt;script&gt;');
    expect(html).toContain('candidate-slow&lt;script&gt;');
    expect(html).toContain('-300');
    expect(html).toContain('+300');
    expect((html.match(/<th>Delta<\/th>/g) || []).length).toBe(2);
  });
});
