// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import { applyEnterpriseMinimalSchema } from '../enterpriseSchema';
import {
  createAnalysisResultWindowStateRepository,
  type AnalysisResultWindowStateRepository,
} from '../analysisResultWindowStateStore';

const userA = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' };
const userB = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-b' };

let db: Database.Database;
let repository: AnalysisResultWindowStateRepository;

function seedSnapshot(id: string, createdBy: string, visibility: 'private' | 'workspace'): void {
  // Window state reads only a snapshot's scope, owner and visibility; the
  // trace/session/run graph a real snapshot hangs off is irrelevant here.
  db.pragma('foreign_keys = OFF');
  db.prepare(`
    INSERT INTO analysis_result_snapshots
      (id, tenant_id, workspace_id, trace_id, session_id, run_id, created_by, visibility,
       scene_type, title, user_query, trace_label, trace_metadata_json, summary_json,
       status, schema_version, created_at)
    VALUES (?, 'tenant-a', 'workspace-a', 'trace', 'session', 'run', ?, ?,
            'startup', 'title', 'query', 'label', '{}', '{}', 'ready', 'v1', 1)
  `).run(id, createdBy, visibility);
  db.pragma('foreign_keys = ON');
}

function heartbeat(
  scope: typeof userA,
  windowId: string,
  latestSnapshotId?: string,
): void {
  repository.upsertWindowState(
    scope,
    {
      windowId,
      traceId: `trace-${scope.userId}`,
      backendTraceId: `backend-${scope.userId}`,
      activeSessionId: `session-${scope.userId}`,
      latestSnapshotId,
      traceTitle: `Title of ${scope.userId}`,
      sceneType: 'startup',
      metadata: { owner: scope.userId },
    },
    { ensureScopeGraph: true },
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  applyEnterpriseMinimalSchema(db);
  repository = createAnalysisResultWindowStateRepository(db);
});

afterEach(() => {
  db.close();
});

describe('analysis result window state identity', () => {
  test('the same window id under two users is two independent windows', () => {
    heartbeat(userA, 'window-shared', 'snapshot-a');
    heartbeat(userB, 'window-shared', 'snapshot-b');

    expect(repository.getWindowState(userA, 'window-shared')).toMatchObject({
      userId: 'user-a',
      activeSessionId: 'session-user-a',
      latestSnapshotId: 'snapshot-a',
    });
    expect(repository.getWindowState(userB, 'window-shared')).toMatchObject({
      userId: 'user-b',
      latestSnapshotId: 'snapshot-b',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analysis_result_window_states').get())
      .toEqual({ count: 2 });
  });

  test('a user cannot read another user window through its id', () => {
    heartbeat(userA, 'window-a', 'snapshot-a');

    expect(repository.getWindowState(userB, 'window-a')).toBeNull();
  });

  test('refuses window state without an authenticated user', () => {
    const anonymous = { tenantId: 'tenant-a', workspaceId: 'workspace-a' };

    expect(() => repository.upsertWindowState(anonymous, { windowId: 'window-a' }, {
      ensureScopeGraph: true,
    })).toThrow('requires an authenticated user');
    expect(() => repository.listActiveWindowStates(anonymous)).toThrow('requires an authenticated user');
  });
});

describe('analysis result window state listing', () => {
  test('shows another user window only as a pointer to a result the reader can read', () => {
    seedSnapshot('snapshot-shared', 'user-a', 'workspace');
    seedSnapshot('snapshot-private', 'user-a', 'private');
    heartbeat(userA, 'window-shared', 'snapshot-shared');
    heartbeat(userA, 'window-private', 'snapshot-private');
    heartbeat(userA, 'window-empty');

    const seenByB = repository.listActiveWindowStates(userB);

    expect(seenByB).toEqual([
      {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        windowId: 'window-shared',
        userId: 'user-a',
        latestSnapshotId: 'snapshot-shared',
        sceneType: 'startup',
        metadata: {},
        updatedAt: expect.any(Number),
        expiresAt: expect.any(Number),
      },
    ]);
  });

  test('shows the reader own windows in full, including private results', () => {
    seedSnapshot('snapshot-private', 'user-a', 'private');
    heartbeat(userA, 'window-private', 'snapshot-private');
    heartbeat(userA, 'window-empty');

    const seenByA = repository.listActiveWindowStates(userA);

    expect(seenByA.map(state => state.windowId).sort()).toEqual(['window-empty', 'window-private']);
    expect(seenByA.find(state => state.windowId === 'window-private')).toMatchObject({
      traceId: 'trace-user-a',
      backendTraceId: 'backend-user-a',
      activeSessionId: 'session-user-a',
      traceTitle: 'Title of user-a',
      metadata: { owner: 'user-a' },
    });
  });

  test('excludes only the reader own window with the excluded id', () => {
    seedSnapshot('snapshot-a', 'user-a', 'workspace');
    heartbeat(userA, 'window-shared', 'snapshot-a');
    heartbeat(userB, 'window-shared');

    expect(repository.listActiveWindowStates(userB, { excludeWindowId: 'window-shared' })
      .map(state => [state.userId, state.windowId]))
      .toEqual([['user-a', 'window-shared']]);
  });

  test('omits expired windows', () => {
    heartbeat(userA, 'window-a');

    expect(repository.listActiveWindowStates(userA, { now: Date.now() + 11 * 60 * 1000 }))
      .toEqual([]);
  });
});
