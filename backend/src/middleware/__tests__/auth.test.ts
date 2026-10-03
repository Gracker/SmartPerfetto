// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  attachRequestContext,
  authenticate,
  buildRequestContext,
  resolveCredentialIdentity,
  type AuthenticatedRequest,
} from '../auth';
import { EnterpriseApiKeyService } from '../../services/enterpriseApiKeyService';
import { openEnterpriseDb } from '../../services/enterpriseDb';

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

function setOidcEnv(): void {
  process.env.SMARTPERFETTO_OIDC_ISSUER_URL = 'https://idp.example.test';
  process.env.SMARTPERFETTO_OIDC_CLIENT_ID = 'client-a';
  process.env.SMARTPERFETTO_OIDC_CLIENT_SECRET = 'client-secret-a';
  process.env.SMARTPERFETTO_OIDC_REDIRECT_URI =
    'https://app.example.test/api/auth/oidc/callback';
}

function headerRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

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
    setOidcEnv();

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
    setOidcEnv();

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('Cookie', 'sp_sso_session=%');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'Unauthorized',
      details: 'OIDC session authentication is required',
    });
  });

  it.each(['true', 'yes', 'on'])(
    'never trusts SSO identity headers under built-in OIDC (trusted headers=%s)',
    async (value) => {
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = value;
      setOidcEnv();
      const forged = {
        'x-smartperfetto-sso-user-id': 'mallory',
        'x-smartperfetto-sso-roles': 'org_admin',
      };

      // The shared resolver also serves the WebSocket upgrade, which has no
      // outer OIDC check of its own.
      expect(resolveCredentialIdentity(headerRequest(forged))).toEqual({ kind: 'none' });
      const res = await request(makeProbeApp()).get('/probe').set(forged);
      expect(res.status).toBe(401);
      expect(res.body.details).toBe('OIDC session authentication is required');
    },
  );

  it('does not accept an enterprise API key under built-in OIDC', () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    setOidcEnv();

    expect(resolveCredentialIdentity(headerRequest({
      authorization: 'Bearer spak_not-a-real-key',
    }))).toEqual({ kind: 'none' });
  });

  it('rejects a present but unusable enterprise API key instead of falling back', () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-auth-'));
    const db = openEnterpriseDb(path.join(tmpDir, 'enterprise.sqlite'));
    EnterpriseApiKeyService.setInstanceForTests(new EnterpriseApiKeyService(db));
    try {
      expect(resolveCredentialIdentity(headerRequest({
        authorization: 'Bearer spak_not-a-real-key',
      }))).toEqual({ kind: 'rejected', details: 'Invalid or expired API key' });
    } finally {
      EnterpriseApiKeyService.resetForTests();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('answers a failing credential lookup with fixed text and logs the cause', () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    const canary = 'canary-auth /srv/enterprise.sqlite SQLITE_CORRUPT';
    EnterpriseApiKeyService.setInstanceForTests({
      resolveRequestIdentityFromRequest: () => {
        throw new Error(canary);
      },
    } as unknown as EnterpriseApiKeyService);
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(resolveCredentialIdentity(headerRequest({
        authorization: 'Bearer spak_not-a-real-key',
      }))).toEqual({ kind: 'rejected', details: 'Invalid or expired API key' });
      expect(errorLog.mock.calls.flat()).toContainEqual(new Error(canary));
    } finally {
      errorLog.mockRestore();
      EnterpriseApiKeyService.resetForTests();
    }
  });

  it('consults context fallbacks after the headers and before the defaults', () => {
    const fallbacks = { tenantId: 'tenant-q', workspaceId: 'workspace-q', windowId: 'window-q' };

    expect(buildRequestContext(headerRequest({}), { userId: 'u', authType: 'dev' }, fallbacks))
      .toMatchObject({ tenantId: 'tenant-q', workspaceId: 'workspace-q', windowId: 'window-q' });
    expect(buildRequestContext(headerRequest({
      'x-tenant-id': 'tenant-h',
      'x-workspace-id': 'workspace-h',
      'x-window-id': 'window-h',
    }), { userId: 'u', authType: 'sso' }, fallbacks))
      .toMatchObject({ tenantId: 'tenant-h', workspaceId: 'workspace-h', windowId: 'window-h' });
  });

  it('never lets headers or fallbacks choose the workspace of an unbound API key', () => {
    const context = buildRequestContext(
      headerRequest({ 'x-workspace-id': 'workspace-h' }),
      { userId: 'owner', authType: 'api_key', tenantId: 'tenant-a', roles: ['api_key'], scopes: ['trace:read'] },
      { workspaceId: 'workspace-q' },
    );

    expect(context).toMatchObject({ tenantId: 'tenant-a', workspaceId: 'default-workspace' });
  });

  it('treats a malformed SSO session cookie as no session outside OIDC', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;

    const res = await request(makeProbeApp())
      .get('/probe')
      .set('Cookie', 'sp_sso_session=%');

    expect(res.status).toBe(200);
    expect(res.body.requestContext).toMatchObject({ authType: 'dev' });
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
