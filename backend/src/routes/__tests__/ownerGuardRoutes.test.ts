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
import reportRoutes, { persistReport, reportStore } from '../reportRoutes';
import traceRoutes from '../simpleTraceRoutes';
import {
  clearCodeAwareOutputGuards,
  registerCodeAwareCanary,
  registerPrivateAnalysisQueryForEcho,
} from '../../services/security/codeAwareOutputRegistry';

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalUploadDir = process.env.UPLOAD_DIR;
const originalSsoTrustedHeaders = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
const API_KEY = 'owner-test-secret';
const API_USER_ID = `api-key-${crypto.createHash('sha256').update(API_KEY).digest('hex').slice(0, 8)}`;

let uploadDir: string;

function authHeaders(req: request.Test, tenantId = 'tenant-a', workspaceId = 'workspace-a'): request.Test {
  return req
    .set('Authorization', `Bearer ${API_KEY}`)
    .set('x-tenant-id', tenantId)
    .set('x-workspace-id', workspaceId);
}

function ssoHeaders(
  req: request.Test,
  userId: string,
  role: string,
  scopes = 'trace:read,report:read',
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', role)
    .set('X-SmartPerfetto-SSO-Scopes', scopes);
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
  if (originalSsoTrustedHeaders === undefined) {
    delete process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  } else {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = originalSsoTrustedHeaders;
  }
  await fs.rm(uploadDir, { recursive: true, force: true });
});

describe('owner guard for trace and report routes', () => {
  it('paginates trace metadata with an opaque stable cursor and rejects invalid page input', async () => {
    await Promise.all([
      writeTraceMetadata('trace-a'),
      writeTraceMetadata('trace-b'),
      writeTraceMetadata('trace-c'),
    ]);
    const app = makeResourceApp();

    const firstPage = await authHeaders(request(app).get('/api/traces?limit=2'));
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.traces).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await authHeaders(
      request(app).get(`/api/traces?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`),
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.traces).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeUndefined();
    expect(new Set([
      ...firstPage.body.traces.map((trace: any) => trace.id),
      ...secondPage.body.traces.map((trace: any) => trace.id),
    ])).toEqual(new Set(['trace-a', 'trace-b', 'trace-c']));

    const invalidCursor = await authHeaders(request(app).get('/api/traces?cursor=not-a-cursor'));
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.code).toBe('INVALID_TRACE_LIST_PAGE');

    const invalidLimit = await authHeaders(request(app).get('/api/traces?limit=201'));
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimit.body.code).toBe('INVALID_TRACE_LIST_PAGE');
  });

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

  it('hides global trace cleanup from non-privileged analyst requests', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const app = makeResourceApp();

    const res = await ssoHeaders(
      request(app).post('/api/traces/cleanup'),
      'analyst-user',
      'analyst',
    );

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('allows viewer to read same-workspace traces but blocks trace writes and deletes', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    await writeTraceMetadata('peer-trace', {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'peer-user',
    });
    await writeTraceMetadata('viewer-trace', {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'viewer-user',
    });
    const app = makeResourceApp();

    const readRes = await ssoHeaders(request(app).get('/api/traces/peer-trace'), 'viewer-user', 'viewer');
    expect(readRes.status).toBe(200);
    expect(readRes.body.trace.id).toBe('peer-trace');

    const writeRes = await ssoHeaders(
      request(app).post('/api/traces/register-rpc').send({ port: 12345, traceName: 'Viewer RPC' }),
      'viewer-user',
      'viewer',
    );
    expect(writeRes.status).toBe(403);

    const deleteRes = await ssoHeaders(request(app).delete('/api/traces/viewer-trace'), 'viewer-user', 'viewer');
    expect(deleteRes.status).toBe(403);
  });

  it('allows workspace admin to delete another user trace in the same workspace', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    await writeTraceMetadata('peer-owned-trace', {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'peer-user',
    });
    const app = makeResourceApp();

    const deleteRes = await ssoHeaders(
      request(app).delete('/api/traces/peer-owned-trace'),
      'admin-user',
      'workspace_admin',
      'trace:read,trace:write,trace:delete:any',
    );
    expect(deleteRes.status).toBe(200);
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

  it('rejects decoded path separators for report reads and exports', async () => {
    const escapedId = '../../frontend/index';
    reportStore.set(escapedId, {
      html: '<html><body>must not escape</body></html>',
      generatedAt: Date.now(),
      sessionId: 'unsafe-session',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: API_USER_ID,
    });
    const app = makeResourceApp();

    const readRes = await authHeaders(
      request(app).get('/api/reports/..%2f..%2ffrontend%2findex'),
    );
    expect(readRes.status).toBe(404);
    expect(readRes.text).not.toContain('must not escape');

    const exportRes = await authHeaders(
      request(app).get('/api/reports/..%2f..%2ffrontend%2findex/export'),
    );
    expect(exportRes.status).toBe(404);
    expect(exportRes.text).not.toContain('must not escape');
  });

  it('rejects unsafe report IDs before caching or persistence', () => {
    expect(() =>
      persistReport('../escaped-report', {
        html: '<html><body>must not persist</body></html>',
        generatedAt: Date.now(),
        sessionId: 'unsafe-session',
      }),
    ).toThrow('Unsafe report id');
    expect(reportStore.has('../escaped-report')).toBe(false);
  });

  it('returns 404 for same-workspace reports when caller lacks report read permission', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    reportStore.set('report-no-read', {
      html: '<html><body>restricted report</body></html>',
      generatedAt: Date.now(),
      sessionId: 'restricted-session',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'report-owner',
    });
    const app = makeResourceApp();

    const exportRes = await ssoHeaders(
      request(app).get('/api/reports/report-no-read/export'),
      'report-analyst',
      'trace_only_custom_role',
      'trace:read',
    );

    expect(exportRes.status).toBe(404);
    expect(exportRes.body.error).toBe('Report not found');
  });

  it('allows workspace admin to delete another user report in the same workspace', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    reportStore.set('peer-report', {
      html: '<html><body>peer report</body></html>',
      generatedAt: Date.now(),
      sessionId: 'peer-session',
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'peer-user',
    });
    const app = makeResourceApp();

    const deleteRes = await ssoHeaders(
      request(app).delete('/api/reports/peer-report'),
      'admin-user',
      'workspace_admin',
      'report:read,report:delete',
    );
    expect(deleteRes.status).toBe(200);
    expect(reportStore.has('peer-report')).toBe(false);
  });
});

describe('owner guard for agent session routes', () => {
  function makeAgentApp() {
    const router = express.Router();
    const recoverResultForSessionIfNeeded = jest.fn((sessionId: string) => sessionId === 'private-session'
      ? {
          success: true,
          conclusion: 'safe conclusion PRIVATE_REPORT_CANARY',
          findings: [{id: 'finding', title: 'PRIVATE_FINDING_CANARY'}],
          hypotheses: [{id: 'hypothesis', description: 'PRIVATE_HYPOTHESIS_CANARY'}],
          confidence: 0.9,
          totalDurationMs: 123,
          rounds: 1,
          partial: true,
          terminationReason: 'execution_error',
          terminationMessage: 'PRIVATE_TERMINATION_CANARY',
          claimSupport: [{claimId: 'PRIVATE_CLAIM_CANARY', kind: 'numeric', text: 'PRIVATE_CLAIM_CANARY',
            anchors: [], supportLevel: 'partial'}],
          claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'not_checked', policy: 'record_only',
            passed: false, checkedClaimCount: 0, unsupportedClaimCount: 0, issues: [], claimResults: [{
              claimId: 'PRIVATE_CLAIM_CANARY', status: 'not_checked', referenceCells: [],
              deterministicProof: {kind: 'none', status: 'not_checked', reason: 'PRIVATE_VERIFY_CANARY', anchorIds: [], evidenceRefIds: []},
              propositionCoverage: {status: 'none', covered: [], uncovered: [], reason: 'PRIVATE_VERIFY_CANARY'},
            }]},
          identityResolutions: [{version: 'identity_contract@1', identityRefId: 'PRIVATE_IDENTITY_CANARY',
            target: {traceId: 'private-trace', source: 'derived'}, status: 'weak', processes: [], threads: [], warnings: []}],
        }
      : {
          success: true,
          conclusion: 'done',
          findings: [],
          hypotheses: [],
          confidence: 0.9,
          totalDurationMs: 123,
          rounds: 1,
        });
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
        queryHistory: [{query: 'PRIVATE_QUERY_HISTORY_CANARY'}],
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
      ['private-session', {
        sessionId: 'private-session',
        status: 'completed',
        traceId: 'private-trace',
        query: 'PRIVATE_QUERY_CANARY PRIVATE_REPORT_CANARY',
        createdAt: 3000,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: API_USER_ID,
        codeAwareMode: 'provider_send',
        codebaseIds: ['cb-private'],
        outputLanguage: 'en',
        scenes: [],
        conversationSteps: [{text: 'PRIVATE_TIMELINE_CANARY'}],
        queryHistory: [],
        conclusionHistory: [{conclusion: 'PRIVATE_HISTORY_CANARY'}],
        hypotheses: [],
        orchestrator: {
          getSessionNotes: () => ['PRIVATE_NOTE_CANARY'],
          getSessionPlan: () => ({text: 'PRIVATE_PLAN_CANARY'}),
          getSessionUncertaintyFlags: () => ['PRIVATE_FLAG_CANARY'],
        },
        logger: {getLogFilePath: () => '/tmp/PRIVATE_LOG_CANARY.log'},
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
      buildClientFindings: (findings) => findings,
      buildSessionResultContract: () => ({value: 'PRIVATE_RESULT_CONTRACT_CANARY'}),
      getCompletedPayload: (session) => session.sessionId === 'private-session' ? {
        qualityArtifacts: {
          claimSupport: [{claimId: 'PRIVATE_PAYLOAD_CLAIM_CANARY'}],
          claimVerificationResult: {status: 'PRIVATE_PAYLOAD_VERIFY_CANARY'},
          identityResolutions: [{identityRefId: 'PRIVATE_PAYLOAD_IDENTITY_CANARY'}],
        },
      } : undefined,
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
    expect(res.body.activeSessions.map((session: any) => session.sessionId).sort()).toEqual([
      'own-session',
      'private-session',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_QUERY_CANARY');
    expect(res.body.activeSessions.find((session: any) =>
      session.sessionId === 'private-session').query).toBe(
      'Private source or knowledge analysis request (original content not persisted)',
    );
  });

  it('returns 404 for another tenant session report without invoking report recovery', async () => {
    const { app, recoverResultForSessionIfNeeded } = makeAgentApp();

    const res = await authHeaders(request(app).get('/api/agent/v1/other-session/report'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Session not found' });
    const missingRes = await authHeaders(request(app).get('/api/agent/v1/missing-session/report'));
    expect(missingRes.status).toBe(404);
    expect(missingRes.body).toEqual({ success: false, error: 'Session not found' });
    expect(recoverResultForSessionIfNeeded).not.toHaveBeenCalled();
  });

  it('retains owner report commentary and history while filtering protected values and raw state', async () => {
    const {app} = makeAgentApp();
    registerPrivateAnalysisQueryForEcho(
      'private-session',
      'PRIVATE_QUERY_CANARY PRIVATE_REPORT_CANARY',
    );
    const protectedCanaries = [
      'PRIVATE_FINDING_CANARY',
      'PRIVATE_HYPOTHESIS_CANARY',
      'PRIVATE_CLAIM_CANARY',
      'PRIVATE_VERIFY_CANARY',
      'PRIVATE_IDENTITY_CANARY',
      'PRIVATE_PAYLOAD_CLAIM_CANARY',
      'PRIVATE_PAYLOAD_VERIFY_CANARY',
      'PRIVATE_PAYLOAD_IDENTITY_CANARY',
      'PRIVATE_RESULT_CONTRACT_CANARY',
      'PRIVATE_TERMINATION_CANARY',
    ];
    protectedCanaries.forEach(canary => registerCodeAwareCanary('private-session', canary));

    try {
      const res = await authHeaders(request(app).get('/api/agent/v1/private-session/report'));

      expect(res.status).toBe(200);
      expect(res.body.report).toEqual(expect.objectContaining({
        findings: [expect.objectContaining({id: 'finding'})],
        hypotheses: [expect.objectContaining({id: 'hypothesis'})],
        claimSupport: [expect.objectContaining({claimId: '[REDACTED_CODE_ECHO]', supportLevel: 'partial'})],
        claimVerificationResult: expect.objectContaining({schemaVersion: 'claim_verifier@2', status: 'not_checked',
          passed: false, claimResults: [expect.objectContaining({claimId: '[REDACTED_CODE_ECHO]', status: 'not_checked'})]}),
        identityResolutions: [expect.objectContaining({version: 'identity_contract@1',
          identityRefId: '[REDACTED_CODE_ECHO]', status: 'weak'})],
        resultContract: expect.any(Object),
        conversationTimeline: [{text: 'PRIVATE_TIMELINE_CANARY'}],
        conclusionHistory: [{conclusion: 'PRIVATE_HISTORY_CANARY'}],
        analysisNotes: [],
        analysisPlan: null,
        uncertaintyFlags: [],
      }));
      expect(res.body.report.logFile).toBeUndefined();
      expect(res.body.report.query).toBe(
        'Private source or knowledge analysis request (original content not persisted)',
      );
      expect(res.body.report.summary.terminationMessage).toBe(
        '[REDACTED_CODE_ECHO]',
      );
      expect(res.body.report.summary.terminationMessage).not.toContain('PRIVATE_TERMINATION_CANARY');
      expect(res.body.report.summary).toEqual(expect.objectContaining({
        conclusion: 'safe conclusion PRIVATE_REPORT_CANARY', partial: true, terminationReason: 'execution_error',
      }));
      // Ordinary source/query quotations are owner-visible; registered canaries
      // and raw prompt/runtime state remain protected independently.
      for (const canary of [...protectedCanaries, 'PRIVATE_QUERY_CANARY', 'PRIVATE_NOTE_CANARY',
        'PRIVATE_PLAN_CANARY', 'PRIVATE_FLAG_CANARY', 'PRIVATE_LOG_CANARY']) {
        expect(JSON.stringify(res.body)).not.toContain(canary);
      }
    } finally {
      clearCodeAwareOutputGuards('private-session');
    }
  });
});
