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
  type NormalizedMetricValue,
} from '../../types/multiTraceComparison';
import {
  authenticate,
} from '../../middleware/auth';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID} from '../../utils/localDevIdentity';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import { openEnterpriseDb } from '../../services/enterpriseDb';
import { createAnalysisResultSnapshotRepository } from '../../services/analysisResultSnapshotStore';
import analysisResultRoutes from '../analysisResultRoutes';
import comparisonRoutes from '../comparisonRoutes';
import { reportStore } from '../reportRoutes';
import workspaceWindowRoutes from '../workspaceWindowRoutes';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalDbPath = process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;
const originalComparisonAiDisabled = process.env.SMARTPERFETTO_COMPARISON_AI_DISABLED;

let tempDir: string;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function app() {
  const server = express();
  server.use(express.json());
  server.use(
    '/api/workspaces/:workspaceId/analysis-results',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    analysisResultRoutes,
  );
  server.use(
    '/api/workspaces/:workspaceId/windows',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    workspaceWindowRoutes,
  );
  server.use(
    '/api/workspaces/:workspaceId/comparisons',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    comparisonRoutes,
  );
  return loopbackServers.listen(server);
}

function metrics(startupMs: number): NormalizedMetricValue[] {
  return [{
    key: 'startup.total_ms',
    label: 'Startup total duration',
    group: 'startup',
    value: startupMs,
    unit: 'ms',
    direction: 'lower_is_better',
    aggregation: 'single',
    confidence: 0.9,
    source: { type: 'skill' },
  }];
}

function snapshot(overrides: Partial<AnalysisResultSnapshot>): AnalysisResultSnapshot {
  const id = overrides.id || 'analysis-result-current-aaaaaaaa';
  return {
    id,
    tenantId: DEFAULT_TENANT_ID,
    workspaceId: 'workspace-a',
    traceId: 'trace-current',
    sessionId: 'session-current',
    runId: 'run-current',
    createdBy: DEFAULT_DEV_USER_ID,
    visibility: 'private',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'startup',
    title: id,
    userQuery: 'analyze startup',
    traceLabel: 'trace-current',
    traceMetadata: {},
    summary: { headline: 'ok' },
    metrics: metrics(300),
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
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('workspace-a', DEFAULT_TENANT_ID, 'workspace-a', now, now);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, 'dev@example.test', 'Dev', 'dev', now, now);

  for (const [traceId, sessionId, runId] of [
    ['trace-current', 'session-current', 'run-current'],
    ['trace-other', 'session-other', 'run-other'],
  ]) {
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, status, created_at)
      VALUES
        (?, ?, 'workspace-a', ?, ?, 'ready', ?)
    `).run(traceId, DEFAULT_TENANT_ID, DEFAULT_DEV_USER_ID, `/tmp/${traceId}`, now);
    db.prepare(`
      INSERT INTO analysis_sessions
        (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
      VALUES
        (?, ?, 'workspace-a', ?, ?, ?, 'private', 'completed', ?, ?)
    `).run(sessionId, DEFAULT_TENANT_ID, traceId, DEFAULT_DEV_USER_ID, sessionId, now, now);
    db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
      VALUES
        (?, ?, 'workspace-a', ?, 'agent', 'completed', 'analyze', ?, ?)
    `).run(runId, DEFAULT_TENANT_ID, sessionId, now, now);
  }

  const repo = createAnalysisResultSnapshotRepository(db);
  repo.createSnapshot(snapshot({
    id: 'analysis-result-current-aaaaaaaa',
    metrics: metrics(300),
  }));
  repo.createSnapshot(snapshot({
    id: 'analysis-result-other-bbbbbbbb',
    traceId: 'trace-other',
    sessionId: 'session-other',
    runId: 'run-other',
    title: 'other startup result',
    traceLabel: 'trace-other',
    metrics: metrics(240),
    createdAt: now + 1,
  }));
  db.close();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-result-flow-'));
  dbPath = path.join(tempDir, 'enterprise.db');
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
  process.env.SMARTPERFETTO_COMPARISON_AI_DISABLED = 'true';
  reportStore.clear();
  seedGraph();
});

afterEach(async () => {
  await loopbackServers.close();
  restoreEnvValue('SMARTPERFETTO_ENTERPRISE_DB_PATH', originalDbPath);
  restoreEnvValue('SMARTPERFETTO_COMPARISON_AI_DISABLED', originalComparisonAiDisabled);
  reportStore.clear();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('analysis result comparison flow', () => {
  test('supports current window result comparison against one active peer window result', async () => {
    const server = await app();

    await request(server)
      .post('/api/workspaces/workspace-a/windows/window-other/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        traceId: 'trace-other',
        activeSessionId: 'session-other',
        latestSnapshotId: 'analysis-result-other-bbbbbbbb',
        traceTitle: 'Other Trace',
        sceneType: 'startup',
      })
      .expect(200);

    const currentHeartbeat = await request(server)
      .post('/api/workspaces/workspace-a/windows/window-current/heartbeat')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        traceId: 'trace-current',
        activeSessionId: 'session-current',
        latestSnapshotId: 'analysis-result-current-aaaaaaaa',
        traceTitle: 'Current Trace',
        sceneType: 'startup',
      })
      .expect(200);

    expect(currentHeartbeat.body.activeWindows.map((item: any) => item.latestSnapshotId)).toEqual([
      'analysis-result-other-bbbbbbbb',
    ]);

    const resultsResponse = await request(server)
      .get('/api/workspaces/workspace-a/analysis-results?limit=500')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(resultsResponse.body.results.map((item: any) => item.id)).toEqual([
      'analysis-result-other-bbbbbbbb',
      'analysis-result-current-aaaaaaaa',
    ]);

    const comparisonResponse = await request(server)
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'analysis-result-current-aaaaaaaa',
        candidateSnapshotIds: ['analysis-result-other-bbbbbbbb'],
        query: '对比一下另外一份',
      })
      .expect(201);

    expect(comparisonResponse.body.comparison.status).toBe('completed');
    expect(comparisonResponse.body.comparison.inputSnapshotIds).toEqual([
      'analysis-result-current-aaaaaaaa',
      'analysis-result-other-bbbbbbbb',
    ]);
    expect(comparisonResponse.body.comparison.result.matrix.baselineSnapshotId).toBe(
      'analysis-result-current-aaaaaaaa',
    );
    expect(comparisonResponse.body.comparison.result.matrix.rows[0].deltas[0]).toMatchObject({
      snapshotId: 'analysis-result-other-bbbbbbbb',
      deltaValue: -60,
      assessment: 'better',
    });
  });
});
