// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import path from 'path';

import {
  assertExpectationRows,
  loadCorpus,
  resolveParameterTokens,
  runCorpusRegression,
  sqlResultState,
} from './corpusRunner';

const repoRoot = path.resolve(__dirname, '../../..');

describe('Trace corpus regression runner', () => {
  it('loads the generated catalog and exact current coverage inventory', () => {
    const corpus = loadCorpus(repoRoot);

    expect(corpus.cases).toHaveLength(18);
    expect(corpus.coverage.missing).toEqual({skills: [], strategies: []});
    expect(corpus.coverage.covered.skills.length).toBeGreaterThan(200);
    expect(corpus.coverage.covered.strategies.length).toBeGreaterThan(20);
  });

  it('requires declared value-level semantic evidence', () => {
    expect(() => assertExpectationRows(
      [{kernel: 'SyntheticComputeKernelA(float*)', dur_ns: 12_000_000}],
      {
        target: 'gpu_compute_kernel_analysis',
        semantic_step: 'kernel_summary',
        min_rows: 1,
        assertions: [
          {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
          {column: 'dur_ns', operator: 'gte', value: 12_000_000},
        ],
      },
    )).not.toThrow();
    expect(() => assertExpectationRows(
      [
        {kernel: 'SyntheticComputeKernelA(float*)', dur_ns: 1},
        {kernel: 'wrong', dur_ns: 12_000_000},
      ],
      {
        target: 'gpu_compute_kernel_analysis',
        semantic_step: 'kernel_summary',
        assertions: [
          {column: 'kernel', operator: 'contains', value: 'SyntheticComputeKernelA'},
          {column: 'dur_ns', operator: 'gte', value: 12_000_000},
        ],
      },
    )).toThrow('no single result row satisfies');
  });

  it('requires every declared source-level result column to be present', () => {
    expect(() => assertExpectationRows(
      [{frame_id: 1, dur_ns: 20_000_000}],
      {
        target: 'smartperfetto.scrolling.jank_frames',
        semantic_step: 'canonical_view',
        required_columns: ['frame_id', 'dur_ns'],
      },
    )).not.toThrow();
    expect(() => assertExpectationRows(
      [{frame_id: 1}],
      {
        target: 'smartperfetto.scrolling.jank_frames',
        semantic_step: 'canonical_view',
        required_columns: ['frame_id', 'dur_ns'],
      },
    )).toThrow('missing required columns');
  });

  it('resolves trace and fixture identity tokens without changing literals', () => {
    expect(resolveParameterTokens(
      {
        start_ts: '${trace_start}',
        end_ts: '${trace_end}',
        fixture_start: '${fixture_start}',
        fixture_end: '${fixture_end}',
        upid: '${fixture_upid}',
        utid: '${fixture_utid}',
        package: 'com.smartperfetto.fixture',
      },
      {
        trace_start: '10',
        trace_end: '20',
        fixture_start: '12',
        fixture_end: '18',
        fixture_upid: 30,
        fixture_utid: 40,
      },
    )).toEqual({
      start_ts: '10',
      end_ts: '20',
      fixture_start: '12',
      fixture_end: '18',
      upid: 30,
      utid: 40,
      package: 'com.smartperfetto.fixture',
    });
  });

  it('does not treat skipped or optional-error SQL as executed', () => {
    expect(sqlResultState({success: true, code: 'condition_not_met'})).toBe('condition_skipped');
    expect(sqlResultState({
      success: true,
      code: 'optional_query_error',
      error: 'no such table: optional_table',
    })).toBe('failed');
    expect(sqlResultState({success: true})).toBe('executed');
  });

  it('executes startup_analysis and startup Strategy against the constructed startup case', async () => {
    const result = await runCorpusRegression(repoRoot, {
      caseIds: ['startup-lifecycle'],
      targetIds: ['startup_analysis', 'startup'],
      writeEvidence: false,
    });

    expect(result.failures).toEqual([]);
    expect(result.executed).toEqual(expect.arrayContaining([
      'startup-lifecycle:skill:startup_analysis',
      'startup-lifecycle:strategy:startup',
    ]));
  }, 120_000);

  it('executes the exact canonical SQL source against a real trace', async () => {
    const result = await runCorpusRegression(repoRoot, {
      caseIds: ['android-scroll-customer'],
      targetIds: ['smartperfetto.scrolling.jank_frames'],
      writeEvidence: false,
    });

    expect(result.failures).toEqual([]);
    expect(result.executed).toContain(
      'android-scroll-customer:sql:smartperfetto.scrolling.jank_frames',
    );
    expect(result.correctness.positive).toContain(
      'android-scroll-customer:sql:smartperfetto.scrolling.jank_frames',
    );
  }, 120_000);
});
