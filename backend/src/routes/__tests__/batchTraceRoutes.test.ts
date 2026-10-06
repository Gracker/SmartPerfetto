// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { authenticate } from '../../middleware/auth';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import { SkillRegistry } from '../../services/skillEngine/skillLoader';
import { getWorkspaceSkillRegistry } from '../../services/skillPacks/workspaceSkillRegistryProvider';
import { runBatchSkill } from '../../services/batchTrace/batchTraceRunner';
import {
  BATCH_TRACE_RUN_SCHEMA_VERSION,
  type BatchTraceRunV1,
} from '../../services/batchTrace/batchTraceTypes';
import batchTraceRoutes from '../batchTraceRoutes';

import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

jest.mock('../../services/batchTrace/batchTraceRunner', () => ({
  runBatchSkill: jest.fn(),
}));

jest.mock('../../services/skillPacks/workspaceSkillRegistryProvider', () => ({
  getWorkspaceSkillRegistry: jest.fn(),
}));

const originalEnv = {
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  apiSyncMaxTraces: process.env.SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES,
  apiMaxInFlightRuns: process.env.SMARTPERFETTO_BATCH_TRACE_API_MAX_IN_FLIGHT_RUNS,
};

let tmpDir: string;
let dbPath: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workspaces/:workspaceId/batch-traces',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    batchTraceRoutes,
  );
  return loopbackServers.listen(app);
}

function ssoHeaders(req: request.Test, scopes: string, userId = 'batch-user'): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'viewer')
    .set('X-SmartPerfetto-SSO-Scopes', scopes);
}

function seedWorkspaceGraph(): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_777_000_000_000;
  try {
    db.prepare(`
      INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, retention_policy, quota_policy, created_at, updated_at)
      VALUES ('workspace-a', 'tenant-a', 'Workspace A', NULL, NULL, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('batch-user', 'tenant-a', 'batch-user@example.test', 'Batch User', 'batch-user', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
      VALUES ('tenant-a', 'workspace-a', 'batch-user', 'analyst', ?)
    `).run(now);
    for (const traceId of ['trace-a', 'trace-b']) {
      db.prepare(`
        INSERT INTO trace_assets
          (id, tenant_id, workspace_id, owner_user_id, local_path, sha256, size_bytes, status, metadata_json, created_at, expires_at)
        VALUES
          (?, 'tenant-a', 'workspace-a', 'batch-user', ?, NULL, 10, 'ready', '{}', ?, NULL)
      `).run(traceId, path.join(tmpDir, `${traceId}.pftrace`), now);
    }
  } finally {
    db.close();
  }
}

function batchRun(): BatchTraceRunV1 {
  return {
    schemaVersion: BATCH_TRACE_RUN_SCHEMA_VERSION,
    id: 'batch-route-run',
    createdAt: 1,
    startedAt: 2,
    completedAt: 3,
    status: 'completed',
    input: {
      skillId: 'startup_analysis',
      params: { package: 'com.example' },
      traceInputs: [
        { ordinal: 0, source: 'workspace_trace', traceId: 'trace-a', label: 'Trace A' },
        { ordinal: 1, source: 'workspace_trace', traceId: 'trace-b', label: 'Trace B' },
      ],
      maxConcurrency: 2,
      traceLimit: 100,
    },
    perTrace: [
      batchResult(0, 'trace-a', 'Trace A', 42),
      batchResult(1, 'trace-b', 'Trace B', 55),
    ],
    aggregate: {
      metrics: [{
        key: 'startup.total_ms',
        label: 'Startup total duration',
        count: 2,
        missingCount: 0,
        min: 42,
        p50: 42,
        p90: 55,
        p95: 55,
        max: 55,
        mean: 48.5,
        outlierOrdinals: [],
        unit: 'ms',
      }],
      limitations: [],
    },
  };
}

function batchResult(
  ordinal: number,
  traceId: string,
  label: string,
  value: number,
): BatchTraceRunV1['perTrace'][number] {
  return {
    ordinal,
    input: { ordinal, source: 'workspace_trace', traceId, label },
    traceId,
    status: 'completed',
    metrics: [{
      key: 'startup.total_ms',
      label: 'Startup total duration',
      value,
      numericValue: value,
      unit: 'ms',
      source: { skillId: 'startup_analysis', stepId: 'overview', dataEnvelopeId: `ev-${ordinal}` },
      promotableMetricKey: 'startup.total_ms',
    }],
    evidenceEnvelopeIds: [`ev-${ordinal}`],
    diagnostics: [],
    executionTimeMs: 5,
  };
}

function deferredBatchRun(): {
  started: Promise<void>;
  resolve: () => void;
} {
  let markStarted: () => void = () => {};
  let complete: (value: BatchTraceRunV1) => void = () => {};
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const pending = new Promise<BatchTraceRunV1>(resolve => {
    complete = resolve;
  });
  jest.mocked(runBatchSkill).mockImplementation(async () => {
    markStarted();
    return pending;
  });
  return {
    started,
    resolve: () => complete(batchRun()),
  };
}

describe('batch trace workspace routes', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-batch-routes-'));
    dbPath = path.join(tmpDir, 'enterprise.db');
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    seedWorkspaceGraph();
    jest.mocked(getWorkspaceSkillRegistry).mockResolvedValue({
      registry: new SkillRegistry(),
      registryFingerprint: 'test-registry',
      enabledPacks: [],
      getSkillOrigin: () => undefined,
    });
    jest.mocked(runBatchSkill).mockResolvedValue(batchRun());
  });

  afterEach(async () => {
    await loopbackServers.close();
    jest.clearAllMocks();
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
    restoreEnvValue('SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES', originalEnv.apiSyncMaxTraces);
    restoreEnvValue('SMARTPERFETTO_BATCH_TRACE_API_MAX_IN_FLIGHT_RUNS', originalEnv.apiMaxInFlightRuns);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates, reads, exports, promotes, and compares a workspace batch run', async () => {
    const app = await makeApp();
    const allScopes = 'agent:run,report:read,analysis_result:create,comparison:create';

    const created = await ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/batch-traces').send({
        skillId: 'startup_analysis',
        traceIds: ['trace-a', 'trace-b'],
        params: { package: 'com.example' },
        maxConcurrency: 2,
      }),
      allScopes,
    );

    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(created.body.run).toMatchObject({
      id: 'batch-route-run',
      status: 'completed',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      createdBy: 'batch-user',
    });
    expect(jest.mocked(runBatchSkill).mock.calls[0]?.[0]).toMatchObject({
      surface: 'api',
      skillId: 'startup_analysis',
      params: { package: 'com.example' },
      maxConcurrency: 2,
    });

    const listed = await ssoHeaders(
      request(app).get('/api/workspaces/workspace-a/batch-traces'),
      allScopes,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.runs.map((run: { id: string }) => run.id)).toEqual(['batch-route-run']);

    const fetched = await ssoHeaders(
      request(app).get('/api/workspaces/workspace-a/batch-traces/batch-route-run'),
      allScopes,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.run.perTrace).toHaveLength(2);

    const fetchedByPeer = await ssoHeaders(
      request(app).get('/api/workspaces/workspace-a/batch-traces/batch-route-run'),
      'report:read',
      'batch-peer',
    );
    expect(fetchedByPeer.status).toBe(200);
    expect(fetchedByPeer.body.run.id).toBe('batch-route-run');

    const exported = await ssoHeaders(
      request(app).get('/api/workspaces/workspace-a/batch-traces/batch-route-run/report/export'),
      allScopes,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/html');
    expect(exported.text).toMatch(/SmartPerfetto (?:Batch Trace Run|批量轨迹分析)/);

    const promoted = await ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/batch-traces/batch-route-run/promote-snapshots').send({
        ordinals: [0, 1],
      }),
      allScopes,
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.promotedSnapshots).toHaveLength(2);
    expect(promoted.body.run.perTrace.every((result: { promotedSnapshotId?: string }) =>
      typeof result.promotedSnapshotId === 'string')).toBe(true);

    const compared = await ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/batch-traces/batch-route-run/comparisons').send({
        ordinals: [0, 1],
        metricKeys: ['startup.total_ms'],
      }),
      allScopes,
    );
    expect(compared.status).toBe(200);
    expect(compared.body.comparison).toMatchObject({ status: 'completed' });
    expect(compared.body.run.comparisonId).toBe(compared.body.comparison.id);
  });

  it('requires agent run permission to create a batch run', async () => {
    const res = await ssoHeaders(
      request(await makeApp()).post('/api/workspaces/workspace-a/batch-traces').send({
        skillId: 'startup_analysis',
        traceIds: ['trace-a'],
      }),
      'report:read',
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toContain('agent:run');
  });

  it('rejects malformed create bodies', async () => {
    const res = await ssoHeaders(
      request(await makeApp()).post('/api/workspaces/workspace-a/batch-traces').send({
        skillId: 'startup_analysis',
        traceIds: [],
      }),
      'agent:run',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('traceIds must contain at least one trace ID');
  });

  it('rejects oversized synchronous API batches before starting the runner', async () => {
    process.env.SMARTPERFETTO_BATCH_TRACE_API_SYNC_MAX_TRACES = '1';

    const res = await ssoHeaders(
      request(await makeApp()).post('/api/workspaces/workspace-a/batch-traces').send({
        skillId: 'startup_analysis',
        traceIds: ['trace-a', 'trace-b'],
      }),
      'agent:run',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_batch_trace_limit:trace_count:2>1');
    expect(jest.mocked(runBatchSkill)).not.toHaveBeenCalled();
  });

  it('limits process-wide synchronous API batch runs', async () => {
    process.env.SMARTPERFETTO_BATCH_TRACE_API_MAX_IN_FLIGHT_RUNS = '1';
    const app = await makeApp();
    const deferred = deferredBatchRun();

    const first = ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/batch-traces').send({
        skillId: 'startup_analysis',
        traceIds: ['trace-a'],
      }),
      'agent:run',
    ).then(response => response);
    await deferred.started;

    const second = await ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/batch-traces').send({
        skillId: 'startup_analysis',
        traceIds: ['trace-b'],
      }),
      'agent:run',
    );

    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({
      success: false,
      error: 'batch_trace_api_busy',
      retryable: true,
      activeRuns: 1,
      maxInFlightRuns: 1,
    });

    deferred.resolve();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
  });
});
