// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import {describe, expect, it} from '@jest/globals';

const skillPath = path.join(
  process.cwd(),
  'skills',
  'atomic',
  'textureview_producer_frame_timing.skill.yaml',
);
const skill = yaml.load(fs.readFileSync(skillPath, 'utf8')) as any;

function getStep(id: string): any {
  const step = skill.steps?.find((candidate: any) => candidate.id === id);
  expect(step).toBeDefined();
  return step;
}

function substitute(sql: string): string {
  return sql
    .split('${package|}').join('com.example.texture')
    .split('${process_name|}').join('')
    .split('${target_frame_ms}').join('NULL')
    .split('${start_ts}').join('NULL')
    .split('${end_ts}').join('NULL');
}

function renderedIntervalSql(): string {
  const step = getStep('textureview_producer_intervals');
  expect(step.sql_fragments).toContain('fragments/vsync_config.sql');
  const sql = substitute(String(step.sql)).trim();
  const withMatch = /^WITH\b/i.exec(sql);
  expect(withMatch).not.toBeNull();
  const withEnd = withMatch!.index + withMatch![0].length;
  const testVsync = "vsync_config(vsync_period_ns, vsync_source) AS (VALUES (8333333, 'test_120hz'))";
  return `${sql.slice(0, withEnd)}\n${testVsync},\n${sql.slice(withEnd)}`;
}

function createFixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, name TEXT);
    CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
    CREATE TABLE slice(
      id INTEGER PRIMARY KEY,
      track_id INTEGER,
      ts INTEGER,
      dur INTEGER,
      name TEXT
    );

    INSERT INTO process VALUES (1, 'com.example.texture');
    INSERT INTO thread VALUES
      (11, 1, 'RenderThread'),
      (12, 1, 'Stable60'),
      (13, 1, 'Stable30'),
      (14, 1, 'BurstBookkeeping');
    INSERT INTO thread_track VALUES
      (101, 11),
      (102, 12),
      (103, 13),
      (104, 14);
  `);

  const insert = db.prepare(
    'INSERT INTO slice(id, track_id, ts, dur, name) VALUES (?, ?, ?, 1000, ?)',
  );
  let id = 1;
  const add = (trackId: number, ts: number, name: string): void => {
    insert.run(id++, trackId, ts, name);
  };

  // Establish TextureView identity for the process.
  add(101, 1, 'SurfaceTexture identity');

  // 120 Hz producer_submit stream with one isolated 16.67 ms gap.
  for (const ts of [10_000_000, 18_333_333, 26_666_666, 43_333_332, 51_666_665]) {
    add(101, ts, 'queueBuffer JNISurfaceTexture');
  }

  // A separate consumer notification stream must not interleave with submits.
  for (const ts of [12_000_000, 20_333_333, 28_666_666, 36_999_999]) {
    add(101, ts, 'onFrameAvailable JNISurfaceTexture');
  }

  // A second submit mechanism on the same thread is a separate event stream.
  for (const ts of [11_000_000, 19_333_333, 27_666_666, 35_999_999]) {
    add(101, ts, 'eglSwapBuffers');
  }

  // dequeueBuffer is inventory evidence only, never a cadence event.
  for (const ts of [14_000_000, 22_333_333, 30_666_666]) {
    add(101, ts, 'dequeueBuffer JNISurfaceTexture');
  }

  // Stable 60 and 30 FPS producers on a 120 Hz display are valid cadences.
  for (let index = 0; index < 8; index += 1) {
    add(102, 100_000_000 + index * 16_666_667, 'queueBuffer stable60');
    add(103, 100_000_000 + index * 33_333_333, 'queueBuffer stable30');
  }

  // High-frequency bookkeeping remains visible in summary but is not a frame clock.
  for (const ts of [10_000_000, 11_000_000, 12_000_000, 13_000_000, 14_000_000, 15_000_000, 35_000_000]) {
    add(104, ts, 'queueBuffer burst');
  }

  // A 250 ms trace/session break must not be reported as a cadence gap.
  add(101, 300_000_000, 'queueBuffer JNISurfaceTexture');

  return db;
}

describe('textureview_producer_frame_timing signal semantics', () => {
  it('assigns queue, dequeue, and frame-available signals to distinct roles', () => {
    const step = getStep('textureview_signal_summary');
    const sql = substitute(String(step.sql))
      .replace('PERCENTILE(dur_ms, 95)', 'MAX(dur_ms)');
    const db = createFixture();
    try {
      const rows = db.prepare(sql).all() as Array<{
        signal_role: string;
        signal_type: string;
        event_count: number;
        evidence_scope: string;
        claim_boundary: string;
      }>;
      const counts = rows.reduce<Record<string, number>>((result, row) => {
        result[row.signal_role] = (result[row.signal_role] ?? 0) + row.event_count;
        return result;
      }, {});
      expect(counts).toEqual(expect.objectContaining({
        producer_submit: 33,
        buffer_dequeue: 3,
        consumer_notification: 4,
      }));
      expect(counts.producer_submit).not.toBe(36);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          signal_role: 'producer_submit',
          signal_type: 'queue_buffer',
          evidence_scope: 'signal_inventory',
          claim_boundary: 'event_count_is_not_frame_count_or_jank_count',
        }),
        expect.objectContaining({
          signal_role: 'producer_submit',
          signal_type: 'egl_swap_buffers',
        }),
        expect.objectContaining({
          signal_role: 'consumer_notification',
          signal_type: 'frame_available',
        }),
      ]));
    } finally {
      db.close();
    }
  });

  it('reports only same-role cadence gaps and ignores stable low-rate streams and session breaks', () => {
    const db = createFixture();
    try {
      const rows = db.prepare(renderedIntervalSql()).all() as Array<{
        interval_ms: number;
        event_role: string;
        event_stream: string;
        thread_name: string;
        display_vsync_ms: number;
        stream_period_ms: number;
        cadence_baseline_ms: number;
        vsync_source: string;
        evidence_scope: string;
        claim_boundary: string;
      }>;

      expect(rows).toEqual([
        expect.objectContaining({
          interval_ms: 16.67,
          event_role: 'producer_submit',
          event_stream: 'queue_buffer',
          thread_name: 'RenderThread',
          display_vsync_ms: 8.33,
          stream_period_ms: 8.33,
          cadence_baseline_ms: 8.33,
          vsync_source: 'test_120hz',
          evidence_scope: 'per_thread_event_stream_cadence_gap_candidate',
          claim_boundary: 'timing_gap_candidate_not_jank_without_frame_correlation',
        }),
      ]);
      expect(rows.some((row) => row.thread_name === 'Stable60')).toBe(false);
      expect(rows.some((row) => row.thread_name === 'Stable30')).toBe(false);
      expect(rows.some((row) => row.thread_name === 'BurstBookkeeping')).toBe(false);
      expect(rows.some((row) => row.interval_ms >= 200)).toBe(false);
    } finally {
      db.close();
    }
  });
});
