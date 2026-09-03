// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, it, expect} from '@jest/globals';

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
    String(getStep(stepId).sql)
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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

    const db = new Database(':memory:');
    try {
      const row = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end) AS (
          VALUES ('display:1', 1000000000, 2000000000)
        ),
        android_monitor_contention(
          ts, dur, process_name, is_blocked_thread_main,
          short_blocking_method, blocking_thread_name
        ) AS (
          VALUES
            (900000000, 300000000, 'com.example.app', 1, 'mainLock', 'owner-main'),
            (1000000000, 900000000, 'com.example.app', 0, 'noise1', 'owner-1'),
            (1010000000, 880000000, 'com.example.app', 0, 'noise2', 'owner-2'),
            (1020000000, 860000000, 'com.example.app', 0, 'noise3', 'owner-3'),
            (1030000000, 840000000, 'com.example.app', 0, 'noise4', 'owner-4'),
            (1040000000, 820000000, 'com.example.app', 0, 'noise5', 'owner-5'),
            (1050000000, 800000000, 'com.example.app', 0, 'noise6', 'owner-6')
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

    const db = new Database(':memory:');
    try {
      const batchRow = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end) AS (
          VALUES ('display:1', 1000000000, 2000000000)
        ),
        android_monitor_contention(
          ts, dur, process_name, is_blocked_thread_main,
          short_blocking_method, blocking_thread_name
        ) AS (
          VALUES
            (1000000000, 100000000, 'com.example.app', 1, 'exactLock', 'owner-exact'),
            (1100000000, 200000000, 'com.example.app:renderer', 1, 'childLock', 'owner-child'),
            (1200000000, 500000000, 'com.example.application', 1, 'wrongLock', 'owner-wrong')
        ),
        ${batchCtes}
        SELECT lock_contention_ms
        FROM per_frame_lock_detail
      `).get() as {lock_contention_ms: number} | undefined;
      expect(batchRow?.lock_contention_ms).toBe(300);

      const deepRow = db.prepare(`
        WITH
        android_monitor_contention(
          ts, dur, process_name, is_blocked_thread_main
        ) AS (
          VALUES
            (1000000000, 100000000, 'com.example.app', 1),
            (1100000000, 200000000, 'com.example.app:renderer', 1),
            (1200000000, 500000000, 'com.example.application', 1)
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

    const db = new Database(':memory:');
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
        jank_frame_list(frame_key, frame_start, frame_end) AS (
          VALUES ('display:1', 1000000000, 1100000000)
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

    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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

  it('counts similar-prefix CPU work as non-app background interference', () => {
    const cte = extractMarkedCtes(
      String(getStep('global_context_flags').sql),
      '-- 4. 非 App 大核 CPU 占用（后台干扰指标）',
      '\nSELECT',
    );
    const db = new Database(':memory:');
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
      `);

      const run = (packageName: string) => db.prepare(`
        WITH ${cte
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
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE android_binder_txns(client_process TEXT, client_dur INTEGER, client_ts INTEGER);
        INSERT INTO android_binder_txns VALUES
          ('com.example.app',          10000000, 100),
          ('com.example.app:remote',   20000000, 200),
          ('com.example.application',  30000000, 300),
          ('com.other',                40000000, 400);
      `);
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

    const db = new Database(':memory:');
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

    const db = new Database(':memory:');
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

    const db = new Database(':memory:');
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

    const db = new Database(':memory:');
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
      const db = new Database(':memory:');
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
      const db = new Database(':memory:');
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
          should_fallback: number;
        };
      } finally {
        db.close();
      }
    };

    expect(runCoverage(0, 100)).toEqual(expect.objectContaining({
      frame_timeline_frames: 0,
      coverage_status: 'no_frame_timeline_coverage',
      should_fallback: 1,
    }));
    expect(runCoverage(36, 100)).toEqual(expect.objectContaining({
      frame_timeline_to_buffer_tx_ratio: 0.36,
      coverage_status: 'partial_frame_timeline_coverage',
      should_fallback: 1,
    }));
    expect(runCoverage(90, 100)).toEqual(expect.objectContaining({
      frame_timeline_to_buffer_tx_ratio: 0.9,
      coverage_status: 'sufficient_frame_timeline_coverage',
      should_fallback: 0,
    }));
    expect(runCoverage(2, null)).toEqual(expect.objectContaining({
      target_process_status: 'found',
      coverage_status: 'no_buffer_tx_candidate',
      should_fallback: 0,
    }));
    expect(runCoverage(1, null, 'com.example.application')).toEqual(expect.objectContaining({
      target_process_count: 0,
      target_process_status: 'not_found',
      coverage_status: 'target_process_not_found',
      should_fallback: 0,
    }));
    expect(runCoverage(1, null, 'com.example.app:renderer')).toEqual(expect.objectContaining({
      target_process_count: 1,
      target_process_status: 'found',
      coverage_status: 'no_buffer_tx_candidate',
      should_fallback: 0,
    }));
  });

  it('does not recommend an unavailable frame fallback when the target process is absent', () => {
    const renderSql = (targetProcessStatus: string) => String(getStep('fallback_no_frame_timeline').sql)
      .split('${package}').join('com.example.app')
      .split('${buffer_tx_coverage.data[0].target_process_status}').join(targetProcessStatus);
    const db = new Database(':memory:');
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
      const sql = String(step.sql);
      expect(sql).toContain('${buffer_tx_coverage.data[0].coverage_status}');
      expect(sql).toContain('${buffer_tx_coverage.data[0].frame_timeline_to_buffer_tx_ratio}');
      expect(sql).toContain("THEN 'partial_sample'");
    }

    const fallback = getStep('buffer_tx_performance_fallback');
    for (const column of [
      'duration_sec',
      'vsync_source',
      'frame_source_track',
      'frame_timeline_to_buffer_tx_ratio',
      'coverage_status',
      'evidence_status',
    ]) {
      getColumn(fallback, column);
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
    const db = new Database(':memory:');
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

    const db = new Database(':memory:');
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
        INSERT INTO thread_track VALUES (10, 99);
        INSERT INTO slice VALUES (10, 1100000, 600000, 'fsync');
      `);

      const rows = db.prepare(`
        WITH
        jank_frame_list(frame_key, frame_start, frame_end) AS (
          VALUES
            ('surface:Layer A:7', 1000000, 1050000),
            ('surface:Layer B:7', 1000000, 1200000)
        ),
        per_frame_thread_roles(frame_key, role, utid) AS (
          VALUES
            ('surface:Layer A:7', 'main', 99),
            ('surface:Layer B:7', 'main', 99)
        ),
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

    const db = new Database(':memory:');
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
    const causeDb = new Database(':memory:');
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
      expect(causes[1].cause).toContain('BufferQueue');
      expect(causes[1].cause).not.toContain('预测时间漂移');
      expect(causes[2].cause).toContain('SurfaceFlinger 调度器预测时间漂移');
    } finally {
      causeDb.close();
    }
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
    expect(strategy).toContain('`fallback_no_frame_timeline` 只有数据不可用提示而没有可用替代源');
    expect(strategy).toContain('立即停止自动追加帧/架构 Skill 与探索 SQL');
    expect(strategy).toContain('`vsync_source = default_60hz_no_trace_timing` 只是内部默认预算');
    expect(strategy).toContain('不得把 60Hz 当作设备或本次场景事实交付');
    expect(strategy).toContain('`frame_timeline_unattributed`');
    expect(strategy).toContain('不能写成噪声、假帧或不可感知');
    expect(strategy).not.toContain('对 top 5 卡顿帧调用 jank_frame_detail（必须执行）');
    expect(strategy).not.toContain('不执行逐帧分析就直接出结论是不允许的');
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
      expect(sql).toContain("present_type IN ('Late Present', 'Dropped Frame')");
      expect(sql).toContain("jank_responsibility = 'BUFFER_STUFFING'");
      expect(sql).toContain('android_is_missed_frame_type');
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
        consumer_jank_frames: 3,
        app_reported_jank: 3,
        false_positives: 1,
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
