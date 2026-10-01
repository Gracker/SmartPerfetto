// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, expect, it, jest} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {normalizeSkillDefinition} from '../skillLoader';
import type {DiagnosticResult, SkillDefinition} from '../types';
import {renderStepSql} from '../../../../tests/helpers/skillFragmentSql';

/**
 * The big/little rollup contract over CPU core tiers, documented in
 * atomic/cpu_topology_view.skill.yaml: big group = prime + big + medium,
 * little = little only, unknown time is its own bucket and never reads as 0%
 * big. Static checks keep every tier list in the Skills on that contract;
 * fixtures run the maintained Skills through the executor over a four-tier
 * SoC, because the canonical traces carry no CPU capacity and classify every
 * core as unknown.
 */

const skillsDir = path.join(process.cwd(), 'skills');
const yamlCache = new Map<string, any>();
/** Parsed once per file; callers copy with `fresh` before handing it to an executor. */
const loadYaml = (rel: string): any => {
  if (!yamlCache.has(rel)) yamlCache.set(rel, yaml.load(fs.readFileSync(path.join(skillsDir, rel), 'utf8')));
  return yamlCache.get(rel);
};
const stepOf = (skill: any, id: string): any => {
  const step = skill.steps.find((candidate: any) => candidate.id === id);
  if (!step) throw new Error(`step ${id} not found`);
  return step;
};
/** A fresh plain copy per run: the executor must never see state from a previous one. */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));

let sources: Array<{file: string; text: string}> | undefined;
function skillSources(): Array<{file: string; text: string}> {
  if (sources) return sources;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      // Authoring templates hold placeholders, not runnable Skills.
      if (entry.isDirectory()) { if (entry.name !== '_template') walk(full); }
      else if (/\.(skill\.yaml|sql)$/.test(entry.name)) files.push(full);
    }
  };
  walk(skillsDir);
  sources = files.map(file => ({file: path.relative(skillsDir, file), text: fs.readFileSync(file, 'utf8')}));
  return sources;
}

const TIERS = new Set(['prime', 'big', 'medium', 'little', 'unknown']);
const setKey = (tiers: string[]) => [...new Set(tiers)].sort().join(',');
// Single tiers, the big group, and the known tiers (positive membership).
const ALLOWED_IN = new Set(['prime', 'big', 'medium', 'little', 'unknown',
  'big,medium,prime', 'big,little,medium,prime']);
// Unknown detection, and its complement.
const ALLOWED_NOT_IN = new Set(['big,little,medium,prime', 'unknown']);

/** Violations of the tier-list contract in one source text. */
function tierListViolations(text: string): string[] {
  const violations: string[] = [];
  const literals = (list: string) => [...list.matchAll(/'(\w+)'/g)].map(match => match[1]);
  for (const match of text.matchAll(/\b\w*core_type\s+(NOT\s+)?IN\s*\(([^)]*)\)/gi)) {
    const tiers = literals(match[2]);
    if (tiers.length === 0 || !tiers.every(tier => TIERS.has(tier))) continue;
    const allowed = match[1] ? ALLOWED_NOT_IN : ALLOWED_IN;
    if (!allowed.has(setKey(tiers))) violations.push(match[0]);
  }
  for (const match of text.matchAll(/\[([^\]]*)\]\.includes\(([^)]*core_type[^)]*)\)/g)) {
    const tiers = literals(match[1]);
    if (tiers.length > 0 && tiers.every(tier => TIERS.has(tier)) && !ALLOWED_IN.has(setKey(tiers))) {
      violations.push(match[0]);
    }
  }
  // Substring tests on tier labels ('big (大核)'.includes('big')) pick one tier
  // where a group was meant; rollups are SQL columns.
  for (const match of text.matchAll(/core_type[^\n]{0,40}?\.includes\('(prime|big|medium|little)'\)/g)) {
    violations.push(match[0]);
  }
  // Running time with no tier must not fall into the little quadrant.
  for (const match of text.matchAll(/WHEN\s+state\s*=\s*'Running'\s+THEN\s+'Q2/gi)) violations.push(match[0]);
  return violations;
}

// Big-group output columns (internal CTE amounts such as q1_big_core_ns are not outputs).
const BIG_GROUP_OUTPUT = /\bAS\s+(big_core_(pct|percent|ms)|q1_big_(running_ms|pct))\b/i;

/** SQL steps emitting a big-group share must also emit unknown time beside it. */
function siblingViolations(skill: any): string[] {
  const violations: string[] = [];
  const visit = (steps: any[] | undefined) => {
    for (const step of steps ?? []) {
      if (typeof step.sql === 'string') {
        const sql = step.sql as string;
        if (BIG_GROUP_OUTPUT.test(sql) && !/\bAS\s+unknown_\w+/i.test(sql)) {
          violations.push(`${step.id}: big-group column without an unknown_* sibling`);
        }
        for (const match of sql.matchAll(/\bAS\s+(\w+)_definition\b/gi)) {
          if (!new RegExp(`\\bAS\\s+${match[1]}\\b`, 'i').test(sql)) {
            violations.push(`${step.id}: ${match[1]}_definition without ${match[1]}`);
          }
        }
      }
      visit(step.steps);
    }
  };
  if (typeof skill?.sql === 'string') visit([{id: 'root', sql: skill.sql}]);
  visit(skill?.steps);
  return violations;
}

describe('core tier rollup contract (static)', () => {
  it('keeps every tier list in the Skills on the rollup contract', () => {
    const violations = skillSources().flatMap(({file, text}) =>
      tierListViolations(text).map(violation => `${file}: ${violation}`));
    expect(violations).toEqual([]);
  });

  it('puts an unknown sibling next to every big-group output', () => {
    const violations = skillSources()
      // A comment-only file (pipelines/_base) holds no Skill.
      .filter(({file, text}) => file.endsWith('.skill.yaml') && /^[^#\s]/m.test(text))
      .flatMap(({file, text}) => siblingViolations(yaml.load(text)).map(violation => `${file}: ${violation}`));
    expect(violations).toEqual([]);
  });

  it.each([
    ["SUM(CASE WHEN core_type IN ('prime', 'big') THEN dur END)", 1],
    ["SUM(CASE WHEN core_type IN ('medium', 'little') THEN dur END)", 1],
    ["WHERE core_type NOT IN ('big', 'medium', 'little')", 1],
    ["WHEN state = 'Running' THEN 'Q2_little_running'", 1],
    ["data.find(c => (c.core_type || '').includes('big'))", 1],
    ["data.find(f => ['prime', 'big'].includes(f.core_type))", 1],
    ["SUM(CASE WHEN core_type IN ('prime','big','medium') THEN dur END)", 0],
    ["WHERE core_type IN ('prime', 'big', 'medium', 'little')", 0],
    ["WHERE core_type NOT IN ('prime','big','medium','little')", 0],
    ["WHERE core_type IN ('little')", 0],
    ["data.find(f => ['prime', 'big', 'medium'].includes(f.core_type))", 0],
  ])('classifies %s', (text, count) => {
    expect(tierListViolations(text)).toHaveLength(count);
  });

  it('requires the unknown sibling and the declared column to travel together', () => {
    expect(siblingViolations({steps: [{id: 'a', sql: 'SELECT 1 AS big_core_pct'}]})).toHaveLength(1);
    expect(siblingViolations({steps: [{id: 'a', sql: 'SELECT 1 AS big_core_pct, 0 AS unknown_core_ms'}]})).toEqual([]);
    expect(siblingViolations({steps: [{id: 'a', sql: "SELECT 'x' AS big_core_pct_definition, 0 AS unknown_x"}]}))
      .toEqual(['a: big_core_pct_definition without big_core_pct']);
  });
});

// ---------------------------------------------------------------------------
// Executor fixtures over _cpu_topology (cpu_topology_view's own SQL).
// ---------------------------------------------------------------------------

// Four capacity tiers plus a CPU whose capacity is under 1/40 of the largest:
// its scale bucket rounds to 0, so it stays 'unknown' beside classified cores.
//   cpu0,1 little(100)  cpu2,3 medium(400)  cpu4 big(700)  cpu5 prime(1024)  cpu6 unknown(10)
const FOUR_TIERS: Array<number | null> = [100, 100, 400, 400, 700, 1024, 10];
const MS = 1_000_000;

type Slice = [utid: number, cpu: number, ms: number];

/** utid 1 = main thread of com.example.app (pid 100); utid 2 = its worker. */
function openTrace(capacities: Array<number | null>, slices: Slice[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, uid INTEGER, android_appid INTEGER);
    CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, tid INTEGER, name TEXT, is_main_thread INTEGER, is_idle INTEGER);
    CREATE TABLE cpu(id INTEGER PRIMARY KEY, cpu INTEGER, machine_id INTEGER, cluster_id INTEGER, capacity INTEGER);
    CREATE TABLE sched_slice(id INTEGER PRIMARY KEY, utid INTEGER, ts INTEGER, dur INTEGER, cpu INTEGER, ucpu INTEGER, end_state TEXT, priority INTEGER);
    CREATE TABLE thread_state(id INTEGER PRIMARY KEY, utid INTEGER, ts INTEGER, dur INTEGER, state TEXT, cpu INTEGER, ucpu INTEGER, blocked_function TEXT, io_wait INTEGER, waker_utid INTEGER);
    CREATE TABLE cpu_counter_track(id INTEGER, cpu INTEGER, name TEXT);
    CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
    CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
    CREATE TABLE slice(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, name TEXT, track_id INTEGER, depth INTEGER);
    INSERT INTO process VALUES (1, 100, 'com.example.app', 10100, 10100);
    INSERT INTO thread VALUES (0, NULL, 0, 'swapper', 0, 1), (1, 1, 100, 'main', 1, 0), (2, 1, 101, 'worker', 0, 0);
  `);
  const addCpu = db.prepare('INSERT INTO cpu VALUES (?, ?, 0, ?, ?)');
  capacities.forEach((capacity, cpu) => addCpu.run(cpu, cpu, cpu, capacity));
  // _cpu_topology classifies the CPUs the trace observed: idle time puts every
  // CPU in that universe, as on a real device.
  const addIdle = db.prepare("INSERT INTO sched_slice(utid, ts, dur, cpu, ucpu, end_state, priority) VALUES (0, 0, 1, ?, ?, 'R', 120)");
  capacities.forEach((_capacity, cpu) => addIdle.run(cpu, cpu));
  const addSlice = db.prepare('INSERT INTO sched_slice(utid, ts, dur, cpu, ucpu, end_state, priority) VALUES (?, ?, ?, ?, ?, ?, 120)');
  const addState = db.prepare('INSERT INTO thread_state(utid, ts, dur, state, cpu, ucpu) VALUES (?, ?, ?, ?, ?, ?)');
  const cursor = new Map<number, number>();
  for (const [utid, cpu, ms] of slices) {
    const ts = cursor.get(utid) ?? 0;
    addSlice.run(utid, ts, ms * MS, cpu, cpu, 'S');
    addState.run(utid, ts, ms * MS, 'Running', cpu, cpu);
    // 2 ms runnable and 1 ms sleeping after each slice: latency stays normal.
    addState.run(utid, ts + ms * MS, 2 * MS, 'R', null, null);
    addState.run(utid, ts + (ms + 2) * MS, 1 * MS, 'S', null, null);
    cursor.set(utid, ts + (ms + 3) * MS);
  }
  db.prepare('INSERT INTO trace_bounds VALUES (0, ?)').run(Math.max(...cursor.values(), 1));
  return db;
}

/** Runs `use` over a fresh trace and closes it afterwards. */
async function withTrace<T>(capacities: Array<number | null>, slices: Slice[],
  use: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const db = openTrace(capacities, slices);
  try { return await use(db); } finally { db.close(); }
}

// main thread: prime 10, big 10, medium 40, little 20, unknown 20 (ms).
const MAIN_ON_EVERY_TIER: Slice[] = [[1, 5, 10], [1, 4, 10], [1, 2, 40], [1, 0, 20], [1, 6, 20]];

/**
 * Runs `skillFile` through the executor against `db`, with cpu_topology_view
 * registered. `stepIds` runs only those maintained steps as one Skill, for a
 * Skill whose required process-identity gate needs Android tables a fixture
 * does not model; the step SQL and its substitution are unchanged.
 */
async function runSkill(db: Database.Database, skillFile: string, params: Record<string, unknown>, stepIds?: string[]) {
  const query = jest.fn(async (_traceId: string, sql: string) => {
    const sqliteSql = sql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '')
      .replace(/CREATE\s+PERFETTO\s+TABLE/gi, 'CREATE TABLE').trim();
    if (!sqliteSql) return {columns: [], rows: []};
    try {
      const statement = db.prepare(sqliteSql);
      if (!statement.reader) {
        statement.run();
        return {columns: [], rows: []};
      }
      return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
    } catch (error) {
      return {columns: [], rows: [], error: (error as Error).message};
    }
  });
  const executor = createSkillExecutor({query, touchTrace: jest.fn(), getTraceWithPort: jest.fn(async () => ({port: 1}))} as any);
  for (const rel of ['atomic/cpu_topology_view.skill.yaml', skillFile]) {
    executor.registerSkill(normalizeSkillDefinition(fresh(loadYaml(rel)), path.join(skillsDir, rel)) as SkillDefinition);
  }
  const skill = loadYaml(skillFile);
  let name = skill.name;
  if (stepIds) {
    name = `${skill.name}_steps_under_test`;
    executor.registerSkill({name, type: 'composite', version: '1', meta: {display_name: name, description: name},
      steps: stepIds.map(id => fresh(stepOf(skill, id)))} as SkillDefinition);
  }
  const result = await executor.execute(name, 'trace-1', params);
  const rows = (stepId: string): Array<Record<string, any>> => {
    const data: any = result.rawResults?.[stepId]?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.rows) && Array.isArray(data?.columns)) {
      return data.rows.map((row: unknown[]) => Object.fromEntries(data.columns.map((c: string, i: number) => [c, row[i]])));
    }
    return [];
  };
  return {result, rows};
}

const close = (value: number) => expect.closeTo(value, 6);

describe('cpu_slice_analysis over a four-tier SoC', () => {
  it('files medium under the big group and keeps unknown time out of little', async () => {
    const {rows} = await withTrace(FOUR_TIERS, MAIN_ON_EVERY_TIER, db =>
      runSkill(db, 'atomic/cpu_slice_analysis.skill.yaml', {package: 'com.example.app'}));
    expect(rows('cpu_time_by_core')).toEqual([expect.objectContaining({
      thread_name: 'main', total_cpu_ms: close(100), big_core_ms: close(60), little_core_ms: close(20), unknown_core_ms: close(20),
    })]);
  });
});

describe('binder_detail over a four-tier SoC', () => {
  it('rolls medium into big and gives unknown Running its own bucket', async () => {
    const {rows} = await withTrace(FOUR_TIERS, MAIN_ON_EVERY_TIER, db => {
      const end = db.prepare('SELECT end_ts FROM trace_bounds').pluck().get() as number;
      return runSkill(db, 'composite/binder_detail.skill.yaml', {
        binder_ts: 0, binder_end_ts: end, dur_ms: end / MS, process_name: 'com.example.app',
      }, ['init_cpu_topology', 'cpu_core_analysis', 'quadrant_analysis']);
    });
    expect(rows('cpu_core_analysis')).toEqual([expect.objectContaining({
      big_core_ms: 60, little_core_ms: 20, unknown_core_ms: 20, total_running_ms: 100,
    })]);
    expect(rows('quadrant_analysis')).toEqual([expect.objectContaining({
      q1_big_running_ms: 60, q2_little_running_ms: 20, unknown_running_ms: 20, q3_runnable_ms: 10, q4_sleeping_ms: 5,
    })]);
  });
});

describe('cpu_profiling over a four-tier SoC', () => {
  const run = async (capacities: Array<number | null>, slices: Slice[]) => (await withTrace(capacities, slices, db =>
    runSkill(db, 'deep/cpu_profiling.skill.yaml', {package: 'com.example.app', min_runtime_ms: 1}))).rows;

  it('reports the big group, its medium share and unknown time per thread', async () => {
    const rows = await run(FOUR_TIERS, MAIN_ON_EVERY_TIER);
    expect(rows('core_distribution')).toEqual([expect.objectContaining({
      thread_name: 'main', total_ms: 100, big_core_pct: 60, medium_core_pct: 40, little_core_pct: 20,
      unknown_core_pct: 20, unknown_core_ms: close(20),
      big_core_pct_definition: 'core_tier_group:prime+big+medium@2',
    })]);
  });

  it.each<[string, Array<number | null>, Slice[], Record<string, unknown>]>([
    ['a classified sample with little big-group time', FOUR_TIERS,
      [[1, 2, 10], [1, 0, 40], [2, 1, 20]],
      {avg_big_core_usage_pct: 10, big_core_sample_threads: 2, classified_sample_threads: 2,
        suggestion: '大核利用率低，关键线程可能未正确绑核'}],
    ['a classified sample with mostly medium time', FOUR_TIERS,
      [[1, 2, 40], [1, 0, 20], [2, 3, 20], [2, 1, 20]],
      // 66.7 and 50 as the distribution rounds them, averaged by the conclusion.
      {avg_big_core_usage_pct: 58.4, big_core_sample_threads: 2, classified_sample_threads: 2,
        suggestion: 'CPU 调度和使用效率良好'}],
    ['a trace without capacity metadata', [null, null, null, null, null, null, null],
      [[1, 5, 40], [2, 0, 20]],
      {avg_big_core_usage_pct: null, big_core_sample_threads: 2, classified_sample_threads: 0,
        suggestion: '调度延迟未见明显异常；样本线程有运行时间落在未分类 CPU 上（拓扑缺少容量信息），无法评估大小核使用'}],
    ['a top thread on an unclassified core beside a classified worker', FOUR_TIERS,
      [[1, 6, 40], [1, 0, 20], [2, 0, 20]],
      {avg_big_core_usage_pct: null, big_core_sample_threads: 2, classified_sample_threads: 1,
        suggestion: '调度延迟未见明显异常；样本线程有运行时间落在未分类 CPU 上（拓扑缺少容量信息），无法评估大小核使用'}],
  ])('concludes on %s', async (_name, capacities, slices, expected) => {
    const rows = await run(capacities, slices);
    expect(rows('profiling_conclusion')).toEqual([expect.objectContaining({latency_severity: 'normal', ...expected})]);
  });

  it('draws no big-core suggestion when no thread qualifies for the distribution', async () => {
    // Every slice is at or under min_runtime_ms (1 ms): the distribution binds
    // [] and the executor cannot inline it, so the optional conclusion yields no row.
    const rows = await run(FOUR_TIERS, [[1, 5, 1], [2, 0, 1]]);
    expect(rows('core_distribution')).toEqual([]);
    expect(rows('profiling_conclusion')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rules over system_cpu_topology (fragments/system_sched_spans.sql, no prime).
// ---------------------------------------------------------------------------

/** Rows of a step's SQL rendered with its fragments and run on `db`. */
function stepRows(db: Database.Database, skillFile: string, stepId: string, vars: Record<string, string | number>) {
  const step = stepOf(loadYaml(skillFile), stepId);
  return db.prepare(renderStepSql(step.sql, step.sql_fragments, vars)).all() as Array<Record<string, unknown>>;
}

/** Runs `ruleStep` with each input bound to the given rows through stub steps. */
async function diagnose(ruleStep: any, inputs: Record<string, Array<Record<string, unknown>>>,
  params: Record<string, unknown> = {}): Promise<DiagnosticResult[]> {
  const stubs = Object.keys(inputs).map(name => ({id: `stub_${name}`, type: 'atomic', sql: `SELECT '${name}' AS stub`, save_as: name}));
  const query = jest.fn(async (_traceId: string, sql: string) => {
    const name = /SELECT '(\w+)' AS stub/.exec(sql)?.[1];
    const rows = name ? inputs[name] : [];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {columns, rows: rows.map(row => columns.map(column => row[column]))};
  });
  const executor = createSkillExecutor({query, touchTrace: jest.fn(), getTraceWithPort: jest.fn(async () => ({port: 1}))} as any);
  executor.registerSkill({name: 'rule_under_test', type: 'composite', version: '1',
    meta: {display_name: 'under test', description: 'under test'}, steps: [...stubs, fresh(ruleStep)]} as SkillDefinition);
  return (await executor.execute('rule_under_test', 'trace-1', params)).diagnostics;
}

describe('cpu_analysis big-group rule', () => {
  const coreStats = (capacities: Array<number | null>, slices: Slice[]) => withTrace(capacities, slices, db =>
    stepRows(db, 'composite/cpu_analysis.skill.yaml', 'core_type_stats', {
      start_ts: 'NULL', end_ts: 'NULL', 'target_process.data[0].upid': 1, '__process_scope.upid': 1,
    }));
  const RULE = stepOf(loadYaml('composite/cpu_analysis.skill.yaml'), 'cpu_diagnosis');
  const lowBigGroup = (diagnostics: DiagnosticResult[]) => diagnostics.filter(d => d.diagnosis.includes('大核组'));

  it('rolls medium into the big group across tier rows', async () => {
    // system_cpu_topology: 100 little, 400 medium, 1024 big (no prime tier).
    const rows = await coreStats([100, 400, 1024], [[1, 1, 60], [1, 2, 10], [1, 0, 30]]);
    expect(rows.map(row => [row.tier, row.big_group_percent, row.unknown_time_ns]).sort()).toEqual([
      ['big', 70, 0], ['little', 70, 0], ['medium', 70, 0],
    ]);
  });

  it('does not call a medium-heavy process low on big cores', async () => {
    const rows = await coreStats([100, 400, 1024], [[1, 1, 60], [1, 2, 10], [1, 0, 30]]);
    expect(lowBigGroup(await diagnose(RULE, {core_stats: rows}))).toEqual([]);
  });

  it('flags a little-heavy process from the big group share', async () => {
    const rows = await coreStats([100, 400, 1024], [[1, 1, 10], [1, 2, 10], [1, 0, 80]]);
    expect(lowBigGroup(await diagnose(RULE, {core_stats: rows})).map(d => d.diagnosis))
      .toEqual(['大核组（超大/大/中核）使用率 20% 偏低 (<30%)']);
  });

  it('draws no big-group verdict when the topology is unknown', async () => {
    const rows = await coreStats([null, null, null], [[1, 0, 80], [1, 1, 20]]);
    expect(rows.map(row => [row.tier, row.unknown_time_ns])).toEqual([['unknown', 100 * MS]]);
    expect(lowBigGroup(await diagnose(RULE, {core_stats: rows}))).toEqual([]);
  });
});

describe('jank_frame_detail migration big-group rule', () => {
  const migration = (capacities: Array<number | null>, slices: Slice[]) => withTrace(capacities, slices, db =>
    stepRows(db, 'atomic/task_migration_in_range.skill.yaml', 'migration_analysis', {
      start_ts: 'NULL', end_ts: 'NULL', package: 'com.example.app', '__process_scope.upid': 1,
    }));
  const RULE = stepOf(loadYaml('composite/jank_frame_detail.skill.yaml'), 'frame_diagnosis');
  const lowBig = (diagnostics: DiagnosticResult[]) => diagnostics.filter(d => d.diagnosis.includes('运行占比仅'));
  const firstThread = (rows: Array<Record<string, unknown>>) => rows.filter(row => row.thread_name === 'main');

  it('reports unknown time beside the big-group share', async () => {
    expect(firstThread(await migration([100, 400, 1024], [[1, 1, 60], [1, 0, 40]])))
      .toEqual([expect.objectContaining({big_core_pct: 60, unknown_core_ns: 0})]);
    expect(firstThread(await migration([null, null, null], [[1, 1, 60], [1, 0, 40]])))
      .toEqual([expect.objectContaining({big_core_pct: 0, unknown_core_ns: 100 * MS})]);
  });

  it('flags a little-heavy thread but never an unclassified one', async () => {
    const little = firstThread(await migration([100, 400, 1024], [[1, 2, 10], [1, 0, 90]]));
    expect(lowBig(await diagnose(RULE, {migration_data: little}, {start_ts: 1, end_ts: 2})).map(d => d.diagnosis))
      .toEqual(['main 大核组（超大/大/中核）运行占比仅 10%']);
    const unknown = firstThread(await migration([null, null, null], [[1, 2, 10], [1, 0, 90]]));
    expect(lowBig(await diagnose(RULE, {migration_data: unknown}, {start_ts: 1, end_ts: 2}))).toEqual([]);
  });
});
