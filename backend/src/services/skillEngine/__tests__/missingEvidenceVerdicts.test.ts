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
import {fresh, stepOf} from '../../../../tests/helpers/skillRuleHarness';

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
  const query = jest.fn(async (_traceId: string, sql: string) => {
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
  const WINDOWED = ['system_cpu_health', 'memory_pressure', 'io_load', 'futex_wait_probe', 'system_freeze_check', 'top_cpu_processes'];
  const detection = stub('anr_detection', 'detection', [{total_anr_count: 1}], ['total_anr_count']);
  const context = (rows: Array<Record<string, number>>) =>
    stub('get_anr_context', 'anr_ctx', rows, ['anr_ts', 'timeout_ns']);

  /** Main threads of an app (uid 10100) and system_server, Running `runningMs` of the 10 ms window. */
  function trace(runningMs: {app?: number; systemServer?: number}) {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, uid INTEGER);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, tid INTEGER);
      CREATE TABLE thread_state(utid INTEGER, ts INTEGER, dur INTEGER, state TEXT);
    `);
    const add = (upid: number, name: string, uid: number, running: number) => {
      db!.prepare('INSERT INTO process VALUES (?, ?, ?, ?)').run(upid, 100 + upid, name, uid);
      db!.prepare('INSERT INTO thread VALUES (?, ?, ?)').run(upid, upid, 100 + upid);
      db!.prepare('INSERT INTO thread_state VALUES (?, ?, ?, ?)').run(upid, 0, running * MS, 'Running');
      db!.prepare('INSERT INTO thread_state VALUES (?, ?, ?, ?)').run(upid, running * MS, (10 - running) * MS, 'S');
    };
    if (runningMs.app !== undefined) add(1, 'com.example.app', 10100, runningMs.app);
    if (runningMs.systemServer !== undefined) add(2, 'system_server', 1000, runningMs.systemServer);
    return db;
  }

  it('skips every windowed step when get_anr_context produced no window', async () => {
    const rows = await run(trace({app: 5, systemServer: 5}), ANR,
      [detection, context([]), ...WINDOWED.map(id => fresh(stepOf(anr, id)))]);
    expect(WINDOWED.map(rows)).toEqual(WINDOWED.map(() => 'not_run'));
  });

  it('runs every windowed step once the window exists', async () => {
    // Tables this fixture does not model make some steps fail; failing is running.
    const rows = await run(trace({app: 5, systemServer: 5}), ANR,
      [detection, context([{anr_ts: 10 * MS, timeout_ns: 10 * MS}]), ...WINDOWED.map(id => fresh(stepOf(anr, id)))]);
    expect(WINDOWED.filter(id => rows(id) === 'not_run')).toEqual([]);
  });

  it('calls a window with no evaluable main thread undetermined, not app-specific', async () => {
    const rows = await run(trace({}), ANR,
      [detection, context([{anr_ts: 10 * MS, timeout_ns: 10 * MS}]), fresh(stepOf(anr, 'system_freeze_check'))]);
    expect(rows('system_freeze_check')).toEqual([expect.objectContaining({total_apps: 0, freeze_verdict: 'undetermined'})]);
  });

  it('still separates an app-specific window from a system_server freeze', async () => {
    const window = context([{anr_ts: 10 * MS, timeout_ns: 10 * MS}]);
    const freeze = fresh(stepOf(anr, 'system_freeze_check'));
    expect((await run(trace({app: 5, systemServer: 5}), ANR, [detection, window, freeze]))('system_freeze_check'))
      .toEqual([expect.objectContaining({total_apps: 2, freeze_verdict: 'app_specific'})]);
    db!.close();
    expect((await run(trace({app: 5, systemServer: 0}), ANR, [detection, window, freeze]))('system_freeze_check'))
      .toEqual([expect.objectContaining({freeze_verdict: 'system_server_freeze'})]);
  });
});

describe('startup_analysis evidence matrix', () => {
  const STARTUP = 'composite/startup_analysis.skill.yaml';
  // Its condition gates on the startup and quality steps; only its SQL is under test.
  const {condition: _condition, ...matrix} = fresh(stepOf(load(STARTUP), 'startup_evidence_matrix'));
  const producers = (slices: Array<Record<string, number>>, binder: Array<Record<string, number>>) => [
    stub('main_thread_slices', 'main_thread_slices', slices, ['percent_of_startup', 'max_dur_ms']),
    stub('main_thread_file_io', 'main_thread_file_io', [{percent_of_startup: 1, total_dur_ms: 10}], ['percent_of_startup', 'total_dur_ms']),
    stub('startup_binder', 'startup_binder', binder, ['percent_of_startup']),
    stub('main_thread_sync_binder', 'main_sync_binder', [], ['percent_of_startup']),
    stub('main_thread_binder_blocking', 'main_binder_blocking', [], ['dur_ms']),
  ];
  const byItem = (rows: Array<Record<string, any>> | string) =>
    Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.item, [row.primary_value, row.status]]));

  it('reports an empty or absent producer as not observed, never a measured 0', async () => {
    db = new Database(':memory:');
    // sched_latency has no producer step at all; the others return no row.
    const rows = await run(db, STARTUP, [...producers([], [{percent_of_startup: 30}]), matrix]);
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
