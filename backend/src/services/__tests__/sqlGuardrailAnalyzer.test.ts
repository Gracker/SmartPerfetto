// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {
  analyzeSqlGuardrails,
  DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
  summarizeSqlGuardrailIssues,
} from '../sqlGuardrailAnalyzer';

describe('sqlGuardrailAnalyzer', () => {
  it('detects LIKE and summarizes by rule', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT *
      FROM process
      WHERE name LIKE '%systemui%'
        AND thread_name NOT LIKE '%binder%'
    `);

    expect(issues.filter(issue => issue.ruleId === 'prefer-glob-for-like')).toHaveLength(2);
    expect(summarizeSqlGuardrailIssues(issues)[0]).toContain('sql-guardrail prefer-glob-for-like');
  });

  it('detects raw duration aggregation without dur = -1 handling', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT SUM(ts.dur) AS blocked_ns, MAX(ts.ts + ts.dur) AS end_ts
      FROM thread_state ts
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-duration-boundary')).toBe(true);
  });

  it('detects nested raw duration aggregation without dur = -1 handling', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT SUM(CASE WHEN state = 'R' THEN dur ELSE 0 END) AS runnable_ns
      FROM thread_state
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-duration-boundary')).toBe(true);
  });

  it('accepts effective durations that handle open intervals', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT SUM(IIF(dur = -1, trace_end() - ts, dur)) AS blocked_ns
      FROM thread_state
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-duration-boundary')).toBe(false);
  });

  it('still detects raw duration usage when another CTE handles open intervals', () => {
    const issues = analyzeSqlGuardrails(`
      WITH safe_durations AS (
        SELECT ts, IIF(dur = -1, trace_end() - ts, dur) AS effective_dur
        FROM thread_state
      ),
      unsafe_durations AS (
        SELECT SUM(dur) AS blocked_ns
        FROM thread_state
      )
      SELECT * FROM unsafe_durations
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-duration-boundary')).toBe(true);
  });

  it('detects start-only interval filters', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT *
      FROM thread_state ts
      WHERE ts.ts >= \${start_ts}
        AND ts.ts < \${end_ts}
    `);

    expect(issues.some(issue => issue.ruleId === 'overlap-range-filter')).toBe(true);
  });

  it('detects exclusive start and BETWEEN interval filters', () => {
    const greaterThanIssues = analyzeSqlGuardrails(`
      SELECT *
      FROM thread_state ts
      WHERE ts.ts > \${start_ts}
        AND ts.ts < \${end_ts}
    `);
    const betweenIssues = analyzeSqlGuardrails(`
      SELECT *
      FROM thread_state ts
      WHERE ts.ts BETWEEN \${start_ts} AND \${end_ts}
    `);

    expect(greaterThanIssues.some(issue => issue.ruleId === 'overlap-range-filter')).toBe(true);
    expect(betweenIssues.some(issue => issue.ruleId === 'overlap-range-filter')).toBe(true);
  });

  it('accepts overlap interval filters with effective duration', () => {
    const issues = analyzeSqlGuardrails(`
      WITH normalized AS (
        SELECT ts, IIF(dur = -1, trace_end() - ts, dur) AS effective_dur
        FROM thread_state
      )
      SELECT *
      FROM normalized
      WHERE ts < \${end_ts}
        AND ts + effective_dur > \${start_ts}
    `);

    expect(issues.some(issue => issue.ruleId === 'overlap-range-filter')).toBe(false);
    expect(issues.some(issue => issue.ruleId === 'safe-duration-boundary')).toBe(false);
  });

  it('still detects start-only filters when another CTE uses overlap predicates', () => {
    const issues = analyzeSqlGuardrails(`
      WITH safe_ranges AS (
        SELECT *
        FROM thread_state ts
        WHERE ts.ts < \${end_ts}
          AND ts.ts + ts.dur > \${start_ts}
      ),
      unsafe_ranges AS (
        SELECT *
        FROM thread_state ts
        WHERE ts.ts >= \${start_ts}
          AND ts.ts < \${end_ts}
      )
      SELECT * FROM unsafe_ranges
    `);

    expect(issues.some(issue => issue.ruleId === 'overlap-range-filter')).toBe(true);
  });

  it('detects SPAN_JOIN without partitioning', () => {
    const issues = analyzeSqlGuardrails(`
      CREATE VIRTUAL TABLE joined
      USING SPAN_JOIN(a, b);
    `);

    expect(issues.filter(issue => issue.ruleId === 'span-join-safety').length).toBeGreaterThanOrEqual(1);
  });

  it('detects an unsafe SPAN_JOIN even when another SPAN_JOIN is partitioned', () => {
    const issues = analyzeSqlGuardrails(`
      DROP TABLE IF EXISTS good_join;
      CREATE VIRTUAL TABLE good_join
      USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED utid);

      CREATE VIRTUAL TABLE bad_join
      USING SPAN_JOIN(c, d);
    `);

    expect(issues.filter(issue => issue.ruleId === 'span-join-safety')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snippet: 'USING SPAN_JOIN(c, d);',
        }),
        expect.objectContaining({
          snippet: 'CREATE VIRTUAL TABLE bad_join',
        }),
      ]),
    );
  });

  it('detects SPAN_LEFT_JOIN setup issues', () => {
    const issues = analyzeSqlGuardrails(`
      CREATE VIRTUAL TABLE left_joined
      USING SPAN_LEFT_JOIN(a, b);
    `);

    expect(issues.filter(issue => issue.ruleId === 'span-join-safety').length).toBeGreaterThanOrEqual(1);
  });

  it('detects mismatched SPAN_JOIN partition keys', () => {
    const issues = analyzeSqlGuardrails(`
      DROP TABLE IF EXISTS joined;
      -- perfetto-span-join-non-overlap-proof: assertion inputs-are-disjoint
      CREATE VIRTUAL TABLE joined
      USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED upid);
    `);

    expect(issues.filter(issue => issue.ruleId === 'span-join-safety')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('same partition key'),
      }),
    ]);
  });

  it('requires an explicit non-overlap proof for an otherwise safe SPAN_JOIN setup', () => {
    const issues = analyzeSqlGuardrails(`
      DROP TABLE IF EXISTS joined;
      CREATE VIRTUAL TABLE joined
      USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED utid);
    `);

    expect(issues.filter(issue => issue.ruleId === 'span-join-non-overlap')).toEqual([
      expect.objectContaining({
        snippet: 'USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED utid);',
      }),
    ]);
  });

  it('accepts a non-empty adjacent SPAN_JOIN proof reference', () => {
    const issues = analyzeSqlGuardrails(`
      DROP TABLE IF EXISTS joined;
      -- perfetto-span-join-non-overlap-proof: fixture span-join-inputs-no-overlap
      CREATE VIRTUAL TABLE joined
      USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED utid);
    `);

    expect(issues.some(issue => issue.ruleId === 'span-join-non-overlap')).toBe(false);
  });

  it('does not treat empty, non-adjacent, or literal proof markers as evidence', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT 'perfetto-span-join-non-overlap-proof: literal' AS note;
      -- perfetto-span-join-non-overlap-proof:
      -- unrelated comment breaks adjacency
      DROP TABLE IF EXISTS joined;
      CREATE VIRTUAL TABLE joined
      USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED utid);
    `);

    expect(issues.some(issue => issue.ruleId === 'span-join-non-overlap')).toBe(true);
  });

  it('requires a proof reference for every SPAN_JOIN statement', () => {
    const issues = analyzeSqlGuardrails(`
      DROP TABLE IF EXISTS first_join;
      -- perfetto-span-join-non-overlap-proof: assertion first-inputs
      CREATE VIRTUAL TABLE first_join
      USING SPAN_JOIN(a PARTITIONED utid, b PARTITIONED utid);

      DROP TABLE IF EXISTS second_join;
      CREATE VIRTUAL TABLE second_join
      USING SPAN_JOIN(c PARTITIONED upid, d PARTITIONED upid);
    `);

    expect(issues.filter(issue => issue.ruleId === 'span-join-non-overlap')).toEqual([
      expect.objectContaining({
        snippet: 'USING SPAN_JOIN(c PARTITIONED upid, d PARTITIONED upid);',
      }),
    ]);
  });

  it('includes SPAN_JOIN non-overlap proof in default validation', () => {
    expect(DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES).toContain('span-join-non-overlap');
  });

  it('detects non-idempotent create statements but accepts IF NOT EXISTS', () => {
    const unsafe = analyzeSqlGuardrails('CREATE VIEW _gc_events AS SELECT * FROM slice;');
    const safe = analyzeSqlGuardrails('CREATE VIEW IF NOT EXISTS _gc_events AS SELECT * FROM slice;');
    const dropCreate = analyzeSqlGuardrails(`
      DROP VIEW IF EXISTS _gc_events;
      CREATE VIEW _gc_events AS SELECT * FROM slice;
    `);
    const dropPerfettoCreate = analyzeSqlGuardrails(`
      DROP PERFETTO VIEW IF EXISTS smartperfetto_jank_frames;
      CREATE PERFETTO VIEW smartperfetto_jank_frames AS SELECT * FROM slice;
    `);

    expect(unsafe.some(issue => issue.ruleId === 'idempotent-create')).toBe(true);
    expect(safe.some(issue => issue.ruleId === 'idempotent-create')).toBe(false);
    expect(dropCreate.some(issue => issue.ruleId === 'idempotent-create')).toBe(false);
    expect(dropPerfettoCreate.some(issue => issue.ruleId === 'idempotent-create')).toBe(false);
  });

  it('detects direct args table parsing without extract_arg', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT args.key, args.string_value
      FROM args
      WHERE args.key = 'debug.foo'
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-arg-extraction')).toBe(true);
  });

  it('detects direct args parsing even when another CTE uses extract_arg', () => {
    const issues = analyzeSqlGuardrails(`
      WITH safe_args AS (
        SELECT extract_arg(arg_set_id, 'debug.foo') AS foo
        FROM slice
      ),
      unsafe_args AS (
        SELECT key, string_value
        FROM args
        WHERE key = 'debug.bar'
      )
      SELECT * FROM unsafe_args
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-arg-extraction')).toBe(true);
  });

  it('accepts lowercase extract_arg usage', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT extract_arg(arg_set_id, 'debug.foo') AS foo
      FROM slice
    `);

    expect(issues.some(issue => issue.ruleId === 'safe-arg-extraction')).toBe(false);
  });

  it('respects same-line and previous-line ignore comments', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT *
      FROM process
      WHERE 1 = 1
        -- smartperfetto-guardrail-ignore prefer-glob-for-like
        AND name LIKE '%systemui%'
        AND thread_name LIKE '%RenderThread%' -- smartperfetto-guardrail-ignore prefer-glob-for-like
    `);

    expect(issues.some(issue => issue.ruleId === 'prefer-glob-for-like')).toBe(false);
  });

  it('does not treat string literals as ignore directives', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT *
      FROM process
      WHERE name LIKE '%systemui%'
        AND note = 'smartperfetto-guardrail-ignore prefer-glob-for-like'
    `);

    expect(issues.some(issue => issue.ruleId === 'prefer-glob-for-like')).toBe(true);
  });

  it('does not let unknown ignore rule names suppress warnings', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT *
      FROM process
      WHERE 1 = 1
        -- smartperfetto-guardrail-ignore prefer_glob_for_like
        AND name LIKE '%systemui%'
    `);

    expect(issues.some(issue => issue.ruleId === 'prefer-glob-for-like')).toBe(true);
  });

  it('keeps default validate integration low-noise', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT *
      FROM process
      WHERE name LIKE '%systemui%'
    `, {includeRules: DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES});

    expect(issues).toHaveLength(0);
  });

  it('rejects ratio-scale literals for Perfetto PERCENTILE arguments', () => {
    const issues = analyzeSqlGuardrails(`
      SELECT
        PERCENTILE(value, 0.95) AS wrong_p95,
        PERCENTILE(COALESCE(value, fallback_value), 0.5) AS wrong_median,
        PERCENTILE(value, 95) AS p95,
        PERCENTILE(value, 50) AS median
      FROM samples
    `);

    expect(issues.filter(
      issue => String(issue.ruleId) === 'percentile-percent-scale',
    )).toHaveLength(2);
    expect(DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES as readonly string[])
      .toContain('percentile-percent-scale');
  });

  it('ignores fractional percentile text in comments and SQL string literals', () => {
    const issues = analyzeSqlGuardrails(`
      -- PERCENTILE(value, 0.95) is intentionally shown as an invalid example.
      SELECT 'PERCENTILE(value, 0.5)' AS note,
        PERCENTILE(value, 95) AS p95
      FROM samples
    `);

    expect(issues.some(
      issue => String(issue.ruleId) === 'percentile-percent-scale',
    )).toBe(false);
  });
});
