// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';
import { authenticate } from '../../middleware/auth';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import traceConfigProposalRoutes from '../traceConfigProposalRoutes';
import {LOADING_ROUTING_CASES} from '../../../tests/helpers/traceConfigProposalRoutingCases';

const originalEnv = {
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
};

const API_KEY = 'trace-config-proposal-secret';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workspaces/:workspaceId/trace-config',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    traceConfigProposalRoutes,
  );
  return app;
}

function authHeaders(req: request.Test, workspaceId = 'workspace-a'): request.Test {
  return req
    .set('Authorization', `Bearer ${API_KEY}`)
    .set('x-tenant-id', 'tenant-a')
    .set('x-workspace-id', workspaceId);
}

function ssoHeaders(req: request.Test, scopes: string): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'trace-config-user')
    .set('X-SmartPerfetto-SSO-Email', 'trace-config-user@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'viewer')
    .set('X-SmartPerfetto-SSO-Scopes', scopes);
}

describe('trace config proposal routes', () => {
  beforeEach(() => {
    process.env.SMARTPERFETTO_API_KEY = API_KEY;
    delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  });

  afterEach(() => {
    restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
    restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  });

  it('creates a workspace-scoped startup proposal without side effects', async () => {
    const app = makeApp();

    const res = await authHeaders(
      request(app)
        .post('/api/workspaces/workspace-a/trace-config/proposals')
        .send({
          request: 'debug startup first frame',
          app: 'com.example.app',
          durationSeconds: 10,
          categories: ['dalvikviktime'],
        }),
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.proposal).toMatchObject({
      schemaVersion: 1,
      source: 'deterministic',
      preset: 'startup',
      app: 'com.example.app',
    });
    expect(res.body.proposal.config.textproto).toContain('duration_ms: 10000');
    expect(res.body.proposal.config.textproto).toContain('atrace_categories: "dalvikviktime"');
  });

  it.each(LOADING_ROUTING_CASES)('routes "$request" to $preset over HTTP ($why)', async ({request: text, preset}) => {
    const res = await authHeaders(
      request(makeApp())
        .post('/api/workspaces/workspace-a/trace-config/proposals')
        .send({request: text}),
    );
    expect(res.status).toBe(200);
    expect(res.body.proposal.preset).toBe(preset);
  });

  it('requires trace write permission for enterprise SSO callers', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    const app = makeApp();

    const res = await ssoHeaders(
      request(app)
        .post('/api/workspaces/workspace-a/trace-config/proposals')
        .send({ request: 'debug scrolling jank' }),
      'trace:read',
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toBe('trace:write permission is required');
  });

  it('rejects malformed requests', async () => {
    const app = makeApp();

    const missingRequest = await authHeaders(
      request(app)
        .post('/api/workspaces/workspace-a/trace-config/proposals')
        .send({ app: 'com.example.app' }),
    );
    expect(missingRequest.status).toBe(400);
    expect(missingRequest.body.error).toBe('request is required');

    const invalidCategories = await authHeaders(
      request(app)
        .post('/api/workspaces/workspace-a/trace-config/proposals')
        .send({ request: 'startup', categories: ['am', 42] }),
    );
    expect(invalidCategories.status).toBe(400);
    expect(invalidCategories.body.error).toBe('categories must be an array of strings');
  });
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
