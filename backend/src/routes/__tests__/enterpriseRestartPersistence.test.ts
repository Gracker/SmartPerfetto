// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { EnhancedSessionContext, sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV,
  ENTERPRISE_MIGRATION_PHASE_ENV,
} from '../../services/enterpriseMigration';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import {
  failInterruptedAnalysisRunsOnStartup,
  getAnalysisRunLifecycle,
  persistAnalysisRunState,
  resetAnalysisRunStoreForTests,
} from '../../services/analysisRunStore';
import {
  ENTERPRISE_DATA_DIR_ENV,
  writeTraceMetadata,
} from '../../services/traceMetadataStore';
import agentRoutes from '../agentRoutes';
import reportRoutes, { persistReport, reportStore } from '../reportRoutes';
import traceRoutes from '../simpleTraceRoutes';
import {NO_PRIVATE_CONTEXT} from '../../services/security/analysisPrivateContext';
import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  migrationPhase: process.env[ENTERPRISE_MIGRATION_PHASE_ENV],
  cutoverConfirmed: process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  enterpriseDataDir: process.env[ENTERPRISE_DATA_DIR_ENV],
  uploadDir: process.env.UPLOAD_DIR,
  apiKey: process.env.SMARTPERFETTO_API_KEY,
};

const TENANT_ID = 'tenant-a';
const WORKSPACE_ID = 'workspace-a';
const USER_ID = 'user-a';
const TRACE_ID = 'trace-restart-a';
const SESSION_ID = 'session-restart-a';
const RUN_ID = 'run-restart-a';
const INTERRUPTED_SESSION_ID = 'session-restart-interrupted';
const INTERRUPTED_RUN_ID = 'run-restart-interrupted';
const REPORT_ID = 'report-restart-a';
const GENERATED_AT = 1_700_000_000_000;

let tmpDir: string;
let dbPath: string;
let dataDir: string;
let uploadDir: string;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/traces', traceRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/agent/v1', agentRoutes);
  return loopbackServers.listen(app);
}

function ssoHeaders(req: request.Test, workspaceId = WORKSPACE_ID): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', USER_ID)
    .set('X-SmartPerfetto-SSO-Email', `${USER_ID}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', TENANT_ID)
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'workspace_admin')
    .set(
      'X-SmartPerfetto-SSO-Scopes',
      'trace:read,trace:write,trace:download,report:read,report:delete,agent:run',
    );
}

function readCount(table: 'trace_assets' | 'report_artifacts' | 'sessions' | 'analysis_runs'): number {
  const db = openEnterpriseDb(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

async function seedRestartState(): Promise<void> {
  const tracePath = path.join(dataDir, TENANT_ID, WORKSPACE_ID, 'traces', `${TRACE_ID}.trace`);
  await fs.mkdir(path.dirname(tracePath), { recursive: true });
  await fs.writeFile(tracePath, 'trace bytes', 'utf-8');

  await writeTraceMetadata({
    id: TRACE_ID,
    filename: 'restart.trace',
    size: Buffer.byteLength('trace bytes'),
    uploadedAt: new Date(GENERATED_AT).toISOString(),
    status: 'ready',
    path: tracePath,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
  });

  persistReport(REPORT_ID, {
    html: '<html><body>restart report</body></html>',
    generatedAt: GENERATED_AT,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    traceId: TRACE_ID,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    visibility: 'private',
    privateContext: NO_PRIVATE_CONTEXT,
  });

  const persistence = SessionPersistenceService.getInstance();
  persistence.saveSession({
    id: SESSION_ID,
    traceId: TRACE_ID,
    traceName: 'restart.trace',
    question: '分析 restart 后是否可恢复',
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT + 1000,
    messages: [],
    metadata: {
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    },
  });

  const context = new EnhancedSessionContext(SESSION_ID, TRACE_ID);
  context.addTurn('分析 restart 后是否可恢复', {
    primaryGoal: 'restart_persistence',
    aspects: ['session', 'report', 'trace'],
    expectedOutputType: 'diagnosis',
    complexity: 'moderate',
  });
  context.getEntityStore().upsertFrame({
    frame_id: 'frame-restart-a',
    jank_type: 'App Deadline Missed',
  });
  persistence.saveSessionContext(SESSION_ID, context);

  persistAnalysisRunState({
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: INTERRUPTED_SESSION_ID,
    runId: INTERRUPTED_RUN_ID,
    traceId: TRACE_ID,
    query: 'restart interrupted running run',
    mode: 'agent',
    privateContext: NO_PRIVATE_CONTEXT,
  }, 'running', { now: GENERATED_AT + 2000 });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-enterprise-restart-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  dataDir = path.join(tmpDir, 'data');
  uploadDir = path.join(tmpDir, 'uploads');

  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = 'cutover';
  process.env[ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV] = 'true';
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  process.env[ENTERPRISE_DATA_DIR_ENV] = dataDir;
  process.env.UPLOAD_DIR = uploadDir;
  delete process.env.SMARTPERFETTO_API_KEY;

  SessionPersistenceService.resetForTests();
  resetAnalysisRunStoreForTests();
  reportStore.clear();
  sessionContextManager.remove(SESSION_ID);
});

afterEach(async () => {
  await loopbackServers.close();
  SessionPersistenceService.resetForTests();
  resetAnalysisRunStoreForTests();
  reportStore.clear();
  sessionContextManager.remove(SESSION_ID);
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue(ENTERPRISE_MIGRATION_PHASE_ENV, originalEnv.migrationPhase);
  restoreEnvValue(ENTERPRISE_MIGRATION_CUTOVER_CONFIRMED_ENV, originalEnv.cutoverConfirmed);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue(ENTERPRISE_DATA_DIR_ENV, originalEnv.enterpriseDataDir);
  restoreEnvValue('UPLOAD_DIR', originalEnv.uploadDir);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enterprise restart persistence', () => {
  it('recovers session, report, and trace metadata from durable storage after in-memory state is lost', async () => {
    await seedRestartState();
    expect(readCount('trace_assets')).toBe(1);
    expect(readCount('report_artifacts')).toBe(1);
    expect(readCount('sessions')).toBe(1);
    expect(readCount('analysis_runs')).toBe(2);

    reportStore.clear();
    sessionContextManager.remove(SESSION_ID);
    SessionPersistenceService.resetForTests();
    resetAnalysisRunStoreForTests();
    const recoveredRuns = failInterruptedAnalysisRunsOnStartup({
      now: GENERATED_AT + 3000,
      error: 'backend restart during active analysis',
    });

    const app = await makeApp();

    const tracesRes = await ssoHeaders(request(app).get('/api/traces'));
    expect(tracesRes.status).toBe(200);
    expect(tracesRes.body.traces).toHaveLength(1);
    expect(tracesRes.body.traces[0]).toEqual(expect.objectContaining({
      id: TRACE_ID,
      filename: 'restart.trace',
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      status: 'ready',
    }));

    const reportRes = await ssoHeaders(request(app).get(`/api/reports/${REPORT_ID}`));
    expect(reportRes.status).toBe(200);
    expect(reportRes.text).toContain('restart report');

    const sessionsRes = await ssoHeaders(
      request(app).get('/api/agent/v1/sessions?includeRecoverable=true'),
    );
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.recoverableSessions).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        status: 'recoverable',
        traceId: TRACE_ID,
        turnCount: 1,
      }),
    ]);

    const turnsRes = await ssoHeaders(
      request(app).get(`/api/agent/v1/${SESSION_ID}/turns?order=asc`),
    );
    expect(turnsRes.status).toBe(200);
    expect(turnsRes.body).toEqual(expect.objectContaining({
      success: true,
      sessionId: SESSION_ID,
      traceId: TRACE_ID,
      source: 'persistence',
      totalTurns: 1,
    }));
    expect(turnsRes.body.turns[0]).toEqual(expect.objectContaining({
      query: '分析 restart 后是否可恢复',
    }));

    expect(recoveredRuns).toEqual([
      expect.objectContaining({
        id: INTERRUPTED_RUN_ID,
        previousStatus: 'running',
      }),
    ]);
    expect(getAnalysisRunLifecycle({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    }, INTERRUPTED_RUN_ID)).toEqual(expect.objectContaining({
      status: 'failed',
      completedAt: GENERATED_AT + 3000,
    }));
    expect(getAnalysisRunLifecycle({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    }, RUN_ID)).toEqual(expect.objectContaining({
      status: 'completed',
      completedAt: GENERATED_AT,
    }));
  });
});
