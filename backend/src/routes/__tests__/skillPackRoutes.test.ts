// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { authenticate } from '../../middleware/auth';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import type { SkillPackAssetKind, SkillPackManifestV1 } from '../../services/skillPacks/skillPackTypes';
import { SKILL_PACK_MANIFEST_FILE } from '../../services/skillPacks/skillPackManifest';
import skillPackRoutes from '../skillPackRoutes';
import { SkillPackInstallService } from '../../services/skillPacks/skillPackInstallService';
import { SkillPackRequestError } from '../../services/skillPacks/skillPackRequestError';

interface AssetInput {
  kind: SkillPackAssetKind;
  path: string;
  content: string;
}

const originalEnv = {
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  backendDataDir: process.env.SMARTPERFETTO_BACKEND_DATA_DIR,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};
const routeSkillYaml = [
  'name: route_pack_local_jank',
  'version: "1"',
  'type: atomic',
  'meta:',
  '  display_name: Route Pack Local Jank',
  '  description: Route pack reviewed skill',
  'sql: SELECT 1 AS value',
  '',
].join('\n');

let tmpDir: string;
let dbPath: string;
let packDir: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workspaces/:workspaceId/skill-packs',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    skillPackRoutes,
  );
  return app;
}

function ssoHeaders(
  req: request.Test,
  input: { workspaceId?: string; role?: string; scopes?: string } = {},
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'skill-pack-admin')
    .set('X-SmartPerfetto-SSO-Email', 'skill-pack-admin@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', input.workspaceId ?? 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', input.role ?? 'workspace_admin')
    .set('X-SmartPerfetto-SSO-Scopes', input.scopes ?? 'runtime:manage');
}

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function writeAsset(root: string, asset: AssetInput): Promise<void> {
  const absolutePath = path.join(root, asset.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, asset.content, 'utf8');
}

async function writePack(root: string, assets: AssetInput[]): Promise<SkillPackManifestV1> {
  for (const asset of assets) {
    await writeAsset(root, asset);
  }
  const manifest: SkillPackManifestV1 = {
    schemaVersion: 1,
    packId: 'route-pack',
    name: 'Route Pack',
    version: '1.0.0',
    publisher: 'local',
    description: 'Route pack',
    license: 'AGPL-3.0-or-later',
    assets: assets.map(asset => ({
      kind: asset.kind,
      path: asset.path,
      sha256: sha(asset.content),
      sizeBytes: Buffer.byteLength(asset.content, 'utf8'),
    })),
    compatibility: {
      smartPerfettoMinVersion: '0.1.0',
    },
  };
  await fs.writeFile(path.join(root, SKILL_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function seedWorkspaceGraph(): void {
  const db = openEnterpriseDb(dbPath);
  const now = 1_777_000_000_000;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    for (const workspaceId of ['workspace-a', 'workspace-b']) {
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
        VALUES (?, 'tenant-a', ?, ?, ?)
      `).run(workspaceId, workspaceId, now, now);
    }
  } finally {
    db.close();
  }
}

describe('skill pack workspace routes', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-skill-pack-routes-'));
    dbPath = path.join(tmpDir, 'enterprise.db');
    packDir = path.join(tmpDir, 'pack');
    await fs.mkdir(packDir, { recursive: true });
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tmpDir, 'data');
    seedWorkspaceGraph();
    await writePack(packDir, [
      { kind: 'skill', path: 'atomic/route_pack_local_jank.skill.yaml', content: routeSkillYaml },
      { kind: 'doc', path: 'docs/readme.md', content: '# Route Pack\n' },
    ]);
  });

  afterEach(async () => {
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
    restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
    restoreEnvValue('SMARTPERFETTO_BACKEND_DATA_DIR', originalEnv.backendDataDir);
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('previews, installs, lists, disables, and removes a workspace pack', async () => {
    const app = makeApp();
    const preview = await ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/skill-packs/preview').send({ sourcePath: packDir }),
    );

    expect(preview.status).toBe(200);
    expect(preview.body.success).toBe(true);
    expect(preview.body.preview.skillIds).toEqual(['route_pack_local_jank']);

    const install = await ssoHeaders(
      request(app).post('/api/workspaces/workspace-a/skill-packs/install').send({ sourcePath: packDir }),
    );

    expect(install.status).toBe(200);
    expect(install.body.skillPack).toMatchObject({
      id: 'route-pack',
      enabled: true,
      metadata: {
        trustState: 'approved',
        approvedBy: 'skill-pack-admin',
      },
    });
    const sourcePath = install.body.skillPack.sourcePath as string;
    await expect(fs.stat(path.join(sourcePath, 'atomic/route_pack_local_jank.skill.yaml'))).resolves.toBeTruthy();

    const listA = await ssoHeaders(request(app).get('/api/workspaces/workspace-a/skill-packs'));
    expect(listA.status).toBe(200);
    expect(listA.body.skillPacks.map((record: { id: string }) => record.id)).toEqual(['route-pack']);

    const listB = await ssoHeaders(
      request(app).get('/api/workspaces/workspace-b/skill-packs'),
      { workspaceId: 'workspace-b' },
    );
    expect(listB.status).toBe(200);
    expect(listB.body.skillPacks).toEqual([]);

    const disabled = await ssoHeaders(
      request(app).patch('/api/workspaces/workspace-a/skill-packs/route-pack').send({ enabled: false }),
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.skillPack.enabled).toBe(false);
    await expect(fs.stat(sourcePath)).resolves.toBeTruthy();

    const removed = await ssoHeaders(
      request(app).delete('/api/workspaces/workspace-a/skill-packs/route-pack'),
    );
    expect(removed.status).toBe(200);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('answers an unknown pack with its reason and a storage failure with fixed text', async () => {
    const missing = await ssoHeaders(
      request(makeApp()).patch('/api/workspaces/workspace-a/skill-packs/no-such-pack').send({ enabled: false }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      success: false,
      code: 'skill_pack_not_found',
      error: 'skill_pack_not_found',
      requestId: expect.any(String),
    });

    const conflict = jest.spyOn(SkillPackInstallService.prototype, 'installSkillPack')
      .mockRejectedValue(new SkillPackRequestError('installed_pack_content_hash_mismatch', 409));
    try {
      const reinstall = await ssoHeaders(
        request(makeApp()).post('/api/workspaces/workspace-a/skill-packs/install').send({ sourcePath: packDir }),
      );
      expect(reinstall.status).toBe(409);
      expect(reinstall.body.code).toBe('installed_pack_content_hash_mismatch');
    } finally {
      conflict.mockRestore();
    }

    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const install = jest.spyOn(SkillPackInstallService.prototype, 'installSkillPack')
      .mockRejectedValue(new Error('skill_pack_persist_failed'));
    try {
      const failed = await ssoHeaders(
        request(makeApp()).post('/api/workspaces/workspace-a/skill-packs/install').send({ sourcePath: packDir }),
      );
      expect(failed.status).toBe(500);
      expect(failed.body).toMatchObject({ success: false, code: 'skill_pack_operation_failed' });
      expect(failed.text).not.toContain('skill_pack_persist_failed');
      expect(errorLog.mock.calls.flat()).toContainEqual(new Error('skill_pack_persist_failed'));
    } finally {
      install.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('requires runtime manage permission', async () => {
    const res = await ssoHeaders(
      request(makeApp()).post('/api/workspaces/workspace-a/skill-packs/install').send({ sourcePath: packDir }),
      { role: 'analyst', scopes: 'trace:read' },
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toContain('runtime:manage');
  });

  it('rejects malformed route bodies', async () => {
    const res = await ssoHeaders(
      request(makeApp()).post('/api/workspaces/workspace-a/skill-packs/install').send({}),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sourcePath is required');
  });
});
