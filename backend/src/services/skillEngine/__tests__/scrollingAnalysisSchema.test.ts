// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, it, expect} from '@jest/globals';
import {androidInputEventsTableDdl, completeAndroidInputEventsFixture} from '../../../../tests/helpers/androidInputEventsFixture';
import {renderStepSql, withStepFragments} from '../../../../tests/helpers/skillFragmentSql';
import {diagnoseRuleStep} from '../../../../tests/helpers/skillRuleHarness';
import {builtInSkillFragment} from '../skillFragments';
import {absentPlaceholderSql, substituteSqlPlaceholders} from '../sqlTemplate';
import {SCROLLING_V1_REASON_CODES} from '../../caseDomainPacks';

// Execute maintained SQL fragments in the legacy named fixtures as well.
// fragments/system_cpu_big_freq_coverage.sql: a ramp over the P6 threshold, and
// every evidence state under which it must not name freq_ramp_slow.
const SLOW_RAMP = {ramp_to_high_ms: 5, top_slice_offset_ms: 1};
const UNOBSERVED_RAMP_EVIDENCE = ['big_core_topology_unknown', 'big_core_freq_incomplete', 'machine_scope_ambiguous', null];

function createScopedSqlFixture(): Database.Database {
  const db = new Database(':memory:');
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    let rendered = sql.split('${__process_scope.upid}').join('NULL');
    if (/\b(?:FROM|JOIN)\s+effective_target_processes\b/.test(rendered) &&
        !/effective_target_processes\s+AS\s*\(/i.test(rendered)) {
      const fragment = fs.readFileSync(path.join(process.cwd(), 'skills/fragments/effective_target_processes.sql'), 'utf8')
        .split('${__process_scope.upid}').join('NULL');
      rendered = rendered.replace(/\bWITH\s+/i, `WITH ${fragment}\n,\n`);
    }
    return prepare(rendered);
  }) as typeof db.prepare;
  return db;
}

describe('scrolling_analysis skill schema', () => {
  const skillPath = path.join(process.cwd(), 'skills', 'composite', 'scrolling_analysis.skill.yaml');
  const skill = yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
  const jankSkillPath = path.join(process.cwd(), 'skills', 'composite', 'jank_frame_detail.skill.yaml');
  const jankSkill = yaml.load(fs.readFileSync(jankSkillPath, 'utf-8')) as any;
  const consumerJankSkillPath = path.join(
    process.cwd(),
    'skills',
    'atomic',
    'consumer_jank_detection.skill.yaml',
  );
  const consumerJankSkill = yaml.load(
    fs.readFileSync(consumerJankSkillPath, 'utf-8'),
  ) as any;
  const flutterSkillPath = path.join(
    process.cwd(),
    'skills',
    'composite',
    'flutter_scrolling_analysis.skill.yaml',
  );
  const flutterSkill = yaml.load(fs.readFileSync(flutterSkillPath, 'utf-8')) as any;
  const scrollingStrategy = fs.readFileSync(
    path.join(process.cwd(), 'strategies', 'scrolling.strategy.md'),
    'utf-8',
  );

  const getStep = (id: string) => {
    const step = skill.steps?.find((s: any) => s.id === id);
    expect(step).toBeDefined();
    return step;
  };

  const getColumn = (step: any, name: string) => {
    const column = step.display?.columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  const getSkillStep = (definition: any, id: string) => {
    const step = definition.steps?.find((candidate: any) => candidate.id === id);
    expect(step).toBeDefined();
    return step;
  };

  const renderScrollingSql = (stepId: string, packageName = 'com.example.app') =>
    withStepFragments(String(getStep(stepId).sql), getStep(stepId).sql_fragments)
      .split('${package}').join(packageName)
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL')
      .split('${input_handling_budget_ratio|0.5}').join('0.5')
      .split('${input_event_backlog_threshold|3}').join('3');

  const extractMarkedCtes = (sql: string, beginMarker: string, endMarker: string) => {
    const start = sql.indexOf(beginMarker);
    const end = sql.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return sql
      .slice(start + beginMarker.length, end)
      .trim()
      .replace(/,\s*$/, '');
  };

  const createConsumerJankFixture = () => {
    const db = createScopedSqlFixture();
    db.function('android_is_app_jank_type', (value: unknown) =>
      /App Deadline Missed|App Resynced Jitter/.test(String(value)) ? 1 : 0);
    db.function('android_is_sf_jank_type', (value: unknown) =>
      /SurfaceFlinger|Prediction Error|Display HAL/.test(String(value)) ? 1 : 0);
    db.function('android_is_missed_frame_type', (value: unknown) =>
      /App Deadline Missed|App Resynced Jitter|SurfaceFlinger/.test(String(value)) ? 1 : 0);
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE actual_frame_timeline_slice(
        upid INTEGER,
        display_frame_token INTEGER,
        surface_frame_token INTEGER,
        layer_name TEXT,
        ts INTEGER,
        dur INTEGER,
        jank_type TEXT,
        present_type TEXT
      );
      INSERT INTO process VALUES (1, 'com.example.app');
      INSERT INTO actual_frame_timeline_slice VALUES
        (1, 1, 101, 'TX - com.example.app/Main#1',        0, 1000000, 'None',                'On-time Present'),
        (1, 2, 102, 'TX - com.example.app/Main#1', 16666667, 1000000, 'None',                'On-time Present'),
        (1, 3, 103, 'TX - com.example.app/Main#1', 25000000, 1000000, 'None',                'Late Present'),
        (1, 4, 104, 'TX - com.example.app/Main#1', 33333333, 1000000, 'Buffer Stuffing',     'Late Present'),
        (1, 5, 105, 'TX - com.example.app/Main#1', 50000000, 1000000, 'Buffer Stuffing',     'Late Present'),
        (1, 6, 106, 'TX - com.example.app/Main#1', 58333333, 1000000, 'App Deadline Missed', 'Late Present');
    `);
    return db;
  };

  const renderAtomicConsumerCtes = (stepId: string, beginMarker: string, endMarker: string) =>
    extractMarkedCtes(
      String(getSkillStep(consumerJankSkill, stepId).sql),
      beginMarker,
      endMarker,
    )
      .split('${package}').join('com.example.app')
      .split('${layer_name}').join('')
      .split('${start_ts}').join('')
      .split('${end_ts}').join('');

  it('get_app_jank_frames has display: false (hidden, data-only step)', () => {
    const step = getStep('get_app_jank_frames');
    expect(step.display).toBe(false);
    // synthesize and save_as must remain for downstream Agent references
    expect(step.synthesize).toBeDefined();
    expect(step.save_as).toBe('app_jank_frames');
  });

  it('batch_frame_root_cause has duration_ms fields correctly typed', () => {
    const step = getStep('batch_frame_root_cause');

    const durMs = getColumn(step, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');

    const topSliceMs = getColumn(step, 'top_slice_ms');
    expect(topSliceMs.type).toBe('duration');
    expect(topSliceMs.format).toBe('duration_ms');

    const presentInterval = getColumn(step, 'present_interval_ms');
    expect(presentInterval.type).toBe('duration');
    expect(presentInterval.format).toBe('duration_ms');
    expect(presentInterval.unit).toBe('ms');
  });

  it('keeps ns-based frame durations explicitly normalized to ms display', () => {
    const perfSummary = getStep('performance_summary');
    const avgFrameDur = getColumn(perfSummary, 'avg_frame_dur');
    const p95FrameDur = getColumn(perfSummary, 'p95_frame_dur');

    expect(avgFrameDur.type).toBe('duration');
    expect(avgFrameDur.format).toBe('duration_ms');
    expect(avgFrameDur.unit).toBe('ns');

    expect(p95FrameDur.type).toBe('duration');
    expect(p95FrameDur.format).toBe('duration_ms');
    expect(p95FrameDur.unit).toBe('ns');

    const sessionStep = getStep('scroll_sessions');
    const duration = getColumn(sessionStep, 'duration');
    const avgDur = getColumn(sessionStep, 'avg_dur');
    const maxDur = getColumn(sessionStep, 'max_dur');

    expect(duration.type).toBe('duration');
    expect(duration.format).toBe('duration_ms');
    expect(duration.unit).toBe('ns');

    expect(avgDur.type).toBe('duration');
    expect(avgDur.format).toBe('duration_ms');
    expect(avgDur.unit).toBe('ns');

    expect(maxDur.type).toBe('duration');
    expect(maxDur.format).toBe('duration_ms');
    expect(maxDur.unit).toBe('ns');
  });

  it('keeps timestamp-range binding for batch_frame_root_cause navigation', () => {
    const step = getStep('batch_frame_root_cause');
    const startTs = getColumn(step, 'start_ts');
    const dur = getColumn(step, 'dur');

    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur');

    expect(dur.type).toBe('duration');
    expect(dur.unit).toBe('ns');
    expect(dur.hidden).toBe(true);
  });

  it('batch_frame_root_cause has expandable self-binding', () => {
    const step = getStep('batch_frame_root_cause');
    expect(step.display.expandable).toBe(true);
    expect(step.display.expandableBindSource).toBe('batch_root_cause');
    expect(step.display.layer).toBe('list');
    expect(step.display.title).toBe('掉帧列表');
  });

  it('batch_frame_root_cause has synthesize with groupBy', () => {
    const step = getStep('batch_frame_root_cause');
    expect(step.synthesize).toBeDefined();
    expect(step.synthesize.role).toBe('list');
    const fields = step.synthesize.groupBy.map((g: any) => g.field);
    expect(fields).toContain('jank_responsibility');
    expect(fields).toContain('reason_code');
  });

  it('keeps the per-session sample cap in one shared fragment so the two steps cannot drift', () => {
    // get_app_jank_frames truncates the frame list; batch_frame_root_cause
    // reports eligible/analyzed coverage for that same truncation. If either
    // re-inlines its own cap expression, reported coverage stops describing
    // the rows that were actually analyzed.
    const rawSkill = fs.readFileSync(skillPath, 'utf-8');
    expect(rawSkill).not.toMatch(/WHEN CAST\(\$\{max_frames_per_session\} AS INTEGER\) <= 0/);

    for (const stepId of ['get_app_jank_frames', 'batch_frame_root_cause']) {
      const step = getStep(stepId);
      expect(step.sql_fragments).toContain('fragments/root_cause_sample_cap.sql');
      expect(String(step.sql)).toContain('root_cause_sample_limit_per_session FROM root_cause_sample_config');
    }

    const fragment = fs.readFileSync(
      path.join(process.cwd(), 'skills', 'fragments', 'root_cause_sample_cap.sql'),
      'utf-8',
    );
    const db = createScopedSqlFixture();
    try {
      for (const [literal, expected] of [['NULL', 200], ['0', 200], ['-5', 200], ['1', 1], ['100000', 100000]] as const) {
        const row = db.prepare(
          `WITH ${fragment.split('${max_frames_per_session}').join(literal)}
           SELECT root_cause_sample_limit_per_session AS cap FROM root_cause_sample_config`,
        ).get() as {cap: number};
        expect(row.cap).toBe(expected);
      }
    } finally {
      db.close();
    }
  });

  it('never presents the cross-source frame ratio as a bounded coverage percentage', () => {
    // frame_timeline_frames / buffer_tx_produced_frames comes from two
    // independent sources and can exceed 1 (measured 1.0024 and 1.0083 on real
    // vendor traces). Typed as `percentage` with a 覆盖率 label it rendered as
    // "100.24% coverage". It must stay a plain ratio; >1 is the signal that
    // BufferTX undercounted, so it must not be clamped either.
    const rawSkill = fs.readFileSync(skillPath, 'utf-8');
    expect(rawSkill).not.toContain('frame_timeline_coverage_ratio');

    let seen = 0;
    for (const step of skill.steps ?? []) {
      for (const column of (step.display?.columns ?? []) as any[]) {
        if (column.name !== 'frame_timeline_to_buffer_tx_ratio') continue;
        seen += 1;
        expect(column.type).toBe('number');
        expect(column.format).toBeUndefined();
        expect(String(column.label)).not.toContain('覆盖率');
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);

    // The ratio must not be clamped anywhere in the skill SQL.
    expect(rawSkill).not.toMatch(/MIN\(\s*1(?:\.0)?\s*,[^)]*frame_timeline_to_buffer_tx_ratio/);
  });

  it('reports root-cause sample coverage independently from FrameTimeline coverage', () => {
    const step = getStep('batch_frame_root_cause');
    for (const column of [
      'root_cause_eligible_frame_count',
      'root_cause_analyzed_frame_count',
      'root_cause_coverage_ratio',
      'root_cause_sample_limit_per_session',
      'root_cause_analysis_scope',
    ]) {
      expect(getColumn(step, column).hidden).toBe(true);
    }
    expect(step.synthesize.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({
        template: expect.stringContaining('root_cause_analyzed_frame_count'),
      }),
    ]));

    // The cap CTE now lives in a shared fragment so get_app_jank_frames and
    // batch_frame_root_cause cannot drift apart. Assemble fragment + marked
    // block the same way the runtime injector does.
    expect(step.sql_fragments).toContain('fragments/root_cause_sample_cap.sql');
    const capFragment = fs.readFileSync(
      path.join(process.cwd(), 'skills', 'fragments', 'root_cause_sample_cap.sql'),
      'utf-8',
    );
    const scopeCtes = `${capFragment.trim()},\n${extractMarkedCtes(
      String(step.sql),
      '-- BATCH_ROOT_CAUSE_SCOPE_CTES_BEGIN',
      '-- BATCH_ROOT_CAUSE_SCOPE_CTES_END',
    )}`;
    const db = createScopedSqlFixture();
    try {
      const run = (limit: number) => db.prepare(`
        WITH
        ranked_jank_frames(session_id, rank_in_session) AS (
          VALUES (1, 1), (1, 2), (1, 3), (2, 1), (2, 2), (2, 3)
        ),
        ${scopeCtes.split('${max_frames_per_session}').join(String(limit))}
        SELECT
          root_cause_eligible_frame_count,
          root_cause_analyzed_frame_count,
          root_cause_coverage_ratio,
          root_cause_sample_limit_per_session,
          root_cause_analysis_scope
        FROM root_cause_population
      `).get() as {
        root_cause_eligible_frame_count: number;
        root_cause_analyzed_frame_count: number;
        root_cause_coverage_ratio: number;
        root_cause_sample_limit_per_session: number;
        root_cause_analysis_scope: string;
      };

      expect(run(2)).toEqual({
        root_cause_eligible_frame_count: 6,
        root_cause_analyzed_frame_count: 4,
        root_cause_coverage_ratio: 0.6667,
        root_cause_sample_limit_per_session: 2,
        root_cause_analysis_scope: 'capped_frame_sample',
      });
      expect(run(10)).toEqual({
        root_cause_eligible_frame_count: 6,
        root_cause_analyzed_frame_count: 6,
        root_cause_coverage_ratio: 1,
        root_cause_sample_limit_per_session: 10,
        root_cause_analysis_scope: 'full_frame_set',
      });
    } finally {
      db.close();
    }
  });

  it('requires direct evidence for lock and RenderThread sync reason codes', () => {
    const step = getStep('batch_frame_root_cause');
    const sql = String(step.sql);

    expect(sql).toContain('lock_contention_ms');
    expect(sql).toContain('render_sync_wait_ms');
    expect(sql).toContain("THEN 'lock_contention'");
    expect(sql).toContain("THEN 'render_sync_wait'");
    expect(sql).not.toMatch(/WHEN\s+main_q4b_pct\s*>\s*30\s+THEN\s+'lock_binder_wait'/m);

    const lockColumn = getColumn(step, 'lock_contention_ms');
    expect(lockColumn.type).toBe('duration');
    expect(lockColumn.unit).toBe('ms');
    const syncColumn = getColumn(step, 'render_sync_wait_ms');
    expect(syncColumn.type).toBe('duration');
    expect(syncColumn.unit).toBe('ms');
    const rtWorkColumn = getColumn(step, 'render_sync_rt_work_ms');
    expect(rtWorkColumn.type).toBe('duration');
    expect(rtWorkColumn.unit).toBe('ms');
  });

  describe('frequency-limit reason branches', () => {
    const batchSql = () => String(getStep('batch_frame_root_cause').sql);
    // The maintained reason CASE of the `classified` CTE, placeholders bound to their defaults.
    const reasonCase = () => {
      const sql = batchSql();
      const start = sql.indexOf('CASE', sql.indexOf('classified AS ('));
      const end = sql.indexOf('END as reason_code', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return sql.slice(start, end + 3).replace(/\$\{[^}|]+\|([^}]+)\}/g, '$1');
    };

    it('keeps P4 workload_heavy < thermal_throttling < cpu_max_limited < big_core_low_freq and the fallback last', () => {
      const tree = reasonCase();
      const at = (code: string, from = 0) => tree.indexOf(`THEN '${code}'`, from);
      const p4 = at('workload_heavy');
      expect(p4).toBeGreaterThan(0);
      expect(at('thermal_throttling')).toBeGreaterThan(p4);
      expect(at('cpu_max_limited')).toBeGreaterThan(at('thermal_throttling'));
      expect(at('big_core_low_freq')).toBeGreaterThan(at('cpu_max_limited'));
      const fallback = at('workload_heavy', p4 + 1);
      expect(fallback).toBeGreaterThan(at('small_core_placement', at('big_core_low_freq')));
      expect(at('app_jank_unattributed')).toBeGreaterThan(fallback);
    });

    it('derives no reason from the device-peak frequency ratio', () => {
      const tree = reasonCase();
      expect(tree).not.toMatch(/device_peak_freq_mhz/);
      // The two frequency-limit branches read only the binding state and the onset verdict.
      const limitBranches = tree.slice(tree.indexOf("THEN 'workload_heavy'"), tree.indexOf("THEN 'cpu_max_limited'"));
      expect(limitBranches).not.toMatch(/freq_mhz/);
      expect(limitBranches.match(/freq_limit_state = 'capped_binding'/g)).toHaveLength(2);
      expect(getColumn(getStep('batch_frame_root_cause'), 'device_peak_freq_mhz').hidden).toBe(true);
      expect(getColumn(getStep('batch_frame_root_cause'), 'freq_ceiling_ratio_pct').type).toBe('percentage');
    });

    it('classifies frames from the main thread\'s binding state and its onset verdict only', () => {
      const tree = reasonCase();
      const columns = [...new Set(tree.replace(/'[^']*'/g, "''").match(/\b[a-z_][a-z0-9_]*\b/g) ?? [])];
      const db = new Database(':memory:');
      try {
        const evaluate = (overrides: Record<string, unknown>) => {
          const row: Record<string, unknown> = Object.fromEntries(columns.map(name => [name, 0]));
          Object.assign(row, {jank_responsibility: 'APP', jank_type: 'App Deadline Missed', input_stage: '',
            vsync_period_ns: 8_333_333, frame_budget_ms: 8.33, slice_critical_ms: 4.17, freq_ramp_critical_ms: 2.92,
            binder_overlap_critical_ms: 1.5, dur_ms: 20, top_slice_ms: 6, freq_limit_state: null,
            freq_limit_basis: null, freq_limit_onset_confirmed: 0, ...overrides});
          const projection = columns.map(name => `@${name} AS ${name}`).join(', ');
          return (db.prepare(`SELECT ${tree} AS reason_code FROM (SELECT ${projection})`).get(
            Object.fromEntries(columns.map(name => [name, row[name] as any]))) as any).reason_code;
        };
        const binding = {freq_limit_state: 'capped_binding'};
        expect(evaluate({})).toBe('workload_heavy');
        expect(evaluate({...binding, freq_limit_onset_confirmed: 1, freq_limit_basis: 'THERMAL_LIMIT_CONFIRMED'}))
          .toBe('thermal_throttling');
        expect(evaluate({...binding, freq_limit_onset_confirmed: 1, freq_limit_basis: 'mixed_limit_values_in_frame'}))
          .toBe('cpu_max_limited');
        expect(evaluate({...binding, freq_limit_basis: 'LIMIT_RELAXED'})).toBe('cpu_max_limited');
        expect(evaluate({...binding, freq_limit_basis: 'LIMIT_ONSET_UNKNOWN'})).toBe('cpu_max_limited');
        // Before P5: a binding cap outranks a low average frequency.
        expect(evaluate({...binding, big_run_pct: 50, big_avg_freq_mhz: 900, big_max_freq_mhz: 2000}))
          .toBe('cpu_max_limited');
        // After P4: a slice over 2x budget stays workload_heavy; under the critical share nothing names a cap.
        expect(evaluate({...binding, freq_limit_onset_confirmed: 1, top_slice_ms: 20})).toBe('workload_heavy');
        expect(evaluate({...binding, freq_limit_onset_confirmed: 1, top_slice_ms: 3})).toBe('app_jank_unattributed');
        for (const state of ['capped_not_binding', 'limit_state_unknown', 'limit_track_unavailable',
          'threads_not_on_limited_policy', 'insufficient_running', 'frequency_unavailable', 'at_observed_max_limit']) {
          expect({state, reason: evaluate({freq_limit_state: state, freq_limit_onset_confirmed: 1})})
            .toEqual({state, reason: 'workload_heavy'});
        }
        // The old heuristic's inputs alone never name a frequency reason.
        expect(evaluate({big_max_freq_mhz: 500, device_peak_freq_mhz: 3000})).toBe('workload_heavy');
        // RenderThread binding is diagnostic only.
        expect(evaluate({freq_limit_state: 'threads_not_on_limited_policy', rt_freq_limit_state: 'capped_binding'}))
          .toBe('workload_heavy');
        // A ramp names freq_ramp_slow only when every big CPU was observed for the frame.
        expect(evaluate({...SLOW_RAMP, freq_ramp_evidence: 'observed'})).toBe('freq_ramp_slow');
        for (const evidence of UNOBSERVED_RAMP_EVIDENCE) {
          expect({evidence, reason: evaluate({...SLOW_RAMP, freq_ramp_evidence: evidence})})
            .toEqual({evidence, reason: 'workload_heavy'});
        }
      } finally { db.close(); }
    });

    it('cites the selected limit value with its own binding time, the cumulative time only as across values', () => {
      const sql = batchSql();
      expect(sql).toContain('flm.onset_binding_ns AS freq_limit_onset_binding_ns');
      const start = sql.search(/CASE\s+WHEN reason_code = 'buffer_stuffing' THEN '原始/);
      const end = sql.indexOf('END as primary_cause', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const text = sql.slice(start, end + 3);
      const columns = [...new Set(text.replace(/'[^']*'/g, "''").match(/\b[a-z_][a-z0-9_]*\b/g) ?? [])];
      const db = new Database(':memory:');
      try {
        const cause = (overrides: Record<string, unknown>) => {
          const row: Record<string, unknown> = Object.fromEntries(columns.map(name => [name, 0]));
          Object.assign(row, {top_slice_name: 'Work', freq_limit_run_ns: 10_000_000, freq_limit_policy_cpu: 6n,
            freq_limit_mhz: 1800.0, freq_limit_depth_pct: 25.0, freq_limit_binding_ratio: 1.0, ...overrides});
          return (db.prepare(`SELECT ${text} AS cause FROM (SELECT ${columns.map(n => `@${n} AS ${n}`).join(', ')})`)
            .get(Object.fromEntries(columns.map(n => [n, row[n] as any]))) as any).cause as string;
        };
        // Confirmed 1800 MHz binds 3 ms, an unconfirmed 1500 MHz value 2 ms: never "5 ms under 1800 MHz".
        const mixed = cause({reason_code: 'cpu_max_limited', freq_limit_basis: 'mixed_limit_values_in_frame',
          freq_limit_onset_binding_ns: 3_000_000, freq_limit_binding_ns: 5_000_000});
        expect(mixed).toContain('运行 10.0ms 中有 3.0ms 受 policy6 上限 1800.0MHz 约束');
        expect(mixed).toContain('跨全部上限值共受约束 5.0ms');
        expect(mixed).not.toMatch(/5\.0ms 受 policy/);
        expect(mixed).toContain('mixed_limit_values_in_frame');
        // Confirmed 1800 MHz binds 6 ms, a later value 2 ms.
        const thermal = cause({reason_code: 'thermal_throttling', freq_limit_basis: 'THERMAL_LIMIT_CONFIRMED',
          freq_limit_onset_binding_ns: 6_000_000, freq_limit_binding_ns: 8_000_000});
        expect(thermal).toContain('运行 10.0ms 中有 6.0ms 受 policy6 上限 1800.0MHz 约束');
        expect(thermal).toContain('跨全部上限值共受约束 8.0ms');
        expect(thermal).not.toMatch(/8\.0ms 受 policy/);
        // One value only: no cross-value clause.
        const single = cause({reason_code: 'thermal_throttling', freq_limit_onset_binding_ns: 10_000_000,
          freq_limit_binding_ns: 10_000_000});
        expect(single).toContain('中有 10.0ms 受 policy6');
        expect(single).not.toContain('跨全部上限值');
      } finally { db.close(); }
    });

    it('attributes main-thread state to the clipped top slice and RenderThread state to the frame', () => {
      const sql = batchSql();
      // The main interval belongs to the thread that ran the top slice, not to every main-role thread.
      expect(sql).toMatch(/system_work_intervals AS \(\s*SELECT ts_top\.frame_key AS window_id,'main' AS role,ts_top\.slice_utid AS utid,\s*MAX\(ts_top\.slice_ts,fl\.frame_start\) AS work_start_ts,\s*MIN\(ts_top\.slice_ts\+ts_top\.slice_dur_ns,fl\.frame_end\) AS work_end_ts/);
      expect(sql).toMatch(/ptr\.utid as slice_utid,\s*ROW_NUMBER\(\) OVER \(PARTITION BY fl\.frame_key ORDER BY s\.dur DESC\) as rn\s*FROM jank_frame_list fl\s*JOIN per_frame_thread_roles ptr ON ptr\.frame_key = fl\.frame_key AND ptr\.role = 'main'/);
      expect(sql).toContain("SELECT frame_key,'render',NULL,frame_start,frame_end FROM jank_frame_list");
      expect(sql).toContain("flm.window_id=fl.frame_key AND flm.role='main'");
      expect(sql).toContain("flr.window_id=fl.frame_key AND flr.role='render'");
    });
  });

  // SQL expression helpers for the reason and label CASEs below.
  // The CASE that ends with `END as <alias>` after `from`, nested CASEs included.
  const caseAs = (sql: string, alias: string, from = 0) => {
    const end = sql.indexOf(`END as ${alias}`, from);
    expect(end).toBeGreaterThan(from);
    // Literals and comments blanked in place, so token offsets stay offsets into `sql`.
    const code = sql.slice(0, end).replace(/'[^']*'|--[^\n]*/g, text => ' '.repeat(text.length));
    const tokens = [...code.matchAll(/\b(CASE|END)\b/g)];
    let depth = 1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      depth += tokens[i][1] === 'END' ? 1 : -1;
      if (depth === 0) return sql.slice(tokens[i].index, end + 3);
    }
    throw new Error(`unbalanced CASE for ${alias}`);
  };
  // Bind every lowercase identifier of `expression` (0 unless given) and evaluate it in SQLite.
  const evaluateSql = (db: Database.Database, expression: string, values: Record<string, unknown>) => {
    const bound = expression
      .replace(/--[^\n]*/g, '')
      .split("'${jank_responsibility}'").join('jank_responsibility')
      .replace(/\$\{[^}|]+\|([^}]+)\}/g, '$1');
    const columns = [...new Set(bound.replace(/'[^']*'/g, "''").match(/\b[a-z_][a-z0-9_]*\b/g) ?? [])];
    const row: Record<string, unknown> = {...Object.fromEntries(columns.map(name => [name, 0])), ...values};
    const projection = columns.map(name => `@${name} AS ${name}`).join(', ');
    return (db.prepare(`SELECT ${bound} AS value FROM (SELECT ${projection})`)
      .get(Object.fromEntries(columns.map(name => [name, row[name] as any]))) as any).value;
  };

  describe('single-frame frequency-limit root cause (jank_frame_detail)', () => {
    const jankSql = () => String(getSkillStep(jankSkill, 'root_cause_summary').sql);
    const jankReasonCase = () => caseAs(jankSql(), 'reason_code', jankSql().indexOf('classified AS ('));
    const batchReasonCase = () => {
      const sql = String(getStep('batch_frame_root_cause').sql);
      return caseAs(sql, 'reason_code', sql.indexOf('classified AS ('));
    };
    // The WHEN clause that yields `code`, split into its AND-ed predicates.
    const predicatesOf = (tree: string, code: string) => {
      const then = tree.indexOf(`THEN '${code}'`);
      expect(then).toBeGreaterThan(0);
      const when = tree.lastIndexOf('WHEN ', then);
      return tree.slice(when + 'WHEN '.length, then).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().split(' AND ');
    };
    const SF_GUARD = "'${jank_responsibility}' <> 'SF'";

    it('keeps P4 workload_heavy < thermal_throttling < cpu_max_limited < big_core_low_freq and the fallback after the ramp', () => {
      const tree = jankReasonCase();
      const at = (code: string, from = 0) => tree.indexOf(`THEN '${code}'`, from);
      const p4 = at('workload_heavy');
      expect(p4).toBeGreaterThan(at('render_thread_heavy'));
      expect(at('thermal_throttling')).toBeGreaterThan(p4);
      expect(at('cpu_max_limited')).toBeGreaterThan(at('thermal_throttling'));
      expect(at('big_core_low_freq')).toBeGreaterThan(at('cpu_max_limited'));
      expect(at('workload_heavy', p4 + 1)).toBeGreaterThan(at('freq_ramp_slow'));
    });

    it('names a limit only outside SF responsibility, which batch splits off before its limit branches', () => {
      const jank = jankReasonCase();
      for (const code of ['thermal_throttling', 'cpu_max_limited']) {
        expect(predicatesOf(jank, code)[0]).toBe(SF_GUARD);
      }
      const batch = batchReasonCase();
      const lastSfBranch = batch.lastIndexOf("WHEN jank_responsibility = 'SF'");
      expect(lastSfBranch).toBeGreaterThan(0);
      expect(lastSfBranch).toBeLessThan(batch.indexOf("THEN 'thermal_throttling'"));
      // cause_type short-circuits SF before the limit override as well.
      const causeType = caseAs(jankSql(), 'cause_type');
      expect(causeType.indexOf("WHEN '${jank_responsibility}' = 'SF' THEN 'sf_composition'"))
        .toBeLessThan(causeType.indexOf("THEN 'freq_limit'"));
    });

    it('shares the binding predicates of the batch branches item by item', () => {
      for (const code of ['thermal_throttling', 'cpu_max_limited']) {
        const jank = predicatesOf(jankReasonCase(), code).filter(predicate => predicate !== SF_GUARD)
          .map(predicate => predicate.split('slice_dur').join('top_slice_ms'));
        expect({code, predicates: jank}).toEqual({code, predicates: predicatesOf(batchReasonCase(), code)});
      }
      expect(predicatesOf(jankReasonCase(), 'thermal_throttling')).toEqual([SF_GUARD,
        'slice_dur > slice_critical_ms', "freq_limit_state = 'capped_binding'", 'freq_limit_onset_confirmed = 1',
        "freq_limit_basis <> 'mixed_limit_values_in_frame'"]);
    });

    it('classifies the frame from the main thread\'s binding state and its onset verdict only', () => {
      const tree = jankReasonCase();
      const db = new Database(':memory:');
      try {
        const reason = (overrides: Record<string, unknown>) => evaluateSql(db, tree, {jank_responsibility: 'APP',
          frame_budget_ms: 8.33, slice_critical_ms: 4.17, freq_ramp_critical_ms: 2.92, binder_overlap_critical_ms: 1.5,
          slice_dur: 6, freq_limit_state: null, freq_limit_basis: null, freq_limit_onset_confirmed: 0, ...overrides});
        const binding = {freq_limit_state: 'capped_binding'};
        expect(reason({})).toBe('workload_heavy');
        expect(reason({...binding, freq_limit_onset_confirmed: 1, freq_limit_basis: 'THERMAL_LIMIT_CONFIRMED'}))
          .toBe('thermal_throttling');
        expect(reason({...binding, freq_limit_onset_confirmed: 1, freq_limit_basis: 'mixed_limit_values_in_frame'}))
          .toBe('cpu_max_limited');
        expect(reason({...binding, freq_limit_basis: 'LIMIT_RELAXED'})).toBe('cpu_max_limited');
        expect(reason({...binding, freq_limit_basis: 'LIMIT_ONSET_UNKNOWN'})).toBe('cpu_max_limited');
        // Before P5: a binding cap outranks a low in-slice big-core frequency.
        const lowFreq = {top_slice_big_pct: 50, top_big_avg_freq_mhz: 900, top_big_max_freq_mhz: 2000};
        expect(reason(lowFreq)).toBe('big_core_low_freq');
        expect(reason({...lowFreq, ...binding})).toBe('cpu_max_limited');
        // After P4: over 2x budget stays workload_heavy; under the critical share nothing names a cap.
        expect(reason({...binding, freq_limit_onset_confirmed: 1, slice_dur: 20})).toBe('workload_heavy');
        expect(reason({...binding, freq_limit_onset_confirmed: 1, slice_dur: 3})).toBe('unknown');
        for (const state of ['capped_not_binding', 'limit_state_unknown', 'limit_track_unavailable',
          'threads_not_on_limited_policy', 'insufficient_running', 'frequency_unavailable', 'at_observed_max_limit']) {
          expect({state, reason: reason({freq_limit_state: state, freq_limit_onset_confirmed: 1})})
            .toEqual({state, reason: 'workload_heavy'});
        }
        // The window-average heuristic never names a limit, nor does RenderThread binding.
        expect(reason({slice_dur: 0, big_freq: 800, big_freq_peak: 2000})).toBe('big_core_low_freq');
        expect(reason({rt_freq_limit_state: 'capped_binding', freq_limit_state: 'threads_not_on_limited_policy'}))
          .toBe('workload_heavy');
        // SF responsibility: the same binding evidence names no App-side limit.
        expect(reason({...binding, freq_limit_onset_confirmed: 1, jank_responsibility: 'SF'})).toBe('workload_heavy');
        expect(reason({...binding, jank_responsibility: 'SF'})).toBe('workload_heavy');
        // A ramp names freq_ramp_slow only when every big CPU was observed for the frame.
        expect(reason({...SLOW_RAMP, freq_ramp_evidence: 'observed'})).toBe('freq_ramp_slow');
        for (const evidence of UNOBSERVED_RAMP_EVIDENCE) {
          expect({evidence, reason: reason({...SLOW_RAMP, freq_ramp_evidence: evidence})})
            .toEqual({evidence, reason: 'workload_heavy'});
        }
      } finally { db.close(); }
    });

    it('labels a limit reason as frequency-limit supply before the slice-based labels', () => {
      const sql = jankSql();
      const causeType = caseAs(sql, 'cause_type');
      const confidence = caseAs(sql, 'confidence');
      const primaryCause = caseAs(sql, 'primary_cause');
      const mechanismGroup = caseAs(sql, 'mechanism_group');
      const supplyConstraint = caseAs(sql, 'supply_constraint');
      const triggerLayer = caseAs(sql, 'trigger_layer');
      const db = new Database(':memory:');
      try {
        const labels = (values: Record<string, unknown>) => {
          const row = {jank_responsibility: 'APP', frame_budget_ms: 8.33, slice_critical_ms: 4.17,
            slice_warning_ms: 2, slice_dur: 6, slice_name: 'Work', render_q4a: 20, render_q4b: 20, ...values};
          const cause = evaluateSql(db, causeType, row);
          const withCause = {...row, cause_type: cause};
          return {cause_type: cause, confidence: evaluateSql(db, confidence, row),
            mechanism_group: evaluateSql(db, mechanismGroup, withCause),
            supply_constraint: evaluateSql(db, supplyConstraint, withCause),
            trigger_layer: evaluateSql(db, triggerLayer, withCause)};
        };
        expect(labels({reason_code: 'thermal_throttling'})).toEqual({cause_type: 'freq_limit', confidence: '高',
          mechanism_group: 'supply', supply_constraint: 'thermal_throttle', trigger_layer: 'app_producer'});
        expect(labels({reason_code: 'cpu_max_limited'})).toEqual({cause_type: 'freq_limit', confidence: '中',
          mechanism_group: 'supply', supply_constraint: 'frequency_insufficient', trigger_layer: 'app_producer'});
        // Without limit evidence a slice over the critical share stays a trigger.
        expect(labels({reason_code: 'workload_heavy'})).toMatchObject({cause_type: 'slice', mechanism_group: 'trigger'});
        // A low window-average big-core frequency is supply, never a frequency limit.
        const heuristic = {reason_code: 'unknown', slice_dur: 0, big_freq: 900, big_freq_peak: 2000};
        expect(labels(heuristic)).toEqual({cause_type: 'low_freq', confidence: '低', mechanism_group: 'supply',
          supply_constraint: 'frequency_insufficient', trigger_layer: 'app_producer'});
        expect(causeType).not.toMatch(/big_freq[^\n]*THEN 'freq_limit'/);
        const text = evaluateSql(db, primaryCause, {...heuristic, frame_budget_ms: 8.33, render_q4a: 0, render_q4b: 0});
        expect(text).toContain('大核平均频率仅 900');
        expect(text).toContain('仅为频率观测');
        expect(text).not.toMatch(/温控|可能触发/);
        // SF responsibility keeps its composition label.
        expect(labels({reason_code: 'workload_heavy', jank_responsibility: 'SF'}).cause_type).toBe('sf_composition');
      } finally { db.close(); }
    });

    it('cites the selected limit value with its own binding time, the cumulative time only across values', () => {
      const primaryCause = caseAs(jankSql(), 'primary_cause');
      const db = new Database(':memory:');
      try {
        const cause = (overrides: Record<string, unknown>) => evaluateSql(db, primaryCause, {slice_name: 'Work',
          slice_dur: 10, slice_critical_ms: 4.17, freq_limit_run_ns: 10_000_000, freq_limit_policy_cpu: 6n,
          freq_limit_mhz: 1800.0, freq_limit_depth_pct: 25.0, freq_limit_binding_ratio: 1.0, ...overrides}) as string;
        const mixed = cause({reason_code: 'cpu_max_limited', freq_limit_basis: 'mixed_limit_values_in_frame',
          freq_limit_onset_binding_ns: 3_000_000, freq_limit_binding_ns: 5_000_000});
        expect(mixed).toContain('运行 10.0ms 中有 3.0ms 受 policy6 上限 1800.0MHz 约束');
        expect(mixed).toContain('跨全部上限值共受约束 5.0ms');
        expect(mixed).toContain('触发方未由帧内证据确定（mixed_limit_values_in_frame）');
        const thermal = cause({reason_code: 'thermal_throttling', freq_limit_onset_binding_ns: 10_000_000,
          freq_limit_binding_ns: 10_000_000});
        expect(thermal).toContain('温控限频: "Work" 运行 10.0ms 中有 10.0ms 受 policy6');
        expect(thermal).not.toContain('跨全部上限值');
      } finally { db.close(); }
    });

    it('attributes main-thread state to the clipped top slice on its own thread and RenderThread to the frame', () => {
      const sql = jankSql();
      expect(sql).toMatch(/ROUND\(s\.dur \/ 1e6, 2\) as dur_ms,\s*tt\.utid as slice_utid\s*FROM slice s/);
      expect(sql).toMatch(/system_work_intervals AS \(\s*SELECT 'frame' AS window_id,'MainThread' AS role,slice_utid AS utid,\s*MAX\(slice_start_ns,\$\{start_ts\}\) AS work_start_ts,MIN\(slice_end_ns,\$\{end_ts\}\) AS work_end_ts\s*FROM top_slice_bounds\s*UNION ALL SELECT 'frame','RenderThread',NULL,\$\{start_ts\},\$\{end_ts\}\s*\)/);
      expect(sql).toContain("SELECT * FROM system_cpu_freq_limit_frame_binding WHERE window_id='frame' AND role='MainThread'");
      expect(sql).toContain("SELECT * FROM system_cpu_freq_limit_frame_binding WHERE window_id='frame' AND role='RenderThread'");
      // Outside the system_target_threads .. GPU Fence slice that crossSceneSystemConsumers executes alone.
      const isolated = sql.slice(sql.indexOf('system_target_threads AS ('), sql.indexOf('-- 8. GPU Fence'));
      expect(isolated).not.toMatch(/system_work_intervals|frame_freq_limit_|system_cpu_freq_limit/);
      // Of the verdict layer, the step reads only the per-frame binding.
      const code = sql.replace(/--[^\n]*/g, ' ').replace(/'[^']*'/g, "''");
      expect([...new Set(code.match(/\bsystem_cpu_freq_limit_[a-z_]+|\bthermal_[a-z_]+/g) ?? [])])
        .toEqual(['system_cpu_freq_limit_frame_binding']);
    });

    it('injects the binding fragment with the batch step\'s dependencies, in the batch order', () => {
      const jankFragments: string[] = getSkillStep(jankSkill, 'root_cause_summary').sql_fragments;
      const batchFragments: string[] = getStep('batch_frame_root_cause').sql_fragments;
      const limitFragments = batchFragments.slice(batchFragments.indexOf('fragments/system_cpu_freq_limit_spans.sql'));
      expect(limitFragments[limitFragments.length - 1]).toBe('fragments/system_cpu_freq_limit_frame_binding.sql');
      expect(jankFragments.filter(file => limitFragments.includes(file))).toEqual(limitFragments);
      const at = (file: string) => jankFragments.indexOf(file);
      for (const dependency of ['system_sched_spans', 'system_thread_state_spans', 'system_cpu_frequency_spans']) {
        expect(at(`fragments/${dependency}.sql`)).toBeGreaterThanOrEqual(0);
        expect(at(`fragments/${dependency}.sql`)).toBeLessThan(at(limitFragments[0]));
      }
    });

    it('declares the limit columns with the batch display contract', () => {
      const step = getSkillStep(jankSkill, 'root_cause_summary');
      const batchStep = getStep('batch_frame_root_cause');
      const names = (batchStep.display.columns as any[]).map(column => column.name)
        .filter(name => /^(rt_)?freq_limit_/.test(name));
      expect(names).toHaveLength(16);
      for (const name of names) {
        expect(getColumn(step, name)).toEqual(getColumn(batchStep, name));
        expect(getColumn(step, name).hidden).toBe(true);
      }
      expect(jankSql()).toContain(
        "CASE WHEN freq_limit_onset_ts IS NOT NULL THEN printf('%d', freq_limit_onset_ts) END AS freq_limit_onset_ts");
    });
  });

  // SCROLLING_V1_REASON_CODES is the domain pack's authoritative vocabulary; the
  // single-frame deep path keeps three deep-only codes of its own.
  describe('reason code vocabulary', () => {
    const codesOf = (sql: string) => {
      const tree = caseAs(sql, 'reason_code', sql.indexOf('classified AS ('));
      return new Set([...tree.matchAll(/\b(?:THEN|ELSE)\s+'([a-z_]+)'/g)].map(match => match[1]));
    };
    const DEEP_ONLY = ['cpu_load_high', 'io_page_cache_wait', 'gpu_wait'];
    // Every code jank_frame_detail produced before the frequency-limit branches.
    const JANK_BASELINE = ['buffer_stuffing', 'binder_sync_blocking', 'lock_contention', 'small_core_placement',
      'sched_delay_in_slice', 'render_thread_heavy', 'workload_heavy', 'big_core_low_freq', 'freq_ramp_slow',
      'gc_jank', 'scheduling_delay', 'shader_compile', 'gpu_wait', 'cpu_load_high', 'io_page_cache_wait',
      'uninterruptible_wait', 'render_sync_wait', 'unknown'];

    it('batch produces exactly the current scrolling.v1 codes', () => {
      const batch = [...codesOf(String(getStep('batch_frame_root_cause').sql))].sort();
      expect(batch).toEqual(SCROLLING_V1_REASON_CODES.filter(code => code !== 'lock_binder_wait').sort());
    });

    it('the single-frame path produces only pack or deep-only codes and keeps every code it had', () => {
      const jank = codesOf(String(getSkillStep(jankSkill, 'root_cause_summary').sql));
      const allowed = new Set<string>([...SCROLLING_V1_REASON_CODES, ...DEEP_ONLY]);
      expect([...jank].filter(code => !allowed.has(code))).toEqual([]);
      expect([...JANK_BASELINE, 'thermal_throttling', 'cpu_max_limited'].filter(code => !jank.has(code))).toEqual([]);
    });
  });

  // frame_diagnosis collects every matching rule, so the limit observation must
  // not contradict the root cause that the same frame reports.
  describe('frame diagnosis agrees with the frequency-limit root cause', () => {
    const OBSERVED = {has_limit_track: 1, has_max_limit_data: 1, episode_count: 1, policy_count: 1,
      deepest_depth_pct: 25, min_limit_khz: 1800000, reference_max_limit_khz: 2400000,
      evidence_status: 'freq_limit_observed', limit_evidence_missing_reason: null};
    const LIMIT_RULES = () => (getSkillStep(jankSkill, 'frame_diagnosis').rules as any[])
      .filter(rule => String(rule.condition).includes("evidence_status === 'freq_limit_observed'"));
    const diagnose = async (rootCause: Record<string, unknown> | null, limit = OBSERVED) =>
      (await diagnoseRuleStep(getSkillStep(jankSkill, 'frame_diagnosis'),
        {root_cause: rootCause ? [rootCause] : [], freq_limit_evidence: [limit]}, {start_ts: 1, end_ts: 2}))
        .filter(d => d.diagnosis.includes('帧窗口内观测到 CPU 限频'));
    const rootCause = (reasonCode: string) => ({primary_cause: 'cause', confidence: '高', secondary_info: 'info',
      reason_code: reasonCode});

    it('fires exactly one limit rule whose advice matches what the root cause already determined', async () => {
      expect(LIMIT_RULES()).toHaveLength(3);
      const thermal = await diagnose(rootCause('thermal_throttling'));
      expect(thermal).toHaveLength(1);
      const thermalAdvice = (thermal[0].suggestions ?? []).join('\n');
      expect(thermalAdvice).toContain('约束了它（binding）');
      expect(thermalAdvice).toContain('温控冷却设备升档配对确认');
      expect(thermalAdvice).not.toContain('尚未判定');

      const limited = await diagnose(rootCause('cpu_max_limited'));
      expect(limited).toHaveLength(1);
      const limitedAdvice = (limited[0].suggestions ?? []).join('\n');
      expect(limitedAdvice).toContain('限频约束了本帧关键线程（binding）');
      expect(limitedAdvice).toContain('cpu_frequency_limit_attribution');
      expect(limitedAdvice).not.toContain('是否约束了本帧关键线程尚未判定');

      for (const other of [rootCause('workload_heavy'), null]) {
        const found = await diagnose(other);
        expect(found).toHaveLength(1);
        expect(found[0].suggestions).toEqual([
          '限频已发生，但由温控还是功耗/厂商策略触发尚未判定：用 cpu_frequency_limit_attribution 判断触发方与限频前负载',
          '限频是否约束了本帧关键线程尚未判定：对照关键线程运行所在 CPU/policy 与运行时长，不能直接把卡顿归因于限频',
        ]);
      }
      // A binding root cause alone never asserts a limit without the limit evidence row.
      expect(await diagnose(rootCause('thermal_throttling'), {...OBSERVED, evidence_status: 'no_limit_episode_in_range'}))
        .toHaveLength(0);
    });

    it('keys the limit rules on reason codes the root cause can produce, in the portable expression subset', () => {
      const sql = String(getSkillStep(jankSkill, 'root_cause_summary').sql);
      const produced = caseAs(sql, 'reason_code', sql.indexOf('classified AS ('));
      const keyed = LIMIT_RULES().flatMap(rule =>
        [...String(rule.condition).matchAll(/reason_code [!=]== '(\w+)'/g)].map(match => match[1]));
      expect([...new Set(keyed)].sort()).toEqual(['cpu_max_limited', 'thermal_throttling']);
      expect(keyed.filter(code => !produced.includes(`THEN '${code}'`))).toEqual([]);
      for (const rule of LIMIT_RULES()) {
        const condition = String(rule.condition).replace(/\?\./g, '');
        expect({condition, ternary: /\?/.test(condition), math: /\bMath\./.test(condition)})
          .toEqual({condition, ternary: false, math: false});
      }
    });
  });

  it('uses trace-wide evidence when the shared VSync fragment has no range', () => {
    const fragmentPath = path.join(process.cwd(), 'skills', 'fragments', 'vsync_config.sql');
    const fragment = fs.readFileSync(fragmentPath, 'utf-8');

    expect(fragment).toMatch(/\$\{start_ts\}\s+IS\s+NULL/i);
    expect(fragment).toMatch(/\$\{end_ts\}\s+IS\s+NULL/i);
    expect(fragment).toContain('expected_frame_timeline_slice');
    expect(fragment).toContain('vsync_source');
  });

  it('keeps batch and single-frame direct-evidence reason families aligned', () => {
    const rootCauseStep = jankSkill.steps?.find((step: any) => step.id === 'root_cause_summary');
    expect(rootCauseStep).toBeDefined();
    const sql = String(rootCauseStep.sql);

    expect(sql).toContain('lock_contention_ms');
    expect(sql).toContain('render_sync_wait_ms');
    expect(sql).toContain("THEN 'lock_contention'");
    expect(sql).toContain("THEN 'render_sync_wait'");
    expect(sql).not.toMatch(/WHEN\s+main_q4b\s*>\s*30\s+THEN\s+'lock_binder_wait'/m);
  });

  it('counts every main-thread lock overlap before applying the display top-N limit', () => {
    const sql = String(getStep('batch_frame_root_cause').sql);
    const start = sql.indexOf('per_frame_lock_overlap AS (');
    const end = sql.indexOf('-- 10g.5.', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const productionCte = sql
      .slice(start, end)
      .replace(/,\s*$/, '')
      .split('${package}').join('com.example.app');

    const db = createScopedSqlFixture();
    try {
      const row = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end, upid) AS (
          VALUES ('display:1', 1000000000, 2000000000, 1)
        ),
        android_monitor_contention(
          ts, dur, process_name, is_blocked_thread_main,
          short_blocking_method, blocking_thread_name, upid
        ) AS (
          VALUES
            (900000000, 300000000, 'com.example.app', 1, 'mainLock', 'owner-main', 1),
            (1000000000, 900000000, 'com.example.app', 0, 'noise1', 'owner-1', 1),
            (1010000000, 880000000, 'com.example.app', 0, 'noise2', 'owner-2', 1),
            (1020000000, 860000000, 'com.example.app', 0, 'noise3', 'owner-3', 1),
            (1030000000, 840000000, 'com.example.app', 0, 'noise4', 'owner-4', 1),
            (1040000000, 820000000, 'com.example.app', 0, 'noise5', 'owner-5', 1),
            (1050000000, 800000000, 'com.example.app', 0, 'noise6', 'owner-6', 1)
        ),
        ${productionCte}
        SELECT lock_contention_ms
        FROM per_frame_lock_detail
      `).get() as {lock_contention_ms: number} | undefined;

      expect(row?.lock_contention_ms).toBe(200);
    } finally {
      db.close();
    }
  });

  it('scopes batch and deep monitor contention to the exact package or a child process', () => {
    const batchSql = String(getStep('batch_frame_root_cause').sql);
    const batchStart = batchSql.indexOf('per_frame_lock_overlap AS (');
    const batchEnd = batchSql.indexOf('-- 10g.5.', batchStart);
    expect(batchStart).toBeGreaterThanOrEqual(0);
    expect(batchEnd).toBeGreaterThan(batchStart);
    const batchCtes = batchSql
      .slice(batchStart, batchEnd)
      .trim()
      .replace(/,\s*$/, '')
      .split('${package}').join('com.example.app');

    const deepSql = String(getSkillStep(jankSkill, 'root_cause_summary').sql);
    const deepStart = deepSql.indexOf('monitor_lock_overlap AS (');
    const deepEnd = deepSql.indexOf('render_sync_wait AS (', deepStart);
    expect(deepStart).toBeGreaterThanOrEqual(0);
    expect(deepEnd).toBeGreaterThan(deepStart);
    const deepCte = deepSql
      .slice(deepStart, deepEnd)
      .trim()
      .replace(/,\s*$/, '')
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('1000000000')
      .split('${end_ts}').join('2000000000');

    const db = createScopedSqlFixture();
    try {
      const batchRow = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end, upid) AS (
          VALUES ('display:1', 1000000000, 2000000000, 1)
        ),
        android_monitor_contention(
          ts, dur, process_name, is_blocked_thread_main,
          short_blocking_method, blocking_thread_name, upid
        ) AS (
          VALUES
            (1000000000, 100000000, 'com.example.app', 1, 'exactLock', 'owner-exact', 1),
            (1100000000, 200000000, 'com.example.app:renderer', 1, 'childLock', 'owner-child', 1),
            (1200000000, 500000000, 'com.example.application', 1, 'wrongLock', 'owner-wrong', 1)
        ),
        ${batchCtes}
        SELECT lock_contention_ms
        FROM per_frame_lock_detail
      `).get() as {lock_contention_ms: number} | undefined;
      expect(batchRow?.lock_contention_ms).toBe(300);

      const deepRow = db.prepare(`
        WITH
        android_monitor_contention(
          ts, dur, process_name, is_blocked_thread_main, upid
        ) AS (
          VALUES
            (1000000000, 100000000, 'com.example.app', 1, 1),
            (1100000000, 200000000, 'com.example.app:renderer', 1, 2),
            (1200000000, 500000000, 'com.example.application', 1, 3)
        ),
        ${deepCte}
        SELECT lock_contention_ms
        FROM monitor_lock_overlap
      `).get() as {lock_contention_ms: number} | undefined;
      expect(deepRow?.lock_contention_ms).toBe(300);
    } finally {
      db.close();
    }
  });

  it('uses exact-or-child package identity throughout the single-frame deep path', () => {
    const deepSql = String(getSkillStep(jankSkill, 'root_cause_summary').sql);
    const targetThreads = fs.readFileSync(
      path.join(process.cwd(), 'skills', 'fragments', 'target_threads.sql'),
      'utf-8',
    );

    expect(deepSql).not.toContain("p.name GLOB '${package}*'");
    expect(targetThreads).not.toContain("p.name GLOB '${package}*'");
    expect(deepSql).toContain("p.name GLOB '${package}:*'");
    expect(targetThreads).toContain("p.name GLOB '${package}:*'");
  });

  it('unions nested RenderThread sync slices after clamping them to the frame window', () => {
    const batchSql = String(getStep('batch_frame_root_cause').sql);
    const batchMarker = '-- BATCH_RENDER_SYNC_CTES_BEGIN';
    const batchMarkerStart = batchSql.indexOf(batchMarker);
    const batchStart = batchMarkerStart >= 0
      ? batchMarkerStart + batchMarker.length
      : batchSql.indexOf('per_frame_render_sync_wait AS (');
    const batchEndMarker = '-- BATCH_RENDER_SYNC_CTES_END';
    const batchMarkerEnd = batchSql.indexOf(batchEndMarker, batchStart);
    const batchEnd = batchMarkerEnd >= 0
      ? batchMarkerEnd
      : batchSql.indexOf('-- 10h.', batchStart);
    expect(batchStart).toBeGreaterThanOrEqual(0);
    expect(batchEnd).toBeGreaterThan(batchStart);
    const batchCtes = batchSql
      .slice(batchStart, batchEnd)
      .trim()
      .replace(/,\s*$/, '');

    const deepSql = String(getSkillStep(jankSkill, 'root_cause_summary').sql);
    const deepMarker = '-- DEEP_RENDER_SYNC_CTES_BEGIN';
    const deepMarkerStart = deepSql.indexOf(deepMarker);
    const deepStart = deepMarkerStart >= 0
      ? deepMarkerStart + deepMarker.length
      : deepSql.indexOf('render_sync_wait AS (');
    const deepEndMarker = '-- DEEP_RENDER_SYNC_CTES_END';
    const deepMarkerEnd = deepSql.indexOf(deepEndMarker, deepStart);
    const deepEnd = deepMarkerEnd >= 0
      ? deepMarkerEnd
      : deepSql.indexOf('top_slice_state_overlap AS (', deepStart);
    expect(deepStart).toBeGreaterThanOrEqual(0);
    expect(deepEnd).toBeGreaterThan(deepStart);
    const deepCtes = deepSql
      .slice(deepStart, deepEnd)
      .trim()
      .replace(/,\s*$/, '')
      .split('${start_ts}').join('1000000000')
      .split('${end_ts}').join('1100000000');

    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
        CREATE TABLE slice(track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
        INSERT INTO thread_track VALUES (10, 1);
        INSERT INTO slice VALUES
          (10, 990000000, 80000000, 'syncAndDrawFrame'),
          (10, 1020000000, 30000000, 'postAndWait'),
          (10, 1060000000, 70000000, 'syncFrameState');
      `);

      const batchRow = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end, upid) AS (
          VALUES ('display:1', 1000000000, 1100000000, 42)
        ),
        per_frame_thread_roles(frame_key, role, utid) AS (
          VALUES ('display:1', 'main', 1)
        ),
        ${batchCtes}
        SELECT render_sync_wait_ms
        FROM per_frame_render_sync_wait
      `).get() as {render_sync_wait_ms: number} | undefined;
      expect(batchRow?.render_sync_wait_ms).toBe(100);

      const deepRow = db.prepare(`
        WITH
        main_thread_utid(utid) AS (VALUES (1)),
        ${deepCtes}
        SELECT render_sync_wait_ms
        FROM render_sync_wait
      `).get() as {render_sync_wait_ms: number} | undefined;
      expect(deepRow?.render_sync_wait_ms).toBe(100);
    } finally {
      db.close();
    }
  });

  it('keeps material RenderThread sync and RT-heavy precedence aligned in batch and deep analysis', () => {
    const batchSql = String(getStep('batch_frame_root_cause').sql);
    const deepSql = String(getSkillStep(jankSkill, 'root_cause_summary').sql);

    expect(batchSql).toMatch(
      /main_q4b_pct\s*>\s*30[\s\S]*render_sync_wait_ms\s*>=\s*MAX\(\s*frame_budget_ms\s*\*\s*0\.20\s*,\s*dur_ms\s*\*\s*0\.25\s*\)/,
    );
    expect(batchSql).toMatch(
      /\(render_q1_pct\s*\+\s*render_q2_pct\)\s*>=\s*30\s+OR\s+render_sync_rt_work_ms\s*>\s*0/,
    );
    expect(deepSql).toMatch(
      /main_q4b\s*>\s*30[\s\S]*render_sync_wait_ms\s*>=\s*MAX\(\s*frame_budget_ms\s*\*\s*0\.20\s*,\s*frame_duration_ms\s*\*\s*0\.25\s*\)/,
    );
    expect(deepSql).toMatch(
      /\(render_q1\s*\+\s*render_q2\)\s*>=\s*30\s+OR\s+render_sync_rt_work_ms\s*>\s*0/,
    );
    expect(deepSql).toContain(
      "WHEN (render_q1 + render_q2) > 70 AND render_q4b < 20",
    );
    expect(deepSql).toContain("THEN 'render_thread_heavy'");
    expect(batchSql).not.toMatch(/render_sync_wait_ms\s*>\s*0\.2\s*\n\s*THEN 'render_sync_wait'/);
    expect(deepSql).not.toMatch(/render_sync_wait_ms\s*>\s*0\.2\s*\n\s*THEN 'render_sync_wait'/);
  });

  it('deduplicates only non-null display tokens across layers', () => {
    const sql = String(getStep('performance_summary').sql);
    const beginMarker = '-- APP_FRAME_DEDUP_CTES_BEGIN';
    const endMarker = '-- APP_FRAME_DEDUP_CTES_END';
    const start = sql.indexOf(beginMarker);
    const end = sql.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const productionCtes = sql
      .slice(start + beginMarker.length, end)
      .trim()
      .replace(/,\s*$/, '')
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');

    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE actual_frame_timeline_slice(
          upid INTEGER,
          display_frame_token INTEGER,
          surface_frame_token INTEGER,
          layer_name TEXT,
          ts INTEGER,
          dur INTEGER,
          jank_type TEXT,
          present_type TEXT
        );
        INSERT INTO process VALUES
          (1, 'com.example.app'),
          (2, 'com.example.app:renderer'),
          (3, 'com.example.application');
        INSERT INTO actual_frame_timeline_slice VALUES
          (1, 10, 100, 'main', 1000, 100, 'None', 'On-time Present'),
          (1, 10, 200, 'surface', 1000, 100, 'None', 'On-time Present'),
          (1, NULL, 7, 'main', 2000, 100, 'None', 'On-time Present'),
          (1, NULL, 7, 'surface', 2000, 100, 'None', 'On-time Present'),
          (1, 11, 300, 'main', 3000, 100, 'None', 'On-time Present'),
          (1, NULL, NULL, 'main', 4000, 100, 'None', 'On-time Present'),
          (2, 12, 400, 'child', 5000, 100, 'None', 'On-time Present'),
          (3, 13, 500, 'similar-prefix', 6000, 100, 'None', 'On-time Present');
      `);
      const row = db.prepare(`
        WITH ${productionCtes}
        SELECT COUNT(DISTINCT frame_key) AS frames
        FROM app_frame_rows
      `).get() as {frames: number};

      expect(row.frames).toBe(5);
    } finally {
      db.close();
    }
  });

  it('scopes input data to the exact app process and colon-delimited children', () => {
    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE android_input_events(
          process_name TEXT,
          receive_ts INTEGER,
          receive_dur INTEGER,
          dispatch_ts INTEGER,
          event_action TEXT,
          frame_id INTEGER
        );
        INSERT INTO android_input_events VALUES
          ('com.example.app',          100, 10, 110, 'DOWN', 1),
          ('com.example.app:remote',   200, 10, 210, 'MOVE', 2),
          ('com.example.application',  300, 10, 310, 'MOVE', 3),
          ('com.example.application',  400, 10, 410, 'MOVE', 4),
          ('com.example.application',  500, 10, 510, 'MOVE', 5);
      `);

      db.exec("ALTER TABLE android_input_events ADD COLUMN upid INTEGER; UPDATE android_input_events SET upid = CASE process_name WHEN 'com.example.app' THEN 1 WHEN 'com.example.app:remote' THEN 2 ELSE 3 END");
      completeAndroidInputEventsFixture(db);
      const row = db.prepare(renderScrollingSql('input_data_check')).get() as {
        total_input_events: number;
        target_processes: number;
      };

      expect(row.total_input_events).toBe(2);
      expect(row.target_processes).toBe(2);
    } finally {
      db.close();
    }
  });

  it('does not let a similar-prefix process win input latency target selection', () => {
    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE counter_track(id INTEGER, name TEXT);
        CREATE TABLE counter(track_id INTEGER, ts INTEGER);
        CREATE TABLE android_input_events(
          process_name TEXT,
          receive_ts INTEGER,
          receive_dur INTEGER,
          dispatch_ts INTEGER,
          total_latency_dur INTEGER,
          dispatch_latency_dur INTEGER,
          handling_latency_dur INTEGER,
          ack_latency_dur INTEGER,
          end_to_end_latency_dur INTEGER,
          event_action TEXT,
          frame_id INTEGER,
          is_speculative_frame INTEGER
        );
      `);
      const insert = db.prepare(`
        INSERT INTO android_input_events VALUES (?, ?, 10, ?, 1000000, 100000, ?, 100000, 1000000, 'MOVE', ?, 0)
      `);
      let ts = 100;
      for (const [processName, handlingDurations] of [
        ['com.example.app', [2000000, 3000000]],
        ['com.example.app:remote', [1000000, 10000000, 20000000]],
        ['com.example.application', Array(10).fill(30000000)],
      ] as const) {
        for (const handlingDuration of handlingDurations) {
          insert.run(processName, ts, ts + 10, handlingDuration, ts);
          ts += 100;
        }
      }

      db.exec("ALTER TABLE android_input_events ADD COLUMN upid INTEGER; UPDATE android_input_events SET upid = CASE process_name WHEN 'com.example.app' THEN 1 WHEN 'com.example.app:remote' THEN 2 ELSE 3 END");
      completeAndroidInputEventsFixture(db);
      const row = db.prepare(renderScrollingSql('input_latency_summary')).get() as {
        target_process: string;
        total_input_events: number;
        p95_handling_ms: number;
      };

      expect(row.target_process).toBe('com.example.app:remote');
      expect(row.total_input_events).toBe(3);
      expect(row.p95_handling_ms).toBe(19);
    } finally {
      db.close();
    }
  });

  it('reads frame linkage, backlog and input-to-present only from exact frame associations', () => {
    type Row = [frameId: number | null, speculative: number | null, e2eNs: number | null];
    const run = (stepId: string, rows: Row[]) => {
      const db = createScopedSqlFixture();
      try {
        db.exec(`
          CREATE TABLE counter_track(id INTEGER, name TEXT);
          CREATE TABLE counter(track_id INTEGER, ts INTEGER);
          ${androidInputEventsTableDdl()}
        `);
        const insert = db.prepare(`
          INSERT INTO android_input_events(process_name, upid, event_action, dispatch_ts, receive_ts, receive_dur,
            handling_latency_dur, total_latency_dur, frame_id, is_speculative_frame, end_to_end_latency_dur)
          VALUES ('com.example.app', 1, 'MOVE', ?, ?, 10, 100000, 1000000, ?, ?, ?)
        `);
        rows.forEach(([frameId, speculative, e2e], index) =>
          insert.run(100 + index * 100, 100 + index * 100, frameId, speculative, e2e));
        return db.prepare(renderScrollingSql(stepId)).get() as Record<string, unknown>;
      } finally {
        db.close();
      }
    };

    // A whole gesture speculatively matched to the one doFrame after it: no
    // backlog, no measured input-to-present, and frame linkage is not available.
    const speculativeOnly: Row[] = Array(18).fill([7, 1, 50_000_000]);
    expect(run('input_latency_summary', speculativeOnly)).toMatchObject({
      input_backlog_frames: 0, speculative_frame_matches: 18, max_e2e_ms: null,
    });
    expect(run('input_data_check', speculativeOnly)).toMatchObject({
      input_data_status: 'speculative_only', frame_matched_events: 0,
    });

    const mixed: Row[] = [[7, 0, 10_000_000], [7, 0, 12_000_000], [7, 0, 11_000_000], [8, 1, 90_000_000]];
    expect(run('input_latency_summary', mixed)).toMatchObject({
      input_backlog_frames: 1, speculative_frame_matches: 1, max_e2e_ms: 12,
    });
    expect(run('input_data_check', mixed)).toMatchObject({input_data_status: 'available', frame_matched_events: 3});

    // A frame without the speculative flag is not assumed exact.
    expect(run('input_latency_summary', [[7, null, 10_000_000], [7, null, 10_000_000], [7, null, 10_000_000]]))
      .toMatchObject({input_backlog_frames: 0, max_e2e_ms: null});
    expect(run('input_data_check', [[null, null, null]])).toMatchObject({input_data_status: 'no_frame_match'});
  });

  // One physical touch is delivered to the app window and to monitor channels;
  // only the app's row carries the action (surface-view trace, runtime 99234d73fe).
  type InputDelivery = readonly [
    upid: number, processName: string, channel: string, eventId: string, action: string | null, latency: number,
  ];
  const createMonitorCopyInputFixture = (deliveries: readonly InputDelivery[]): Database.Database => {
    const db = createScopedSqlFixture();
    db.exec(`
      CREATE TABLE counter_track(id INTEGER, name TEXT);
      CREATE TABLE counter(track_id INTEGER, ts INTEGER);
      CREATE TABLE android_input_events(
        upid INTEGER, process_name TEXT, event_channel TEXT, input_event_id TEXT,
        event_action TEXT, total_latency_dur INTEGER,
        dispatch_ts INTEGER, receive_ts INTEGER, receive_dur INTEGER
      );
    `);
    const insert = db.prepare('INSERT INTO android_input_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10)');
    deliveries.forEach(([upid, processName, channel, eventId, action, latency], index) =>
      insert.run(upid, processName, channel, eventId, action, latency, 100 * (index + 1), 100 * (index + 1)));
    completeAndroidInputEventsFixture(db);
    return db;
  };

  const monitorCopyDeliveries: InputDelivery[] = [
    ...['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].flatMap((action, index): InputDelivery[] => [
      [1, 'com.example.app', 'app (server)', String(index + 1), action, 1000000],
      [2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', String(index + 1), null, 3000000],
      [3, 'system_server', 'PointerEventDispatcher0 (server)', String(index + 1), null, 2000000],
    ]),
    [2, 'com.android.systemui', 'NavigationBar0 (server)', '1', null, 3000000],
  ];

  it('selects the input latency target by application deliveries, not monitor copies', () => {
    const db = createMonitorCopyInputFixture(monitorCopyDeliveries);
    try {
      const row = db.prepare(renderScrollingSql('input_latency_summary', '')).get() as {
        target_process: string;
        total_input_events: number;
        move_events: number;
      };

      expect(row.target_process).toBe('com.example.app');
      expect(row.total_input_events).toBe(3);
      expect(row.move_events).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps an explicit package authoritative when its input rows are all monitor copies', () => {
    const db = createMonitorCopyInputFixture(monitorCopyDeliveries);
    try {
      const row = db.prepare(renderScrollingSql('input_latency_summary', 'com.android.systemui')).get() as {
        target_process: string;
        total_input_events: number;
      };

      expect(row.target_process).toBe('com.android.systemui');
      // Four rows, three physical events: the navigation bar repeats event 1.
      expect(row.total_input_events).toBe(3);
    } finally {
      db.close();
    }
  });

  it('leaves out the target\'s own monitor channel once it has application deliveries', () => {
    // The launcher owns its window and a gesture monitor: 1-3 resolve an action
    // on the window and are copied to the monitor, 4-5 resolve none and reach
    // both, 6 reaches only the window.
    const launcher = 'com.example.launcher';
    const db = createMonitorCopyInputFixture([
      ...['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].map((action, index): InputDelivery =>
        [1, launcher, 'Launcher (server)', String(index + 1), action, 1000000]),
      ...['4', '5', '6'].map((eventId): InputDelivery => [1, launcher, 'Launcher (server)', eventId, null, 1000000]),
      ...['1', '2', '3', '4', '5'].map((eventId): InputDelivery =>
        [1, launcher, '[Gesture Monitor] swipe-up (server)', eventId, null, 9000000]),
    ]);
    try {
      const row = db.prepare(renderScrollingSql('input_latency_summary', '')).get() as {
        target_process: string;
        total_input_events: number;
        move_events: number;
      };

      expect(row).toMatchObject({target_process: launcher, total_input_events: 6, move_events: 1});
    } finally {
      db.close();
    }
  });

  it('keeps a pinned instance that only observed input when a same-named instance has deliveries', () => {
    const launcher = 'com.example.launcher';
    const db = createMonitorCopyInputFixture([
      ...['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].map((action, index): InputDelivery =>
        [1, launcher, 'Launcher (server)', String(index + 1), action, 1000000]),
      ...['1', '2', '3'].map((eventId): InputDelivery =>
        [1, launcher, '[Gesture Monitor] swipe-up (server)', eventId, null, 9000000]),
      ...['1', '2'].map((eventId): InputDelivery =>
        [3, launcher, '[Gesture Monitor] swipe-up (server)', eventId, null, 9000000]),
    ]);
    try {
      const render = (upid: string) =>
        renderScrollingSql('input_latency_summary', launcher).split('${__process_scope.upid}').join(upid);
      expect(db.prepare(render('NULL')).get()).toMatchObject({total_input_events: 3});
      expect(db.prepare(render('3')).get()).toMatchObject({target_process: launcher, total_input_events: 2});
    } finally {
      db.close();
    }
  });

  it('counts the input precheck in physical events of the rows the analysis reads', () => {
    // The launcher owns its window and a gesture monitor: 1-3 resolve an action
    // on the window and are copied to the monitor, 4-5 resolve none and reach
    // both, 6 (FOCUS) reaches only the window. 7 is a touch on another app's
    // window that both monitors also observe. systemui observes 1-5 and 7.
    // Rows: launcher 12, app 1, systemui 6; physical events: 7.
    const launcher = 'com.example.launcher';
    const db = createMonitorCopyInputFixture([
      ...['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].map((action, index): InputDelivery =>
        [1, launcher, 'Launcher (server)', String(index + 1), action, 2000000]),
      ...['4', '5', '6'].map((eventId): InputDelivery => [1, launcher, 'Launcher (server)', eventId, null, 4000000]),
      [3, 'com.example.app', 'app (server)', '7', 'ACTION_DOWN', 2000000],
      ...['1', '2', '3', '4', '5', '7'].flatMap((eventId): InputDelivery[] => [
        [1, launcher, '[Gesture Monitor] swipe-up (server)', eventId, null, 9000000],
        [2, 'com.android.systemui', '[Gesture Monitor] edge-swipe (server)', eventId, null, 3000000],
      ]),
    ]);
    try {
      const run = (stepId: string, scope: {upid?: number; packageName?: string}) => {
        const step = getStep(stepId);
        return db.prepare(renderStepSql(String(step.sql), step.sql_fragments, {
          '__process_scope.upid': scope.upid ?? 'NULL',
          package: scope.packageName ?? '',
          start_ts: 'NULL',
          end_ts: 'NULL',
        })).get() as Record<string, unknown>;
      };

      // Selected app: its own monitor channel adds no events (not even 7, which
      // only it saw), and the count is what input_latency_summary then reads.
      for (const scope of [{packageName: launcher}, {upid: 1}]) {
        expect(run('input_data_check', scope)).toMatchObject({
          input_data_status: 'no_frame_match', total_input_events: 6, move_events: 1, target_processes: 1,
        });
        expect(run('input_latency_summary', scope)).toMatchObject({target_process: launcher, total_input_events: 6});
      }
      // Unscoped: each physical event once; the observer is not an input target.
      expect(run('input_data_check', {})).toMatchObject({
        input_data_status: 'no_frame_match', total_input_events: 7, move_events: 1, target_processes: 2,
      });
      // An explicitly chosen observer still returns its observations.
      for (const scope of [{packageName: 'com.android.systemui'}, {upid: 2}]) {
        expect(run('input_data_check', scope)).toMatchObject({
          input_data_status: 'no_frame_match', total_input_events: 6, move_events: 0, target_processes: 1,
        });
      }
      expect(run('input_data_check', {packageName: 'com.example.absent'})).toMatchObject({
        input_data_status: 'unavailable', total_input_events: 0, target_processes: 0,
      });
    } finally {
      db.close();
    }
  });

  it('counts an observer target in physical events across its channels, latency per delivery', () => {
    // systemui observes the app's touches on a gesture monitor and its
    // navigation bar; events 1-2 are slow and map both channels to the same
    // exact frame, event 3 to a speculative one.
    const db = createMonitorCopyInputFixture(['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].flatMap(
      (action, index): InputDelivery[] => [
        [1, 'com.example.app', 'app (server)', String(index + 1), action, 1000000],
        [2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', String(index + 1), null, 3000000],
        [2, 'com.android.systemui', 'NavigationBar0 (server)', String(index + 1), null, 3000000],
      ]));
    try {
      db.exec(`UPDATE android_input_events SET handling_latency_dur = 10000000, frame_id = 7,
        is_speculative_frame = 0 WHERE upid = 2 AND input_event_id IN ('1', '2');
        UPDATE android_input_events SET frame_id = 8, is_speculative_frame = 1
        WHERE upid = 2 AND input_event_id = '3'`);
      const check = db.prepare(renderScrollingSql('input_data_check', 'com.android.systemui')).get();
      const summary = db.prepare(renderScrollingSql('input_latency_summary', 'com.android.systemui')).get();

      expect(check).toMatchObject({total_input_events: 3, move_events: 0, frame_matched_events: 2});
      // Two events on frame 7 is no backlog, however many channels saw them.
      expect(summary).toMatchObject({
        target_process: 'com.android.systemui', total_input_events: 3, move_events: 0, input_backlog_frames: 0,
        slow_handling_events: 2, speculative_frame_matches: 1, max_handling_ms: 10,
      });
    } finally {
      db.close();
    }
  });

  it('ranks action-free input by physical events, so extra monitor channels do not win', () => {
    // No receiver carries an action (runtimes that resolve none): the app has
    // more distinct events, systemui more rows through two channels.
    const db = createMonitorCopyInputFixture([
      ...['1', '2', '3', '4'].map((eventId): InputDelivery => [1, 'com.example.app', 'app (server)', eventId, null, 1000000]),
      ...['1', '2', '3'].flatMap((eventId): InputDelivery[] => [
        [2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', eventId, null, 3000000],
        [2, 'com.android.systemui', 'NavigationBar0 (server)', eventId, null, 3000000],
      ]),
    ]);
    try {
      const row = db.prepare(renderScrollingSql('input_latency_summary', '')).get() as {target_process: string};

      expect(row.target_process).toBe('com.example.app');
    } finally {
      db.close();
    }
  });

  // Action-free input where monitors see as many or more physical events than
  // the app: only the receiver of a '<hash> <package>/<component>' window owns it.
  const appWindow = '32c6ecb com.tencent.mm/com.tencent.mm.plugin.lite.ui.WxaLiteAppLiteUI (server)';

  it('ranks action-free input by owned window events before monitor event counts', () => {
    // v58.2 runtime on the surface-view trace: equal counts, monitors slower.
    const tied = createMonitorCopyInputFixture(['1', '2', '3'].flatMap((eventId): InputDelivery[] => [
      [1, 'com.tencent.mm', appWindow, eventId, null, 1000000],
      [2, 'com.android.systemui', '[Gesture Monitor] swipe-to-screenshot (server)', eventId, null, 3000000],
      [3, 'system_server', 'PointerEventDispatcher0 (server)', eventId, null, 2000000],
    ]));
    // A child process on its package window; the monitor also saw a touch elsewhere.
    const childProcess = createMonitorCopyInputFixture([
      ...['1', '2'].map((eventId): InputDelivery =>
        [1, 'com.tencent.mm:appbrand0', 'a1 com.tencent.mm/com.tencent.mm.plugin.appbrand.ui.AppBrandUI00 (server)', eventId, null, 1000000]),
      ...['1', '2', '3'].map((eventId): InputDelivery =>
        [2, 'system_server', '[Gesture Monitor] OplusExInputReceiver1', eventId, null, 3000000]),
    ]);
    try {
      const target = (db: Database.Database, packageName: string) =>
        (db.prepare(renderScrollingSql('input_latency_summary', packageName)).get() as {target_process: string})
          .target_process;

      expect(target(tied, '')).toBe('com.tencent.mm');
      expect(target(tied, 'com.android.systemui')).toBe('com.android.systemui');
      expect(target(childProcess, '')).toBe('com.tencent.mm:appbrand0');
    } finally {
      tied.close();
      childProcess.close();
    }
  });

  it('counts similar-prefix CPU work as non-app background interference', () => {
    const cte = extractMarkedCtes(
      String(getStep('global_context_flags').sql),
      '-- 4. 非 App 大核 CPU 占用（后台干扰指标）',
      '\nSELECT',
    );
    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE thread_state(utid INTEGER, state TEXT, dur INTEGER, cpu INTEGER, ts INTEGER);
        CREATE TABLE thread(utid INTEGER, upid INTEGER);
        CREATE TABLE process(upid INTEGER, name TEXT);
        CREATE TABLE _cpu_topology(cpu_id INTEGER, core_type TEXT);
        INSERT INTO _cpu_topology VALUES (0, 'big');
        INSERT INTO process VALUES
          (1, 'com.example.app'),
          (2, 'com.example.app:remote'),
          (3, 'com.example.application'),
          (4, 'com.other');
        INSERT INTO thread VALUES (1, 1), (2, 2), (3, 3), (4, 4);
        INSERT INTO thread_state VALUES
          (1, 'Running', 100, 0, 0),
          (2, 'Running', 100, 0, 0),
          (3, 'Running', 100, 0, 0),
          (4, 'Running', 100, 0, 0);
        ALTER TABLE thread ADD COLUMN is_idle INTEGER DEFAULT 0;
        CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
        INSERT INTO cpu VALUES(0,0,0,0,1024),(1,1,0,1,300);
        CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
        INSERT INTO trace_bounds VALUES(0,100);
        CREATE TABLE sched_slice(id INTEGER,utid INTEGER,cpu INTEGER,ucpu INTEGER,ts INTEGER,dur INTEGER,end_state TEXT,priority INTEGER);
        INSERT INTO sched_slice SELECT rowid,utid,cpu,cpu,ts,dur,'S',120 FROM thread_state;
      `);

      const run = (packageName: string) => db.prepare(`
        WITH system_windows(window_id,window_start_ts,window_end_ts) AS (VALUES(0,0,100)),
        ${fs.readFileSync(path.join(process.cwd(), 'skills/fragments/system_sched_spans.sql'), 'utf8')},
        ${cte
          .split('${package}').join(packageName)
          .split('${start_ts}').join('NULL')
          .split('${end_ts}').join('NULL')}
        SELECT non_app_big_core_pct FROM background_cpu
      `).get() as {non_app_big_core_pct: number};

      expect(run('com.example.app').non_app_big_core_pct).toBe(50);
      expect(run('').non_app_big_core_pct).toBe(0);
    } finally {
      db.close();
    }
  });

  it('scopes Binder statistics to the exact app and colon-delimited children', () => {
    const cte = extractMarkedCtes(
      String(getStep('root_cause_classification').sql),
      '-- Binder 调用统计',
      '-- 综合分析',
    );
    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE android_binder_txns(client_process TEXT, client_dur INTEGER, client_ts INTEGER);
        INSERT INTO android_binder_txns VALUES
          ('com.example.app',          10000000, 100),
          ('com.example.app:remote',   20000000, 200),
          ('com.example.application',  30000000, 300),
          ('com.other',                40000000, 400);
      `);
      db.exec("ALTER TABLE android_binder_txns ADD COLUMN client_upid INTEGER; UPDATE android_binder_txns SET client_upid = CASE client_process WHEN 'com.example.app' THEN 1 WHEN 'com.example.app:remote' THEN 2 ELSE 3 END");
      const renderedCte = cte
        .split('${package}').join('com.example.app')
        .split('${start_ts}').join('NULL')
        .split('${end_ts}').join('NULL');
      const row = db.prepare(`
        WITH ${renderedCte}
        SELECT total_calls, total_dur_ms FROM binder_stats
      `).get() as {total_calls: number; total_dur_ms: number};

      expect(row.total_calls).toBe(2);
      expect(row.total_dur_ms).toBe(30);
    } finally {
      db.close();
    }
  });

  it('never scopes scrolling SQL or strategy fallback with a bare package prefix', () => {
    const legacyPrefixMatches = [
      "p.name GLOB '${package}*'",
      "p.name NOT GLOB '${package}*'",
      "process_name GLOB '${package}*'",
      "client_process GLOB '${package}*'",
    ];
    for (const step of skill.steps ?? []) {
      const sql = String(step.sql ?? '');
      for (const legacyPrefixMatch of legacyPrefixMatches) {
        expect(sql).not.toContain(legacyPrefixMatch);
      }
      expect(sql).not.toMatch(
        /(?:p\.name|process_name|client_process)\s+(?:NOT\s+)?LIKE\s+'\$\{package\}%'/,
      );
    }
    expect(scrollingStrategy).not.toContain("p.name GLOB '{process_name}*'");
    expect(scrollingStrategy).not.toMatch(/LIKE\s+'\{process_name\}%'/);
  });

  it('excludes only inter-session idle excess from the FrameTimeline FPS window', () => {
    const sql = String(getStep('performance_summary').sql);
    const beginMarker = '-- FRAME_TIME_RANGE_CTES_BEGIN';
    const endMarker = '-- FRAME_TIME_RANGE_CTES_END';
    const start = sql.indexOf(beginMarker);
    const end = sql.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const timingCtes = sql
      .slice(start + beginMarker.length, end)
      .trim()
      .replace(/,\s*$/, '');

    const db = createScopedSqlFixture();
    try {
      const row = db.prepare(`
        WITH
        timing_config(vsync_period_ns) AS (VALUES (10000000)),
        app_frame_rows(frame_key, ts, dur) AS (
          VALUES
            ('display:1',          0, 1000000),
            ('display:1',          0,  500000),
            ('display:2',   30000000, 1000000),
            ('display:3',   60000000, 1000000),
            ('display:4',  510000000, 1000000),
            ('display:5',  540000000, 1000000),
            ('display:6',  990000000, 1000000),
            ('display:7', 1020000000, 1000000)
        ),
        ${timingCtes}
        SELECT
          (SELECT COUNT(*) FROM display_frame_times) AS frame_count,
          raw_duration_ns,
          inter_session_idle_ns,
          session_break_count,
          duration_ns,
          ROUND(
            1e9 * (SELECT COUNT(*) FROM display_frame_times) / NULLIF(duration_ns, 0),
            1
          ) AS actual_fps
        FROM time_range
      `).get();

      expect(row).toEqual({
        frame_count: 7,
        raw_duration_ns: 1021000000,
        inter_session_idle_ns: 898000000,
        session_break_count: 2,
        duration_ns: 123000000,
        actual_fps: 56.9,
      });
    } finally {
      db.close();
    }
  });

  it('uses the latest present frontier when frame presents are non-monotonic', () => {
    const sql = String(getStep('performance_summary').sql);
    const beginMarker = '-- FRAME_TIME_RANGE_CTES_BEGIN';
    const endMarker = '-- FRAME_TIME_RANGE_CTES_END';
    const start = sql.indexOf(beginMarker);
    const end = sql.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const timingCtes = sql
      .slice(start + beginMarker.length, end)
      .trim()
      .replace(/,\s*$/, '');

    const db = createScopedSqlFixture();
    try {
      const row = db.prepare(`
        WITH
        timing_config(vsync_period_ns) AS (VALUES (10000000)),
        app_frame_rows(frame_key, ts, dur) AS (
          VALUES
            ('display:1',         0,   1000000),
            ('display:2',  30000000,   1000000),
            ('display:3',  60000000, 200000000),
            ('display:4',  90000000,   1000000),
            ('display:5', 120000000,   1000000),
            ('display:6', 570000000,   1000000)
        ),
        ${timingCtes}
        SELECT
          raw_duration_ns,
          inter_session_idle_ns,
          session_break_count,
          duration_ns
        FROM time_range
      `).get();

      expect(row).toEqual({
        raw_duration_ns: 571000000,
        inter_session_idle_ns: 310000000,
        session_break_count: 1,
        duration_ns: 261000000,
      });
    } finally {
      db.close();
    }
  });

  it('selects one package-scoped BufferTX track by positive frame deltas', () => {
    const fallback = getStep('buffer_tx_performance_fallback');
    expect(fallback.save_as).toBe('perf_summary');
    expect(String(fallback.condition)).toMatch(/buffer_tx_coverage.*should_fallback/);
    expect(fallback.sql_fragments).toContain('fragments/buffer_tx_frame_production.sql');
    const sql = String(fallback.sql);
    const fragment = fs.readFileSync(
      path.join(process.cwd(), 'skills', 'fragments', 'buffer_tx_frame_production.sql'),
      'utf-8',
    );
    const beginMarker = '-- BUFFER_TX_FALLBACK_CTES_BEGIN';
    const endMarker = '-- BUFFER_TX_FALLBACK_CTES_END';
    const start = fragment.indexOf(beginMarker);
    const end = fragment.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const productionCtes = fragment
      .slice(start + beginMarker.length, end)
      .trim()
      .replace(/,\s*$/, '')
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');

    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE counter_track(id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
      `);
      const insertTrack = (
        trackId: number,
        name: string,
        risingFrames: number,
        stepNs: number,
      ) => {
        db.prepare('INSERT INTO counter_track(id, name) VALUES (?, ?)').run(trackId, name);
        const insert = db.prepare('INSERT INTO counter(id, track_id, ts, value) VALUES (?, ?, ?, ?)');
        for (let index = 0; index <= risingFrames * 2; index += 1) {
          insert.run(trackId * 1000 + index, trackId, index * stepNs, index % 2);
        }
      };
      insertTrack(1, 'BufferTX - com.example.app/Main#1', 5, 10_000_000);
      insertTrack(2, 'BufferTX - com.example.app/Secondary#2', 4, 10_000_000);
      insertTrack(3, 'QueuedBuffer - com.example.app/Main#3', 12, 10_000_000);
      insertTrack(4, 'BufferTX - com.example.other/Main#4', 12, 10_000_000);
      insertTrack(5, 'BufferTX - com.example.app/ShortBurst#5', 20, 1_000_000);
      insertTrack(6, 'BufferTX - com.example.application/Main#6', 30, 10_000_000);

      const selectPrimaryTrack = () => db.prepare(`
        WITH
        vsync_config(vsync_period_ns) AS (VALUES (8333333)),
        ${productionCtes}
        SELECT track_id, track_name, produced_frames
        FROM selected_buffer_tx_track
      `).get() as {track_id: number; track_name: string; produced_frames: number};

      expect(selectPrimaryTrack()).toEqual({
        track_id: 1,
        track_name: 'BufferTX - com.example.app/Main#1',
        produced_frames: 5,
      });

      insertTrack(7, 'BufferTX - com.example.app:renderer/Main#7', 6, 10_000_000);
      expect(selectPrimaryTrack()).toEqual({
        track_id: 7,
        track_name: 'BufferTX - com.example.app:renderer/Main#7',
        produced_frames: 6,
      });
    } finally {
      db.close();
    }

    expect(sql).toMatch(/NULL\s+as\s+perceived_jank_frames/i);
    expect(sql).toMatch(/NULL\s+as\s+app_janky_frames/i);
    expect(sql).toMatch(/NULL\s+as\s+sf_jank_count/i);
    expect(sql).toContain("'buffer_tx_rising_edge_fallback' as fps_source");
  });

  it('scopes fallback FrameTimeline coverage to exact and child processes', () => {
    const sql = String(getStep('buffer_tx_performance_fallback').sql);
    const start = sql.indexOf('frame_timeline_coverage AS (');
    const end = sql.indexOf('fallback_summary AS (', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const coverageCte = sql
      .slice(start, end)
      .trim()
      .replace(/,\s*$/, '')
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');

    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE actual_frame_timeline_slice(
          upid INTEGER,
          display_frame_token INTEGER,
          surface_frame_token INTEGER,
          layer_name TEXT,
          ts INTEGER,
          dur INTEGER
        );
        INSERT INTO process VALUES
          (1, 'com.example.app'),
          (2, 'com.example.app:renderer'),
          (3, 'com.example.application');
        INSERT INTO actual_frame_timeline_slice VALUES
          (1, 1, 101, 'exact', 1000, 100),
          (2, 2, 102, 'child', 2000, 100),
          (3, 3, 103, 'similar-prefix', 3000, 100);
      `);

      const row = db.prepare(`
        WITH ${coverageCte}
        SELECT frame_timeline_frames
        FROM frame_timeline_coverage
      `).get() as {frame_timeline_frames: number};

      expect(row.frame_timeline_frames).toBe(2);
    } finally {
      db.close();
    }
  });

  it('uses exact target identity and mutually exclusive frame coverage modes', () => {
    const environmentSql = String(getStep('vsync_config').sql)
      .trim()
      .replace(/^WITH\s+/i, '')
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');
    const runEnvironment = (processName: string) => {
      const db = createScopedSqlFixture();
      try {
        db.exec(`
          CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE actual_frame_timeline_slice(
            upid INTEGER,
            display_frame_token INTEGER,
            surface_frame_token INTEGER,
            layer_name TEXT,
            ts INTEGER,
            dur INTEGER
          );
        `);
        db.prepare('INSERT INTO process VALUES (1, ?)').run(processName);
        db.exec(`
          INSERT INTO actual_frame_timeline_slice
          VALUES (1, 1, 1, 'main', 1000, 100)
        `);
        return db.prepare(`
          WITH
          vsync_config(vsync_period_ns, vsync_source) AS (
            VALUES (8333333, 'trace_wide_vsync_counter')
          ),
          ${environmentSql}
        `).get() as {total_frames: number; has_data: number};
      } finally {
        db.close();
      }
    };

    expect(runEnvironment('com.example.application')).toMatchObject({
      total_frames: 0,
      has_data: 0,
    });
    expect(runEnvironment('com.example.app')).toMatchObject({
      total_frames: 1,
      has_data: 1,
    });
    expect(runEnvironment('com.example.app:renderer')).toMatchObject({
      total_frames: 1,
      has_data: 1,
    });

    const probe = getStep('buffer_tx_coverage_probe');
    const sql = String(probe.sql)
      .trim()
      .replace(/^WITH\s+/i, '')
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');
    const runCoverage = (
      frameTimelineFrames: number,
      bufferTxFrames: number | null,
      processName = 'com.example.app',
    ) => {
      const db = createScopedSqlFixture();
      try {
        db.exec(`
          CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE actual_frame_timeline_slice(
            upid INTEGER,
            display_frame_token INTEGER,
            surface_frame_token INTEGER,
            layer_name TEXT,
            ts INTEGER,
            dur INTEGER
          );
        `);
        db.prepare('INSERT INTO process VALUES (1, ?)').run(processName);
        const insert = db.prepare(`
          INSERT INTO actual_frame_timeline_slice
            (upid, display_frame_token, surface_frame_token, layer_name, ts, dur)
          VALUES (1, ?, ?, 'main', ?, 100)
        `);
        for (let index = 1; index <= frameTimelineFrames; index += 1) {
          insert.run(index, index, index * 1000);
        }
        const selectedCte = bufferTxFrames === null
          ? `selected_buffer_tx_track(track_id, track_name, produced_frames, effective_span_ns) AS (
              SELECT NULL, NULL, NULL, NULL WHERE 0
            )`
          : `selected_buffer_tx_track(track_id, track_name, produced_frames, effective_span_ns) AS (
              VALUES (7, 'BufferTX - com.example.app/Main#7', ${bufferTxFrames}, 1000000000)
            )`;
        return db.prepare(`WITH ${selectedCte}, ${sql}`).get() as {
          frame_timeline_frames: number;
          frame_timeline_to_buffer_tx_ratio: number | null;
          target_process_count: number;
          target_process_status: string;
          coverage_status: string;
          root_cause_evidence_scope: string;
          should_fallback: number;
        };
      } finally {
        db.close();
      }
    };

    expect(runCoverage(0, 100)).toEqual(expect.objectContaining({
      frame_timeline_frames: 0,
      coverage_status: 'no_frame_timeline_coverage',

      root_cause_evidence_scope: 'coverage_unverified',
      should_fallback: 1,
    }));
    expect(runCoverage(36, 100)).toEqual(expect.objectContaining({
      frame_timeline_to_buffer_tx_ratio: 0.36,
      coverage_status: 'partial_frame_timeline_coverage',

      root_cause_evidence_scope: 'partial_sample',
      should_fallback: 1,
    }));
    expect(runCoverage(90, 100)).toEqual(expect.objectContaining({
      frame_timeline_to_buffer_tx_ratio: 0.9,
      coverage_status: 'sufficient_frame_timeline_coverage',

      root_cause_evidence_scope: 'full_frame_timeline',
      should_fallback: 0,
    }));
    expect(runCoverage(2, null)).toEqual(expect.objectContaining({
      target_process_status: 'found',
      coverage_status: 'no_buffer_tx_candidate',

      root_cause_evidence_scope: 'frame_timeline_only_unbenchmarked',
      should_fallback: 0,
    }));
    expect(runCoverage(1, null, 'com.example.application')).toEqual(expect.objectContaining({
      target_process_count: 0,
      target_process_status: 'not_found',
      coverage_status: 'target_process_not_found',

      root_cause_evidence_scope: 'coverage_unverified',
      should_fallback: 0,
    }));
    expect(runCoverage(1, null, 'com.example.app:renderer')).toEqual(expect.objectContaining({
      target_process_count: 1,
      target_process_status: 'found',
      coverage_status: 'no_buffer_tx_candidate',

      root_cause_evidence_scope: 'frame_timeline_only_unbenchmarked',
      should_fallback: 0,
    }));
  });

  it('does not recommend an unavailable frame fallback when the target process is absent', () => {
    const renderSql = (targetProcessStatus: string) => String(getStep('fallback_no_frame_timeline').sql)
      .split('${package}').join('com.example.app')
      .split('${buffer_tx_coverage.data[0].target_process_status|}').join(targetProcessStatus);
    const db = createScopedSqlFixture();
    try {
      db.exec('CREATE TABLE actual_frame_timeline_slice(id INTEGER)');
      const targetMissingRows = db.prepare(renderSql('not_found')).all() as Array<Record<string, unknown>>;
      expect(targetMissingRows).toHaveLength(1);
      expect(JSON.stringify(targetMissingRows)).toContain('com.example.app');
      expect(JSON.stringify(targetMissingRows)).not.toContain('frame_slice');

      db.exec('CREATE TABLE frame_slice(id INTEGER)');
      const targetFoundRows = db.prepare(renderSql('found')).all() as Array<Record<string, unknown>>;
      expect(targetFoundRows).toHaveLength(2);
      expect(targetFoundRows[1]).toMatchObject({missing_table: 'frame_slice (可用)'});
    } finally {
      db.close();
    }
  });

  it('marks sparse jank summaries and root rows as partial evidence', () => {
    for (const stepId of ['jank_type_stats', 'batch_frame_root_cause']) {
      const step = getStep(stepId);
      expect(getColumn(step, 'frame_timeline_coverage_status').hidden).toBe(true);
      expect(getColumn(step, 'frame_timeline_to_buffer_tx_ratio').hidden).toBe(true);
      expect(getColumn(step, 'evidence_scope').hidden).toBe(true);
    }

    const fallback = getStep('buffer_tx_performance_fallback');
    for (const column of [
      'duration_sec',
      'vsync_source',
      'frame_source_track',
      'frame_timeline_to_buffer_tx_ratio',
      'coverage_status',
      'evidence_status',
      'present_interval_source',
    ]) {
      getColumn(fallback, column);
    }
    // Both perf_summary producers describe where their present intervals came from.
    getColumn(getStep('performance_summary'), 'present_interval_source');
  });

  it('calls coverage full only after a sufficient FrameTimeline/BufferTX comparison', () => {
    const cases: Array<[string, string]> = [
      ['sufficient_frame_timeline_coverage', 'full_frame_timeline'],
      ['partial_frame_timeline_coverage', 'partial_sample'],
      ['no_buffer_tx_candidate', 'frame_timeline_only_unbenchmarked'],
      ['frame_timeline_only_exact_upid', 'frame_timeline_only_unbenchmarked'],
      ['no_frame_timeline_coverage', 'coverage_unverified'],
      ['target_process_not_found', 'coverage_unverified'],
    ];
    const probe = getStep('buffer_tx_coverage_probe') as any;
    const db = new Database(':memory:');
    try {
      // The probe maps its own coverage status, in both branches.
      for (const [branch, sql] of [['sql', probe.sql], ['exact_sql', probe.exact_sql.sql]]) {
        const mapping = /(CASE coverage_status[\s\S]*?END) AS root_cause_evidence_scope/.exec(String(sql))?.[1];
        expect([branch, mapping === undefined]).toEqual([branch, false]);
        for (const [status, expected] of cases) {
          const scope = db.prepare(`SELECT ${mapping} AS v FROM (SELECT ? AS coverage_status)`).pluck().get(status);
          expect([branch, status, scope]).toEqual([branch, status, expected]);
        }
      }
      // A consumer reads that scope; a probe that produced no row (it is
      // optional) leaves coverage unverified.
      for (const stepId of ['jank_type_stats', 'batch_frame_root_cause']) {
        for (const value of ['partial_sample', undefined]) {
          const sql = substituteSqlPlaceholders(String(getStep(stepId).sql), placeholder =>
            placeholder.path === 'buffer_tx_coverage.data[0].root_cause_evidence_scope' && value !== undefined
              ? value
              : absentPlaceholderSql(placeholder));
          const scope = /'([^']*)' as evidence_scope/.exec(sql)?.[1];
          expect([stepId, value, scope]).toEqual([stepId, value, value ?? 'coverage_unverified']);
        }
      }
    } finally {
      db.close();
    }
  });

  it('does not present capped root-cause rows as an all-frame distribution', () => {
    expect(scrollingStrategy).toContain('root_cause_analysis_scope');
    expect(scrollingStrategy).toContain('root_cause_analyzed_frame_count');
    expect(scrollingStrategy).toContain('root_cause_eligible_frame_count');
    expect(scrollingStrategy).toContain('root_cause_coverage_ratio');
    expect(scrollingStrategy).toContain('截断时禁止外推样本百分比');
    expect(scrollingStrategy).not.toContain('覆盖所有掉帧帧');
    expect(scrollingStrategy).not.toContain('batch_frame_root_cause 提供了全量分类');
  });

  it('keeps jank summaries and root rows at one row per display frame', () => {
    const extractCtes = (sql: string, beginMarker: string, endMarker: string) => {
      const start = sql.indexOf(beginMarker);
      const end = sql.indexOf(endMarker, start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return sql.slice(start + beginMarker.length, end).trim().replace(/,\s*$/, '');
    };
    const db = createScopedSqlFixture();
    try {
      db.function('android_is_app_jank_type', (value: unknown) =>
        /App Deadline Missed|App Resynced Jitter/.test(String(value)) ? 1 : 0);
      db.function('android_is_sf_jank_type', (value: unknown) =>
        /SurfaceFlinger|Prediction Error|Display HAL/.test(String(value)) ? 1 : 0);
      db.exec(`
        CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT, pid INTEGER);
        INSERT INTO process VALUES (1, 'com.example.app', 10);
      `);

      const jankStatsCtes = extractCtes(
        String(getStep('jank_type_stats').sql),
        '-- JANK_TYPE_DISPLAY_DEDUP_CTES_BEGIN',
        '-- JANK_TYPE_DISPLAY_DEDUP_CTES_END',
      );
      const jankStats = db.prepare(`
        WITH
        jank_row_signals(frame_key, jank_type, dur, layer_name, row_is_consumer_jank) AS (
          VALUES
            ('display:10', 'Self Jank', 100, 'main', 1),
            ('display:10', 'SurfaceFlinger Stuffing', 200, 'surface', 1)
        ),
        ${jankStatsCtes}
        SELECT COUNT(*) AS rows, SUM(is_consumer_jank) AS real_jank_count
        FROM jank_analysis
      `).get() as {rows: number; real_jank_count: number};
      expect(jankStats).toEqual({rows: 1, real_jank_count: 1});

      const getAppCte = extractCtes(
        String(getStep('get_app_jank_frames').sql),
        '-- GET_APP_DISPLAY_DEDUP_CTE_BEGIN',
        '-- GET_APP_DISPLAY_DEDUP_CTE_END',
      ).split('${package}').join('com.example.app');
      const getApp = db.prepare(`
        WITH
        frame_thread_info(
          frame_key, upid, jank_responsibility, vsync_missed, actual_dur, layer_name
        ) AS (
          VALUES
            ('display:10', 1, 'APP', 1, 100, 'main'),
            ('display:10', 1, 'SF', 2, 200, 'surface')
        ),
        ${getAppCte}
        SELECT COUNT(*) AS rows
        FROM deduped_frames
        WHERE display_frame_rank = 1
      `).get() as {rows: number};
      expect(getApp.rows).toBe(1);

      const batchCte = extractCtes(
        String(getStep('batch_frame_root_cause').sql),
        '-- BATCH_DISPLAY_DEDUP_CTE_BEGIN',
        '-- BATCH_DISPLAY_DEDUP_CTE_END',
      );
      const batch = db.prepare(`
        WITH
        all_jank_frames(frame_key, jank_responsibility, vsync_missed, frame_dur, layer_name) AS (
          VALUES
            ('display:10', 'APP', 1, 100, 'main'),
            ('display:10', 'SF', 2, 200, 'surface')
        ),
        ${batchCte}
        SELECT COUNT(*) AS rows
        FROM deduped_jank_frames
        WHERE display_frame_rank = 1
      `).get() as {rows: number};
      expect(batch.rows).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps null-display frame identity and per-frame metrics isolated across layers', () => {
    const getAppSql = String(getStep('get_app_jank_frames').sql);
    expect(getAppSql).toContain('frame_identity_key');

    const batchStep = getStep('batch_frame_root_cause');
    const identityColumn = getColumn(batchStep, 'frame_identity_key');
    expect(identityColumn.type).toBe('string');
    expect(identityColumn.hidden).toBe(true);
    const layerColumn = getColumn(batchStep, 'layer_name');
    expect(layerColumn.type).toBe('string');
    expect(layerColumn.hidden).toBe(true);

    const sql = String(batchStep.sql);
    const extractCte = (beginMarker: string, endMarker: string) => {
      const start = sql.indexOf(beginMarker);
      const end = sql.indexOf(endMarker, start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return sql.slice(start + beginMarker.length, end).trim().replace(/,\s*$/, '');
    };
    const frequencyCte = extractCte(
      '-- BATCH_FRAME_IDENTITY_FREQ_CTE_BEGIN',
      '-- BATCH_FRAME_IDENTITY_FREQ_CTE_END',
    );
    const fileIoCte = extractCte(
      '-- BATCH_FRAME_IDENTITY_FILE_IO_CTE_BEGIN',
      '-- BATCH_FRAME_IDENTITY_FILE_IO_CTE_END',
    );

    const db = createScopedSqlFixture();
    try {
      db.exec(`
        CREATE TABLE counter(track_id INTEGER, ts INTEGER, value REAL);
        CREATE TABLE cpu_counter_track(id INTEGER, name TEXT, cpu INTEGER);
        CREATE TABLE _cpu_topology(cpu_id INTEGER, core_type TEXT);
        CREATE TABLE thread_track(id INTEGER, utid INTEGER);
        CREATE TABLE slice(track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
        INSERT INTO cpu_counter_track VALUES (1, 'cpufreq', 0);
        INSERT INTO _cpu_topology VALUES (0, 'big');
        INSERT INTO counter VALUES (1, 1100000, 2000000);
        CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
        INSERT INTO cpu VALUES (0,0,0,0,1024),(1,1,0,1,300);
        CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
        INSERT INTO trace_bounds VALUES (0,2000000);
        CREATE TABLE cpu_frequency_counters(cpu INTEGER,ts INTEGER,dur INTEGER,freq INTEGER);
        INSERT INTO cpu_frequency_counters VALUES (0,1100000,900000,2000000);
        ALTER TABLE cpu_frequency_counters ADD COLUMN id INTEGER;
        ALTER TABLE cpu_frequency_counters ADD COLUMN track_id INTEGER;
        ALTER TABLE cpu_frequency_counters ADD COLUMN ucpu INTEGER;
        UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu;
        INSERT INTO thread_track VALUES (10, 99);
        INSERT INTO slice VALUES (10, 1100000, 600000, 'fsync');
      `);

      const rows = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end, upid) AS (
          VALUES
            ('surface:Layer A:7', 1000000, 1050000, 42),
            ('surface:Layer B:7', 1000000, 1200000, 42)
        ),
        per_frame_thread_roles(frame_key, role, utid) AS (
          VALUES
            ('surface:Layer A:7', 'main', 99),
            ('surface:Layer B:7', 'main', 99)
        ),
        system_windows AS (
          SELECT frame_key AS window_id,frame_start AS window_start_ts,frame_end AS window_end_ts FROM jank_frame_list
        ),
        ${fs.readFileSync(path.join(process.cwd(), 'skills/fragments/system_sched_spans.sql'), 'utf8')},
        ${fs.readFileSync(path.join(process.cwd(), 'skills/fragments/system_cpu_frequency_spans.sql'), 'utf8')},
        ${frequencyCte},
        ${fileIoCte}
        SELECT
          fl.frame_key,
          COALESCE(pff.big_max_freq_mhz, 0) AS big_max_freq_mhz,
          COALESCE(pfio.file_io_overlap_ms, 0) AS file_io_overlap_ms
        FROM jank_frame_list fl
        LEFT JOIN per_frame_freq pff ON pff.frame_key = fl.frame_key
        LEFT JOIN per_frame_file_io pfio ON pfio.frame_key = fl.frame_key
        ORDER BY fl.frame_key
      `).all() as Array<{
        frame_key: string;
        big_max_freq_mhz: number;
        file_io_overlap_ms: number;
      }>;

      expect(rows).toEqual([
        {frame_key: 'surface:Layer A:7', big_max_freq_mhz: 0, file_io_overlap_ms: 0},
        {frame_key: 'surface:Layer B:7', big_max_freq_mhz: 2000, file_io_overlap_ms: 0.1},
      ]);
    } finally {
      db.close();
    }

    for (const cte of [
      'per_frame_thread_roles',
      'top_slices',
      'per_frame_cpu_mix',
      'per_frame_quadrants',
      'render_thread_quadrants',
      'per_frame_freq',
      'per_frame_ramp',
      'per_frame_binder',
      'per_frame_gc',
      'gpu_fence_per_frame',
      'shader_per_frame',
      'per_frame_cpu_clusters',
      'per_frame_freq_changes',
      'per_frame_main_top_slices',
      'per_frame_render_top_slices',
      'per_frame_binder_detail',
      'per_frame_gc_detail',
      'per_frame_lock_detail',
      'per_frame_render_sync_wait',
      'per_frame_file_io',
      'per_frame_input_events',
      'per_frame_input_slices',
      'per_frame_input_detail',
      'per_frame_input_slice_detail',
    ]) {
      expect(sql).toMatch(new RegExp(`${cte}\\s+AS\\s*\\([\\s\\S]*?frame_key`, 'm'));
    }
  });

  it('uses Perfetto jank helpers and stable priority for combined responsibility labels', () => {
    expect(skill.prerequisites?.modules).toContain('android.frames.jank_type');
    const sql = String(getStep('batch_frame_root_cause').sql);
    const beginMarker = '-- JANK_RESPONSIBILITY_CASE_BEGIN';
    const endMarker = '-- JANK_RESPONSIBILITY_CASE_END';
    const start = sql.indexOf(beginMarker);
    const end = sql.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const responsibilityCase = sql.slice(start + beginMarker.length, end).trim();

    const db = createScopedSqlFixture();
    try {
      db.function('android_is_app_jank_type', (value: unknown) =>
        /App Deadline Missed|App Resynced Jitter/.test(String(value)) ? 1 : 0);
      db.function('android_is_sf_jank_type', (value: unknown) =>
        /SurfaceFlinger|Prediction Error|Display HAL/.test(String(value)) ? 1 : 0);
      const rows = db.prepare(`
        WITH samples(jank_type) AS (
          VALUES
            ('Self Jank, Prediction Error'),
            ('Prediction Error, App Deadline Missed'),
            ('SurfaceFlinger Scheduling, Buffer Stuffing'),
            ('Buffer Stuffing, Prediction Error'),
            ('Prediction Error'),
            ('Display HAL'),
            ('Unknown Jank')
        )
        SELECT jank_type, ${responsibilityCase} AS responsibility
        FROM samples a
      `).all();

      expect(rows).toEqual([
        {jank_type: 'Self Jank, Prediction Error', responsibility: 'APP'},
        {jank_type: 'Prediction Error, App Deadline Missed', responsibility: 'APP'},
        {jank_type: 'SurfaceFlinger Scheduling, Buffer Stuffing', responsibility: 'SF'},
        {jank_type: 'Buffer Stuffing, Prediction Error', responsibility: 'BUFFER_STUFFING'},
        {jank_type: 'Prediction Error', responsibility: 'SF'},
        {jank_type: 'Display HAL', responsibility: 'SF'},
        {jank_type: 'Unknown Jank', responsibility: 'UNKNOWN'},
      ]);
    } finally {
      db.close();
    }

    for (const reasonCode of [
      'prediction_error',
      'display_hal',
      'app_jank_unattributed',
      'frame_timeline_unattributed',
    ]) {
      expect(sql).toContain(`THEN '${reasonCode}'`);
    }
    const appUnattributedIndex = sql.indexOf("THEN 'app_jank_unattributed'");
    const frameTimelineUnattributedIndex = sql.indexOf("THEN 'frame_timeline_unattributed'");
    const genericUnknownIndex = sql.indexOf("ELSE 'unknown'", frameTimelineUnattributedIndex);
    expect(frameTimelineUnattributedIndex).toBeGreaterThan(appUnattributedIndex);
    expect(genericUnknownIndex).toBeGreaterThan(frameTimelineUnattributedIndex);
    expect(sql).toContain(
      "WHEN jank_responsibility = 'UNKNOWN' AND jank_type GLOB '*Unknown Jank*'",
    );
    expect(sql).toContain('异常保留但根因未归因');
    expect(String(getStep('get_app_jank_frames').sql)).toContain('android_is_missed_frame_type');
    expect(sql).toContain('android_is_missed_frame_type');

    const getAppSql = String(getStep('get_app_jank_frames').sql);
    const causeBegin = getAppSql.indexOf('-- JANK_CAUSE_CASE_BEGIN');
    const causeEnd = getAppSql.indexOf('-- JANK_CAUSE_CASE_END', causeBegin);
    expect(causeBegin).toBeGreaterThanOrEqual(0);
    expect(causeEnd).toBeGreaterThan(causeBegin);
    const causeCase = getAppSql.slice(
      causeBegin + '-- JANK_CAUSE_CASE_BEGIN'.length,
      causeEnd,
    ).trim();
    const causeDb = createScopedSqlFixture();
    try {
      const causes = causeDb.prepare(`
        WITH samples(
          jank_type, jank_responsibility, actual_dur, vsync_missed,
          guilty_frame_id, guilty_dur, over_budget_ms
        ) AS (
          VALUES
            ('Self Jank, Prediction Error', 'APP', 20000000, 1, NULL, NULL, NULL),
            ('Buffer Stuffing, Prediction Error', 'BUFFER_STUFFING', 20000000, 2, NULL, NULL, NULL),
            ('Prediction Error', 'SF', 7000000, 1, NULL, NULL, NULL)
        )
        SELECT ${causeCase} AS cause
        FROM samples
      `).all() as Array<{cause: string}>;
      expect(causes[0].cause).toContain('App');
      expect(causes[0].cause).not.toContain('预测时间漂移');
      expect(causes[1].cause).toContain('原始 Buffer Stuffing 标签');
      expect(causes[1].cause).toContain('呈现间隔估算');
      expect(causes[1].cause).toContain('dequeue/release-fence');
      expect(causes[1].cause).toContain('标签不证明 BufferQueue 阻塞或排除 App 原因');
      expect(causes[1].cause).not.toContain('预测时间漂移');
      expect(causes[2].cause).toContain('SurfaceFlinger 调度器预测时间漂移');
    } finally {
      causeDb.close();
    }
  });

  it('keeps a stuffing batch diagnosis observational until backpressure is measured', () => {
    const sql = String(getStep('batch_frame_root_cause').sql);
    const branch = sql.match(/WHEN reason_code = 'buffer_stuffing' THEN ([^\n]+)/);
    expect(branch).not.toBeNull();
    const db = createScopedSqlFixture();
    try {
      const row = db.prepare(`WITH frame(dur_ms) AS (VALUES (19.67))
        SELECT ${branch![1]} AS cause FROM frame`).get() as {cause: string};
      expect(row.cause).toContain('原始 Buffer Stuffing 标签，帧耗时 19.67ms');
      expect(row.cause).toContain('presentation_cadence_audit 与 dequeue/release-fence');
      expect(row.cause).toContain('尚未证明 BufferQueue 背压，也不能排除 App 原因');
      expect(row.cause).not.toContain('非 App 问题');
      expect(row.cause).not.toContain('积压导致跳帧');
    } finally { db.close(); }
  });

  it('keeps the documented SQL fallback on the same terminal-code and drill policy', () => {
    const strategy = fs.readFileSync(
      path.join(process.cwd(), 'strategies', 'scrolling.strategy.md'),
      'utf-8',
    );

    expect(strategy).toContain("a.jank_type GLOB '*Prediction Error*'");
    expect(strategy).toContain("a.jank_type GLOB '*Display HAL*'");
    expect(strategy).toContain("a.jank_type GLOB '*App Resynced Jitter*'");
    expect(strategy).toContain("THEN 'BUFFER_STUFFING'");
    expect(strategy).toContain('不得固定跑 top 5');
    expect(strategy).toContain('不能把密集或连续 Prediction Error 一概称为“统计噪声/统计假象”');
    expect(strategy).toContain('不能用“仅 N 帧真实/可感知”排除其余呈现间隔异常');
    expect(strategy).toContain('已有 `scrolling_analysis:vsync_config` artifact 时直接复用');
    expect(strategy).toContain('不要在 `expectedCalls` 中无条件预占 standalone `vsync_config`');
    expect(strategy).toContain('目标存在但 FrameTimeline/BufferTX 不可用时，只停止依赖帧源的统计和深钻');
    expect(strategy).toContain('继续读取主线程工作证据');
    expect(strategy).toContain('`vsync_source = default_60hz_no_trace_timing` 只是内部默认预算');
    expect(strategy).toContain('不得把 60Hz 当作设备或本次场景事实交付');
    expect(strategy).toContain('`frame_timeline_unattributed`');
    expect(strategy).toContain('不能写成噪声、假帧或不可感知');
    expect(strategy).not.toContain('对 top 5 卡顿帧调用 jank_frame_detail（必须执行）');
    expect(strategy).not.toContain('不执行逐帧分析就直接出结论是不允许的');
  });

  it('routes high raw stuffing tags to the cadence audit in the fast-visible core', () => {
    const core = scrollingStrategy.split('#### Scrolling Core Strategy')[1].split('<!-- strategy-detail')[0];
    expect(core).toContain('标签占比 >50%');
    expect(core).toContain('`consumer_jank_detection`');
    expect(core).toContain('`presentation_cadence_audit`');
    expect(core).toContain('含 Stuffing 的混合 Deadline 标签也不能直接证明画面停顿');
    expect(core).toContain('`package` 或 `layer_name`');
    const insight = getStep('performance_summary').synthesize.insights.find(
      (entry: any) => entry.condition === 'buffer_stuffing_rate > 50',
    );
    expect(insight.template).toContain('原始 Buffer Stuffing 标签占比');
    expect(insight.template).toContain('presentation_cadence_audit');
    expect(insight.template).not.toContain('帧呈现被队列推迟为主');
  });

  it('uses Late/Dropped present as the non-Buffer-Stuffing consumer-jank authority', () => {
    expect(consumerJankSkill.prerequisites?.modules).toContain('android.frames.jank_type');
    expect(flutterSkill.prerequisites?.modules).toContain('android.frames.jank_type');

    const summaryStep = getSkillStep(consumerJankSkill, 'consumer_jank_summary');
    expect(summaryStep.display?.columns?.map((column: any) => column.name)).toContain('total_frames');
    expect(String(summaryStep.sql)).toMatch(
      /SELECT\s+total_frames,\s+total_frames as vsync_total_frames/,
    );

    for (const sql of [
      String(getSkillStep(consumerJankSkill, 'consumer_jank_frames').sql),
      String(getSkillStep(consumerJankSkill, 'consumer_jank_summary').sql),
      String(getSkillStep(consumerJankSkill, 'jank_severity_distribution').sql),
      String(getSkillStep(flutterSkill, 'flutter_consumer_jank').sql),
    ]) {
      if (sql.includes('-- CONSUMER_JANK_')) {
        expect(sql).toContain("present_type = 'Dropped Frame' THEN 1");
        expect(sql).toContain("jank_type NOT GLOB '*Buffer Stuffing*'");
        expect(sql).toContain('END as row_is_steady_stuffing');
      } else {
        expect(sql).toContain("present_type IN ('Late Present', 'Dropped Frame')");
        expect(sql).toContain("jank_responsibility = 'BUFFER_STUFFING'");
        expect(sql).toContain('android_is_missed_frame_type');
      }
    }
  });

  it('does not turn On-time Present cadence gaps into hidden jank', () => {
    const frameCtes = renderAtomicConsumerCtes(
      'consumer_jank_frames',
      '-- CONSUMER_JANK_FRAME_CTES_BEGIN',
      '-- CONSUMER_JANK_FRAME_CTES_END',
    );
    const summaryCtes = renderAtomicConsumerCtes(
      'consumer_jank_summary',
      '-- CONSUMER_JANK_SUMMARY_CTES_BEGIN',
      '-- CONSUMER_JANK_SUMMARY_CTES_END',
    );
    const severityCtes = renderAtomicConsumerCtes(
      'jank_severity_distribution',
      '-- CONSUMER_JANK_SEVERITY_CTES_BEGIN',
      '-- CONSUMER_JANK_SEVERITY_CTES_END',
    );

    const db = createConsumerJankFixture();
    try {
      const frames = db.prepare(`
        WITH
        vsync_period(vsync_period_ns) AS (VALUES (8333333)),
        ${frameCtes}
        SELECT
          frame_id,
          app_jank_type,
          present_type,
          is_consumer_jank,
          vsync_missed,
          jank_responsibility
        FROM frame_signals
        ORDER BY frame_id
      `).all();
      expect(frames).toEqual([
        {frame_id: 1, app_jank_type: 'None', present_type: 'On-time Present', is_consumer_jank: 0, vsync_missed: 0, jank_responsibility: 'HIDDEN'},
        {frame_id: 2, app_jank_type: 'None', present_type: 'On-time Present', is_consumer_jank: 0, vsync_missed: 0, jank_responsibility: 'HIDDEN'},
        {frame_id: 3, app_jank_type: 'None', present_type: 'Late Present', is_consumer_jank: 1, vsync_missed: 1, jank_responsibility: 'HIDDEN'},
        {frame_id: 4, app_jank_type: 'Buffer Stuffing', present_type: 'Late Present', is_consumer_jank: 0, vsync_missed: 0, jank_responsibility: 'BUFFER_STUFFING'},
        {frame_id: 5, app_jank_type: 'Buffer Stuffing', present_type: 'Late Present', is_consumer_jank: 1, vsync_missed: 1, jank_responsibility: 'BUFFER_STUFFING'},
        {frame_id: 6, app_jank_type: 'App Deadline Missed', present_type: 'Late Present', is_consumer_jank: 1, vsync_missed: 1, jank_responsibility: 'APP'},
      ]);

      const summary = db.prepare(`
        WITH
        vsync_period(vsync_period_ns) AS (VALUES (8333333)),
        ${summaryCtes}
        SELECT * FROM frame_stats
      `).get();
      expect(summary).toEqual({
        total_frames: 6,
        raw_buffer_stuffing_frames: 2,
        consumer_jank_frames: 3,
        unassessed_frames: 0,
        smooth_frames: 3,
        app_reported_jank: 3,
        false_positives: 0,
        false_negatives: 1,
        max_vsync_missed: 1,
        avg_token_gap: 1.5,
      });

      const severity = db.prepare(`
        WITH
        vsync_period(vsync_period_ns) AS (VALUES (8333333)),
        ${severityCtes}
        SELECT severity, COUNT(*) AS count
        FROM severity_analysis
        GROUP BY severity
        ORDER BY severity
      `).all();
      expect(severity).toEqual([
        {severity: 'MINOR_JANK (missed=1)', count: 3},
        {severity: 'SMOOTH_OR_ON_TIME', count: 3},
      ]);
    } finally {
      db.close();
    }
  });

  const runCadenceAudit = (db: Database.Database) => {
    const sql = String(getSkillStep(consumerJankSkill, 'presentation_cadence_audit').sql);
    const ctesAndSelect = sql.slice(sql.indexOf('-- PRESENTATION_CADENCE_CTES_BEGIN'))
      .split('${package}').join('com.example.app')
      .split('${layer_name}').join('')
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');
    return db.prepare(`WITH cadence_timing(vsync_period_ns) AS (VALUES (8333333)), ${ctesAndSelect}`).all() as any[];
  };

  const createSteadyLateFixture = () => {
    const db = createConsumerJankFixture();
    db.exec(`
      DELETE FROM actual_frame_timeline_slice;
      ALTER TABLE actual_frame_timeline_slice ADD COLUMN id INTEGER;
      CREATE TABLE expected_frame_timeline_slice(
        upid INTEGER, layer_name TEXT, surface_frame_token INTEGER, ts INTEGER, dur INTEGER
      );
    `);
    const actual = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)');
    const expected = db.prepare('INSERT INTO expected_frame_timeline_slice VALUES (1, ?, ?, ?, ?)');
    for (let i = 0; i < 10; i++) {
      const layer = 'TX - com.example.app/Main#1';
      actual.run(i + 1, i + 101, layer, i * 8333333, 24999999,
        i === 4 ? 'App Deadline Missed, Buffer Stuffing' : 'Buffer Stuffing', 'Late Present', i + 1);
      expected.run(layer, i + 101, i * 8333333, 8333333);
    }
    return db;
  };

  it('separates steady late presentation from raw mixed deadline tags', () => {
    const db = createSteadyLateFixture();
    try {
      const [audit] = runCadenceAudit(db);
      expect(audit).toMatchObject({
        total_frames: 10, raw_buffer_stuffing_frames: 10, buffer_stuffing_label_pct: 100,
        steady_late_frames: 8, cadence_status: 'steady_late', cadence_gap_frames: 0,
        missed_frame_type_frames: 1, late_present_frames: 10, dropped_frames: 0, manual_review_required: 1,
        matched_expected_frames: 10, min_late_vsyncs: 2, max_late_vsyncs: 2,
      });
      const frameCtes = renderAtomicConsumerCtes('consumer_jank_frames',
        '-- CONSUMER_JANK_FRAME_CTES_BEGIN', '-- CONSUMER_JANK_FRAME_CTES_END');
      const mixed = db.prepare(`WITH vsync_period(vsync_period_ns) AS (VALUES (8333333)),
        ${frameCtes} SELECT is_consumer_jank, app_jank_type, jank_responsibility FROM frame_signals WHERE frame_id = 5`).get();
      expect(mixed).toEqual({is_consumer_jank: 0, app_jank_type: 'App Deadline Missed, Buffer Stuffing', jank_responsibility: 'APP'});
    } finally { db.close(); }
  });

  const consumerViews = (db: Database.Database, period: number | null = 8333333) => {
    const query = (id: string, marker: string, select: string) => db.prepare(`
      WITH vsync_period(vsync_period_ns) AS (VALUES (${period ?? 'NULL'})),
      ${renderAtomicConsumerCtes(id, `-- CONSUMER_JANK_${marker}_CTES_BEGIN`, `-- CONSUMER_JANK_${marker}_CTES_END`)}
      ${select}`).all() as any[];
    return {
      frames: query('consumer_jank_frames', 'FRAME', 'SELECT * FROM frame_signals ORDER BY frame_id'),
      summary: query('consumer_jank_summary', 'SUMMARY', 'SELECT * FROM frame_stats')[0],
      severity: query('jank_severity_distribution', 'SEVERITY', 'SELECT severity, COUNT(*) AS count FROM severity_analysis GROUP BY severity'),
    };
  };

  it('keeps mixed-tag gaps and drops while all three views agree on unknown and steady frames', () => {
    const db = createSteadyLateFixture();
    try {
      const steady = consumerViews(db);
      expect(steady.summary).toMatchObject({consumer_jank_frames: 0, unassessed_frames: 1,
        smooth_frames: 9, app_reported_jank: 10, false_positives: 8});
      expect(steady.severity).toContainEqual({severity: 'UNASSESSED', count: 1});
      db.exec(`UPDATE actual_frame_timeline_slice SET ts = ts + 8333333 WHERE id >= 5;
        UPDATE actual_frame_timeline_slice SET present_type = 'Dropped Frame' WHERE id = 8;`);
      const result = consumerViews(db);
      expect(result.frames.find(row => row.frame_id === 5).is_consumer_jank).toBe(1);
      expect(result.frames.find(row => row.frame_id === 8).is_consumer_jank).toBe(1);
      expect(result.frames.find(row => row.frame_id === 9).is_consumer_jank).toBe(1);
      expect(result.summary.consumer_jank_frames).toBe(3);
      expect(result.frames.filter(row => row.is_consumer_jank === 1)).toHaveLength(3);
      expect(result.severity).toContainEqual({severity: 'MINOR_JANK (missed=1)', count: 3});
    } finally { db.close(); }
  });

  it('requires review for majority raw stuffing while retaining measured gaps and drops', () => {
    const db = createSteadyLateFixture();
    try {
      db.exec(`UPDATE actual_frame_timeline_slice SET jank_type = 'None', present_type = 'On-time Present' WHERE id = 1;
        UPDATE actual_frame_timeline_slice SET ts = ts + 8333333 WHERE id >= 5;
        UPDATE actual_frame_timeline_slice SET present_type = 'Dropped Frame' WHERE id = 8;`);
      const sql = String(getSkillStep(consumerJankSkill, 'consumer_jank_summary').sql);
      const tail = sql.slice(sql.indexOf('-- CONSUMER_JANK_SUMMARY_CTES_BEGIN'))
        .split('${package}').join('com.example.app').split('${layer_name}').join('')
        .split('${start_ts}').join('').split('${end_ts}').join('');
      const summary = db.prepare(`WITH vsync_period(vsync_period_ns) AS (VALUES (8333333)), ${tail}`).get();
      expect(summary).toMatchObject({total_frames: 10, raw_buffer_stuffing_frames: 9,
        consumer_jank_frames: 3, unassessed_frames: 0, manual_review_required: 1, rating: 'needs_review'});
    } finally { db.close(); }
  });

  it('keeps missing timing, long gaps, incomplete rows and process boundaries unassessed', () => {
    const db = createSteadyLateFixture();
    try {
      expect(consumerViews(db, null).summary).toMatchObject({
        consumer_jank_frames: 0, unassessed_frames: 10, smooth_frames: 0, false_positives: 0,
      });
      db.exec(`UPDATE actual_frame_timeline_slice SET ts = ts + 1000000000 WHERE id >= 7;
        UPDATE actual_frame_timeline_slice SET dur = -1 WHERE id = 3;
        UPDATE actual_frame_timeline_slice SET upid = 2 WHERE id = 10;`);
      const result = consumerViews(db);
      for (const id of [1, 3, 7, 10]) {
        expect(result.frames.find(row => row.frame_id === id).is_consumer_jank).toBeNull();
      }
      expect(result.summary.smooth_frames + result.summary.consumer_jank_frames + result.summary.unassessed_frames).toBe(10);
      expect(result.severity).toContainEqual({severity: 'UNASSESSED', count: result.summary.unassessed_frames});
    } finally { db.close(); }
  });

  it('does not substitute expected frame budgets for missing measured VSync', () => {
    const db = createSteadyLateFixture();
    try {
      db.exec('CREATE TABLE counter(ts INTEGER, track_id INTEGER); CREATE TABLE counter_track(id INTEGER, name TEXT);');
      db.aggregate('PERCENTILE', {
        start: () => [] as number[],
        step: (values: number[], value: number) => { values.push(value); return values; },
        result: (values: number[]) => values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null,
      });
      const render = (step: string) => String(getSkillStep(consumerJankSkill, step).sql)
        .split("'${start_ts}'").join("''").split("'${end_ts}'").join("''")
        .split('${start_ts}').join('NULL').split('${end_ts}').join('NULL')
        .split('${package}').join('com.example.app').split('${layer_name}').join('');
      expect(db.prepare(render('vsync_config')).get()).toEqual({vsync_period_ns: null, refresh_rate_hz: null});
      const summary = db.prepare(render('consumer_jank_summary')).get();
      expect(summary).toMatchObject({consumer_jank_frames: 0, smooth_frames: 0, unassessed_frames: 10,
        false_positives: 0, rating: 'needs_review'});
      expect(db.prepare(render('presentation_cadence_audit')).get()).toMatchObject({
        vsync_period_ns: null, steady_late_frames: 0, cadence_status: 'insufficient_cadence_evidence',
      });
    } finally { db.close(); }
  });

  it('orders actual presentations and excludes SF display rows from app frame aggregation', () => {
    const db = createSteadyLateFixture();
    try {
      // Reorder starts while retaining the same presentation sequence.
      db.exec(`UPDATE actual_frame_timeline_slice SET ts = ts - 20000000, dur = dur + 20000000 WHERE id = 5;
        INSERT INTO actual_frame_timeline_slice VALUES (99, 5, NULL, NULL, 0, 90000000, 'SurfaceFlinger CPU Deadline Missed', 'Late Present', 100);`);
      const result = consumerViews(db);
      expect(result.summary).toMatchObject({total_frames: 10, consumer_jank_frames: 0, unassessed_frames: 1});
      expect(result.frames.find(row => row.frame_id === 5).is_consumer_jank).toBe(0);
    } finally { db.close(); }
  });

  it('keeps cadence excursions, burst boundaries, drops and incomplete frames visible', () => {
    const db = createSteadyLateFixture();
    try {
      db.exec(`
        UPDATE actual_frame_timeline_slice SET dur = dur + 8333333 WHERE id = 5;
        UPDATE actual_frame_timeline_slice SET ts = ts + 1000000000 WHERE id >= 8;
        UPDATE actual_frame_timeline_slice SET present_type = 'Dropped Frame' WHERE id = 2;
        UPDATE actual_frame_timeline_slice SET dur = -1 WHERE id = 3;
      `);
      const rows = runCadenceAudit(db);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({dropped_frames: 1, incomplete_frames: 1});
      expect(rows[0].cadence_gap_frames).toBeGreaterThan(0);
      expect(rows[0].cadence_status).not.toBe('steady_late');
      expect(rows[1]).toMatchObject({preceding_burst_gaps: 1, cadence_status: 'insufficient_cadence_evidence'});
      expect(rows[1].preceding_burst_gap_ms).toBeGreaterThan(500);
    } finally { db.close(); }
  });

  it('does not invent lateness from missing or ambiguous expected frames or another layer', () => {
    const db = createSteadyLateFixture();
    try {
      db.exec(`
        INSERT INTO expected_frame_timeline_slice SELECT * FROM expected_frame_timeline_slice;
        INSERT INTO expected_frame_timeline_slice SELECT 2, layer_name, surface_frame_token, ts, dur
          FROM expected_frame_timeline_slice;
      `);
      expect(runCadenceAudit(db)[0]).toMatchObject({
        matched_expected_frames: 0, steady_late_frames: 0,
        min_late_vsyncs: null, max_late_vsyncs: null, cadence_status: 'steady_cadence',
      });
      db.exec("DELETE FROM expected_frame_timeline_slice; UPDATE actual_frame_timeline_slice SET layer_name = 'TX - com.example.app/Other#2' WHERE id = 1");
      const rows = runCadenceAudit(db);
      expect(rows.every(row => row.matched_expected_frames === 0 && row.max_late_vsyncs === null)).toBe(true);
      expect(rows.find(row => row.total_frames === 1)).toMatchObject({
        steady_late_frames: 0, cadence_status: 'insufficient_cadence_evidence',
      });
    } finally { db.close(); }
  });

  it('keeps Flutter consumer-jank counts on the same hybrid contract', () => {
    const overviewCtes = extractMarkedCtes(
      String(getSkillStep(flutterSkill, 'flutter_frame_overview').sql),
      '-- FLUTTER_OVERVIEW_CONSUMER_CTES_BEGIN',
      '-- FLUTTER_OVERVIEW_CONSUMER_CTES_END',
    )
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');
    const flutterCtes = extractMarkedCtes(
      String(getSkillStep(flutterSkill, 'flutter_consumer_jank').sql),
      '-- FLUTTER_CONSUMER_JANK_CTES_BEGIN',
      '-- FLUTTER_CONSUMER_JANK_CTES_END',
    )
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');

    const db = createConsumerJankFixture();
    try {
      const overview = db.prepare(`
        WITH
        flutter_timing(vsync_period_ns) AS (VALUES (8333333)),
        flutter_processes(upid) AS (VALUES (1)),
        ${overviewCtes}
        SELECT
          COUNT(*) AS total_frames,
          SUM(is_consumer_jank) AS jank_frames,
          SUM(CASE WHEN jank_type != 'None' THEN 1 ELSE 0 END) AS reported_jank_frames
        FROM flutter_frames
      `).get();
      expect(overview).toEqual({
        total_frames: 6,
        jank_frames: 3,
        reported_jank_frames: 3,
      });

      const rows = db.prepare(`
        WITH
        vsync_config(vsync_period_ns) AS (VALUES (8333333)),
        flutter_processes(upid) AS (VALUES (1)),
        ${flutterCtes}
        SELECT
          jank_type,
          COUNT(*) AS count,
          SUM(is_consumer_jank) AS real_jank_count,
          SUM(CASE WHEN jank_type = 'None' AND is_consumer_jank = 1 THEN 1 ELSE 0 END) AS hidden_jank_count,
          SUM(CASE WHEN jank_type != 'None' AND is_consumer_jank = 0 THEN 1 ELSE 0 END) AS false_positive
        FROM jank_analysis
        GROUP BY jank_type
        ORDER BY jank_type
      `).all();

      expect(rows).toEqual([
        {jank_type: 'App Deadline Missed', count: 1, real_jank_count: 1, hidden_jank_count: 0, false_positive: 0},
        {jank_type: 'Buffer Stuffing', count: 2, real_jank_count: 1, hidden_jank_count: 0, false_positive: 1},
        {jank_type: 'None', count: 3, real_jank_count: 1, hidden_jank_count: 1, false_positive: 0},
      ]);
    } finally {
      db.close();
    }
  });
});

describe('scrolling exact UPID SQL semantics', () => {
  const source = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite/scrolling_analysis.skill.yaml'), 'utf8')) as any;
  const render = (stepId: string, upid: number) => {
    const step = source.steps.find((item: any) => item.id === stepId);
    return withStepFragments(String(step.sql), step.sql_fragments)
      .split('${__process_scope.upid}').join(String(upid))
      .split('${package}').join('com.example.app')
      .split('${start_ts}').join('NULL').split('${end_ts}').join('NULL');
  };

  it('does not count same-name restarts, children or similar prefixes as exact input events', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE android_input_events(upid INTEGER, process_name TEXT, receive_ts INTEGER,
        receive_dur INTEGER, dispatch_ts INTEGER, event_action TEXT, frame_id INTEGER);
        INSERT INTO android_input_events VALUES
          (42,'com.example.app',100,10,90,'MOVE',1),
          (43,'com.example.app',100,10,90,'MOVE',1),
          (44,'com.example.app:child',100,10,90,'MOVE',1),
          (45,'com.example.application',100,10,90,'MOVE',1);`);
      completeAndroidInputEventsFixture(db);
      expect(db.prepare(render('input_data_check', 42)).get()).toMatchObject({ total_input_events: 1, target_processes: 1 });
    } finally { db.close(); }
  });

  it('binds Binder client UPID while retaining an external server', () => {
    const sql = render('root_cause_classification', 42);
    const begin = sql.indexOf('binder_stats AS (');
    const end = sql.indexOf('-- 综合分析', begin);
    const cte = sql.slice(begin, end).trim().replace(/,\s*$/, '');
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE android_binder_txns(client_upid INTEGER, client_process TEXT,
        server_upid INTEGER, server_process TEXT, client_dur INTEGER, client_ts INTEGER);
        INSERT INTO android_binder_txns VALUES
          (42,'com.example.app',90,'surfaceflinger',10000000,100),
          (43,'com.example.app',90,'surfaceflinger',50000000,100),
          (44,'com.example.app:child',90,'surfaceflinger',70000000,100);`);
      expect(db.prepare(`WITH ${cte} SELECT * FROM binder_stats`).get()).toMatchObject({ total_calls: 1, total_dur_ms: 10 });
    } finally { db.close(); }
  });

  it('ignores lock events from another UPID even when the process name matches', () => {
    const sql = render('batch_frame_root_cause', 42);
    const begin = sql.indexOf('per_frame_lock_overlap AS (');
    const end = sql.indexOf('-- 10g.5.', begin);
    const ctes = sql.slice(begin, end).trim().replace(/,\s*$/, '');
    const db = new Database(':memory:');
    try {
      const result = db.prepare(`WITH
        jank_frame_list(frame_key,frame_start,frame_end,upid) AS (VALUES ('frame',0,100000000,42)),
        android_monitor_contention(upid,ts,dur,process_name,is_blocked_thread_main,short_blocking_method,blocking_thread_name) AS (
          VALUES (42,0,10000000,'com.example.app',1,'target','owner'),
            (43,0,80000000,'com.example.app',1,'restarted','owner')),
        ${ctes} SELECT lock_contention_ms FROM per_frame_lock_detail`).get();
      expect(result).toMatchObject({ lock_contention_ms: 10 });
    } finally { db.close(); }
  });
});

describe('single-frame exact UPID SQL semantics', () => {
  const source = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite/jank_frame_detail.skill.yaml'), 'utf8')) as any;
  const step = (id: string) => source.steps.find((value: any) => value.id === id);
  const bindings = (upid: number | null, packageName: string, overrides: Record<string, string>) => ({
    '__process_scope.upid': upid === null ? 'NULL' : String(upid), package: packageName,
    start_ts: '0', end_ts: '100000000', main_start_ts: 'NULL', main_end_ts: 'NULL',
    render_start_ts: 'NULL', render_end_ts: 'NULL', dur_ms: '100',
    jank_type: 'App Deadline Missed', jank_responsibility: 'APP', ...overrides,
  });
  const render = (sql: string, upid: number | null, packageName = 'com.example.app') =>
    renderStepSql(sql, [], bindings(upid, packageName, {}));
  const sqlFor = (id: string, upid: number | null, packageName = 'com.example.app',
    overrides: Record<string, string> = {}) =>
    renderStepSql(String(step(id).sql), step(id).sql_fragments, bindings(upid, packageName, overrides));
  const rootCtes = (first: string, next: string, upid: number | null) => {
    const sql = String(step('root_cause_summary').sql);
    const start = sql.indexOf(`${first} AS (`);
    const end = sql.indexOf(`${next} AS (`, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return render(sql.slice(start, end).replace(/--[^\n]*/g, '').trim().replace(/,\s*$/, ''), upid);
  };
  const fixture = () => {
    const db = new Database(':memory:');
    // The maintained VSync fragment requests PERCENTILE(..., 50). SQLite's
    // fixture aggregate supplies that median without replacing timing rows.
    db.aggregate<number[]>('PERCENTILE', {varargs: true, start: () => [],
      step: (values, value) => typeof value === 'number' ? [...values, value] : values,
      result: values => {
        const ordered = values.slice().sort((left, right) => left - right);
        const middle = Math.floor(ordered.length / 2);
        return ordered.length ? ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2 : null;
      },
    });
    db.function('STR_SPLIT', (value: string, separator: string, index: number) => value.split(separator)[index] ?? null);
    // trace_processor intrinsic; NULL like a trace without clock snapshots,
    // so fragments/cpu_cluster_load.sql uses the wall-clock window.
    db.function('to_monotonic', (_ts: unknown) => null);
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
      INSERT INTO process VALUES (42,700,'com.example.app'),(43,700,'com.example.app'),
        (44,701,'com.example.app:child'),(45,702,'com.example.application'),(90,900,'surfaceflinger');
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, tid INTEGER, upid INTEGER, name TEXT);
      INSERT INTO thread VALUES (1,700,42,'main'),(2,710,42,'RenderThread'),(3,711,42,'1.ui'),(4,712,42,'1.raster'),
        (5,713,42,'worker'),(8,800,42,'HeapTaskDaemon'),(11,700,43,'main'),(12,710,43,'RenderThread'),
        (18,800,43,'HeapTaskDaemon'),(21,701,44,'main'),(31,702,45,'main'),(90,900,90,'surfaceflinger');
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
      INSERT INTO thread_track SELECT utid,utid FROM thread;
      CREATE TABLE slice(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
      INSERT INTO slice VALUES (1,1,10000000,20000000,'target_main'),(2,2,10000000,4000000,'DrawFrame'),
        (3,3,10000000,3000000,'target_flutter_ui'),(4,4,10000000,5000000,'target_flutter_raster'),
        (5,5,10000000,99000000,'excluded_worker'),(11,11,10000000,80000000,'restarted_main'),
        (12,12,10000000,80000000,'restarted_render'),(21,21,10000000,70000000,'child_main'),
        (31,31,10000000,70000000,'similar_prefix_main'),
        (41,1,10000000,1000000,'Choreographer#doFrame - resynced to 123 delayed 4'),
        (42,11,10000000,8000000,'Choreographer#doFrame - resynced to 999 delayed 8');
      CREATE TABLE android_binder_txns(client_upid INTEGER, client_utid INTEGER, client_tid INTEGER,
        client_process TEXT, server_process TEXT, client_ts INTEGER, client_dur INTEGER, is_sync INTEGER);
      INSERT INTO android_binder_txns VALUES (42,1,700,'com.example.app','surfaceflinger',10000000,10000000,1),
        (43,11,700,'com.example.app','surfaceflinger',10000000,80000000,1),
        (44,21,701,'com.example.app:child','external-child-server',10000000,70000000,1);
      CREATE TABLE android_monitor_contention(upid INTEGER,ts INTEGER,dur INTEGER,process_name TEXT,
        is_blocked_thread_main INTEGER,short_blocking_method TEXT,blocking_thread_name TEXT,
        short_blocked_method TEXT,blocked_thread_name TEXT,waiter_count INTEGER);
      INSERT INTO android_monitor_contention VALUES (42,10000000,10000000,'com.example.app',1,'externalLock','external-owner','targetWait','main',2),
        (43,10000000,80000000,'com.example.app',1,'wrongLock','restarted-owner','wrongWait','main',9);
      CREATE TABLE android_garbage_collection_events(tid INTEGER,utid INTEGER,upid INTEGER,gc_type TEXT,gc_ts INTEGER,gc_dur INTEGER);
      INSERT INTO android_garbage_collection_events VALUES (800,8,42,'young',10000000,10000000),
        (800,18,43,'young',10000000,80000000);
      CREATE TABLE _cpu_topology(cpu_id INTEGER,core_type TEXT,topology_source TEXT);
      INSERT INTO _cpu_topology VALUES (0,'big','capacity_scale'),(1,'little','capacity_scale');
      CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0,100000000);
      CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
      INSERT INTO cpu VALUES (0,0,0,0,1024),(1,1,0,1,300);
      CREATE TABLE cpu_frequency_counters(cpu INTEGER,ts INTEGER,dur INTEGER,freq INTEGER);
      INSERT INTO cpu_frequency_counters VALUES (0,0,50000000,1000000),(0,50000000,50000000,2000000),
        (1,0,50000000,500000),(1,50000000,50000000,600000);
      ALTER TABLE cpu_frequency_counters ADD COLUMN id INTEGER;
      ALTER TABLE cpu_frequency_counters ADD COLUMN track_id INTEGER;
      ALTER TABLE cpu_frequency_counters ADD COLUMN ucpu INTEGER;
      UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu;
      CREATE TABLE thread_state(utid INTEGER,ts INTEGER,dur INTEGER,state TEXT,cpu INTEGER,io_wait INTEGER,blocked_function TEXT);
      INSERT INTO thread_state VALUES (1,0,10000000,'Running',0,0,NULL),(11,0,40000000,'Running',0,0,NULL),
        (90,0,60000000,'Running',1,0,NULL),(1,20000000,2000000,'D',NULL,1,'filemap_fault'),
        (11,20000000,8000000,'D',NULL,1,'filemap_fault'),(5,20000000,9000000,'D',NULL,1,'filemap_fault');
      ALTER TABLE thread_state ADD COLUMN ucpu INTEGER;
      UPDATE thread_state SET ucpu=cpu;
      ALTER TABLE thread_state ADD COLUMN id INTEGER;
      ALTER TABLE thread_state ADD COLUMN irq_context INTEGER;
      ALTER TABLE thread_state ADD COLUMN waker_utid INTEGER;
      UPDATE thread_state SET id=rowid;
      ALTER TABLE thread ADD COLUMN is_idle INTEGER DEFAULT 0;
      CREATE TABLE sched_slice(id INTEGER,utid INTEGER,cpu INTEGER,ucpu INTEGER,ts INTEGER,dur INTEGER,end_state TEXT,priority INTEGER);
      INSERT INTO sched_slice SELECT rowid,utid,cpu,ucpu,ts,dur,'S',120 FROM thread_state WHERE state='Running';
      CREATE TABLE counter(track_id INTEGER,ts INTEGER,value REAL);
      INSERT INTO counter VALUES (100,0,0),(100,16666667,1),(100,33333334,0),
        (200,0,1000000),(200,50000000,2000000),(201,0,500000),(201,50000000,600000);
      CREATE TABLE counter_track(id INTEGER,name TEXT);
      INSERT INTO counter_track VALUES (100,'VSYNC-sf');
      CREATE TABLE cpu_counter_track(id INTEGER,cpu INTEGER,name TEXT);
      INSERT INTO cpu_counter_track VALUES (200,0,'cpufreq'),(201,1,'cpufreq');
      CREATE TABLE expected_frame_timeline_slice(ts INTEGER,dur INTEGER);
      INSERT INTO expected_frame_timeline_slice VALUES (0,16666667);
      -- The frequency-limit fragments read these; this trace has no limit or cooling track.
      ALTER TABLE counter_track ADD COLUMN type TEXT;
      ALTER TABLE counter_track ADD COLUMN dimension_arg_set_id INTEGER;
      ALTER TABLE cpu_counter_track ADD COLUMN type TEXT;
      ALTER TABLE counter ADD COLUMN id INTEGER;
      UPDATE counter SET id=rowid;
      CREATE TABLE args(arg_set_id INTEGER,key TEXT,string_value TEXT);
    `);
    return db;
  };

  it('preserves each target thread set, exact frame windows, and named/empty process selection', () => {
    const db = fixture();
    try {
      expect(db.prepare(sqlFor('main_thread_slices', 42)).all()).toEqual([
        expect.objectContaining({name: 'target_main', dur_ms: 20}),
        expect.objectContaining({name: 'target_flutter_ui', dur_ms: 3}),
      ]);
      expect(db.prepare(sqlFor('render_thread_slices', 42)).all()).toEqual([
        expect.objectContaining({name: 'target_flutter_raster', dur_ms: 5}),
        expect.objectContaining({name: 'DrawFrame', dur_ms: 4}),
      ]);
      expect(db.prepare(sqlFor('choreographer_resync_markers', 42)).all()).toEqual([
        expect.objectContaining({target_vsync: '123', resync_delay: '4', dur_ms: 1}),
      ]);
      expect(db.prepare(sqlFor('io_blocking', 42)).all()).toEqual([
        expect.objectContaining({thread_name: 'main', blocked_count: 1, total_ms: 2, max_ms: 2}),
      ]);
      const named = db.prepare(sqlFor('main_thread_slices', null)).all() as {name: string}[];
      expect(named.map(row => row.name).sort()).toEqual(['child_main', 'restarted_main', 'target_flutter_ui', 'target_main']);
      const unscoped = db.prepare(sqlFor('main_thread_slices', null, '')).all() as {name: string}[];
      expect(unscoped.map(row => row.name).sort()).toEqual([...named.map(row => row.name), 'similar_prefix_main'].sort());
      db.exec("INSERT INTO slice VALUES (100,1,100000000,90000000,'outside_frame')");
      expect(db.prepare(sqlFor('main_thread_slices', 42)).all()).toHaveLength(2);
    } finally {db.close();}
  });

  it('binds Binder client UPID and root UTID while retaining the external server', () => {
    const db = fixture();
    try {
      expect(db.prepare(sqlFor('binder_calls', 42)).all()).toEqual([
        {interface: 'surfaceflinger', count: 1, dur_ms: 10, max_ms: 10, sync_count: 1},
      ]);
      const effective = render(fs.readFileSync(path.join(process.cwd(), 'skills/fragments/effective_target_processes.sql'), 'utf8'), 42);
      const main = rootCtes('main_thread_utid', 'top_slice', 42);
      const binder = rootCtes('binder_sync_main', 'binder_frame', 42);
      expect(db.prepare(`WITH ${effective}, ${main}, ${binder} SELECT * FROM binder_sync_main`).all()).toEqual([
        {client_ts: 10000000, client_dur: 10000000, server_process: 'surfaceflinger'},
      ]);
      expect(step('binder_calls').process_scope.context_fields.peer_context).toContain('interface');
    } finally {db.close();}
  });

  it('uses lock and GC UPIDs despite reused process and thread IDs', () => {
    const db = fixture();
    try {
      expect(db.prepare(sqlFor('lock_contention', 42)).all()).toEqual([
        {blocking_method: 'externalLock', blocking_thread_name: 'external-owner', blocked_method: 'targetWait',
          blocked_thread_name: 'main', main_blocked: 1, wait_ms: 10, waiter_count: 2},
      ]);
      const lock = rootCtes('monitor_lock_overlap', 'render_sync_intervals', 42);
      expect(db.prepare(`WITH ${lock} SELECT lock_contention_ms FROM monitor_lock_overlap`).get()).toEqual({lock_contention_ms: 10});
      expect(db.prepare(sqlFor('gc_in_frame', 42)).all()).toEqual([
        {gc_type: 'young', gc_count: 1, total_dur_ms: 10, overlap_ms: 10, max_dur_ms: 10, total_overlap_ms: 10},
      ]);
      expect(db.prepare(sqlFor('gc_in_frame', null)).all()).toEqual([
        {gc_type: 'young', gc_count: 2, total_dur_ms: 90, overlap_ms: 90, max_dur_ms: 80, total_overlap_ms: 90},
      ]);
      expect(step('lock_contention').process_scope.context_fields.peer_context).toEqual(['blocking_method', 'blocking_thread_name', 'waiter_count']);
    } finally {db.close();}
  });

  it('keeps CPU resources and VSync global while root target metrics exclude restarts', () => {
    const db = fixture();
    try {
      const frequencies = db.prepare(sqlFor('cpu_freq_analysis', 42)).all();
      expect(frequencies).toEqual([
        expect.objectContaining({core_type: 'little', avg_freq_mhz: 550, max_freq_mhz: 600, min_freq_mhz: 500}),
        expect.objectContaining({core_type: 'big', avg_freq_mhz: 1500, max_freq_mhz: 2000, min_freq_mhz: 1000}),
      ]);
      expect(db.prepare(sqlFor('cpu_freq_analysis', 43)).all()).toEqual(frequencies);
      const timeline = db.prepare(sqlFor('cpu_freq_timeline', 42)).all();
      expect(timeline).toHaveLength(4);
      expect(db.prepare(sqlFor('cpu_freq_timeline', 43)).all()).toEqual(timeline);
      // Same definition as the cpu_cluster_load_in_range table (fragments/cpu_cluster_load.sql).
      const cluster = rootCtes('cluster_load', 'gc_frame_overlap', 42);
      const clusterFragment = render(builtInSkillFragment('cpu_cluster_load.sql'), 42);
      expect(db.prepare(`WITH ${clusterFragment}, ${cluster} SELECT * FROM cluster_load`).get())
        .toEqual({big_load_pct: 50, little_load_pct: 60});
      const root = db.prepare(sqlFor('root_cause_summary', 42)).get() as Record<string, unknown>;
      expect(root).toMatchObject({slice_name: 'target_main', slice_dur: 20, frame_budget_ms: 16.67,
        frame_dur_ms: 100, main_io_block_ms: 2, reason_code: 'binder_sync_blocking'});
      expect(root.deep_reason).toContain('surfaceflinger');
      expect(step('root_cause_summary').process_scope.context_fields).toEqual({
        global_context: ['frame_budget_ms', 'primary_cause', 'secondary_info', 'ramp_to_high_ms', 'freq_ramp_evidence'],
        peer_context: ['deep_reason'],
      });
      for (const status of ['multi_machine_unresolved', 'ambiguous_cpu_metadata']) {
        db.prepare('UPDATE _cpu_topology SET topology_source = ?').run(status);
        expect(db.prepare(`WITH ${clusterFragment}, ${cluster} SELECT * FROM cluster_load`).get())
          .toEqual({big_load_pct: null, little_load_pct: null});
      }
    } finally {db.close();}
  });

  it('times the big-core frequency ramp only from complete big-tier observation', () => {
    // The full root-cause SQL on a frame P6 can reach: no Binder or monitor wait,
    // top slice 20 ms (1x-2x of the 16.67 ms budget), starting 10 ms into the
    // 0..100 ms frame. cpu0 is the only big CPU (capacity 1024 vs 300): 1 GHz
    // until 50 ms, then 2 GHz, so the big tier reaches high frequency at 50 ms.
    const ramp = (setup: string) => {
      const db = fixture();
      try {
        db.exec(`DELETE FROM android_binder_txns WHERE client_upid=42;
          DELETE FROM android_monitor_contention WHERE upid=42; ${setup}`);
        const row = db.prepare(sqlFor('root_cause_summary', 42)).get() as Record<string, unknown>;
        return {reason_code: row.reason_code, ramp_to_high_ms: row.ramp_to_high_ms,
          freq_ramp_evidence: row.freq_ramp_evidence};
      } finally {db.close();}
    };
    const cpu0 = (rows: string) => `DELETE FROM cpu_frequency_counters WHERE cpu=0;
      INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq,track_id,ucpu) VALUES ${rows};
      UPDATE cpu_frequency_counters SET id=rowid;`;
    const unobserved = (state: string) => ({reason_code: 'workload_heavy', ramp_to_high_ms: null, freq_ramp_evidence: state});

    expect(ramp('')).toEqual({reason_code: 'freq_ramp_slow', ramp_to_high_ms: 50, freq_ramp_evidence: 'observed'});
    // Already high when the frame starts: a measured 0, not a missing value.
    expect(ramp('UPDATE cpu_frequency_counters SET freq=2000000 WHERE cpu=0;'))
      .toEqual({reason_code: 'workload_heavy', ramp_to_high_ms: 0, freq_ramp_evidence: 'observed'});
    // No big tier: nothing to time, so no frequency reason (was the whole 100 ms frame).
    expect(ramp('UPDATE cpu SET capacity=NULL;')).toEqual(unobserved('big_core_topology_unknown'));
    // A big CPU first sampled inside the frame, a dropped negative sample, a missing tail.
    expect(ramp(cpu0('(0,50000000,50000000,2000000,0,0)'))).toEqual(unobserved('big_core_freq_incomplete'));
    expect(ramp(cpu0(`(0,0,10000000,1000000,0,0),(0,10000000,40000000,-1,0,0),
      (0,50000000,50000000,2000000,0,0)`))).toEqual(unobserved('big_core_freq_incomplete'));
    expect(ramp(cpu0('(0,0,50000000,1000000,0,0),(0,50000000,30000000,2000000,0,0)')))
      .toEqual(unobserved('big_core_freq_incomplete'));
    // Coverage is the union per CPU: a span nested in an earlier, longer one does not end
    // coverage (an adjacent-end check would see a gap at 20..30 ms), and spans that abut cover.
    expect(ramp(cpu0(`(0,0,60000000,1000000,0,0),(0,10000000,10000000,1000000,1,0),
      (0,30000000,20000000,1000000,1,0),(0,50000000,50000000,2000000,0,0)`)))
      .toEqual({reason_code: 'freq_ramp_slow', ramp_to_high_ms: 50, freq_ramp_evidence: 'observed'});
    // Overlap is not coverage: 150 ms of spans that leave 60..70 ms unobserved.
    expect(ramp(cpu0(`(0,0,60000000,1000000,0,0),(0,0,60000000,1000000,1,0),
      (0,70000000,30000000,2000000,0,0)`))).toEqual(unobserved('big_core_freq_incomplete'));
    // Every big CPU must be covered: a second, fully observed big CPU does not cover cpu0's gap.
    const secondBig = `INSERT INTO cpu VALUES (2,2,0,0,1024);
      INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq,track_id,ucpu) VALUES (2,0,100000000,1000000,2,2);
      UPDATE cpu_frequency_counters SET id=rowid;`;
    expect(ramp(secondBig)).toEqual({reason_code: 'freq_ramp_slow', ramp_to_high_ms: 50, freq_ramp_evidence: 'observed'});
    expect(ramp(secondBig + cpu0('(0,0,40000000,1000000,0,0),(0,50000000,50000000,2000000,0,0)')))
      .toEqual(unobserved('big_core_freq_incomplete'));
    // CPUs of two machines (duplicate ordinals): the frame names no machine, so no single big tier.
    expect(ramp('INSERT INTO cpu VALUES (2,0,1,0,1024),(3,1,1,1,300);'))
      .toEqual(unobserved('machine_scope_ambiguous'));
  });

  it('runs the frequency-limit binding in the full root-cause SQL and leaves the reason unchanged without limit data', () => {
    const db = fixture();
    try {
      // The facts of a capped value exist only for a capped frame.
      const LIMIT_FACTS = ['freq_limit_basis', 'freq_limit_onset_ts', 'freq_limit_cooling_basis', 'freq_limit_mhz',
        'freq_limit_depth_pct', 'freq_limit_trace_episode_id'];
      // A valid top-slice work interval on a trace without a max-limit track.
      const root = db.prepare(sqlFor('root_cause_summary', 42)).get() as Record<string, unknown>;
      // Every declared display column is projected by the executed SQL.
      const declared = (step('root_cause_summary').display.columns as any[]).map(column => column.name);
      expect(declared.filter(name => !Object.prototype.hasOwnProperty.call(root, name))).toEqual([]);
      expect(root).toMatchObject({reason_code: 'binder_sync_blocking', freq_limit_state: 'limit_track_unavailable',
        freq_limit_onset_confirmed: 0, rt_freq_limit_state: 'limit_track_unavailable'});
      for (const column of LIMIT_FACTS) expect({column, value: root[column]}).toEqual({column, value: null});
      // No top slice in the main window: no main row, so no state and no limit reason.
      const noTopSlice = db.prepare(sqlFor('root_cause_summary', 42, 'com.example.app',
        {main_start_ts: '95000000', main_end_ts: '100000000'})).get() as Record<string, unknown>;
      expect(noTopSlice).toMatchObject({slice_name: null, freq_limit_state: null, freq_limit_onset_confirmed: null,
        rt_freq_limit_state: 'limit_track_unavailable'});
      expect(['thermal_throttling', 'cpu_max_limited']).not.toContain(noTopSlice.reason_code);
    } finally {db.close();}
  });
});

// Main-thread causes are evaluated from the continuous execution window, even
// when FrameTimeline and input/scroll session tables do not exist.
describe('main_thread_frame_work continuous-window SQL behavior', () => {
  const definition = yaml.load(fs.readFileSync(path.join(process.cwd(),
    'skills/composite/main_thread_frame_work.skill.yaml'), 'utf8')) as any;
  it('keeps all standalone evidence projections first and identical in scrolling analysis', () => {
    const scrolling = yaml.load(fs.readFileSync(path.join(process.cwd(),
      'skills/composite/scrolling_analysis.skill.yaml'), 'utf8')) as any;
    expect(scrolling.steps.slice(0, definition.steps.length)).toEqual(definition.steps);
  });

  const step = (id: string) => definition.steps.find((candidate: any) => candidate.id === id);
  const sql = (id: string, options: {
    upid?: number | null; packageName?: string; start?: number; end?: number; topK?: number;
    projection?: string;
  } = {}) => {
    const selected = step(id);
    const fragments = selected.sql_fragments.map((file: string) =>
      fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8')).join('\n,\n');
    return `WITH ${fragments}\n${options.projection || selected.sql}`
      .split('${__process_scope.upid}').join(String(options.upid ?? 'NULL'))
      .split('${package}').join(options.packageName ?? 'com.example.app')
      .split('${start_ts}').join(String(options.start ?? 'NULL'))
      .split('${end_ts}').join(String(options.end ?? 'NULL'))
      .split('${main_thread_top_k|20}').join(String(options.topK ?? 20));
  };
  const fixture = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0, 100000000);
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, start_ts INTEGER, end_ts INTEGER);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, tid INTEGER, name TEXT, start_ts INTEGER, end_ts INTEGER);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
      CREATE TABLE slice(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, dur INTEGER,
        name TEXT, parent_id INTEGER, arg_set_id INTEGER);
      CREATE INDEX slice_track_ts ON slice(track_id, ts);
      CREATE INDEX slice_parent ON slice(parent_id);
      CREATE TABLE thread_state(utid INTEGER, ts INTEGER, dur INTEGER, state TEXT, io_wait INTEGER,
        id INTEGER PRIMARY KEY, blocked_function TEXT);
      CREATE INDEX thread_state_utid_ts ON thread_state(utid, ts);
      INSERT INTO process VALUES (42, 100, 'com.example.app', NULL, NULL);
      INSERT INTO thread VALUES (1, 42, 100, 'main', NULL, NULL);
      INSERT INTO thread_track VALUES (10, 1);
    `);
    return db;
  };
  const rows = (db: Database.Database, id: string, options: Parameters<typeof sql>[1] = {}) =>
    db.prepare(sql(id, options)).all() as Record<string, any>[];
  const windowRow = (db: Database.Database, options: Parameters<typeof sql>[1] = {}) =>
    rows(db, 'main_thread_work_summary', options).find(row => row.phase === 'window')!;

  it('finds a 30ms initialization task between 22ms and 24ms doFrames without FrameTimeline', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO slice VALUES
          (1,10,0,22000000,'Choreographer#doFrame 1',NULL,11),
          (2,10,22000000,30000000,'ContentLoader.initialize',NULL,12),
          (3,10,52000000,24000000,'Choreographer#doFrame 2',NULL,13),
          (4,10,23000000,25000000,'ContentRepository.initialize',2,14),
          (5,10,24000000,14000000,'parseContent',4,15),
          (6,10,38000000,8000000,'inflateContent',4,16);
        INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES
          (1,0,30000000,'Running',NULL), (1,30000000,2000000,'R',NULL),
          (1,32000000,68000000,'Running',NULL);
      `);
      const summary = rows(db, 'main_thread_work_summary');
      expect(windowRow(db)).toMatchObject({wall_ms: 100, annotated_wall_ms: 76,
        unannotated_wall_ms: 24, observed_doframe_count: 2, eligible_task_count: 3,
        running_ms: 98, runnable_ms: 2, unannotated_running_ms: 24});
      expect(summary.find(row => row.phase === 'between_doFrames')).toMatchObject({
        wall_ms: 30, annotated_wall_ms: 30, running_ms: 28, runnable_ms: 2,
      });
      const tasks = rows(db, 'main_thread_work_tasks');
      expect(tasks[0]).toMatchObject({task_name: 'ContentLoader.initialize', phase: 'between_doFrames',
        wall_ms: 30, outside_doframe_ms: 30, inside_doframe_ms: 0, running_ms: 28, runnable_ms: 2,
        slice_id: 2, arg_set_id: 12, hotspot_name: 'parseContent', hotspot_slice_id: 5,
        hotspot_parent_id: 4, hotspot_arg_set_id: 15, hotspot_exclusive_wall_ms: 14,
        eligible_task_count: 3, returned_task_count: 3});
      expect(tasks[0].ancestor_path).toBe('ContentLoader.initialize > ContentRepository.initialize > parseContent');
      expect(rows(db, 'main_thread_work_cadence')).toEqual([
        expect.objectContaining({observed_start_interval_ms: 52, between_execution_ms: 30,
          previous_slice_id: 1, slice_id: 3, eligible_interval_count: 1, returned_interval_count: 1}),
      ]);
    } finally {db.close();}
  });

  it('preserves every phase of one outer task and computes exclusive wall with a running child union', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO slice VALUES
          (1,10,0,100000000,'outerDispatch',NULL,1),
          (2,10,10000000,20000000,'Choreographer#doFrame 1',1,2),
          (3,10,60000000,20000000,'Choreographer#doFrame 2',1,3),
          (4,10,30000000,30000000,'initialize',1,4),
          (5,10,32000000,18000000,'longChild',4,5),
          (6,10,34000000,2000000,'overlappingChild',4,6),
          (7,10,46000000,6000000,'tailChild',4,7);
        INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES (1,0,100000000,'Running',NULL);
      `);
      const task = rows(db, 'main_thread_work_tasks')[0];
      expect(task).toMatchObject({task_name: 'outerDispatch', phase: 'mixed', wall_ms: 100,
        inside_doframe_ms: 40, between_doframes_ms: 30, before_first_doframe_ms: 10,
        after_last_doframe_ms: 20, outside_doframe_ms: 60, running_ms: 100});
      const hotspots = rows(db, 'main_thread_work_tasks', {
        projection: 'SELECT slice_id, exclusive_wall_ns FROM mtw_hotspots ORDER BY slice_id',
      });
      expect(hotspots.find(row => row.slice_id === 1)?.exclusive_wall_ns).toBe(30000000);
      // Children cover [32,52), not 18+2+6=26ms and not a LAG(end) overcount.
      expect(hotspots.find(row => row.slice_id === 4)?.exclusive_wall_ns).toBe(10000000);
      const summary = rows(db, 'main_thread_work_summary');
      expect(windowRow(db).annotated_wall_ms).toBe(100);
      expect(summary.filter(row => row.phase !== 'window').reduce((sum, row) => sum + row.wall_ms, 0)).toBe(100);
      expect(summary.filter(row => row.phase !== 'window').reduce((sum, row) => sum + row.running_ms, 0)).toBe(100);
    } finally {db.close();}
  });

  it('clips open and boundary slices, keeps incomplete status, and never turns unknown scheduling into zero CPU', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO slice VALUES
          (1,10,20000000,-1,'unfinishedInitialization',NULL,1),
          (2,10,10000000,20000000,'endsAtWindowStart',NULL,2),
          (3,10,70000000,10000000,'startsAtWindowEnd',NULL,3),
          (4,10,35000000,-1,'unfinishedChild',1,4);
      `);
      const options = {start: 30000000, end: 70000000};
      expect(windowRow(db, options)).toMatchObject({wall_ms: 40, annotated_wall_ms: 40,
        incomplete_slice_count: 2, eligible_task_count: 1, observed_doframe_count: 0,
        running_ms: null, runnable_ms: null, known_state_ms: 0, unknown_state_ms: 40,
        unannotated_running_ms: null});
      expect(rows(db, 'main_thread_work_tasks', options)).toEqual([
        expect.objectContaining({task_name: 'unfinishedInitialization', raw_ts: '20000000',
          raw_dur: '-1', start_ts: '30000000', end_ts: '70000000', dur: '40000000',
          phase: 'no_doFrame', is_incomplete: 1, hotspot_is_incomplete: 1,
          running_ms: null, unknown_state_ms: 40}),
      ]);
      expect(rows(db, 'main_thread_work_cadence', options)).toEqual([]);
    } finally {db.close();}
  });

  it('keeps exact UPID lifetimes and conserves union time across overlapping annotation tracks', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE process SET end_ts=50000000 WHERE upid=42;
        UPDATE thread SET end_ts=50000000 WHERE utid=1;
        INSERT INTO process VALUES (43,100,'com.example.app',50000000,NULL),
          (44,101,'com.example.app:worker',NULL,NULL),(45,102,'com.example.app2',NULL,NULL);
        INSERT INTO thread VALUES (2,43,100,'main',50000000,NULL),
          (3,44,101,'main',NULL,NULL),(4,45,102,'main',NULL,NULL);
        INSERT INTO thread_track VALUES (11,1),(20,2),(30,3),(40,4);
        INSERT INTO slice VALUES
          (1,10,10000000,30000000,'trackOne',NULL,1),
          (2,11,20000000,30000000,'trackTwo',NULL,2),
          (3,20,50000000,50000000,'restartedProcess',NULL,3),
          (4,30,0,100000000,'childProcess',NULL,4),
          (5,40,0,100000000,'similarPrefix',NULL,5);
        INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES (1,0,100000000,'Running',NULL),
          (2,0,100000000,'Running',NULL),(3,0,100000000,'Running',NULL);
      `);
      expect(windowRow(db, {upid: 42})).toMatchObject({upid: 42, window_end_ts: '50000000',
        wall_ms: 50, annotated_wall_ms: 40, running_ms: 50, ambiguous_annotation_wall_ms: 20,
        annotation_track_count: 2, eligible_task_count: 2});
      const tasks = rows(db, 'main_thread_work_tasks', {upid: 42});
      expect(tasks).toHaveLength(2);
      expect(tasks.every(row => row.upid === 42 && row.attribution === 'overlapping_roots_nonadditive')).toBe(true);
      expect(tasks.reduce((sum, row) => sum + row.wall_ms, 0)).toBe(60);
      expect(windowRow(db, {upid: 43})).toMatchObject({upid: 43, window_start_ts: '50000000', wall_ms: 50});
      expect(rows(db, 'main_thread_work_summary').filter(row => row.phase === 'window')
        .map(row => row.upid)).toEqual([42, 43, 44]);
      // A trusted identity binding takes precedence over a stale display name.
      expect(windowRow(db, {upid: 42, packageName: 'stale.name'}).upid).toBe(42);
    } finally {db.close();}
  });

  it('reports unannotated CPU, actual waits and uncovered state without inferring idle or IO causes', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES
        (1,0,10000000,'Running',NULL),(1,10000000,10000000,'R',NULL),
        (1,20000000,10000000,'R+',NULL),(1,30000000,10000000,'S',NULL),
        (1,40000000,10000000,'I',NULL),(1,50000000,10000000,'D',0),
        (1,60000000,10000000,'D',1),(1,70000000,5000000,'DK',NULL),
        (1,75000000,5000000,'T',NULL);`);
      expect(windowRow(db)).toMatchObject({wall_ms: 100, annotated_wall_ms: 0,
        unannotated_wall_ms: 100, unannotated_running_ms: 10, running_ms: 10,
        runnable_ms: 10, runnable_preempted_ms: 10, sleep_ms: 10, idle_state_ms: 10,
        uninterruptible_ms: 20, uninterruptible_wakekill_ms: 5,
        io_wait_ms: 10, unknown_io_wait_ms: 5, other_state_ms: 5,
        known_state_ms: 80, unknown_state_ms: 20});
      expect(rows(db, 'main_thread_work_tasks')).toEqual([]);
      expect(rows(db, 'main_thread_work_cadence')).toEqual([]);
      db.exec("INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES (1,0,5000000,'S',NULL)");
      expect(windowRow(db)).toMatchObject({running_ms: 5, unknown_state_ms: 25, conflicting_state_ms: 5});
    } finally {db.close();}
  });

  it('keeps complete many-short-task totals before TopK and excludes resynced annotation from doFrame cadence', () => {
    const db = fixture();
    try {
      const insert = db.prepare('INSERT INTO slice VALUES (?,10,?,1000000,?,NULL,?)');
      db.transaction(() => {
        for (let index = 0; index < 60; index++) {
          insert.run(index + 1, index * 1000000, 'ContentLoader.smallInitialization', index + 1);
        }
      })();
      db.exec(`INSERT INTO slice VALUES (100,10,80000000,1000000,'Choreographer#doFrame resynced',NULL,100);
        INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES (1,0,100000000,'Running',NULL);`);
      const options = {topK: 2};
      expect(windowRow(db, options)).toMatchObject({annotated_wall_ms: 61,
        eligible_task_count: 61, observed_doframe_count: 0, running_ms: 100});
      const tasks = rows(db, 'main_thread_work_tasks', options);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({task_name: 'ContentLoader.smallInitialization',
        eligible_task_count: 61, returned_task_count: 2, phase: 'no_doFrame'});
      expect(rows(db, 'main_thread_work_cadence', options)).toEqual([]);
      expect(rows(db, 'main_thread_work_tasks', {topK: 1000000})).toHaveLength(61);
    } finally {db.close();}
  });

  it('marks duplicate-track and incomplete doFrame observations instead of inventing execution gaps', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO thread_track VALUES (11,1);
        INSERT INTO slice VALUES
          (1,10,0,10000000,'Choreographer#doFrame 1',NULL,1),
          (2,11,0,10000000,'Choreographer#doFrame 1',NULL,2),
          (3,10,20000000,-1,'Choreographer#doFrame 2',NULL,3),
          (4,11,50000000,10000000,'Choreographer#doFrame 3',NULL,4);
      `);
      const intervals = rows(db, 'main_thread_work_cadence');
      expect(intervals).toHaveLength(2);
      expect(intervals.find(row => row.start_ts === '0')).toMatchObject({
        observed_start_interval_ms: 20, previous_slice_id: null,
        observation: 'ambiguous_duplicate_markers', between_execution_ms: null,
      });
      expect(intervals.find(row => row.start_ts === '20000000')).toMatchObject({
        observed_start_interval_ms: 30, observation: 'incomplete_previous_execution',
        between_execution_ms: null,
      });
      expect(rows(db, 'main_thread_work_cadence', {topK: 1})[0]).toMatchObject({
        eligible_interval_count: 2, returned_interval_count: 1,
      });
    } finally {db.close();}
  });

  it('scopes many irrelevant slices before sweeping and bounds only detail expansion', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO process VALUES (99,999,'unrelated',NULL,NULL);
        INSERT INTO thread VALUES (99,99,999,'main',NULL,NULL);
        INSERT INTO thread_track VALUES (99,99);
        UPDATE trace_bounds SET end_ts=10000000000;`);
      const insert = db.prepare('INSERT INTO slice VALUES (?,?,?,?,?,NULL,0)');
      db.transaction(() => {
        for (let index = 0; index < 10000; index++) {
          insert.run(index + 1, 99, index * 1000000, 1000000, 'irrelevant');
          insert.run(index + 20000, 10, index * 1000000, 1000000, 'smallInitialization');
        }
      })();
      const options = {upid: 42, start: 100000000, end: 200000000, topK: 3};
      expect(windowRow(db, options)).toMatchObject({eligible_task_count: 100,
        annotated_wall_ms: 100, wall_ms: 100, observed_slice_count: 100});
      expect(rows(db, 'main_thread_work_tasks', options)).toHaveLength(3);
      expect(rows(db, 'main_thread_work_tasks', options)[0]).toMatchObject({
        eligible_task_count: 100, returned_task_count: 3,
      });
      // The full-window path still accounts for every root before bounding
      // detailed descendants, rather than doing a root x endpoint expansion.
      expect(windowRow(db, {upid: 42, topK: 3})).toMatchObject({
        eligible_task_count: 10000, annotated_wall_ms: 10000,
      });
      expect(rows(db, 'main_thread_work_tasks', {upid: 42, topK: 3})[0]).toMatchObject({
        eligible_task_count: 10000, returned_task_count: 3,
      });
    } finally {db.close();}
  });

  it('prioritizes inter-frame work ahead of arbitrarily many slower doFrames and removes nested duplicate markers', () => {
    const db = fixture();
    try {
      db.exec('UPDATE trace_bounds SET end_ts = 2000000000');
      const insert = db.prepare('INSERT INTO slice VALUES (?,10,?,30000000,?,NULL,0)');
      db.transaction(() => {
        for (let index = 0; index < 30; index++) {
          insert.run(index + 1, index * 50000000, `Choreographer#doFrame ${index}`);
        }
      })();
      db.exec(`INSERT INTO slice VALUES
        (100,10,30000000,20000000,'initializeContent',NULL,100),
        (101,10,1000000,10000000,'Choreographer#doFrame nested',1,101);`);
      expect(windowRow(db, {topK: 1})).toMatchObject({observed_doframe_count: 30, eligible_task_count: 31});
      expect(rows(db, 'main_thread_work_tasks', {topK: 1})).toEqual([
        expect.objectContaining({task_name: 'initializeContent', phase: 'between_doFrames',
          outside_doframe_ms: 20, eligible_task_count: 31, returned_task_count: 1}),
      ]);
      expect(rows(db, 'main_thread_work_cadence')[0]).toMatchObject({eligible_interval_count: 29,
        observed_start_interval_ms: 50});
    } finally {db.close();}
  });

  it('retains bounded non-frame exclusive hotspots and scheduler blocking provenance for mixed outer tasks', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO slice VALUES
        (1,10,0,100000000,'Looper.dispatch',NULL,1),
        (2,10,0,35000000,'Choreographer#doFrame 1',1,2),
        (3,10,55000000,45000000,'Choreographer#doFrame 2',1,3),
        (4,10,35000000,20000000,'initializeContent',1,4),
        (5,10,0,34000000,'drawFirstFrame',2,5),
        (6,10,55000000,44000000,'drawSecondFrame',3,6);
        INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES
          (1,0,35000000,'Running',NULL),(1,35000000,10000000,'D',1),
          (1,45000000,5000000,'S',NULL),(1,50000000,50000000,'Running',NULL);
        UPDATE thread_state SET blocked_function='filemap_fault' WHERE state='D';
        UPDATE thread_state SET blocked_function='futex_wait_queue' WHERE state='S';`);
      const task = rows(db, 'main_thread_work_tasks')[0];
      expect(task).toMatchObject({phase: 'mixed', outside_doframe_ms: 20,
        hotspot_name: 'initializeContent', hotspot_exclusive_wall_ms: 20,
        hotspot_exclusive_outside_doframe_ms: 20, running_ms: 85,
        uninterruptible_ms: 10, io_wait_ms: 10, sleep_ms: 5,
        top_wait_state: 'D', top_wait_state_id: 2, top_wait_blocked_function: 'filemap_fault',
        top_wait_io_wait: 1, top_wait_start_ts: '35000000', top_wait_end_ts: '45000000',
        top_wait_overlap_ms: 10});
      const hotspots = JSON.parse(task.hotspot_evidence);
      expect(hotspots).toHaveLength(3);
      expect(hotspots[0]).toMatchObject({name: 'initializeContent', slice_id: 4,
        arg_set_id: 4, in_doframe_tree: 0, start_ts: '35000000',
        exclusive_outside_doframe_ms: 20, ancestor_path: 'Looper.dispatch > initializeContent'});
      expect(hotspots.some((row: any) => row.in_doframe_tree === 1)).toBe(true);
      expect(JSON.parse(task.wait_evidence)).toEqual([
        expect.objectContaining({thread_state_id: 2, state: 'D', io_wait: 1,
          blocked_function: 'filemap_fault', overlap_ms: 10, start_ts: '35000000', end_ts: '45000000'}),
        expect.objectContaining({thread_state_id: 3, state: 'S', io_wait: null,
          blocked_function: 'futex_wait_queue', overlap_ms: 5}),
      ]);
    } finally {db.close();}
  });

  it('preserves nanosecond precision beyond the JavaScript integer range on every output surface', () => {
    const db = fixture();
    try {
      db.exec(`UPDATE trace_bounds SET start_ts=9007199254740993, end_ts=9007199354740993;
        INSERT INTO slice VALUES
        (1,10,9007199254740993,20000000,'Choreographer#doFrame 1',NULL,1),
        (2,10,9007199274740993,30000000,'initialize',NULL,2),
        (3,10,9007199304740993,20000000,'Choreographer#doFrame 2',NULL,3);`);
      expect(windowRow(db)).toMatchObject({window_start_ts: '9007199254740993',
        window_end_ts: '9007199354740993'});
      expect(rows(db, 'main_thread_work_tasks')[0]).toMatchObject({
        raw_ts: '9007199274740993', raw_dur: '30000000', start_ts: '9007199274740993',
        end_ts: '9007199304740993', dur: '30000000',
      });
      expect(rows(db, 'main_thread_work_cadence')[0]).toMatchObject({
        start_ts: '9007199254740993', next_start_ts: '9007199304740993', dur: '50000000',
      });
    } finally {db.close();}
  });

  it('exports the top three hotspots and waits as scalar source rows independent of JSON truncation', () => {
    const db = fixture();
    try {
      const longName = 'initializeContent_' + 'longBusinessAnnotation'.repeat(8);
      db.exec(`INSERT INTO slice VALUES (1,10,0,100000000,'dispatch',NULL,1),
        (2,10,0,20000000,'childOne',1,2), (3,10,20000000,20000000,'childTwo',1,3),
        (4,10,40000000,20000000,'childThree',1,4), (5,10,60000000,20000000,'childFour',1,5);
        INSERT INTO thread_state(utid,ts,dur,state,io_wait) VALUES
          (1,0,30000000,'D',1),(1,30000000,25000000,'S',NULL),
          (1,55000000,20000000,'R',NULL),(1,75000000,15000000,'R+',NULL),
          (1,90000000,10000000,'Running',NULL);
        UPDATE thread_state SET blocked_function='filemap_fault' WHERE state='D';`);
      db.prepare('UPDATE slice SET name=? WHERE id=2').run(longName);
      const sources = rows(db, 'main_thread_work_sources', {topK: 1});
      expect(sources).toHaveLength(6);
      expect(sources.filter(row => row.source_kind === 'hotspot')).toHaveLength(3);
      expect(sources.filter(row => row.source_kind === 'wait')).toHaveLength(3);
      expect(sources.find(row => row.source_slice_id === 2)).toMatchObject({
        root_slice_id: 1, source_name: longName, source_rank: 2,
        source_slice_id: 2, parent_id: 1, arg_set_id: 2, upid: 42, utid: 1,
        track_id: 10, start_ts: '0', end_ts: '20000000', dur: '20000000',
        exclusive_wall_ms: 20, exclusive_outside_doframe_ms: 20,
      });
      expect(sources.find(row => row.thread_state_id === 1)).toMatchObject({
        source_kind: 'wait', source_rank: 1, root_slice_id: 1,
        state: 'D', blocked_function: 'filemap_fault', io_wait: 1,
        start_ts: '0', end_ts: '30000000', wait_overlap_ms: 30,
        source_slice_id: null, exclusive_wall_ms: null,
      });
      const columns = step('main_thread_work_sources').display.columns.map((column: any) => column.name);
      expect(columns).toEqual(expect.arrayContaining(['source_slice_id', 'thread_state_id',
        'parent_id', 'arg_set_id', 'blocked_function', 'start_ts', 'end_ts', 'source_rank']));
      expect(step('main_thread_work_tasks').display.columns.map((column: any) => column.name))
        .not.toContain('hotspot_evidence');
    } finally {db.close();}
  });
});

describe('FrameTimeline gap observation boundary', () => {
  it('keeps process/layer identity and counts crossing markers without inferring backpressure', () => {
    const skill = yaml.load(fs.readFileSync(path.join(process.cwd(),
      'skills/atomic/frame_production_gap.skill.yaml'), 'utf8')) as any;
    const db = new Database(':memory:');
    try {
      db.function('PERCENTILE', {varargs: true}, () => 16666667);
      db.exec(`CREATE TABLE process(upid INTEGER, pid INTEGER, name TEXT);
        INSERT INTO process VALUES(1,10,'com.example.app'),(2,20,'com.example.app:remote');
        CREATE TABLE thread(utid INTEGER, tid INTEGER, upid INTEGER, name TEXT);
        INSERT INTO thread VALUES(1,10,1,'main'),(2,20,2,'main'),
          (3,11,1,'RenderThread'),(4,21,2,'RenderThread');
        CREATE TABLE thread_track(id INTEGER, utid INTEGER);
        INSERT INTO thread_track SELECT utid,utid FROM thread;
        CREATE TABLE counter(ts INTEGER, track_id INTEGER);
        CREATE TABLE counter_track(id INTEGER, name TEXT);
        CREATE TABLE actual_frame_timeline_slice(ts INTEGER,dur INTEGER,upid INTEGER,
          layer_name TEXT,display_frame_token INTEGER,surface_frame_token INTEGER);
        INSERT INTO actual_frame_timeline_slice VALUES(0,10000000,1,'same',1,1),
          (50000000,10000000,1,'same',2,2),(40000000,1000000,2,'same',3,3);
        CREATE TABLE slice(id INTEGER,track_id INTEGER,ts INTEGER,dur INTEGER,name TEXT);
        INSERT INTO slice VALUES(1,1,5000000,25000000,'Choreographer#doFrame 1'),
          (2,4,20000000,5000000,'DrawFrame 1');`);
      const query = (id: string) => {
        const values: Record<string, string> = {process_name:'com.example.app',
          '__process_scope.upid':'1',start_ts:'NULL',end_ts:'NULL',min_gap_vsync:'1.5'};
        return db.prepare(skill.steps.find((step: any) => step.id === id).sql.replace(
          /\$\{([^}]+)\}/g, (_: string, key: string) => {
            if (!(key in values)) throw new Error(`Unexpected gap parameter ${key}`);
            return values[key];
          })).all() as any[];
      };
      expect(query('gap_list')).toEqual([expect.objectContaining({upid:1,gap_ms:40,
        doframe_count:1,drawframe_count:0,gap_type:'rt_no_drawframe'})]);
      db.exec("INSERT INTO slice VALUES(3,3,20000000,5000000,'DrawFrame 2')");
      expect(query('gap_list')[0]).toMatchObject({gap_type:'drawframe_observed',
        evidence_scope:'observed_marker_coverage_only'});
      expect(query('gap_summary')[0]).toMatchObject({total_frames:2,total_gaps:1,
        drawframe_observed_count:1});
      expect(query('gap_summary')[0]).not.toHaveProperty('sf_backpressure_count');
      db.exec(`DELETE FROM actual_frame_timeline_slice;
        INSERT INTO actual_frame_timeline_slice VALUES(0,100000000,1,'same',10,10),
          (30000000,10000000,1,'same',11,11),(80000000,10000000,1,'same',12,12);`);
      expect(query('gap_list')).toEqual([]);
      db.exec("INSERT INTO actual_frame_timeline_slice VALUES(140000000,20000000,1,'same',13,13)");
      expect(query('gap_list')).toEqual([expect.objectContaining({gap_ms:40,before_frame_id:'10',after_frame_id:'13'})]);
    } finally { db.close(); }
  });
});

describe('smoothness_basis puts present cadence beside frame duration', () => {
  const scrolling = yaml.load(fs.readFileSync(path.join(process.cwd(),
    'skills/composite/scrolling_analysis.skill.yaml'), 'utf8')) as any;
  const consumer = yaml.load(fs.readFileSync(path.join(process.cwd(),
    'skills/atomic/consumer_jank_detection.skill.yaml'), 'utf8')) as any;
  const stepOf = (definition: any, id: string) => definition.steps.find((item: any) => item.id === id);
  const VSYNC = 8333333;
  const LAYER = 'TX - com.example.app/Main#1';

  const fixture = () => {
    const db = new Database(':memory:');
    db.aggregate('PERCENTILE', {
      start: () => ({values: [] as number[], p: 50}),
      step: (state: {values: number[]; p: number}, ...args: unknown[]) => {
        const [value, p] = args as [number | null, number];
        if (value !== null) state.values.push(value);
        state.p = p;
        return state;
      },
      result: (state: {values: number[]; p: number}) => {
        const sorted = state.values.sort((a, b) => a - b);
        return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * state.p / 100))] : null;
      },
    });
    db.function('android_is_missed_frame_type', (value: unknown) => /App Deadline Missed/.test(String(value)) ? 1 : 0);
    db.exec(`
      CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0, 2000000000);
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, start_ts INTEGER, end_ts INTEGER);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, tid INTEGER, name TEXT, start_ts INTEGER, end_ts INTEGER);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
      CREATE TABLE slice(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, dur INTEGER,
        name TEXT, parent_id INTEGER, arg_set_id INTEGER);
      CREATE TABLE thread_state(utid INTEGER, ts INTEGER, dur INTEGER, state TEXT, io_wait INTEGER,
        id INTEGER PRIMARY KEY, blocked_function TEXT);
      CREATE TABLE counter(ts INTEGER, track_id INTEGER);
      CREATE TABLE counter_track(id INTEGER, name TEXT);
      CREATE TABLE actual_frame_timeline_slice(id INTEGER, upid INTEGER, display_frame_token INTEGER,
        surface_frame_token INTEGER, layer_name TEXT, ts INTEGER, dur INTEGER, jank_type TEXT, present_type TEXT);
      CREATE TABLE expected_frame_timeline_slice(upid INTEGER, layer_name TEXT, surface_frame_token INTEGER,
        ts INTEGER, dur INTEGER);
      INSERT INTO process VALUES (1, 100, 'com.example.app', NULL, NULL);
      INSERT INTO thread VALUES (1, 1, 100, 'main', NULL, NULL);
      INSERT INTO thread_track VALUES (10, 1);
      INSERT INTO counter_track VALUES (1, 'VSYNC-sf');
    `);
    const tick = db.prepare('INSERT INTO counter VALUES (?, 1)');
    for (let i = 0; i < 240; i++) tick.run(i * VSYNC);
    // A steady pipeline one buffer deep: every frame presents one VSync
    // apart, two VSyncs after its expected present, with a three-VSync dur.
    const actual = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)');
    const expected = db.prepare('INSERT INTO expected_frame_timeline_slice VALUES (1, ?, ?, ?, ?)');
    for (let i = 0; i < 30; i++) {
      actual.run(i + 1, i + 1, i + 101, LAYER, i * VSYNC, 3 * VSYNC, 'Buffer Stuffing', 'Late Present');
      expected.run(LAYER, i + 101, i * VSYNC, VSYNC);
    }
    return db;
  };
  const bind = (sql: string, fragments?: string[]) => renderStepSql(sql, fragments, {
    '__process_scope.upid': 'NULL', package: 'com.example.app', layer_name: '',
    start_ts: 'NULL', end_ts: 'NULL', 'buffer_tx_coverage.data[0].coverage_status': 'no_buffer_tx_candidate',
  });
  const basis = (db: Database.Database) => {
    const step = stepOf(scrolling, 'smoothness_basis');
    return db.prepare(bind(String(step.sql), step.sql_fragments)).all() as Record<string, any>[];
  };
  const audit = (db: Database.Database) => db.prepare(bind(String(
    stepOf(consumer, 'presentation_cadence_audit').sql))).all() as Record<string, any>[];

  it('reads a steady late pipeline as one-VSync presents beside a three-VSync dur', () => {
    const db = fixture();
    try {
      const [row] = basis(db);
      expect(row).toMatchObject({
        session_id: 1, layer_name: LAYER, frames: 30, budget_ns: VSYNC, budget_source: 'trace_wide_vsync_counter',
        cadence_metric: 'frametimeline_present_gap', cadence_gap_count: 29, cadence_gap_p50_ns: VSYNC,
        cadence_gaps_over_1_5x_budget: 0, frame_dur_metric: 'frametimeline_actual_dur_start_to_present',
        frame_dur_p50_ns: 3 * VSYNC, buffer_stuffing_frames: 30, buffer_stuffing_pct: 100,
        cadence_status: 'steady_late', presentation_status: 'measured', budget_status: 'measured',
        verdict_basis: 'present_gaps_vs_budget',
      });
      expect(audit(db).map(item => item.cadence_status)).toEqual([row.cadence_status]);
    } finally { db.close(); }
  });

  it('applies the presentation cadence audit rule to a session with an excursion', () => {
    const db = fixture();
    try {
      db.exec(`UPDATE actual_frame_timeline_slice SET dur = dur + ${2 * VSYNC} WHERE id = 15`);
      const [row] = basis(db);
      expect(row.cadence_gaps_over_1_5x_budget).toBe(1);
      expect(row.cadence_status).toBe('steady_late_with_cadence_excursions');
      expect(audit(db).map(item => item.cadence_status)).toEqual([row.cadence_status]);
    } finally { db.close(); }
  });

  it('aggregates every doFrame start gap and leaves presentation unmeasured without FrameTimeline', () => {
    const db = fixture();
    try {
      db.exec('DELETE FROM actual_frame_timeline_slice');
      const insert = db.prepare("INSERT INTO slice VALUES (?, 10, ?, 5000000, 'Choreographer#doFrame', NULL, NULL)");
      // 40 starts one VSync apart except one skipped VSync: more gaps than the top-K list returns.
      for (let i = 0; i < 40; i++) insert.run(i + 1, (i < 20 ? i : i + 1) * VSYNC);
      const rows = basis(db);
      expect(rows).toEqual([expect.objectContaining({
        process_name: 'com.example.app', session_id: null, frames: 40,
        cadence_metric: 'doframe_start_gap', cadence_gap_count: 39, cadence_gaps_over_1_5x_budget: 1,
        frame_dur_metric: 'doframe_main_thread_execution', frame_dur_p50_ns: 5000000,
        buffer_stuffing_pct: null, cadence_status: 'presentation_unmeasured',
        presentation_status: 'unmeasured', verdict_basis: 'doframe_start_gaps_presentation_unmeasured',
      })]);
    } finally { db.close(); }
  });

  it('leaves cadence unjudged without a measured VSYNC-sf budget, as the audit does', () => {
    const db = fixture();
    try {
      db.exec('DELETE FROM counter');
      const [row] = basis(db);
      expect(row).toMatchObject({budget_source: 'trace_wide_expected_frame', budget_status: 'derived_from_expected_frames',
        cadence_status: 'insufficient_cadence_evidence', verdict_basis: 'present_gaps_budget_unverified'});
      expect(audit(db).map(item => item.cadence_status)).toEqual([row.cadence_status]);
    } finally { db.close(); }
  });

  it('splits sessions with scroll_sessions\' own rule', () => {
    const db = fixture();
    try {
      // A pause past six VSyncs, then a second run: two sessions in both steps.
      const actual = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 30; i++) {
        actual.run(i + 101, i + 101, i + 201, LAYER, 1000000000 + i * VSYNC, 3 * VSYNC, 'None', 'On-time Present');
      }
      const step = stepOf(scrolling, 'scroll_sessions');
      const sessions = db.prepare(bind(String(step.sql), step.sql_fragments)).all() as Record<string, any>[];
      expect(basis(db).map(row => [row.session_id, row.start_ts, row.frames]))
        .toEqual(sessions.map(row => [row.session_id, row.start_ts, row.frame_count]));
      expect(sessions).toHaveLength(2);
    } finally { db.close(); }
  });

  it('marks a budget the observed cadence contradicts', () => {
    const db = fixture();
    try {
      // A sparse VSync counter: every sixth tick.
      db.exec(`DELETE FROM counter WHERE (ts / ${VSYNC}) % 6 != 0`);
      const [row] = basis(db);
      expect(row).toMatchObject({budget_status: 'contradicted_by_observed_cadence',
        verdict_basis: 'present_gaps_budget_unverified'});
    } finally { db.close(); }
  });

  it('reports no present interval rather than FrameTimeline dur when no present gap is valid', () => {
    const sql = String(stepOf(scrolling, 'performance_summary').sql);
    const begin = sql.indexOf('app_frame_intervals AS (');
    const end = sql.indexOf('-- Per-layer 帧序列', begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const ctes = sql.slice(begin, end).trim().replace(/,\s*$/, '');
    const db = fixture();
    try {
      // One frame per layer: no gap at all, while every dur is three VSyncs.
      db.exec("UPDATE actual_frame_timeline_slice SET layer_name = 'layer-' || id");
      const result = db.prepare(`WITH
        timing_config(vsync_period_ns) AS (VALUES (${VSYNC})),
        app_frame_rows AS (SELECT *, 'display:' || display_frame_token AS frame_key FROM actual_frame_timeline_slice),
        ${ctes} SELECT * FROM app_stats`).get();
      expect(result).toMatchObject({total: 30, avg_present_interval: null, p95_present_interval: null,
        max_present_interval: null, present_interval_source: 'unmeasured_no_valid_present_gap'});
    } finally { db.close(); }
  });
});
