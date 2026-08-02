// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  attachRequestContext,
  authenticate,
  type AuthenticatedRequest,
} from '../auth';

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalEnterprise = process.env.SMARTPERFETTO_ENTERPRISE;
const originalSsoTrustedHeaders = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
const oidcEnvKeys = [
  'SMARTPERFETTO_OIDC_ISSUER_URL',
  'SMARTPERFETTO_OIDC_CLIENT_ID',
  'SMARTPERFETTO_OIDC_CLIENT_SECRET',
  'SMARTPERFETTO_OIDC_REDIRECT_URI',
] as const;
const originalOidcEnv = Object.fromEntries(
  oidcEnvKeys.map(key => [key, process.env[key]]),
);

function makeProbeApp(middleware = authenticate): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/probe', middleware, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    res.json({
      user: authReq.user,
      requestContext: authReq.requestContext,
    });
  });
  return app;
}

afterEach(() => {
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
  for (const key of oidcEnvKeys) {
    if (originalOidcEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalOidcEnv[key];
  }
});

describe('authenticate RequestContext', () => {
  it('injects default dev context when API key auth is not configured', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;

    const res = await request(makeProbeApp()).get('/probe');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: 'dev-user-123',
      email: 'dev@example.com',
      subscription: 'pro',
    });
    expect(res.body.requestContext).toMatchObject({
      tenantId: 'default-dev-tenant',
      workspaceId: 'default-workspace',
      userId: 'dev-user-123',
      authType: 'dev',
      roles: ['org_admin'],
      scopes: ['*'],
    });
    expect(res.body.requestContext.requestId).toMatch(/^req-/);
  });

  it('uses workspace headers and sanitizes request/window identifiers', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('X-Tenant-Id', 'tenant:alpha')
      .set('X-Workspace-Id', 'workspace_01')
      .set('X-Window-Id', 'window<>42')
      .set('X-Request-Id', 'req 123!');

    expect(res.status).toBe(200);
    expect(res.body.requestContext).toMatchObject({
      tenantId: 'tenant:alpha',
      workspaceId: 'workspace_01',
      windowId: 'window42',
      requestId: 'req123',
    });
  });

  it('rejects missing API key when auth is configured', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(makeProbeApp()).get('/probe');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Unauthorized',
      details: 'Invalid or missing API key',
    });
  });

  it('rejects dev fallback in enterprise mode when no SSO or API key identity is present', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';

    const res = await request(makeProbeApp()).get('/probe');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Unauthorized',
      details: 'Enterprise mode requires SSO or API key authentication',
    });
  });

  it('ignores SSO identity headers unless trusted SSO headers are enabled', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('X-SSO-User-Id', 'alice');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('injects SSO RequestContext from trusted identity headers', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('X-SmartPerfetto-SSO-User-Id', 'user<>alice')
      .set('X-SmartPerfetto-SSO-Email', 'alice@example.test')
      .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
      .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
      .set('X-SmartPerfetto-SSO-Roles', 'analyst,workspace_admin')
      .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run')
      .set('X-Window-Id', 'window-a');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: 'useralice',
      email: 'alice@example.test',
      subscription: 'enterprise',
    });
    expect(res.body.requestContext).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'useralice',
      authType: 'sso',
      roles: ['analyst', 'workspace_admin'],
      scopes: ['trace:read', 'trace:write', 'agent:run'],
      windowId: 'window-a',
    });
  });

  it('injects API-key RequestContext for valid bearer auth', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('Authorization', 'Bearer test-secret')
      .set('X-Tenant-Id', 'tenant-a')
      .set('X-Workspace-Id', 'workspace-a');

    expect(res.status).toBe(200);
    expect(res.body.user.id).toMatch(/^api-key-[a-f0-9]{8}$/);
    expect(res.body.requestContext).toMatchObject({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: res.body.user.id,
      authType: 'api_key',
      roles: ['org_admin'],
      scopes: ['*'],
    });
  });

  it('does not allow the legacy static API key to bypass built-in OIDC', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
      'https://app.example.test/api/auth/oidc/callback';

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('Authorization', 'Bearer test-secret')
      .set('X-Tenant-Id', 'tenant-a')
      .set('X-Workspace-Id', 'workspace-a');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Unauthorized',
      details: 'OIDC session authentication is required',
    });
  });

  it('treats a malformed OIDC session cookie as unauthorized instead of failing', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
    process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
    process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
    process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
      'https://app.example.test/api/auth/oidc/callback';

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('Cookie', 'sp_sso_session=%');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Unauthorized',
      details: 'OIDC session authentication is required',
    });
  });

  it('attachRequestContext keeps the same behavior as authenticate for route coverage', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;

    const res = await request(makeProbeApp(attachRequestContext)).get('/probe');

    expect(res.status).toBe(200);
    expect(res.body.requestContext).toMatchObject({
      tenantId: 'default-dev-tenant',
      workspaceId: 'default-workspace',
      authType: 'dev',
    });
  });
});
