// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';

import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import { stableStringify } from '../../utils/stableJson';
import exportRoutes from '../exportRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

let tmpDir: string;
let dbPath: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/export', exportRoutes);
  return app;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function ssoHeaders(
  req: request.Test,
  input: { role?: string; scopes?: string } = {},
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'user-a')
    .set('X-SmartPerfetto-SSO-Email', 'user-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', input.role ?? 'org_admin')
    .set('X-SmartPerfetto-SSO-Scopes', input.scopes ?? 'report:read');
}

async function seedTenantExportFixture(): Promise<void> {
  const reportDir = path.join(tmpDir, 'data', 'tenant-a', 'workspace-a', 'reports', 'report-a');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'report.html'), '<html><body>tenant report</body></html>');
  await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify({ title: 'Tenant report' }));

  const now = 1_800_000_000_000;
  const db = openEnterpriseDb(dbPath);
  try {
    db.prepare(`
      INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES
        ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?),
        ('tenant-b', 'Tenant B', 'active', 'enterprise', ?, ?)
    `).run(now, now, now, now);
    db.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, retention_policy, quota_policy, created_at, updated_at)
      VALUES
        ('workspace-a', 'tenant-a', 'Workspace A', '{"traceRetentionDays":7}', '{"monthlyRunLimit":10}', ?, ?),
        ('workspace-b', 'tenant-a', 'Workspace B', NULL, NULL, ?, ?),
        ('workspace-x', 'tenant-b', 'Workspace X', NULL, NULL, ?, ?)
    `).run(now, now, now, now, now, now);
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES
        ('user-a', 'tenant-a', 'user-a@example.test', 'User A', 'sso:user-a', ?, ?),
        ('user-b', 'tenant-b', 'user-b@example.test', 'User B', 'sso:user-b', ?, ?)
    `).run(now, now, now, now);
    db.prepare(`
      INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
      VALUES ('tenant-a', 'workspace-a', 'user-a', 'org_admin', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, sha256, size_bytes, status, metadata_json, created_at, expires_at)
      VALUES
        ('trace-a', 'tenant-a', 'workspace-a', 'user-a', '/tmp/tenant-a-trace.pftrace', 'sha-a', 123, 'ready', '{"device":"pixel"}', ?, NULL),
        ('trace-b', 'tenant-b', 'workspace-x', 'user-b', '/tmp/tenant-b-trace.pftrace', 'sha-b', 456, 'ready', NULL, ?, NULL)
    `).run(now, now);
    db.prepare(`
      INSERT INTO provider_snapshots
        (id, tenant_id, provider_id, snapshot_hash, runtime_kind, resolved_config_json, secret_version, created_at)
      VALUES
        ('snapshot-a', 'tenant-a', 'provider-a', 'hash-a', 'openai-agents-sdk', '{"connection":{"apiKey":"sk-secret","baseUrl":"https://example.test"}}', 'secret-v1', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO analysis_sessions
        (id, tenant_id, workspace_id, trace_id, created_by, provider_snapshot_id, title, visibility, status, created_at, updated_at)
      VALUES
        ('session-a', 'tenant-a', 'workspace-a', 'trace-a', 'user-a', 'snapshot-a', 'Session A', 'private', 'completed', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at, error_json, heartbeat_at, updated_at)
      VALUES
        ('run-a', 'tenant-a', 'workspace-a', 'session-a', 'quick', 'completed', 'Why jank?', ?, ?, NULL, ?, ?)
    `).run(now, now + 100, now + 50, now + 100);
    db.prepare(`
      INSERT INTO conversation_turns
        (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
      VALUES
        ('turn-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', 'assistant', '{"text":"answer"}', ?)
    `).run(now + 10);
    db.prepare(`
      INSERT INTO report_artifacts
        (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at)
      VALUES
        ('report-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', ?, 'hash-report-a', 'private', 'user-a', ?, NULL)
    `).run(path.join(reportDir, 'report.html'), now);
    db.prepare(`
      INSERT INTO memory_entries
        (id, tenant_id, workspace_id, scope, source_run_id, content_json, embedding_ref, created_at, updated_at)
      VALUES
        ('memory-a', 'tenant-a', 'workspace-a', 'baseline', 'run-a', '{"kind":"baseline","externalId":"baseline-a","record":{"value":1}}', NULL, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO provider_credentials
        (id, tenant_id, workspace_id, owner_user_id, scope, name, type, models_json, secret_ref, policy_json, created_at, updated_at)
      VALUES
        ('provider-a', 'tenant-a', 'workspace-a', 'user-a', 'personal', 'Provider A', 'openai', '{"primary":"gpt-5.2","light":"gpt-5.2-mini"}', 'secret:provider:tenant-a:workspace-a:user-a:provider-a', '{"connection":{"apiKey":"sk-secret","baseUrl":"https://example.test"},"secretVersion":1}', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO audit_events
        (id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at)
      VALUES
        ('audit-a', 'tenant-a', 'workspace-a', 'user-a', 'report.read', 'report', 'report-a', '{"ok":true}', ?),
        ('audit-b', 'tenant-b', 'workspace-x', 'user-b', 'report.read', 'report', 'report-b', NULL, ?)
    `).run(now, now);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-tenant-export-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  delete process.env.SMARTPERFETTO_API_KEY;
});

afterEach(async () => {
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enterprise tenant export route', () => {
  it('exports a tenant bundle with reports, manifests, identity proof, and no secrets', async () => {
    await seedTenantExportFixture();
    const app = makeApp();

    const res = await ssoHeaders(request(app).get('/api/export/tenant'));

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('smartperfetto-tenant-tenant-a');
    expect(res.body.success).toBe(true);
    expect(res.body.bundleSha256).toBe(
      `sha256:${crypto.createHash('sha256').update(stableStringify(res.body.bundle)).digest('hex')}`,
    );
    expect(res.body.bundle.tenantIdentityProof).toEqual(expect.objectContaining({
      tenantId: 'tenant-a',
      generatedBy: 'user-a',
      workspaceIds: ['workspace-a', 'workspace-b'],
    }));
    expect(res.body.bundle.manifest).toEqual(expect.objectContaining({
      traceFilesIncluded: false,
      traceCount: 1,
      reportCount: 1,
      sessionCount: 1,
      runCount: 1,
      turnCount: 1,
      memoryRecordCount: 1,
      auditEventCount: 1,
      providerCredentialCount: 1,
      providerSnapshotCount: 1,
    }));
    expect(res.body.bundle.traces[0]).toEqual(expect.objectContaining({
      id: 'trace-a',
      fileIncluded: false,
      sha256: 'sha-a',
    }));
    expect(res.body.bundle.reports[0]).toEqual(expect.objectContaining({
      id: 'report-a',
      html: '<html><body>tenant report</body></html>',
      json: { title: 'Tenant report' },
    }));
    expect(res.body.bundle.sessions[0].id).toBe('session-a');
    expect(res.body.bundle.runs[0].id).toBe('run-a');
    expect(res.body.bundle.turns[0].id).toBe('turn-a');
    expect(res.body.bundle.knowledge.memoryEntries[0].id).toBe('memory-a');

    const serialized = JSON.stringify(res.body.bundle);
    expect(serialized).not.toContain('tenant-b');
    expect(serialized).not.toContain('/tmp/tenant-a-trace.pftrace');
    expect(serialized).not.toContain('secret:provider');
    expect(serialized).not.toContain('sk-secret');
    expect(res.body.bundle.providers.credentials[0].policy.connection.apiKey).toBe('[redacted]');
    expect(res.body.bundle.providers.snapshots[0].resolvedConfig.connection.apiKey).toBe('[redacted]');

    const db = openEnterpriseDb(dbPath);
    try {
      const audit = db.prepare<unknown[], { action: string; metadata_json: string | null }>(`
        SELECT action, metadata_json
        FROM audit_events
        WHERE tenant_id = 'tenant-a' AND action = 'tenant.exported'
      `).get();
      expect(audit?.action).toBe('tenant.exported');
      expect(audit?.metadata_json).toContain(res.body.bundleSha256);
    } finally {
      db.close();
    }
  });

  it('exports and hashes content under an own __proto__ key in stored JSON', async () => {
    await seedTenantExportFixture();
    const setTraceMetadata = (metadata: string) => {
      const db = openEnterpriseDb(dbPath);
      try {
        db.prepare(`UPDATE trace_assets SET metadata_json = ? WHERE id = 'trace-a'`).run(metadata);
      } finally {
        db.close();
      }
    };
    const exportTraceMetadata = async (build: string) => {
      setTraceMetadata(`{"device":"pixel","__proto__":{"build":"${build}","apiKey":"sk-proto-secret"}}`);
      const res = await ssoHeaders(request(makeApp()).get('/api/export/tenant'));
      expect(res.status).toBe(200);
      // Re-hash what the client received, as a downstream verifier would.
      expect(res.body.bundleSha256).toBe(
        `sha256:${crypto.createHash('sha256').update(stableStringify(res.body.bundle)).digest('hex')}`,
      );
      return res;
    };

    const first = await exportTraceMetadata('A1');
    const metadata = first.body.bundle.traces[0].metadata;
    expect(Object.getOwnPropertyDescriptor(metadata, '__proto__')?.value).toEqual({
      build: 'A1',
      apiKey: '[redacted]',
    });
    expect(JSON.stringify(first.body.bundle)).not.toContain('sk-proto-secret');

    const second = await exportTraceMetadata('A2');
    expect(stableStringify(second.body.bundle.traces)).not.toBe(stableStringify(first.body.bundle.traces));
  });

  it('requires tenant export privileges', async () => {
    await seedTenantExportFixture();
    const app = makeApp();

    const res = await ssoHeaders(
      request(app).get('/api/export/tenant'),
      { role: 'analyst', scopes: 'report:read' },
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toBe('Tenant export requires org_admin or tenant:export scope');
  });
});
