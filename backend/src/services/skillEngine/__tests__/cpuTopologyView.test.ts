// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {spawnSync} from 'child_process';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, expect, it, jest} from '@jest/globals';
import {builtInSkillFragment, injectFragmentCtes} from '../skillFragments';
import {PerfettoSqlSkill} from '../../perfettoSqlSkill';
import {frameAnalyzerTool} from '../../../agent/tools/frameAnalyzer';
import {sqlExecutorTool} from '../../../agent/tools/sqlExecutor';

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

const loadText = (relativePath: string): string =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');

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
    CREATE TABLE cpu(id INTEGER, cpu INTEGER, machine_id INTEGER, capacity INTEGER);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
    CREATE TABLE counter(track_id INTEGER, value REAL);
  `;
  const result = spawnSync('sqlite3', ['-json', ':memory:'], {
    input: `${schemaSql}\n${fixtureSql}\nWITH ${cte}\nSELECT cpu_id, core_type, capacity, max_freq, scale_value, topology_source, cluster_rank FROM cpu_topology ORDER BY cpu_id;\n`,
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
      expect(source).not.toContain("_uniform_four_little");
      expect(source).not.toContain("'freq_rank'");
      expect(source).toContain("WHEN sc.cluster_count = 2 AND sc.cluster_rank = sc.cluster_count THEN 'big'");
      expect(source).not.toMatch(/cpu\s*>?=\s*4/);
      expect(source).not.toMatch(/cpu\s*<\s*4/);
      expect(source).not.toMatch(/capacity\s*>=\s*(1000|500)/);
    }
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

  it('keeps TypeScript inline topology behavior aligned for stale metadata and common layouts', () => {
    for (const sourcePath of [
      'src/agent/tools/frameAnalyzer.ts',
      'src/services/perfettoSqlSkill.ts',
    ]) {
      const staleRows = runInlineTopologyFixture(sourcePath, `
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
      expect(staleRows.map(row => row.cpu_id)).toEqual([0, 1, 2, 3]);

      const layoutRows = runInlineTopologyFixture(sourcePath, `
        INSERT INTO cpu(cpu, capacity) VALUES
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


describeWithSqlite('topology evidence authority across all three SQL producers', () => {
  const producers = [
    {name: 'atomic Skill', run: runTopologyFixture},
    ...['src/agent/tools/frameAnalyzer.ts', 'src/services/perfettoSqlSkill.ts'].map(source => ({
      name: source,
      run: (fixture: string) => runInlineTopologyFixture(source, fixture),
    })),
  ];
  for (const producer of producers) {
    describe(producer.name, () => {
      it('uses local CPU metadata even when universal CPU IDs differ', () => {
        const rows = producer.run(`
          INSERT INTO cpu(id, cpu, machine_id, capacity) VALUES (91, 0, 8, 100), (3, 1, 8, 300);
          INSERT INTO sched_slice(cpu) VALUES (0), (1);
        `);
        expect(rows.map(row => [row.cpu_id, row.capacity, row.core_type])).toEqual([
          [0, 100, 'little'], [1, 300, 'big'],
        ]);
      });
      it.each([false, true])('never classifies from frequency with partial capacity=%s', partial => {
        const rows = producer.run(`
          INSERT INTO cpu(id, cpu, capacity) VALUES (7, 0, ${partial ? 100 : 'NULL'}), (9, 1, NULL);
          INSERT INTO sched_slice(cpu) VALUES (0), (1);
          INSERT INTO cpu_counter_track(id, cpu, name) VALUES (10, 0, 'cpufreq'), (11, 1, 'cpufreq');
          INSERT INTO counter(track_id, value) VALUES (10, 800000), (11, 3000000);
        `);
        expect(rows.map(row => row.max_freq)).toEqual([800000, 3000000]);
        expect(rows.every(row => row.core_type === 'unknown' && row.scale_value === null && row.cluster_rank === null)).toBe(true);
      });
      it.each([true, false])('collapses duplicate local CPUs across machines with sched observed=%s', observed => {
        const rows = producer.run(`
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
        const rows = producer.run(`
          INSERT INTO cpu(id, cpu, machine_id, capacity) VALUES (0, 0, 1, 100), (1, 1, 2, 300);
          INSERT INTO sched_slice(cpu) VALUES (0), (1);
        `);
        expect(rows.every(row => row.capacity === null && row.core_type === 'unknown' && row.topology_source === 'multi_machine_unresolved')).toBe(true);
      });
      it('does not multiply ambiguous metadata on one machine', () => {
        const rows = producer.run(`
          INSERT INTO cpu(id, cpu, capacity) VALUES (0, 0, 100), (1, 0, 300), (2, 1, 500);
          INSERT INTO sched_slice(cpu) VALUES (0), (1);
        `);
        expect(rows.map(row => row.cpu_id)).toEqual([0, 1]);
        expect(rows[0].capacity).toBeNull();
        expect(rows.every(row => row.core_type === 'unknown' && row.topology_source === 'ambiguous_cpu_metadata')).toBe(true);
      });
    });
  }
});

describe('startup core distribution coverage', () => {
  const analyze = async (rows: unknown[][]) => {
    const service = Object.create(PerfettoSqlSkill.prototype) as any;
    service.traceProcessor = {
      query: async (_traceId: string, sql: string) => sql.includes('SUM(sched.clipped_dur) / 1e6 as total_dur_ms')
        ? {columns: ['cpu', 'core_type', 'total_dur_ms'], rows}
        : {columns: [], rows: []},
    };
    return service.analyzeOneStartup('fixture', 0, 100000000, 'com.fixture', 'cold', 100, 1, 1);
  };
  it('keeps unknown Running time in the denominator and visible summary', async () => {
    const result = await analyze([[0, 'big', 20], [1, 'little', 30], [2, 'unknown', 50]]);
    expect(result.sections.cpuCoreDistribution.summary).toMatchObject({
      bigCorePercent: '20.0', littleCorePercent: '30.0', unknownCorePercent: '50.0',
      totalCoreTime: '100.00', classificationCoveragePercent: '50.0', classificationStatus: 'partial',
    });
    expect(result.summary).toContain('未分类运行时间: 50.00ms (50.0%)');
  });
  it('renders unavailable classification explicitly instead of a 0/0 split', async () => {
    const result = await analyze([[0, 'unknown', 80]]);
    expect(result.sections.cpuCoreDistribution.summary).toMatchObject({
      unknownCoreTime: '80.00', unknownCorePercent: '100.0', classificationCoveragePercent: '0.0', classificationStatus: 'unknown',
    });
    expect(result.summary).toContain('核心类型未知');
    expect(result.summary).not.toContain('大核运行时间:');
    expect(result.summary).not.toContain('小核运行时间:');
  });
});


describeWithSqlite('direct consumer topology and interval behavior', () => {
  const runConsumerSql = (sql: string, fixture: string) => {
    const result = spawnSync('sqlite3', ['-json', ':memory:'], {
      input: `
        CREATE TABLE cpu(id INTEGER, cpu INTEGER, machine_id INTEGER, capacity INTEGER);
        CREATE TABLE sched_slice(cpu INTEGER, utid INTEGER, ts INTEGER, dur INTEGER);
        CREATE TABLE thread_state(cpu INTEGER, utid INTEGER, ts INTEGER, dur INTEGER, state TEXT);
        CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
        CREATE TABLE counter(track_id INTEGER, value REAL);
        CREATE TABLE thread(utid INTEGER, tid INTEGER, upid INTEGER, name TEXT);
        CREATE TABLE process(upid INTEGER, pid INTEGER, name TEXT);
        CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
        INSERT INTO thread VALUES (1, 100, 10, 'main');
        INSERT INTO process VALUES (10, 100, 'com.fixture');
        ${fixture}
        ${sql};
      `,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const objects: Record<string, unknown>[] = JSON.parse(result.stdout.trim() || '[]');
    const columns = Object.keys(objects[0] ?? {});
    return {columns, rows: objects.map(row => columns.map(column => row[column]))};
  };

  it('returns unknown Running percentage through actual quadrant SQL and output mapping', async () => {
    const spy = jest.spyOn(sqlExecutorTool, 'execute').mockImplementation(async params => {
      const data = runConsumerSql(params.sql, `
        INSERT INTO cpu(id, cpu, capacity) VALUES (90, 0, NULL);
        INSERT INTO thread_state VALUES
          (0, 1, 0, 60000000, 'Running'), (NULL, 1, 60000000, 20000000, 'R'),
          (NULL, 1, 80000000, 20000000, 'S');
      `);
      return {success: true, data: {...data, rowCount: data.rows.length}, executionTimeMs: 0};
    });
    try {
      const result = await frameAnalyzerTool.execute({
        start_ts: '0', end_ts: '100000000', package: 'com.fixture', include_quadrants: true,
      }, {} as any);
      expect(result.success).toBe(true);
      expect(result.data?.quadrants).toEqual([{
        thread_type: 'MainThread', q1_pct: 0, q2_pct: 0, q3_pct: 20, q4_pct: 20, q_unknown_pct: 60,
      }]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([[90000000, -1], [150000000, -1], [150000000, 40000000]])('clips startup Running to both boundaries with trace end=%s and tail duration=%s', (traceEnd, tailDuration) => {
    const service = Object.create(PerfettoSqlSkill.prototype) as any;
    service.traceProcessor = {
      query: async (_id: string, sql: string) => sql.includes('SUM(sched.clipped_dur) / 1e6 as total_dur_ms')
        ? runConsumerSql(sql, `
          INSERT INTO trace_bounds VALUES (0, ${traceEnd});
          INSERT INTO cpu(id, cpu, capacity) VALUES (91, 0, NULL), (92, 1, NULL);
          INSERT INTO sched_slice VALUES
            (0, 1, 5000000, 10000000), (0, 1, 15000000, 65000000),
            (1, 1, 80000000, ${tailDuration}), (0, 1, 0, 10000000),
            (0, 1, 100000000, 10000000), (0, 1, 90000000, 0);
        `)
        : {columns: [], rows: []},
    };
    return service.analyzeOneStartup('fixture', 10000000, 100000000, 'com.fixture', 'cold', 90, 1, 1)
      .then((result: any) => {
        const distribution = result.sections.cpuCoreDistribution;
        expect(distribution.data).toEqual([
          {cpu: 0, core_type: 'unknown', total_dur_ms: 70, slice_count: 2, avg_dur_ms: 35},
          {cpu: 1, core_type: 'unknown', total_dur_ms: traceEnd === 90000000 ? 10 : 20,
            slice_count: 1, avg_dur_ms: traceEnd === 90000000 ? 10 : 20},
        ]);
        expect(distribution.summary.totalCoreTime).toBe(traceEnd === 90000000 ? '80.00' : '90.00');
        expect(distribution.summary.unknownCorePercent).toBe('100.0');
      });
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
