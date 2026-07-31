// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import {
  createEnterpriseAuthRouter,
  resolveEnterpriseSsoCookiePolicy,
} from '../enterpriseAuthRoutes';
import { applyEnterpriseMinimalSchema } from '../../services/enterpriseSchema';
import { EnterpriseSsoService } from '../../services/enterpriseSsoService';
import type { EnterpriseOidcUserInfo } from '../../services/enterpriseOidcClient';

const originalEnterprise = process.env.SMARTPERFETTO_ENTERPRISE;
const originalCookieSecret = process.env.SMARTPERFETTO_SSO_COOKIE_SECRET;
const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalDomainMap = process.env.SMARTPERFETTO_OIDC_EMAIL_DOMAIN_MAP;
const originalDefaultTenant =
  process.env.SMARTPERFETTO_OIDC_DEFAULT_TENANT_ID;
const FRONTEND_ORIGIN = 'http://frontend.example.test';

function ssoUserId(issuer: string, subject: string): string {
  return `sso-${crypto.createHash('sha256').update(`${issuer}|${subject}`).digest('hex').slice(0, 20)}`;
}

function makeApp(service: EnterpriseSsoService, userInfo: EnterpriseOidcUserInfo): {
  app: express.Express;
  captured: {
    state?: string;
    nonce?: string;
    transaction?: { state: string; nonce: string; codeVerifier: string };
  };
} {
  const app = express();
  app.use(express.json());
  const captured: {
    state?: string;
    nonce?: string;
    transaction?: { state: string; nonce: string; codeVerifier: string };
  } = {};
  app.use('/api/auth', createEnterpriseAuthRouter({
    ssoService: service,
    allowedOrigins: [FRONTEND_ORIGIN],
    cookiePolicy: {
      secure: false,
      sameSite: 'Lax',
      sessionMaxAgeSeconds: 8 * 60 * 60,
    },
    oidcClient: {
      publicConfig: {
        issuerUrl: 'https://idp.example.test',
        clientId: 'client-a',
        scopes: ['openid', 'email', 'profile'],
      },
      async buildAuthorizationRequest(params) {
        captured.state = params.state;
        captured.nonce = params.nonce;
        return {
          authorizationUrl:
            `https://idp.example.test/auth?state=${params.state}&nonce=${params.nonce}`,
          codeVerifier: 'pkce-verifier-123',
        };
      },
      async exchangeCodeForUserInfo(callbackUrl, transaction) {
        expect(callbackUrl.searchParams.get('code')).toBe('code-123');
        captured.transaction = transaction;
        return userInfo;
      },
    },
  }));
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
    process.env.SMARTPERFETTO_SSO_COOKIE_SECRET =
      'test-sso-cookie-secret-32-bytes';
    delete process.env.SMARTPERFETTO_API_KEY;
    delete process.env.SMARTPERFETTO_OIDC_EMAIL_DOMAIN_MAP;
    delete process.env.SMARTPERFETTO_OIDC_DEFAULT_TENANT_ID;
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
    if (originalDomainMap === undefined) {
      delete process.env.SMARTPERFETTO_OIDC_EMAIL_DOMAIN_MAP;
    } else {
      process.env.SMARTPERFETTO_OIDC_EMAIL_DOMAIN_MAP = originalDomainMap;
    }
    if (originalDefaultTenant === undefined) {
      delete process.env.SMARTPERFETTO_OIDC_DEFAULT_TENANT_ID;
    } else {
      process.env.SMARTPERFETTO_OIDC_DEFAULT_TENANT_ID =
        originalDefaultTenant;
    }
  });

  test('completes PKCE onboarding through an HttpOnly session without exposing its token', async () => {
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
        groups: ['org_admin'],
      },
    };
    const userId = ssoUserId(issuer, subject);
    seedMemberships(db, userId);
    const service = new EnterpriseSsoService(db);
    EnterpriseSsoService.setInstanceForTests(service);
    const { app, captured } = makeApp(service, userInfo);
    const agent = request.agent(app);

    const config = await agent.get('/api/auth/config').expect(200);
    expect(config.body).toMatchObject({
      enterprise: true,
      oidc: {
        enabled: true,
        issuerUrl: issuer,
        localLogoutOnly: true,
      },
    });

    const login = await agent.get('/api/auth/oidc/login').expect(302);
    expect(login.headers.location).toContain('https://idp.example.test/auth');
    expect(login.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(login.headers['set-cookie'][0]).toContain('SameSite=Lax');

    const callback = await agent
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .expect(200);
    expect(callback.body).toMatchObject({
      success: true,
      status: 'needs_workspace_selection',
      tenantId: 'tenant-a',
      userId,
    });
    expect(callback.body.accessToken).toBeUndefined();
    expect(callback.body.sessionId).toBeUndefined();
    expect((callback.headers['set-cookie'] as unknown as string[]).join(';')).toContain(
      'sp_oidc_state=; Path=/api/auth/oidc/callback',
    );
    expect(captured.transaction).toEqual({
      state: captured.state,
      nonce: captured.nonce,
      codeVerifier: 'pkce-verifier-123',
    });

    const session = await agent.get('/api/auth/session').expect(200);
    expect(session.body).toMatchObject({
      authenticated: true,
      status: 'needs_workspace_selection',
      tenantId: 'tenant-a',
      userId,
      email: 'alice@example.test',
    });
    expect(session.body.workspaces.map((workspace: any) => workspace.workspaceId)).toEqual([
      'workspace-a',
      'workspace-b',
    ]);

    await agent
      .post('/api/auth/onboarding/workspace')
      .send({ workspaceId: 'workspace-a' })
      .expect(403);
    const selected = await agent
      .post('/api/auth/onboarding/workspace')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ workspaceId: 'workspace-a' })
      .expect(200);
    expect(selected.body).toMatchObject({
      success: true,
      status: 'ready',
      workspaceId: 'workspace-a',
    });

    const protectedRes = await agent.get('/protected').expect(200);
    expect(protectedRes.body.requestContext).toMatchObject({
      authType: 'sso',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId,
      roles: ['analyst'],
    });
    expect(protectedRes.body.requestContext.scopes).not.toContain('*');

    db.prepare(`
      UPDATE memberships
      SET role = 'viewer'
      WHERE tenant_id = 'tenant-a'
        AND workspace_id = 'workspace-a'
        AND user_id = ?
    `).run(userId);
    const downgraded = await agent.get('/protected').expect(200);
    expect(downgraded.body.requestContext).toMatchObject({
      roles: ['viewer'],
      scopes: ['trace:read', 'report:read'],
    });

    db.prepare(`
      DELETE FROM memberships
      WHERE tenant_id = 'tenant-a'
        AND workspace_id = 'workspace-a'
        AND user_id = ?
    `).run(userId);
    await agent.get('/protected').expect(401);
    const membershipRevokedSession =
      await agent.get('/api/auth/session').expect(200);
    expect(membershipRevokedSession.body).toMatchObject({
      authenticated: true,
      status: 'needs_workspace_selection',
      roles: [],
      scopes: [],
    });
    expect(membershipRevokedSession.body.workspaceId).toBeUndefined();

    await agent
      .post('/api/auth/logout')
      .set('Origin', FRONTEND_ORIGIN)
      .expect(200);
    expect((await agent.get('/api/auth/session')).body.authenticated).toBe(false);
  });

  test('returns a CSP-protected popup callback only to an allowlisted frontend', async () => {
    const issuer = 'https://idp.example.test';
    const subject = 'alice-sub';
    const userId = ssoUserId(issuer, subject);
    seedMemberships(db, userId);
    const service = new EnterpriseSsoService(db);
    const { app, captured } = makeApp(service, {
      issuer,
      subject,
      claims: { sub: subject, tenant_id: 'tenant-a' },
    });
    const agent = request.agent(app);
    await agent
      .get(`/api/auth/oidc/login?returnTo=${encodeURIComponent(`${FRONTEND_ORIGIN}/viewer#trace`)}`)
      .expect(302);
    const callback = await agent
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .expect(200);
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(callback.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(callback.text).toContain('smartperfetto:oidc-callback');
    expect(callback.text).toContain('"perfettoIgnore":true');
    expect(callback.text).toContain(FRONTEND_ORIGIN);

    await request(app)
      .get('/api/auth/oidc/login?returnTo=https://attacker.example/steal')
      .expect(400);
  });

  test('clears state for provider errors and invalid callback state', async () => {
    const service = new EnterpriseSsoService(db);
    const { app, captured } = makeApp(service, {
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      claims: { sub: 'alice-sub', tenant_id: 'tenant-a' },
    });
    const agent = request.agent(app);
    await agent.get('/api/auth/oidc/login').expect(302);
    const providerError = await agent
      .get(`/api/auth/oidc/callback?error=access_denied&state=${captured.state}`)
      .expect(400);
    expect(providerError.headers['set-cookie'][0]).toContain(
      'sp_oidc_state=',
    );
    expect(providerError.headers['set-cookie'][0]).toContain('Max-Age=0');

    const invalid = await request(app)
      .get('/api/auth/oidc/callback?code=code-123&state=wrong')
      .expect(400);
    expect(invalid.headers['set-cookie'][0]).toContain('Max-Age=0');
  });

  test('returns needs_tenant_join without creating a browser session', async () => {
    const service = new EnterpriseSsoService(db);
    const { app, captured } = makeApp(service, {
      issuer: 'https://idp.example.test',
      subject: 'bob-sub',
      email: 'bob@unknown.test',
      claims: { sub: 'bob-sub', email: 'bob@unknown.test' },
    });
    const agent = request.agent(app);
    await agent.get('/api/auth/oidc/login').expect(302);
    const callback = await agent
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .expect(200);
    expect(callback.body).toMatchObject({
      success: true,
      status: 'needs_tenant_join',
    });
    expect((await agent.get('/api/auth/session')).body.authenticated).toBe(false);
    expect(service.listAuditEvents()).toEqual([]);
  });

  test('does not domain-map a raw email claim suppressed as unverified', async () => {
    process.env.SMARTPERFETTO_OIDC_EMAIL_DOMAIN_MAP =
      'example.test=tenant-a';
    const service = new EnterpriseSsoService(db);
    const { app, captured } = makeApp(service, {
      issuer: 'https://idp.example.test',
      subject: 'unverified-sub',
      claims: {
        sub: 'unverified-sub',
        email: 'unverified@example.test',
        email_verified: false,
      },
    });
    const agent = request.agent(app);
    await agent.get('/api/auth/oidc/login').expect(302);
    const callback = await agent
      .get(`/api/auth/oidc/callback?code=code-123&state=${captured.state}`)
      .expect(200);
    expect(callback.body).toMatchObject({
      success: true,
      status: 'needs_tenant_join',
    });
    expect((await agent.get('/api/auth/session')).body.authenticated).toBe(false);
  });

  test('rejects returnTo values that URL parsing would reinterpret externally', async () => {
    const service = new EnterpriseSsoService(db);
    const { app } = makeApp(service, {
      issuer: 'https://idp.example.test',
      subject: 'alice-sub',
      claims: {sub: 'alice-sub', tenant_id: 'tenant-a'},
    });
    await request(app)
      .get('/api/auth/oidc/login')
      .query({returnTo: '/\\attacker.example'})
      .expect(400);
  });
});

describe('resolveEnterpriseSsoCookiePolicy', () => {
  test('derives Secure from HTTPS and requires it for SameSite=None', () => {
    expect(resolveEnterpriseSsoCookiePolicy({
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'https://smartperfetto.example.test/api/auth/oidc/callback',
      SMARTPERFETTO_SSO_COOKIE_SAME_SITE: 'none',
    })).toMatchObject({
      secure: true,
      sameSite: 'None',
    });
    expect(() => resolveEnterpriseSsoCookiePolicy({
      SMARTPERFETTO_OIDC_REDIRECT_URI:
        'http://127.0.0.1:3000/api/auth/oidc/callback',
      SMARTPERFETTO_SSO_COOKIE_SAME_SITE: 'none',
    })).toThrow('SameSite=None requires');
  });
});
