// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import Database from 'better-sqlite3';

import {androidInputEventsTableDdl} from '../../../tests/helpers/androidInputEventsFixture';
import {agentRoutesSceneDetectionTestSeam} from '../agentRoutes';

type SceneTps = Parameters<typeof agentRoutesSceneDetectionTestSeam.detectScrollSessions>[0];

const MS = 1_000_000;

/**
 * One touch gesture whose physical events each reach the app window, systemui's
 * gesture monitor and navigation bar, and the pointer dispatcher, followed by a
 * run of frames — the shape of a tap on the launcher in a cold-launch trace.
 */
function gestureTrace(actions: readonly string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`${androidInputEventsTableDdl()}
    CREATE TABLE actual_frame_timeline_slice(ts INTEGER, dur INTEGER, jank_type TEXT, surface_frame_token INTEGER);`);
  const insert = db.prepare(`INSERT INTO android_input_events(upid, process_name, event_channel, input_event_id,
    event_type, event_action, read_time, dispatch_ts) VALUES (?, ?, ?, ?, 'MOTION', ?, ?, ?)`);
  actions.forEach((action, index) => {
    const ts = 1000 * MS + index * 10 * MS;
    insert.run(1, 'com.example.app', 'a1 com.example.app/.Main (server)', String(index), `ACTION_${action}`, ts, ts);
    insert.run(2, 'com.android.systemui', '[Gesture Monitor] swipe (server)', String(index), null, ts, ts);
    insert.run(2, 'com.android.systemui', 'NavigationBar0 (server)', String(index), null, ts, ts);
    insert.run(3, 'system_server', 'PointerEventDispatcher0 (server)', String(index), null, ts, ts);
  });
  const frame = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES (?, 10000000, NULL, ?)');
  for (let k = 0; k < 15; k++) frame.run(1000 * MS + k * 16 * MS, k + 1);
  return db;
}

async function detect(db: Database.Database) {
  const tps = {
    query: async (_traceId: string, sql: string) => ({
      columns: [], rows: db.prepare(sql).raw().all() as unknown[][], durationMs: 0,
    }),
  } as unknown as SceneTps;
  return agentRoutesSceneDetectionTestSeam.detectScrollSessions(tps, 'trace');
}

describe('legacy scroll scene detection', () => {
  it('does not read a tap as a scroll gesture because monitors repeat its events', async () => {
    // Two physical events, eight rows.
    const db = gestureTrace(['DOWN', 'UP']);
    try {
      expect(await detect(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('detects a gesture of four physical events', async () => {
    const db = gestureTrace(['DOWN', 'MOVE', 'MOVE', 'UP']);
    try {
      expect(await detect(db)).toEqual([expect.objectContaining({type: 'scroll', startTs: String(1000 * MS)})]);
    } finally {
      db.close();
    }
  });
});
