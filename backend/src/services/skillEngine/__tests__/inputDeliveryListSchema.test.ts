// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';
import {createOwnMonitorInputFixture} from '../../../../tests/helpers/androidInputEventsFixture';
import {renderStepSql} from '../../../../tests/helpers/skillFragmentSql';

// Skills that list one row per input delivery of a package-matched process.
const LISTING_SKILLS = ['input_events_in_range', 'touch_to_display_latency'] as const;
type ListingSkill = typeof LISTING_SKILLS[number];

const skills = new Map(LISTING_SKILLS.map(id => [id, yaml.load(fs.readFileSync(
  path.join(process.cwd(), 'skills', 'atomic', `${id}.skill.yaml`),
  'utf8',
)) as any]));

type Row = {process_name: string; normalized_channel: string; total_latency_ms: number};

function run(
  db: Database.Database,
  id: ListingSkill,
  vars: {package?: string; start_ts?: string | number; end_ts?: string | number; event_action?: string} = {},
): Row[] {
  const skill = skills.get(id);
  const sql = renderStepSql(String(skill.sql), skill.sql_fragments, {
    package: '', start_ts: 'NULL', end_ts: 'NULL', event_type: '', event_action: '', ...vars,
  });
  return db.prepare(sql).all() as Row[];
}

const createFixture = () => createOwnMonitorInputFixture().db;

describe.each(LISTING_SKILLS)('%s input deliveries of a package', id => {
  it('lists only the application channel of a process that also owns a monitor', () => {
    const db = createFixture();
    try {
      const rows = run(db, id, {package: 'com.example.launcher'});
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map(row => row.normalized_channel))).toEqual(new Set(['Launcher (server)']));
      expect(Math.max(...rows.map(row => row.total_latency_ms))).toBe(4);
    } finally {
      db.close();
    }
  });

  it('keeps every observation of an explicitly chosen observer', () => {
    const db = createFixture();
    try {
      expect(run(db, id, {package: 'com.android.systemui'})).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('applies the same per-process rule without a package', () => {
    const db = createFixture();
    try {
      const rows = run(db, id);
      expect(rows.filter(row => row.process_name === 'com.example.launcher')).toHaveLength(6);
      expect(rows.filter(row => row.process_name === 'com.android.systemui')).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('judges application rows per process name across package:* children', () => {
    const {db, deliver} = createOwnMonitorInputFixture();
    try {
      // A child process that only observed input stays listed under its own name.
      deliver(3, 'com.example.launcher:overlay', '[Gesture Monitor] overlay (server)', 1, 'MOTION', null, 5);
      const rows = run(db, id, {package: 'com.example.launcher'});
      expect(rows.map(row => row.process_name).sort()).toEqual([
        ...Array(6).fill('com.example.launcher'), 'com.example.launcher:overlay',
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps the application rows when the window holds only unresolved events', () => {
    const db = createFixture();
    try {
      // Events 4-6 only: no action in the window, yet the monitor channel is
      // known from the whole trace.
      const rows = run(db, id, {package: 'com.example.launcher', start_ts: 350});
      expect(rows).toHaveLength(3);
      expect(rows.every(row => row.normalized_channel === 'Launcher (server)')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('keeps every receiver when no event in the trace resolves an action', () => {
    const db = createFixture();
    try {
      db.exec('UPDATE android_input_events SET event_action = NULL');
      expect(run(db, id, {package: 'com.example.launcher'})).toHaveLength(11);
    } finally {
      db.close();
    }
  });
});

describe('input_events_in_range filters', () => {
  it('includes a delivery in flight at the window start and excludes one dispatched at its end', () => {
    const db = createFixture();
    try {
      // Event 2 is dispatched at 200 and received until 215; event 3 is dispatched at 300.
      const rows = run(db, 'input_events_in_range', {package: 'com.example.launcher', start_ts: 210, end_ts: 300});
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('keeps an action filter to the application deliveries', () => {
    const db = createFixture();
    try {
      expect(run(db, 'input_events_in_range', {package: 'com.example.launcher', event_action: 'MOVE'}))
        .toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
