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
import { listEnterpriseAuditEvents } from '../../services/enterpriseAuditService';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  ENTERPRISE_DATA_DIR_ENV,
  writeTraceMetadata,
} from '../../services/traceMetadataStore';
import reportRoutes, { persistReport, reportStore } from '../reportRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  enterpriseDataDir: process.env[ENTERPRISE_DATA_DIR_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

interface ReportArtifactRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  run_id: string;
  local_path: string;
  content_hash: string;
  visibility: string;
  created_by: string | null;
  expires_at: number | null;
}

let tmpDir: string;
let dbPath: string;
let dataDir: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportRoutes);
  return app;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function ssoHeaders(req: request.Test, workspaceId = 'workspace-a'): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'user-a')
    .set('X-SmartPerfetto-SSO-Email', 'user-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'workspace_admin')
    .set('X-SmartPerfetto-SSO-Scopes', 'report:read,report:delete');
}

function readReportArtifact(reportId: string): ReportArtifactRow | null {
  const db = openEnterpriseDb(dbPath);
  try {
    return db.prepare<unknown[], ReportArtifactRow>(`
      SELECT *
      FROM report_artifacts
      WHERE id = ?
    `).get(reportId) || null;
  } finally {
    db.close();
  }
}

function readAuditActions(): string[] {
  const db = openEnterpriseDb(dbPath);
  try {
    return listEnterpriseAuditEvents(db).map(event => event.action);
  } finally {
    db.close();
  }
}

function writeWorkspacePolicies(input: {
  retentionPolicy?: Record<string, unknown>;
}): void {
  const db = openEnterpriseDb(dbPath);
  const now = Date.now();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT OR REPLACE INTO workspaces
        (id, tenant_id, name, retention_policy, quota_policy, created_at, updated_at)
      VALUES
        ('workspace-a', 'tenant-a', 'workspace-a', ?, NULL, ?, ?)
    `).run(
      input.retentionPolicy ? JSON.stringify(input.retentionPolicy) : null,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-report-routes-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  dataDir = path.join(tmpDir, 'data');

  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env[ENTERPRISE_DATA_DIR_ENV] = dataDir;
  delete process.env.SMARTPERFETTO_API_KEY;
  reportStore.clear();
});

afterEach(async () => {
  reportStore.clear();
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(ENTERPRISE_DATA_DIR_ENV, originalEnv.enterpriseDataDir);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enterprise report routes', () => {
  it('starts an exported report filename with the current trace name', async () => {
    const app = makeApp();
    const reportId = 'report-trace-filename';
    const generatedAt = 1_700_000_000_000;
    const traceNamePrefix = `应用:trace?-${'a'.repeat(70)}`;
    const safeTraceNamePrefix = `应用_trace_-${'a'.repeat(70)}`;

    await writeTraceMetadata({
      id: 'trace-filename',
      filename: `../${traceNamePrefix}😀.pftrace`,
      size: 128,
      uploadedAt: new Date(generatedAt).toISOString(),
      status: 'ready',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    });
    persistReport(reportId, {
      html: '<html><body>trace filename report</body></html>',
      generatedAt,
      sessionId: 'session-trace-filename',
      runId: 'run-trace-filename',
      traceId: 'trace-filename',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      visibility: 'private',
    });

    reportStore.clear();
    const exportRes = await ssoHeaders(
      request(app).get(`/api/reports/${reportId}/export`),
    );
    const encodedFilename = /filename\*=UTF-8''([^;]+)/u.exec(
      exportRes.headers['content-disposition'] || '',
    )?.[1];

    expect(exportRes.status).toBe(200);
    expect(encodedFilename).toBeDefined();
    expect(decodeURIComponent(encodedFilename!)).toBe(
      `${safeTraceNamePrefix}-2023-11-14T22-13-20Z-SmartPerfetto.html`,
    );
  });

  it('stores reports in report_artifacts and reloads them from scoped data storage', async () => {
    const app = makeApp();
    const reportId = 'report-a';

    persistReport(reportId, {
      html: '<html><body>enterprise report</body></html>',
      generatedAt: 1_700_000_000_000,
      sessionId: 'session-a',
      runId: 'run-a',
      traceId: 'trace-a',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      visibility: 'private',
    });

    const expectedHtmlPath = path.join(
      dataDir,
      'tenant-a',
      'workspace-a',
      'reports',
      reportId,
      'report.html',
    );
    const expectedJsonPath = path.join(path.dirname(expectedHtmlPath), 'report.json');
    await expect(fs.access(expectedHtmlPath)).resolves.toBeUndefined();
    await expect(fs.access(expectedJsonPath)).resolves.toBeUndefined();

    const row = readReportArtifact(reportId);
    expect(row).toEqual(expect.objectContaining({
      id: reportId,
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      session_id: 'session-a',
      run_id: 'run-a',
      local_path: expectedHtmlPath,
      visibility: 'private',
      created_by: 'user-a',
    }));
    expect(row!.content_hash).toHaveLength(64);

    reportStore.clear();
    const getRes = await ssoHeaders(request(app).get(`/api/reports/${reportId}`));
    expect(getRes.status).toBe(200);
    expect(getRes.text).toContain('enterprise report');
    expect(getRes.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(getRes.headers['content-security-policy']).toContain("connect-src 'none'");

    const exportRes = await ssoHeaders(request(app).get(`/api/reports/${reportId}/export`));
    expect(exportRes.status).toBe(200);
    expect(exportRes.text).toContain('enterprise report');
    expect(exportRes.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(readAuditActions()).toEqual(expect.arrayContaining([
      'report.read',
      'report.exported',
    ]));

    const otherWorkspaceRes = await ssoHeaders(
      request(app).get(`/api/reports/${reportId}`),
      'workspace-b',
    );
    expect(otherWorkspaceRes.status).toBe(404);

    const missingReportRes = await ssoHeaders(request(app).get('/api/reports/report-missing'));
    expect(missingReportRes.status).toBe(404);
    expect(missingReportRes.text).toContain('<html');

    const otherWorkspaceExportRes = await ssoHeaders(
      request(app).get(`/api/reports/${reportId}/export`),
      'workspace-b',
    );
    expect(otherWorkspaceExportRes.status).toBe(404);
    expect(otherWorkspaceExportRes.body).toEqual({
      success: false,
      error: 'Report not found',
    });

    const missingExportRes = await ssoHeaders(request(app).get('/api/reports/report-missing/export'));
    expect(missingExportRes.status).toBe(404);
    expect(missingExportRes.body).toEqual({
      success: false,
      error: 'Report not found',
    });
  });

  it('deletes enterprise report_artifacts metadata and scoped report files', async () => {
    const app = makeApp();
    const reportId = 'report-delete';

    persistReport(reportId, {
      html: '<html><body>delete report</body></html>',
      generatedAt: 1_700_000_000_000,
      sessionId: 'session-delete',
      runId: 'run-delete',
      traceId: 'trace-delete',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      visibility: 'private',
    });
    const row = readReportArtifact(reportId);
    expect(row).not.toBeNull();

    reportStore.clear();
    const deleteRes = await ssoHeaders(request(app).delete(`/api/reports/${reportId}`));

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
    expect(readReportArtifact(reportId)).toBeNull();
    await expect(fs.access(row!.local_path)).rejects.toThrow();
    await expect(fs.access(path.dirname(row!.local_path))).rejects.toThrow();
    expect(readAuditActions()).toContain('report.deleted');
  });

  it('applies report retention policy and hides expired cached reports', async () => {
    const app = makeApp();
    const reportId = 'report-expired';
    writeWorkspacePolicies({
      retentionPolicy: {
        reportRetentionDays: 0,
      },
    });

    persistReport(reportId, {
      html: '<html><body>expired report</body></html>',
      generatedAt: Date.now() - 1,
      sessionId: 'session-expired',
      runId: 'run-expired',
      traceId: 'trace-expired',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      visibility: 'private',
    });

    expect(readReportArtifact(reportId)?.expires_at).toBeLessThanOrEqual(Date.now());
    const getRes = await ssoHeaders(request(app).get(`/api/reports/${reportId}`));
    expect(getRes.status).toBe(404);
  });
});
