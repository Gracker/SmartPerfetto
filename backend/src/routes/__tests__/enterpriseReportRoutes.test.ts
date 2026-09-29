// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
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
import reportRoutes, { ReportIdTakenError, persistReport, reportStore } from '../reportRoutes';
import { ENTERPRISE_MIGRATION_PHASE_ENV } from '../../services/enterpriseMigration';
import { backendLogPath } from '../../runtimePaths';
import {NO_PRIVATE_CONTEXT, type AnalysisPrivateContextMarker} from '../../services/security/analysisPrivateContext';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  enterpriseDataDir: process.env[ENTERPRISE_DATA_DIR_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
  logDir: process.env.SMARTPERFETTO_BACKEND_LOG_DIR,
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

function legacyReportFiles(reportId: string): {html: string; meta: string} {
  const reportsDir = backendLogPath('reports');
  return {html: path.join(reportsDir, `${reportId}.html`), meta: path.join(reportsDir, `${reportId}.meta.json`)};
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

function enterpriseReportDirOf(reportId: string): string {
  return path.join(dataDir, 'tenant-a', 'workspace-a', 'reports', reportId);
}

type NodeFs = typeof import('fs');
type AnyFunction = (...args: unknown[]) => unknown;
// The module object itself: reportRoutes reads its namespace binding at call time.
const nodeFs = require('fs') as NodeFs;

/** Replaces an fs function for the rest of the test, unless the returned spy is restored sooner. */
function interceptFs(
  name: 'openSync' | 'writeFileSync' | 'rmSync',
  fake: (real: AnyFunction, ...args: unknown[]) => unknown,
): {mockRestore(): void} {
  const real = nodeFs[name] as AnyFunction;
  return jest.spyOn(nodeFs, name).mockImplementation(((...args: unknown[]) => fake(real, ...args)) as never);
}

/**
 * The next write of a file matching `target` fails after half of its content
 * reached disk, as a full disk would.
 */
function failWritePartway(target: (file: string) => boolean): void {
  let failingFd: number | undefined;
  let failed = false;
  interceptFs('openSync', (real, file, ...rest) => {
    const fd = real(file, ...rest) as number;
    if (!failed && failingFd === undefined && target(String(file))) failingFd = fd;
    return fd;
  });
  interceptFs('writeFileSync', (real, file, data, ...rest) => {
    if (typeof file === 'number' ? file !== failingFd : failed || !target(String(file))) return real(file, data, ...rest);
    failed = true;
    failingFd = undefined;
    const text = String(data);
    real(file, text.slice(0, text.length >> 1), ...rest);
    throw Object.assign(new Error('ENOSPC: no space left on device'), {code: 'ENOSPC'});
  });
}

/** The enterprise content file of any write of the report. */
function isEnterpriseContent(reportId: string): (file: string) => boolean {
  return file => file.startsWith(enterpriseReportDirOf(reportId) + path.sep) && path.basename(file) === 'report.html';
}

/** Files created while `run` executes, in order, whether opened or written by path. */
function recordCreatedFiles(run: () => void): string[] {
  const created: string[] = [];
  const spies = [
    interceptFs('openSync', (real, file, ...rest) => {
      created.push(String(file));
      return real(file, ...rest);
    }),
    interceptFs('writeFileSync', (real, file, ...rest) => {
      if (typeof file !== 'number') created.push(String(file));
      return real(file, ...rest);
    }),
  ];
  try {
    run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return created;
}

function persistTestReport(reportId: string, privateContext: AnalysisPrivateContextMarker = NO_PRIVATE_CONTEXT): void {
  persistReport(reportId, {
    html: `<html><body>${reportId}</body></html>`,
    generatedAt: Date.now(),
    sessionId: `session-${reportId}`,
    runId: `run-${reportId}`,
    traceId: 'trace-a',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: 'user-a',
    visibility: 'private',
    privateContext,
  });
}

/** Makes the database refuse to remove report rows until restored. */
function failReportRowDeletion(): () => void {
  const {prepare} = Database.prototype;
  const spy = jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    source: string,
  ) {
    if (/^\s*DELETE FROM report_artifacts/u.test(source)) {
      throw Object.assign(new Error('disk I/O error'), {code: 'SQLITE_IOERR'});
    }
    return prepare.call(this, source);
  } as typeof prepare);
  return () => spy.mockRestore();
}

/** The content file a report's row publishes. */
function publishedContentPath(reportId: string): string {
  return readReportArtifact(reportId)!.local_path;
}

async function expectNothingStored(reportId: string): Promise<void> {
  expect(readReportArtifact(reportId)).toBeNull();
  expect(await exists(enterpriseReportDirOf(reportId))).toBe(false);
  for (const file of Object.values(legacyReportFiles(reportId))) expect(await exists(file)).toBe(false);
  expect(reportStore.has(reportId)).toBe(false);
}

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

function ssoHeaders(
  req: request.Test,
  workspaceId = 'workspace-a',
  {userId = 'user-a', roles = 'workspace_admin', scopes = 'report:read,report:delete'} = {},
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', roles)
    .set('X-SmartPerfetto-SSO-Scopes', scopes);
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
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tmpDir, 'logs');
  delete process.env.SMARTPERFETTO_API_KEY;
  reportStore.clear();
});

afterEach(async () => {
  jest.restoreAllMocks();
  reportStore.clear();
  restoreEnvValue('SMARTPERFETTO_BACKEND_LOG_DIR', originalEnv.logDir);
  restoreEnvValue(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
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
      privateContext: NO_PRIVATE_CONTEXT,
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
      privateContext: NO_PRIVATE_CONTEXT,
    });

    const row = readReportArtifact(reportId);
    // Each write keeps its files in a directory of its own under the report's directory.
    expect(path.dirname(path.dirname(row!.local_path))).toBe(enterpriseReportDirOf(reportId));
    expect(path.basename(row!.local_path)).toBe('report.html');
    await expect(fs.access(row!.local_path)).resolves.toBeUndefined();
    await expect(fs.access(path.join(path.dirname(row!.local_path), 'report.json'))).resolves.toBeUndefined();
    expect(row).toEqual(expect.objectContaining({
      id: reportId,
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      session_id: 'session-a',
      run_id: 'run-a',
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
      privateContext: NO_PRIVATE_CONTEXT,
    });
    const row = readReportArtifact(reportId);
    expect(row).not.toBeNull();

    reportStore.clear();
    const deleteRes = await ssoHeaders(request(app).delete(`/api/reports/${reportId}`));

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
    expect(readReportArtifact(reportId)).toBeNull();
    await expectNothingStored(reportId);
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
      privateContext: NO_PRIVATE_CONTEXT,
    });

    expect(readReportArtifact(reportId)?.expires_at).toBeLessThanOrEqual(Date.now());
    const getRes = await ssoHeaders(request(app).get(`/api/reports/${reportId}`));
    expect(getRes.status).toBe(404);
  });
});

describe.each([
  ['filesystem read authority (dual-write)', 'dual-write'],
  ['database read authority (retired)', 'retired'],
])('private-context report audience with %s', (_label, phase) => {
  beforeEach(() => {
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = phase;
  });

  /** Make a stored report look as it did before markers existed, in every store. */
  async function rewriteStored(reportId: string, update: {forgetMarker?: boolean; forgetCreator?: boolean}) {
    const db = openEnterpriseDb(dbPath);
    try {
      if (update.forgetMarker) db.prepare('UPDATE report_artifacts SET private_context = NULL WHERE id = ?').run(reportId);
      if (update.forgetCreator) db.prepare('UPDATE report_artifacts SET created_by = NULL WHERE id = ?').run(reportId);
    } finally {
      db.close();
    }
    const metaPath = legacyReportFiles(reportId).meta;
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8').catch(() => 'null'));
    if (meta) {
      if (update.forgetMarker) delete meta.privateContext;
      if (update.forgetCreator) delete meta.userId;
      await fs.writeFile(metaPath, JSON.stringify(meta));
    }
    reportStore.clear();
  }

  async function statuses(reportId: string, userId: string): Promise<number[]> {
    const app = makeApp();
    const viewer = {userId, roles: 'viewer', scopes: 'report:read'};
    const read = (await ssoHeaders(request(app).get(`/api/reports/${reportId}`), 'workspace-a', viewer)).status;
    const exported = (await ssoHeaders(request(app).get(`/api/reports/${reportId}/export`), 'workspace-a', viewer))
      .status;
    return [read, exported];
  }

  it('keeps a private report with its creator from the cache, from disk and on export', async () => {
    const reportId = `report-private-${phase}`;
    persistTestReport(reportId, {codebase: true, knowledge: false});
    expect(readReportArtifact(reportId)).toMatchObject({private_context: 1});

    expect(await statuses(reportId, 'user-b')).toEqual([404, 404]);
    expect(await statuses(reportId, 'user-a')).toEqual([200, 200]);
    reportStore.clear();
    expect(await statuses(reportId, 'user-b')).toEqual([404, 404]);
    reportStore.clear();
    expect(await statuses(reportId, 'user-a')).toEqual([200, 200]);
  });

  it('refuses a second write under a report id and keeps the first', async () => {
    const reportId = `report-write-once-${phase}`;
    persistTestReport(reportId, {codebase: true, knowledge: false});
    expect(() => persistTestReport(reportId, NO_PRIVATE_CONTEXT)).toThrow(ReportIdTakenError);
    // Without this process's cache the stores themselves refuse the id.
    reportStore.clear();
    expect(() => persistTestReport(reportId, NO_PRIVATE_CONTEXT)).toThrow(ReportIdTakenError);

    expect(readReportArtifact(reportId)).toMatchObject({private_context: 1});
    expect(await statuses(reportId, 'user-b')).toEqual([404, 404]);
    reportStore.clear();
    expect(await statuses(reportId, 'user-a')).toEqual([200, 200]);
  });

  it('leaves no rows behind for a write refused as a duplicate', () => {
    const reportId = `report-duplicate-${phase}`;
    persistTestReport(reportId);
    expect(() => persistReport(reportId, {
      html: '<html><body>duplicate</body></html>',
      generatedAt: Date.now(),
      sessionId: 'session-duplicate',
      runId: 'run-duplicate',
      traceId: 'trace-a',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
      visibility: 'private',
      privateContext: NO_PRIVATE_CONTEXT,
    })).toThrow(ReportIdTakenError);

    const db = openEnterpriseDb(dbPath);
    try {
      expect(db.prepare('SELECT id FROM analysis_sessions WHERE id = ?').get('session-duplicate')).toBeUndefined();
      expect(db.prepare('SELECT id FROM analysis_runs WHERE id = ?').get('run-duplicate')).toBeUndefined();
    } finally {
      db.close();
    }
    expect(nodeFs.readdirSync(enterpriseReportDirOf(reportId))).toHaveLength(1);
  });

  it('releases the id in every store when the database copy fails partway', async () => {
    const reportId = `report-rollback-${phase}`;
    failWritePartway(isEnterpriseContent(reportId));
    expect(() => persistTestReport(reportId)).toThrow('ENOSPC');

    await expectNothingStored(reportId);
    expect(await statuses(reportId, 'user-a')).toEqual([404, 404]);
    persistTestReport(reportId, NO_PRIVATE_CONTEXT);
    reportStore.clear();
    expect(await statuses(reportId, 'user-b')).toEqual([200, 200]);
  });

  it('keeps the record when its content cannot be removed, so the deletion can be retried', async () => {
    const reportId = `report-undeletable-${phase}`;
    persistTestReport(reportId, NO_PRIVATE_CONTEXT);
    const contentDir = path.dirname(publishedContentPath(reportId));
    const rmSpy = interceptFs('rmSync', (real, target, ...rest) => {
      if (String(target) === contentDir) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
      return real(target, ...rest);
    });
    const app = makeApp();
    expect((await ssoHeaders(request(app).delete(`/api/reports/${reportId}`))).status).toBe(500);
    rmSpy.mockRestore();
    expect(readReportArtifact(reportId)).not.toBeNull();

    expect((await ssoHeaders(request(app).delete(`/api/reports/${reportId}`))).status).toBe(200);
    await expectNothingStored(reportId);
  });

  it('keeps the record when its row cannot be removed, so the deletion can be retried', async () => {
    const reportId = `report-row-undeletable-${phase}`;
    persistTestReport(reportId, NO_PRIVATE_CONTEXT);
    const app = makeApp();
    const restore = failReportRowDeletion();
    expect((await ssoHeaders(request(app).delete(`/api/reports/${reportId}`))).status).toBe(500);
    restore();
    expect(readReportArtifact(reportId)).not.toBeNull();

    expect((await ssoHeaders(request(app).delete(`/api/reports/${reportId}`))).status).toBe(200);
    await expectNothingStored(reportId);
  });

  it('lets its creator delete a report whose content no longer matches its record', async () => {
    const reportId = `report-corrupt-${phase}`;
    persistTestReport(reportId, {codebase: true, knowledge: false});
    for (const file of [legacyReportFiles(reportId).html, publishedContentPath(reportId)]) {
      if (await exists(file)) await fs.writeFile(file, '<html><body>partial');
    }
    reportStore.clear();
    expect(await statuses(reportId, 'user-a')).toEqual([404, 404]);

    const deleteRes = await ssoHeaders(request(makeApp()).delete(`/api/reports/${reportId}`));
    expect(deleteRes.status).toBe(200);
    await expectNothingStored(reportId);
  });

  it('serves content only with the record written for it', async () => {
    const reportId = `report-bound-${phase}`;
    persistTestReport(reportId, NO_PRIVATE_CONTEXT);
    // Content that is not the record's own: a partial write, or an id deleted and re-created under a reader.
    for (const file of [legacyReportFiles(reportId).html, publishedContentPath(reportId)]) {
      if (await exists(file)) await fs.writeFile(file, '<html><body>other content</body></html>');
    }
    reportStore.clear();
    expect(await statuses(reportId, 'user-a')).toEqual([404, 404]);
  });

  it('keeps a public report readable by the workspace', async () => {
    const reportId = `report-public-${phase}`;
    persistTestReport(reportId, NO_PRIVATE_CONTEXT);
    expect(await statuses(reportId, 'user-b')).toEqual([200, 200]);
    reportStore.clear();
    expect(await statuses(reportId, 'user-b')).toEqual([200, 200]);
  });

  it('restricts a report written before markers existed, and one whose creator is gone', async () => {
    const reportId = `report-legacy-${phase}`;
    persistTestReport(reportId, NO_PRIVATE_CONTEXT);
    await rewriteStored(reportId, {forgetMarker: true});
    expect(await statuses(reportId, 'user-b')).toEqual([404, 404]);
    reportStore.clear();
    expect(await statuses(reportId, 'user-a')).toEqual([200, 200]);

    // Deleting the creating user nulls created_by; an unknown creator admits no account.
    await rewriteStored(reportId, {forgetCreator: true});
    expect(await statuses(reportId, 'user-a')).toEqual([404, 404]);
  });
});

describe.each([
  ['legacy'],
  ['dual-write'],
])('report persistence with filesystem read authority (%s)', (phase) => {
  beforeEach(() => {
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = phase;
  });

  it('writes the read-authority copy last', () => {
    const reportId = `report-commit-order-${phase}`;
    const created = recordCreatedFiles(() => persistTestReport(reportId))
      .filter(file => file.includes(reportId))
      .map(file => `${file.startsWith(dataDir) ? 'database' : 'filesystem'}:${path.basename(file)}`);

    // Readers use only the filesystem copy, so it becomes readable after the database copy is complete.
    expect(created).toEqual([
      ...(phase === 'dual-write' ? ['database:report.json', 'database:report.html'] : []),
      `filesystem:${reportId}.meta.json`,
      `filesystem:${reportId}.html`,
    ]);
  });

  it.each([
    ['its content', '.html'],
    ['its claiming metadata', '.meta.json'],
  ])('releases every store when %s fails partway', async (_label, suffix) => {
    const reportId = `report-authority-rollback${suffix.replace(/\./g, '-')}-${phase}`;
    failWritePartway(file => file.endsWith(`${reportId}${suffix}`));
    expect(() => persistTestReport(reportId)).toThrow('ENOSPC');

    await expectNothingStored(reportId);
    persistTestReport(reportId);
    expect(reportStore.has(reportId)).toBe(true);
  });

  it('lets its creator delete a claim whose content never landed', async () => {
    // A crash between the claiming metadata and the content leaves only the claim.
    const reportId = `report-claim-only-${phase}`;
    persistTestReport(reportId);
    await fs.rm(legacyReportFiles(reportId).html);
    reportStore.clear();
    const app = makeApp();
    expect((await ssoHeaders(request(app).get(`/api/reports/${reportId}`))).status).toBe(404);

    const deleteRes = await ssoHeaders(request(app).delete(`/api/reports/${reportId}`));
    expect(deleteRes.status).toBe(200);
    await expectNothingStored(reportId);
  });
});

describe('local report persistence without accounts', () => {
  beforeEach(() => {
    delete process.env[ENTERPRISE_FEATURE_FLAG_ENV];
    delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  });

  it('keeps a report with unreadable metadata unserved but deletable', async () => {
    const reportId = 'report-unreadable-meta';
    persistReport(reportId, {
      html: '<html><body>local report</body></html>',
      generatedAt: Date.now(),
      sessionId: 'session-local',
      privateContext: NO_PRIVATE_CONTEXT,
    });
    // A crash while the metadata was written leaves it truncated.
    await fs.writeFile(legacyReportFiles(reportId).meta, '{"generatedAt":');
    reportStore.clear();
    const app = makeApp();
    expect((await request(app).get(`/api/reports/${reportId}`)).status).toBe(404);

    expect((await request(app).delete(`/api/reports/${reportId}`)).status).toBe(200);
    for (const file of Object.values(legacyReportFiles(reportId))) expect(await exists(file)).toBe(false);
  });
});

describe('dual-write report withdrawal', () => {
  beforeEach(() => {
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'dual-write';
  });

  it('withdraws only its own database copy when the id changed hands', async () => {
    const reportId = 'report-changed-hands';
    // While the filesystem copy is being written, the database copy is replaced by another writer's.
    const otherContent = path.join(enterpriseReportDirOf(reportId), 'other-write', 'report.html');
    interceptFs('openSync', (real, file, ...rest) => {
      if (String(file).endsWith(`${reportId}.meta.json`)) {
        const db = openEnterpriseDb(dbPath);
        try {
          db.prepare('UPDATE report_artifacts SET local_path = ? WHERE id = ?').run(otherContent, reportId);
        } finally {
          db.close();
        }
        nodeFs.mkdirSync(path.dirname(otherContent), {recursive: true});
        nodeFs.writeFileSync(otherContent, '<html><body>other writer</body></html>');
        throw Object.assign(new Error('EIO: i/o error'), {code: 'EIO'});
      }
      return real(file, ...rest);
    });
    expect(() => persistTestReport(reportId)).toThrow('EIO');

    expect(readReportArtifact(reportId)?.local_path).toBe(otherContent);
    expect(await exists(otherContent)).toBe(true);
    expect(nodeFs.readdirSync(enterpriseReportDirOf(reportId))).toEqual(['other-write']);
  });

  it('leaves a failed write unreadable even when its row cannot be withdrawn', async () => {
    const reportId = 'report-withdrawal-without-row';
    failReportRowDeletion();
    failWritePartway(file => file.endsWith(`${reportId}.html`));
    expect(() => persistTestReport(reportId)).toThrow('ENOSPC');

    // The row stayed, but its content is gone: once the database is the read authority,
    // the write that was reported failed is still not readable.
    expect(readReportArtifact(reportId)).not.toBeNull();
    process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'retired';
    reportStore.clear();
    expect((await ssoHeaders(request(makeApp()).get(`/api/reports/${reportId}`))).status).toBe(404);
  });
});
