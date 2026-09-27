// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, it, expect} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {normalizeSkillDefinition} from '../skillLoader';
import {ArtifactStore} from '../../../agentv3/artifactStore';
import {captureEvidenceTable, evidenceTableFor, getCapturedAnchorFacts} from '../../evidence/evidenceCapture';
import {investigationCaptureFields} from '../../evidence/investigationEvidenceLedger';
import {prepareClaimEvidence} from '../../evidence/claimEvidencePreparation';
import {runClaimVerification} from '../../verifier/claimVerificationRunner';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';

describe('startup display unit contracts', () => {
  const loadYaml = (relativePath: string) => {
    const skillPath = path.join(process.cwd(), relativePath);
    return yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
  };

  const getColumn = (columns: any[], name: string) => {
    const column = columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  it('keeps startup display tails on native half-open clipped methodology', () => {
    const strategy = fs.readFileSync(path.join(process.cwd(), 'strategies/startup.strategy.md'), 'utf8');
    expect(strategy).not.toContain('ts BETWEEN <end_ts>');
    expect(strategy).not.toContain('dur / 1e6 AS dur_ms FROM thread_slice');
    expect(strategy).toContain('[框架完成点, TTID 终点)');
    expect(strategy).toContain('[TTID 终点, TTFD 终点)');
    expect(strategy).toContain('原生 `upid/utid`');
    expect(strategy).toContain('overlap 后裁剪到窗口');
  });

  it('startup_events_in_range exposes ms display and ns jump fields consistently', () => {
    const skill = loadYaml('skills/atomic/startup_events_in_range.skill.yaml');
    const columns = skill.display?.columns || [];

    expect(getColumn(columns, 'upid')).toMatchObject({type: 'number', hidden: true});

    // dur_ms is the visible human-readable column; dur_ns is hidden, used by
    // start_ts.clickAction navigate_range. Original spec had this swapped, but
    // commit 0bae10a5 fixed dur_ns 32-bit overflow by showing dur_ms instead.
    const durMs = getColumn(columns, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');
    expect(durMs.hidden).not.toBe(true);

    const startTs = getColumn(columns, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur_ns');

    const durNs = getColumn(columns, 'dur_ns');
    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');
    expect(durNs.hidden).toBe(true);

    const ttid = getColumn(columns, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const ttfd = getColumn(columns, 'ttfd_ms');
    expect(ttfd.type).toBe('duration');
    expect(ttfd.format).toBe('duration_ms');
    expect(ttfd.unit).toBe('ms');
  });

  it('emits an exact launch UPID only when the startup process is unambiguous', () => {
    const skill = loadYaml('skills/atomic/startup_events_in_range.skill.yaml');
    const parent = loadYaml('skills/composite/startup_analysis.skill.yaml').steps
      .find((step: any) => step.id === 'get_startups');
    expect(getColumn(parent.display.columns, 'upid')).toMatchObject({type: 'number', hidden: true});
    const sql = skill.sql
      .replaceAll('${package}', '')
      .replaceAll('${startup_id}', 'NULL')
      .replaceAll('${startup_type}', '')
      .replaceAll('${start_ts}', 'NULL')
      .replaceAll('${end_ts}', 'NULL');
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE android_startups(startup_id INTEGER, package TEXT, startup_type TEXT, ts INTEGER, ts_end INTEGER, dur INTEGER);
        CREATE TABLE _startup_events(ts INTEGER, dur INTEGER, ts_end INTEGER, package_name TEXT);
        CREATE TABLE android_startup_time_to_display(startup_id INTEGER, time_to_initial_display INTEGER, time_to_full_display INTEGER);
        CREATE TABLE android_startup_threads(startup_id INTEGER, utid INTEGER, is_main_thread INTEGER, ts INTEGER, dur INTEGER);
        CREATE TABLE thread_track(id INTEGER, utid INTEGER);
        CREATE TABLE slice(track_id INTEGER, name TEXT, ts INTEGER, dur INTEGER);
        CREATE TABLE android_startup_processes(startup_id INTEGER, upid INTEGER);
        CREATE TABLE process(upid INTEGER, start_ts INTEGER);
        INSERT INTO android_startups VALUES
          (1, 'com.example', 'cold', 100, 1100, 1000),
          (2, 'com.example', 'warm', 200, 2200, 2000),
          (3, 'com.example', 'hot', 300, 3300, 3000);
        -- Startup 1 opens on another package's trampoline launch; 2 has only its own.
        INSERT INTO _startup_events VALUES
          (100, 50, 150, 'com.trampoline'),
          (160, 900, 1060, 'com.example'),
          (1200, 1000, 2200, 'com.example');
        INSERT INTO android_startup_processes VALUES (1, 42), (1, 42), (2, 43), (2, 44), (3, NULL);
        INSERT INTO process VALUES (42, 100), (43, 200), (44, 200);
      `);
      const rows = db.prepare(sql).all() as Array<{
        startup_id: number; upid: number | null; dur_without_trampoline_ms: number; trampoline_ms: number;
      }>;
      expect(Object.fromEntries(rows.map(row => [row.startup_id, row.upid]))).toEqual({1: 42, 2: null, 3: null});
      // Mirrors android_startups.dur_without_trampoline: only the launch that
      // follows an earlier one inside the span is split off; otherwise dur.
      expect(Object.fromEntries(rows.map(row =>
        [row.startup_id, [row.dur_without_trampoline_ms * 1e6, row.trampoline_ms * 1e6].map(Math.round)])))
        .toEqual({1: [900, 100], 2: [2000, 0], 3: [3000, 0]});
    } finally {
      db.close();
    }
  });

  it('startup_detail uses ms display units for startup and CPU/quadrant durations', () => {
    const skill = loadYaml('skills/composite/startup_detail.skill.yaml');
    const getStep = (id: string) => {
      const step = skill.steps?.find((s: any) => s.id === id);
      expect(step).toBeDefined();
      return step;
    };

    const startupInfoCols = getStep('startup_info').display?.columns || [];
    const durMs = getColumn(startupInfoCols, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    const ttid = getColumn(startupInfoCols, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const startTs = getColumn(startupInfoCols, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');

    const cpuCoreCols = getStep('cpu_core_analysis').display?.columns || [];
    for (const name of ['big_core_ms', 'little_core_ms', 'total_running_ms']) {
      const col = getColumn(cpuCoreCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    // quadrant_analysis exposes per-quadrant *_ms columns + per-quadrant *_pct
    // columns (Q1 big-running / Q2 little-running / Q3 runnable / Q4a uninterruptible / Q4b sleep)
    // — there is no generic dur_ms / quadrant / percentage column.
    const quadrantCols = getStep('quadrant_analysis').display?.columns || [];
    for (const name of ['q1_big_running_ms', 'q2_little_running_ms', 'q3_runnable_ms', 'q4a_uninterruptible_ms', 'q4b_sleeping_ms', 'total_ms']) {
      const col = getColumn(quadrantCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    const threadType = getColumn(quadrantCols, 'thread_type');
    expect(threadType.type).toBe('string');

    const q1Pct = getColumn(quadrantCols, 'q1_pct');
    expect(q1Pct.type).toBe('percentage');
    expect(q1Pct.format).toBe('percentage');

    const criticalColumns = getStep('critical_tasks').display?.columns || [];
    expect(getColumn(criticalColumns, 'q4a_uninterruptible_ms')).toMatchObject({
      type: 'duration', format: 'duration_ms', unit: 'ms',
    });
    expect(criticalColumns.some((column: any) => column.name === 'q4a_io_blocked_ms')).toBe(false);
    const atomicCriticalColumns = loadYaml('skills/atomic/startup_critical_tasks.skill.yaml').display.columns;
    expect(getColumn(atomicCriticalColumns, 'q4a_uninterruptible_ms')).toMatchObject({
      type: 'duration', format: 'duration_ms', unit: 'ms',
    });
    expect(atomicCriticalColumns.some((column: any) => column.name === 'q4a_io_blocked_ms')).toBe(false);
  });

  // Execute the maintained YAML queries, including their real target fragment.
  // Only fixture parameter substitution is local to this test.
  const query = (db: Database.Database, target: string, options: {
    start?: number; end?: number; upid?: number | null; packageName?: string; topN?: number;
  } = {}) => {
    db.exec('UPDATE thread_state SET ucpu=cpu; UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu');
    const detail = loadYaml('skills/composite/startup_detail.skill.yaml');
    const node = target === 'critical_tasks'
      ? loadYaml('skills/atomic/startup_critical_tasks.skill.yaml')
      : target === 'hot_slice_states'
        ? loadYaml('skills/atomic/startup_hot_slice_states.skill.yaml')
        : detail.steps.find((step: any) => step.id === target);
    expect(node).toBeDefined();
    let sql = node.sql as string;
    for (const fragment of node.sql_fragments || []) {
      const text = fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8');
      sql = sql.replace(/\bWITH\s+/i, `WITH ${text}\n,\n`);
    }
    const parameters: Record<string, string> = {
      start_ts: String(options.start ?? 10000000),
      end_ts: String(options.end ?? 40000000),
      '__process_scope.upid': String(options.upid === null ? 'NULL' : options.upid ?? 42),
      package: options.packageName ?? 'com.example.app',
      'top_k|15': '15',
      'top_n|10': String(options.topN ?? 3),
    };
    sql = sql.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      expect(parameters[key]).toBeDefined();
      return parameters[key];
    });
    return db.prepare(sql).all() as Array<Record<string, any>>;
  };

  const fixture = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, tid INTEGER, upid INTEGER, name TEXT,is_idle INTEGER DEFAULT 0);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY,utid INTEGER);
      CREATE TABLE slice(id INTEGER PRIMARY KEY,track_id INTEGER,ts INTEGER,dur INTEGER,name TEXT);
      CREATE TABLE sched_slice(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, cpu INTEGER,
        ucpu INTEGER, utid INTEGER, end_state TEXT, priority INTEGER);
      CREATE TABLE thread_state(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, cpu INTEGER,
        utid INTEGER, state TEXT,ucpu INTEGER,io_wait INTEGER,blocked_function TEXT,waker_utid INTEGER,irq_context INTEGER);
      CREATE TABLE cpu_frequency_counters(cpu INTEGER, ts INTEGER, dur INTEGER, freq INTEGER,id INTEGER,track_id INTEGER,ucpu INTEGER);
      CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
      INSERT INTO trace_bounds VALUES(0,100000000);
      CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
      INSERT INTO cpu VALUES(0,0,NULL,0,300),(7,7,NULL,1,1024),(10,10,NULL,2,512);
      CREATE TABLE _cpu_topology(cpu_id INTEGER PRIMARY KEY, core_type TEXT, topology_source TEXT);
      INSERT INTO process VALUES (42,100,'com.example.app'),(43,101,'com.example.app'),
        (99,900,'system_server');
      INSERT INTO thread(utid,tid,upid,name) VALUES (1,100,42,'main'),(2,102,42,'worker'),
        (3,900,99,'system_server'),(4,101,43,'other incarnation');
      INSERT INTO thread VALUES(0,0,NULL,'swapper',1);
      INSERT INTO _cpu_topology VALUES (0,'little','capacity_scale'),(7,'big','capacity_scale');
    `);
    return db;
  };

  it('keeps native hot-slice identity, clipped Top-N scope and missing state coverage', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO thread_track VALUES (1,1),(2,4);
        INSERT INTO slice VALUES
          (10,1,5000000,13000000,'same_name'),
          (11,1,10000000,8000000,'same_name'),
          (12,1,30000000,-1,'unfinished'),
          (13,1,20000000,6000000,'below_limit'),
          (20,2,10000000,30000000,'other_process');
        INSERT INTO thread_state(id,ts,dur,utid,state,io_wait,blocked_function) VALUES
          (101,5000000,10000000,1,'Running',NULL,NULL),
          (102,35000000,-1,1,'S',NULL,'futex_wait'),
          (201,10000000,30000000,4,'Running',NULL,NULL);
      `);
      const rows = query(db, 'hot_slice_states');
      expect(new Set(rows.map(row => row.slice_id))).toEqual(new Set([10, 11, 12]));
      expect(rows.every(row => row.upid === 42 && row.utid === 1 && row.pid === 100 && row.tid === 100)).toBe(true);
      expect(rows.find(row => row.slice_id === 12)).toMatchObject({
        sample_rank: 1, slice_dur_ms: 10, raw_slice_end_ts: null,
        right_censored: 1, is_unfinished: 1, state: 'S', state_dur_ms: 5,
        state_coverage_ms: 5, state_coverage_pct: 50, uncovered_ms: 5,
        sample_limit: 3, eligible_slice_count: 4, selected_slice_count: 3,
        sampling_scope: 'top_by_clipped_duration_within_analysis_window',
      });
      expect(rows.find(row => row.slice_id === 10)).toMatchObject({
        sample_rank: 2, slice_ts: '10000000', slice_end_ts: '18000000',
        raw_slice_ts: '5000000', left_censored: 1, state_dur_ms: 5,
        state_coverage_pct: 62.5, uncovered_ms: 3,
      });
      expect(rows.find(row => row.slice_id === 11)).toMatchObject({
        sample_rank: 3, state: 'Running', state_dur_ms: 5,
        state_coverage_pct: 62.5, uncovered_ms: 3,
      });
      expect(rows.some(row => row.slice_id === 13)).toBe(false);
      expect(rows.every(row => row.state_coverage_ms <= row.slice_dur_ms)).toBe(true);

      db.exec('DELETE FROM thread_state WHERE utid=1');
      expect(query(db, 'hot_slice_states').find(row => row.slice_id === 12)).toMatchObject({
        state: 'NotObserved', evidence_strength: 'state_coverage_missing',
        state_dur_ms: 0, state_coverage_ms: 0, state_coverage_pct: 0, uncovered_ms: 10,
      });
    } finally { db.close(); }
  });

  it('projects every hot-slice identity, clipping, coverage and sampling field through startup_detail', () => {
    const atomic = loadYaml('skills/atomic/startup_hot_slice_states.skill.yaml');
    const composite = loadYaml('skills/composite/startup_detail.skill.yaml').steps
      .find((step: any) => step.id === 'hot_slice_states');
    expect(composite).toBeDefined();
    expect(composite.display.columns.map((column: any) => column.name))
      .toEqual(atomic.display.columns.map((column: any) => column.name));
  });

  it('weights frequency only over the true intersection of running, counter and selected window', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES (1,0,12000000,7,7,1,'S',120),
          (2,30000000,20000000,7,7,1,'S',120),
          (3,12000000,18000000,7,7,3,'S',100),
          (4,10000000,30000000,0,0,4,'S',120);
        INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES (7,0,35000000,1000000),
          (7,35000000,65000000,2000000);
      `);
      expect(query(db, 'cpu_freq_analysis', {packageName: 'stale.display.name'})).toEqual([
        expect.objectContaining({core_type: 'big', avg_freq_mhz: 1417, min_freq_mhz: 1000, max_freq_mhz: 2000}),
      ]);
      const rows = query(db, 'per_cpu_system_context', {packageName: 'stale.display.name'});
      expect(rows.every(row => row.upid === 42 && row.utid === 1)).toBe(true);
      expect(rows.find(row => row.cpu === 7)).toMatchObject({
        avg_freq_mhz: 1166.67, freq_coverage_ms: 30, freq_coverage_pct: 100,
        sched_coverage_ms: 30, system_busy_ms: 30, system_busy_pct: 100,
        target_main_running_ms: 12, topology_source: 'recorded_capacity',
        evidence_scope: 'system_context_not_causal_attribution',
      });
      // The peer's CPU work survives exact target binding; other incarnations
      // are system context, not target work.
      expect(rows.find(row => row.cpu === 0)).toMatchObject({system_busy_ms: 30, target_main_running_ms: 0});
    } finally { db.close(); }
  });

  it('preserves missing frequency, missing scheduler data and unknown topology without fabricating zero load', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE cpu SET capacity=NULL WHERE id=10;
        INSERT INTO sched_slice VALUES (1,10000000,30000000,0,0,0,'S',120);
        INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES (10,20000000,10000000,1500000);
      `);
      expect(query(db, 'cpu_freq_analysis')).toEqual([]);
      const rows = query(db, 'per_cpu_system_context');
      expect(rows.find(row => row.cpu === 0)).toMatchObject({
        avg_freq_mhz: null, min_freq_mhz: null, max_freq_mhz: null,
        freq_coverage_ms: 0, freq_coverage_pct: 0,
        sched_coverage_ms: 30, system_busy_ms: 0, target_main_running_ms: 0,
      });
      expect(rows.find(row => row.cpu === 10)).toMatchObject({
        core_type: 'unknown', topology_source: 'capacity_incomplete', avg_freq_mhz: 1500,
        freq_coverage_ms: 10, freq_coverage_pct: 33.33,
        sched_coverage_ms: 0, system_busy_ms: null, system_busy_pct: null,
        target_main_running_ms: null,
      });
      // A known CPU without any observation in this window remains visible
      // as unknown; absence of data is not an idle/offline observation.
      expect(rows.find(row => row.cpu === 7)).toMatchObject({
        core_type: 'unknown', topology_source: 'capacity_incomplete', capacity: 1024, avg_freq_mhz: null,
        freq_coverage_ms: 0, sched_coverage_ms: 0, system_busy_ms: null,
        target_main_running_ms: null,
      });
    } finally { db.close(); }
  });

  it('links only R+ actual switch points to the exact next task on the same ucpu and preserves peer identity', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES
          (1,0,15000000,7,7,1,'R+',120),
          (2,15000000,5000000,7,7,3,'S',90),
          (3,15000000,5000000,0,0,3,'S',80),
          (4,20000000,2000000,7,7,1,'R',110),
          (5,11000000,5000000,0,0,2,'R+',NULL),
          (6,17000000,1000000,0,0,3,'S',95),
          (7,25000000,15000000,7,7,1,'R+',110),
          (8,10000000,5000000,4,4,4,'R+',90),
          (9,26000000,-1,0,0,2,'R+',120);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,15000000,25000000,NULL,1,'R+');
      `);
      const rows = query(db, 'preemption', {end: 30000000, packageName: 'stale.display.name'});
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({sched_id: 1, switch_ts: '15000000', upid: 42, utid: 1,
        next_sched_id: 2, next_upid: 99, next_utid: 3, next_process_name: 'system_server',
        priority: 120, next_priority: 90, observed_wait_ms: 15,
        wait_evidence: 'observed_runnable_preempted',
        handoff_evidence: 'exact_same_cpu_handoff_not_causal_duration',
        scheduling_policy_evidence: 'not_recorded_in_sched_slice'});
      expect(rows[1]).toMatchObject({sched_id: 5, switch_ts: '16000000', priority: null,
        next_sched_id: null, observed_wait_ms: null,
        wait_evidence: 'missing_runnable_state', handoff_evidence: 'next_task_not_observed'});
      // The selected end at 30ms is not the actual R+ switch at 40ms.
      expect(rows.some(row => row.sched_id === 7)).toBe(false);
    } finally { db.close(); }
  });

  it('does not substitute ordinary Runnable or incomplete state duration for observed R+ waiting', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES (1,0,10000000,7,7,1,'R+',120),
          (2,20000000,5000000,7,7,1,'R+',120);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,10000000,10000000,NULL,1,'R'),
          (2,25000000,-1,NULL,1,'R+');
      `);
      const rows = query(db, 'preemption');
      expect(rows[0]).toMatchObject({switch_ts: '10000000', observed_wait_ms: null, wait_evidence: 'missing_runnable_state'});
      expect(rows[1]).toMatchObject({observed_wait_ms: null, wait_evidence: 'incomplete_runnable_state'});
    } finally { db.close(); }
  });

  it('keeps critical-task priorities as observations and clips R+ states without inventing a scheduling policy', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE cpu SET capacity=NULL,cluster_id=NULL WHERE id=10;
        INSERT INTO sched_slice VALUES (1,0,15000000,7,7,1,'R+',120),
          (2,40000000,10000000,0,0,1,'S',90),
          (3,10000000,5000000,10,10,2,'S',NULL),
          (4,20000000,5000000,7,7,2,'S',NULL);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,0,15000000,7,1,'Running'),
          (2,15000000,25000000,NULL,1,'R+'),(3,40000000,10000000,0,1,'Running'),
          (4,50000000,50000000,NULL,1,'S'),(5,10000000,5000000,10,2,'Running'),
          (6,20000000,5000000,7,2,'Running'),(7,10000000,50000000,7,4,'Running');
      `);
      const rows = query(db, 'critical_tasks', {end: 60000000, packageName: 'stale.display.name'});
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({upid: 42, pid: 100, utid: 1, tid: 100,
        window_start_ts: 10000000, window_end_ts: 60000000, total_observed_threads: 2,
        total_cpu_ms: 15, q3_runnable_ms: 25, runnable_preempted_ms: 25, total_ms: 50,
        priority_min: 90, priority_max: 120, priority_value_count: 2, preemption_count: 1,
        priority_evidence: 'observed_kernel_priority_only', scheduling_policy_evidence: 'not_recorded_in_sched_slice'});
      expect(rows[1]).toMatchObject({utid: 2, priority_min: null, priority_max: null,
        priority_value_count: 0, preemption_count: 0, priority_evidence: 'kernel_priority_unavailable',
        unknown_running_ms: 10, cross_cluster_migrations: null, observed_cross_cluster_migrations: 0,
        unknown_cluster_migrations: 1, migration_evidence: 'partial_cluster_identity'});
    } finally { db.close(); }
  });

  it('retains the main thread and long-waiting tasks when no CPU slice or priority was recorded', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,0,50000000,NULL,1,'R+'),
        (2,5000000,50000000,NULL,2,'R');`);
      const rows = query(db, 'critical_tasks');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({utid: 1, total_cpu_ms: 0, q3_runnable_ms: 30,
        runnable_preempted_ms: 30, priority_min: null, priority_max: null,
        preemption_count: null, priority_evidence: 'sched_slice_unavailable'});
      expect(rows[1]).toMatchObject({utid: 2, q3_runnable_ms: 30, runnable_preempted_ms: 0});
    } finally { db.close(); }
  });

  it('does not prescribe FIFO or assert contention/cache damage from parallel CPU totals or migrations alone', () => {
    const detail = loadYaml('skills/composite/startup_detail.skill.yaml');
    const rules = detail.steps.find((step: any) => step.id === 'startup_diagnosis').rules;
    expect(JSON.stringify(rules)).not.toContain('考虑使用 SCHED_FIFO');
    expect(JSON.stringify(rules)).not.toContain('L2 Cache 反复失效导致性能损失');
    expect(JSON.stringify(rules)).not.toContain('CPU 争抢激烈');
    expect(detail.steps.find((step: any) => step.id === 'preemption').process_scope.context_fields.peer_context)
      .toContain('next_upid');
    expect(detail.steps.find((step: any) => step.id === 'per_cpu_system_context').process_scope.context_fields.global_context)
      .toContain('system_busy_ms');
  });

  it('accounts for unknown running and other observed states without assigning them to little cores', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE cpu SET capacity=NULL WHERE id=10;
        INSERT INTO sched_slice VALUES (1,10000000,10000000,10,10,1,'R',120);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,10000000,10000000,10,1,'Running'),
          (2,20000000,10000000,NULL,1,'R'),(3,30000000,10000000,NULL,1,'T');
      `);
      expect(query(db, 'cpu_core_analysis')).toEqual([
        expect.objectContaining({big_core_ms: 0, little_core_ms: 0, total_running_ms: 10,
          unknown_core_ms: 10, unknown_core_pct: 100, classify_method: 'capacity_incomplete'}),
      ]);
      const quadrant = query(db, 'quadrant_analysis')[0];
      expect(quadrant).toMatchObject({q1_big_running_ms: 0, q2_little_running_ms: 0,
        q3_runnable_ms: 10, unknown_running_ms: 10, other_state_ms: 10, total_ms: 30});
      expect(quadrant.q1_big_running_ms + quadrant.q2_little_running_ms + quadrant.q3_runnable_ms +
        quadrant.q4a_uninterruptible_ms + quadrant.q4b_sleeping_ms + quadrant.unknown_running_ms + quadrant.other_state_ms)
        .toBe(quadrant.total_ms);
      const critical = query(db, 'critical_tasks');
      expect(critical).toEqual([
        expect.objectContaining({total_cpu_ms: 10, q1_big_running_ms: 0, q2_little_running_ms: 0,
          unknown_running_ms: 10, other_state_ms: 10, q3_runnable_ms: 10,
          q4a_uninterruptible_ms: 0, big_core_pct: null, total_ms: 30}),
      ]);
      expect(critical[0]).not.toHaveProperty('q4a_io_blocked_ms');
      expect(critical[0]).not.toHaveProperty('unknown_running_unrounded_ms');
    } finally { db.close(); }
  });

  it('reports a big-core percentage only when every running interval has known topology', () => {
    const run = (states: string) => {
      const db = fixture();
      try {
        db.exec(`UPDATE cpu SET machine_id=1,capacity=NULL WHERE id=10; ${states}`);
        return query(db, 'critical_tasks')[0];
      } finally { db.close(); }
    };

    expect(run(`INSERT INTO thread_state(id,ts,dur,cpu,utid,state) VALUES
      (1,10000000,10000000,0,1,'Running')`)).toMatchObject({
      total_cpu_ms: 10, q1_big_running_ms: 0, q2_little_running_ms: 10,
      unknown_running_ms: 0, big_core_pct: 0,
    });
    expect(run(`INSERT INTO thread_state(id,ts,dur,cpu,utid,state) VALUES
      (1,10000000,5000000,0,1,'Running'),(2,15000000,5000000,7,1,'Running')`)).toMatchObject({
      total_cpu_ms: 10, q1_big_running_ms: 5, q2_little_running_ms: 5,
      unknown_running_ms: 0, big_core_pct: 50,
    });
    expect(run(`INSERT INTO thread_state(id,ts,dur,cpu,utid,state) VALUES
      (1,10000000,10000000,0,1,'Running'),(2,20000000,1000000,10,1,'Running')`)).toMatchObject({
      total_cpu_ms: 11, unknown_running_ms: 1, big_core_pct: null,
    });
    expect(run(`INSERT INTO thread_state(id,ts,dur,cpu,utid,state) VALUES
      (1,10000000,10000000,0,1,'Running'),(2,20000000,1,10,1,'Running')`)).toMatchObject({
      total_cpu_ms: 10, unknown_running_ms: 0, big_core_pct: null,
    });
  });

  it('preserves every system evidence locator through production display projection and restored artifact fetch', async () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES (1,0,15000000,7,7,1,'R+',120),
          (2,15000000,15000000,7,7,3,'S',90),
          (3,30000000,10000000,7,7,1,'S',110),
          (4,10000000,5000000,0,0,2,'S',NULL);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,0,15000000,7,1,'Running'),
          (2,15000000,15000000,NULL,1,'R+'),(3,30000000,10000000,7,1,'Running'),
          (4,10000000,5000000,0,2,'Running');
        INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES (7,0,100000000,1500000);
      `);
      const sources = ['per_cpu_system_context', 'preemption', 'critical_tasks'];
      const rawRows = Object.fromEntries(sources.map(id => [id, query(db, id)]));
      const detail = loadYaml('skills/composite/startup_detail.skill.yaml');
      const critical = loadYaml('skills/atomic/startup_critical_tasks.skill.yaml');
      // Validate both projection directions: a declared evidence column must
      // exist in SQL rows, not merely preserve whichever columns SQL returned.
      for (const column of critical.display.columns) {
        expect(Object.prototype.hasOwnProperty.call(rawRows.critical_tasks[0], column.name)).toBe(true);
      }
      // The fixture processor returns the SQL rows already tested above.
      // Keep production parent/child display contracts and execute the real
      // nested Skill path, where unlisted columns would otherwise be dropped.
      const executor = createSkillExecutor({
        query: async (_traceId: string, sql: string) => {
          const id = sources.find(source => sql.includes(`'${source}'`));
          expect(id).toBeDefined();
          const rows = rawRows[id!];
          const columns = Object.keys(rows[0]);
          return {columns, rows: rows.map(row => columns.map(column => row[column]))};
        },
        touchTrace: () => undefined,
      });
      executor.registerSkill(JSON.parse(JSON.stringify({...critical, identity: undefined, prerequisites: undefined,
        sql_fragments: undefined, sql: "SELECT 'critical_tasks' AS fixture_source"})));
      executor.registerSkill(JSON.parse(JSON.stringify({...detail, identity: undefined, prerequisites: undefined,
        steps: detail.steps.filter((step: any) => sources.includes(step.id)).map((step: any) =>
          step.type === 'skill' ? step : {...step, sql_fragments: undefined,
            sql: `SELECT '${step.id}' AS fixture_source`})})));
      const result = await executor.execute('startup_detail', 'system-evidence-delivery', {
        startup_id: 1, package: 'com.example.app', startup_type: 'cold',
        start_ts: 10000000, end_ts: 40000000, dur_ms: 30,
      });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(Object.fromEntries(Object.entries(result.rawResults || {}).map(([id, step]) => [id,
        {success: step.success, error: step.error}]))).toEqual(Object.fromEntries(sources.map(id => [id,
          {success: true, error: undefined}])));
      const store = new ArtifactStore();
      for (const source of sources) {
        const display = result.displayResults.find(item => item.stepId === source);
        expect(display).toBeDefined();
        const data = display!.data as {columns: string[]; rows: unknown[][]};
        // Store dr.data exactly as the MCP artifact adapter does; fetching raw
        // result.data here would conceal projection regressions.
        const id = store.store({skillId: detail.name, stepId: source, data});
        const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
        const fetched = restored.fetch(id, 'rows');
        expect(data.rows).toHaveLength(rawRows[source].length);
        expect(fetched.rows).toHaveLength(rawRows[source].length);
        for (const [index, raw] of rawRows[source].entries()) {
          expect(fetched.rows[index].rowIndex).toBe(index);
          for (const [column, value] of Object.entries(raw)) {
            expect(data.columns).toContain(column);
            expect(fetched.columns).toContain(column);
            // The established display formatter renders null as '-'. Explicit
            // evidence status survives so unavailable never means numeric zero.
            const displayedValue = value === null ? '-' : value;
            expect(data.rows[index][data.columns.indexOf(column)]).toBe(displayedValue);
            expect(fetched.rows[index].values[fetched.columns.indexOf(column)]).toBe(displayedValue);
          }
        }
      }
    } finally { db.close(); }
  });
});

describe('nullable thread-state evidence', () => {
  const loadSkill = (relativePath: string): any => yaml.load(
    fs.readFileSync(path.join(process.cwd(), 'skills', relativePath), 'utf8'));

  const withFragments = (node: any): string => {
    let sql = node.sql as string;
    for (const fragment of node.sql_fragments || []) {
      const text = fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8');
      sql = sql.replace(/\bWITH\s+/i, `WITH ${text}\n,\n`);
    }
    return sql;
  };

  const render = (sql: string, parameters: Record<string, string>): string => sql.replace(
    /\$\{([^}]+)\}/g, (_, key: string) => {
      expect(parameters[key]).toBeDefined();
      return parameters[key];
    });

  const fixture = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
      INSERT INTO trace_bounds VALUES(0,100000000);
      CREATE TABLE process(upid INTEGER PRIMARY KEY,pid INTEGER,name TEXT);
      INSERT INTO process VALUES(42,100,'com.example.app');
      CREATE TABLE thread(utid INTEGER PRIMARY KEY,tid INTEGER,upid INTEGER,name TEXT,is_idle INTEGER DEFAULT 0);
      INSERT INTO thread VALUES(1,100,42,'main',0);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY,utid INTEGER);
      INSERT INTO thread_track VALUES(1,1);
      CREATE TABLE slice(id INTEGER PRIMARY KEY,track_id INTEGER,ts INTEGER,dur INTEGER,name TEXT,depth INTEGER DEFAULT 0);
      INSERT INTO slice VALUES(10,1,10000000,12000000,'selected',0);
      CREATE TABLE android_startups(startup_id INTEGER,package TEXT,startup_type TEXT,ts INTEGER,dur INTEGER);
      INSERT INTO android_startups VALUES(7,'com.example.app','cold',10000000,12000000);
      CREATE TABLE android_startup_threads(startup_id INTEGER,utid INTEGER,is_main_thread INTEGER,ts INTEGER,dur INTEGER);
      INSERT INTO android_startup_threads VALUES(7,1,1,10000000,12000000);
      CREATE TABLE thread_state(id INTEGER PRIMARY KEY,ts INTEGER,dur INTEGER,cpu INTEGER,ucpu INTEGER,
        utid INTEGER,state TEXT,io_wait INTEGER,blocked_function TEXT,waker_utid INTEGER,irq_context INTEGER);
      INSERT INTO thread_state VALUES
        (1,10000000,2000000,NULL,NULL,1,'D',NULL,NULL,NULL,NULL),
        (2,12000000,2000000,NULL,NULL,1,'D',0,'',NULL,NULL),
        (3,14000000,2000000,NULL,NULL,1,'D',1,'io_schedule',NULL,NULL),
        (4,16000000,2000000,NULL,NULL,1,'D',NULL,'filemap_fault',NULL,NULL),
        (5,18000000,2000000,NULL,NULL,1,'S',NULL,'futex_wait',NULL,NULL),
        (6,20000000,2000000,NULL,NULL,1,'D',0,'mutex_lock',NULL,NULL);
    `);
    return db;
  };

  const common = {
    package: 'com.example.app', 'package|': 'com.example.app',
    start_ts: '10000000', end_ts: '22000000', startup_id: '7', startup_type: 'cold',
    '__process_scope.upid': '42', 'upid|0': '42', 'pid|0': '0',
    'top_n|10': '10', 'top_k|10': '10', 'top_k|20': '20', 'min_block_ms|1': '1',
    'target_process.data[0].upid': '42',
  };

  const expectStateRows = (rows: Array<Record<string, any>>, blockedColumn: string) => {
    expect(rows.find(row => row.state === 'D' && row.io_wait === null && row[blockedColumn] === null))
      .toMatchObject({evidence_strength: 'ambiguous_uninterruptible_wait'});
    expect(rows.find(row => row.state === 'D' && row.io_wait === 0 && row[blockedColumn] === null))
      .toMatchObject({evidence_strength: 'ambiguous_uninterruptible_wait'});
    expect(rows.find(row => row.state === 'D' && row.io_wait === 1 && row[blockedColumn] === 'io_schedule'))
      .toMatchObject({evidence_strength: 'direct_io_wait'});
    expect(rows.find(row => row.state === 'D' && row.io_wait === null && row[blockedColumn] === 'filemap_fault'))
      .toMatchObject({evidence_strength: 'inferred_io_or_page_cache'});
    expect(rows.find(row => row.state === 'S' && row.io_wait === null && row[blockedColumn] === 'futex_wait'))
      .toMatchObject({evidence_strength: 'lock_wait'});
  };

  it('preserves NULL, explicit false and true in startup_hot_slice_states', () => {
    const db = fixture();
    try {
      const skill = loadSkill('atomic/startup_hot_slice_states.skill.yaml');
      const rows = db.prepare(render(withFragments(skill), common)).all() as Array<Record<string, any>>;
      expectStateRows(rows, 'blocked_functions');
      db.exec('DELETE FROM thread_state');
      expect((db.prepare(render(withFragments(skill), common)).get() as Record<string, any>)).toMatchObject({
        state: 'NotObserved', io_wait: null, blocked_functions: null,
        evidence_strength: 'state_coverage_missing',
      });
    } finally { db.close(); }
  });

  it('preserves NULL, explicit false and true in startup_main_thread_states_in_range', () => {
    const db = fixture();
    try {
      const skill = loadSkill('atomic/startup_main_thread_states_in_range.skill.yaml');
      const rows = db.prepare(render(withFragments(skill), common)).all() as Array<Record<string, any>>;
      expectStateRows(rows, 'blocked_functions');
    } finally { db.close(); }
  });

  it('preserves NULL, explicit false and true in main_thread_states_in_range', () => {
    const db = fixture();
    try {
      const skill = loadSkill('atomic/main_thread_states_in_range.skill.yaml');
      const rows = db.prepare(render(withFragments(skill), common)).all() as Array<Record<string, any>>;
      expectStateRows(rows, 'blocked_function');
    } finally { db.close(); }
  });

  it('preserves nullable io_wait in both cpu_analysis state outputs', () => {
    const db = fixture();
    try {
      const skill = loadSkill('composite/cpu_analysis.skill.yaml');
      const main = skill.steps.find((step: any) => step.id === 'main_thread_states');
      const mainRows = db.prepare(render(withFragments(main), common)).all() as Array<Record<string, any>>;
      expect(mainRows.some(row => row.state === 'D' && row.io_wait === null)).toBe(true);
      expect(mainRows.some(row => row.state === 'D' && row.io_wait === 0)).toBe(true);
      expect(mainRows.some(row => row.state === 'D' && row.io_wait === 1)).toBe(true);

      const blocked = skill.steps.find((step: any) => step.id === 'blocked_functions');
      const blockedRows = db.prepare(render(withFragments(blocked), common)).all() as Array<Record<string, any>>;
      expect(blockedRows.find(row => row.io_wait === 1 && row.blocked_function === 'io_schedule'))
        .toMatchObject({evidence_strength: 'direct_io_wait'});
      expect(blockedRows.find(row => row.io_wait === null && row.blocked_function === 'filemap_fault'))
        .toMatchObject({evidence_strength: 'inferred_io_or_page_cache'});
      expect(blockedRows.find(row => row.io_wait === null && row.blocked_function === 'futex_wait'))
        .toMatchObject({evidence_strength: 'lock_wait'});
      expect(blockedRows.find(row => row.io_wait === 0 && row.blocked_function === 'mutex_lock'))
        .toMatchObject({evidence_strength: 'ambiguous_uninterruptible_wait'});
    } finally { db.close(); }
  });

  it('keeps missing and empty blocking functions NULL in startup_thread_blocking_graph', () => {
    const db = fixture();
    try {
      const skill = loadSkill('atomic/startup_thread_blocking_graph.skill.yaml');
      const rows = db.prepare(render(withFragments(skill), common)).all() as Array<Record<string, any>>;
      expect(rows.find(row => row.thread_state_id === 1)).toMatchObject({
        blocked_state: 'D', blocked_function: null,
        relation_status: 'observed_wakeup_not_proven_blocking_cause',
      });
      expect(rows.find(row => row.thread_state_id === 2)).toMatchObject({blocked_function: null});
      expect(rows.find(row => row.thread_state_id === 3)).toMatchObject({blocked_function: 'io_schedule'});
    } finally { db.close(); }
  });
});

describe('startup frequency and causal candidate boundaries', () => {
  const skill = (file: string): any => yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills', file), 'utf8'));
  function frequency(fixture: string, start: number, end: number): any[] {
    const db = new Database(':memory:');
    try {
      db.function('trace_end', () => 400_000_000);
      db.exec(`CREATE TABLE cpu(ucpu INTEGER,cpu INTEGER,machine_id INTEGER);
        CREATE TABLE cpu_frequency_counters(ucpu INTEGER,ts INTEGER,dur INTEGER,freq REAL);${fixture}`);
      return db.prepare(skill('atomic/startup_freq_rampup.skill.yaml').sql
        .replaceAll('${start_ts}', String(start)).replaceAll('${end_ts}', String(end))).all();
    } finally { db.close(); }
  }
  it('clips both stage boundaries and separates identical local CPUs on different machines', () => {
    const rows = frequency(`INSERT INTO cpu VALUES(42,7,1),(43,7,2);
      INSERT INTO cpu_frequency_counters VALUES(42,0,175000000,1000000),(42,175000000,75000000,3000000),
      (42,250000000,100000000,9999000),(43,0,300000000,500000);`,50_000_000,250_000_000);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ucpu:42,cpu:7,machine_id:1,early_avg_freq_mhz:1000,
      steady_avg_freq_mhz:2500,max_freq_mhz:3000,early_covered_ns:100_000_000,
      steady_covered_ns:100_000_000,rampup_pct:150,assessment:'later_frequency_higher_observed'});
    expect(rows[1]).toMatchObject({ucpu:43,cpu:7,machine_id:2,early_avg_freq_mhz:500,steady_avg_freq_mhz:500});
    expect(rows[0].claim_boundary).toContain('not_capacity_throttling_or_governor_delay_proof');
  });
  it('keeps the absent later phase unknown for a short launch', () => {
    expect(frequency('INSERT INTO cpu VALUES(1,0,NULL); INSERT INTO cpu_frequency_counters VALUES(1,0,200000000,1000000);',
      50_000_000,80_000_000)[0]).toMatchObject({early_window_ns:30_000_000,early_covered_ns:30_000_000,
      steady_window_ns:0,steady_covered_ns:0,steady_avg_freq_mhz:null,rampup_pct:null,assessment:'no_comparison_window'});
  });
  it('distinguishes missing samples from observed zero frequency', () => {
    const rows = frequency('INSERT INTO cpu VALUES(1,0,NULL),(2,1,NULL); INSERT INTO cpu_frequency_counters VALUES(2,0,200000000,0);',0,200_000_000);
    expect(rows[0]).toMatchObject({early_avg_freq_mhz:null,steady_avg_freq_mhz:null,early_covered_ns:0,
      max_freq_mhz:null,rampup_pct:null,assessment:'insufficient_frequency_coverage'});
    expect(rows[1]).toMatchObject({early_avg_freq_mhz:0,steady_avg_freq_mhz:0,early_covered_ns:100_000_000,max_freq_mhz:0,rampup_pct:null});
  });
  it('clips unfinished samples to trace end', () => {
    expect(frequency('INSERT INTO cpu VALUES(1,0,NULL); INSERT INTO cpu_frequency_counters VALUES(1,0,-1,2000000);',
      300_000_000,500_000_000)[0]).toMatchObject({early_avg_freq_mhz:2000,early_covered_ns:100_000_000,
      steady_covered_ns:0,steady_avg_freq_mhz:null,assessment:'insufficient_frequency_coverage'});
  });
  it('does not hide overlapping spans behind missing coverage', () => {
    expect(frequency(`INSERT INTO cpu VALUES(1,0,NULL); INSERT INTO cpu_frequency_counters VALUES
      (1,0,40000000,1000000),(1,20000000,40000000,2000000),(1,100000000,100000000,3000000);`,0,200_000_000)[0])
      .toMatchObject({early_avg_freq_mhz:null,early_covered_ns:80_000_000,steady_avg_freq_mhz:3000,
        rampup_pct:null,assessment:'overlapping_frequency_spans'});
  });
  function reasonFixture(code: string, until: string, fixture: string): any {
    const db = new Database(':memory:');
    try {
      db.function('trace_end', () => 200_000_000);
      db.exec(fixture);
      const sql = skill('atomic/startup_slow_reasons.skill.yaml').steps.find((s: any) => s.id === 'slow_reason_checks').sql;
      const branch = sql.slice(sql.indexOf(`SELECT '${code}'`),sql.indexOf(`-- ${until}:`));
      return db.prepare(`WITH result(reason_id,reason,severity,evidence,suggestion) AS (${branch}) SELECT * FROM result`).get();
    } finally { db.close(); }
  }
  it('clips nanosleep waits and leaves their calling API unconfirmed', () => {
    const row = reasonFixture('SR11','SR12',`CREATE TABLE startup_info(ts INTEGER,dur INTEGER);
      INSERT INTO startup_info VALUES(10000000,10000000); CREATE TABLE main_thread(utid INTEGER); INSERT INTO main_thread VALUES(1);
      CREATE TABLE thread_state(utid INTEGER,ts INTEGER,dur INTEGER,state TEXT,blocked_function TEXT);
      INSERT INTO thread_state VALUES(1,5000000,10000000,'S','hrtimer_nanosleep'),(1,15000000,-1,'S','hrtimer_nanosleep'),
        (1,20000000,10000000,'S','hrtimer_nanosleep'),(1,0,10000000,'S','hrtimer_nanosleep'),(2,10000000,10000000,'S','hrtimer_nanosleep');`);
    expect(row.evidence).toContain('10.0 ms (2 次)');
    expect(row.reason).toContain('调用 API 尚未确认');
  });
  it('clips only direct-child initialization work without claiming SDK identity', () => {
    const row = reasonFixture('SR12','SR13',`CREATE TABLE startup_info(ts INTEGER,dur INTEGER); INSERT INTO startup_info VALUES(50000000,50000000);
      CREATE TABLE main_thread(utid INTEGER); INSERT INTO main_thread VALUES(1);
      CREATE TABLE thread_track(id INTEGER,utid INTEGER); INSERT INTO thread_track VALUES(1,1);
      CREATE TABLE slice(id INTEGER,track_id INTEGER,ts INTEGER,dur INTEGER,depth INTEGER,name TEXT);
      INSERT INTO slice VALUES(1,1,0,100000000,0,'bindApplication'),(2,1,0,90000000,1,'AppInit'),(3,1,5000000,80000000,2,'NestedWork');`);
    expect(row.evidence).toContain('80.0%');
    expect(row.evidence).toContain('40.0 ms');
    expect(row.reason).toContain('尚未识别 SDK 或业务身份');
  });
  it('keeps per-CPU frequency coverage and boundaries in the parent artifact projection', () => {
    const child = skill('atomic/startup_freq_rampup.skill.yaml');
    const parent = skill('composite/startup_detail.skill.yaml').steps.find((s: any) => s.id === 'freq_rampup');
    expect(parent.display.columns).toEqual(child.display.columns);
  });
  it('keeps wakeup identity and provenance in the parent artifact projection', () => {
    const child = skill('atomic/startup_thread_blocking_graph.skill.yaml');
    const parent = skill('composite/startup_detail.skill.yaml').steps.find((s: any) => s.id === 'thread_blocking_graph');
    expect(parent.display.columns).toEqual(child.display.columns);
  });
});


describe('startup primitive unit authority', () => {
  it.each([
    ['startup_main_thread_slices_in_range', 'total_dur_ms', 'ms', 'proved', 'numeric_operator_proved'],
    ['startup_main_thread_states_in_range', 'total_dur_ms', 'ms', 'proved', 'numeric_operator_proved'],
    ['startup_sched_latency_in_range', 'total_wait_ms', 'ms', 'proved', 'numeric_operator_proved'],
    ['startup_breakdown_in_range', 'total_dur_ms', 'ms', 'proved', 'numeric_operator_proved'],
    ['startup_breakdown_in_range', 'avg_dur_ms', 'ms', 'proved', 'numeric_operator_proved'],
    ['startup_breakdown_in_range', 'max_dur_ms', 'ms', 'proved', 'numeric_operator_proved'],
    ['startup_breakdown_in_range', 'percent', '%', 'candidate', 'unit_authority_unknown'],
  ])('retains %s explicit units without inferring ambiguous percentage scale',
    async (name, column, unit, status, reason) => {
    const skill = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/atomic', `${name}.skill.yaml`), 'utf8')) as any;
    const columns = skill.display.columns.map((item: any) => item.name);
    const row = skill.display.columns.map((item: any) => item.type === 'string' ? 'observed' : 2);
    const executor = createSkillExecutor({query: async () => ({columns, rows: [row], durationMs: 1})});
    // The Skill's own fragments, as the registry would supply them.
    executor.setFragmentRegistry(new Map((skill.sql_fragments ?? []).map((fragment: string) =>
      [fragment, fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8').trim()])));
    executor.registerSkill(normalizeSkillDefinition(skill, `${name}.skill.yaml`)!);
    const params = {package: 'example.app', startup_id: 1, startup_type: 'cold', start_ts: 0, end_ts: 10000000, min_dur_ns: 0, top_k: 15};
    let executedSkill = name;
    let inputNames = skill.inputs.map((input: any) => input.name);
    if (name === 'startup_breakdown_in_range') {
      const parent = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite/startup_analysis.skill.yaml'), 'utf8')) as any;
      const parentStep = parent.steps.find((step: any) => step.id === 'startup_breakdown');
      const fixture = normalizeSkillDefinition({
        name: 'startup_breakdown_parent_fixture', version: '1.0', type: 'composite', category: 'app_lifecycle', tier: 'B',
        meta: {display_name: 'startup breakdown parent fixture', description: 'test fixture'}, inputs: parent.inputs,
        steps: [{...parentStep, condition: undefined, synthesize: undefined}],
      }, 'startup_breakdown_parent_fixture.skill.yaml')!;
      executor.registerSkill(fixture);
      executedSkill = fixture.name;
      inputNames = parent.inputs.map((input: any) => input.name);
    }
    const result = await executor.execute(executedSkill, 'trace', Object.fromEntries(
      Object.entries(params).filter(([key]) => inputNames.includes(key))));
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const display = result.displayResults[0];
    const store = new ArtifactStore();
    const id = store.store({skillId: name, data: display.data, scopeProvenance: display.scopeProvenance, sourceToolCallId: 'invoke:unit',
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(id, evidenceTableFor(display)!, {evidenceRefId: 'startup-metric'})).toBe(true);
    const reference = {artifactId: id, rowIndex: 0, column, value: 2};
    const conclusionContract: any = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], bindingEligibility: 'eligible',
      claims: [{id: 'metric', kind: 'numeric', text: `Observed value is 2 ${unit}`, references: [reference],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [reference]},
          numeric: {operator: 'eq', value: 2, unit}}}]};
    const view = store.createEvidenceReadView({ownerKey: 'test', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]});
    const resolution = await view.resolveReferences([{key: 'unit', reference, requiredColumns: [column]}]);
    expect(resolution.map(item => ({status: item.status, reason: 'reason' in item ? item.reason : undefined}))).toEqual([{status: 'resolved', reason: undefined}]);
    const preparedEvidence = await prepareClaimEvidence({conclusionContract, evidenceReadView: view});
    const verified = runClaimVerification({conclusionContract, preparedEvidence});
    expect(verified.claimVerificationResult.claimResults[0].deterministicProof).toMatchObject({status, reason});
    const facts = getCapturedAnchorFacts(verified.claimSupport[0].anchors[0]);
    if (status === 'proved') {
      expect(facts?.fields[column]).toMatchObject({unit, origin: {kind: 'skill_literal', skillId: name}});
      expect(facts?.fields[column]).not.toHaveProperty('clock');
    } else {
      expect(facts?.fields[column]).toBeUndefined();
    }
  });

  it('keeps startup breakdown units identical in the atomic producer and parent projection', () => {
    const atomic = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/atomic/startup_breakdown_in_range.skill.yaml'), 'utf8')) as any;
    const parentSkill = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite/startup_analysis.skill.yaml'), 'utf8')) as any;
    const parent = parentSkill.steps.find((step: any) => step.id === 'startup_breakdown');
    for (const [column, unit] of [['total_dur_ms', 'ms'], ['avg_dur_ms', 'ms'], ['max_dur_ms', 'ms']]) {
      expect(atomic.display.columns.find((item: any) => item.name === column)?.unit).toBe(unit);
      expect(parent.display.columns.find((item: any) => item.name === column)?.unit).toBe(unit);
    }
    for (const producer of [atomic.display, parent.display]) {
      expect(producer.columns.find((item: any) => item.name === 'percent')).toMatchObject({
        type: 'percentage', format: 'percentage',
      });
      expect(producer.columns.find((item: any) => item.name === 'percent')).not.toHaveProperty('unit');
    }
  });

  it('declares the system busy percentage as an authoritative Skill value', async () => {
    const name = 'cpu_system_context_in_range';
    const skillDef = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/atomic', `${name}.skill.yaml`), 'utf8')) as any;
    const origin = {kind: 'skill_literal' as const, skillId: name, stepId: 'root',
      definitionFingerprint: 'cpu-system-context-v1', selectedSqlHash: 'sql-v1'};
    const fields = investigationCaptureFields(skillDef.investigation_evidence, origin);
    expect(fields.busy_pct).toMatchObject({unit: '%', metricId: 'system.cpu.busy.percentage', origin});
    const witness = captureEvidenceTable({columns: ['busy_pct'], rows: [[68.1201377940634]]}, fields);
    const store = new ArtifactStore();
    store.registerStandaloneEvidenceCapture(witness, {meta: {type: 'skill_result', version: '2.0.0', source: name,
      timestamp: 1, skillId: name, stepId: 'root', executionStatus: 'observed', evidenceRefId: 'cpu-context',
      traceId: 'trace', traceSide: 'current'}, display: {layer: 'deep', level: 'detail', format: 'table', title: 'CPU'}});
    const reference = {evidenceRefId: 'cpu-context', rowIndex: 0, column: 'busy_pct', value: 68.1201377940634};
    const contract: any = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], uncertainties: [], nextSteps: [], bindingEligibility: 'eligible', claims: [{id: 'busy', kind: 'numeric',
        text: 'CPU busy is exactly 68.1201377940634%.', references: [reference], semantics: {schemaVersion: 'claim_semantics@1',
          predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'eq', value: 68.1201377940634, unit: '%'}}}]};
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: contract,
      evidenceReadView: store.createEvidenceReadView({ownerKey: 'test', allowedTraces: [{traceId: 'trace', traceSide: 'current'}]})});
    expect(runClaimVerification({conclusionContract: contract, preparedEvidence}).claimVerificationResult.claimResults[0]
      .deterministicProof).toMatchObject({status: 'proved', reason: 'numeric_operator_proved'});
  });
});
