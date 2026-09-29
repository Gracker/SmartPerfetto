// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import {loadPerfettoSqlDocsAsset} from '../../src/services/perfettoSqlDocs';

/**
 * Columns of the stdlib `android_input_events` table, from the generated
 * Perfetto SQL docs of the pinned runtime. Skills read it only through
 * `fragments/android_input_events_normalized.sql`, which names every column,
 * so a SQLite stand-in must carry the full schema.
 */
function androidInputEventsColumns(): Array<readonly [string, 'INTEGER' | 'TEXT']> {
  const entry = loadPerfettoSqlDocsAsset()?.entries.find(candidate => candidate.id === 'stdlib.android.input.android_input_events');
  if (!entry?.columns?.length) throw new Error('perfettoSqlDocs.json has no android_input_events columns');
  return entry.columns.map(column => [column.name, column.type === 'STRING' ? 'TEXT' : 'INTEGER'] as const);
}

/** CREATE TABLE for a full-schema `android_input_events` stand-in. */
export function androidInputEventsTableDdl(): string {
  return `CREATE TABLE android_input_events(${androidInputEventsColumns().map(([name, type]) => `${name} ${type}`).join(', ')});`;
}

/**
 * Add the stdlib columns a narrow fixture table left out, as NULL. Call it after
 * positional INSERTs into the narrow table and before running Skill SQL.
 */
export function completeAndroidInputEventsFixture(db: Database.Database): void {
  const present = new Set((db.prepare('PRAGMA table_info(android_input_events)').all() as Array<{name: string}>)
    .map(column => column.name));
  for (const [name, type] of androidInputEventsColumns()) {
    if (!present.has(name)) db.exec(`ALTER TABLE android_input_events ADD COLUMN ${name} ${type}`);
  }
}

/** Adds one delivery of physical event `id`: dispatched at id*100, received id*100+5 for 10 ns. */
export type InputDelivery = (upid: number, processName: string, channel: string, id: number,
  eventType: string, action: string | null, latencyMs: number) => void;

/**
 * A launcher owns its activity window and its own gesture monitor. Events 1-3
 * resolve an action on the window and are copied to the monitor; events 4-5
 * resolve no action anywhere and reach both channels; event 6 (FOCUS) reaches
 * only the window. systemui observes 1-5 on its own monitor. Monitor rows are
 * slower (9 ms) than any window row (at most 4 ms).
 */
export function createOwnMonitorInputFixture(): {db: Database.Database; deliver: InputDelivery} {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE android_input_events (
      upid INTEGER, process_name TEXT, event_channel TEXT, normalized_event_channel TEXT, input_event_id TEXT,
      event_type TEXT, event_action TEXT, total_latency_dur INTEGER,
      dispatch_ts INTEGER, receive_ts INTEGER, receive_dur INTEGER
    );
  `);
  // Named columns so deliver() still works after the table is completed.
  const insert = db.prepare(`INSERT INTO android_input_events (upid, process_name, event_channel,
    normalized_event_channel, input_event_id, event_type, event_action, total_latency_dur,
    dispatch_ts, receive_ts, receive_dur) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 10)`);
  const deliver: InputDelivery = (upid, processName, channel, id, eventType, action, latencyMs) => {
    insert.run(upid, processName, channel, channel, String(id), eventType, action, latencyMs * 1_000_000,
      id * 100, id * 100 + 5);
  };
  const launcher = 'com.example.launcher';
  ['ACTION_DOWN', 'ACTION_MOVE', 'ACTION_UP'].forEach((action, index) =>
    deliver(1, launcher, 'Launcher (server)', index + 1, 'MOTION', action, 2));
  [4, 5].forEach(id => deliver(1, launcher, 'Launcher (server)', id, 'MOTION', null, 4));
  deliver(1, launcher, 'Launcher (server)', 6, 'FOCUS', null, 1);
  [1, 2, 3, 4, 5].forEach(id => deliver(1, launcher, '[Gesture Monitor] swipe-up (server)', id, 'MOTION', null, 9));
  [1, 2, 3, 4, 5].forEach(id =>
    deliver(2, 'com.android.systemui', '[Gesture Monitor] edge-swipe (server)', id, 'MOTION', null, 3));
  completeAndroidInputEventsFixture(db);
  return {db, deliver};
}
