// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { authenticate } from '../../middleware/auth';
import { registerAgentReportRoutes } from '../agentReportRoutes';
import { registerAgentSessionCatalogRoutes } from '../agentSessionCatalogRoutes';
import reportRoutes, { reportStore } from '../reportRoutes';
import traceRoutes from '../simpleTraceRoutes';

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalUploadDir = process.env.UPLOAD_DIR;
const API_KEY = 'owner-test-secret';
const API_USER_ID = `api-key-${crypto.createHash('sha256').update(API_KEY).digest('hex').slice(0, 8)}`;

let uploadDir: string;

function authHeaders(req: request.Test, tenantId = 'tenant-a', workspaceId = 'workspace-a'): request.Test {
  return req
    .set('Authorization', `Bearer ${API_KEY}`)
    .set('x-tenant-id', tenantId)
    .set('x-workspace-id', workspaceId);
}

function makeResourceApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/traces', traceRoutes);
  app.use('/api/reports', reportRoutes);
  return app;
}

async function writeTraceMetadata(
  id: string,
  owner: { tenantId?: string; workspaceId?: string; userId?: string } | null = {
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    userId: API_USER_ID,
  },
): Promise<void> {
  const tracesDir = path.join(uploadDir, 'traces');
  await fs.mkdir(tracesDir, { recursive: true });
  const tracePath = path.join(tracesDir, `${id}.trace`);
  await fs.writeFile(tracePath, `trace-${id}`);
  const metadata = {
    id,
    filename: `${id}.trace`,
    size: 16,
    uploadedAt: new Date().toISOString(),
    status: 'ready',
    path: tracePath,
    ...(owner ?? {}),
  };
  await fs.writeFile(path.join(tracesDir, `${id}.json`), JSON.stringify(metadata, null, 2));
}

beforeEach(async () => {
  uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-owner-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.SMARTPERFETTO_API_KEY = API_KEY;
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
  await fs.rm(uploadDir, { recursive: true, force: true });
});

describe('owner guard for trace and report routes', () => {
  it('filters trace list and returns 404 for traces owned by another tenant', async () => {
    await writeTraceMetadata('own-trace');
    await writeTraceMetadata('other-trace', {
      tenantId: 'tenant-b',
      workspaceId: 'workspace-a',
      userId: API_USER_ID,
    });

    const app = makeResourceApp();
    const listRes = await authHeaders(request(app).get('/api/traces'));
    expect(listRes.status).toBe(200);
    expect(listRes.body.traces.map((trace: any) => trace.id)).toEqual(['own-trace']);

    const ownRes = await authHeaders(request(app).get('/api/traces/own-trace'));
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.trace.id).toBe('own-trace');

    const otherRes = await authHeaders(request(app).get('/api/traces/other-trace'));
    expect(otherRes.status).toBe(404);

    const otherDelete = await authHeaders(request(app).delete('/api/traces/other-trace'));
    expect(otherDelete.status).toBe(404);
  });

  it('treats legacy trace metadata as dev-only default ownership', async () => {
    await writeTraceMetadata('legacy-trace', null);
    const app = makeResourceApp();

    const apiKeyRes = await authHeaders(request(app).get('/api/traces/legacy-trace'));
    expect(apiKeyRes.status).toBe(404);

    delete process.env.SMARTPERFETTO_API_KEY;
    const devRes = await request(app).get('/api/traces/legacy-trace');
    expect(devRes.status).toBe(200);
    expect(devRes.body.trace.id).toBe('legacy-trace');
  });

  it('hides global trace cleanup from non-privileged API-key requests', async () => {
    const app = makeResourceApp();

    const res = await authHeaders(request(app).post('/api/traces/cleanup'));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('guards persisted report access and delete by owner fields', async () => {
    reportStore.set('own-report', {
      html: '<html><body>own report</body></html>',
      generatedAt: Date.now(),
      sessionId: 'own-session',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: API_USER_ID,
    });
    reportStore.set('other-report', {
      html: '<html><body>other report</body></html>',
      generatedAt: Date.now(),
      sessionId: 'other-session',
      tenantId: 'tenant-b',
      workspaceId: 'workspace-a',
      userId: API_USER_ID,
    });

    const app = makeResourceApp();

    const ownRes = await authHeaders(request(app).get('/api/reports/own-report'));
    expect(ownRes.status).toBe(200);
    expect(ownRes.text).toContain('own report');

    const otherExport = await authHeaders(request(app).get('/api/reports/other-report/export'));
    expect(otherExport.status).toBe(404);

    const otherDelete = await authHeaders(request(app).delete('/api/reports/other-report'));
    expect(otherDelete.status).toBe(404);
    expect(reportStore.has('other-report')).toBe(true);
  });
});

describe('owner guard for agent session routes', () => {
  function makeAgentApp() {
    const router = express.Router();
    const recoverResultForSessionIfNeeded = jest.fn(() => ({
      conclusion: 'done',
      findings: [],
      hypotheses: [],
      confidence: 0.9,
      totalDurationMs: 123,
      rounds: 1,
    }));
    const sessions = new Map<string, any>([
      ['own-session', {
        status: 'completed',
        traceId: 'own-trace',
        query: 'own query',
        createdAt: 1000,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: API_USER_ID,
        scenes: [],
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        hypotheses: [],
        orchestrator: {},
        logger: { getLogFilePath: () => '/tmp/own.log' },
      }],
      ['other-session', {
        status: 'completed',
        traceId: 'other-trace',
        query: 'other query',
        createdAt: 2000,
        tenantId: 'tenant-b',
        workspaceId: 'workspace-a',
        userId: API_USER_ID,
        scenes: [],
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        hypotheses: [],
        orchestrator: {},
        logger: { getLogFilePath: () => '/tmp/other.log' },
      }],
    ]);

    registerAgentSessionCatalogRoutes(router, {
      sessionStore: {
        entries: () => sessions.entries(),
      },
      buildSessionObservability: () => ({}),
    });
    registerAgentReportRoutes(router, {
      getSession: (sessionId) => sessions.get(sessionId),
      recoverResultForSessionIfNeeded,
      normalizeNarrativeForClient: (narrative) => narrative,
      buildClientFindings: (findings) => findings,
      buildSessionResultContract: () => ({}),
    });

    const app = express();
    app.use(express.json());
    app.use(authenticate);
    app.use('/api/agent/v1', router);
    return { app, recoverResultForSessionIfNeeded };
  }

  it('filters /api/agent/v1/sessions by owner fields', async () => {
    const { app } = makeAgentApp();

    const res = await authHeaders(request(app).get('/api/agent/v1/sessions?includeRecoverable=false'));

    expect(res.status).toBe(200);
    expect(res.body.activeSessions.map((session: any) => session.sessionId)).toEqual(['own-session']);
  });

  it('returns 404 for another tenant session report without invoking report recovery', async () => {
    const { app, recoverResultForSessionIfNeeded } = makeAgentApp();

    const res = await authHeaders(request(app).get('/api/agent/v1/other-session/report'));

    expect(res.status).toBe(404);
    expect(recoverResultForSessionIfNeeded).not.toHaveBeenCalled();
  });
});
