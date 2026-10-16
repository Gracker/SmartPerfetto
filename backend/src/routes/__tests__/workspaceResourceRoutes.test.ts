// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';

import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

let authenticate: typeof import('../../middleware/auth')['authenticate'];
let bindWorkspaceRouteContext: typeof import('../../middleware/workspaceRouteContext')['bindWorkspaceRouteContext'];
let requireWorkspaceRouteContext: typeof import('../../middleware/workspaceRouteContext')['requireWorkspaceRouteContext'];
let agentRoutes: typeof import('../agentRoutes').default;
let providerRoutes: typeof import('../providerRoutes').default;
let reportRoutes: typeof import('../reportRoutes').default;
let reportStore: typeof import('../reportRoutes')['reportStore'];
let traceRoutes: typeof import('../simpleTraceRoutes').default;
let NO_PRIVATE_CONTEXT: typeof import('../../services/security/analysisPrivateContext')['NO_PRIVATE_CONTEXT'];
let SessionPersistenceService: typeof import('../../services/sessionPersistenceService')['SessionPersistenceService'];
let resetConversationSessionStoreForTests: typeof import('../../services/conversationSessionStore')['resetConversationSessionStoreForTests'];
let resetProviderService: typeof import('../../services/providerManager')['resetProviderService'];
let resetAnalysisRunStoreForTests: typeof import('../../services/analysisRunStore')['resetAnalysisRunStoreForTests'];
let resetAgentEventStoreForTests: typeof import('../../services/agentEventStore')['resetAgentEventStoreForTests'];
let resetAnalysisHistoryStoreForTests: typeof import('../../services/analysisHistoryStore')['resetAnalysisHistoryStoreForTests'];
let resetRunManifestStoreForTests: typeof import('../../services/selfEvolution/runManifestStore')['resetRunManifestStoreForTests'];

const fixtureEnvKeys = ['SMARTPERFETTO_ENTERPRISE_DB_PATH', 'SMARTPERFETTO_BACKEND_DATA_DIR',
  'SMARTPERFETTO_BACKEND_LOG_DIR', 'PROVIDER_DATA_DIR_OVERRIDE', 'SCENE_REPORT_DIR',
  'SCENE_JOB_ARTIFACT_DIR', 'SMARTPERFETTO_DATA_DIR', 'UPLOAD_DIR'] as const;
const fixtureOriginalEnv = new Map(fixtureEnvKeys.map(key => [key, process.env[key]]));
let suiteRoot: string;
let caseRoot: string;
const caseRoots = new Set<string>();
let cleanupFailed = false;

function useFixturePaths(root: string): void {
  process.env.SMARTPERFETTO_ENTERPRISE_DB_PATH = path.join(root, 'sessions.sqlite');
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(root, 'data');
  process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(root, 'logs');
  process.env.PROVIDER_DATA_DIR_OVERRIDE = path.join(root, 'providers');
  process.env.SMARTPERFETTO_DATA_DIR = path.join(root, 'enterprise-data');
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
}

function closeFixtureStores(): void {
  SessionPersistenceService.resetForTests();
  resetConversationSessionStoreForTests();
  resetAnalysisRunStoreForTests();
  resetAgentEventStoreForTests();
  resetAnalysisHistoryStoreForTests();
  resetRunManifestStoreForTests();
  resetProviderService();
}

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-private-http-'));
  useFixturePaths(suiteRoot);
  console.info('[HTTP fixture] workspaceResourceRoutes owns', suiteRoot);
  // These paths are captured by config/route singletons at import time.
  process.env.SCENE_REPORT_DIR = path.join(suiteRoot, 'scene-reports');
  process.env.SCENE_JOB_ARTIFACT_DIR = path.join(suiteRoot, 'scene-jobs');
  ({authenticate} = await import('../../middleware/auth'));
  ({bindWorkspaceRouteContext, requireWorkspaceRouteContext} = await import('../../middleware/workspaceRouteContext'));
  agentRoutes = (await import('../agentRoutes')).default;
  providerRoutes = (await import('../providerRoutes')).default;
  reportRoutes = (await import('../reportRoutes')).default;
  ({reportStore} = await import('../reportRoutes'));
  traceRoutes = (await import('../simpleTraceRoutes')).default;
  ({NO_PRIVATE_CONTEXT} = await import('../../services/security/analysisPrivateContext'));
  ({SessionPersistenceService} = await import('../../services/sessionPersistenceService'));
  ({resetConversationSessionStoreForTests} = await import('../../services/conversationSessionStore'));
  ({resetProviderService} = await import('../../services/providerManager'));
  ({resetAnalysisRunStoreForTests} = await import('../../services/analysisRunStore'));
  ({resetAgentEventStoreForTests} = await import('../../services/agentEventStore'));
  ({resetAnalysisHistoryStoreForTests} = await import('../../services/analysisHistoryStore'));
  ({resetRunManifestStoreForTests} = await import('../../services/selfEvolution/runManifestStore'));
});

beforeEach(async () => {
  if (cleanupFailed) throw new Error(`Previous fixture cleanup failed; retained ${suiteRoot}`);
  caseRoot = await fs.mkdtemp(path.join(suiteRoot, 'case-'));
  caseRoots.add(caseRoot);
  useFixturePaths(caseRoot);
  closeFixtureStores();
});

async function removeCaseRoots(): Promise<void> {
  if (cleanupFailed) return;
  for (const root of caseRoots) {
    await fs.rm(root, {recursive: true, force: true});
  }
  caseRoots.clear();
}

afterAll(async () => {
  try {
    closeFixtureStores();
  } catch (error) {
    cleanupFailed = true;
    throw error;
  } finally {
    for (const [key, value] of fixtureOriginalEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (!cleanupFailed) {
      const root = suiteRoot;
      await fs.rm(root, {recursive: true, force: true});
      console.info('[HTTP fixture] workspaceResourceRoutes cleanup complete', root);
    }
  }
});

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalUploadDir = process.env.UPLOAD_DIR;
const originalSsoTrustedHeaders = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
const originalOutputLanguage = process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
const API_KEY = 'workspace-route-secret';
const API_USER_ID = `api-key-${crypto.createHash('sha256').update(API_KEY).digest('hex').slice(0, 8)}`;

let uploadDir: string;

async function makeWorkspaceApp() {
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
  return loopbackServers.listen(app);
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
  try {
    await loopbackServers.close();
    reportStore.clear();
    closeFixtureStores();
    caseRoots.add(uploadDir);
    await removeCaseRoots();
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
    useFixturePaths(suiteRoot);
  } catch (error) {
    cleanupFailed = true;
    throw error;
  }
});

describe('workspace resource routes', () => {
  it('binds trace list ownership to the workspace path without legacy headers', async () => {
    await writeTraceMetadata('trace-a', 'workspace-a');
    await writeTraceMetadata('trace-b', 'workspace-b');
    const app = await makeWorkspaceApp();

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
    const app = await makeWorkspaceApp();

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
      privateContext: NO_PRIVATE_CONTEXT,
      sessionId: 'session-b',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-b',
      userId: API_USER_ID,
    });
    const app = await makeWorkspaceApp();

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
    const app = await makeWorkspaceApp();

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
