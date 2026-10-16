// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { authenticate } from '../../middleware/auth';
import { markLegacyApi } from '../../middleware/legacyAgentApi';
import {
  bindWorkspaceRouteContext,
  requireWorkspaceRouteContext,
} from '../../middleware/workspaceRouteContext';
import agentRoutes from '../agentRoutes';
import providerRoutes from '../providerRoutes';
import reportRoutes from '../reportRoutes';
import batchTraceRoutes from '../batchTraceRoutes';
import skillPackRoutes from '../skillPackRoutes';
import traceRoutes from '../simpleTraceRoutes';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;

async function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/traces',
    markLegacyApi(
      '/api/workspaces/:workspaceId/traces',
      'Legacy trace API is deprecated. Migrate to workspace-scoped trace APIs',
    ),
    traceRoutes,
  );
  app.use(
    '/api/reports',
    markLegacyApi(
      '/api/workspaces/:workspaceId/reports',
      'Legacy report API is deprecated. Migrate to workspace-scoped report APIs',
    ),
    reportRoutes,
  );
  app.use(
    '/api/agent/v1',
    markLegacyApi(
      '/api/workspaces/:workspaceId/agent',
      'Legacy agent API is deprecated. Migrate to workspace-scoped agent APIs',
    ),
    agentRoutes,
  );
  app.use(
    '/api/v1/providers',
    markLegacyApi(
      '/api/workspaces/:workspaceId/providers',
      'Legacy provider API is deprecated. Migrate to workspace-scoped provider APIs',
    ),
    providerRoutes,
  );
  app.use(
    '/api/workspaces/:workspaceId/skill-packs',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    skillPackRoutes,
  );
  app.use(
    '/api/workspaces/:workspaceId/batch-traces',
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
    batchTraceRoutes,
  );
  return loopbackServers.listen(app);
}

afterEach(async () => {
  await loopbackServers.close();
  if (originalApiKey === undefined) {
    delete process.env.SMARTPERFETTO_API_KEY;
  } else {
    process.env.SMARTPERFETTO_API_KEY = originalApiKey;
  }
});

describe('RequestContext route coverage', () => {
  it('keeps trace health available through dev fallback', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;

    const res = await request(await makeApp()).get('/api/traces/health');

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('keeps trace health public when API key auth is configured', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp()).get('/api/traces/health');

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('applies RequestContext auth middleware to trace resource routes when API key auth is configured', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp()).get('/api/traces');

    expect(res.status).toBe(401);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeDefined();
    expect(res.body.error).toBe('Unauthorized');
  });

  it('applies RequestContext auth middleware to report routes when API key auth is configured', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp()).get('/api/reports/missing-report');

    expect(res.status).toBe(401);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeDefined();
    expect(res.body.error).toBe('Unauthorized');
  });

  it('applies RequestContext auth middleware to legacy agent routes before analysis starts', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp())
      .post('/api/agent/v1/analyze')
      .send({ traceId: 'trace-a', query: 'analyze this trace' });

    expect(res.status).toBe(401);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeDefined();
    expect(res.body.error).toBe('Unauthorized');
  });

  it('applies RequestContext auth middleware to legacy provider routes', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp()).get('/api/v1/providers');

    expect(res.status).toBe(401);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeDefined();
    expect(res.body.error).toBe('Unauthorized');
  });

  it('applies RequestContext auth middleware to workspace skill pack routes', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp()).get('/api/workspaces/workspace-a/skill-packs');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('applies RequestContext auth middleware to workspace batch trace routes', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'test-secret';

    const res = await request(await makeApp()).get('/api/workspaces/workspace-a/batch-traces');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });
});
