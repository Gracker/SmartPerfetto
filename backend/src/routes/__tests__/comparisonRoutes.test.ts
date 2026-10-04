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
import comparisonRoutes from '../comparisonRoutes';
import { reportStore } from '../reportRoutes';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import { backendLogPath } from '../../runtimePaths';

const originalDbPath = process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH;
const originalComparisonAiDisabled = process.env.SMARTPERFETTO_COMPARISON_AI_DISABLED;
const originalLogDir = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;

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
    '/api/workspaces/:workspaceId/comparisons',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    comparisonRoutes,
  );
  return server;
}

function metrics(values: {
  startupMs: number;
  fps: number;
  jankRate: number;
  renderLatencyMs?: number;
}): NormalizedMetricValue[] {
  return [
    {
      key: 'startup.total_ms',
      label: 'Startup total duration',
      group: 'startup',
      value: values.startupMs,
      unit: 'ms',
      direction: 'lower_is_better',
      aggregation: 'single',
      confidence: 0.9,
      source: { type: 'skill' },
    },
    {
      key: 'scrolling.avg_fps',
      label: 'Average FPS',
      group: 'fps',
      value: values.fps,
      unit: 'fps',
      direction: 'higher_is_better',
      aggregation: 'avg',
      confidence: 0.9,
      source: { type: 'skill' },
    },
    {
      key: 'scrolling.jank_rate_pct',
      label: 'Jank rate',
      group: 'jank',
      value: values.jankRate,
      unit: '%',
      direction: 'lower_is_better',
      aggregation: 'avg',
      confidence: 0.9,
      source: { type: 'skill' },
    },
    values.renderLatencyMs === undefined ? undefined : {
      key: 'custom.render_latency_ms',
      label: 'Render latency',
      group: 'custom',
      value: values.renderLatencyMs,
      unit: 'ms',
      direction: 'lower_is_better',
      aggregation: 'avg',
      confidence: 0.8,
      source: { type: 'manual' },
    },
  ].filter(Boolean) as NormalizedMetricValue[];
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
    metrics: metrics({ startupMs: 1200, fps: 55, jankRate: 8 }),
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
    ['trace-a', 'session-a', 'run-a'],
    ['trace-b', 'session-b', 'run-b'],
    ['trace-c', 'session-c', 'run-c'],
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
  repo.createSnapshot(snapshot({ id: 'snapshot-a' }));
  repo.createSnapshot(snapshot({
    id: 'snapshot-b',
    traceId: 'trace-b',
    sessionId: 'session-b',
    runId: 'run-b',
    visibility: 'workspace',
    metrics: metrics({ startupMs: 900, fps: 60, jankRate: 3 }),
  }));
  repo.createSnapshot(snapshot({
    id: 'snapshot-c',
    traceId: 'trace-c',
    sessionId: 'session-c',
    runId: 'run-c',
    visibility: 'workspace',
    metrics: metrics({ startupMs: 1400, fps: 50, jankRate: 12 }),
  }));
  db.close();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-comparisons-'));
  dbPath = path.join(tempDir, 'enterprise.db');
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = dbPath;
  process.env.SMARTPERFETTO_COMPARISON_AI_DISABLED = 'true';
  // Comparison reports land in the backend log directory; keep them in this test's directory.
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tempDir, 'logs');
  reportStore.clear();
  seedGraph();
});

afterEach(async () => {
  restoreEnvValue('SMARTPERFETTO_ENTERPRISE_DB_PATH', originalDbPath);
  restoreEnvValue('SMARTPERFETTO_COMPARISON_AI_DISABLED', originalComparisonAiDisabled);
  restoreEnvValue('SMARTPERFETTO_BACKEND_LOG_DIR', originalLogDir);
  reportStore.clear();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('comparison routes', () => {
  test('carries a private input snapshot\'s audience to the comparison and its report', async () => {
    const db = openEnterpriseDb(dbPath);
    try {
      createAnalysisResultSnapshotRepository(db).createSnapshot(snapshot({
        id: 'snapshot-private',
        traceId: 'trace-b',
        sessionId: 'session-b',
        runId: 'run-b',
        privateContext: {codebase: false, knowledge: true},
        metrics: metrics({ startupMs: 900, fps: 60, jankRate: 3 }),
      }));
    } finally {
      db.close();
    }

    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({baselineSnapshotId: 'snapshot-a', candidateSnapshotIds: ['snapshot-private'], query: 'compare'})
      .expect(201);

    const comparison = createResponse.body.comparison;
    expect(comparison.privateContext).toEqual({codebase: false, knowledge: true});
    expect(reportStore.get(comparison.result.reportId)?.privateContext).toEqual({codebase: false, knowledge: true});
    const stored = openEnterpriseDb(dbPath);
    try {
      expect(stored.prepare('SELECT private_context FROM multi_trace_comparison_runs WHERE id = ?')
        .get(comparison.id)).toEqual({private_context: 2});
    } finally {
      stored.close();
    }
  });

  test('creates completed startup/fps/jank comparison result for two readable snapshots', async () => {
    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
        query: 'compare startup',
      })
      .expect(201);

    expect(createResponse.body.success).toBe(true);
    expect(createResponse.body.comparison.status).toBe('completed');
    expect(createResponse.body.comparison.inputSnapshotIds).toEqual([
      'snapshot-a',
      'snapshot-b',
    ]);
    expect(createResponse.body.comparison.result.matrix.rows.map((row: { metricKey: string }) => row.metricKey)).toEqual([
      'startup.total_ms',
      'scrolling.avg_fps',
      'scrolling.jank_rate_pct',
    ]);

    const rows = createResponse.body.comparison.result.matrix.rows as Array<{
      metricKey: string;
      deltas: Array<{ deltaValue: number; deltaPct: number; assessment: string }>;
    }>;
    expect(rows.find(row => row.metricKey === 'startup.total_ms')?.deltas[0]).toMatchObject({
      deltaValue: -300,
      deltaPct: -25,
      assessment: 'better',
    });
    expect(rows.find(row => row.metricKey === 'scrolling.avg_fps')?.deltas[0]).toMatchObject({
      deltaValue: 5,
      assessment: 'better',
    });
    expect(rows.find(row => row.metricKey === 'scrolling.jank_rate_pct')?.deltas[0]).toMatchObject({
      deltaValue: -5,
      assessment: 'better',
    });
    expect(createResponse.body.comparison.result.significantChanges).toHaveLength(3);
    expect(createResponse.body.comparison.result.reportId).toMatch(/^comparison-report-/);
    expect(createResponse.body.comparison.result.reportExportUrl).toMatch(/\/api\/reports\/comparison-report-.*\/export/);
    expect(reportStore.get(createResponse.body.comparison.result.reportId)?.html).toContain('Metric Delta Matrix');

    const comparisonId = createResponse.body.comparison.id;
    const readResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${comparisonId}`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(readResponse.body.comparison.id).toBe(comparisonId);
    expect(readResponse.body.comparison.status).toBe('completed');
    expect(readResponse.body.comparison.result.matrix.rows).toHaveLength(3);
  });

  test('rejects missing candidate snapshots', async () => {
    await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: [],
      })
      .expect(400);
  });

  test('creates comparison for explicitly requested custom metric keys', async () => {
    const db = openEnterpriseDb(dbPath);
    const repo = createAnalysisResultSnapshotRepository(db);
    repo.upsertMetrics(
      {
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: 'workspace-a',
        userId: DEFAULT_DEV_USER_ID,
      },
      'snapshot-a',
      [metrics({ startupMs: 1200, fps: 55, jankRate: 8, renderLatencyMs: 18 })[3]],
      [],
    );
    repo.upsertMetrics(
      {
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: 'workspace-a',
        userId: DEFAULT_DEV_USER_ID,
      },
      'snapshot-b',
      [metrics({ startupMs: 900, fps: 60, jankRate: 3, renderLatencyMs: 27 })[3]],
      [],
    );
    db.close();

    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
        metricKeys: ['custom.render_latency_ms'],
      })
      .expect(201);

    const rows = createResponse.body.comparison.result.matrix.rows as Array<{
      metricKey: string;
      label: string;
      group: string;
      deltas: Array<{ deltaValue: number; deltaPct: number; assessment: string }>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      metricKey: 'custom.render_latency_ms',
      label: 'Render latency',
      group: 'custom',
    });
    expect(rows[0].deltas[0]).toMatchObject({
      deltaValue: 9,
      deltaPct: 50,
      assessment: 'worse',
    });
  });

  test('creates comparison for more than two snapshots', async () => {
    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b', 'snapshot-c'],
        metricKeys: ['startup.total_ms'],
        query: 'compare three startups',
      })
      .expect(201);

    expect(createResponse.body.comparison.inputSnapshotIds).toEqual([
      'snapshot-a',
      'snapshot-b',
      'snapshot-c',
    ]);

    const rows = createResponse.body.comparison.result.matrix.rows as Array<{
      metricKey: string;
      deltas: Array<{ snapshotId: string; deltaValue: number; assessment: string }>;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].metricKey).toBe('startup.total_ms');
    expect(rows[0].deltas).toHaveLength(2);
    expect(rows[0].deltas[0]).toMatchObject({
      snapshotId: 'snapshot-b',
      deltaValue: -300,
      assessment: 'better',
    });
    expect(rows[0].deltas[1]).toMatchObject({
      snapshotId: 'snapshot-c',
      deltaValue: 200,
      assessment: 'worse',
    });
    expect(createResponse.body.comparison.result.significantChanges).toHaveLength(2);

    const html = reportStore.get(createResponse.body.comparison.result.reportId)?.html || '';
    expect(html).toContain('snapshot-b');
    expect(html).toContain('snapshot-c');
    expect((html.match(/<th>Delta<\/th>/g) || []).length).toBe(2);
  });

  test('switches baseline and recalculates deltas for an existing comparison', async () => {
    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b', 'snapshot-c'],
        metricKeys: ['startup.total_ms'],
        query: 'compare three startups',
      })
      .expect(201);

    const comparisonId = createResponse.body.comparison.id;
    const originalReportId = createResponse.body.comparison.result.reportId;
    const updateResponse = await request(app())
      .patch(`/api/workspaces/workspace-a/comparisons/${comparisonId}/baseline`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-b',
      })
      .expect(200);

    expect(updateResponse.body.comparison.id).toBe(comparisonId);
    expect(updateResponse.body.comparison.baselineSnapshotId).toBe('snapshot-b');
    expect(updateResponse.body.comparison.inputSnapshotIds).toEqual([
      'snapshot-a',
      'snapshot-b',
      'snapshot-c',
    ]);
    expect(updateResponse.body.comparison.result.matrix.baselineSnapshotId).toBe('snapshot-b');

    const row = updateResponse.body.comparison.result.matrix.rows[0] as {
      baseline: { snapshotId: string; numericValue: number };
      deltas: Array<{ snapshotId: string; deltaValue: number; assessment: string }>;
    };
    expect(row.baseline).toMatchObject({
      snapshotId: 'snapshot-b',
      numericValue: 900,
    });
    expect(row.deltas).toEqual([
      expect.objectContaining({
        snapshotId: 'snapshot-a',
        deltaValue: 300,
        assessment: 'worse',
      }),
      expect.objectContaining({
        snapshotId: 'snapshot-c',
        deltaValue: 500,
        assessment: 'worse',
      }),
    ]);
    expect(updateResponse.body.comparison.result.reportId).not.toBe(originalReportId);
    const html = reportStore.get(updateResponse.body.comparison.result.reportId)?.html || '';
    expect(html).toContain('Baseline: snapshot-b');
  });

  test('filters API response to significant changes without mutating persisted matrix', async () => {
    const db = openEnterpriseDb(dbPath);
    const repo = createAnalysisResultSnapshotRepository(db);
    const scope = {
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: 'workspace-a',
      userId: DEFAULT_DEV_USER_ID,
    };
    repo.upsertMetrics(
      scope,
      'snapshot-a',
      [metrics({ startupMs: 1200, fps: 55, jankRate: 8, renderLatencyMs: 18 })[3]],
      [],
    );
    repo.upsertMetrics(
      scope,
      'snapshot-b',
      [metrics({ startupMs: 900, fps: 60, jankRate: 3, renderLatencyMs: 18 })[3]],
      [],
    );
    db.close();

    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
        metricKeys: ['startup.total_ms', 'custom.render_latency_ms'],
      })
      .expect(201);

    const comparisonId = createResponse.body.comparison.id;
    expect(createResponse.body.comparison.result.matrix.rows.map((row: { metricKey: string }) => row.metricKey)).toEqual([
      'startup.total_ms',
      'custom.render_latency_ms',
    ]);

    const filteredResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${comparisonId}?significantOnly=true`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);
    expect(filteredResponse.body.comparison.result.matrix.rows.map((row: { metricKey: string }) => row.metricKey)).toEqual([
      'startup.total_ms',
    ]);

    const fullResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${comparisonId}`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);
    expect(fullResponse.body.comparison.result.matrix.rows.map((row: { metricKey: string }) => row.metricKey)).toEqual([
      'startup.total_ms',
      'custom.render_latency_ms',
    ]);
  });

  test('does not treat tiny deltas as significant changes', async () => {
    const db = openEnterpriseDb(dbPath);
    const repo = createAnalysisResultSnapshotRepository(db);
    const scope = {
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: 'workspace-a',
      userId: DEFAULT_DEV_USER_ID,
    };
    repo.upsertMetrics(
      scope,
      'snapshot-b',
      metrics({ startupMs: 1199, fps: 55.2, jankRate: 7.7 }),
      [],
    );
    db.close();

    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
        metricKeys: ['startup.total_ms', 'scrolling.avg_fps', 'scrolling.jank_rate_pct'],
      })
      .expect(201);

    expect(createResponse.body.comparison.result.significantChanges).toHaveLength(0);

    const filteredResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${createResponse.body.comparison.id}?significantOnly=true`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);
    expect(filteredResponse.body.comparison.result.matrix.rows).toHaveLength(0);
  });

  test('exports filtered comparison report without reusing the unfiltered cached report', async () => {
    const db = openEnterpriseDb(dbPath);
    const repo = createAnalysisResultSnapshotRepository(db);
    const scope = {
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: 'workspace-a',
      userId: DEFAULT_DEV_USER_ID,
    };
    repo.upsertMetrics(
      scope,
      'snapshot-a',
      [metrics({ startupMs: 1200, fps: 55, jankRate: 8, renderLatencyMs: 18 })[3]],
      [],
    );
    repo.upsertMetrics(
      scope,
      'snapshot-b',
      [metrics({ startupMs: 900, fps: 60, jankRate: 3, renderLatencyMs: 18 })[3]],
      [],
    );
    db.close();

    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
        metricKeys: ['startup.total_ms', 'custom.render_latency_ms'],
      })
      .expect(201);
    const reportId = createResponse.body.comparison.result.reportId;
    expect(reportStore.get(reportId)?.html).toContain('custom.render_latency_ms');

    const exportResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${createResponse.body.comparison.id}/report/export?significantOnly=true`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(exportResponse.text).toContain('startup.total_ms');
    expect(exportResponse.text).not.toContain('custom.render_latency_ms');
  });

  test('exports comparison report from persisted result when artifact cache is empty', async () => {
    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
        metricKeys: ['startup.total_ms'],
        query: 'export this comparison',
      })
      .expect(201);

    const comparisonId = createResponse.body.comparison.id;
    reportStore.clear();

    const exportResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${comparisonId}/report/export`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(exportResponse.headers['content-type']).toContain('text/html');
    expect(exportResponse.headers['content-disposition']).toContain(
      `attachment; filename="smartperfetto-comparison-${comparisonId}.html"`,
    );
    expect(exportResponse.text).toContain(`data-comparison-id="${comparisonId}"`);
    expect(exportResponse.text).toContain('Metric Delta Matrix');
    expect(exportResponse.text).toContain('export this comparison');
  });

  test('completes the comparison without a report when the report cannot be saved', async () => {
    // The module object itself: reportRoutes reads its namespace binding at call time.
    const nodeFs = require('fs') as typeof import('fs');
    const realOpen = nodeFs.openSync;
    const spy = jest.spyOn(nodeFs, 'openSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (/comparison-report-.*\.html$/u.test(String(file))) throw new Error('disk full');
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof nodeFs.openSync);
    let createResponse: request.Response;
    try {
      createResponse = await request(app())
        .post('/api/workspaces/workspace-a/comparisons')
        .set('x-tenant-id', DEFAULT_TENANT_ID)
        .send({baselineSnapshotId: 'snapshot-a', candidateSnapshotIds: ['snapshot-b'], query: 'compare without report'})
        .expect(201);
    } finally {
      spy.mockRestore();
    }

    const comparison = createResponse.body.comparison;
    expect(comparison.status).toBe('completed');
    expect(comparison.result.matrix.rows.length).toBeGreaterThan(0);
    expect(comparison.result).not.toHaveProperty('reportId');
    expect(comparison.result).not.toHaveProperty('reportUrl');
    // The failed write left nothing claiming a report id.
    expect(nodeFs.readdirSync(backendLogPath('reports'))
      .filter(file => file.startsWith(`comparison-report-${comparison.id}-`))).toEqual([]);

    const exportResponse = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${comparison.id}/report/export`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);
    expect(exportResponse.text).toContain('compare without report');
  });

  test('rejects baseline switch outside comparison inputs', async () => {
    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
      })
      .expect(201);

    await request(app())
      .patch(`/api/workspaces/workspace-a/comparisons/${createResponse.body.comparison.id}/baseline`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-c',
      })
      .expect(400);
  });

  test('streams the current comparison state as SSE', async () => {
    const createResponse = await request(app())
      .post('/api/workspaces/workspace-a/comparisons')
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .send({
        baselineSnapshotId: 'snapshot-a',
        candidateSnapshotIds: ['snapshot-b'],
      })
      .expect(201);

    const response = await request(app())
      .get(`/api/workspaces/workspace-a/comparisons/${createResponse.body.comparison.id}/stream`)
      .set('x-tenant-id', DEFAULT_TENANT_ID)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: comparison_state');
    expect(response.text).toContain(createResponse.body.comparison.id);
  });
});
