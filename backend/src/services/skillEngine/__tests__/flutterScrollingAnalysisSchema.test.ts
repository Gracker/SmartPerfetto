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
  'composite',
  'flutter_scrolling_analysis.skill.yaml',
);
const fragmentPath = path.join(
  process.cwd(),
  'skills',
  'fragments',
  'flutter_process_identity.sql',
);
const skill = yaml.load(fs.readFileSync(skillPath, 'utf8')) as any;
const processIdentityFragment = fs.readFileSync(fragmentPath, 'utf8');

function getStep(id: string): any {
  const step = skill.steps?.find((candidate: any) => candidate.id === id);
  expect(step).toBeDefined();
  return step;
}

function substitute(sql: string, packageName = ''): string {
  return sql
    .split('${package}').join(packageName)
    .split('${start_ts}').join('NULL')
    .split('${end_ts}').join('NULL')
    .split('${vsync_period_ns|16666667}').join('8333333')
    .split('${vsync_period_ns}').join('8333333');
}

function renderedStepSql(id: string, packageName = ''): string {
  const step = getStep(id);
  expect(step.sql_fragments).toContain('fragments/flutter_process_identity.sql');
  const sql = substitute(String(step.sql), packageName).trim();
  const fragment = substitute(processIdentityFragment, packageName).trim();
  const withMatch = /^(\s*(?:--[^\n]*\n\s*)*)WITH\b/i.exec(sql);
  if (!withMatch) return `WITH\n${fragment}\n${sql}`;
  const withEnd = withMatch.index + withMatch[0].length;
  return `${sql.slice(0, withEnd)}\n${fragment}\n,\n${sql.slice(withEnd)}`;
}

function createFixture(): Database.Database {
  const db = new Database(':memory:');
  db.function('android_is_app_jank_type', (value: unknown) =>
    /App Deadline Missed|App Resynced Jitter/.test(String(value)) ? 1 : 0);
  db.function('android_is_sf_jank_type', (value: unknown) =>
    /SurfaceFlinger|Prediction Error|Display HAL/.test(String(value)) ? 1 : 0);
  db.function('android_is_missed_frame_type', (value: unknown) =>
    /App Deadline Missed|App Resynced Jitter|SurfaceFlinger/.test(String(value)) ? 1 : 0);
  db.exec(`
    CREATE TABLE process(upid INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE thread(utid INTEGER PRIMARY KEY, upid INTEGER, name TEXT);
    CREATE TABLE thread_track(id INTEGER PRIMARY KEY, utid INTEGER);
    CREATE TABLE counter_track(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE counter(id INTEGER PRIMARY KEY, track_id INTEGER, ts INTEGER, value REAL);
    CREATE TABLE slice(
      id INTEGER PRIMARY KEY,
      track_id INTEGER,
      ts INTEGER,
      dur INTEGER,
      depth INTEGER,
      name TEXT
    );
    CREATE TABLE actual_frame_timeline_slice(
      id INTEGER PRIMARY KEY,
      upid INTEGER,
      display_frame_token INTEGER,
      surface_frame_token INTEGER,
      ts INTEGER,
      dur INTEGER,
      jank_type TEXT,
      jank_tag TEXT,
      present_type TEXT,
      on_time_finish INTEGER,
      layer_name TEXT
    );
    CREATE TABLE expected_frame_timeline_slice(ts INTEGER, dur INTEGER);

    INSERT INTO process VALUES
      (1, 'com.example.flutter'),
      (2, '/system/bin/surfaceflinger'),
      (3, 'com.example.background_flutter'),
      (4, 'com.example.flutter:renderer'),
      (5, 'com.example.flutterish');
    INSERT INTO thread VALUES
      (11, 1, '1.ui'),
      (12, 1, '1.raster'),
      (13, 1, 'DartWorker'),
      (14, 1, '1.io'),
      (31, 3, '2.ui'),
      (32, 3, '2.raster');
    INSERT INTO thread_track VALUES
      (101, 11),
      (102, 12),
      (103, 13),
      (104, 14),
      (301, 31),
      (302, 32);
    INSERT INTO actual_frame_timeline_slice VALUES
      (1, 2, 100, 100, 1000000000, 16600000, 'None', '', 'On-time Present', 1, 'SurfaceFlinger'),
      (2, 2, 101, 101, 1016666667, 25000000, 'None', '', 'On-time Present', 1, 'SurfaceFlinger'),
      (3, 4, 102, 102, 1030000000, 8000000, 'None', '', 'On-time Present', 1, 'Flutter child'),
      (4, 5, 103, 103, 1040000000, 8000000, 'None', '', 'On-time Present', 1, 'Similar prefix');
    INSERT INTO counter_track VALUES (1, 'VSYNC-sf');
    INSERT INTO counter VALUES
      (1, 1, 1000000000, 1),
      (2, 1, 1008333333, 2),
      (3, 1, 1016666666, 3);
  `);
  const insertSlice = db.prepare(
    'INSERT INTO slice(id, track_id, ts, dur, depth, name) VALUES (?, ?, ?, ?, 0, ?)',
  );
  let id = 1;
  for (let index = 0; index < 10; index += 1) {
    insertSlice.run(id++, 101, index * 1_000_000, 100_000, 'Animator::BeginFrame');
    insertSlice.run(id++, 102, index * 1_000_000, 200_000, 'Rasterizer::DoDraw');
  }
  insertSlice.run(id++, 103, 1, 10_000, 'DartWorker task');
  insertSlice.run(id++, 104, 1, 20_000, 'IO task');
  insertSlice.run(id++, 301, 1, 10_000, 'background ui');
  insertSlice.run(id++, 302, 1, 10_000, 'background raster');
  return db;
}

describe('flutter_scrolling_analysis process scope', () => {
  it('uses the shared Flutter identity fragment for every process-sensitive step', () => {
    for (const stepId of [
      'flutter_frame_overview',
      'flutter_thread_analysis',
      'flutter_consumer_jank',
      'flutter_jank_frames',
      'flutter_ui_thread_long_slices',
      'flutter_raster_thread_long_slices',
    ]) {
      const sql = String(getStep(stepId).sql);
      expect(getStep(stepId).sql_fragments).toContain(
        'fragments/flutter_process_identity.sql',
      );
      expect(sql).not.toMatch(/\$\{package\}\s*=\s*''\s+OR\s+p\.name/i);
    }
  });

  it('does not turn SurfaceFlinger FrameTimeline rows into Flutter frames', () => {
    const db = createFixture();
    try {
      const overview = db.prepare(renderedStepSql('flutter_frame_overview')).get() as {
        total_frames: number;
        evidence_status: string;
        process_scope: string;
      };
      expect(overview).toEqual(expect.objectContaining({
        total_frames: 0,
        evidence_status: 'no_flutter_process_frame_timeline',
        process_scope: 'com.example.flutter',
      }));

      const jankRows = db.prepare(renderedStepSql('flutter_jank_frames')).all();
      expect(jankRows).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps thread analysis on the single dominant Flutter process', () => {
    const db = createFixture();
    try {
      const rows = db.prepare(renderedStepSql('flutter_thread_analysis')).all() as Array<{
        role: string;
        slice_count: number;
      }>;
      expect(rows).toEqual([
        expect.objectContaining({role: 'Raster (GPU)', slice_count: 10}),
        expect.objectContaining({role: 'UI (Dart)', slice_count: 10}),
        expect.objectContaining({role: 'IO (Decode)', slice_count: 1}),
      ]);
    } finally {
      db.close();
    }
  });

  it('uses exact package plus child-process matching when package is explicit', () => {
    const db = createFixture();
    try {
      const sql = renderedStepSql('flutter_frame_overview', 'com.example.flutter');
      expect(sql).toContain("p.name = 'com.example.flutter'");
      expect(sql).toContain("p.name GLOB 'com.example.flutter:*'");
      expect(sql).not.toContain("LIKE '%com.example.flutter%'");
      expect(db.prepare(sql).get()).toEqual(expect.objectContaining({
        total_frames: 1,
        evidence_status: 'scoped_flutter_frame_timeline',
      }));
    } finally {
      db.close();
    }
  });
});
