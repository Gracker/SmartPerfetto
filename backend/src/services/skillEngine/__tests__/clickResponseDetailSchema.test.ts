// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';
import {completeAndroidInputEventsFixture} from '../../../../tests/helpers/androidInputEventsFixture';
import {renderStepSql, withStepFragments} from '../../../../tests/helpers/skillFragmentSql';

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

  type TargetRow = {process_name: string; event_count: number; app_delivery_events: number; max_total_ms: number};
  const renderStep = (stepId: string, vars: Record<string, string | number>) => {
    const step = analysisSkill.steps.find((candidate: any) => candidate.id === stepId);
    return renderStepSql(String(step.sql), step.sql_fragments, {start_ts: 'NULL', end_ts: 'NULL', ...vars});
  };
  const selectTarget = (db: Database.Database, packageName: string, startTs: string | number = 'NULL') =>
    db.prepare(renderStep('get_process', {package: packageName, start_ts: startTs})).all() as TargetRow[];
  const runForTarget = (db: Database.Database, stepId: string, target: TargetRow, startTs: string | number = 'NULL') =>
    db.prepare(renderStep(stepId, {start_ts: startTs, 'target_process.data[0].process_name': target.process_name}))
      .all() as Array<Record<string, unknown>>;

  const createInputFixture = (rows: string): Database.Database => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_input_events (
        upid INTEGER, process_name TEXT, event_channel TEXT, input_event_id TEXT,
        event_action TEXT, total_latency_dur INTEGER,
        dispatch_ts INTEGER, receive_ts INTEGER, receive_dur INTEGER
      );
      INSERT INTO android_input_events VALUES ${rows};
    `);
    completeAndroidInputEventsFixture(db);
    return db;
  };

  // The tapped app gets the actioned row of each physical event; systemui
  // observes each one on a gesture monitor plus once on the navigation bar.
  const createFixture = () => createInputFixture(`
    (1, 'com.example.app', 'app (server)', '1', 'ACTION_DOWN', 1000000, 100, 110, 10),
    (1, 'com.example.app', 'app (server)', '2', 'ACTION_UP', 1000000, 200, 210, 10),
    (2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', '1', NULL, 3000000, 100, 110, 10),
    (2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', '2', NULL, 3000000, 200, 210, 10),
    (2, 'com.android.systemui', 'NavigationBar0 (server)', '1', NULL, 3000000, 100, 110, 10)`);

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
      const roles = db.prepare(renderStepSql(
        'SELECT delivery_role FROM android_input_scoped_deliveries',
        getProcess.sql_fragments,
        {start_ts: 100, end_ts: 'NULL'},
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

  // No receiver carries an action (pre-sync runtime on the surface-view trace,
  // no `view` atrace, or a multi-process app the stdlib cannot join). Timing
  // is irrelevant to ranking, so every row shares it.
  const unresolved = (upid: number, processName: string, channel: string, eventId: string, latency = 1) =>
    `(${upid}, '${processName}', '${channel}', '${eventId}', NULL, ${latency}, 100, 110, 10)`;
  const appWindow = '32c6ecb com.tencent.mm/com.tencent.mm.plugin.lite.ui.WxaLiteAppLiteUI (server)';

  it('derives the stdlib window owner and keeps unresolved events only on owned windows', () => {
    const db = createInputFixture([
      unresolved(1, 'com.tencent.mm', appWindow, '1'),
      unresolved(2, 'com.tencent.mm:appbrand0', 'a1 com.tencent.mm/com.tencent.mm.plugin.appbrand.ui.AppBrandUI00', '2'),
      unresolved(3, 'com.tencent.mmx', 'b2 com.tencent.mm/com.tencent.mm.Other', '3'),
      unresolved(4, 'com.android.systemui', 'f4033a5 com.android.systemui.wallpapers.ImageWallpaper', '4'),
      unresolved(4, 'com.android.systemui', 'e620163 NavigationBar0 (server)', '4'),
      unresolved(4, 'com.android.systemui', '[Gesture Monitor] swipe-to-screenshot (server)', '4'),
      unresolved(5, 'system_server', 'PointerEventDispatcher0 (server)', '4'),
      unresolved(5, 'system_server', 'PointerEventDispatcher0', '4'),
    ].join(','));
    try {
      const rows = db.prepare(renderStepSql(
        'SELECT process_name, window_owner, unresolved_window_event_key FROM android_input_event_deliveries ORDER BY upid, event_channel',
        getProcess.sql_fragments,
        {start_ts: 'NULL', end_ts: 'NULL'},
      )).all();

      expect(rows).toEqual([
        {process_name: 'com.tencent.mm', window_owner: 'com.tencent.mm', unresolved_window_event_key: '1'},
        {process_name: 'com.tencent.mm:appbrand0', window_owner: 'com.tencent.mm', unresolved_window_event_key: '2'},
        {process_name: 'com.tencent.mmx', window_owner: 'com.tencent.mm', unresolved_window_event_key: null},
        {process_name: 'com.android.systemui', window_owner: 'Monitor]', unresolved_window_event_key: null},
        {process_name: 'com.android.systemui', window_owner: 'NavigationBar0', unresolved_window_event_key: null},
        {process_name: 'com.android.systemui', window_owner: 'com.android.systemui.wallpapers.ImageWallpaper', unresolved_window_event_key: null},
        {process_name: 'system_server', window_owner: null, unresolved_window_event_key: null},
        {process_name: 'system_server', window_owner: '(server)', unresolved_window_event_key: null},
      ]);
    } finally {
      db.close();
    }
  });

  it('prefers the window owner over monitors that tie on unresolved events and lead on latency', () => {
    // Surface-view trace on the v58.2 runtime: every receiver sees the same events.
    const db = createInputFixture(['1', '2'].flatMap(eventId => [
      unresolved(1, 'com.tencent.mm', appWindow, eventId, 1000000),
      unresolved(2, 'com.android.systemui', '[Gesture Monitor] swipe-to-screenshot (server)', eventId, 3000000),
      unresolved(3, 'system_server', 'PointerEventDispatcher0 (server)', eventId, 2000000),
    ]).join(','));
    try {
      expect(selectTarget(db, '')).toMatchObject([{process_name: 'com.tencent.mm', app_delivery_events: 0}]);
      expect(selectTarget(db, 'com.android.systemui')).toMatchObject([{process_name: 'com.android.systemui'}]);
    } finally {
      db.close();
    }
  });

  it('prefers a child process on its package window over a monitor that saw more events', () => {
    // The monitor also sees the navigation-bar touch the app never received.
    const appBrandWindow = 'a1 com.tencent.mm/com.tencent.mm.plugin.appbrand.ui.AppBrandUI00 (server)';
    const db = createInputFixture([
      ...['1', '2'].map(eventId => unresolved(1, 'com.tencent.mm:appbrand0', appBrandWindow, eventId, 1000000)),
      ...['1', '2', '3'].map(eventId => unresolved(2, 'system_server', '[Gesture Monitor] OplusExInputReceiver1', eventId, 3000000)),
    ].join(','));
    try {
      expect(selectTarget(db, '')).toMatchObject([{process_name: 'com.tencent.mm:appbrand0'}]);
    } finally {
      db.close();
    }
  });
  // A launcher owns its activity window and its own gesture monitor. Events 1-3
  // resolve an action on the window and are copied to the monitor; events 4-5
  // resolve no action anywhere and reach both channels; event 6 (FOCUS) reaches
  // only the window. systemui observes 1-5 on its own monitor.
  const createOwnMonitorFixture = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE android_input_events (
        upid INTEGER, process_name TEXT, event_channel TEXT, normalized_event_channel TEXT, input_event_id TEXT,
        event_type TEXT, event_action TEXT, total_latency_dur INTEGER,
        dispatch_ts INTEGER, receive_ts INTEGER, receive_dur INTEGER
      );
    `);
    const insert = db.prepare('INSERT INTO android_input_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10)');
    const deliver = (upid: number, processName: string, channel: string, id: number,
      eventType: string, action: string | null, latencyMs: number) =>
      insert.run(upid, processName, channel, channel, String(id), eventType, action, latencyMs * 1_000_000,
        id * 100, id * 100 + 5);
    const launcher = 'com.example.launcher';
    ['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].forEach((action, index) =>
      deliver(1, launcher, 'Launcher (server)', index + 1, 'MOTION', action, 2));
    [4, 5].forEach(id => deliver(1, launcher, 'Launcher (server)', id, 'MOTION', null, 4));
    deliver(1, launcher, 'Launcher (server)', 6, 'FOCUS', null, 1);
    [1, 2, 3, 4, 5].forEach(id => deliver(1, launcher, '[Gesture Monitor] swipe-up (server)', id, 'MOTION', null, 9));
    [1, 2, 3, 4, 5].forEach(id =>
      deliver(2, 'com.android.systemui', '[Gesture Monitor] edge-swipe (server)', id, 'MOTION', null, 3));
    completeAndroidInputEventsFixture(db);
    return db;
  };

  it('analyzes only the target application channel when it also owns a monitor', () => {
    const db = createOwnMonitorFixture();
    try {
      const [target] = selectTarget(db, '');
      expect(target).toEqual({
        process_name: 'com.example.launcher', event_count: 6, app_delivery_events: 3, max_total_ms: 4,
      });
      expect(runForTarget(db, 'input_latency_overview', target)).toEqual([
        expect.objectContaining({total_events: 6, avg_total_ms: 2.5, max_total_ms: 4}),
      ]);
      expect(runForTarget(db, 'latency_by_window', target)).toEqual([
        expect.objectContaining({window: 'Launcher (server)', count: 6, max_latency_ms: 4}),
      ]);
      expect(runForTarget(db, 'latency_by_event_type', target).map(row => [row.event_type, row.event_action, row.count]))
        .toEqual(expect.arrayContaining([['MOTION', null, 2], ['FOCUS', null, 1], ['MOTION', 'DOWN', 1]]));
      expect(runForTarget(db, 'latency_distribution', target)).toEqual([
        {latency_bucket: '<16ms (极快)', count: 6, percent: 100},
      ]);
    } finally {
      db.close();
    }
  });

  it('recognizes a monitor channel whose copies lie outside the caller window', () => {
    const db = createOwnMonitorFixture();
    try {
      // Only events 4-6 are inside; the monitor's copies of 1-3 are not.
      const [target] = selectTarget(db, '', 350);
      expect(target).toMatchObject({process_name: 'com.example.launcher', event_count: 3, app_delivery_events: 0});
      expect(runForTarget(db, 'input_latency_overview', target, 350)).toEqual([
        expect.objectContaining({total_events: 3, max_total_ms: 4}),
      ]);
    } finally {
      db.close();
    }
  });

  it('leaves out a same-named instance that only observed input', () => {
    const db = createOwnMonitorFixture();
    try {
      // A second launcher process (upid 3) that only observed events 1-3 on its monitor.
      db.exec(`
        INSERT INTO android_input_events(upid, process_name, event_channel, normalized_event_channel,
          input_event_id, event_type, event_action, total_latency_dur, dispatch_ts, receive_ts, receive_dur)
        VALUES (3, 'com.example.launcher', '[Gesture Monitor] swipe-up (server)', '[Gesture Monitor] swipe-up (server)',
          '1', 'MOTION', NULL, 20000000, 101, 106, 10),
          (3, 'com.example.launcher', '[Gesture Monitor] swipe-up (server)', '[Gesture Monitor] swipe-up (server)',
          '2', 'MOTION', NULL, 20000000, 201, 206, 10);
      `);
      const [target] = selectTarget(db, '');
      expect(target).toMatchObject({process_name: 'com.example.launcher', event_count: 6, max_total_ms: 4});
      expect(runForTarget(db, 'input_latency_overview', target)).toEqual([
        expect.objectContaining({total_events: 6, max_total_ms: 4}),
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps every receiver when no event in the trace resolves an action', () => {
    const db = createOwnMonitorFixture();
    try {
      // Without action evidence no channel can be shown to be a monitor.
      db.exec('UPDATE android_input_events SET event_action = NULL');
      const [target] = selectTarget(db, 'com.example.launcher');
      expect(target).toMatchObject({event_count: 11, app_delivery_events: 0});
    } finally {
      db.close();
    }
  });

  it('keeps every observation of an explicit target that only observes input', () => {
    const db = createOwnMonitorFixture();
    try {
      const [target] = selectTarget(db, 'com.android.systemui');
      expect(target).toMatchObject({event_count: 5, app_delivery_events: 0, max_total_ms: 3});
      expect(runForTarget(db, 'input_latency_overview', target)).toEqual([
        expect.objectContaining({total_events: 5}),
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
