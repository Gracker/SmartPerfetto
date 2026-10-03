// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {normalizeSkillDefinition} from '../skillLoader';
import type {SkillDefinition} from '../types';
import {diagnoseRuleStep, fresh, stepOf} from '../../../../tests/helpers/skillRuleHarness';
import {renderStepSql} from '../../../../tests/helpers/skillFragmentSql';

/**
 * Missing evidence is reported as missing, never as a negative finding. The
 * maintained step SQL runs through the executor on SQLite, after stub steps
 * that stand in for its producers.
 */

const skillsDir = path.join(process.cwd(), 'skills');
const load = (rel: string): any => yaml.load(fs.readFileSync(path.join(skillsDir, rel), 'utf8'));
const MS = 1_000_000;

let db: Database.Database | undefined;
afterEach(() => { db?.close(); });

/** The built-in SQL fragments, keyed as the loader registers them. */
const fragments = new Map(fs.readdirSync(path.join(skillsDir, 'fragments'))
  .filter(file => file.endsWith('.sql'))
  .map(file => [`fragments/${file}`, fs.readFileSync(path.join(skillsDir, 'fragments', file), 'utf8')]));

function executorOn(database: Database.Database) {
  const query = jest.fn(async (_traceId: string, rawSql: string) => {
    const sql = rawSql.replace(/INCLUDE PERFETTO MODULE [^;]+;/g, '').trim();
    try {
      const statement = database.prepare(sql);
      return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
    } catch (error) {
      return {columns: [], rows: [], error: (error as Error).message};
    }
  });
  const executor = createSkillExecutor({query, touchTrace: jest.fn(), getTraceWithPort: jest.fn(async () => ({port: 1}))} as any);
  executor.setFragmentRegistry(fragments);
  return executor;
}

/**
 * Runs `steps` as one composite Skill (fragments resolved against `skillFile`)
 * and returns, per step, its rows, 'error', or 'not_run' when it was skipped.
 */
async function run(database: Database.Database, skillFile: string, steps: any[]) {
  const executor = executorOn(database);
  executor.registerSkill(normalizeSkillDefinition({name: 'under_test', type: 'composite', version: '1',
    meta: {display_name: 'under_test', description: 'under_test'}, steps}, path.join(skillsDir, skillFile)) as SkillDefinition);
  const result = await executor.execute('under_test', 'trace-1', {});
  return (stepId: string): Array<Record<string, any>> | 'error' | 'not_run' => {
    const step: any = result.rawResults?.[stepId];
    if (!step || step.code === 'condition_not_met') return 'not_run';
    if (!step.success) return 'error';
    const data = step.data;
    if (Array.isArray(data)) return data;
    return data.rows.map((row: unknown[]) => Object.fromEntries(data.columns.map((c: string, i: number) => [c, row[i]])));
  };
}

/** A stub producer: an atomic step saving `rows` (none when empty) under `saveAs`. */
function stub(id: string, saveAs: string, rows: Array<Record<string, number>>, columns: string[]) {
  const select = rows.length
    ? rows.map(row => `SELECT ${columns.map(column => `${row[column] ?? 'NULL'} AS ${column}`).join(', ')}`).join(' UNION ALL ')
    : `SELECT ${columns.map(column => `NULL AS ${column}`).join(', ')} WHERE 0`;
  return {id, type: 'atomic', sql: select, save_as: saveAs};
}

describe('anr_analysis first-ANR-window steps', () => {
  const ANR = 'composite/anr_analysis.skill.yaml';
  const anr = load(ANR);
  const WINDOWED = ['system_cpu_health', 'memory_pressure', 'io_load', 'anr_process_io_wait', 'futex_wait_probe',
    'system_freeze_check', 'top_cpu_processes'];
  const detection = stub('anr_detection', 'detection', [{total_anr_count: 1}], ['total_anr_count']);
  const context = (rows: Array<Record<string, number>>) =>
    stub('get_anr_context', 'anr_ctx', rows, ['anr_ts', 'timeout_ns', 'upid']);

  /**
   * Main threads in a 10 ms window, each given as its state segments in ms
   * (`[['Running', 2], ['S', 8]]`), a D segment optionally with its wait
   * channel (`['D', 6, 'io_schedule']`). App threads get uid 10100 + n.
   */
  type Segments = Array<[string, number] | [string, number, string]>;
  function trace(threads: {apps?: Segments[]; systemServer?: Segments}) {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, uid INTEGER);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, tid INTEGER, name TEXT);
      CREATE TABLE thread_state(id INTEGER PRIMARY KEY, utid INTEGER, ts INTEGER, dur INTEGER, state TEXT,
        blocked_function TEXT, cpu INTEGER, ucpu INTEGER, io_wait INTEGER, waker_utid INTEGER, irq_context INTEGER);
      CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0, ${10 * MS});
    `);
    const add = (upid: number, name: string, uid: number, segments: Segments) => {
      db!.prepare('INSERT INTO process VALUES (?, ?, ?, ?)').run(upid, 100 + upid, name, uid);
      db!.prepare('INSERT INTO thread VALUES (?, ?, ?, ?)').run(upid, upid, 100 + upid, 'main');
      let at = 0;
      for (const [state, ms, wchan] of segments) {
        db!.prepare('INSERT INTO thread_state (utid, ts, dur, state, blocked_function) VALUES (?, ?, ?, ?, ?)')
          .run(upid, at * MS, ms * MS, state, wchan ?? null);
        at += ms;
      }
    };
    (threads.apps ?? []).forEach((segments, index) => add(index + 1, `com.example.app${index}`, 10100 + index, segments));
    if (threads.systemServer) add(100, 'system_server', 1000, threads.systemServer);
    return db;
  }
  const IDLE: Segments = [['Running', 0.2], ['S', 9.8]];
  const STARVED: Segments = [['Running', 1], ['R', 7], ['S', 2]];

  it('skips every windowed step when get_anr_context produced no window', async () => {
    const rows = await run(trace({apps: [IDLE], systemServer: IDLE}), ANR,
      [detection, context([]), ...WINDOWED.map(id => fresh(stepOf(anr, id)))]);
    expect(WINDOWED.map(rows)).toEqual(WINDOWED.map(() => 'not_run'));
  });

  it('runs every windowed step once the window exists', async () => {
    // Tables this fixture does not model make some steps fail; failing is running.
    const rows = await run(trace({apps: [IDLE], systemServer: IDLE}), ANR,
      [detection, context([{anr_ts: 10 * MS, timeout_ns: 10 * MS, upid: 1}]), ...WINDOWED.map(id => fresh(stepOf(anr, id)))]);
    expect(WINDOWED.filter(id => rows(id) === 'not_run')).toEqual([]);
  });

  it('reads the D waits of the ANR process, not the longest one system-wide', async () => {
    const rows = await run(trace({apps: [[['Running', 2], ['D', 6, 'io_schedule'], ['S', 2]]], systemServer: [['D', 9], ['S', 1]]}),
      ANR, [detection, context([{anr_ts: 10 * MS, timeout_ns: 10 * MS, upid: 1}]), fresh(stepOf(anr, 'anr_process_io_wait'))]);
    expect(rows('anr_process_io_wait')).toEqual([{
      process_name: 'com.example.app0', main_thread_uninterruptible_ms: 6, process_uninterruptible_ms: 6,
      top_thread_name: 'main', top_thread_ms: 6, main_thread_io_wchan_ms: 6, frozen_ms: 0, blocked_function_coverage_pct: 100,
    }]);
  });

  it('does not read an ANR without a process as one without D waits', async () => {
    const rows = await run(trace({apps: [[['D', 10]]]}), ANR,
      [detection, context([{anr_ts: 10 * MS, timeout_ns: 10 * MS}]), fresh(stepOf(anr, 'anr_process_io_wait'))]);
    expect(rows('anr_process_io_wait')).toBe('not_run');
  });

  it('diagnoses a D wait of the ANR main thread, not one elsewhere', async () => {
    const rule = stepOf(anr, 'anr_diagnosis');
    const dWait = (results: Awaited<ReturnType<typeof diagnoseRuleStep>>) =>
      results.filter(result => /D-state/.test(result.diagnosis));
    const systemWide = {io_load: [{process_name: 'msm_hw_fence_soccp_listener', uninterruptible_wait_ms: 3086}]};
    expect(dWait(await diagnoseRuleStep(rule, {detection: [{total_anr_count: 1}], ...systemWide,
      anr_io_wait: [{process_name: 'com.example.app', main_thread_uninterruptible_ms: 40}]}))).toEqual([]);
    expect(dWait(await diagnoseRuleStep(rule, {detection: [{total_anr_count: 1}], ...systemWide,
      anr_io_wait: [{process_name: 'com.example.app', main_thread_uninterruptible_ms: 800}]})).map(result => result.diagnosis))
      .toEqual(['ANR 进程 com.example.app 主线程在 ANR 窗口内 D-state 不可中断等待 800ms']);
  });

  async function verdict(threads: Parameters<typeof trace>[0], anrUpid?: number) {
    const rows = await run(trace(threads), ANR, [detection, context([{anr_ts: 10 * MS, timeout_ns: 10 * MS, upid: anrUpid ?? -1}]),
      fresh(stepOf(anr, 'system_freeze_check'))]);
    db!.close();
    db = undefined;
    return (rows('system_freeze_check') as Array<Record<string, unknown>>)[0];
  }

  it('reads idle main threads as no freeze evidence, not as frozen', async () => {
    // An idle Looper sleeps nearly the whole window: it is not frozen.
    expect(await verdict({apps: [IDLE, IDLE, IDLE], systemServer: IDLE})).toMatchObject({
      total_apps: 4, demanding_apps: 0, stalled_apps: 0, system_server_evaluated: 1, freeze_verdict: 'app_specific',
    });
  });

  it('needs stall evidence for a freeze', async () => {
    expect(await verdict({apps: [IDLE], systemServer: [['Running', 1], ['D', 8], ['S', 1]]}))
      .toMatchObject({system_server_stalled_pct: 80, freeze_verdict: 'system_server_freeze'});
    // Idle apps neither prove nor dilute a stall: the share is over apps with demand.
    expect(await verdict({apps: [STARVED, STARVED, IDLE, IDLE, IDLE], systemServer: IDLE}))
      .toMatchObject({demanding_apps: 2, stalled_apps: 2, freeze_verdict: 'app_specific'});
    expect(await verdict({apps: [STARVED, STARVED, STARVED, IDLE, IDLE], systemServer: IDLE}))
      .toMatchObject({demanding_apps: 3, stalled_apps: 3, stalled_pct: 100, freeze_verdict: 'system_freeze'});
    // The ANR process itself is not evidence that the system stalled.
    expect(await verdict({apps: [STARVED, STARVED, STARVED], systemServer: IDLE}, 1))
      .toMatchObject({demanding_apps: 2, freeze_verdict: 'app_specific'});
  });

  it('leaves the verdict undetermined without an evaluable system_server', async () => {
    expect(await verdict({})).toMatchObject({total_apps: 0, freeze_verdict: 'undetermined'});
    expect(await verdict({apps: [IDLE, IDLE, IDLE]})).toMatchObject({freeze_verdict: 'undetermined'});
    // Positive evidence still decides without system_server.
    expect(await verdict({apps: [STARVED, STARVED, STARVED]})).toMatchObject({freeze_verdict: 'system_freeze'});
    // system_server alive for less than 90% of the window is not evaluable.
    expect(await verdict({apps: [IDLE], systemServer: [['Running', 0.2], ['S', 5]]}))
      .toMatchObject({system_server_evaluated: 0, freeze_verdict: 'undetermined'});
  });

  it('evaluates each process over its alive time, a dead one not at all', async () => {
    const dead: Segments = [['Z', 10]];
    expect(await verdict({apps: [dead, dead, dead], systemServer: IDLE}))
      .toMatchObject({total_apps: 1, stalled_apps: 0, freeze_verdict: 'app_specific'});
  });
});

describe('startup_analysis evidence matrix', () => {
  const STARTUP = 'composite/startup_analysis.skill.yaml';
  // Its condition gates on the startup and quality steps; only its SQL is under test.
  const {condition: _condition, ...matrix} = fresh(stepOf(load(STARTUP), 'startup_evidence_matrix'));
  const producers = (slices: Array<Record<string, number>>, binder: Array<Record<string, number>>) => [
    stub('main_thread_slices', 'main_thread_slices', slices, ['percent_of_startup', 'max_dur_ms']),
    stub('main_thread_file_io', 'main_thread_file_io', [{all_percent_of_startup: 1, all_total_dur_ms: 10}],
      ['all_percent_of_startup', 'all_total_dur_ms']),
    stub('startup_binder', 'startup_binder', binder, ['all_percent_of_startup']),
    stub('main_thread_sync_binder', 'main_sync_binder', [], ['all_percent_of_startup']),
    stub('main_thread_binder_blocking', 'main_binder_blocking', [], ['dur_ms']),
  ];
  const byItem = (rows: Array<Record<string, any>> | string) =>
    Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.item, [row.primary_value, row.status]]));

  it('reports an empty or absent producer as not observed, never a measured 0', async () => {
    db = new Database(':memory:');
    // sched_latency has no producer step at all; the others return no row.
    const rows = await run(db, STARTUP, [...producers([], [{all_percent_of_startup: 30}]), matrix]);
    expect(byItem(rows('startup_evidence_matrix'))).toEqual({
      'MainThread Hot Slice': [null, 'not_observed'],
      'MainThread File IO': [1, 'normal'],
      // Above threshold, corroboration missing.
      'Binder Total': [30, 'needs_corroboration'],
      'Main Sync Binder': [null, 'not_observed'],
      'Sched Latency': [null, 'not_observed'],
    });
  });

  it('keeps a measured value below and above its thresholds', async () => {
    db = new Database(':memory:');
    const rows = await run(db, STARTUP, [...producers([{percent_of_startup: 25, max_dur_ms: 150}], []), matrix]);
    expect(byItem(rows('startup_evidence_matrix'))['MainThread Hot Slice']).toEqual([25, 'confirmed']);
  });
});

describe('startup evidence producers', () => {
  /** Runs one maintained atomic producer on `database` and returns its rows. */
  async function produce(database: Database.Database, rel: string, params: Record<string, unknown>) {
    const executor = executorOn(database);
    const skill = normalizeSkillDefinition(fresh(load(rel)), path.join(skillsDir, rel)) as SkillDefinition;
    executor.registerSkill(skill);
    const result = await executor.execute(skill.name, 'trace-1', params);
    expect(result.success).toBe(true);
    const data: any = result.displayResults?.[0]?.data;
    return data.rows.map((row: unknown[]) => Object.fromEntries(data.columns.map((c: string, i: number) => [c, row[i]])));
  }
  const window = {package: 'com.example.app', startup_id: 1, startup_type: 'cold', start_ts: 0, end_ts: 1000 * MS};

  it('totals every group before the top-K cut, counting a nested IO slice once', async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT);
      CREATE TABLE android_thread_slices_for_all_startups(
        startup_id INTEGER, slice_id INTEGER, slice_name TEXT, thread_name TEXT, slice_dur INTEGER, is_main_thread INTEGER);
      INSERT INTO android_startups VALUES (1, 0, ${1000 * MS}, 'com.example.app');
    `);
    // sqliteRead (2) runs inside openDatabase (1); fsync (3) stands alone.
    const parents = new Map<number, number>([[2, 1]]);
    db.table('ancestor_slice', {
      columns: ['id'],
      parameters: ['slice_id'],
      *rows(sliceId: unknown) {
        for (let id = parents.get(Number(sliceId)); id !== undefined; id = parents.get(id)) yield {id};
      },
    });
    const insert = db.prepare('INSERT INTO android_thread_slices_for_all_startups VALUES (1, ?, ?, ?, ?, 1)');
    [['openDatabase', 40], ['sqliteRead', 30], ['fsync', 20]].forEach(([name, ms], index) =>
      insert.run(index + 1, name, 'main', Number(ms) * MS));
    const rows = await produce(db, 'atomic/startup_main_thread_file_io_in_range.skill.yaml', {...window, top_k: 1});
    expect(rows).toEqual([expect.objectContaining({
      io_slice: 'openDatabase', percent_of_startup: 4, all_percent_of_startup: 6, all_total_dur_ms: 60,
    })]);
  });

  it('counts a slice as file IO only when an IO word starts a word of its name', async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT);
      CREATE TABLE android_thread_slices_for_all_startups(
        startup_id INTEGER, slice_id INTEGER, slice_name TEXT, thread_name TEXT, slice_dur INTEGER, is_main_thread INTEGER);
      INSERT INTO android_startups VALUES (1, 0, ${1000 * MS}, 'com.example.app');
    `);
    db.table('ancestor_slice', {columns: ['id'], parameters: ['slice_id'], *rows() {}});
    const insert = db.prepare('INSERT INTO android_thread_slices_for_all_startups VALUES (1, ?, ?, ?, ?, 1)');
    // Not file IO: an IO word inside another word, or a Binder parcel.
    const notIo = ['ActivityThreadMain', 'Mutator threads suspended for EnableDebugFeatures', 'isReady',
      'onReadyToRun', 'Parcel.readFromParcel', 'writeToParcel', 'ProfileInstallerInitializer'];
    const io = ['readFile', 'loadFile', 'APKFile', 'SQLiteDatabase.query', 'SqliteLoad', 'readSP',
      'open /data/app.db', 'openat', 'fsync', 'SharedPreferencesImpl.loadFromDisk'];
    [...notIo, ...io].forEach((name, index) => insert.run(index + 1, name, 'main', 10 * MS));
    const rows = await produce(db, 'atomic/startup_main_thread_file_io_in_range.skill.yaml', {...window, top_k: 20});
    expect(rows.map((row: any) => row.io_slice).sort()).toEqual([...io].sort());
    expect(rows[0].all_total_dur_ms).toBe(10 * io.length);
  });

  it('applies the same whole-word rule to main-thread file IO outside startup', async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER, pid INTEGER, name TEXT);
      CREATE TABLE thread(utid INTEGER, upid INTEGER, tid INTEGER);
      CREATE TABLE thread_track(id INTEGER, utid INTEGER);
      CREATE TABLE slice(track_id INTEGER, name TEXT, ts INTEGER, dur INTEGER);
      INSERT INTO process VALUES (1, 100, 'com.example.app');
      INSERT INTO thread VALUES (1, 1, 100);
      INSERT INTO thread_track VALUES (1, 1);
    `);
    const notIo = ['ActivityThreadMain', 'isReady', 'Parcel.readFromParcel', 'writeToParcel'];
    const io = ['readFile', 'SQLiteDatabase.query', 'openat', 'fsync'];
    const insert = db.prepare('INSERT INTO slice VALUES (1, ?, ?, ?)');
    [...notIo, ...io].forEach((name, index) => insert.run(name, index * 20 * MS, 10 * MS));
    const rows = await produce(db, 'atomic/main_thread_file_io_in_range.skill.yaml',
      {package: 'com.example.app', start_ts: 0, end_ts: 1000 * MS, top_k: 20});
    expect(rows.map((row: any) => row.io_slice).sort()).toEqual([...io].sort());
  });

  it('orders scheduling states and totals them', async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT);
      CREATE TABLE android_startup_threads(startup_id INTEGER, utid INTEGER, is_main_thread INTEGER);
      CREATE TABLE thread_state(utid INTEGER, ts INTEGER, dur INTEGER, state TEXT);
      INSERT INTO android_startups VALUES (1, 0, ${1000 * MS}, 'com.example.app');
      INSERT INTO android_startup_threads VALUES (1, 7, 1);
    `);
    const insert = db.prepare('INSERT INTO thread_state VALUES (7, ?, ?, ?)');
    insert.run(10 * MS, 2 * MS, 'R');
    insert.run(20 * MS, 12 * MS, 'R+');
    insert.run(40 * MS, 9 * MS, 'R+');
    const rows = await produce(db, 'atomic/startup_sched_latency_in_range.skill.yaml', window);
    expect(rows.map((row: any) => [row.state, row.severe_delays, row.all_severe_delays, row.all_max_wait_ms]))
      .toEqual([['R+', 2, 2, 12], ['R', 0, 2, 12]]);
  });

  it('groups breakdown reasons by their exact value, totalling each category before the top-K cut', async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT);
      CREATE TABLE android_startup_opinionated_breakdown(startup_id INTEGER, ts INTEGER, dur INTEGER, reason TEXT);
      INSERT INTO android_startups VALUES (1, 0, ${1000 * MS}, 'com.example.app');
    `);
    const insert = db.prepare('INSERT INTO android_startup_opinionated_breakdown VALUES (1, 0, ?, ?)');
    // Each of these once read as IO through the substring io; D without
    // io_wait is a thread state, and an unlisted reason is Other.
    insert.run(380 * MS, 'bind_application');
    insert.run(200 * MS, 'monitor_contention');
    insert.run(120 * MS, 'verify_class');
    insert.run(100 * MS, 'open_dex_files_from_oat');
    insert.run(100 * MS, 'io');
    insert.run(50 * MS, 'D');
    insert.run(50 * MS, 'some_new_reason');
    const rows = await produce(db, 'atomic/startup_breakdown_in_range.skill.yaml', {...window, top_k: 3});
    expect(rows.map((row: any) => [row.reason, row.category, row.percent, row.category_percent])).toEqual([
      ['bind_application', 'AppPhase', 38, 38],
      ['monitor_contention', 'Lock', 20, 20],
      ['verify_class', 'ClassLoading', 12, 22],
    ]);
    const all = await produce(db, 'atomic/startup_breakdown_in_range.skill.yaml', {...window, top_k: 10});
    expect(Object.fromEntries(all.map((row: any) => [row.reason, [row.category, row.category_percent]]))).toEqual({
      bind_application: ['AppPhase', 38],
      monitor_contention: ['Lock', 20],
      verify_class: ['ClassLoading', 22],
      open_dex_files_from_oat: ['ClassLoading', 22],
      io: ['IO', 10],
      D: ['Uninterruptible', 5],
      some_new_reason: ['Other', 5],
    });
  });
});

describe('fragments/file_io_slice_names.sql', () => {
  it('types a slice name by its whole I/O words and excludes names of non-I/O work', () => {
    db = new Database(':memory:');
    const names: Array<[string, string | null]> = [
      ['readFile', 'file,read'], ['Thread', null], ['isReady', null], ['FileUtils.copy', 'file'],
      ['fsync', 'sync'], ['AsyncTask', null], ['flush commands', null], ['SharedPreferencesImpl.apply', 'shared_prefs'],
      ['IO_read', 'read'], ['readahead', 'read'], ['Reader', null], ['SQLiteDatabase', 'database'],
      // All-caps is not a form of a word: the real all-caps OPEN is a transition type.
      ['playTransition: OPEN', null], ['Transition-OPEN#409', null],
    ];
    const rows = db.prepare(`WITH
      ${fragments.get('fragments/file_io_slice_names.sql')},
      names(name) AS (VALUES ${names.map(() => '(?)').join(', ')})
      SELECT name,
        (SELECT group_concat(io_type) FROM (SELECT DISTINCT io_type FROM file_io_slice_name_patterns n
          WHERE name GLOB n.pattern ORDER BY io_type)) AS io_types
      FROM names`).all(...names.map(([name]) => name)) as Array<{name: string; io_types: string | null}>;
    expect(rows.map(row => [row.name, row.io_types])).toEqual(names);
    const excluded = db.prepare(`WITH ${fragments.get('fragments/file_io_slice_names.sql')}
      SELECT ? GLOB pattern AS hit FROM file_io_slice_name_exclusions`);
    const hit = (name: string) => (excluded.all(name) as Array<{hit: number}>).some(row => row.hit === 1);
    for (const name of ['Parcel.readFromParcel', 'writeToParcel', 'writeToProto', 'readLock',
      'ReentrantReadWriteLock', 'OpenGLRenderer', 'ScopedCodeCacheWrite',
      'JIT compiling void java.io.File.<init>(java.lang.String)', 'DefineClass_Lcom/a/FileUtils;',
      'RegisterDexFile /product/app/A/A.apk', 'GC: Wait For Completion ClassLinkerForRegisterDexFile',
      'monitor contention with owner main at void a.FileCache.read()',
      'AIDL::java::INetworkStatsService::openSessionForUsageStats::server', 'Lcom/a/FileUtils;']) {
      expect([name, hit(name)]).toEqual([name, true]);
    }
    for (const name of ['readFile', 'ParcelFileDescriptor.open', 'openDexFile', 'SQLiteDatabase.query',
      'SharedPreferencesImpl.loadFromDisk']) {
      expect([name, hit(name)]).toEqual([name, false]);
    }
  });
});

describe('fragments/gpu_frequency_intervals.sql', () => {
  // The gpufreq track is labelled kHz, but its writers use kHz, Hz and MHz.
  const gpuFixture = () => {
    db = new Database(':memory:');
    db.function('trace_end', () => 1000);
    db.exec(`
      CREATE TABLE gpu_counter_track(id INTEGER PRIMARY KEY, name TEXT, gpu_id INTEGER, ugpu INTEGER);
      CREATE TABLE counter(id INTEGER PRIMARY KEY, ts INTEGER, track_id INTEGER, value REAL);
      INSERT INTO gpu_counter_track VALUES
        (1, 'gpufreq', 0, 0),     -- power/gpu_frequency: kHz, with power-off samples
        (2, 'gpufreq', 1, 1),     -- kHz and kgsl Hz on one track
        (3, 'gpufreq', 2, 2),     -- sys_stats gpufreq_mhz, and two values no GPU clock has
        (4, 'gpu_mem', 0, 0),
        (5, 'gpufreq', NULL, 3);
      INSERT INTO counter VALUES
        (1, 0, 1, 434000), (2, 100, 1, 0), (3, 200, 1, 251000),
        (4, 0, 2, 700000), (5, 50, 2, 700000000), (6, 80, 2, 900000000),
        (7, 0, 3, 600), (8, 30, 3, 5), (9, 60, 3, 2e10),
        (10, 0, 4, 123456), (11, 0, 5, 300000);
    `);
  };
  const intervals = () => fragments.get('fragments/gpu_frequency_intervals.sql')!;

  it('reads each sample by its own magnitude and compares normalized neighbours', () => {
    gpuFixture();
    const rows = db!.prepare(`WITH ${intervals()}
      SELECT gpu_id, ts, dur, freq_mhz, is_off, unit_basis, prev_freq_mhz
      FROM gpu_frequency_intervals ORDER BY gpu_id, ts`).all();
    expect(rows).toEqual([
      {gpu_id: 0, ts: 0, dur: 100, freq_mhz: 434, is_off: 0, unit_basis: 'khz', prev_freq_mhz: null},
      {gpu_id: 0, ts: 100, dur: 100, freq_mhz: 0, is_off: 1, unit_basis: 'off', prev_freq_mhz: 434},
      {gpu_id: 0, ts: 200, dur: 800, freq_mhz: 251, is_off: 0, unit_basis: 'khz', prev_freq_mhz: 0},
      {gpu_id: 1, ts: 0, dur: 50, freq_mhz: 700, is_off: 0, unit_basis: 'khz', prev_freq_mhz: null},
      {gpu_id: 1, ts: 50, dur: 30, freq_mhz: 700, is_off: 0, unit_basis: 'hz', prev_freq_mhz: 700},
      {gpu_id: 1, ts: 80, dur: 920, freq_mhz: 900, is_off: 0, unit_basis: 'hz', prev_freq_mhz: 700},
      {gpu_id: 2, ts: 0, dur: 30, freq_mhz: 600, is_off: 0, unit_basis: 'mhz', prev_freq_mhz: null},
      {gpu_id: 2, ts: 30, dur: 30, freq_mhz: null, is_off: 0, unit_basis: 'out_of_domain', prev_freq_mhz: 600},
      {gpu_id: 2, ts: 60, dur: 940, freq_mhz: null, is_off: 0, unit_basis: 'out_of_domain', prev_freq_mhz: null},
    ]);
  });

  it('clips intervals to a window and summarizes running, off and changes per GPU', () => {
    gpuFixture();
    const windowed = (start: number, end: number, select: string) => db!.prepare(renderStepSql(select,
      ['fragments/gpu_frequency_intervals.sql', 'fragments/gpu_frequency_window.sql', 'fragments/gpu_frequency_summary.sql'],
      {start_ts: start, end_ts: end})).all();
    expect(windowed(150, 250, `SELECT gpu_id, ts, dur, running_mhz, is_running_change
      FROM gpu_frequency_window WHERE gpu_id = 0 ORDER BY ts`)).toEqual([
      {gpu_id: 0, ts: 150, dur: 50, running_mhz: null, is_running_change: 0},
      {gpu_id: 0, ts: 200, dur: 50, running_mhz: 251, is_running_change: 0},
    ]);
    // GPU 1 ran at 700 MHz (kHz then Hz: no change) and 900 MHz; GPU 0 was off
    // for a third of the window; GPU 2 has 30 ns at 600 MHz and the rest unreadable.
    expect(windowed(0, 300, 'SELECT * FROM gpu_frequency_summary ORDER BY gpu_id')).toEqual([
      {gpu_id: 0, observed_ns: 300, running_ns: 200, off_ns: 100, out_of_domain_ns: 0,
        avg_running_mhz: 342.5, max_running_mhz: 434, min_running_mhz: 251, running_levels: 2, running_change_count: 0},
      {gpu_id: 1, observed_ns: 300, running_ns: 300, off_ns: 0, out_of_domain_ns: 0,
        avg_running_mhz: (80 * 700 + 220 * 900) / 300, max_running_mhz: 900, min_running_mhz: 700, running_levels: 2,
        running_change_count: 1},
      {gpu_id: 2, observed_ns: 300, running_ns: 30, off_ns: 0, out_of_domain_ns: 270,
        avg_running_mhz: 600, max_running_mhz: 600, min_running_mhz: 600, running_levels: 1, running_change_count: 0},
    ]);
    expect(windowed(250, 150, 'SELECT * FROM gpu_frequency_window')).toEqual([]);
  });
});
