// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../enterpriseDb';
import {
  ENTERPRISE_MIGRATION_PHASE_ENV,
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  buildEnterpriseMigrationDryRun,
  createEnterpriseMigrationSnapshot,
  resolveEnterpriseMigrationPlan,
  restoreEnterpriseMigrationSnapshot,
} from '../enterpriseMigration';
import {
  getTraceMetadataPath,
  readTraceMetadata,
  writeTraceMetadata,
} from '../traceMetadataStore';

const DATA_DIR_ENV = 'SMARTPERFETTO_DATA_DIR';
const LOGS_DIR_ENV = 'SMARTPERFETTO_LOGS_DIR';
const PROVIDER_DATA_DIR_ENV = 'PROVIDER_DATA_DIR_OVERRIDE';
const UPLOAD_DIR_ENV = 'UPLOAD_DIR';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
  cutoverConfirmed: process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV],
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  dataDir: process.env[DATA_DIR_ENV],
  logsDir: process.env[LOGS_DIR_ENV],
  providerDataDir: process.env[PROVIDER_DATA_DIR_ENV],
  uploadDir: process.env[UPLOAD_DIR_ENV],
};

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function applyEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

function testEnv(tmpDir: string, phase = 'cutover'): Record<string, string> {
  return {
    [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
    [ENTERPRISE_MIGRATION_PHASE_ENV]: phase,
    [ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV]: 'true',
    [ENTERPRISE_DB_PATH_ENV]: path.join(tmpDir, 'enterprise.sqlite'),
    [DATA_DIR_ENV]: path.join(tmpDir, 'data'),
    [LOGS_DIR_ENV]: path.join(tmpDir, 'logs'),
    [PROVIDER_DATA_DIR_ENV]: path.join(tmpDir, 'provider'),
    [UPLOAD_DIR_ENV]: path.join(tmpDir, 'uploads'),
  };
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), {recursive: true});
  await fsp.writeFile(filePath, text, 'utf-8');
}

afterEach(() => {
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  restoreEnvValue(ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV, originalEnv.cutoverConfirmed);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(DATA_DIR_ENV, originalEnv.dataDir);
  restoreEnvValue(LOGS_DIR_ENV, originalEnv.logsDir);
  restoreEnvValue(PROVIDER_DATA_DIR_ENV, originalEnv.providerDataDir);
  restoreEnvValue(UPLOAD_DIR_ENV, originalEnv.uploadDir);
});

describe('enterprise migration phases', () => {
  it('resolves legacy, dual-write, cutover, and retired storage semantics', () => {
    expect(resolveEnterpriseMigrationPlan({}).phase).toBe('legacy');

    expect(resolveEnterpriseMigrationPlan({
      [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
    }).phase).toBe('dual-write');

    expect(resolveEnterpriseMigrationPlan({
      [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
      [ENTERPRISE_MIGRATION_PHASE_ENV]: 'P-A',
    })).toEqual(expect.objectContaining({
      phase: 'dual-write',
      readAuthority: 'filesystem',
      writeFilesystem: true,
      writeDb: true,
      rollback: 'delete-db',
    }));

    expect(resolveEnterpriseMigrationPlan({
      [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
      [ENTERPRISE_MIGRATION_PHASE_ENV]: 'cutover',
      [ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV]: 'true',
    })).toEqual(expect.objectContaining({
      phase: 'cutover',
      readAuthority: 'db',
      writeFilesystem: false,
      writeDb: true,
      rollback: 'restore-snapshots',
    }));

    expect(resolveEnterpriseMigrationPlan({
      [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
      [ENTERPRISE_MIGRATION_PHASE_ENV]: 'retired',
    })).toEqual(expect.objectContaining({
      phase: 'retired',
      readAuthority: 'db',
      writeFilesystem: false,
      writeDb: true,
      rollback: 'restore-snapshots',
    }));
  });

  it('uses scoped DB authority by default for built-in OIDC only', () => {
    const oidcEnv = {
      SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
      SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
      SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'https://app.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
      FRONTEND_URL: 'https://app.example.test',
    } as NodeJS.ProcessEnv;

    expect(resolveEnterpriseMigrationPlan(oidcEnv)).toEqual(expect.objectContaining({
      phase: 'retired',
      readAuthority: 'db',
      writeFilesystem: false,
      writeDb: true,
    }));
    expect(() => resolveEnterpriseMigrationPlan({
      ...oidcEnv,
      [ENTERPRISE_MIGRATION_PHASE_ENV]: 'dual-write',
    })).toThrow(/OIDC requires DB-authoritative storage/);
    expect(resolveEnterpriseMigrationPlan({
      [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
    }).phase).toBe('dual-write');
  });

  it('refuses DB-authoritative cutover without an explicit reconciliation confirmation', () => {
    expect(() => resolveEnterpriseMigrationPlan({
      [ENTERPRISE_FEATURE_FLAG_ENV]: 'true',
      [ENTERPRISE_MIGRATION_PHASE_ENV]: 'cutover',
    })).toThrow(ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV);
  });

  it('dual-writes trace metadata while keeping legacy JSON authoritative until cutover', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-migration-trace-'));
    try {
      applyEnv(testEnv(tmpDir, 'dual-write'));
      await writeTraceMetadata({
        id: 'trace-a',
        filename: 'legacy-authority.perfetto-trace',
        size: 123,
        uploadedAt: new Date(0).toISOString(),
        status: 'ready',
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
      });

      const legacyPath = getTraceMetadataPath('trace-a')!;
      expect(fs.existsSync(legacyPath)).toBe(true);

      let db = openEnterpriseDb(process.env[ENTERPRISE_DB_PATH_ENV]!);
      try {
        const row = db.prepare(`
          SELECT tenant_id, workspace_id, metadata_json
          FROM trace_assets
          WHERE id = 'trace-a'
        `).get() as {tenant_id: string; workspace_id: string; metadata_json: string};
        expect(row.tenant_id).toBe('tenant-a');
        expect(row.workspace_id).toBe('workspace-a');
        expect(row.metadata_json).toContain('legacy-authority.perfetto-trace');
        db.prepare(`
          UPDATE trace_assets
          SET metadata_json = ?
          WHERE id = 'trace-a'
        `).run(JSON.stringify({
          filename: 'db-shadow-only.perfetto-trace',
          uploadedAt: new Date(0).toISOString(),
        }));
      } finally {
        db.close();
      }

      await expect(readTraceMetadata('trace-a')).resolves.toEqual(
        expect.objectContaining({filename: 'legacy-authority.perfetto-trace'}),
      );

      process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'cutover';
      await writeTraceMetadata({
        id: 'trace-b',
        filename: 'db-authority.perfetto-trace',
        size: 456,
        uploadedAt: new Date(1).toISOString(),
        status: 'ready',
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
      });

      expect(fs.existsSync(getTraceMetadataPath('trace-b')!)).toBe(false);
      await expect(readTraceMetadata('trace-b')).resolves.toEqual(
        expect.objectContaining({filename: 'db-authority.perfetto-trace'}),
      );
      await expect(readTraceMetadata('trace-a')).resolves.toEqual(
        expect.objectContaining({filename: 'db-shadow-only.perfetto-trace'}),
      );
    } finally {
      await fsp.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('creates dry-run fingerprints, filesystem snapshots, DB snapshots, and restores them', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-migration-snapshot-'));
    try {
      const env = testEnv(tmpDir, 'retired');
      await writeText(path.join(env[UPLOAD_DIR_ENV], 'traces', 'trace-a.json'), '{"id":"trace-a"}');
      await writeText(path.join(env[LOGS_DIR_ENV], 'reports', 'report-a.html'), '<html>report</html>');
      await writeText(path.join(env[DATA_DIR_ENV], 'tenant-a', 'workspace-a', 'traces', 'trace-a.trace'), 'trace bytes');
      await writeText(path.join(env[PROVIDER_DATA_DIR_ENV], 'providers.json'), '[{"id":"legacy-provider"}]');

      const db = openEnterpriseDb(env[ENTERPRISE_DB_PATH_ENV]);
      try {
        db.prepare(`
          INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
          VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', 1, 1)
        `).run();
      } finally {
        db.close();
      }

      const dryRun = buildEnterpriseMigrationDryRun({
        env: env as NodeJS.ProcessEnv,
        snapshotRoot: path.join(tmpDir, 'snapshots'),
        now: new Date('2026-05-08T00:00:00.000Z'),
      });
      expect(dryRun.phase).toBe('retired');
      expect(dryRun.filesystem.find(item => item.label === 'uploads')).toEqual(
        expect.objectContaining({exists: true, fileCount: 1}),
      );
      expect(dryRun.database.tableCounts.organizations).toBe(1);
      expect(dryRun.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const manifest = await createEnterpriseMigrationSnapshot({
        env: env as NodeJS.ProcessEnv,
        snapshotRoot: path.join(tmpDir, 'snapshots'),
        snapshotId: 'snapshot-a',
        now: new Date('2026-05-08T00:00:00.000Z'),
      });
      expect(fs.existsSync(path.join(manifest.snapshotDir, 'manifest.json'))).toBe(true);
      expect(fs.existsSync(manifest.databaseSnapshot.snapshotPath)).toBe(true);

      await fsp.rm(env[UPLOAD_DIR_ENV], {recursive: true, force: true});
      await fsp.rm(env[LOGS_DIR_ENV], {recursive: true, force: true});
      await fsp.rm(env[DATA_DIR_ENV], {recursive: true, force: true});
      await fsp.rm(env[PROVIDER_DATA_DIR_ENV], {recursive: true, force: true});
      await fsp.rm(env[ENTERPRISE_DB_PATH_ENV], {force: true});

      const restored = await restoreEnterpriseMigrationSnapshot(manifest.snapshotDir, {
        env: env as NodeJS.ProcessEnv,
        now: new Date('2026-05-08T00:01:00.000Z'),
      });
      expect(restored.restoredDatabase.restored).toBe(true);
      expect(fs.existsSync(path.join(env[UPLOAD_DIR_ENV], 'traces', 'trace-a.json'))).toBe(true);
      expect(fs.existsSync(path.join(env[LOGS_DIR_ENV], 'reports', 'report-a.html'))).toBe(true);
      expect(fs.existsSync(path.join(env[DATA_DIR_ENV], 'tenant-a', 'workspace-a', 'traces', 'trace-a.trace'))).toBe(true);
      expect(fs.existsSync(path.join(env[PROVIDER_DATA_DIR_ENV], 'providers.json'))).toBe(true);

      const restoredDb = openEnterpriseDb(env[ENTERPRISE_DB_PATH_ENV]);
      try {
        const row = restoredDb.prepare(`
          SELECT name
          FROM organizations
          WHERE id = 'tenant-a'
        `).get() as {name: string};
        expect(row.name).toBe('Tenant A');
      } finally {
        restoredDb.close();
      }
    } finally {
      await fsp.rm(tmpDir, {recursive: true, force: true});
    }
  });
});
