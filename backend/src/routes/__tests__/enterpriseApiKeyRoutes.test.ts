// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import {
  authenticate,
  type AuthenticatedRequest,
} from '../../middleware/auth';
import { createEnterpriseApiKeyRouter } from '../enterpriseApiKeyRoutes';
import { applyEnterpriseMinimalSchema } from '../../services/enterpriseSchema';
import { EnterpriseApiKeyService } from '../../services/enterpriseApiKeyService';
import { listEnterpriseAuditEvents } from '../../services/enterpriseAuditService';

import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalEnterprise = process.env.SMARTPERFETTO_ENTERPRISE;
const originalSsoTrustedHeaders = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;

function adminHeaders(): Record<string, string> {
  return {
    'X-SmartPerfetto-SSO-User-Id': 'admin-user',
    'X-SmartPerfetto-SSO-Email': 'admin@example.test',
    'X-SmartPerfetto-SSO-Tenant-Id': 'tenant-a',
    'X-SmartPerfetto-SSO-Workspace-Id': 'workspace-a',
    'X-SmartPerfetto-SSO-Roles': 'workspace_admin',
  };
}

function viewerHeaders(): Record<string, string> {
  return {
    ...adminHeaders(),
    'X-SmartPerfetto-SSO-User-Id': 'viewer-user',
    'X-SmartPerfetto-SSO-Roles': 'viewer',
    'X-SmartPerfetto-SSO-Scopes': 'trace:read',
  };
}

function orgAdminHeaders(): Record<string, string> {
  return {
    ...adminHeaders(),
    'X-SmartPerfetto-SSO-Roles': 'org_admin',
    'X-SmartPerfetto-SSO-Scopes': '*',
  };
}

async function makeApp(service: EnterpriseApiKeyService) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createEnterpriseApiKeyRouter({ apiKeyService: service }));
  app.get('/protected', authenticate, (req, res) => {
    res.json({ requestContext: (req as AuthenticatedRequest).requestContext });
  });
  return loopbackServers.listen(app);
}

function seedIdentity(db: Database.Database): void {
  const now = Date.now();
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
    VALUES
      ('admin-user', 'tenant-a', 'admin@example.test', 'Admin', 'oidc|admin', ?, ?),
      ('viewer-user', 'tenant-a', 'viewer@example.test', 'Viewer', 'oidc|viewer', ?, ?)
  `).run(now, now, now, now);
  db.prepare(`
    INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
    VALUES
      ('tenant-a', 'workspace-a', 'admin-user', 'workspace_admin', ?),
      ('tenant-a', 'workspace-a', 'viewer-user', 'viewer', ?)
  `).run(now, now);
}

describe('enterprise API key routes', () => {
  let db: Database.Database;
  let service: EnterpriseApiKeyService;
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    EnterpriseApiKeyService.resetForTests();
    db = new Database(':memory:');
    applyEnterpriseMinimalSchema(db);
    seedIdentity(db);
    service = new EnterpriseApiKeyService(db);
    EnterpriseApiKeyService.setInstanceForTests(service);
    app = await makeApp(service);
  });

  afterEach(async () => {
    await loopbackServers.close();
    db.close();
    EnterpriseApiKeyService.resetForTests();
    if (originalApiKey === undefined) {
      delete process.env.SMARTPERFETTO_API_KEY;
    } else {
      process.env.SMARTPERFETTO_API_KEY = originalApiKey;
    }
    if (originalEnterprise === undefined) {
      delete process.env.SMARTPERFETTO_ENTERPRISE;
    } else {
      process.env.SMARTPERFETTO_ENTERPRISE = originalEnterprise;
    }
    if (originalSsoTrustedHeaders === undefined) {
      delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
    } else {
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = originalSsoTrustedHeaders;
    }
  });

  test('creates, lists, authenticates with, and revokes a scoped API key with audit events', async () => {
    const created = await request(app)
      .post('/api/auth/api-keys')
      .set(adminHeaders())
      .send({
        name: 'CI runner',
        scopes: ['trace:read', 'agent:run'],
        expiresAt: Date.now() + 60_000,
      })
      .expect(201);

    expect(created.body.token).toMatch(/^spak_/);
    expect(created.body.apiKey).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      ownerUserId: 'admin-user',
      name: 'CI runner',
      scopes: ['trace:read', 'agent:run'],
    });
    expect(JSON.stringify(created.body)).not.toContain('key_hash');

    const listed = await request(app)
      .get('/api/auth/api-keys')
      .set(adminHeaders())
      .expect(200);
    expect(listed.body.apiKeys).toHaveLength(1);
    expect(listed.body.apiKeys[0].id).toBe(created.body.apiKey.id);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    const protectedRes = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${created.body.token}`)
      .expect(200);
    expect(protectedRes.body.requestContext).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'admin-user',
      authType: 'api_key',
      roles: ['api_key'],
      scopes: ['trace:read', 'agent:run'],
    });

    const revoked = await request(app)
      .post(`/api/auth/api-keys/${created.body.apiKey.id}/revoke`)
      .set(adminHeaders())
      .expect(200);
    expect(revoked.body.apiKey.revokedAt).toBeGreaterThan(0);

    await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${created.body.token}`)
      .expect(401);

    expect(listEnterpriseAuditEvents(db).map(event => event.action)).toEqual([
      'api_key_created',
      'api_key_revoked',
    ]);
  });

  test('rejects API key management without admin role or api_key scope', async () => {
    await request(app)
      .post('/api/auth/api-keys')
      .set(viewerHeaders())
      .send({ name: 'Denied key' })
      .expect(403);
  });

  test('rejects creating a key for a different workspace in this minimal slice', async () => {
    const res = await request(app)
      .post('/api/auth/api-keys')
      .set(adminHeaders())
      .send({ name: 'Wrong workspace', workspaceId: 'workspace-b' })
      .expect(400);

    expect(res.body.error).toContain('workspaceId must match');
  });

  test('prevents a workspace admin from minting a tenant-wide wildcard key', async () => {
    const response = await request(app)
      .post('/api/auth/api-keys')
      .set(adminHeaders())
      .send({workspaceId: null, ownerUserId: null, scopes: ['*']})
      .expect(400);

    expect(response.body.error).toContain('org admin');
  });

  test('prevents a workspace admin from delegating scopes they do not hold', async () => {
    const response = await request(app)
      .post('/api/auth/api-keys')
      .set(adminHeaders())
      .send({scopes: ['provider:manage_org']})
      .expect(400);

    expect(response.body.error).toContain('Cannot delegate scope');
  });

  test('keeps tenant-wide keys invisible and irrevocable to workspace admins', async () => {
    const created = await request(app)
      .post('/api/auth/api-keys')
      .set(orgAdminHeaders())
      .send({workspaceId: null, scopes: ['*']})
      .expect(201);

    const listed = await request(app)
      .get('/api/auth/api-keys')
      .set(adminHeaders())
      .expect(200);
    expect(listed.body.apiKeys).toEqual([]);

    await request(app)
      .post(`/api/auth/api-keys/${created.body.apiKey.id}/revoke`)
      .set(adminHeaders())
      .expect(404);

    const protectedResponse = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${created.body.token}`)
      .set('X-Workspace-Id', 'workspace-b')
      .expect(200);
    expect(protectedResponse.body.requestContext.workspaceId).toBe('default-workspace');
  });

  test('rejects expired managed API keys during authenticate', async () => {
    const created = await request(app)
      .post('/api/auth/api-keys')
      .set(adminHeaders())
      .send({ name: 'Short key' })
      .expect(201);
    db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1_000, created.body.apiKey.id);

    await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${created.body.token}`)
      .expect(401);
  });
});
