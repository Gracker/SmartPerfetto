// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../types/multiTraceComparison';
import {
  authenticate,
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
} from '../../middleware/auth';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import { openEnterpriseDb } from '../../services/enterpriseDb';
import { createAnalysisResultSnapshotRepository } from '../../services/analysisResultSnapshotStore';
import analysisResultRoutes from '../analysisResultRoutes';
import {getRegisteredScenes} from '../../agentv3/strategyLoader';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';

const originalDbPath = process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;

let tempDir: string;
let dbPath: string;

function app(): express.Express {
  const server = express();
  server.use(express.json());
  server.use(
    '/api/workspaces/:workspaceId/analysis-results',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    analysisResultRoutes,
  );
  return server;
}

function snapshot(overrides: Partial<AnalysisResultSnapshot>): AnalysisResultSnapshot {
  const id = overrides.id || 'snapshot-a';
  return {
    id,
    tenantId: DEFAULT_TENANT_ID,
    workspaceId: 'workspace-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    runId: 'run-a',
    createdBy: DEFAULT_DEV_USER_ID,
    visibility: 'private',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'startup',
    title: id,
    userQuery: 'analyze startup',
    traceLabel: 'trace-a',
    traceMetadata: {},
    summary: { headline: 'ok' },
    conclusionContract: {
      claims: [{
        id: 'Q1',
        text: 'Startup total duration is 123ms',
        references: [{ evidenceRefId: 'data:startup:summary', sourceRef: '表 1' }],
      }],
    },
    metrics: [{
      key: 'startup.total_ms',
      label: 'Startup total duration',
      group: 'startup',
      value: 123,
      unit: 'ms',
      direction: 'lower_is_better',
      aggregation: 'single',
      confidence: 0.9,
      source: { type: 'skill' },
    }],
    evidenceRefs: [],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function seedGraph(): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, now, now);
  for (const workspaceId of ['workspace-a', 'workspace-b']) {
    db.prepare(`
      INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workspaceId, DEFAULT_TENANT_ID, workspaceId, now, now);
  }
  db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, 'dev@example.test', 'Dev', 'dev', now, now);
  for (const [workspaceId, traceId, sessionId, runId] of [
    ['workspace-a', 'trace-a', 'session-a', 'run-a'],
    ['workspace-a', 'trace-b', 'session-b', 'run-b'],
    ['workspace-b', 'trace-c', 'session-c', 'run-c'],
  ]) {
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, status, created_at)
      VALUES
        (?, ?, ?, ?, ?, 'ready', ?)
    `).run(traceId, DEFAULT_TENANT_ID, workspaceId, DEFAULT_DEV_USER_ID, `/tmp/${traceId}`, now);
    db.prepare(`
      INSERT INTO analysis_sessions
        (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, 'private', 'completed', ?, ?)
    `).run(sessionId, DEFAULT_TENANT_ID, workspaceId, traceId, DEFAULT_DEV_USER_ID, sessionId, now, now);
    db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
      VALUES
        (?, ?, ?, ?, 'agent', 'completed', 'analyze', ?, ?)
    `).run(runId, DEFAULT_TENANT_ID, workspaceId, sessionId, now, now);
  }
  const repo = createAnalysisResultSnapshotRepository(db);
  repo.createSnapshot(snapshot({ id: 'snapshot-a' }));
  repo.createSnapshot(snapshot({
    id: 'snapshot-b',
    traceId: 'trace-b',
    sessionId: 'session-b',
    runId: 'run-b',
    sceneType: 'scrolling',
    visibility: 'workspace',
    createdAt: now + 1,
  }));
  repo.createSnapshot(snapshot({
    id: 'snapshot-c',
    workspaceId: 'workspace-b',
    traceId: 'trace-c',
    sessionId: 'session-c',
    runId: 'run-c',
  }));
  db.close();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-analysis-results-'));
  dbPath = path.join(tempDir, 'enterprise.db');
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
  seedGraph();
});

afterEach(async () => {
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = originalDbPath;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('analysis result routes', () => {
  test('lists readable snapshots in workspace scope', async () => {
    const response = await request(app())
      .get('/api/workspaces/workspace-a/analysis-results')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.results.map((item: any) => item.id).sort()).toEqual([
      'snapshot-a',
      'snapshot-b',
    ]);
    expect(response.body.results[0]).not.toHaveProperty('conclusionContract');
  });

  test('returns full snapshot detail with conclusion contract on explicit read', async () => {
    const response = await request(app())
      .get('/api/workspaces/workspace-a/analysis-results/snapshot-a')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.snapshot.id).toBe('snapshot-a');
    expect(response.body.snapshot.conclusionContract).toEqual(expect.objectContaining({
      claims: [expect.objectContaining({ id: 'Q1' })],
    }));
  });

  test('supports scene and trace filters without leaking other workspaces', async () => {
    const response = await request(app())
      .get('/api/workspaces/workspace-a/analysis-results?sceneType=scrolling&traceId=trace-b')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(response.body.results.map((item: any) => item.id)).toEqual(['snapshot-b']);
  });

  test('rejects invalid filters', async () => {
    await request(app())
      .get('/api/workspaces/workspace-a/analysis-results?sceneType=bad')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(400);
  });

  test('filters every registered scene ID and retains the legacy CPU snapshot category', async () => {
    const db = openEnterpriseDb(dbPath);
    try {
      for (const sceneType of new Set([...getRegisteredScenes().map(scene => scene.scene), 'cpu'])) {
        db.prepare('UPDATE analysis_result_snapshots SET scene_type = ? WHERE id = ?').run(sceneType, 'snapshot-a');
        const response = await request(app())
          .get('/api/workspaces/workspace-a/analysis-results')
          .query({sceneType})
          .set('x-tenant-id', DEFAULT_TENANT_ID)
          .expect(200);
        expect(response.body.results).toEqual(expect.arrayContaining([expect.objectContaining({id: 'snapshot-a', sceneType})]));
        expect(response.body.results.every((item: {sceneType: string}) => item.sceneType === sceneType)).toBe(true);
      }
    } finally {db.close();}
  });

  test('updates owned snapshot visibility', async () => {
    const response = await request(app())
      .patch('/api/workspaces/workspace-a/analysis-results/snapshot-a')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ visibility: 'workspace' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.snapshot.visibility).toBe('workspace');
    expect(response.body.snapshot.id).toBe('snapshot-a');
  });

  test('refuses to share a snapshot whose analysis read private source or knowledge', async () => {
    const db = openEnterpriseDb(dbPath);
    try {
      createAnalysisResultSnapshotRepository(db).createSnapshot(snapshot({
        id: 'snapshot-private', privateContext: {codebase: true, knowledge: false},
      }));
    } finally {
      db.close();
    }

    const refused = await request(app())
      .patch('/api/workspaces/workspace-a/analysis-results/snapshot-private')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ visibility: 'workspace' })
      .expect(409);
    expect(refused.body).toMatchObject({success: false, code: 'PRIVATE_CONTEXT_NOT_SHAREABLE'});

    const read = await request(app())
      .get('/api/workspaces/workspace-a/analysis-results/snapshot-private')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);
    expect(read.body.snapshot).toMatchObject({visibility: 'private',
      privateContext: {codebase: true, knowledge: false}});
  });

  test('rejects invalid visibility updates', async () => {
    await request(app())
      .patch('/api/workspaces/workspace-a/analysis-results/snapshot-a')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({ visibility: 'org' })
      .expect(400);
  });
});
