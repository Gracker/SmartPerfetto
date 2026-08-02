// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';

import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  evaluateTenantMutationPolicy,
} from '../../services/enterpriseTenantLifecycleService';
import { ENTERPRISE_DATA_DIR_ENV } from '../../services/traceMetadataStore';
import tenantRoutes, { resetTenantPurgeJobsForTests } from '../enterpriseTenantRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  enterpriseDataDir: process.env[ENTERPRISE_DATA_DIR_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

let tmpDir: string;
let dbPath: string;
let dataDir: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/tenant', tenantRoutes);
  return app;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function adminHeaders(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'admin-a')
    .set('X-SmartPerfetto-SSO-Email', 'admin-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'org_admin')
    .set('X-SmartPerfetto-SSO-Scopes', 'report:read');
}

function analystHeaders(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'analyst-a')
    .set('X-SmartPerfetto-SSO-Email', 'analyst-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,agent:run');
}

function workspaceAdminHeaders(req: request.Test, workspaceId = 'workspace-a'): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'workspace-admin-a')
    .set('X-SmartPerfetto-SSO-Email', 'workspace-admin-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'workspace_admin')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write');
}

function readTenantRow(): { status: string } | null {
  const db = openEnterpriseDb(dbPath);
  try {
    return db.prepare<unknown[], { status: string }>(`
      SELECT status
      FROM organizations
      WHERE id = 'tenant-a'
    `).get() ?? null;
  } finally {
    db.close();
  }
}

function readTombstone(): {
  status: string;
  proof_hash: string | null;
  purge_after: number;
} | null {
  const db = openEnterpriseDb(dbPath);
  try {
    return db.prepare<unknown[], {
      status: string;
      proof_hash: string | null;
      purge_after: number;
    }>(`
      SELECT status, proof_hash, purge_after
      FROM tenant_tombstones
      WHERE tenant_id = 'tenant-a'
    `).get() ?? null;
  } finally {
    db.close();
  }
}

function readCount(table: string, where = "tenant_id = 'tenant-a'"): number {
  const db = openEnterpriseDb(dbPath);
  try {
    const row = db.prepare<unknown[], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM ${table}
      WHERE ${where}
    `).get();
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function readAuditActions(): string[] {
  const db = openEnterpriseDb(dbPath);
  try {
    return db.prepare<unknown[], { action: string }>(`
      SELECT action
      FROM audit_events
      WHERE tenant_id = 'tenant-a'
      ORDER BY created_at ASC, id ASC
    `).all().map(row => row.action);
  } finally {
    db.close();
  }
}

async function waitForPurgeJob(
  app: express.Express,
  jobId: string,
): Promise<request.Response> {
  let last: request.Response | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    last = await adminHeaders(request(app).get(`/api/tenant/purge/${jobId}`));
    if (last.body.job.status !== 'running') return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return last!;
}

async function seedTenantData(): Promise<void> {
  const tenantDir = path.join(dataDir, 'tenant-a', 'workspace-a', 'traces');
  await fs.mkdir(tenantDir, { recursive: true });
  await fs.writeFile(path.join(tenantDir, 'trace-a.trace'), 'trace');

  const now = 1_800_000_000_000;
  const db = openEnterpriseDb(dbPath);
  try {
    db.prepare(`
      INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES ('workspace-a', 'tenant-a', 'Workspace A', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('admin-a', 'tenant-a', 'admin-a@example.test', 'Admin A', 'sso:admin-a', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, sha256, size_bytes, status, created_at)
      VALUES
        ('trace-a', 'tenant-a', 'workspace-a', 'admin-a', ?, 'sha-a', 5, 'ready', ?)
    `).run(path.join(tenantDir, 'trace-a.trace'), now);
    db.prepare(`
      INSERT INTO analysis_sessions
        (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
      VALUES
        ('session-a', 'tenant-a', 'workspace-a', 'trace-a', 'admin-a', 'Session A', 'private', 'completed', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at)
      VALUES
        ('run-a', 'tenant-a', 'workspace-a', 'session-a', 'quick', 'completed', 'q', ?, ?)
    `).run(now, now + 1);
    db.prepare(`
      INSERT INTO memory_entries
        (id, tenant_id, workspace_id, scope, source_run_id, content_json, created_at, updated_at)
      VALUES
        ('memory-a', 'tenant-a', 'workspace-a', 'baseline', 'run-a', '{"ok":true}', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO provider_snapshots
        (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, created_at)
      VALUES
        ('snapshot-a', 'tenant-a', 'provider-a', 'hash-a', 'openai-agents-sdk', '{}', ?)
    `).run(now);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-tenant-lifecycle-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  dataDir = path.join(tmpDir, 'data');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env[ENTERPRISE_DATA_DIR_ENV] = dataDir;
  delete process.env.SMARTPERFETTO_API_KEY;
  resetTenantPurgeJobsForTests();
});

afterEach(async () => {
  resetTenantPurgeJobsForTests();
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(ENTERPRISE_DATA_DIR_ENV, originalEnv.enterpriseDataDir);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enterprise tenant lifecycle routes', () => {
  it('manages workspaces, members, and quota policies through the admin control plane', async () => {
    const app = makeApp();

    const createRes = await adminHeaders(request(app).post('/api/tenant/workspaces')).send({
      workspaceId: 'workspace-admin',
      name: 'Workspace Admin',
      quotaPolicy: {
        maxTraceBytes: 1024,
      },
      retentionPolicy: {
        traceRetentionDays: 7,
      },
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.workspace).toEqual(expect.objectContaining({
      id: 'workspace-admin',
      name: 'Workspace Admin',
      quotaPolicy: { maxTraceBytes: 1024 },
      retentionPolicy: { traceRetentionDays: 7 },
    }));

    const policyRes = await adminHeaders(
      request(app).patch('/api/tenant/workspaces/workspace-admin/policies'),
    ).send({
      quotaPolicy: {
        maxTraceBytes: 2048,
        maxConcurrentRuns: 3,
      },
      retentionPolicy: {
        reportRetentionDays: 30,
      },
    });
    expect(policyRes.status).toBe(200);
    expect(policyRes.body.workspace).toEqual(expect.objectContaining({
      quotaPolicy: {
        maxTraceBytes: 2048,
        maxConcurrentRuns: 3,
      },
      retentionPolicy: {
        reportRetentionDays: 30,
      },
    }));

    const memberRes = await adminHeaders(
      request(app).put('/api/tenant/workspaces/workspace-admin/members/user-b'),
    ).send({
      email: 'user-b@example.test',
      displayName: 'User B',
      role: 'analyst',
    });
    expect(memberRes.status).toBe(200);
    expect(memberRes.body.member).toEqual(expect.objectContaining({
      userId: 'user-b',
      email: 'user-b@example.test',
      displayName: 'User B',
      role: 'analyst',
    }));

    const membersRes = await adminHeaders(
      request(app).get('/api/tenant/workspaces/workspace-admin/members'),
    );
    expect(membersRes.status).toBe(200);
    expect(membersRes.body.members).toEqual([
      expect.objectContaining({
        userId: 'user-b',
        role: 'analyst',
      }),
    ]);

    const summaryRes = await adminHeaders(request(app).get('/api/tenant/admin/summary'));
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.counts).toEqual(expect.objectContaining({
      workspaces: 2,
      users: 2,
      memberships: 1,
      providers: 0,
    }));
    expect(summaryRes.body.providerManagement).toEqual(expect.objectContaining({
      workspaceEndpointTemplate: '/api/workspaces/:workspaceId/providers',
    }));

    const deleteMemberRes = await adminHeaders(
      request(app).delete('/api/tenant/workspaces/workspace-admin/members/user-b'),
    );
    expect(deleteMemberRes.status).toBe(200);
    expect(readCount('memberships')).toBe(0);
    expect(readAuditActions()).toEqual(expect.arrayContaining([
      'tenant.workspace.created',
      'tenant.workspace.policy_updated',
      'tenant.member.upserted',
      'tenant.member.deleted',
    ]));
  });

  it('limits admin control plane access by tenant and workspace management permission', async () => {
    await seedTenantData();
    const app = makeApp();

    const tenantListDenied = await analystHeaders(request(app).get('/api/tenant/workspaces'));
    expect(tenantListDenied.status).toBe(403);
    expect(tenantListDenied.body.details).toContain('Tenant metadata requires');

    const ownWorkspaceUpdate = await workspaceAdminHeaders(
      request(app).patch('/api/tenant/workspaces/workspace-a/policies'),
    ).send({
      quotaPolicy: { maxConcurrentRuns: 2 },
    });
    expect(ownWorkspaceUpdate.status).toBe(200);
    expect(ownWorkspaceUpdate.body.workspace.quotaPolicy).toEqual({ maxConcurrentRuns: 2 });

    const otherWorkspaceDenied = await workspaceAdminHeaders(
      request(app).patch('/api/tenant/workspaces/workspace-b/policies'),
      'workspace-a',
    ).send({
      quotaPolicy: { maxConcurrentRuns: 3 },
    });
    expect(otherWorkspaceDenied.status).toBe(403);
    expect(otherWorkspaceDenied.body.details).toContain('Workspace management requires');
  });

  it('prevents workspace administrators from elevating themselves or peers', async () => {
    await seedTenantData();
    const app = makeApp();

    const selfElevation = await workspaceAdminHeaders(
      request(app).put('/api/tenant/workspaces/workspace-a/members/workspace-admin-a'),
    ).send({role: 'org_admin'});
    expect(selfElevation.status).toBe(403);
    expect(selfElevation.body.error).toContain('own role');

    const peerElevation = await workspaceAdminHeaders(
      request(app).put('/api/tenant/workspaces/workspace-a/members/analyst-b'),
    ).send({role: 'workspace_admin'});
    expect(peerElevation.status).toBe(403);
    expect(peerElevation.body.error).toContain('cannot grant role');
  });

  it('protects the last organization administrator membership', async () => {
    await seedTenantData();
    const app = makeApp();

    await adminHeaders(
      request(app).put('/api/tenant/workspaces/workspace-a/members/admin-a'),
    ).send({role: 'org_admin'}).expect(200);

    const deletion = await adminHeaders(
      request(app).delete('/api/tenant/workspaces/workspace-a/members/admin-a'),
    );
    expect(deletion.status).toBe(409);
    expect(deletion.body.error).toContain('last organization administrator');
  });

  it('creates a tenant tombstone, records audit state, and blocks new work', async () => {
    const app = makeApp();

    const denied = await adminHeaders(request(app).post('/api/tenant/tombstone')).send({});
    expect(denied.status).toBe(400);

    const res = await adminHeaders(request(app).post('/api/tenant/tombstone')).send({
      confirmTenantId: 'tenant-a',
      reason: 'customer requested deletion',
    });

    expect(res.status).toBe(202);
    expect(res.body.tombstone).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      requestedBy: 'admin-a',
      status: 'tombstoned',
      proofHash: null,
    }));
    expect(readTenantRow()?.status).toBe('tombstoned');

    const db = openEnterpriseDb(dbPath);
    try {
      const audit = db.prepare<unknown[], { action: string }>(`
        SELECT action
        FROM audit_events
        WHERE tenant_id = 'tenant-a' AND action = 'tenant.tombstoned'
      `).get();
      expect(audit?.action).toBe('tenant.tombstoned');
    } finally {
      db.close();
    }

    const decision = evaluateTenantMutationPolicy({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'admin-a',
      authType: 'sso',
      roles: ['org_admin'],
      scopes: ['*'],
      requestId: 'req-test',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.httpStatus).toBe(423);
  });

  it('rejects tombstone from non-admin users', async () => {
    const app = makeApp();

    const res = await analystHeaders(request(app).post('/api/tenant/tombstone')).send({
      confirmTenantId: 'tenant-a',
    });

    expect(res.status).toBe(403);
    expect(res.body.details).toBe('Tenant deletion requires org_admin or tenant:delete scope');
  });

  it('runs async purge after the seven-day window and keeps a proof hash', async () => {
    await seedTenantData();
    const app = makeApp();

    await adminHeaders(request(app).post('/api/tenant/tombstone')).send({
      confirmTenantId: 'tenant-a',
    }).expect(202);
    const windowRes = await adminHeaders(request(app).post('/api/tenant/purge')).send({
      confirmTenantId: 'tenant-a',
    });
    expect(windowRes.status).toBe(409);
    expect(windowRes.body.code).toBe('TENANT_PURGE_WINDOW_ACTIVE');

    const db = openEnterpriseDb(dbPath);
    try {
      db.prepare(`
        UPDATE tenant_tombstones
        SET purge_after = ?
        WHERE tenant_id = 'tenant-a'
      `).run(Date.now() - 1);
    } finally {
      db.close();
    }

    const enqueueRes = await adminHeaders(request(app).post('/api/tenant/purge')).send({
      confirmTenantId: 'tenant-a',
    });
    expect(enqueueRes.status).toBe(202);
    const jobRes = await waitForPurgeJob(app, enqueueRes.body.jobId);

    expect(jobRes.body.job.status).toBe('completed');
    expect(jobRes.body.job.proof).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      purgedBy: 'admin-a',
      proofHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      dataPathRemoved: true,
    }));
    await expect(fs.access(path.join(dataDir, 'tenant-a'))).rejects.toThrow();
    expect(readTombstone()).toEqual(expect.objectContaining({
      status: 'purged',
      proof_hash: jobRes.body.job.proof.proofHash,
    }));
    expect(readTenantRow()?.status).toBe('purged');
    expect(readCount('workspaces')).toBe(0);
    expect(readCount('trace_assets')).toBe(0);
    expect(readCount('analysis_runs')).toBe(0);
    expect(readCount('memory_entries')).toBe(0);
    expect(readCount('provider_snapshots')).toBe(0);
    expect(readCount('audit_events')).toBeGreaterThan(0);
  });

  it('blocks purge while tenant runs or leases are still active', async () => {
    await seedTenantData();
    const db = openEnterpriseDb(dbPath);
    try {
      db.prepare(`
        UPDATE analysis_runs
        SET status = 'running'
        WHERE id = 'run-a'
      `).run();
    } finally {
      db.close();
    }
    const app = makeApp();
    await adminHeaders(request(app).post('/api/tenant/tombstone')).send({
      confirmTenantId: 'tenant-a',
    }).expect(202);
    const updateDb = openEnterpriseDb(dbPath);
    try {
      updateDb.prepare(`
        UPDATE tenant_tombstones
        SET purge_after = ?
        WHERE tenant_id = 'tenant-a'
      `).run(Date.now() - 1);
    } finally {
      updateDb.close();
    }

    const enqueueRes = await adminHeaders(request(app).post('/api/tenant/purge')).send({
      confirmTenantId: 'tenant-a',
    });
    const jobRes = await waitForPurgeJob(app, enqueueRes.body.jobId);

    expect(jobRes.body.job.status).toBe('blocked');
    expect(jobRes.body.job.blockers).toEqual([
      expect.objectContaining({
        id: 'run-a',
        kind: 'analysis_run',
        status: 'running',
      }),
    ]);
    expect(readTombstone()?.status).toBe('purge_blocked');
    expect(readCount('trace_assets')).toBe(1);
  });
});
