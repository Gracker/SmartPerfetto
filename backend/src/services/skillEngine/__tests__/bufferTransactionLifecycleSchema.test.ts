// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {afterEach, describe, expect, it} from '@jest/globals';
import {renderStepSql} from '../../../../tests/helpers/skillFragmentSql';

const skill = yaml.load(fs.readFileSync(
  path.join(process.cwd(), 'skills/atomic/buffer_transaction_lifecycle.skill.yaml'), 'utf8',
)) as {steps: Array<{id: string; sql: string}>};
const MS = 1_000_000;
const packageName = 'com.example.buffer';
let db: Database.Database;

afterEach(() => { db?.close(); });

function fixture(): Database.Database {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, name TEXT);
    CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
    CREATE TABLE slice(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, dur INTEGER, name TEXT);
    CREATE TABLE actual_frame_timeline_slice(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER,
      upid INTEGER, layer_name TEXT, jank_type TEXT);
    CREATE TABLE counter_track(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
    INSERT INTO process VALUES
      (1, '${packageName}'), (2, '${packageName}:renderer'),
      (3, '${packageName}.extra'), (4, 'com.other.app'), (5, '${packageName}'),
      (10, '/system/bin/surfaceflinger'), (11, 'surfaceflinger');
    INSERT INTO thread VALUES
      (1, 1, 'RenderThread'), (2, 2, 'RenderThread'), (3, 3, 'RenderThread'),
      (4, 4, 'RenderThread'), (5, 5, 'RenderThread'), (10, 10, 'surfaceflinger'), (11, 11, 'surfaceflinger');
    INSERT INTO thread_track SELECT utid, utid FROM thread;
  `);
  return db;
}

function rows(id: string, parameters: Record<string, string | number> = {}): Array<Record<string, unknown>> {
  const step = skill.steps.find(candidate => candidate.id === id);
  if (!step) throw new Error(`Missing production step ${id}`);
  return db.prepare(renderStepSql(step.sql, undefined, {
    package: packageName, start_ts: 100 * MS, end_ts: 200 * MS, ...parameters,
  })).all() as Array<Record<string, unknown>>;
}

describe('buffer_transaction_lifecycle evidence semantics', () => {
  it('keeps global SF counts separate from exact package/subprocess event counts and refuses time pairing', () => {
    fixture();
    const insert = db.prepare('INSERT INTO slice(track_id, ts, dur, name) VALUES (?, ?, 1000, ?)');
    for (const [track, ms, name] of [
      [1, 99, 'queueBuffer'],
      [1, 105, 'queueBuffer'],
      [4, 106, 'queueBuffer'],
      [10, 107, 'applyTransaction'],
      [3, 108, 'queueBuffer'],
      [11, 109, 'latchBuffer'],
      [1, 110, 'dequeueBuffer'],
      [2, 111, 'Surface::queueBuffer'],
      [1, 112, 'BLASTBufferQueue::acquireNextBufferLocked'],
      [2, 113, 'BLASTBufferQueue::acquireNextBufferLocked'],
      [3, 114, 'BLASTBufferQueue::acquireNextBufferLocked'],
      [11, 115, 'applyTransaction'],
      [10, 116, 'setTransactionState'],
      [1, 200, 'queueBuffer'],
    ] as Array<[number, number, string]>) insert.run(track, ms * MS, name);

    expect(rows('apply_transaction_summary')).toEqual([{
      total_apply_transactions: 2,
      total_set_transaction_state: 1,
      total_blast_bq: 2,
      total_queue_buffer: 2,
      avg_apply_to_latch_ms: null,
      pairing_status: 'unsupported_missing_identity',
      sf_event_scope: 'global_surfaceflinger',
      app_event_scope: 'package_and_colon_subprocesses',
    }]);
    expect(rows('apply_transaction_summary', {package: ''})[0]).toMatchObject({
      total_apply_transactions: 2, total_blast_bq: 3, total_queue_buffer: 4,
      avg_apply_to_latch_ms: null, app_event_scope: 'all_processes',
    });
    expect(rows('queue_to_transaction_delay')).toEqual([{
      bucket: 'unavailable_missing_identity', count: null,
      pairing_status: 'unsupported_missing_identity',
    }]);
  });

  it('reports complete FrameTimeline records by process instance/layer rather than transactions', () => {
    fixture();
    const insert = db.prepare(`INSERT INTO actual_frame_timeline_slice
      (ts, dur, upid, layer_name, jank_type) VALUES (?, ?, ?, ?, ?)`);
    for (const [upid, ms, durationMs, jank] of [
      [1, 105, 4, 'None'], [1, 110, 8, 'App Deadline Missed'],
      [1, 115, -1, 'App Deadline Missed'], [1, 200, 50, 'App Deadline Missed'],
      [2, 120, 3, 'None'], [3, 125, 50, 'App Deadline Missed'],
      [4, 130, 50, 'App Deadline Missed'], [5, 135, 2, 'None'],
    ] as Array<[number, number, number, string]>) {
      insert.run(ms * MS, durationMs * MS, upid, 'SharedLayer', jank);
    }

    expect(rows('per_layer_transactions')).toEqual([
      {upid: 1, process_name: packageName, layer_name: 'SharedLayer', frame_count: 2,
        jank_count: 1, avg_dur_ms: 6, evidence_scope: 'frame_timeline_layer_records_not_transactions'},
      {upid: 2, process_name: `${packageName}:renderer`, layer_name: 'SharedLayer', frame_count: 1,
        jank_count: 0, avg_dur_ms: 3, evidence_scope: 'frame_timeline_layer_records_not_transactions'},
      {upid: 5, process_name: packageName, layer_name: 'SharedLayer', frame_count: 1,
        jank_count: 0, avg_dur_ms: 2, evidence_scope: 'frame_timeline_layer_records_not_transactions'},
    ]);
    expect(rows('per_layer_transactions', {package: ''})).toHaveLength(5);
  });

  it('uses the sample before the window for deltas and keeps duplicate-named counter tracks separate', () => {
    fixture();
    db.exec(`INSERT INTO counter_track VALUES
      (101, 'BufferTX - ${packageName}/Activity#1'),
      (102, 'BufferTX - ${packageName}/Activity#1'),
      (103, 'BufferTX - ${packageName}.extra/Activity#1'),
      (104, 'BufferTX - SurfaceView[${packageName}/Activity]'),
      (105, 'BufferTX - [${packageName}:renderer]'),
      (106, 'BufferTX - com.other.app/Activity#1');`);
    const insert = db.prepare('INSERT INTO counter(track_id, ts, value) VALUES (?, ?, ?)');
    for (const [track, ms, value] of [
      [101, 90, 2], [101, 100, 3], [101, 110, 1], [101, 199, 2], [101, 200, 9],
      [102, 90, 0], [102, 100, 2], [102, 150, 1],
      [103, 90, 0], [103, 100, 99],
      [104, 110, 5],
      [105, 90, 1], [105, 130, 0],
      [106, 90, 0], [106, 100, 88],
    ]) insert.run(track, ms * MS, value);

    const observed = rows('buffer_tx_pending_observations');
    expect(observed.map(row => row.track_id)).toEqual([101, 102, 104, 105]);
    expect(observed[0]).toMatchObject({
      sample_count: 3, received_updates: 2, removed_updates: 2,
      min_pending_updates: 1, max_pending_updates: 3, last_pending_updates: 2,
      coverage_status: 'observed', evidence_scope: 'package_layer_name_match_not_exact_upid',
      claim_boundary: 'server_pending_not_gpu_ready_or_presented_frames',
    });
    expect(observed[1]).toMatchObject({sample_count: 2, received_updates: 2, removed_updates: 1});
    // No preceding sample: a nonzero left edge is inventory, never newly received updates.
    expect(observed[2]).toMatchObject({
      sample_count: 1, received_updates: 0, removed_updates: 0,
      min_pending_updates: 5, max_pending_updates: 5, last_pending_updates: 5,
      coverage_status: 'partial_missing_previous_sample',
    });
    expect(observed[3]).toMatchObject({received_updates: 0, removed_updates: 1, last_pending_updates: 0});
    expect(rows('buffer_tx_pending_observations', {package: ''})).toHaveLength(6);
  });

  it('distinguishes missing counter samples from observed zero activity and leaves absent FrameTimeline empty', () => {
    fixture();
    expect(rows('buffer_tx_pending_observations')).toEqual([{
      track_id: null, track_name: null, sample_count: 0,
      received_updates: null, removed_updates: null,
      min_pending_updates: null, max_pending_updates: null, last_pending_updates: null,
      coverage_status: 'unavailable_no_counter_samples',
      evidence_scope: 'package_layer_name_match_not_exact_upid',
      claim_boundary: 'server_pending_not_gpu_ready_or_presented_frames',
    }]);
    expect(rows('per_layer_transactions')).toEqual([]);
    expect(rows('apply_transaction_summary')[0]).toMatchObject({
      avg_apply_to_latch_ms: null, pairing_status: 'unsupported_missing_identity',
    });
  });
});
