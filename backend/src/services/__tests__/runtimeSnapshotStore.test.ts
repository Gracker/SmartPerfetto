// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../enterpriseDb';
import { persistAnalysisRunState } from '../analysisRunStore';
import {
  CLAUDE_SESSION_MAP_RUNTIME_TYPE,
  deleteClaudeSessionMapRuntimeSnapshot,
  deleteClaudeSessionMapRuntimeSnapshots,
  loadClaudeSessionMapFromRuntimeSnapshots,
  saveClaudeSessionMapToRuntimeSnapshots,
} from '../runtimeSnapshotStore';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

const originalDbPath = process.env[ENTERPRISE_DB_PATH_ENV];

interface RuntimeSnapshotRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  run_id: string;
  runtime_type: string;
  snapshot_json: string;
  created_at: number;
}

let tmpDir: string | undefined;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function readRuntimeSnapshots(): RuntimeSnapshotRow[] {
  const db = openEnterpriseDb(dbPath);
  try {
    return db.prepare<unknown[], RuntimeSnapshotRow>(`
      SELECT *
      FROM runtime_snapshots
      ORDER BY id
    `).all();
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-runtime-snapshot-store-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
});

afterEach(async () => {
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalDbPath);
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('runtime snapshot store', () => {
  it('fixes the run marker when a runtime snapshot creates the run row before its lifecycle', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: {codebase: false, knowledge: true},
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-order',
      runId: 'run-order',
      traceId: 'trace-a',
    }, 'session-order', {sdkSessionId: 'sdk-order', updatedAt: 1_700_000_000_000});
    persistAnalysisRunState({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a',
      sessionId: 'session-order', runId: 'run-order', traceId: 'trace-a',
      privateContext: {codebase: false, knowledge: true}}, 'completed');

    const db = openEnterpriseDb(dbPath);
    try {
      expect(db.prepare('SELECT private_context, status FROM analysis_runs WHERE id = ?').get('run-order'))
        .toEqual({private_context: 2, status: 'completed'});
    } finally {
      db.close();
    }
  });

  it('stores Claude session maps in runtime_snapshots with enterprise graph rows', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-session-a',
      updatedAt: 1_700_000_000_000,
    });

    const rows = readRuntimeSnapshots();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      session_id: 'session-a',
      run_id: 'run-a',
      runtime_type: CLAUDE_SESSION_MAP_RUNTIME_TYPE,
      created_at: 1_700_000_000_000,
    }));
    expect(JSON.parse(rows[0].snapshot_json)).toEqual({
      sessionMapKey: 'session-a',
      sdkSessionId: 'sdk-session-a',
      updatedAt: 1_700_000_000_000,
      traceId: 'trace-a',
    });

    const db = openEnterpriseDb(dbPath);
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM analysis_sessions').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM analysis_runs').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('loads the latest non-stale entry per session map key', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'old-sdk',
      updatedAt: 1_700_000_000_000,
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'new-sdk',
      updatedAt: 1_700_000_010_000,
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-stale',
      runId: 'run-stale',
      traceId: 'trace-stale',
    }, 'session-stale', {
      sdkSessionId: 'stale-sdk',
      updatedAt: 1_699_000_000_000,
    });

    const map = loadClaudeSessionMapFromRuntimeSnapshots(
      60_000,
      1_700_000_020_000,
    );

    expect(map.get('session-a')).toEqual({
      sdkSessionId: 'new-sdk',
      updatedAt: 1_700_000_010_000,
    });
    expect(map.has('session-stale')).toBe(false);
    expect(readRuntimeSnapshots()).toHaveLength(2);
  });

  it('deletes all Claude session map rows for a SmartPerfetto session', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-a',
      updatedAt: 1_700_000_000_000,
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a:ref:trace-b', {
      sdkSessionId: 'sdk-b',
      updatedAt: 1_700_000_000_100,
    });

    expect(deleteClaudeSessionMapRuntimeSnapshots('session-a')).toBe(2);
    expect(readRuntimeSnapshots()).toHaveLength(0);
  });

  it('deletes only one Claude session map row by session map key', () => {
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a', {
      sdkSessionId: 'sdk-a',
      updatedAt: 1_700_000_000_000,
    });
    saveClaudeSessionMapToRuntimeSnapshots({
      privateContext: NO_PRIVATE_CONTEXT,
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
    }, 'session-a:ref:trace-b', {
      sdkSessionId: 'sdk-b',
      updatedAt: 1_700_000_000_100,
    });

    expect(deleteClaudeSessionMapRuntimeSnapshot('session-a', 'session-a:ref:trace-b')).toBe(1);

    const rows = readRuntimeSnapshots();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].snapshot_json)).toEqual(expect.objectContaining({
      sessionMapKey: 'session-a',
      sdkSessionId: 'sdk-a',
    }));
  });
});
