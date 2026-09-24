// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';
import {completeAndroidInputEventsFixture} from '../../../../tests/helpers/androidInputEventsFixture';
import {withStepFragments} from '../../../../tests/helpers/skillFragmentSql';

const skillPath = path.join(
  process.cwd(),
  'skills',
  'composite',
  'click_response_detail.skill.yaml',
);
const skill = yaml.load(fs.readFileSync(skillPath, 'utf8')) as any;

function inputPipelineTargetEventSql(): string {
  const step = skill.steps?.find((candidate: any) => candidate.id === 'input_pipeline_lifecycle');
  expect(step).toBeDefined();
  const match = String(step.sql).match(
    /WITH target_event AS \(\s*([\s\S]*?LIMIT 1)\s*\)\s*SELECT/,
  );
  expect(match).not.toBeNull();
  return withStepFragments(match![1], step.sql_fragments);
}

describe('click_response_analysis target process selection', () => {
  const analysisSkill = yaml.load(fs.readFileSync(
    path.join(process.cwd(), 'skills', 'composite', 'click_response_analysis.skill.yaml'),
    'utf8',
  )) as any;

  const getProcess = analysisSkill.steps.find((candidate: any) => candidate.id === 'get_process');

  const selectTarget = (db: Database.Database, packageName: string) => {
    const sql = withStepFragments(String(getProcess.sql), getProcess.sql_fragments)
      .split('${package}').join(packageName)
      .split('${start_ts}').join('NULL')
      .split('${end_ts}').join('NULL');
    return db.prepare(sql).all() as Array<{process_name: string; event_count: number; app_delivery_events: number; max_total_ms: number}>;
  };

  // The tapped app gets the actioned row of each physical event; systemui
  // observes each one on a gesture monitor plus once on the navigation bar.
  const createFixture = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_input_events (
        upid INTEGER, process_name TEXT, event_channel TEXT, input_event_id TEXT,
        event_action TEXT, total_latency_dur INTEGER,
        dispatch_ts INTEGER, receive_ts INTEGER, receive_dur INTEGER
      );
      INSERT INTO android_input_events VALUES
        (1, 'com.example.app', 'app (server)', '1', 'ACTION_DOWN', 1000000, 100, 110, 10),
        (1, 'com.example.app', 'app (server)', '2', 'ACTION_UP', 1000000, 200, 210, 10),
        (2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', '1', NULL, 3000000, 100, 110, 10),
        (2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', '2', NULL, 3000000, 200, 210, 10),
        (2, 'com.android.systemui', 'NavigationBar0 (server)', '1', NULL, 3000000, 100, 110, 10);
    `);
    completeAndroidInputEventsFixture(db);
    return db;
  };

  it('ranks application deliveries above monitor copies with more rows', () => {
    const db = createFixture();
    try {
      expect(selectTarget(db, '')).toEqual([
        {process_name: 'com.example.app', event_count: 2, app_delivery_events: 2, max_total_ms: 1},
      ]);
    } finally {
      db.close();
    }
  });

  it('classifies a copy whose action-bearing sibling lies outside the caller window', () => {
    const db = createFixture();
    try {
      // The app rows arrive before the window; only systemui's copies are inside.
      db.exec("UPDATE android_input_events SET receive_ts = 90 WHERE process_name = 'com.example.app'");
      const roles = db.prepare(withStepFragments(
        'SELECT delivery_role FROM android_input_event_deliveries WHERE receive_ts > 100',
        getProcess.sql_fragments,
      )).all();

      expect(roles).toEqual(Array(3).fill({delivery_role: 'monitor_copy'}));
    } finally {
      db.close();
    }
  });

  it('keeps an explicit package authoritative when its rows are all monitor copies', () => {
    const db = createFixture();
    try {
      expect(selectTarget(db, 'com.android.systemui')).toEqual([
        {process_name: 'com.android.systemui', event_count: 3, app_delivery_events: 0, max_total_ms: 3},
      ]);
    } finally {
      db.close();
    }
  });
});

describe('click_response_detail input event identity', () => {
  it('selects the exact process when a prefix process has the same event bounds', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE android_input_events (
          process_name TEXT,
          dispatch_ts INTEGER,
          receive_ts INTEGER,
          receive_dur INTEGER,
          input_event_id INTEGER,
          event_channel TEXT
        );
        INSERT INTO android_input_events VALUES
          ('com.foo:remote', 100, 180, 20, 1, 'remote'),
          ('com.foo', 100, 180, 20, 2, 'main');
      `);
      completeAndroidInputEventsFixture(db);

      const selector = inputPipelineTargetEventSql()
        .replace(/\$\{process_name\}/g, 'com.foo')
        .replace(/\$\{event_ts\}/g, '100')
        .replace(/\$\{event_end_ts\}/g, '200');
      const selected = db.prepare(selector).get() as {
        process_name: string;
        input_event_id: number;
      };

      expect(selected.process_name).toBe('com.foo');
      expect(selected.input_event_id).toBe(2);
    } finally {
      db.close();
    }
  });
});
