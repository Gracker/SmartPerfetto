// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SmartPerfetto contributors
// This file is part of SmartPerfetto. See LICENSE for details.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import * as yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '../..');
const skill = yaml.load(fs.readFileSync(path.join(root, 'backend/skills/atomic/game_fps_analysis.skill.yaml'), 'utf8'));

function analyze(timestamps, options = {}) {
  const db = new DatabaseSync(':memory:');
  try {
    // The original jank query uses PERCENTILE(..., 50). Register its SQLite
    // equivalent so the same regressions exercise both old and fixed SQL.
    db.aggregate('PERCENTILE', {
      start: () => ({values: [], p: 50}),
      step: (acc, value, p) => {acc.p = p; if (value !== null) acc.values.push(value); return acc;},
      result: acc => {
        const values = acc.values.sort((a, b) => a - b);
        if (!values.length) return null;
        const rank = acc.p / 100 * (values.length - 1);
        const left = Math.floor(rank);
        return values[left] + (values[Math.ceil(rank)] - values[left]) * (rank - left);
      },
    });
    db.exec(`CREATE TABLE process(upid, name);
      INSERT INTO process VALUES(1, 'com.example');
      CREATE TABLE actual_frame_timeline_slice(ts, dur, upid, surface_frame_token);`);
    const insert = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES(?, 1, 1, 1)');
    for (const ts of timestamps) insert.run(ts);
    const params = {package: 'com.example', target_fps: null, start_ts: null, end_ts: null, ...options};
    let detection;
    const execute = id => {
      const step = skill.steps.find(candidate => candidate.id === id);
      const sql = step.sql.replace(/\$\{([^}]+)\}/g, (_, key) => {
        if (key === 'fps_detection.data[0].target_interval_ns|NULL') return String(detection.target_interval_ns ?? 'NULL');
        assert.ok(Object.hasOwn(params, key), `unbound fixture value: ${key}`);
        return String(params[key] ?? 'NULL');
      });
      return {...db.prepare(sql).get()};
    };
    detection = execute('detect_target_fps');
    return {detection, jank: execute('jank_detection')};
  } finally {
    db.close();
  }
}

const cadence = gap => Array.from({length: 10}, (_, i) => i * gap);

test('variable cadence has no invented 120 FPS target, hit rate or quality', () => {
  const {detection, jank} = analyze(cadence(50_000_000));
  assert.equal(detection.detected_fps_mode, 'variable');
  for (const key of ['target_fps', 'target_interval_ns', 'frames_at_target', 'target_hit_rate']) assert.equal(detection[key], null, key);
  for (const key of ['target_fps', 'jank_count', 'severe_jank_count', 'freeze_count', 'jank_rate', 'severe_jank_rate', 'quality_rating']) assert.equal(jank[key], null, key);
});

test('an explicit target is honored by detection and jank', () => {
  const {detection, jank} = analyze(cadence(50_000_000), {target_fps: 60});
  assert.equal(detection.target_fps, 60);
  assert.equal(jank.target_fps, 60);
  assert.equal(detection.frames_at_target, 0);
  assert.equal(jank.jank_count, 9);
});

test('target hits retain the authored 60 FPS bucket, including its edges', () => {
  const {detection, jank} = analyze(cadence(14_600_000), {target_fps: 60});
  assert.equal(detection.frames_at_target, 9);
  assert.equal(detection.target_hit_rate, 100);
  assert.equal(jank.jank_count, 0);
});

test('empty samples never receive a quality rating', () => {
  for (const target_fps of [null, 60]) {
    const {detection, jank} = analyze([], {target_fps});
    assert.equal(detection.total_frames, 0);
    assert.equal(jank.quality_rating, null);
    assert.equal(jank.jank_count, null);
  }
});

test('nonpositive targets use the same detected target in both steps', () => {
  for (const target_fps of [0, -60]) {
    const {detection, jank} = analyze(cadence(16_666_667), {target_fps});
    assert.equal(detection.target_fps, 60);
    assert.equal(jank.target_fps, 60);
    assert.equal(jank.jank_count, 0);
  }
});

test('an explicit nonpreset target defines jank without inventing a hit bucket', () => {
  const {detection, jank} = analyze(cadence(50_000_000), {target_fps: 75});
  assert.equal(detection.target_fps, 75);
  assert.equal(jank.target_fps, 75);
  assert.equal(detection.frames_at_target, null);
  assert.equal(detection.target_hit_rate, null);
});

test('jank uses the target detected inside the selected window', () => {
  const timestamps = Array.from({length: 30}, (_, i) => i * 16_666_667)
    .concat(cadence(33_333_333).map(ts => ts + 600_000_000));
  const {detection, jank} = analyze(timestamps, {start_ts: 600_000_000, end_ts: 1_000_000_000});
  assert.equal(detection.target_fps, 30);
  assert.equal(jank.target_fps, 30);
  assert.equal(jank.jank_count, 0);
});
