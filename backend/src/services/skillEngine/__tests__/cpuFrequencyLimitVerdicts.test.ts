// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {describe, it, expect} from '@jest/globals';
import {composeFragmentSql} from '../skillFragments';
import {renderStepSql} from '../../../../tests/helpers/skillFragmentSql';

/**
 * Executable contract for the shared frequency-limit verdict layer.
 *
 * The fragments under skills/fragments/ are the ONLY place that decides a
 * limit sample's validity and direction, a cooling device's policy, and what
 * triggered each limit write. These fixtures run the real fragment SQL and the
 * real consumer step SQL on SQLite, one hand-built trace per rule, so a change
 * that quietly weakens a rule (a reverse-order pair counted as confirmation, a
 * window boundary read as an onset, a zero sample read as a limit) fails here.
 */

const skillsDir = path.join(process.cwd(), 'skills');
const MS = 1_000_000;
const VERDICT_FRAGMENTS = [
  'system_sched_spans',
  'system_cpu_freq_limit_spans',
  'system_cpu_freq_limit_episodes',
  'thermal_cooling_spans',
  'thermal_cdev_policy_association',
  'thermal_signal_signatures',
  'system_cpu_freq_limit_episode_verdicts',
].map(name => `${name}.sql`);

type Window = [number, number, number];

/** The verdict fragment chain behind `system_windows`, composed as the engine injects it. */
function verdictQuery(db: Database.Database, select: string, windows: Window[] = [[0, 0, 10_000 * MS]]): any[] {
  const windowSql = windows
    .map(([id, start, end]) => `SELECT ${id} AS window_id, ${start} AS window_start_ts, ${end} AS window_end_ts`)
    .join(' UNION ALL ');
  return db.prepare(composeFragmentSql({leadingCtes: [`system_windows AS (${windowSql})`],
    fragments: VERDICT_FRAGMENTS, select})).all();
}

function loadSkill(rel: string): any {
  return yaml.load(fs.readFileSync(path.join(skillsDir, rel), 'utf8'));
}

/** Every step of a Skill, including nested steps and inline conditional branches. */
function allStepsOf(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const branches = [...(node.conditions ?? []).map((c: any) => c?.then), node.else]
    .filter(b => b && typeof b === 'object');
  return [...(node.id && node.type ? [node] : []),
    ...[...(node.steps ?? []), ...branches].flatMap(allStepsOf)];
}

function findStep(skill: any, id: string): any {
  const found = allStepsOf(skill).find(s => s.id === id);
  if (!found) throw new Error(`step ${id} not found`);
  return found;
}

/** Run a consumer step exactly as authored: its own SQL with its declared fragments. */
function stepQuery(db: Database.Database, rel: string, id: string, params: Record<string, string | number> = {}): any[] {
  const step = findStep(loadSkill(rel), id);
  return db.prepare(renderStepSql(step.sql, step.sql_fragments,
    {start_ts: 'NULL', end_ts: 'NULL', package: '', process_name: '', ...params})).all();
}

class Fixture {
  readonly db = new Database(':memory:');
  private nextCounter = 1;
  private nextTrack = 1;
  private nextUtid = 10;

  constructor() {
    this.db.exec(`
      CREATE TABLE trace_bounds(start_ts INTEGER, end_ts INTEGER);
      INSERT INTO trace_bounds VALUES (0, ${10_000 * MS});
      CREATE TABLE cpu(id INTEGER PRIMARY KEY, cpu INTEGER, machine_id INTEGER, cluster_id INTEGER, capacity INTEGER);
      INSERT INTO cpu VALUES (0,0,0,0,300),(1,1,0,0,300),(2,2,0,0,300),(3,3,0,0,300),
        (4,4,0,1,700),(5,5,0,1,700),(6,6,0,2,1024),(7,7,0,2,1024);
      CREATE TABLE cpu_counter_track(id INTEGER PRIMARY KEY, cpu INTEGER, type TEXT, name TEXT);
      CREATE TABLE counter_track(id INTEGER PRIMARY KEY, type TEXT, name TEXT, dimension_arg_set_id INTEGER);
      CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
      CREATE TABLE args(arg_set_id INTEGER, key TEXT, string_value TEXT);
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT, uid INTEGER);
      CREATE TABLE android_process_metadata(upid INTEGER, is_kernel_task INTEGER);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, tid INTEGER, name TEXT, is_idle INTEGER);
      CREATE TABLE sched_slice(id INTEGER PRIMARY KEY, utid INTEGER, ts INTEGER, dur INTEGER, cpu INTEGER,
        ucpu INTEGER, end_state TEXT, priority INTEGER);
      CREATE TABLE thread_state(id INTEGER PRIMARY KEY, utid INTEGER, ts INTEGER, dur INTEGER, state TEXT, cpu INTEGER,
        ucpu INTEGER, io_wait INTEGER, blocked_function TEXT, waker_utid INTEGER, irq_context INTEGER);
      CREATE TABLE cpu_frequency_counters(id INTEGER PRIMARY KEY, track_id INTEGER, cpu INTEGER, ucpu INTEGER,
        ts INTEGER, dur INTEGER, freq INTEGER);
      CREATE TABLE slice(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
      CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
      CREATE TABLE actual_frame_timeline_slice(ts INTEGER, dur INTEGER, upid INTEGER, display_frame_token INTEGER);
      INSERT INTO process VALUES (1, 1000, 'com.example.app', 10100);
      INSERT INTO thread VALUES (1, 1, 1000, 'main', 0);
      INSERT INTO thread VALUES (2, 1, 1002, 'RenderThread', 0);
    `);
  }

  /** A Running interval of the app's main (utid 1) or RenderThread (utid 2); ts/dur in ns. */
  running(utid: number, cpu: number, ts: number, dur: number): void {
    this.db.prepare(`INSERT INTO thread_state VALUES (NULL,?,?,?,'Running',?,?,NULL,NULL,NULL,NULL)`)
      .run(utid, ts, dur, cpu, cpu);
  }

  /** A CPU frequency span in kHz; ts/dur in ns. */
  frequency(cpu: number, ts: number, dur: number, khz: number): void {
    this.db.prepare('INSERT INTO cpu_frequency_counters VALUES (NULL,?,?,?,?,?,?)').run(500 + cpu, cpu, cpu, ts, dur, khz);
  }

  maxTrack(policy: number): number { return this.cpuTrack(policy, 'cpu_max_frequency_limit'); }
  minTrack(policy: number): number { return this.cpuTrack(policy, 'cpu_min_frequency_limit'); }

  private cpuTrack(policy: number, type: string): number {
    const id = this.nextTrack++;
    this.db.prepare('INSERT INTO cpu_counter_track VALUES (?,?,?,?)').run(id, policy, type, `Cpu ${policy} ${type}`);
    return id;
  }

  cooling(name: string): number {
    const id = 100 + this.nextTrack++;
    this.db.prepare('INSERT INTO counter_track VALUES (?,?,?,?)').run(id, 'cooling_device_counter', `${name} Cooling Device`, id);
    this.db.prepare('INSERT INTO args VALUES (?,?,?)').run(id, 'linux_device', name);
    return id;
  }

  temperature(zone: string, samples: Array<[number, number]>): void {
    const id = 100 + this.nextTrack++;
    this.db.prepare('INSERT INTO counter_track VALUES (?,?,?,?)').run(id, 'thermal_temperature', `${zone} Temperature`, null);
    for (const [ts, v] of samples) this.put(id, ts, v);
  }

  /** Counter sample; `ts` in ns, value in kHz (limits) or state (cooling). */
  put(track: number, ts: number, value: number): void {
    this.db.prepare('INSERT INTO counter VALUES (?,?,?,?)').run(this.nextCounter++, track, ts, value);
  }

  daemonRun(ts: number, dur: number): void {
    const utid = this.nextUtid++;
    this.db.prepare('INSERT OR IGNORE INTO process VALUES (?,?,?,?)').run(50, 5000, '/vendor/bin/thermal-engine-v2', 1000);
    this.db.prepare('INSERT INTO thread VALUES (?,?,?,?,?)').run(utid, 50, 5000 + utid, 'thermal-engine', 0);
    this.db.prepare('INSERT INTO sched_slice VALUES (NULL,?,?,?,0,0,?,120)').run(utid, ts, dur, 'S');
  }

  /**
   * Ties `cdev` to the policy of `limitTrack` by timing alone: `count`
   * transitions, each followed 100 us later by a concordant limit change that
   * stays uncapped (2400 <-> 2300 MHz against a 2400 MHz reference).
   * Leaves the cooling device at state 0 and the limit at 2400 MHz.
   */
  tie(cdev: number, limitTrack: number, startMs: number, count = 4): void {
    this.put(cdev, startMs * MS, 0);
    for (let i = 1; i <= count; i++) {
      const t = (startMs + i * 100) * MS;
      const up = i % 2 === 1;
      this.put(cdev, t, up ? 1 : 0);
      this.put(limitTrack, t + 100_000, up ? 2_300_000 : 2_400_000);
    }
    if (count % 2 === 1) {
      const t = (startMs + (count + 1) * 100) * MS;
      this.put(cdev, t, 0);
      this.put(limitTrack, t + 100_000, 2_400_000);
    }
  }

  close(): void { this.db.close(); }
}

const ONSETS = `SELECT onset_ts, limit_khz, direction, direction_basis, onset_verdict, trigger_class,
  trigger_class_rank, cooling_basis, trace_episode_id FROM system_cpu_freq_limit_onset_verdicts ORDER BY onset_ts`;
const ASSOC = `SELECT cdev_name, transition_count, association_status, associated_policy_cpu
  FROM thermal_cdev_policy_association ORDER BY cdev_name`;
const TRACE = 'SELECT * FROM system_cpu_freq_limit_trace_summary';
const WINDOW = 'SELECT * FROM system_cpu_freq_limit_window_summary ORDER BY window_id';
const onsetAt = (rows: any[], ts: number) => rows.find(r => r.onset_ts === ts);

/** Policy 0 at 2400 MHz from 10 ms, tied cooling device D calibrated at 100-500 ms. */
function tiedPolicy(): {f: Fixture; limit: number; d: number} {
  const f = new Fixture();
  const limit = f.maxTrack(0);
  f.put(limit, 10 * MS, 2_400_000);
  const d = f.cooling('thermal-cpufreq-0');
  f.tie(d, limit, 100);
  return {f, limit, d};
}

describe('shared frequency-limit verdict layer (SQLite fixtures)', () => {
  describe('forward-only pairing (R-order)', () => {
    it.each([
      ['exactly equal timestamps', 0, 'thermal_cooling_device_confirmed', 'limit_set_by_paired_policy_cooling_transition'],
      ['cooling 0.8 ms before the limit', -800_000, 'thermal_cooling_device_confirmed', 'limit_set_by_paired_policy_cooling_transition'],
      ['cooling 1.2 ms before the limit', -1_200_000, 'policy_cooling_active_background', 'policy_cooling_not_paired_with_this_onset'],
      ['cooling 0.3 ms after the limit', 300_000, 'policy_cooling_active_background', 'cooling_follows_limit_change'],
    ])('%s', (_label, coolingOffset, verdict, basis) => {
      const {f, limit, d} = tiedPolicy();
      try {
        const onset = 2000 * MS;
        f.put(d, onset + coolingOffset, 2);
        f.put(limit, onset, 1_800_000);
        expect(verdictQuery(f.db, ASSOC)[0]).toMatchObject({association_status: 'paired_with_policy_limit_changes', associated_policy_cpu: 0});
        expect(onsetAt(verdictQuery(f.db, ONSETS), onset)).toMatchObject({direction: 'tightened', onset_verdict: verdict, cooling_basis: basis});
        const confirmed = verdict === 'thermal_cooling_device_confirmed';
        expect(verdictQuery(f.db, TRACE)[0].freq_limit_classification)
          .toBe(confirmed ? 'THERMAL_LIMIT_CONFIRMED' : 'THERMAL_COOLING_BACKGROUND');
      } finally { f.close(); }
    });

    it('a discordant forward pair (cooling relaxes while the limit tightens) is never confirmation', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(d, 1000 * MS, 2);
        f.put(d, 2000 * MS, 1);
        f.put(limit, 2000 * MS + 200_000, 1_800_000);
        expect(verdictQuery(f.db, ASSOC)[0].association_status).toBe('paired_with_policy_limit_changes');
        expect(onsetAt(verdictQuery(f.db, ONSETS), 2000 * MS + 200_000)).toMatchObject({
          cooling_basis: 'discordant_cooling_pair', trigger_class: 'THERMAL_COOLING_BACKGROUND'});
      } finally { f.close(); }
    });
  });

  describe('cooling-device to policy association (R1/R1\')', () => {
    it('ties by timing, never by name, and keeps ambiguity, splits and short series out', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        const p4 = f.maxTrack(4);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p4, 10 * MS, 2_400_000);
        // Named for policy 6, but its transitions are followed by policy 0 only.
        f.tie(f.cooling('thermal-cpufreq-6'), p0, 100);
        // Every transition is followed by BOTH policies' changes.
        const both = f.cooling('both');
        f.put(both, 1000 * MS, 0);
        for (let i = 1; i <= 4; i++) {
          const t = (1000 + i * 100) * MS;
          f.put(both, t, i % 2);
          f.put(p0, t + 100_000, i % 2 ? 2_300_000 : 2_400_000);
          f.put(p4, t + 200_000, i % 2 ? 2_300_000 : 2_400_000);
        }
        // Half of the transitions go with each policy.
        const split = f.cooling('split');
        f.put(split, 2000 * MS, 0);
        for (let i = 1; i <= 4; i++) {
          const t = (2000 + i * 100) * MS;
          f.put(split, t, i % 2);
          f.put(i <= 2 ? p0 : p4, t + 100_000, i % 2 ? 2_300_000 : 2_400_000);
        }
        f.put(p0, 2900 * MS, 2_400_000);
        f.put(p4, 2900 * MS, 2_400_000);
        // Only two transitions, both paired.
        const short = f.cooling('short');
        f.put(short, 3000 * MS, 0);
        f.put(short, 3100 * MS, 1);
        f.put(p0, 3100 * MS + 100_000, 2_300_000);
        f.put(short, 3200 * MS, 0);
        f.put(p0, 3200 * MS + 100_000, 2_400_000);

        const rows = Object.fromEntries(verdictQuery(f.db, ASSOC).map(r => [r.cdev_name, r]));
        expect(rows['thermal-cpufreq-6']).toMatchObject({association_status: 'paired_with_policy_limit_changes', associated_policy_cpu: 0});
        expect(rows.both).toMatchObject({association_status: 'ambiguous_multiple_policies', associated_policy_cpu: null});
        expect(rows.split).toMatchObject({association_status: 'no_policy_limit_pairing', associated_policy_cpu: null});
        expect(rows.short).toMatchObject({association_status: 'insufficient_transitions', transition_count: 2});
      } finally { f.close(); }
    });

    it('counts a burst of limit updates after one transition once (distinct transitions)', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        const burst = f.cooling('burst');
        f.put(burst, 1000 * MS, 0);
        f.put(burst, 2000 * MS, 1);
        [2_300_000, 2_200_000, 2_300_000, 2_200_000, 2_300_000]
          .forEach((v, i) => f.put(p0, 2000 * MS + (i + 1) * 100_000, v));
        f.put(burst, 3000 * MS, 0);
        f.put(burst, 4000 * MS, 1);
        expect(verdictQuery(f.db, ASSOC)[0]).toMatchObject({
          transition_count: 3, association_status: 'no_policy_limit_pairing'});
      } finally { f.close(); }
    });
  });

  describe('value onsets and episodes', () => {
    it('a relaxation is never rank 1, keeps its own value, and never upgrades the session', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(limit, 2000 * MS, 1_800_000); // unpaired tightening
        f.put(d, 2200 * MS, 2);
        f.put(d, 2500 * MS, 1); // cooling decrease ...
        f.put(limit, 2500 * MS + 100_000, 1_900_000); // ... paired with a capped relaxation
        const onsets = verdictQuery(f.db, ONSETS);
        expect(onsetAt(onsets, 2500 * MS + 100_000)).toMatchObject({direction: 'relaxed',
          onset_verdict: 'limit_relaxed', trigger_class: 'LIMIT_RELAXED', cooling_basis: 'cap_value_set_by_relaxation'});
        expect(onsets.some(o => o.trigger_class_rank === 1)).toBe(false);
        expect(verdictQuery(f.db, TRACE)[0].freq_limit_classification).not.toBe('THERMAL_LIMIT_CONFIRMED');
      } finally { f.close(); }
    });

    it('a confirmed tightening followed by a relaxation reads as a mix, each value with its own verdict', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(d, 2000 * MS, 2);
        f.put(limit, 2000 * MS + 100_000, 1_800_000);
        f.put(d, 2500 * MS, 1);
        f.put(limit, 2500 * MS + 100_000, 1_900_000);
        const onsets = verdictQuery(f.db, ONSETS);
        expect(onsets.map(o => [o.limit_khz, o.cooling_basis])).toEqual([
          [1_800_000, 'limit_set_by_paired_policy_cooling_transition'],
          [1_900_000, 'cap_value_set_by_relaxation'],
        ]);
        expect(verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_episode_verdicts')[0]).toMatchObject({
          trigger_class: 'THERMAL_LIMIT_CONFIRMED', episode_verdict: 'thermal_cooling_device_confirmed',
          onset_trigger_mix: 'THERMAL_LIMIT_CONFIRMED:1,LIMIT_RELAXED:1', confirmed_onset_count: 1, causal_onset_count: 1});
      } finally { f.close(); }
    });

    it('a same-value re-write (min-only boost) is not an onset', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 1000 * MS, 1_800_000);
        f.put(p0, 1200 * MS, 1_800_000);
        const events = verdictQuery(f.db, `SELECT ts, direction, is_value_onset, value_onset_ts
          FROM system_cpu_freq_limit_max_events ORDER BY ts`);
        expect(events[2]).toMatchObject({ts: 1200 * MS, direction: 'unchanged', is_value_onset: 0, value_onset_ts: 1000 * MS});
        expect(verdictQuery(f.db, ONSETS).map(o => o.onset_ts)).toEqual([1000 * MS]);
      } finally { f.close(); }
    });

    it('merges across a short uncapped gap into one trace episode; the restoration is an event, not a verdict', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 1000 * MS, 1_800_000);
        f.put(p0, 1200 * MS, 2_400_000);
        f.put(p0, 1500 * MS, 1_800_000);
        f.put(p0, 3000 * MS, 2_400_000);
        expect(verdictQuery(f.db, 'SELECT trace_episode_id, onset_ts, end_ts FROM system_cpu_freq_limit_trace_episodes'))
          .toEqual([{trace_episode_id: 'policy0-tep1', onset_ts: 1000 * MS, end_ts: 3000 * MS}]);
        const restore = verdictQuery(f.db, `SELECT direction, in_episode, trace_episode_id
          FROM system_cpu_freq_limit_max_events WHERE ts = ${1200 * MS}`)[0];
        expect(restore).toEqual({direction: 'relaxed', in_episode: 0, trace_episode_id: null});
        expect(verdictQuery(f.db, ONSETS).map(o => o.onset_ts)).toEqual([1000 * MS, 1500 * MS]);
      } finally { f.close(); }
    });

    it('treats a zero sample as invalid and the value after it as an unobserved onset (2400 -> 0 -> 1800)', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 1000 * MS, 0);
        f.put(p0, 1500 * MS, 1_800_000);
        const events = verdictQuery(f.db, `SELECT ts, limit_value_valid, direction, direction_basis, is_capped
          FROM system_cpu_freq_limit_max_events ORDER BY ts`);
        expect(events[1]).toMatchObject({limit_value_valid: 0, direction: 'unknown', direction_basis: 'invalid_limit_sample', is_capped: 0});
        expect(events[2]).toMatchObject({direction: 'unknown', direction_basis: 'onset_after_invalid_sample', is_capped: 1});
        expect(verdictQuery(f.db, ONSETS)).toEqual([expect.objectContaining({onset_ts: 1500 * MS,
          onset_verdict: 'onset_after_invalid_sample', trigger_class: 'LIMIT_ONSET_UNKNOWN', trigger_class_rank: 5,
          cooling_basis: 'onset_after_invalid_sample'})]);
        expect(verdictQuery(f.db, 'SELECT reference_max_limit_khz FROM system_cpu_freq_limit_reference')[0])
          .toEqual({reference_max_limit_khz: 2_400_000});
        expect(verdictQuery(f.db, 'SELECT onset_observed FROM system_cpu_freq_limit_trace_episodes')[0].onset_observed).toBe(0);
      } finally { f.close(); }
    });

    it('a contiguous 2400 -> 1800 change is a tightening with an observed onset', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 1500 * MS, 1_800_000);
        expect(verdictQuery(f.db, ONSETS)[0]).toMatchObject({direction: 'tightened',
          onset_verdict: 'thermal_evidence_not_captured', trigger_class: 'THERMAL_EVIDENCE_NOT_CAPTURED'});
        expect(verdictQuery(f.db, 'SELECT onset_observed FROM system_cpu_freq_limit_trace_episodes')[0].onset_observed).toBe(1);
      } finally { f.close(); }
    });

    it('maps every window episode to exactly one trace episode', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 1000 * MS, 1_800_000);
        f.put(p0, 1200 * MS, 2_400_000);
        f.put(p0, 1500 * MS, 1_800_000);
        f.put(p0, 4000 * MS, 2_400_000);
        f.put(p0, 6000 * MS, 1_800_000);
        const rows = verdictQuery(f.db,
          'SELECT window_id, episode_id, trace_episode_id FROM system_cpu_freq_limit_episodes ORDER BY window_id, episode_id',
          [[0, 0, 10_000 * MS], [1, 1100 * MS, 7000 * MS]]);
        expect(rows).toEqual([
          {window_id: 0, episode_id: 'policy0-ep1', trace_episode_id: 'policy0-tep1'},
          {window_id: 0, episode_id: 'policy0-ep2', trace_episode_id: 'policy0-tep2'},
          {window_id: 1, episode_id: 'policy0-ep1', trace_episode_id: 'policy0-tep1'},
          {window_id: 1, episode_id: 'policy0-ep2', trace_episode_id: 'policy0-tep2'},
        ]);
      } finally { f.close(); }
    });
  });

  describe('onset ladder (R6\')', () => {
    it('a clipped window keeps the true onset: confirmed, with onset_ts before the window', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(d, 2000 * MS, 2);
        f.put(limit, 2000 * MS + 100_000, 1_800_000);
        const windowRows = verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_episode_verdicts',
          [[0, 2300 * MS, 3000 * MS]]);
        expect(windowRows[0]).toMatchObject({episode_start_ts: 2300 * MS, onset_ts: 2000 * MS + 100_000,
          onset_observed: 1, trigger_class: 'THERMAL_LIMIT_CONFIRMED'});
      } finally { f.close(); }
    });

    it('a tied transition near the window start but not near the onset is not confirmation', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(limit, 2000 * MS, 1_800_000);
        f.put(d, 2320 * MS, 1);
        const row = verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_episode_verdicts', [[0, 2300 * MS, 3000 * MS]])[0];
        expect(row.onset_ts).toBe(2000 * MS);
        expect(row.trigger_class).not.toBe('THERMAL_LIMIT_CONFIRMED');
        expect(row.trigger_class).toBe('THERMAL_COOLING_BACKGROUND');
      } finally { f.close(); }
    });

    it('a tied device already active when a plain limit write lands is background, not confirmation', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(d, 1500 * MS, 2);
        f.put(limit, 2000 * MS, 1_800_000);
        expect(verdictQuery(f.db, ONSETS)[0]).toMatchObject({onset_verdict: 'policy_cooling_active_background',
          trigger_class_rank: 3, cooling_basis: 'policy_cooling_active_limit_set_elsewhere'});
      } finally { f.close(); }
    });

    it('an unobservable onset stays unknown even while a tied device is active', () => {
      const f = new Fixture();
      try {
        const limit = f.maxTrack(0);
        f.put(limit, 10 * MS, 1_800_000); // first sample already capped
        const d = f.cooling('thermal-cpufreq-0');
        f.put(d, 5 * MS, 2);
        f.put(limit, 1000 * MS, 2_400_000);
        f.tie(d, limit, 1100);
        expect(verdictQuery(f.db, ASSOC)[0].association_status).toBe('paired_with_policy_limit_changes');
        expect(verdictQuery(f.db, ONSETS)[0]).toMatchObject({onset_ts: 10 * MS,
          onset_verdict: 'onset_unknown_capped_at_data_start', trigger_class: 'LIMIT_ONSET_UNKNOWN'});
      } finally { f.close(); }
    });

    it('only an untied cooling device active reads as unassociated (policy-9-like episode)', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        const p4 = f.maxTrack(4);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p4, 10 * MS, 2_400_000);
        const d = f.cooling('thermal-cpufreq-2');
        f.tie(d, p4, 100);
        f.put(p0, 800 * MS, 1_900_000);
        f.put(d, 1500 * MS, 2);
        f.put(p4, 1500 * MS, 2_000_000);
        f.put(p0, 2300 * MS, 2_400_000);
        expect(verdictQuery(f.db, ASSOC)[0]).toMatchObject({associated_policy_cpu: 4});
        expect(onsetAt(verdictQuery(f.db, ONSETS), 800 * MS)).toMatchObject({
          onset_verdict: 'cooling_activity_policy_unassociated', trigger_class: 'THERMAL_COOLING_UNASSOCIATED',
          cooling_basis: 'cooling_unassociated_with_policy'});
        expect(onsetAt(verdictQuery(f.db, ONSETS), 1500 * MS).trigger_class).toBe('THERMAL_LIMIT_CONFIRMED');
      } finally { f.close(); }
    });

    it.each([
      ['temperature only', (f: Fixture) => f.temperature('cpu', [[500 * MS, 70_000], [1900 * MS, 80_000]]), 'THERMAL_EVIDENCE_NOT_CAPTURED'],
      ['daemon ran 1 s before, no cooling tracks', (f: Fixture) => f.daemonRun(1000 * MS, 3 * MS), 'THERMAL_DAEMON_SUSPECTED'],
      ['daemon ran 3 s before, no cooling tracks', (f: Fixture) => f.daemonRun(1 * MS, 3 * MS), 'THERMAL_EVIDENCE_NOT_CAPTURED'],
      ['cooling track that never transitions', (f: Fixture) => {
        const c = f.cooling('thermal-cpufreq-0');
        f.put(c, 5 * MS, 0);
        f.put(c, 3000 * MS, 0);
      }, 'THERMAL_EVIDENCE_NOT_CAPTURED'],
      ['cooling transitions captured but unrelated in time', (f: Fixture) => {
        const c = f.cooling('thermal-gpufreq-0');
        f.put(c, 5 * MS, 1);
        f.put(c, 100 * MS, 0);
      }, 'NO_THERMAL_EVIDENCE_OBSERVED'],
    ])('coverage: %s', (_label, setup, expected) => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 3000 * MS, 1_800_000);
        setup(f);
        expect(verdictQuery(f.db, TRACE)[0].freq_limit_classification).toBe(expected);
      } finally { f.close(); }
    });
  });

  describe('ranks and scopes (R-rank, R-window)', () => {
    function rankFixture(extra: (f: Fixture, limit: number) => void): Fixture {
      const f = new Fixture();
      const limit = f.maxTrack(0);
      f.put(limit, 10 * MS, 1_800_000); // capped from the first sample: onset unknown
      f.put(limit, 1000 * MS, 2_400_000);
      extra(f, limit);
      return f;
    }

    it('unknown onset alone -> LIMIT_ONSET_UNKNOWN, never a non-thermal verdict', () => {
      const f = rankFixture(() => {});
      try {
        expect(verdictQuery(f.db, TRACE)[0]).toMatchObject({freq_limit_classification: 'LIMIT_ONSET_UNKNOWN',
          onset_trigger_mix: 'LIMIT_ONSET_UNKNOWN:1'});
      } finally { f.close(); }
    });

    it('unknown + no evidence -> LIMIT_ONSET_UNKNOWN (no causal claim either way)', () => {
      const f = rankFixture((fx, limit) => {
        const c = fx.cooling('thermal-gpufreq-0');
        fx.put(c, 5 * MS, 1);
        fx.put(c, 100 * MS, 0);
        fx.put(limit, 2000 * MS, 1_800_000);
      });
      try {
        expect(verdictQuery(f.db, TRACE)[0]).toMatchObject({freq_limit_classification: 'LIMIT_ONSET_UNKNOWN',
          onset_trigger_mix: 'LIMIT_ONSET_UNKNOWN:1,NO_THERMAL_EVIDENCE_OBSERVED:1'});
      } finally { f.close(); }
    });

    it('unknown + confirmed -> THERMAL_LIMIT_CONFIRMED with the mix visible', () => {
      const f = rankFixture((fx, limit) => {
        const d = fx.cooling('thermal-cpufreq-0');
        fx.tie(d, limit, 1100);
        fx.put(d, 3000 * MS, 2);
        fx.put(limit, 3000 * MS + 100_000, 1_800_000);
      });
      try {
        expect(verdictQuery(f.db, TRACE)[0]).toMatchObject({freq_limit_classification: 'THERMAL_LIMIT_CONFIRMED',
          onset_trigger_mix: 'THERMAL_LIMIT_CONFIRMED:1,LIMIT_ONSET_UNKNOWN:1', classification_scope: 'trace_wide'});
      } finally { f.close(); }
    });

    function mixedEpisode(): Fixture {
      const {f, limit, d} = tiedPolicy();
      f.put(limit, 1000 * MS, 1_800_000); // unpaired first onset
      f.put(d, 1600 * MS, 2);
      f.put(limit, 1600 * MS, 1_500_000); // paired tightening later in the same episode
      return f;
    }

    it('a window before the paired onset never cites it; the trace-wide summary does', () => {
      const f = mixedEpisode();
      try {
        const windows: Window[] = [[0, 900 * MS, 1100 * MS], [1, 1200 * MS, 1300 * MS]];
        const rows = verdictQuery(f.db, WINDOW, windows);
        expect(rows[0]).toMatchObject({freq_limit_classification: 'NO_THERMAL_EVIDENCE_OBSERVED',
          onset_trigger_mix: 'NO_THERMAL_EVIDENCE_OBSERVED:1', classification_scope: 'window_scoped'});
        // The onset before window 1 set the value still in force at its start.
        expect(rows[1]).toMatchObject({freq_limit_classification: 'NO_THERMAL_EVIDENCE_OBSERVED', onset_count: 1});
        expect(verdictQuery(f.db, TRACE, windows)[0]).toMatchObject({freq_limit_classification: 'THERMAL_LIMIT_CONFIRMED',
          onset_trigger_mix: 'THERMAL_LIMIT_CONFIRMED:1,NO_THERMAL_EVIDENCE_OBSERVED:1'});
      } finally { f.close(); }
    });

    it('episode detail and the shared episode verdict agree on a mixed episode', () => {
      const f = mixedEpisode();
      try {
        const shared = verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_episode_verdicts')[0];
        expect(shared).toMatchObject({trace_episode_id: 'policy0-tep1', trigger_class: 'THERMAL_LIMIT_CONFIRMED',
          onset_trigger_mix: 'THERMAL_LIMIT_CONFIRMED:1,NO_THERMAL_EVIDENCE_OBSERVED:1', confirmed_onset_count: 1, causal_onset_count: 2});
        const params = {trace_episode_id: 'policy0-tep1', policy_cpu: 0, episode_start_ts: shared.onset_ts,
          episode_end_ts: shared.episode_end_ts, window_start_ts: 0, window_end_ts: 10_000 * MS};
        const detail = stepQuery(f.db, 'composite/cpu_frequency_limit_episode.skill.yaml', 'who_verdict', params)[0];
        expect(detail).toMatchObject({who_verdict: shared.episode_verdict, trigger_class: shared.trigger_class,
          onset_trigger_mix: shared.onset_trigger_mix, onset_count: 2, confirmed_onset_count: 1});
        const onsets = stepQuery(f.db, 'composite/cpu_frequency_limit_episode.skill.yaml', 'limit_onsets',
          {...params, 'who_verdict.data[0].episode_id': detail.episode_id});
        expect(onsets.map(o => o.trigger_class)).toEqual(['NO_THERMAL_EVIDENCE_OBSERVED', 'THERMAL_LIMIT_CONFIRMED']);

        const summary = stepQuery(f.db, 'composite/cpu_frequency_limit_attribution.skill.yaml', 'attribution_summary', {
          'analysis_window.data[0].window_start_ts': 0, 'analysis_window.data[0].window_end_ts': 10_000 * MS,
          'episode_rows[0].before_start_ts': 0, 'episode_rows[0].before_end_ts': shared.onset_ts,
          'episode_rows[0].episode_id': 'policy0-ep1'})[0];
        expect(summary).toMatchObject({classification: 'THERMAL_LIMIT_CONFIRMED', onset_trigger_mix: shared.onset_trigger_mix,
          cooling_confirmed_episodes: 1, tied_cooling_devices: 1});
        // With the same window, a detail that only sees the unpaired value says so.
        const early = stepQuery(f.db, 'composite/cpu_frequency_limit_episode.skill.yaml', 'who_verdict',
          {...params, window_start_ts: 900 * MS, window_end_ts: 1100 * MS})[0];
        expect(early.trigger_class).toBe('NO_THERMAL_EVIDENCE_OBSERVED');
      } finally { f.close(); }
    });
  });

  describe('parent drill-down resolves the same episode under non-default thresholds', () => {
    // The child rebuilds the shared fragments from its own parameters, and
    // trace_episode_id numbers episodes under episode_drop_pct/merge_gap_ms.
    // A 6 % drop is an episode only below the default 10 %, so a child that
    // fell back to the defaults would renumber and cite the wrong episode.
    it('passes every threshold the episode numbering depends on to cpu_frequency_limit_episode', () => {
      const {f, limit, d} = tiedPolicy();
      f.daemonRun(995 * MS, 10 * MS);
      f.put(limit, 1000 * MS, 2_256_000);
      f.put(limit, 1500 * MS, 2_400_000);
      f.put(d, 3000 * MS, 1);
      f.put(limit, 3000 * MS + 100_000, 1_800_000);
      f.put(d, 3500 * MS, 0);
      f.put(limit, 3500 * MS + 100_000, 2_400_000);
      const parentParams = {episode_drop_pct: 5, merge_gap_ms: 500, max_episodes: 3,
        'analysis_window.data[0].window_start_ts': 0, 'analysis_window.data[0].window_end_ts': 10_000 * MS};
      const parent = 'composite/cpu_frequency_limit_attribution.skill.yaml';
      const rows = stepQuery(f.db, parent, 'episodes', parentParams)
        .sort((a, b) => Number(a.onset_ts) - Number(b.onset_ts));
      expect(rows).toHaveLength(2);
      const itemParams: Record<string, string> = findStep(loadSkill(parent), 'episode_drilldown').item_params;
      const classes = rows.map(row => {
        const params: Record<string, string | number> = {};
        for (const [param, column] of Object.entries(itemParams)) {
          if (row[column] !== null && row[column] !== undefined) params[param] = row[column];
        }
        const child = stepQuery(f.db, 'composite/cpu_frequency_limit_episode.skill.yaml', 'who_verdict', params);
        expect(child).toHaveLength(1);
        expect(child[0].trace_episode_id).toBe(row.trace_episode_id);
        return child[0];
      });
      expect(classes[0].trigger_class_rank).not.toBe(1);
      expect(classes[1].trigger_class).toBe('THERMAL_LIMIT_CONFIRMED');
      f.close();
    });
  });

  describe('window cooling-device count', () => {
    it('counts distinct devices tied to the policies a window touches, each policy once', () => {
      const f = new Fixture();
      const big = f.maxTrack(0);
      const mid = f.maxTrack(4);
      f.put(big, 10 * MS, 2_400_000);
      f.put(mid, 10 * MS, 2_400_000);
      f.tie(f.cooling('thermal-cpufreq-0'), big, 100);
      f.tie(f.cooling('thermal-cpufreq-1'), mid, 700);
      for (const [track, start] of [[big, 2000], [mid, 3000], [big, 5000]] as const) {
        f.put(track, start * MS, 1_800_000);
        f.put(track, (start + 500) * MS, 2_400_000);
      }
      const [window] = verdictQuery(f.db, WINDOW);
      expect(window.policy_count).toBe(2);
      expect(window.episode_count).toBe(3);
      expect(window.tied_cooling_device_count).toBe(2);
      f.close();
    });
  });

  describe('limit data availability in every consumer (R-maxsamples, R-consumers)', () => {
    const variants: Array<[string, (f: Fixture) => void, number, string | null]> = [
      ['min-only capture', f => { const t = f.minTrack(0); f.put(t, 10 * MS, 500_000); }, 0, 'max_limit_not_captured'],
      ['empty max track', f => { f.maxTrack(0); }, 0, 'max_limit_samples_missing'],
      ['invalid-only max samples', f => { const t = f.maxTrack(0); f.put(t, 10 * MS, 0); f.put(t, 20 * MS, -1); }, 0, 'max_limit_samples_missing'],
      ['one valid max sample', f => { const t = f.maxTrack(0); f.put(t, 10 * MS, 2_400_000); }, 1, null],
    ];

    it.each(variants)('%s', (_label, setup, hasMax, reason) => {
      const f = new Fixture();
      try {
        setup(f);
        expect(stepQuery(f.db, 'composite/cpu_frequency_limit_attribution.skill.yaml', 'data_check')[0])
          .toMatchObject({has_max_limit_data: hasMax, limit_evidence_missing_reason: reason});
        expect(stepQuery(f.db, 'composite/thermal_throttling.skill.yaml', 'data_check')[0])
          .toMatchObject({has_max_limit_data: hasMax, limit_evidence_missing_reason: reason});
        expect(stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_data_check')[0])
          .toMatchObject({has_max_limit_data: hasMax, limit_evidence_missing_reason: reason});
        const throttling = stepQuery(f.db, 'atomic/cpu_throttling_in_range.skill.yaml', 'limit_evidence',
          {start_ts: 0, end_ts: 10_000 * MS})[0];
        expect(throttling).toMatchObject({has_max_limit_data: hasMax,
          evidence_status: hasMax ? 'no_limit_episode_in_range' : 'limit_track_unavailable'});
        if (!hasMax) {
          expect(stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_unavailable')[0])
            .toMatchObject({limit_classification: 'LIMIT_EVIDENCE_MISSING', limit_evidence_missing_reason: reason});
          expect(stepQuery(f.db, 'composite/cpu_frequency_limit_attribution.skill.yaml', 'no_limit_capture_advice')[0])
            .toMatchObject({classification: 'LIMIT_EVIDENCE_MISSING', limit_evidence_missing_reason: reason});
          expect(verdictQuery(f.db, TRACE)[0]).toMatchObject({freq_limit_classification: 'LIMIT_EVIDENCE_MISSING',
            limit_evidence_missing_reason: reason});
        } else {
          expect(verdictQuery(f.db, TRACE)[0].freq_limit_classification).toBe('NO_LIMIT_EPISODE');
        }
      } finally { f.close(); }
    });
  });

  describe('cpu_freq_limit_timeline reads the shared events (R-events, R-timeline-entry)', () => {
    it('lists the invalid sample and the unknown-direction value after it; aggregates skip the invalid span', () => {
      const f = new Fixture();
      try {
        const p0 = f.maxTrack(0);
        f.put(p0, 10 * MS, 2_400_000);
        f.put(p0, 1000 * MS, 0);
        f.put(p0, 1500 * MS, 1_800_000);
        const events = stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_events');
        expect(events.map(e => [e.limit_khz, e.direction, e.direction_basis, e.limit_value_valid])).toEqual([
          [2_400_000, 'unknown', 'first_observed_sample', 1],
          [0, 'unknown', 'invalid_limit_sample', 0],
          [1_800_000, 'unknown', 'onset_after_invalid_sample', 1],
        ]);
        const summary = stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_summary')
          .find(r => r.kind === 'max');
        expect(summary).toMatchObject({min_limit_khz: 1_800_000, max_limit_khz: 2_400_000, sample_count: 2,
          invalid_sample_count: 1, invalid_limit_ns: 500 * MS, data_quality_note: 'invalid_limit_samples_excluded_from_aggregates'});
        expect(summary.limit_covered_ns).toBe((10_000 - 10 - 500) * MS);
        // A valid-only trace keeps its aggregates unchanged.
        f.db.prepare('DELETE FROM counter WHERE value = 0').run();
        expect(stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_summary')
          .find(r => r.kind === 'max')).toMatchObject({invalid_sample_count: 0, limit_covered_ns: (10_000 - 10) * MS,
          data_quality_note: 'all_samples_valid'});
      } finally { f.close(); }
    });

    it('min-only: gate 1 reports max_limit_not_captured while limit_events lists the floor facts', () => {
      const f = new Fixture();
      try {
        const m = f.minTrack(0);
        f.put(m, 10 * MS, 500_000);
        f.put(m, 1000 * MS, 0);
        f.put(m, 1500 * MS, 600_000);
        f.put(m, 2000 * MS, 700_000);
        const check = stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_data_check')[0];
        expect(check).toMatchObject({has_max_limit_data: 0, has_any_limit_sample: 1, limit_evidence_missing_reason: 'max_limit_not_captured'});
        const events = stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_events');
        expect(events.map(e => [e.kind, e.direction, e.event_role])).toEqual([
          ['min', 'unknown', 'non_trigger_fact'],
          ['min', 'unknown', 'non_trigger_fact'],
          ['min', 'unknown', 'non_trigger_fact'],
          ['min', 'floor_raised', 'non_trigger_fact'],
        ]);
      } finally { f.close(); }
    });

    it('invalid-only max samples are still listed as data-quality events', () => {
      const f = new Fixture();
      try {
        const t = f.maxTrack(0);
        f.put(t, 10 * MS, 0);
        f.put(t, 20 * MS, 0);
        expect(stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_data_check')[0])
          .toMatchObject({has_max_limit_data: 0, has_any_limit_sample: 1, limit_evidence_missing_reason: 'max_limit_samples_missing'});
        expect(stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_events')
          .map(e => e.direction_basis)).toEqual(['invalid_limit_sample', 'invalid_limit_sample']);
      } finally { f.close(); }
    });
  });

  describe('thermal_throttling counts only rank-1 episodes', () => {
    it('a background-only cooling device is not THERMAL_LIMIT_CONFIRMED', () => {
      const {f, limit, d} = tiedPolicy();
      try {
        f.put(d, 1500 * MS, 2);
        f.put(limit, 2000 * MS, 1_800_000);
        const row = stepQuery(f.db, 'composite/thermal_throttling.skill.yaml', 'direct_limit_evidence')[0];
        expect(row).toMatchObject({episode_count: 1, cooling_confirmed_episodes: 0, has_cdev_data: 1, is_confirmed: 0,
          freq_limit_classification: 'THERMAL_COOLING_BACKGROUND', thermal_throttling_evidence: 'limit_observed_cause_unverified'});
      } finally { f.close(); }
    });
  });
});

const FRAME_FRAGMENTS = ['system_sched_spans', 'system_thread_state_spans', 'system_cpu_frequency_spans',
  ...VERDICT_FRAGMENTS.map(name => name.replace(/\.sql$/, '')).filter(name => name !== 'system_sched_spans'),
  'system_cpu_freq_limit_frame_binding'].map(name => `${name}.sql`);

/**
 * One frame window 'f' over the fixture app's threads: RenderThread (utid 2)
 * has role render, every other thread of upid 1 role main. A main work interval
 * belongs to the top slice's thread (utid 1 unless given), a render interval
 * to every render thread, as scrolling_analysis defines them. Rows keyed by role.
 */
function frameBinding(db: Database.Database, work: Array<['main' | 'render', number, number, number?]>,
  window: [number, number] = [0, 10_000 * MS], numbers: Record<string, number> = {}): Record<string, any> {
  const leadingCtes = [
    `system_windows AS (SELECT 'f' AS window_id, ${window[0]} AS window_start_ts, ${window[1]} AS window_end_ts)`,
    `system_target_threads AS (SELECT 'f' AS window_id, upid, utid,
      CASE name WHEN 'RenderThread' THEN 'render' ELSE 'main' END AS role FROM thread WHERE upid = 1)`,
    `system_work_intervals AS (${work.map(([role, start, end, utid]) =>
      `SELECT 'f' AS window_id, '${role}' AS role, ${utid ?? (role === 'main' ? 1 : 'NULL')} AS utid,
        ${start} AS work_start_ts, ${end} AS work_end_ts`).join(' UNION ALL ')})`,
  ];
  const rows = db.prepare(composeFragmentSql({leadingCtes, fragments: FRAME_FRAGMENTS, numbers,
    select: 'SELECT * FROM system_cpu_freq_limit_frame_binding'})).all() as any[];
  return Object.fromEntries(rows.map(row => [row.role, row]));
}

/**
 * Policy 6 (cluster 2 = CPUs 6 and 7) tied to its cooling device, capped from
 * 2000 ms at 1800 MHz by a forward-paired tightening (confirmed).
 */
function confirmedCapOnPolicy6(): {f: Fixture; limit: number; d: number} {
  const f = new Fixture();
  const limit = f.maxTrack(6);
  f.put(limit, 10 * MS, 2_400_000);
  const d = f.cooling('thermal-cpufreq-2');
  f.tie(d, limit, 100);
  f.put(d, 2000 * MS, 2);
  f.put(limit, 2000 * MS + 100_000, 1_800_000);
  return {f, limit, d};
}

const MAIN_WORK: ['main', number, number] = ['main', 3000 * MS, 3010 * MS];

describe('per-frame frequency-limit binding (system_cpu_freq_limit_frame_binding)', () => {
  it('binding on a policy member CPU under a confirmed tightening is capped_binding with the onset confirmed', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 7, 3000 * MS, 10 * MS);
      f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'capped_binding',
        policy_cpu: 6, membership_basis: 'cpu_cluster_id', limit_khz: 1_800_000, reference_max_limit_khz: 2_400_000,
        depth_pct: 25, binding_ratio: 1, run_ns: 10 * MS, binding_ns: 10 * MS, onset_binding_ns: 10 * MS,
        freq_limit_onset_class: 'THERMAL_LIMIT_CONFIRMED', freq_limit_basis: 'THERMAL_LIMIT_CONFIRMED',
        freq_limit_onset_confirmed: 1, freq_limit_onset_ts: 2000 * MS + 100_000, trace_episode_id: 'policy6-tep1',
        freq_limit_cooling_basis: 'limit_set_by_paired_policy_cooling_transition'});
    } finally { f.close(); }
  });

  it.each([
    ['running below the cap', 1_500_000, 'capped_not_binding'],
    ['running at 90% of the cap', 1_620_000, 'capped_binding'],
  ])('%s', (_label, khz, state) => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 7, 3000 * MS, 10 * MS);
      f.frequency(7, 2900 * MS, 200 * MS, khz);
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: state, trace_episode_id: 'policy6-tep1'});
    } finally { f.close(); }
  });

  it('at the observed maximum limit, before the tightening, is not a limit', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 7, 1000 * MS, 10 * MS);
      f.frequency(7, 900 * MS, 200 * MS, 2_400_000);
      expect(frameBinding(f.db, [['main', 1000 * MS, 1010 * MS]]).main)
        .toMatchObject({freq_limit_state: 'at_observed_max_limit', policy_cpu: 6, freq_limit_onset_confirmed: 0});
    } finally { f.close(); }
  });

  it.each([
    ['before the policy\'s first sample', (f: Fixture) => f.running(1, 7, 2 * MS, 6 * MS), 2 * MS],
    ['under an invalid (zero) sample', (f: Fixture) => f.running(1, 7, 4100 * MS, 6 * MS), 4100 * MS],
  ])('%s is limit_state_unknown', (_label, run, start) => {
    const {f, limit} = confirmedCapOnPolicy6();
    try {
      f.put(limit, 4000 * MS, 0);
      run(f);
      f.frequency(7, 0, 5000 * MS, 1_800_000);
      expect(frameBinding(f.db, [['main', start, start + 6 * MS]]).main).toMatchObject({freq_limit_state: 'limit_state_unknown'});
    } finally { f.close(); }
  });

  it('without a valid max-limit sample every frame is limit_track_unavailable', () => {
    const f = new Fixture();
    try {
      f.put(f.minTrack(6), 10 * MS, 500_000);
      f.running(1, 7, 3000 * MS, 10 * MS);
      f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'limit_track_unavailable', run_ns: 0});
    } finally { f.close(); }
  });

  it('running on CPUs no max limit governs is threads_not_on_limited_policy', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 4, 3000 * MS, 10 * MS);
      f.frequency(4, 2900 * MS, 200 * MS, 1_800_000);
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'threads_not_on_limited_policy',
        limited_policy_ns: 0, policy_cpu: null});
    } finally { f.close(); }
  });

  it('a thread that mostly sleeps through its work interval is insufficient_running', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 7, 3000 * MS, 4 * MS);
      f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
      // A frame the cap did not reach carries no trigger facts.
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'insufficient_running',
        running_share: 0.4, freq_limit_basis: null, freq_limit_onset_class: null, trace_episode_id: null});
    } finally { f.close(); }
  });

  it('missing frequency is frequency_unavailable, never capped_not_binding', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 7, 3000 * MS, 10 * MS);
      f.frequency(7, 3000 * MS, 4 * MS, 1_000_000);
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'frequency_unavailable',
        freq_covered_ns: 4 * MS});
    } finally { f.close(); }
  });

  describe('policy membership', () => {
    it('a cluster holding two policy leaders keeps each policy to its leader', () => {
      const f = new Fixture();
      try {
        for (const policy of [0, 2]) {
          const t = f.maxTrack(policy);
          f.put(t, 10 * MS, 2_400_000);
          f.put(t, 1000 * MS, 1_800_000);
        }
        f.running(1, 1, 3000 * MS, 10 * MS);
        f.frequency(1, 2900 * MS, 200 * MS, 1_800_000);
        f.running(2, 0, 3000 * MS, 10 * MS);
        f.frequency(0, 2900 * MS, 200 * MS, 1_800_000);
        const rows = frameBinding(f.db, [MAIN_WORK, ['render', 3000 * MS, 3010 * MS]]);
        expect(rows.main).toMatchObject({freq_limit_state: 'threads_not_on_limited_policy'});
        expect(rows.render).toMatchObject({freq_limit_state: 'capped_binding', policy_cpu: 0,
          membership_basis: 'policy_leader_only'});
      } finally { f.close(); }
    });

    it('without cluster information only the leader belongs to its policy', () => {
      const {f} = confirmedCapOnPolicy6();
      try {
        f.db.exec('UPDATE cpu SET cluster_id = NULL');
        f.running(1, 7, 3000 * MS, 10 * MS);
        f.running(2, 6, 3000 * MS, 10 * MS);
        f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
        f.frequency(6, 2900 * MS, 200 * MS, 1_800_000);
        const rows = frameBinding(f.db, [MAIN_WORK, ['render', 3000 * MS, 3010 * MS]]);
        expect(rows.main).toMatchObject({freq_limit_state: 'threads_not_on_limited_policy'});
        expect(rows.render).toMatchObject({freq_limit_state: 'capped_binding', membership_basis: 'policy_leader_only'});
      } finally { f.close(); }
    });

    it('a leader ordinal shared by two machines has no members at all', () => {
      const {f} = confirmedCapOnPolicy6();
      try {
        f.db.exec('INSERT INTO cpu VALUES (8, 6, 1, 3, 1024)');
        f.running(1, 6, 3000 * MS, 10 * MS);
        f.frequency(6, 2900 * MS, 200 * MS, 1_800_000);
        expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'threads_not_on_limited_policy',
          limited_policy_ns: 0});
      } finally { f.close(); }
    });
  });

  describe('the frame reads the verdict of the value in force for its binding work', () => {
    it('a capped relaxation is never confirmed, even after a confirmed tightening', () => {
      const {f, limit} = confirmedCapOnPolicy6();
      try {
        f.put(limit, 2500 * MS, 2_000_000);
        f.running(1, 7, 3000 * MS, 10 * MS);
        f.frequency(7, 2900 * MS, 200 * MS, 2_000_000);
        expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'capped_binding',
          limit_khz: 2_000_000, freq_limit_onset_class: 'LIMIT_RELAXED', freq_limit_basis: 'LIMIT_RELAXED',
          freq_limit_onset_confirmed: 0, freq_limit_cooling_basis: 'cap_value_set_by_relaxation'});
      } finally { f.close(); }
    });

    it('a value first observed already capped has an unknown onset', () => {
      const f = new Fixture();
      try {
        const limit = f.maxTrack(6);
        f.put(limit, 10 * MS, 1_800_000);
        f.put(limit, 5000 * MS, 2_400_000);
        f.running(1, 7, 3000 * MS, 10 * MS);
        f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
        expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'capped_binding',
          freq_limit_onset_class: 'LIMIT_ONSET_UNKNOWN', freq_limit_onset_confirmed: 0});
      } finally { f.close(); }
    });

    it.each([
      ['binds 3 ms of 10 alongside an unconfirmed value binding 2 ms', 3, 'mixed_limit_values_in_frame', 0],
      ['binds 6 ms of 10 on its own', 6, 'THERMAL_LIMIT_CONFIRMED', 1],
    ])('a confirmed value that %s', (_label, confirmedMs, basis, confirmed) => {
      const {f, limit} = confirmedCapOnPolicy6();
      try {
        const split = (3000 + confirmedMs) * MS;
        f.put(limit, split, 1_500_000); // a second, unpaired tightening
        f.running(1, 7, 3000 * MS, 10 * MS);
        f.frequency(7, 2900 * MS, split - 2900 * MS, 1_800_000);
        f.frequency(7, split, 2 * MS, 1_500_000);
        f.frequency(7, split + 2 * MS, 3100 * MS - split - 2 * MS, 1_000_000);
        const main = frameBinding(f.db, [MAIN_WORK]).main;
        expect(main).toMatchObject({freq_limit_state: 'capped_binding', freq_limit_basis: basis,
          freq_limit_onset_confirmed: confirmed, onset_binding_ns: confirmedMs * MS, limit_khz: 1_800_000});
        expect(main.binding_ns).toBe((confirmedMs + 2) * MS);
      } finally { f.close(); }
    });

    it.each([
      ['the default 50% threshold: the earlier value is selected but binds too little alone', {},
        'mixed_limit_values_in_frame', 0],
      ['a 40% threshold: the earlier, confirmed value alone is enough', {freq_limit_binding_min_pct: 40},
        'THERMAL_LIMIT_CONFIRMED', 1],
    ])('equal binding time selects the earlier value, never the one capped longer (%s)',
      (_label, numbers, basis, confirmed) => {
        const {f, limit} = confirmedCapOnPolicy6();
        try {
          f.put(limit, 3004 * MS, 1_500_000); // a later, unpaired tightening
          f.running(1, 7, 3000 * MS, 10 * MS);
          f.frequency(7, 2900 * MS, 104 * MS, 1_800_000); // 1800 MHz value: binding = capped = 4 ms
          f.frequency(7, 3004 * MS, 4 * MS, 1_500_000); // 1500 MHz value: binding 4 ms ...
          f.frequency(7, 3008 * MS, 92 * MS, 1_000_000); // ... capped 6 ms
          expect(frameBinding(f.db, [MAIN_WORK], undefined, numbers).main).toMatchObject({
            freq_limit_state: 'capped_binding', limit_khz: 1_800_000, onset_binding_ns: 4 * MS,
            binding_ns: 8 * MS, freq_limit_onset_ts: 2000 * MS + 100_000, freq_limit_basis: basis,
            freq_limit_onset_confirmed: confirmed});
        } finally { f.close(); }
      });

    it('a paired tightening after the work interval, inside the frame, does not apply', () => {
      const f = new Fixture();
      try {
        const limit = f.maxTrack(6);
        f.put(limit, 10 * MS, 2_400_000);
        const d = f.cooling('thermal-cpufreq-2');
        f.tie(d, limit, 100);
        f.put(limit, 2000 * MS, 2_000_000); // unpaired
        f.put(d, 3020 * MS, 2);
        f.put(limit, 3020 * MS + 100_000, 1_800_000); // paired, after the work
        f.running(1, 7, 3000 * MS, 10 * MS);
        f.frequency(7, 2900 * MS, 200 * MS, 2_000_000);
        expect(frameBinding(f.db, [MAIN_WORK], [2990 * MS, 3050 * MS]).main).toMatchObject({
          freq_limit_state: 'capped_binding', limit_khz: 2_000_000, freq_limit_onset_ts: 2000 * MS,
          freq_limit_onset_confirmed: 0});
      } finally { f.close(); }
    });
  });

  it('another main-role thread binding under a confirmed cap never counts for the top slice\'s thread', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.db.exec("INSERT INTO thread VALUES (3, 1, 1003, '1.ui', 0)");
      f.running(1, 6, 3000 * MS, 10 * MS); // the top slice's thread, below the cap
      f.frequency(6, 2900 * MS, 200 * MS, 1_000_000);
      f.running(3, 7, 3000 * MS, 10 * MS); // a second main-role thread, at the cap
      f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
      expect(frameBinding(f.db, [MAIN_WORK]).main).toMatchObject({freq_limit_state: 'capped_not_binding',
        run_ns: 10 * MS, binding_ns: 0, freq_limit_onset_confirmed: 0});
      // The same interval attributed to the other thread binds.
      expect(frameBinding(f.db, [['main', 3000 * MS, 3010 * MS, 3]]).main).toMatchObject({
        freq_limit_state: 'capped_binding', freq_limit_onset_confirmed: 1});
    } finally { f.close(); }
  });

  it('RenderThread binding on a capped policy never moves the main thread\'s state', () => {
    const {f} = confirmedCapOnPolicy6();
    try {
      f.running(1, 1, 3000 * MS, 10 * MS);
      f.frequency(1, 2900 * MS, 200 * MS, 1_000_000);
      f.running(2, 7, 2995 * MS, 40 * MS);
      f.frequency(7, 2900 * MS, 200 * MS, 1_800_000);
      const rows = frameBinding(f.db, [MAIN_WORK, ['render', 2990 * MS, 3050 * MS]], [2990 * MS, 3050 * MS]);
      expect(rows.main).toMatchObject({freq_limit_state: 'threads_not_on_limited_policy'});
      expect(rows.render).toMatchObject({freq_limit_state: 'capped_binding', policy_cpu: 6, binding_ns: 40 * MS});
    } finally { f.close(); }
  });
});

/** The closed class tables, read from the fragment itself. */
function classTables(db: Database.Database): {classes: any[]; verdicts: any[]} {
  return {
    classes: verdictQuery(db, `SELECT trigger_class, trigger_class_rank, class_scope, is_confirmed
      FROM system_cpu_freq_limit_trigger_classes`),
    verdicts: verdictQuery(db, 'SELECT onset_verdict, trigger_class_rank FROM system_cpu_freq_limit_onset_verdict_classes'),
  };
}

describe('closed trigger-class and onset-verdict tables', () => {
  it('maps every onset verdict to exactly one rank and only rank 1 is confirmed', () => {
    const f = new Fixture();
    try {
      const {classes, verdicts} = classTables(f.db);
      expect(verdicts.map(v => [v.onset_verdict, v.trigger_class_rank])).toEqual([
        ['thermal_cooling_device_confirmed', 1],
        ['userspace_thermal_daemon_active_before_limit', 2],
        ['policy_cooling_active_background', 3],
        ['cooling_activity_policy_unassociated', 4],
        ['onset_unknown_capped_at_data_start', 5],
        ['onset_after_invalid_sample', 5],
        ['limit_changed_no_thermal_evidence', 6],
        ['thermal_evidence_not_captured', 7],
        ['limit_relaxed', 8],
      ]);
      expect(classes.map(c => [c.trigger_class, c.trigger_class_rank, c.class_scope, c.is_confirmed])).toEqual([
        ['THERMAL_LIMIT_CONFIRMED', 1, 'onset', 1],
        ['THERMAL_DAEMON_SUSPECTED', 2, 'onset', 0],
        ['THERMAL_COOLING_BACKGROUND', 3, 'onset', 0],
        ['THERMAL_COOLING_UNASSOCIATED', 4, 'onset', 0],
        ['LIMIT_ONSET_UNKNOWN', 5, 'onset', 0],
        ['NO_THERMAL_EVIDENCE_OBSERVED', 6, 'onset', 0],
        ['THERMAL_EVIDENCE_NOT_CAPTURED', 7, 'onset', 0],
        ['LIMIT_RELAXED', 8, 'onset', 0],
        ['NO_LIMIT_EPISODE', null, 'session', 0],
        ['LIMIT_EVIDENCE_MISSING', null, 'session', 0],
      ]);
    } finally { f.close(); }
  });
});

/** scrolling_analysis global_context_flags over one analysis window, as authored. */
function scrollingContext(db: Database.Database, window: {start_ts: number; end_ts: number}): any {
  return stepQuery(db, 'composite/scrolling_analysis.skill.yaml', 'global_context_flags',
    {...window, '__process_scope.upid': 'NULL'})[0];
}

describe('scrolling global context is window-scoped (R-scroll-window)', () => {
  it('a paired onset after the scroll window confirms only the trace-wide summary', () => {
    const {f, limit, d} = tiedPolicy();
    try {
      f.put(d, 700 * MS, 2);
      f.put(limit, 700 * MS + 100_000, 1_800_000);
      expect(scrollingContext(f.db, {start_ts: 0, end_ts: 200 * MS})).toMatchObject({
        freq_limit_classification: 'NO_LIMIT_EPISODE', thermal_trending: 0,
        freq_limit_trace_summary: 'THERMAL_LIMIT_CONFIRMED', freq_limit_trace_summary_scope: 'trace_wide'});
      expect(scrollingContext(f.db, {start_ts: 0, end_ts: 1000 * MS})).toMatchObject({
        freq_limit_classification: 'THERMAL_LIMIT_CONFIRMED', thermal_trending: 1});
    } finally { f.close(); }
  });
});

/**
 * Behavioural equivalence: on every fixture scenario, each consumer's class
 * column is the fragment's scope summary for the same window, never a value
 * of its own.
 */
describe('consumers report the fragment classification (behavioural equivalence)', () => {
  const WINDOW_MS: Window = [0, 0, 10_000 * MS];
  const scenarios: Array<[string, () => Fixture]> = [
    ['tied and forward-paired', () => {
      const {f, limit, d} = tiedPolicy();
      f.put(d, 2000 * MS, 2);
      f.put(limit, 2000 * MS + 100_000, 1_800_000);
      return f;
    }],
    ['tied device only in the background', () => {
      const {f, limit, d} = tiedPolicy();
      f.put(d, 1500 * MS, 2);
      f.put(limit, 2000 * MS, 1_800_000);
      return f;
    }],
    ['mixed episode (unpaired, then paired)', () => {
      const {f, limit, d} = tiedPolicy();
      f.put(limit, 1000 * MS, 1_800_000);
      f.put(d, 1600 * MS, 2);
      f.put(limit, 1600 * MS, 1_500_000);
      return f;
    }],
    ['daemon only', () => {
      const f = new Fixture();
      const p0 = f.maxTrack(0);
      f.put(p0, 10 * MS, 2_400_000);
      f.put(p0, 3000 * MS, 1_800_000);
      f.daemonRun(1000 * MS, 3 * MS);
      return f;
    }],
    ['onset unknown', () => {
      const f = new Fixture();
      const p0 = f.maxTrack(0);
      f.put(p0, 10 * MS, 1_800_000);
      f.put(p0, 1000 * MS, 2_400_000);
      return f;
    }],
    ['untied cooling activity', () => {
      const f = new Fixture();
      const p0 = f.maxTrack(0);
      const p4 = f.maxTrack(4);
      f.put(p0, 10 * MS, 2_400_000);
      f.put(p4, 10 * MS, 2_400_000);
      const d = f.cooling('thermal-cpufreq-2');
      f.tie(d, p4, 100);
      f.put(p0, 800 * MS, 1_900_000);
      f.put(d, 1500 * MS, 2);
      f.put(p0, 2300 * MS, 2_400_000);
      return f;
    }],
    ['no cooling capture', () => {
      const f = new Fixture();
      const p0 = f.maxTrack(0);
      f.put(p0, 10 * MS, 2_400_000);
      f.put(p0, 3000 * MS, 1_800_000);
      return f;
    }],
    ['no capped episode', () => {
      const f = new Fixture();
      f.put(f.maxTrack(0), 10 * MS, 2_400_000);
      return f;
    }],
    ['min-only capture', () => {
      const f = new Fixture();
      f.put(f.minTrack(0), 10 * MS, 500_000);
      return f;
    }],
  ];

  it.each(scenarios)('%s', (_label, build) => {
    const f = build();
    try {
      const ws = verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_window_summary WHERE window_id = 0', [WINDOW_MS])[0];
      const trace = verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_trace_summary')[0];
      const window = {start_ts: WINDOW_MS[1], end_ts: WINDOW_MS[2]};

      if (ws.has_max_limit_data === 1) {
        const direct = stepQuery(f.db, 'composite/thermal_throttling.skill.yaml', 'direct_limit_evidence', window)[0];
        expect(direct).toMatchObject({freq_limit_classification: ws.freq_limit_classification, is_confirmed: ws.is_confirmed,
          class_note: ws.class_note, cooling_confirmed_episodes: ws.confirmed_episode_count, has_cdev_data: ws.cooling_transition_coverage});
      }
      const episodes = verdictQuery(f.db, 'SELECT * FROM system_cpu_freq_limit_episode_verdicts WHERE window_id = 0', [WINDOW_MS]);
      if (episodes.length > 0) {
        const summary = stepQuery(f.db, 'composite/cpu_frequency_limit_attribution.skill.yaml', 'attribution_summary', {
          'analysis_window.data[0].window_start_ts': WINDOW_MS[1], 'analysis_window.data[0].window_end_ts': WINDOW_MS[2],
          'episode_rows[0].before_start_ts': 0, 'episode_rows[0].before_end_ts': episodes[0].onset_ts,
          'episode_rows[0].episode_id': episodes[0].episode_id})[0];
        expect(summary).toMatchObject({classification: ws.freq_limit_classification, description: ws.class_note,
          onset_trigger_mix: ws.onset_trigger_mix, cooling_confirmed_episodes: ws.confirmed_episode_count});
      }
      for (const e of episodes) {
        const who = stepQuery(f.db, 'composite/cpu_frequency_limit_episode.skill.yaml', 'who_verdict', {
          trace_episode_id: e.trace_episode_id, policy_cpu: e.policy_cpu, episode_start_ts: e.onset_ts,
          episode_end_ts: e.episode_end_ts, window_start_ts: WINDOW_MS[1], window_end_ts: WINDOW_MS[2]})[0];
        expect(who).toMatchObject({trigger_class: e.trigger_class, who_verdict: e.episode_verdict,
          onset_trigger_mix: e.onset_trigger_mix, interpretation: e.class_note});
      }
      const scrolling = scrollingContext(f.db, window);
      expect(scrolling).toMatchObject({freq_limit_classification: ws.freq_limit_classification,
        thermal_evidence: ws.freq_limit_classification, freq_limit_episode_count: ws.episode_count,
        freq_limit_confirmed_episode_count: ws.confirmed_episode_count, freq_limit_class_note: ws.class_note,
        thermal_trending: ws.has_max_limit_data === 1 ? ws.is_confirmed : null,
        freq_limit_trace_summary: trace.freq_limit_classification, freq_limit_trace_summary_scope: 'trace_wide'});
      if (trace.has_max_limit_data !== 1) {
        expect(stepQuery(f.db, 'composite/cpu_frequency_limit_attribution.skill.yaml', 'no_limit_capture_advice')[0].classification)
          .toBe(trace.freq_limit_classification);
        expect(stepQuery(f.db, 'atomic/cpu_freq_limit_timeline.skill.yaml', 'limit_unavailable')[0].limit_classification)
          .toBe(trace.freq_limit_classification);
      }
    } finally { f.close(); }
  });
});

/**
 * R-single-source: no Skill outside fragments/ may read the raw limit or
 * cooling sources, the fragments' internal CTEs, or produce a trigger class
 * or onset verdict of its own. A copied ladder is how the clipped-onset and
 * any-cooling-device bugs spread to three Skills.
 */
describe('frequency-limit verdict single source (contract)', () => {
  const fragmentsDir = path.join(skillsDir, 'fragments');
  const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, ' ');
  const fragmentFiles = fs.readdirSync(fragmentsDir).filter(name => name.endsWith('.sql'));
  const fragmentText = Object.fromEntries(fragmentFiles.map(name =>
    [name, stripComments(fs.readFileSync(path.join(fragmentsDir, name), 'utf8'))]));
  const OWNED_FRAGMENTS = [
    'system_cpu_freq_limit_spans.sql', 'system_cpu_freq_limit_episodes.sql', 'thermal_cooling_spans.sql',
    'thermal_cdev_policy_association.sql', 'system_cpu_freq_limit_episode_verdicts.sql',
    'system_cpu_freq_limit_frame_binding.sql',
  ];
  const definedCtes = new Set(OWNED_FRAGMENTS.flatMap(name =>
    [...fragmentText[name].matchAll(/^([a-z_]+) AS (?:MATERIALIZED )?\(/gm)].map(m => m[1])));

  // What consumers may read. Everything else a fragment defines is internal.
  const OUTPUT_CTES = [
    'system_cpu_freq_limit_data_status', 'system_cpu_freq_limit_spans', 'system_cpu_freq_limit_episodes',
    'system_cpu_freq_limit_events', 'system_cpu_freq_limit_max_events',
    'system_cpu_freq_limit_onset_verdicts', 'system_cpu_freq_limit_window_onset_verdicts',
    'system_cpu_freq_limit_episode_verdicts', 'system_cpu_freq_limit_window_summary', 'system_cpu_freq_limit_trace_summary',
    'thermal_cooling_spans', 'thermal_cooling_transition_coverage', 'thermal_cdev_policy_association',
    'system_cpu_freq_limit_frame_binding',
  ];
  // Consumers that read no more than a named subset of the output CTEs. A
  // frame reads the verdict of its value onset only through the frame binding,
  // and the scroll-wide context only through the window/trace summaries; it
  // never re-derives cooling or thermal evidence.
  const NARROW_CONSUMERS: Record<string, string[]> = {
    'composite/scrolling_analysis.skill.yaml#batch_frame_root_cause': ['system_cpu_freq_limit_frame_binding'],
    'composite/scrolling_analysis.skill.yaml#global_context_flags':
      ['system_cpu_freq_limit_window_summary', 'system_cpu_freq_limit_trace_summary'],
  };
  // Raw sources only a fragment may read. A step that needs one for something
  // other than limit/cooling evidence is listed with its reason.
  const RAW_SOURCE = /\b(cpu_max_frequency_limit|cpu_min_frequency_limit|cooling_device_counter|_flv_\w+)\b/;
  const RAW_SOURCE_READERS: Record<string, string> = {
    'atomic/cpu_freq_limit_timeline.skill.yaml#limit_summary': 'window start = first limit sample (data bounds, not evidence)',
    'atomic/cpu_freq_limit_timeline.skill.yaml#limit_episodes': 'window start = first limit sample (data bounds, not evidence)',
    'atomic/cpu_freq_limit_timeline.skill.yaml#limit_events': 'window start = first limit sample (data bounds, not evidence)',
    'composite/cpu_frequency_limit_attribution.skill.yaml#analysis_window': 'window start = first limit sample (data bounds, not evidence)',
    'atomic/thermal_cooling_device_timeline.skill.yaml#cooling_data_check': 'cooling-device display presence check, no trigger decision',
    'atomic/thermal_cooling_device_timeline.skill.yaml#cooling_summary': 'window start = first cooling sample (data bounds, not evidence)',
    'atomic/thermal_cooling_device_timeline.skill.yaml#cooling_transitions': 'window start = first cooling sample (data bounds, not evidence)',
    'modules/hardware/thermal_module.skill.yaml#cooling_activity': 'per-device state level display, no trigger decision',
  };

  const skillFiles = (dir: string): string[] => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    // Authoring templates and the empty pipeline base are not runtime Skills.
    if (entry.isDirectory()) return entry.name === '_template' ? [] : skillFiles(full);
    return entry.name.endsWith('.skill.yaml') && !entry.name.startsWith('_') ? [full] : [];
  });
  const allSteps = skillFiles(skillsDir).flatMap(file => {
    const skill = yaml.load(fs.readFileSync(file, 'utf8')) as any;
    const rel = path.relative(skillsDir, file);
    return [...(typeof skill?.sql === 'string' ? [{id: 'root', sql: skill.sql}] : []), ...allStepsOf(skill)]
      .filter(step => typeof step.sql === 'string')
      .map(step => ({key: `${rel}#${step.id}`, sql: stripComments(step.sql)}));
  });

  const literals = (() => {
    const f = new Fixture();
    try {
      const {classes, verdicts} = classTables(f.db);
      return [...classes.map(c => c.trigger_class), ...verdicts.map(v => v.onset_verdict)];
    } finally { f.close(); }
  })();
  // A class literal is allowed only as the right-hand side of a comparison
  // (`= 'X'`, `<> 'X'`, `IN (..., 'X')`, `CASE x WHEN 'X'`).
  const producedLiterals = (sql: string): string[] => literals.filter(lit =>
    [...sql.matchAll(new RegExp(`'${lit}'`, 'g'))].some(m => {
      const before = sql.slice(0, m.index).trimEnd();
      if (/(=|<>|!=|\bWHEN)$/i.test(before)) return false;
      const open = before.lastIndexOf('(');
      return !(open >= 0 && /\bIN\s*$/i.test(before.slice(0, open)) && !before.slice(open).includes(')'));
    }));

  it('every allowed output CTE is defined by a fragment', () => {
    expect(OUTPUT_CTES.filter(name => !definedCtes.has(name))).toEqual([]);
  });

  it('no consumer step produces a trigger class or onset verdict literal', () => {
    expect(literals.length).toBeGreaterThan(15);
    const offenders = allSteps.flatMap(({key, sql}) => producedLiterals(sql).map(lit => `${key}: '${lit}'`));
    expect(offenders).toEqual([]);
  });

  it('consumers read only the fragments\' output CTEs', () => {
    const offenders = allSteps.flatMap(({key, sql}) => [...new Set(sql.match(/\b[a-z_]+\b/g) ?? [])]
      .filter(name => definedCtes.has(name) && !OUTPUT_CTES.includes(name)).map(name => `${key}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it('only fragments read the raw limit and cooling sources', () => {
    const readers = allSteps.filter(({sql}) => RAW_SOURCE.test(sql)).map(({key}) => key);
    expect(readers.filter(key => !(key in RAW_SOURCE_READERS))).toEqual([]);
    // A stale exception would silently widen the allowlist.
    expect(Object.keys(RAW_SOURCE_READERS).filter(key => !readers.includes(key))).toEqual([]);
  });

  it('scrolling reads only its named slice of the verdict layer', () => {
    for (const [key, allowed] of Object.entries(NARROW_CONSUMERS)) {
      const step = allSteps.find(candidate => candidate.key === key);
      expect(step).toBeDefined();
      const read = [...new Set(step!.sql.match(/\b[a-z_]+\b/g) ?? [])].filter(name => definedCtes.has(name)).sort();
      expect({key, read}).toEqual({key, read: [...allowed].sort()});
    }
  });

  it('no consumer derives limit direction, capping or validity on its own', () => {
    const LOCAL_RULE = /\b(LAG|LEAD)\s*\([^)]*\b(value|limit_khz|state)\b|reference_max_limit_khz\s*\*|\b(value|limit_khz)\s*(>|>=|<>|!=)\s*0\b/i;
    const limitSteps = allSteps.filter(({sql}) => /system_cpu_freq_limit_|thermal_cooling_|thermal_cdev_/.test(sql));
    expect(limitSteps.length).toBeGreaterThan(5);
    expect(limitSteps.map(({key}) => key)).toEqual(expect.arrayContaining(Object.keys(NARROW_CONSUMERS)));
    expect(limitSteps.filter(({sql}) => LOCAL_RULE.test(sql)).map(({key}) => key)).toEqual([]);
  });

  it('keeps the ladder and the rank table in exactly one fragment', () => {
    const owners = fragmentFiles.filter(name => /THEN\s+'thermal_cooling_device_confirmed'/.test(fragmentText[name]));
    expect(owners).toEqual(['system_cpu_freq_limit_episode_verdicts.sql']);
    const everything = [...allSteps.map(({sql}) => sql), ...Object.values(fragmentText)].join('\n');
    // A trigger that cannot be judged is never reported as non-thermal.
    expect(everything).not.toMatch(/NON_THERMAL_LIMIT/);
  });
});
