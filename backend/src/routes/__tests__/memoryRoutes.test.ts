// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {jest, describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import {createMemoryRoutes} from '../memoryRoutes';
import {ProjectMemory} from '../../agentv3/projectMemory';
import * as patternMemory from '../../agentv3/analysisPatternMemory';
import {listEnterpriseAuditEvents} from '../../services/enterpriseAuditService';
import {
  ENTERPRISE_DB_PATH_ENV,
  openEnterpriseDb,
} from '../../services/enterpriseDb';
import {
  type MemoryPromotionPolicy,
  type ProjectMemoryEntry,
} from '../../types/sparkContracts';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

let tmpDir: string;
let memory: ProjectMemory;
let app: express.Express;
let server: Awaited<ReturnType<typeof loopbackServers.listen>>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-routes-test-'));
  memory = new ProjectMemory(path.join(tmpDir, 'memory.json'));
  app = express();
  app.use(express.json({limit: '5mb'}));
  app.use('/api/memory', createMemoryRoutes(memory));
  server = await loopbackServers.listen(app);
});

afterEach(async () => {
  await loopbackServers.close();
  jest.restoreAllMocks();
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

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
  } = {},
): request.Test {
  const userId = input.userId ?? 'memory-admin';
  return req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', input.role ?? 'workspace_admin')
    .set('X-SmartPerfetto-SSO-Scopes', input.scopes ?? 'audit:read');
}

function readEnterpriseAuditActions(dbPath: string): string[] {
  const db = openEnterpriseDb(dbPath);
  try {
    return listEnterpriseAuditEvents(db).map(event => event.action);
  } finally {
    db.close();
  }
}

function makeEntry(
  overrides: Partial<ProjectMemoryEntry> = {},
): ProjectMemoryEntry {
  return {
    entryId: 'sha256:test001',
    scope: 'project',
    projectKey: 'com.example/pixel',
    tags: ['scrolling'],
    insight: 'Binder S>5ms before doFrame',
    confidence: 0.78,
    status: 'provisional',
    createdAt: 1714600000000,
    ...overrides,
  };
}

describe('POST /api/memory/sweep-confirm', () => {
  it('runs the auto-confirm sweep and returns the promoted count', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
    delete process.env.SMARTPERFETTO_API_KEY;
    const sweepSpy = jest.spyOn(patternMemory, 'sweepAutoConfirm') as any;
    sweepSpy.mockResolvedValue({
      positivePromoted: 2,
      negativePromoted: 1,
      totalPromoted: 3,
    });

    const res = await ssoHeaders(request(server).post('/api/memory/sweep-confirm')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      promoted: 3,
      result: {
        positivePromoted: 2,
        negativePromoted: 1,
        totalPromoted: 3,
      },
    });
    expect(patternMemory.sweepAutoConfirm).toHaveBeenCalledWith(
      expect.any(Number),
      {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'memory-admin',
      },
    );
  });
});

describe('GET /api/memory', () => {
  it('requires audit read permission for memory admin access in enterprise SSO', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
    delete process.env.SMARTPERFETTO_API_KEY;
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a'}));

    const analystHeaders = {
      userId: 'memory-analyst',
      role: 'analyst',
      scopes: 'trace:read,report:read',
    };
    const listRes = await ssoHeaders(request(server).get('/api/memory'), analystHeaders);
    expect(listRes.status).toBe(403);
    expect(listRes.body.details).toContain('Memory administration requires audit:read permission');

    const auditRes = await ssoHeaders(request(server).get('/api/memory/audit'), analystHeaders);
    expect(auditRes.status).toBe(403);

    const deleteRes = await ssoHeaders(request(server).delete('/api/memory/a'), analystHeaders);
    expect(deleteRes.status).toBe(403);

    const adminRes = await ssoHeaders(request(server).get('/api/memory'));
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
  });

  it('lists entries with count', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a'}));
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'b'}));
    const res = await request(server).get('/api/memory');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.entries.map((e: ProjectMemoryEntry) => e.entryId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('respects scope filter', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a', scope: 'project'}));
    memory.saveProjectMemoryEntry(
      makeEntry({
        entryId: 'b',
        scope: 'world',
        promotionPolicy: {
          fromScope: 'project',
          toScope: 'world',
          trigger: 'reviewer_approval',
          reviewer: 'chris',
          promotedAt: 1714600000000,
        },
      }),
    );
    const res = await request(server).get('/api/memory?scope=world');
    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].entryId).toBe('b');
  });

  it('respects projectKey filter', async () => {
    memory.saveProjectMemoryEntry(
      makeEntry({entryId: 'a', projectKey: 'com.example/pixel'}),
    );
    memory.saveProjectMemoryEntry(
      makeEntry({entryId: 'b', projectKey: 'com.other/pixel'}),
    );
    const res = await request(server).get(
      '/api/memory?projectKey=com.example/pixel',
    );
    expect(res.body.count).toBe(1);
    expect(res.body.entries[0].entryId).toBe('a');
  });

  it('ignores invalid scope values silently', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a'}));
    const res = await request(server).get('/api/memory?scope=invalid');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe('GET /api/memory/audit', () => {
  it('returns the audit log including post-promotion entries', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a', scope: 'project'}));
    memory.promoteEntry('a', {
      fromScope: 'project',
      toScope: 'world',
      trigger: 'reviewer_approval',
      reviewer: 'chris',
      promotedAt: 1714600000000,
    });
    const res = await request(server).get('/api/memory/audit');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.audit[0].entryId).toBe('a');
    expect(res.body.audit[0].policy.toScope).toBe('world');
  });

  it('returns empty audit when nothing promoted', async () => {
    const res = await request(server).get('/api/memory/audit');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});

describe('POST /api/memory/promote', () => {
  const REVIEWER_POLICY: MemoryPromotionPolicy = {
    fromScope: 'project',
    toScope: 'world',
    trigger: 'reviewer_approval',
    reviewer: 'chris',
    promotedAt: 1714600000000,
  };

  it('promotes a project entry to world', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a', scope: 'project'}));
    const res = await request(server)
      .post('/api/memory/promote')
      .send({entryId: 'a', policy: REVIEWER_POLICY});
    expect(res.status).toBe(200);
    expect(res.body.entry.scope).toBe('world');
    expect(res.body.entry.promotionPolicy.trigger).toBe('reviewer_approval');
  });

  it('records enterprise audit events for promotion and deletion', async () => {
    const dbPath = path.join(tmpDir, 'enterprise.sqlite');
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
    delete process.env.SMARTPERFETTO_API_KEY;

    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a', scope: 'project'}), {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'memory-admin',
    });
    const promoteRes = await ssoHeaders(
      request(server)
        .post('/api/memory/promote')
        .send({entryId: 'a', policy: REVIEWER_POLICY}),
    );
    expect(promoteRes.status).toBe(200);

    const deleteRes = await ssoHeaders(request(server).delete('/api/memory/a'));
    expect(deleteRes.status).toBe(200);

    expect(readEnterpriseAuditActions(dbPath)).toEqual(expect.arrayContaining([
      'memory.promoted',
      'memory.deleted',
    ]));
  });

  it('400 on missing body fields', async () => {
    const res = await request(server).post('/api/memory/promote').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('surfaces auto_inferred trigger rejection as 400', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a', scope: 'project'}));
    const res = await request(server)
      .post('/api/memory/promote')
      .send({
        entryId: 'a',
        policy: {...REVIEWER_POLICY, trigger: 'auto_inferred'},
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/auto-promotion/i);
  });

  it("surfaces 'world without reviewer_approval' rejection as 400", async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a', scope: 'project'}));
    const res = await request(server)
      .post('/api/memory/promote')
      .send({
        entryId: 'a',
        policy: {...REVIEWER_POLICY, trigger: 'user_feedback'},
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope='world'/);
  });

  it('surfaces missing entry as 404', async () => {
    const res = await request(server)
      .post('/api/memory/promote')
      .send({entryId: 'missing', policy: REVIEWER_POLICY});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('memory_entry_not_found');
    expect(res.body.error).toMatch(/not found/);
  });
});

describe('DELETE /api/memory/:entryId', () => {
  it('removes an entry and returns 200', async () => {
    memory.saveProjectMemoryEntry(makeEntry({entryId: 'a'}));
    const res = await request(server).delete('/api/memory/a');
    expect(res.status).toBe(200);
    expect(memory.getProjectMemoryEntry('a')).toBeUndefined();
  });

  it('returns 404 for unknown entryId', async () => {
    const res = await request(server).delete('/api/memory/missing');
    expect(res.status).toBe(404);
  });
});
