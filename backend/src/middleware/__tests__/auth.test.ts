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
      roles: ['analyst'],
      scopes: ['trace:read', 'trace:write', 'agent:run', 'report:read'],
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
