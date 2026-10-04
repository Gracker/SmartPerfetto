// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import {
  authenticate,
} from '../../middleware/auth';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID} from '../../utils/localDevIdentity';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import { openEnterpriseDb } from '../../services/enterpriseDb';
import workspaceWindowRoutes from '../workspaceWindowRoutes';

const originalEnv = {
  dbPath: process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH,
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

let tempDir: string;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function app(): express.Express {
  const server = express();
  server.use(express.json());
  server.use(
    '/api/workspaces/:workspaceId/windows',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    workspaceWindowRoutes,
  );
  return server;
}

function seedGraph({
  tenantId = DEFAULT_TENANT_ID,
  workspaceId = 'workspace-a',
  userId = DEFAULT_DEV_USER_ID,
  email = 'dev@example.test',
}: {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  email?: string;
} = {}): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(tenantId, tenantId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workspaceId, tenantId, workspaceId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, tenantId, email, userId, userId, now, now);
  db.close();
}

function clearGraph(): void {
  const db = openEnterpriseDb(dbPath);
  db.prepare('DELETE FROM organizations').run();
  db.close();
}

function trustedSsoHeaders(
  req: request.Test,
  workspaceId = 'workspace-a',
  userId = 'user-a',
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'analysis_result:read');
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-window-routes-'));
  dbPath = path.join(tempDir, 'enterprise.db');
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
  delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
  delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  delete process.env.SMARTPERFETTO_API_KEY;
  seedGraph();
});

afterEach(async () => {
  restoreEnvValue('SMARTPERFETTO_ENTERPRISE_DB_PATH', originalEnv.dbPath);
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('workspace window routes', () => {
  test('persists heartbeat and returns active peer windows', async () => {
    await request(app())
      .post('/api/workspaces/workspace-a/windows/window-a/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        traceId: 'trace-a',
        backendTraceId: 'trace-a',
        activeSessionId: 'session-a',
        latestSnapshotId: 'snapshot-a',
        traceTitle: 'Trace A',
        sceneType: 'startup',
      })
      .expect(200);

    const response = await request(app())
      .post('/api/workspaces/workspace-a/windows/window-b/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        traceId: 'trace-b',
        latestSnapshotId: 'snapshot-b',
        traceTitle: 'Trace B',
        sceneType: 'scrolling',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.windowState.windowId).toBe('window-b');
    expect(response.body.windowState.latestSnapshotId).toBe('snapshot-b');
    expect(response.body.activeWindows.map((item: any) => item.windowId)).toEqual(['window-a']);
    expect(response.body.activeWindows[0].latestSnapshotId).toBe('snapshot-a');
  });

  test('persists heartbeat before any workspace rows exist locally', async () => {
    clearGraph();

    const response = await request(app())
      .post('/api/workspaces/workspace-a/windows/window-a/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        traceId: 'trace-a',
        latestSnapshotId: 'snapshot-a',
        sceneType: 'startup',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.windowState.windowId).toBe('window-a');
    expect(response.body.windowState.latestSnapshotId).toBe('snapshot-a');

    const db = openEnterpriseDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    db.close();
  });

  test('does not auto-create a missing workspace in enterprise mode', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    clearGraph();

    const response = await trustedSsoHeaders(
      request(app()).post('/api/workspaces/workspace-missing/windows/window-a/heartbeat'),
      'workspace-missing',
    )
      .send({
        traceId: 'trace-a',
        latestSnapshotId: 'snapshot-a',
        sceneType: 'startup',
      })
      .expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: 'Workspace not found',
    });

    const db = openEnterpriseDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS count FROM organizations').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analysis_result_window_states').get()).toEqual({ count: 0 });
    db.close();
  });

  test('persists heartbeat for an existing workspace in enterprise mode', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    clearGraph();
    seedGraph({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      email: 'user-a@example.test',
    });

    const response = await trustedSsoHeaders(
      request(app()).post('/api/workspaces/workspace-a/windows/window-a/heartbeat'),
    )
      .send({
        traceId: 'trace-a',
        latestSnapshotId: 'snapshot-a',
        sceneType: 'startup',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.windowState.workspaceId).toBe('workspace-a');
    expect(response.body.windowState.latestSnapshotId).toBe('snapshot-a');
  });

  test('lists active windows while excluding the requester', async () => {
    await request(app())
      .post('/api/workspaces/workspace-a/windows/window-a/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ latestSnapshotId: 'snapshot-a', sceneType: 'startup' })
      .expect(200);

    const response = await request(app())
      .get('/api/workspaces/workspace-a/windows/active?excludeWindowId=window-a')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.activeWindows).toEqual([]);
  });

  test('another user heartbeating a listed window id cannot take over that window', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    clearGraph();
    seedGraph({ tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a' });
    const asUser = (req: request.Test, userId: string) => trustedSsoHeaders(req, 'workspace-a', userId);

    await asUser(request(app()).post('/api/workspaces/workspace-a/windows/window-a/heartbeat'), 'user-a')
      .send({ traceId: 'trace-a', activeSessionId: 'session-a', traceTitle: 'A private trace' })
      .expect(200);

    const listedToB = await asUser(request(app()).get('/api/workspaces/workspace-a/windows/active'), 'user-b')
      .expect(200);
    // A's window points at no result B can read, so B is not told it exists.
    expect(listedToB.body.activeWindows).toEqual([]);

    const hijack = await asUser(
      request(app()).post('/api/workspaces/workspace-a/windows/window-a/heartbeat'),
      'user-b',
    )
      .send({ traceId: 'trace-b', activeSessionId: 'session-b' })
      .expect(200);
    expect(hijack.body.windowState).toMatchObject({ userId: 'user-b', windowId: 'window-a', traceId: 'trace-b' });

    const seenByA = await asUser(request(app()).get('/api/workspaces/workspace-a/windows/active'), 'user-a')
      .expect(200);
    expect(seenByA.body.activeWindows).toEqual([
      expect.objectContaining({
        userId: 'user-a',
        windowId: 'window-a',
        traceId: 'trace-a',
        activeSessionId: 'session-a',
        traceTitle: 'A private trace',
      }),
    ]);
  });

  test('rejects invalid heartbeat scene type', async () => {
    await request(app())
      .post('/api/workspaces/workspace-a/windows/window-a/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ sceneType: 'bad' })
      .expect(400);
  });
});
