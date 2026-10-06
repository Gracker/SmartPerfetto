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
import {AnalysisHistoryStore} from '../../services/analysisHistoryStore';
import {toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import exportRoutes from '../exportRoutes';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

let tmpDir: string;
let dbPath: string;

async function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/export', exportRoutes);
  return loopbackServers.listen(app);
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
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at, error_json, heartbeat_at, updated_at,
         private_context)
      VALUES
        ('run-a', 'tenant-a', 'workspace-a', 'session-a', 'quick', 'completed', 'Why jank?', ?, ?, NULL, ?, ?, 0)
    `).run(now, now + 100, now + 50, now + 100);
    db.prepare(`
      INSERT INTO conversation_turns
        (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
      VALUES
        ('turn-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', 'assistant', '{"text":"answer"}', ?)
    `).run(now + 10);
    db.prepare(`
      INSERT INTO report_artifacts
        (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at, expires_at,
         private_context)
      VALUES
        ('report-a', 'tenant-a', 'workspace-a', 'session-a', 'run-a', ?, 'hash-report-a', 'private', 'user-a', ?, NULL, 0)
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
  await loopbackServers.close();
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedRestrictedContentFixture(): Promise<void> {
  const now = 1_800_000_000_000;
  const reportPaths: Record<string, string> = {};
  for (const [reportId, body] of [['report-private', 'PRIVATE_REPORT'], ['report-legacy', 'LEGACY_REPORT']]) {
    const dir = path.join(tmpDir, 'data', 'tenant-a', 'workspace-a', 'reports', reportId);
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(path.join(dir, 'report.html'), `<html><body>${body}</body></html>`);
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify({title: body}));
    reportPaths[reportId] = path.join(dir, 'report.html');
  }
  const db = openEnterpriseDb(dbPath);
  try {
    const insertRun = db.prepare(`
      INSERT INTO analysis_runs
        (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at, error_json,
         heartbeat_at, updated_at, private_context)
      VALUES (?, 'tenant-a', 'workspace-a', 'session-a', 'full', 'failed', ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRun.run('run-private', 'PRIVATE_QUESTION', now, now, '{"message":"PRIVATE_ERROR"}', now, now, 1);
    // Written before markers existed: nothing proves it read no private material.
    insertRun.run('run-legacy', 'LEGACY_QUESTION', now, now, '{"message":"LEGACY_ERROR"}', now, now, null);
    const insertTurn = db.prepare(`
      INSERT INTO conversation_turns (id, tenant_id, workspace_id, session_id, run_id, role, content_json, created_at)
      VALUES (?, 'tenant-a', 'workspace-a', 'session-a', ?, 'assistant', ?, ?)
    `);
    insertTurn.run('turn-private', 'run-private', '{"text":"PRIVATE_TURN"}', now);
    insertTurn.run('turn-legacy', 'run-legacy', '{"text":"LEGACY_TURN"}', now);
    // A private run's history keeps its creator's question for follow-ups; the export still omits it.
    new AnalysisHistoryStore(db).append({tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a',
      sessionId: 'session-a', traceId: 'trace-a', runId: 'run-private'}, toAnalysisHistoryTurn({id: 'turn-private-history',
      turnIndex: 0, traceId: 'trace-a', timestamp: now, query: 'PRIVATE_HISTORY_QUESTION', sourceDerived: true,
      result: {message: 'answer'}}));
    const insertReport = db.prepare(`
      INSERT INTO report_artifacts
        (id, tenant_id, workspace_id, session_id, run_id, local_path, content_hash, visibility, created_by, created_at,
         expires_at, private_context)
      VALUES (?, 'tenant-a', 'workspace-a', 'session-a', ?, ?, ?, 'private', 'user-a', ?, NULL, ?)
    `);
    insertReport.run('report-private', 'run-private', reportPaths['report-private'], 'hash-private', now, 2);
    insertReport.run('report-legacy', 'run-legacy', reportPaths['report-legacy'], 'hash-legacy', now, null);
    const insertMemory = db.prepare(`
      INSERT INTO memory_entries
        (id, tenant_id, workspace_id, scope, source_run_id, content_json, embedding_ref, created_at, updated_at)
      VALUES (?, 'tenant-a', 'workspace-a', ?, ?, ?, NULL, ?, ?)
    `);
    const chunk = (kind: string, text: string, registryOrigin?: string) => JSON.stringify({
      kind: 'rag_chunk', externalId: `${kind}-chunk`,
      record: {chunkId: `${kind}-chunk`, kind, snippet: text, ...(registryOrigin ? {registryOrigin} : {})},
    });
    insertMemory.run('memory-private-run', 'baseline', 'run-private',
      '{"kind":"baseline","externalId":"b","record":{"note":"PRIVATE_MEMORY"}}', now, now);
    insertMemory.run('memory-unlinked', 'baseline', null,
      '{"kind":"baseline","externalId":"u","record":{"note":"UNLINKED_MEMORY"}}', now, now);
    insertMemory.run('chunk-private-source', 'rag:app_source', null,
      chunk('app_source', 'PRIVATE_SOURCE_CHUNK', 'codebase_registry'), now, now);
    insertMemory.run('chunk-public-blog', 'rag:androidperformance.com', null,
      chunk('androidperformance.com', 'PUBLIC_BLOG_CHUNK'), now, now);
    // Last written by a public run, yet it holds an entry no run can be proven
    // to have written publicly: the bucket is exported entry by entry.
    insertMemory.run('memory-pattern-bucket', 'pattern-memory:positive', 'run-a', JSON.stringify({
      kind: 'analysis_pattern_bucket', externalId: 'positive', record: [
        {id: 'pat-legacy', keyInsights: ['LEGACY_PATTERN']},
        {id: 'pat-admitted', keyInsights: ['ADMITTED_PATTERN'],
          learningAdmission: {version: 1, basis: 'public_run', runId: 'run-a', admittedAt: now}},
      ],
    }), now, now);
    // A malformed bucket carries nothing, even though a public run wrote it last.
    insertMemory.run('memory-pattern-bucket-malformed', 'pattern-memory:negative', 'run-a', JSON.stringify({
      kind: 'analysis_pattern_bucket', externalId: 'negative',
      record: {entries: [{id: 'neg-legacy', failedApproaches: [{approach: 'MALFORMED_BUCKET_PATTERN'}]}]},
    }), now, now);
  } finally {
    db.close();
  }
}

describe('enterprise tenant export route', () => {
  it('exports a tenant bundle with reports, manifests, identity proof, and no secrets', async () => {
    await seedTenantExportFixture();
    const app = await makeApp();

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
    expect(res.body.bundle.schemaVersion).toBe(2);
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
      contentPolicy: 'public_context_only',
      contentOmitted: {reports: 0, runs: 0, turns: 0, memoryRecords: 0},
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

  it('keeps content a private or unknown context may have derived out of the compliance bundle', async () => {
    await seedTenantExportFixture();
    await seedRestrictedContentFixture();

    const res = await ssoHeaders(request(await makeApp()).get('/api/export/tenant'));

    expect(res.status).toBe(200);
    const bundle = res.body.bundle;
    const serialized = JSON.stringify(bundle);
    for (const secret of ['PRIVATE_QUESTION', 'PRIVATE_HISTORY_QUESTION', 'PRIVATE_ERROR', 'PRIVATE_TURN', 'PRIVATE_REPORT', 'PRIVATE_MEMORY',
      'LEGACY_QUESTION', 'LEGACY_ERROR', 'LEGACY_TURN', 'LEGACY_REPORT', 'UNLINKED_MEMORY', 'PRIVATE_SOURCE_CHUNK',
      'LEGACY_PATTERN', 'MALFORMED_BUCKET_PATTERN']) {
      expect(serialized).not.toContain(secret);
    }
    // Public material keeps its content.
    expect(serialized).toContain('PUBLIC_BLOG_CHUNK');
    expect(serialized).toContain('ADMITTED_PATTERN');
    expect(serialized).toContain('Why jank?');
    expect(serialized).toContain('tenant report');

    const byId = (records: Array<{id: string}>, id: string) => records.find(record => record.id === id);
    expect(byId(bundle.runs, 'run-private')).toMatchObject({question: null, error: null,
      privateContext: {codebase: true, knowledge: false}, contentOmitted: 'private_context'});
    expect(byId(bundle.runs, 'run-legacy')).toMatchObject({question: null, privateContext: 'unknown',
      contentOmitted: 'private_context'});
    expect(byId(bundle.reports, 'report-private')).toMatchObject({html: null, json: null,
      privateContext: {codebase: false, knowledge: true}, contentOmitted: 'private_context', contentHash: 'hash-private'});
    expect(byId(bundle.reports, 'report-legacy')).toMatchObject({html: null, privateContext: 'unknown'});
    expect(byId(bundle.turns, 'turn-legacy')).toMatchObject({content: null, contentOmitted: 'private_context'});
    expect(byId(bundle.turns, 'turn-private-history')).toMatchObject({content: null, contentOmitted: 'private_context'});
    expect(byId(bundle.knowledge.memoryEntries, 'chunk-public-blog')).not.toHaveProperty('contentOmitted');
    expect(byId(bundle.knowledge.memoryEntries, 'memory-pattern-bucket')).toMatchObject({
      content: {record: [{id: 'pat-admitted'}]}});
    expect(byId(bundle.knowledge.memoryEntries, 'memory-pattern-bucket-malformed')).toMatchObject({
      content: null, contentOmitted: 'private_context'});
    expect(bundle.manifest.contentOmitted).toEqual({reports: 2, runs: 2, turns: 3, memoryRecords: 4});
    expect(bundle.manifest).toEqual(expect.objectContaining({runCount: 3, turnCount: 4, reportCount: 3,
      memoryRecordCount: 7}));
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
      const res = await ssoHeaders(request(await makeApp()).get('/api/export/tenant'));
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
    const app = await makeApp();

    const res = await ssoHeaders(
      request(app).get('/api/export/tenant'),
      { role: 'analyst', scopes: 'report:read' },
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toBe('Tenant export requires org_admin or tenant:export scope');
  });
});
