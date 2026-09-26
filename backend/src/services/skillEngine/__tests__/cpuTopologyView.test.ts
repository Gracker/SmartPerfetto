// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import {builtInSkillFragment, injectFragmentCtes} from '../skillFragments';

const loadSkillYaml = (relativePath: string): any => {
  const skillPath = path.join(process.cwd(), relativePath);
  return yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
};

const loadCreateTopologySql = (): string => {
  const skill = loadSkillYaml('skills/atomic/cpu_topology_view.skill.yaml');
  const step = skill.steps?.find((candidate: any) => candidate.id === 'create_topology_view');
  expect(step?.sql).toBeTruthy();
  return step.sql;
};

const sqlite3Available = spawnSync('sqlite3', ['-version'], {encoding: 'utf-8'}).status === 0;
const describeWithSqlite = sqlite3Available ? describe : describe.skip;

const runTopologyFixture = (fixtureSql: string): Array<Record<string, unknown>> => {
  // The production statement intentionally uses Perfetto's durable table
  // syntax. SQLite is only the lightweight fixture engine here, so translate
  // that one DDL keyword while exercising the identical CTE/classification SQL.
  const createTopologySql = loadCreateTopologySql()
    .replace(/^\s*CREATE\s+PERFETTO\s+TABLE\s+/i, 'CREATE TABLE ');
  const schemaSql = `
    CREATE TABLE sched_slice(cpu INTEGER);
    CREATE TABLE thread_state(cpu INTEGER, state TEXT);
    CREATE TABLE cpu(id INTEGER, cpu INTEGER, machine_id INTEGER, capacity INTEGER);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
    CREATE TABLE counter(track_id INTEGER, value REAL);
  `;
  const selectSql = `
    SELECT
      cpu_id,
      capacity,
      max_freq,
      scale_value,
      universe_source,
      core_type,
      topology_source,
      cluster_rank,
      cluster_count,
      cores_in_cluster
    FROM _cpu_topology
    ORDER BY cpu_id;
  `;
  const result = spawnSync('sqlite3', ['-json', ':memory:'], {
    input: `${schemaSql}\n${fixtureSql}\n${createTopologySql};\n${selectSql}\n`,
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout.trim() || '[]') as Array<Record<string, unknown>>;
};

describe('cpu_topology_view SQL', () => {
  it('builds the CPU universe from observed trace data before falling back to cpu table rows', () => {
    const sql = loadCreateTopologySql();

    expect(sql).toContain('observed_sched_cpus AS');
    expect(sql).toContain('SELECT cpu as cpu_id FROM sched_slice WHERE cpu IS NOT NULL');
    expect(sql).toContain("WHERE cpu IS NOT NULL AND state = 'Running'");
    expect(sql).toContain('observed_counter_cpus AS');
    expect(sql).toContain('FROM cpu_counter_track t');
    expect(sql).toContain('JOIN counter c ON c.track_id = t.id');
    expect(sql).toContain('AND c.value > 0');
    expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM observed_sched_cpus)');
    expect(sql).toContain('cpu_table_fallback_no_observed');
  });

  it('does not guess core type from CPU id or fixed capacity scale', () => {
    const sql = loadCreateTopologySql();

    expect(sql).not.toMatch(/cpu_id\s*[<>]=?\s*\d/);
    expect(sql).not.toMatch(/capacity\s*>=\s*(1000|500)/);
    expect(sql).not.toContain('MAX(capacity) * 0.7');
    expect(sql).not.toContain('MAX(capacity) * 0.4');
    expect(sql).toContain('distinct_scales AS');
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY scale_bucket ASC) as cluster_rank');
    expect(sql).toContain('COUNT(*) OVER () as cluster_count');
    expect(sql).toContain('ROUND(rs.scale_value * 20.0');
    expect(sql).toContain('cores_in_cluster');
    expect(sql).toContain('WHERE cluster_rank = sc.cluster_count');
  });

  it('keeps missing scale data explicit instead of treating it as little cores', () => {
    const sql = loadCreateTopologySql();

    expect(sql).toContain("WHEN cs.scale_bucket IS NULL OR cs.scale_bucket <= 0 THEN 'unknown'");
    expect(sql).toContain('topology_source');
    expect(sql).toContain("'capacity_scale'");
    expect(sql).not.toContain("'freq_rank'");
    expect(sql).toContain("'observed_no_scale'");
  });

  it('keeps uniform CPU sets unknown regardless of core count', () => {
    const sql = loadCreateTopologySql();

    expect(sql).not.toContain("THEN 'little'\n          WHEN sc.cluster_count <= 1");
    expect(sql).toContain("WHEN sc.cluster_count <= 1 THEN 'unknown'");
    expect(sql).not.toContain("_uniform_four_little");
    expect(sql).toContain("cs.topology_source || '_uniform'");
  });

  it('keeps the public cpu_topology_detection skill delegated to the shared topology view', () => {
    const skill = loadSkillYaml('skills/atomic/cpu_topology_detection.skill.yaml');
    const initStep = skill.steps?.find((candidate: any) => candidate.id === 'init_cpu_topology');
    const allSql = skill.steps
      ?.map((candidate: any) => candidate.sql || '')
      .join('\n') || '';

    expect(initStep?.skill).toBe('cpu_topology_view');
    expect(allSql).toContain('FROM _cpu_topology');
    expect(allSql).toContain("core_type IN ('prime', 'big', 'medium')");
    expect(allSql).not.toContain('* 0.95');
    expect(allSql).not.toContain('* 0.75');
    expect(allSql).not.toContain('* 0.50');
    expect(allSql).not.toContain("'mid'");
  });
});

describeWithSqlite('cpu_topology_view fixture behavior', () => {
  it('prefers scheduled CPUs over stale cpu table and cpufreq rows', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100),
        (4, 300), (5, 300), (6, 300), (7, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3);
      INSERT INTO cpu_counter_track(id, cpu, name) VALUES
        (10, 0, 'cpufreq'), (11, 1, 'cpufreq'), (12, 2, 'cpufreq'), (13, 3, 'cpufreq'),
        (14, 4, 'cpufreq'), (15, 5, 'cpufreq'), (16, 6, 'cpufreq'), (17, 7, 'cpufreq');
      INSERT INTO counter(track_id, value) VALUES
        (10, 1000000), (11, 1000000), (12, 1000000), (13, 1000000),
        (14, 2000000), (15, 2000000), (16, 2000000), (17, 2000000);
    `);

    expect(rows.map(row => row.cpu_id)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map(row => row.universe_source))).toEqual(new Set(['sched_observed']));
    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
    expect(new Set(rows.map(row => row.topology_source))).toEqual(new Set(['capacity_scale_uniform']));
  });

  it('classifies 4+3+1 capacity layouts as little, big, prime', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100),
        (4, 300), (5, 300), (6, 300), (7, 500);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'little', 'big', 'big', 'big', 'prime',
    ]);
  });

  it('classifies 3+3+2 capacity layouts as little, medium, big', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100),
        (3, 300), (4, 300), (5, 300),
        (6, 500), (7, 500);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'medium', 'medium', 'medium', 'big', 'big',
    ]);
  });

  it('treats 4+2 capacity layouts as little and big, not prime', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100), (4, 300), (5, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'little', 'big', 'big',
    ]);
  });

  it('keeps uniform four-core Android layouts unknown', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES (0, 100), (1, 100), (2, 100), (3, 100);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3);
    `);

    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
    expect(new Set(rows.map(row => row.topology_source))).toEqual(new Set(['capacity_scale_uniform']));
  });

  it('keeps larger uniform CPU sets unknown instead of inventing big/little split', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100),
        (4, 100), (5, 100), (6, 100), (7, 100);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7);
    `);

    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
    expect(new Set(rows.map(row => row.topology_source))).toEqual(new Set(['capacity_scale_uniform']));
  });

  it('classifies 6+2 capacity layouts as little and big', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100), (4, 100), (5, 100),
        (6, 300), (7, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'little', 'little', 'little', 'big', 'big',
    ]);
  });

  it('classifies 4+4 capacity layouts as little and big', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100),
        (4, 300), (5, 300), (6, 300), (7, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'little', 'big', 'big', 'big', 'big',
    ]);
  });

  it('classifies 10-core tri-cluster layouts as little, medium, big', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100),
        (4, 250), (5, 250), (6, 250), (7, 250),
        (8, 500), (9, 500);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'little',
      'medium', 'medium', 'medium', 'medium',
      'big', 'big',
    ]);
  });

  it('buckets small per-core scale noise into one cluster', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES (0, 1000), (1, 1001), (2, 1002), (3, 1003);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3);
    `);

    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
    expect(new Set(rows.map(row => row.cluster_count))).toEqual(new Set([1]));
  });

  it('does not turn zero-frequency fallback data into a medium cluster', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(cpu, capacity) VALUES (0, 0), (1, 0), (2, 0), (3, 0);
      INSERT INTO cpu_counter_track(id, cpu, name) VALUES
        (10, 0, 'cpufreq'), (11, 1, 'cpufreq'), (12, 2, 'cpufreq'), (13, 3, 'cpufreq');
      INSERT INTO counter(track_id, value) VALUES (10, 0), (11, 0), (12, 0), (13, 0);
    `);

    expect(rows.map(row => row.cpu_id)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map(row => row.universe_source))).toEqual(new Set(['cpu_table_fallback_no_observed']));
    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
  });
});

describeWithSqlite('topology evidence authority', () => {
  it('uses local CPU metadata even when universal CPU IDs differ', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, cpu, machine_id, capacity) VALUES (91, 0, 8, 100), (3, 1, 8, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1);
    `);
    expect(rows.map(row => [row.cpu_id, row.capacity, row.core_type])).toEqual([
      [0, 100, 'little'], [1, 300, 'big'],
    ]);
  });
  it.each([false, true])('never classifies from frequency with partial capacity=%s', partial => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, cpu, capacity) VALUES (7, 0, ${partial ? 100 : 'NULL'}), (9, 1, NULL);
      INSERT INTO sched_slice(cpu) VALUES (0), (1);
      INSERT INTO cpu_counter_track(id, cpu, name) VALUES (10, 0, 'cpufreq'), (11, 1, 'cpufreq');
      INSERT INTO counter(track_id, value) VALUES (10, 800000), (11, 3000000);
    `);
    expect(rows.map(row => row.max_freq)).toEqual([800000, 3000000]);
    expect(rows.every(row => row.core_type === 'unknown' && row.scale_value === null && row.cluster_rank === null)).toBe(true);
  });
  it.each([true, false])('collapses duplicate local CPUs across machines with sched observed=%s', observed => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, cpu, machine_id, capacity) VALUES
        (0, 0, NULL, 100), (1, 1, NULL, 300), (2, 0, 2, 400), (3, 1, 2, 900);
      ${observed ? 'INSERT INTO sched_slice(cpu) VALUES (0), (1), (0), (1);' : ''}
      INSERT INTO cpu_counter_track(id, cpu, name) VALUES (10,0,'cpufreq'),(11,0,'cpufreq'),(12,1,'cpufreq');
      INSERT INTO counter(track_id,value) VALUES (10,1000000),(11,3000000),(12,2000000);
    `);
    expect(rows.map(row => row.cpu_id)).toEqual([0, 1]);
    expect(rows.every(row => row.core_type === 'unknown' && row.capacity === null && row.scale_value === null && row.max_freq === null && row.topology_source === 'multi_machine_unresolved')).toBe(true);
  });
  it('does not infer a single machine from disjoint local CPU numbers', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, cpu, machine_id, capacity) VALUES (0, 0, 1, 100), (1, 1, 2, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1);
    `);
    expect(rows.every(row => row.capacity === null && row.core_type === 'unknown' && row.topology_source === 'multi_machine_unresolved')).toBe(true);
  });
  it('does not multiply ambiguous metadata on one machine', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, cpu, capacity) VALUES (0, 0, 100), (1, 0, 300), (2, 1, 500);
      INSERT INTO sched_slice(cpu) VALUES (0), (1);
    `);
    expect(rows.map(row => row.cpu_id)).toEqual([0, 1]);
    expect(rows[0].capacity).toBeNull();
    expect(rows.every(row => row.core_type === 'unknown' && row.topology_source === 'ambiguous_cpu_metadata')).toBe(true);
  });
});

// fragments/cpu_cluster_load.sql is the one cluster-load definition: the
// cpu_cluster_load_in_range table and jank_frame_detail's root cause read it.
describe('shared CPU cluster load', () => {
  const window = {start_ts: '1000', end_ts: '2000'};
  const bindWindow = (sql: string): string =>
    sql.replace(/\$\{(start_ts|end_ts)\}/g, (_match, name: 'start_ts' | 'end_ts') => window[name]);
  const clusterFragment = (): string => builtInSkillFragment('cpu_cluster_load.sql');

  // Four capacity tiers: little x4, medium x2, big x1, prime x1. Every CPU has
  // sched data (it is observed), but only some ran a task in the window. The
  // prime core's last Running row is unfinished (dur = -1) and runs to the
  // trace end at 1900.
  const openFixture = (toMonotonic: (ts: number) => number | null): Database.Database => {
    const db = new Database(':memory:');
    db.function('to_monotonic', (ts: unknown) => toMonotonic(Number(ts)));
    db.exec(`
      CREATE TABLE sched_slice(cpu INTEGER);
      CREATE TABLE thread_state(utid INTEGER, ts INTEGER, dur INTEGER, state TEXT, cpu INTEGER);
      CREATE TABLE cpu(id INTEGER, cpu INTEGER, machine_id INTEGER, capacity INTEGER);
      CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
      CREATE TABLE counter(track_id INTEGER, value REAL);
      CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0, 1900);
      INSERT INTO sched_slice VALUES (0), (1), (2), (3), (4), (5), (6), (7);
      INSERT INTO cpu VALUES
        (0, 0, 0, 100), (1, 1, 0, 100), (2, 2, 0, 100), (3, 3, 0, 100),
        (4, 4, 0, 400), (5, 5, 0, 400), (6, 6, 0, 700), (7, 7, 0, 1024);
      INSERT INTO thread_state VALUES
        (1, 500, 1000, 'Running', 0),
        (2, 500, 600, 'Running', 1),
        (3, 1000, 250, 'Running', 4),
        (4, 1000, 400, 'Running', 6),
        (5, 1000, 800, 'S', 7),
        (6, 1800, -1, 'Running', 7);
    `);
    db.exec(loadCreateTopologySql().replace(/^\s*CREATE\s+PERFETTO\s+TABLE\s+/i, 'CREATE TABLE '));
    return db;
  };

  const clusterTable = (db: Database.Database): Array<Record<string, unknown>> => {
    const step = loadSkillYaml('skills/atomic/cpu_cluster_load_in_range.skill.yaml')
      .steps.find((candidate: any) => candidate.id === 'cluster_load');
    expect(step.sql_fragments).toEqual(['fragments/cpu_cluster_load.sql']);
    return db.prepare(bindWindow(injectFragmentCtes(step.sql, [clusterFragment()]))).all() as Array<Record<string, unknown>>;
  };

  const jankClusterLoad = (db: Database.Database): Record<string, unknown> => {
    const step = loadSkillYaml('skills/composite/jank_frame_detail.skill.yaml')
      .steps.find((candidate: any) => candidate.id === 'root_cause_summary');
    expect(step.sql_fragments).toContain('fragments/cpu_cluster_load.sql');
    const cte = String(step.sql).match(/\n\s*(cluster_load AS \([\s\S]*?\n\s*\)),\n/)?.[1];
    expect(cte).toContain('FROM cpu_cluster_load_by_tier');
    return db.prepare(bindWindow(`WITH ${clusterFragment()},\n${cte}\nSELECT * FROM cluster_load`)).get() as Record<string, unknown>;
  };

  it('divides by every topology core times awake time', () => {
    // 500 ns of suspend inside the window: awake time is 500, not 1000.
    const db = openFixture(ts => (ts >= 2000 ? ts - 500 : ts));
    expect(clusterTable(db).map(({cluster, core_count, active_core_count, awake_ms, load_pct, max_single_core_pct}) =>
      ({cluster, core_count, active_core_count, awake_ms, load_pct, max_single_core_pct}))).toEqual([
      {cluster: '超大核簇', core_count: 1, active_core_count: 1, awake_ms: 0, load_pct: 20, max_single_core_pct: 20},
      {cluster: '大核簇', core_count: 1, active_core_count: 1, awake_ms: 0, load_pct: 80, max_single_core_pct: 80},
      {cluster: '中核簇', core_count: 2, active_core_count: 1, awake_ms: 0, load_pct: 25, max_single_core_pct: 50},
      {cluster: '小核簇', core_count: 4, active_core_count: 2, awake_ms: 0, load_pct: 30, max_single_core_pct: 100},
    ]);
    // Root cause: 大核 = prime + big + medium over their 4 cores, same denominator.
    expect(jankClusterLoad(db)).toEqual({big_load_pct: 37.5, little_load_pct: 30});
  });

  it('falls back to wall-clock time without a clock snapshot', () => {
    const db = openFixture(() => null);
    expect(clusterTable(db).find(row => row.cluster === '小核簇')?.load_pct).toBe(15);
    expect(jankClusterLoad(db)).toEqual({big_load_pct: 18.8, little_load_pct: 15});
  });
});
