// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import yaml from 'js-yaml';
import {describe, expect, it} from '@jest/globals';

const loadCreateTopologySql = (): string => {
  const skillPath = path.join(process.cwd(), 'skills/atomic/cpu_topology_view.skill.yaml');
  const skill = yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
  const step = skill.steps?.find((candidate: any) => candidate.id === 'create_topology_view');
  expect(step?.sql).toBeTruthy();
  return step.sql;
};

const loadText = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');

const sqlite3Available = spawnSync('sqlite3', ['-version'], {encoding: 'utf-8'}).status === 0;
const describeWithSqlite = sqlite3Available ? describe : describe.skip;

const runTopologyFixture = (fixtureSql: string): Array<Record<string, unknown>> => {
  const createTopologySql = loadCreateTopologySql();
  const schemaSql = `
    CREATE TABLE sched_slice(cpu INTEGER);
    CREATE TABLE thread_state(cpu INTEGER, state TEXT);
    CREATE TABLE cpu(id INTEGER, capacity INTEGER);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
    CREATE TABLE counter(track_id INTEGER, value REAL);
  `;
  const selectSql = `
    SELECT
      cpu_id,
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

const extractInlineTopologyCte = (relativePath: string): string => {
  const source = loadText(relativePath);
  const match = source.match(/const CPU_TOPOLOGY_CTE = `([\s\S]*?)`;/);
  expect(match?.[1]).toBeTruthy();
  return match?.[1] ?? '';
};

const runInlineTopologyFixture = (
  relativePath: string,
  fixtureSql: string
): Array<Record<string, unknown>> => {
  const cte = extractInlineTopologyCte(relativePath);
  const schemaSql = `
    CREATE TABLE sched_slice(cpu INTEGER);
    CREATE TABLE thread_state(cpu INTEGER, state TEXT);
    CREATE TABLE cpu(id INTEGER, capacity INTEGER);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
    CREATE TABLE counter(track_id INTEGER, value REAL);
  `;
  const result = spawnSync('sqlite3', ['-json', ':memory:'], {
    input: `${schemaSql}\n${fixtureSql}\nWITH ${cte}\nSELECT cpu_id, core_type FROM cpu_topology ORDER BY cpu_id;\n`,
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
    expect(sql).toContain("'freq_rank'");
    expect(sql).toContain("'observed_no_scale'");
  });

  it('keeps uniform-scale CPU sets explicit instead of naming them big or prime clusters', () => {
    const sql = loadCreateTopologySql();

    expect(sql).toContain("WHEN sc.cluster_count <= 1 THEN 'unknown'");
    expect(sql).toContain("cs.topology_source || '_uniform'");
  });

  it('keeps TypeScript inline topology copies aligned with the same invariants', () => {
    for (const source of [
      loadText('src/agent/tools/frameAnalyzer.ts'),
      loadText('src/services/perfettoSqlSkill.ts'),
    ]) {
      expect(source).toContain('observed_sched_cpus AS');
      expect(source).toContain("WHERE cpu IS NOT NULL AND state = 'Running'");
      expect(source).toContain('observed_counter_cpus AS');
      expect(source).toContain('AND c.value > 0');
      expect(source).toContain('cpu_table_fallback_no_observed');
      expect(source).toContain('ROUND(rs.scale_value * 20.0');
      expect(source).toContain("WHEN sc.cluster_count = 2 AND sc.cluster_rank = sc.cluster_count THEN 'big'");
      expect(source).not.toMatch(/cpu\s*>?=\s*4/);
      expect(source).not.toMatch(/cpu\s*<\s*4/);
      expect(source).not.toMatch(/capacity\s*>=\s*(1000|500)/);
    }
  });
});

describeWithSqlite('cpu_topology_view fixture behavior', () => {
  it('prefers scheduled CPUs over stale cpu table and cpufreq rows', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, capacity) VALUES
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
      INSERT INTO cpu(id, capacity) VALUES
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
      INSERT INTO cpu(id, capacity) VALUES
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
      INSERT INTO cpu(id, capacity) VALUES
        (0, 100), (1, 100), (2, 100), (3, 100), (4, 300), (5, 300);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5);
    `);

    expect(rows.map(row => row.core_type)).toEqual([
      'little', 'little', 'little', 'little', 'big', 'big',
    ]);
  });

  it('keeps uniform four-core devices unknown instead of guessing a cluster name', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, capacity) VALUES (0, 100), (1, 100), (2, 100), (3, 100);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3);
    `);

    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
    expect(new Set(rows.map(row => row.topology_source))).toEqual(new Set(['capacity_scale_uniform']));
  });

  it('buckets small per-core scale noise into one cluster', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, capacity) VALUES (0, 1000), (1, 1001), (2, 1002), (3, 1003);
      INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3);
    `);

    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
    expect(new Set(rows.map(row => row.cluster_count))).toEqual(new Set([1]));
  });

  it('does not turn zero-frequency fallback data into a medium cluster', () => {
    const rows = runTopologyFixture(`
      INSERT INTO cpu(id, capacity) VALUES (0, 0), (1, 0), (2, 0), (3, 0);
      INSERT INTO cpu_counter_track(id, cpu, name) VALUES
        (10, 0, 'cpufreq'), (11, 1, 'cpufreq'), (12, 2, 'cpufreq'), (13, 3, 'cpufreq');
      INSERT INTO counter(track_id, value) VALUES (10, 0), (11, 0), (12, 0), (13, 0);
    `);

    expect(rows.map(row => row.cpu_id)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map(row => row.universe_source))).toEqual(new Set(['cpu_table_fallback_no_observed']));
    expect(new Set(rows.map(row => row.core_type))).toEqual(new Set(['unknown']));
  });

  it('keeps TypeScript inline topology behavior aligned for stale metadata and common layouts', () => {
    for (const sourcePath of [
      'src/agent/tools/frameAnalyzer.ts',
      'src/services/perfettoSqlSkill.ts',
    ]) {
      const staleRows = runInlineTopologyFixture(sourcePath, `
        INSERT INTO cpu(id, capacity) VALUES
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
      expect(staleRows.map(row => row.cpu_id)).toEqual([0, 1, 2, 3]);

      const layoutRows = runInlineTopologyFixture(sourcePath, `
        INSERT INTO cpu(id, capacity) VALUES
          (0, 100), (1, 100), (2, 100), (3, 100),
          (4, 300), (5, 300), (6, 300), (7, 500);
        INSERT INTO sched_slice(cpu) VALUES (0), (1), (2), (3), (4), (5), (6), (7);
      `);
      expect(layoutRows.map(row => row.core_type)).toEqual([
        'little', 'little', 'little', 'little', 'big', 'big', 'big', 'prime',
      ]);
    }
  });
});
