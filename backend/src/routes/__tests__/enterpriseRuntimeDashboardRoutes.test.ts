// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  setTraceProcessorLeaseStoreForTests,
  TraceProcessorLeaseStore,
} from '../../services/traceProcessorLeaseStore';
import { createEnterpriseRuntimeDashboardRoutes } from '../enterpriseRuntimeDashboardRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

let tmpDir: string;
let dbPath: string;
let leaseStore: TraceProcessorLeaseStore | null = null;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function ssoHeaders(
  req: request.Test,
  input: {
    userId?: string;
    role?: string;
    scopes?: string;
    workspaceId?: string;
  } = {},
): request.Test {
  const userId = input.userId ?? 'runtime-admin';
  return req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', input.workspaceId ?? 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', input.role ?? 'workspace_admin')
    .set('X-SmartPerfetto-SSO-Scopes', input.scopes ?? 'runtime:manage,audit:read');
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/runtime', createEnterpriseRuntimeDashboardRoutes({
    now: () => Date.parse('2026-05-09T10:00:00.000Z'),
    eventLimit: 5,
    traceProcessorStatsProvider: () => ({
      count: 2,
      traceIds: ['trace-a', 'trace-b'],
      processorKeys: ['trace-a', 'trace-b'],
      processors: [
        {
          kind: 'owned_process',
          processorId: 'processor-a',
          traceId: 'trace-a',
          status: 'ready',
          activeQueries: 1,
          httpPort: 9101,
          leaseMode: 'shared',
          rssBytes: 64 * 1024 * 1024,
          startupRssBytes: 48 * 1024 * 1024,
          peakRssBytes: 72 * 1024 * 1024,
          lastRssSampleAt: 1_777_000_001_000,
          rssSampleSource: 'ps',
          sqlWorker: {
            running: true,
            queuedP0: 1,
            queuedP1: 2,
            queuedP2: 3,
            usesWorkerThread: true,
          },
        },
        {
          kind: 'owned_process',
          processorId: 'processor-b',
          traceId: 'trace-b',
          status: 'ready',
          activeQueries: 0,
          httpPort: 9102,
          leaseMode: 'shared',
          rssBytes: 128 * 1024 * 1024,
          rssSampleSource: 'ps',
          sqlWorker: {
            running: false,
            queuedP0: 9,
            queuedP1: 9,
            queuedP2: 9,
            usesWorkerThread: true,
          },
        },
      ],
      ramBudget: {
        enabled: true,
        totalMemoryBytes: 8 * 1024 * 1024 * 1024,
        nodeRssBytes: 128 * 1024 * 1024,
        osSafetyReserveBytes: 1024 * 1024 * 1024,
        uploadReserveBytes: 0,
        machineFactor: 0.6,
        budgetBytes: 2 * 1024 * 1024 * 1024,
        observedProcessorRssBytes: 192 * 1024 * 1024,
        availableForNewLeaseBytes: 1856 * 1024 * 1024,
        activeProcessorCount: 2,
        unknownRssProcessorCount: 0,
        estimateMultiplier: 1.5,
        minEstimateBytes: 128 * 1024 * 1024,
      },
    }),
  }));
  return app;
}

function seedWorkspaceGraph(): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_777_000_000_000;
  try {
    for (const workspaceId of ['workspace-a', 'workspace-b']) {
      db.prepare(`
        INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
        VALUES ('tenant-a', 'tenant-a', 'active', 'enterprise', ?, ?)
      `).run(now, now);
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
        VALUES (?, 'tenant-a', ?, ?, ?)
      `).run(workspaceId, workspaceId, now, now);
    }
    db.prepare(`
      INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('runtime-admin', 'tenant-a', 'runtime-admin@example.test', 'runtime-admin', 'runtime-admin', ?, ?)
    `).run(now, now);
    for (const [traceId, workspaceId, sessionId, runId] of [
      ['trace-a', 'workspace-a', 'session-a', 'run-a'],
      ['trace-b', 'workspace-b', 'session-b', 'run-b'],
    ] as const) {
      db.prepare(`
        INSERT INTO trace_assets
          (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, metadata_json, created_at)
        VALUES
          (?, 'tenant-a', ?, 'runtime-admin', ?, 1024, 'ready', '{}', ?)
      `).run(traceId, workspaceId, `/tmp/${traceId}.trace`, now);
      db.prepare(`
        INSERT INTO analysis_sessions
          (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
        VALUES
          (?, 'tenant-a', ?, ?, 'runtime-admin', ?, 'private', 'running', ?, ?)
      `).run(sessionId, workspaceId, traceId, sessionId, now, now);
      db.prepare(`
        INSERT INTO analysis_runs
          (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, heartbeat_at, updated_at)
        VALUES
          (?, 'tenant-a', ?, ?, 'full', 'running', 'dashboard', ?, ?, ?)
      `).run(runId, workspaceId, sessionId, now, now, now);
    }
    db.prepare(`
      INSERT INTO agent_events
        (id, tenant_id, workspace_id, run_id, cursor, event_type, payload_json, created_at)
      VALUES
        ('event-a', 'tenant-a', 'workspace-a', 'run-a', 7, 'progress', '{}', ?),
        ('event-b', 'tenant-a', 'workspace-b', 'run-b', 8, 'progress', '{}', ?)
    `).run(now + 10, now + 20);
    db.prepare(`
      INSERT INTO audit_events
        (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at)
      VALUES
        ('audit-a', 'tenant-a', 'workspace-a', 'runtime-admin', 'runtime.read', 'runtime_dashboard', 'workspace-a', '{}', ?),
        ('audit-tenant', 'tenant-a', NULL, 'runtime-admin', 'tenant.audit', 'tenant', 'tenant-a', '{}', ?),
        ('audit-b', 'tenant-a', 'workspace-b', 'runtime-admin', 'other_workspace.audit', 'runtime_dashboard', 'workspace-b', '{}', ?)
    `).run(now + 30, now + 40, now + 50);
  } finally {
    db.close();
  }
}

function seedLeases(): void {
  leaseStore = new TraceProcessorLeaseStore(openEnterpriseDb(dbPath));
  setTraceProcessorLeaseStoreForTests(leaseStore);
  const scopeA = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: 'runtime-admin',
  };
  const scopeB = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-b',
    userId: 'runtime-admin',
  };
  const leaseA = leaseStore.acquireHolder(scopeA, 'trace-a', {
    holderType: 'frontend_http_rpc',
    holderRef: 'window-a',
    windowId: 'window-a',
  }, { mode: 'shared', now: 1_777_000_000_000 });
  leaseStore.markStarting(scopeA, leaseA.id);
  leaseStore.markReady(scopeA, leaseA.id);
  leaseStore.recordRss(scopeA, leaseA.id, 64 * 1024 * 1024);
  const leaseB = leaseStore.acquireHolder(scopeB, 'trace-b', {
    holderType: 'agent_run',
    holderRef: 'run-b',
    runId: 'run-b',
  }, { mode: 'shared', now: 1_777_000_000_000 });
  leaseStore.markStarting(scopeB, leaseB.id);
  leaseStore.markReady(scopeB, leaseB.id);
  leaseStore.recordRss(scopeB, leaseB.id, 128 * 1024 * 1024);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-runtime-dashboard-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  delete process.env.SMARTPERFETTO_API_KEY;
  seedWorkspaceGraph();
  seedLeases();
});

afterEach(async () => {
  leaseStore?.close();
  leaseStore = null;
  setTraceProcessorLeaseStoreForTests(null);
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enterprise runtime dashboard routes', () => {
  it('returns scoped leases, RSS, queue length, events, and LLM cost for runtime admins', async () => {
    const res = await ssoHeaders(request(makeApp()).get('/api/admin/runtime'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      generatedAt: '2026-05-09T10:00:00.000Z',
      scope: expect.objectContaining({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'runtime-admin',
      }),
    }));
    expect(res.body.leases).toEqual(expect.objectContaining({
      count: 1,
      activeCount: 1,
      holderCount: 1,
      totalRssBytes: 64 * 1024 * 1024,
      countsByState: expect.objectContaining({ active: 1 }),
      countsByHolderType: expect.objectContaining({ frontend_http_rpc: 1 }),
    }));
    expect(res.body.leases.items).toEqual([
      expect.objectContaining({
        traceId: 'trace-a',
        mode: 'shared',
        state: 'active',
        rssBytes: 64 * 1024 * 1024,
        queueLength: 6,
        holderTypes: ['frontend_http_rpc'],
      }),
    ]);
    expect(res.body.processors).toEqual(expect.objectContaining({
      count: 1,
      traceIds: ['trace-a'],
      queueTotals: {
        queuedP0: 1,
        queuedP1: 2,
        queuedP2: 3,
        total: 6,
      },
      rssTotals: {
        observedProcessorRssBytes: 64 * 1024 * 1024,
        unknownRssProcessorCount: 0,
      },
    }));
    expect(res.body.events.recentAgentEvents).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        cursor: 7,
        eventType: 'progress',
      }),
    ]);
    expect(res.body.events.recentAuditEvents.map((event: any) => event.action)).toEqual([
      'tenant.audit',
      'runtime.read',
    ]);
    // No runtime-wide LLM usage counter exists; the dashboard reports none rather than zeros.
    expect(res.body).not.toHaveProperty('llmCost');
  });

  it('requires runtime manage permission', async () => {
    const res = await ssoHeaders(
      request(makeApp()).get('/api/admin/runtime'),
      {
        userId: 'runtime-analyst',
        role: 'analyst',
        scopes: 'trace:read,report:read',
      },
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toContain('Runtime dashboard requires runtime:manage permission');
  });
});
