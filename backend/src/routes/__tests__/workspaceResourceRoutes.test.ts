// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import crypto from 'crypto';
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
import agentRoutes from '../agentRoutes';
import providerRoutes from '../providerRoutes';
import reportRoutes, { reportStore } from '../reportRoutes';
import traceRoutes from '../simpleTraceRoutes';

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalUploadDir = process.env.UPLOAD_DIR;
const originalSsoTrustedHeaders = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
const originalOutputLanguage = process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
const API_KEY = 'workspace-route-secret';
const API_USER_ID = `api-key-${crypto.createHash('sha256').update(API_KEY).digest('hex').slice(0, 8)}`;

let uploadDir: string;

function makeWorkspaceApp(): express.Express {
  const app = express();
  const workspaceMiddlewares = [
    bindWorkspaceRouteContext,
    authenticate,
    requireWorkspaceRouteContext,
  ];
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/traces', ...workspaceMiddlewares, traceRoutes);
  app.use('/api/workspaces/:workspaceId/reports', ...workspaceMiddlewares, reportRoutes);
  app.use('/api/workspaces/:workspaceId/agent', ...workspaceMiddlewares, agentRoutes);
  app.use('/api/workspaces/:workspaceId/providers', ...workspaceMiddlewares, providerRoutes);
  return app;
}

function authHeaders(req: request.Test, workspaceId = 'workspace-a'): request.Test {
  return req
    .set('Authorization', `Bearer ${API_KEY}`)
    .set('x-tenant-id', 'tenant-a')
    .set('x-workspace-id', workspaceId);
}

function trustedSsoHeaders(
  req: request.Test,
  workspaceId = 'workspace-a',
  roles = 'analyst',
  scopes = 'trace:read,report:read,agent:run',
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'sso-user')
    .set('X-SmartPerfetto-SSO-Email', 'sso-user@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', roles)
    .set('X-SmartPerfetto-SSO-Scopes', scopes);
}

async function writeTraceMetadata(id: string, workspaceId: string): Promise<void> {
  const tracesDir = path.join(uploadDir, 'traces');
  await fs.mkdir(tracesDir, { recursive: true });
  const tracePath = path.join(tracesDir, `${id}.trace`);
  await fs.writeFile(tracePath, `trace-${id}`);
  await fs.writeFile(
    path.join(tracesDir, `${id}.json`),
    JSON.stringify({
      id,
      filename: `${id}.trace`,
      size: 16,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      path: tracePath,
      tenantId: 'tenant-a',
      workspaceId,
      userId: API_USER_ID,
    }, null, 2),
  );
}

beforeEach(async () => {
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-workspace-routes-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.SMARTPERFETTO_API_KEY = API_KEY;
  // These cases assert route wiring through the exact error text, so the output
  // language has to be pinned rather than inherited: the runtime defaults to
  // zh-CN and would answer 「缺少 traceId」 on any machine that has not set this.
  process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
  reportStore.clear();
});

afterEach(async () => {
  reportStore.clear();
  if (originalApiKey === undefined) {
    delete process.env.SMARTPERFETTO_API_KEY;
  } else {
    process.env.SMARTPERFETTO_API_KEY = originalApiKey;
  }
  if (originalUploadDir === undefined) {
    delete process.env.UPLOAD_DIR;
  } else {
    process.env.UPLOAD_DIR = originalUploadDir;
  }
  if (originalOutputLanguage === undefined) {
    delete process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
  } else {
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = originalOutputLanguage;
  }
  if (originalSsoTrustedHeaders === undefined) {
    delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  } else {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = originalSsoTrustedHeaders;
  }
  await fs.rm(uploadDir, { recursive: true, force: true });
});

describe('workspace resource routes', () => {
  it('binds trace list ownership to the workspace path without legacy headers', async () => {
    await writeTraceMetadata('trace-a', 'workspace-a');
    await writeTraceMetadata('trace-b', 'workspace-b');
    const app = makeWorkspaceApp();

    const res = await authHeaders(
      request(app).get('/api/workspaces/workspace-b/traces'),
      'workspace-a',
    );

    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBeUndefined();
    expect(res.body.traces.map((trace: any) => trace.id)).toEqual(['trace-b']);
  });

  it('rejects trusted SSO requests whose selected workspace differs from the workspace path', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const app = makeWorkspaceApp();

    const res = await trustedSsoHeaders(
      request(app).get('/api/workspaces/workspace-b/traces'),
      'workspace-a',
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Resource not found');
  });

  it('serves reports through workspace-scoped paths without legacy headers', async () => {
    reportStore.set('report-b', {
      html: '<html><body>workspace b report</body></html>',
      generatedAt: Date.now(),
      sessionId: 'session-b',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-b',
      userId: API_USER_ID,
    });
    const app = makeWorkspaceApp();

    const res = await authHeaders(
      request(app).get('/api/workspaces/workspace-b/reports/report-b'),
      'workspace-a',
    );

    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBeUndefined();
    expect(res.text).toContain('workspace b report');
  });

  it('mounts provider and agent aliases under the workspace resource root', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const app = makeWorkspaceApp();

    const providerRes = await trustedSsoHeaders(
      request(app).get('/api/workspaces/workspace-b/providers/templates'),
      'workspace-b',
      'workspace_admin',
      'provider:manage_workspace,agent:run',
    );
    expect(providerRes.status).toBe(200);
    expect(providerRes.headers.deprecation).toBeUndefined();
    expect(providerRes.body.success).toBe(true);

    const runRes = await trustedSsoHeaders(
      request(app)
        .post('/api/workspaces/workspace-b/agent/sessions/session-b/runs')
        .send({ query: '分析 trace' }),
      'workspace-b',
      'workspace_admin',
      'provider:manage_workspace,agent:run',
    );
    expect(runRes.status).toBe(400);
    expect(runRes.body.error).toBe('traceId is required');

    const respondRes = await trustedSsoHeaders(
      request(app)
        .post('/api/workspaces/workspace-b/agent/sessions/missing-session/respond')
        .send({ action: 'continue' }),
      'workspace-b',
      'workspace_admin',
      'provider:manage_workspace,agent:run',
    );
    expect(respondRes.status).toBe(404);
    expect(respondRes.body.error).toBe('Session not found');

    const streamRes = await trustedSsoHeaders(
      request(app).get('/api/workspaces/workspace-b/agent/runs/missing-run/stream'),
      'workspace-b',
      'workspace_admin',
      'provider:manage_workspace,agent:run',
    );
    expect(streamRes.status).toBe(404);
    expect(streamRes.body.error).toBe('Run not found');
  });
});
