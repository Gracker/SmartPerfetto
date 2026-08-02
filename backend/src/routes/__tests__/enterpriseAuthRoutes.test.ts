// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { bindWorkspaceRouteContext, requireWorkspaceRouteContext } from '../../middleware/workspaceRouteContext';
import { createEnterpriseAuthRouter } from '../enterpriseAuthRoutes';
import enterpriseTenantRoutes from '../enterpriseTenantRoutes';
import exportRoutes from '../exportRoutes';
import { applyEnterpriseMinimalSchema } from '../../services/enterpriseSchema';
import { EnterpriseSsoService } from '../../services/enterpriseSsoService';
import {
  EnterpriseOidcClient,
  type EnterpriseOidcUserInfo,
} from '../../services/enterpriseOidcClient';

const originalEnterprise = process.env.SMARTPERFETTO_ENTERPRISE;
const originalCookieSecret = process.env.SMARTPERFETTO_SSO_COOKIE_SECRET;
const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const oidcEnvKeys = [
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'SMARTPERFETTO_OIDC_CLIENT_ID',
  'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  'SMARTPERFETTO_OIDC_REDIRECT_URI',
  'SMARTPERFETTO_OIDC_ALLOW_INSECURE_HTTP',
  'SMARTPERFETTO_SERVER_SECRET',
  'FRONTEND_URL',
] as const;
const originalOidcEnv = Object.fromEntries(
  oidcEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof oidcEnvKeys)[number], string | undefined>;

function sessionCookieFrom(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find(value => value.startsWith('sp_sso_session='));
  if (!cookie) throw new Error('session cookie missing');
  return cookie.split(';')[0];
}

function ssoUserId(issuer: string, subject: string): string {
  return `sso-${crypto.createHash('sha256').update(`${issuer}|${subject}`).digest('hex').slice(0, 20)}`;
}

function oidcTenantId(issuer: string): string {
  const normalized = issuer.replace(/\/+$/, '');
  return `oidc-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

function makeApp(service: EnterpriseSsoService, userInfo: EnterpriseOidcUserInfo): {
  app: express.Express;
  captured: { state?: string; nonce?: string };
} {
  const app = express();
  app.use(express.json());
  const captured: { state?: string; nonce?: string } = {};
  app.use('/api/auth', createEnterpriseAuthRouter({
    ssoService: service,
    oidcClient: {
      async buildAuthorizationUrl(params) {
        captured.state = params.state;
        captured.nonce = params.nonce;
        return `https://idp.example.test/auth?state=${params.state}&nonce=${params.nonce}`;
      },
      async exchangeCodeForUserInfo(code) {
        if (code !== 'code-123') throw new Error('unexpected code');
        return userInfo;
      },
    },
  }));
  app.use('/api/tenant', enterpriseTenantRoutes);
  app.use('/api/export', authenticate, exportRoutes);
  app.get(
    '/workspace/:workspaceId',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    (_req, res) => res.json({ success: true }),
  );
  app.get('/protected', authenticate, (req, res) => {
    res.json({ requestContext: (req as AuthenticatedRequest).requestContext });
  });
  return { app, captured };
}

function seedMemberships(db: Database.Database, userId: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES
      ('workspace-a', 'tenant-a', 'Workspace A', ?, ?),
      ('workspace-b', 'tenant-a', 'Workspace B', ?, ?)
  `).run(now, now, now, now);
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, 'tenant-a', 'alice@example.test', 'Alice', 'https://idp.example.test|alice-sub', ?, ?)
  `).run(userId, now, now);
  db.prepare(`
    INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
    VALUES
      ('tenant-a', 'workspace-a', ?, 'analyst', ?),
      ('tenant-a', 'workspace-b', ?, 'workspace_admin', ?)
  `).run(userId, now, userId, now);
}

describe('enterprise auth routes', () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    process.env.SMARTPERFETTO_SSO_COOKIE_SECRET = 'test-sso-cookie-secret-32-bytes';
    delete process.env.SMARTPERFETTO_API_KEY;
    for (const key of oidcEnvKeys) delete process.env[key];
    EnterpriseSsoService.resetForTests();
    db = new Database(':memory:');
    applyEnterpriseMinimalSchema(db);
  });

  afterEach(() => {
    db.close();
    EnterpriseSsoService.resetForTests();
    if (originalEnterprise === undefined) {
      delete process.env.SMARTPERFETTO_ENTERPRISE;
    } else {
      process.env.SMARTPERFETTO_ENTERPRISE = originalEnterprise;
    }
    if (originalCookieSecret === undefined) {
      delete process.env.SMARTPERFETTO_SSO_COOKIE_SECRET;
    } else {
      process.env.SMARTPERFETTO_SSO_COOKIE_SECRET = originalCookieSecret;
    }
    if (originalApiKey === undefined) {
      delete process.env.SMARTPERFETTO_API_KEY;
    } else {
      process.env.SMARTPERFETTO_API_KEY = originalApiKey;
    }
    for (const key of oidcEnvKeys) {
      const value = originalOidcEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('resolves the environment OIDC client lazily after startup env loading', async () => {
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test/';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
      'https://app.example.test/api/auth/oidc/callback';
    process.env.SMARTPERFETTO_SERVER_SECRET =
      'test-server-secret-at-least-32-bytes';
    process.env.FRONTEND_URL = 'https://app.example.test';
    const client = {
      async buildAuthorizationUrl() {
        return 'https://idp.example.test/authorize';
      },
      async exchangeCodeForUserInfo() {
        throw new Error('not used');
      },
    };
    const fromEnv = jest
      .spyOn(EnterpriseOidcClient, 'fromEnv')
      .mockReturnValue(client as never);
    try {
      const app = express();
      app.use('/api/auth', createEnterpriseAuthRouter({
        ssoService: new EnterpriseSsoService(db),
      }));

      expect(fromEnv).not.toHaveBeenCalled();
      await request(app).get('/api/auth/oidc/login').expect(302);
      expect(fromEnv).toHaveBeenCalledTimes(1);
    } finally {
      fromEnv.mockRestore();
    }
  });

  test('runs OIDC callback into workspace-selection onboarding and audit, then authenticates selected workspace', async () => {
    const issuer = 'https://idp.example.test';
    const subject = 'alice-sub';
    const userInfo: EnterpriseOidcUserInfo = {
      issuer,
      subject,
      email: 'alice@example.test',
      displayName: 'Alice',
      claims: {
        sub: subject,
        email: 'alice@example.test',
        name: 'Alice',
        tenant_id: 'tenant-a',
      },
    };
    const userId = ssoUserId(issuer, subject);
    seedMemberships(db, userId);
    const service = new EnterpriseSsoService(db);
    EnterpriseSsoService.setInstanceForTests(service);
    const { app, captured } = makeApp(service, userInfo);

    const login = await request(app)
      .get('/api/auth/oidc/login?returnTo=/assistant-shell')
      .expect(302);
    expect(login.headers.location).toContain('https://idp.example.test/auth');
    expect(captured.state).toBeDefined();
    const stateCookie = login.headers['set-cookie'][0].split(';')[0];

    const callback = await request(app)
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .set('Cookie', stateCookie)
      .expect(200);

    expect(callback.body).toMatchObject({
      success: true,
      status: 'needs_workspace_selection',
      tenantId: 'tenant-a',
      userId,
      returnTo: '/assistant-shell',
    });
    expect(callback.body.workspaces.map((workspace: any) => workspace.workspaceId)).toEqual([
      'workspace-a',
      'workspace-b',
    ]);
    expect(callback.body.accessToken).toBeUndefined();
    const sessionCookie = sessionCookieFrom(callback);
    const session = await request(app)
      .get('/api/auth/session')
      .set('Cookie', sessionCookie)
      .expect(200);

    const selected = await request(app)
      .post('/api/auth/onboarding/workspace')
      .set('Cookie', sessionCookie)
      .set('X-CSRF-Token', session.body.csrfToken)
      .send({ workspaceId: 'workspace-b' })
      .expect(200);
    expect(selected.body).toMatchObject({
      success: true,
      status: 'ready',
      workspaceId: 'workspace-b',
    });

    const protectedRes = await request(app)
      .get('/protected')
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(protectedRes.body.requestContext).toMatchObject({
      authType: 'sso',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-b',
      userId,
      roles: ['workspace_admin'],
      scopes: expect.arrayContaining(['trace:read', 'agent:run', 'provider:manage_workspace']),
    });
    expect(protectedRes.body.requestContext.scopes).not.toContain('*');

    db.prepare(`
      UPDATE memberships SET role = 'analyst'
      WHERE tenant_id = 'tenant-a' AND workspace_id = 'workspace-b' AND user_id = ?
    `).run(userId);
    const downgraded = await request(app)
      .get('/protected')
      .set('Cookie', sessionCookie)
      .expect(200);
    expect(downgraded.body.requestContext.roles).toEqual(['analyst']);
    db.prepare(`
      DELETE FROM memberships
      WHERE tenant_id = 'tenant-a' AND workspace_id = 'workspace-b' AND user_id = ?
    `).run(userId);
    await request(app)
      .get('/protected')
      .set('Cookie', sessionCookie)
      .expect(401);

    expect(service.listAuditEvents().map(event => event.action)).toEqual([
      'sso_login',
      'workspace_selected',
      'provider_default_resolved',
    ]);
  });

  test('returns needs_tenant_join when the OIDC identity has no issuer', async () => {
    const service = new EnterpriseSsoService(db);
    const { app, captured } = makeApp(service, {
      issuer: '',
      subject: 'bob-sub',
      email: 'bob@unknown.test',
      claims: { sub: 'bob-sub', email: 'bob@unknown.test' },
    });

    const login = await request(app).get('/api/auth/oidc/login').expect(302);
    const stateCookie = login.headers['set-cookie'][0].split(';')[0];
    const callback = await request(app)
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .set('Cookie', stateCookie)
      .expect(200);

    expect(callback.body).toMatchObject({
      success: true,
      status: 'needs_tenant_join',
    });
    expect(callback.body.accessToken).toBeUndefined();
    expect(service.listAuditEvents()).toEqual([]);
  });

  test('creates one isolated personal workspace per OIDC user and redirects to the frontend', async () => {
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI = 'https://app.example.test:3000/api/auth/oidc/callback';
    process.env.SMARTPERFETTO_SERVER_SECRET = 'test-server-secret-at-least-32-bytes';
    process.env.FRONTEND_URL = 'https://app.example.test:10000';
    delete process.env.SMARTPERFETTO_SSO_COOKIE_SECRET;
    const tenantId = oidcTenantId('https://idp.example.test');

    const alice: EnterpriseOidcUserInfo = {
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      email: 'alice@example.test',
      displayName: 'Alice',
      claims: { sub: 'alice-sub', groups: ['other-group'] },
    };
    const service = new EnterpriseSsoService(db);
    EnterpriseSsoService.setInstanceForTests(service);
    const { app, captured } = makeApp(service, alice);
    const login = await request(app)
      .get('/api/auth/oidc/login?returnTo=/assistant-shell')
      .expect(302);
    const stateCookie = login.headers['set-cookie'][0].split(';')[0];
    const callback = await request(app)
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .set('Cookie', stateCookie)
      .expect(302);
    expect(callback.headers.location).toBe('https://app.example.test:10000/assistant-shell');
    expect(callback.body.accessToken).toBeUndefined();
    expect((callback.headers['set-cookie'] as unknown as string[])
      .find(value => value.startsWith('sp_sso_session='))).toContain('Max-Age=28800');

    const aliceCookie = sessionCookieFrom(callback);
    const aliceSession = await request(app)
      .get('/api/auth/session')
      .set('Cookie', aliceCookie)
      .expect(200);
    expect(aliceSession.body).toMatchObject({
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: { email: 'alice@example.test' },
      workspace: { name: 'Personal Workspace', kind: 'personal' },
      roles: ['personal_workspace_owner'],
      scopes: expect.arrayContaining(['trace:read', 'agent:run']),
    });
    expect(aliceSession.body.scopes).not.toContain('*');

    const repeatedAlice = service.completeOidcLogin(alice);
    expect(repeatedAlice.workspaceId).toBe(aliceSession.body.workspace.id);

    const bobResult = service.completeOidcLogin({
      issuer: 'https://idp.example.test',
      subject: 'bob-sub',
      email: 'bob@example.test',
      displayName: 'Bob',
      claims: { sub: 'bob-sub' },
    });
    expect(bobResult).toMatchObject({ status: 'ready' });
    expect(bobResult.workspaceId).not.toBe(aliceSession.body.workspace.id);
    const workspaceRows = db.prepare(`
      SELECT id, name FROM workspaces WHERE tenant_id = ? ORDER BY id
    `).all(tenantId) as Array<{ id: string; name: string }>;
    expect(workspaceRows).toHaveLength(2);
    expect(workspaceRows.map(row => row.name)).toEqual([
      'Personal Workspace',
      'Personal Workspace',
    ]);
    const now = Date.now();
    db.prepare(`
      INSERT INTO users(id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('intruder', ?, 'intruder@example.test', 'Intruder', 'test|intruder', ?, ?)
    `).run(tenantId, now, now);
    expect(() => db.prepare(`
      INSERT INTO memberships(tenant_id, workspace_id, user_id, role, created_at)
      VALUES (?, ?, 'intruder', 'analyst', ?)
    `).run(tenantId, aliceSession.body.workspace.id, now)).toThrow(/personal workspace cannot accept additional members/);

    await request(app)
      .get('/api/tenant/workspaces')
      .set('Cookie', aliceCookie)
      .expect(403);
    await request(app)
      .get('/api/export/tenant')
      .set('Cookie', aliceCookie)
      .expect(403);
    await request(app)
      .get(`/workspace/${bobResult.workspaceId}`)
      .set('Cookie', aliceCookie)
      .expect(404);

    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', aliceCookie)
      .expect(403);
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', aliceCookie)
      .set('X-CSRF-Token', aliceSession.body.csrfToken)
      .expect(200);
    const afterLogout = await request(app)
      .get('/api/auth/session')
      .set('Cookie', aliceCookie)
      .expect(200);
    expect(afterLogout.body).toMatchObject({ authenticated: false, status: 'unauthenticated' });
  });

  test('does not claim a pre-existing workspace whose deterministic personal id collides', () => {
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
      'https://app.example.test/api/auth/oidc/callback';
    process.env.SMARTPERFETTO_SERVER_SECRET =
      'test-server-secret-at-least-32-bytes';
    process.env.FRONTEND_URL = 'https://app.example.test';
    delete process.env.SMARTPERFETTO_SSO_COOKIE_SECRET;

    const issuer = 'https://idp.example.test';
    const tenantId = oidcTenantId(issuer);
    const userId = ssoUserId(issuer, 'alice-sub');
    const conflictingWorkspaceId = `sso-personal-${userId}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO organizations(id, name, status, plan, created_at, updated_at)
      VALUES (?, ?, 'active', 'enterprise', ?, ?)
    `).run(tenantId, tenantId, now, now);
    db.prepare(`
      INSERT INTO workspaces(id, tenant_id, name, created_at, updated_at)
      VALUES (?, ?, 'Existing Workspace', ?, ?)
    `).run(conflictingWorkspaceId, tenantId, now, now);
    db.prepare(`
      INSERT INTO users(id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('existing-user', ?, 'existing@example.test', 'Existing User', 'existing-subject', ?, ?)
    `).run(tenantId, now, now);
    db.prepare(`
      INSERT INTO memberships(tenant_id, workspace_id, user_id, role, created_at)
      VALUES (?, ?, 'existing-user', 'workspace_admin', ?)
    `).run(tenantId, conflictingWorkspaceId, now);

    const result = new EnterpriseSsoService(db).completeOidcLogin({
      issuer,
      subject: 'alice-sub',
      email: 'alice@example.test',
      displayName: 'Alice',
      claims: {sub: 'alice-sub'},
    });

    expect(result).toMatchObject({status: 'ready'});
    expect(result.workspaceId).not.toBe(conflictingWorkspaceId);
    expect(db.prepare(`
      SELECT user_id FROM memberships
      WHERE tenant_id = ? AND workspace_id = ?
    `).all(tenantId, conflictingWorkspaceId)).toEqual([
      {user_id: 'existing-user'},
    ]);
  });

  test('keeps OIDC return targets on the configured frontend origin', async () => {
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
      'https://app.example.test:3000/api/auth/oidc/callback';
    process.env.SMARTPERFETTO_SERVER_SECRET =
      'test-server-secret-at-least-32-bytes';
    process.env.FRONTEND_URL = 'https://app.example.test:10000';
    delete process.env.SMARTPERFETTO_SSO_COOKIE_SECRET;
    const service = new EnterpriseSsoService(db);
    EnterpriseSsoService.setInstanceForTests(service);
    const {app, captured} = makeApp(service, {
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      claims: {sub: 'alice-sub'},
    });

    const login = await request(app)
      .get('/api/auth/oidc/login')
      .query({returnTo: '/\\attacker.example'})
      .expect(302);
    const callback = await request(app)
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .set('Cookie', login.headers['set-cookie'][0].split(';')[0])
      .expect(302);

    expect(callback.headers.location).toBe('https://app.example.test:10000/');
  });

  test('treats malformed session cookies as unauthenticated', async () => {
    const service = new EnterpriseSsoService(db);
    const {app} = makeApp(service, {
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      claims: {sub: 'alice-sub'},
    });

    const response = await request(app)
      .get('/api/auth/session')
      .set('Cookie', 'sp_sso_session=%')
      .expect(200);
    expect(response.body).toMatchObject({authenticated: false});
  });
});
