// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import {EventEmitter} from 'events';
import {attachFinalizationContext, takeFinalizationContext, type RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createDataEnvelope} from '../../types/dataContract';
import {ArtifactStore} from '../../agentv3/artifactStore';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import type {EvidenceReadView} from '../../services/evidence/evidenceReadView';
import * as finalization from '../../services/finalizeAnalysisResult';
import * as persistence from '../../services/persistAgentSession';
import * as agentEventStore from '../../services/agentEventStore';
import * as streamingProjection from '../../services/security/codeAwareStreamingUpdateProjection';
import {projectOwnerConclusion} from '../../services/security/privateAnalysisProjection';
import * as summary from '../../services/managedTraceSummary';
import * as comparison from '../../services/comparisonAppendixService';
import * as sourceSupplement from '../../services/codebase/analysisSourceSupplement';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import * as reports from '../reportRoutes';
import * as snapshots from '../../services/analysisResultSnapshotPipeline';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import { ClaudeRuntime } from '../../agentRuntime/engines/claude';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { resetAgentEventStoreForTests } from '../../services/agentEventStore';
import { resetAnalysisRunStoreForTests } from '../../services/analysisRunStore';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {AnalysisHistoryStore, resetAnalysisHistoryStoreForTests} from '../../services/analysisHistoryStore';
import { clearRunManifestLifecyclesForTests } from '../../services/selfEvolution/runManifestLifecycle';
import {
  getRunManifestStore,
  resetRunManifestStoreForTests,
} from '../../services/selfEvolution/runManifestStore';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import {
  getTraceProcessorLeaseStore,
  setTraceProcessorLeaseStoreForTests,
} from '../../services/traceProcessorLeaseStore';
import {
  TraceProcessorService,
  setTraceProcessorServiceForTests,
  type TraceProcessor,
} from '../../services/traceProcessorService';
import { ENTERPRISE_DATA_DIR_ENV, writeTraceMetadata } from '../../services/traceMetadataStore';
import agentRoutes, {agentRoutesCancellationTestSeam} from '../agentRoutes';
import {NO_PRIVATE_CONTEXT, resolveAnalysisPrivateContext} from '../../services/security/analysisPrivateContext';

const envKeys = [
  'SMARTPERFETTO_API_KEY',
  'SMARTPERFETTO_SSO_TRUSTED_HEADERS',
  ENTERPRISE_FEATURE_FLAG_ENV,
  ENTERPRISE_DB_PATH_ENV,
  ENTERPRISE_DATA_DIR_ENV,
  'UPLOAD_DIR',
  'SMARTPERFETTO_AGENT_RUNTIME',
  'SMARTPERFETTO_AI_ENABLED',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/agent/v1', agentRoutes);
  return app;
}

function analystHeaders(testRequest: request.Test): request.Test {
  return testRequest
    .set('X-SmartPerfetto-SSO-User-Id', 'analyst-user')
    .set('X-SmartPerfetto-SSO-Email', 'analyst@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read');
}

function readyProcessor(traceId: string): TraceProcessor {
  return {
    id: `processor-${traceId}`,
    traceId,
    status: 'ready',
    activeQueries: 0,
    query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    queryRaw: jest.fn(async () => Buffer.alloc(0)),
    destroy: jest.fn(),
  };
}

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  setTraceProcessorServiceForTests(null);
  setTraceProcessorLeaseStoreForTests(null);
  SessionPersistenceService.resetForTests();
  resetAgentEventStoreForTests();
  resetAnalysisRunStoreForTests();
  resetAnalysisHistoryStoreForTests();
  clearRunManifestLifecyclesForTests();
  resetRunManifestStoreForTests();
  restoreEnvironment();
});

describe('agent analyze cancellation races', () => {
  it.each([false, true])('persists local admitted parents and final history without enterprise journaling (rejectParents=%s)', async rejectParents => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-local-history-'));
    let sessionId: string | undefined;
    let db: ReturnType<typeof openEnterpriseDb> | undefined;
    try {
      const traceId = 'local-history-trace';
      const tracePath = path.join(tmpDir, 'local.trace');
      await fs.writeFile(tracePath, 'fixture trace');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';
      db = openEnterpriseDb();
      db.prepare(`INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
        VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', 100, 100)`).run();
      db.prepare(`INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
        VALUES ('analyst-user', 'tenant-a', 'real-profile@example.test', 'Real Analyst', 'idp-real', 100, 150)`).run();
      const expectedProfile = {email: 'real-profile@example.test', display_name: 'Real Analyst', idp_subject: 'idp-real', created_at: 100, updated_at: 150};
      if (rejectParents) db.exec(`CREATE TRIGGER reject_local_parent BEFORE INSERT ON analysis_runs
        BEGIN SELECT RAISE(ABORT, 'test parent write rejected'); END`);
      const service = new TraceProcessorService(process.env.UPLOAD_DIR);
      const trace = service.registerStoredTrace({id: traceId, filename: 'local.trace', size: 13, filePath: tracePath});
      await writeTraceMetadata({id: traceId, filename: trace.filename, size: trace.size,
        uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath,
        tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'});
      const referenceTraceId = 'local-history-reference';
      const referencePath = path.join(tmpDir, 'reference.trace');
      await fs.writeFile(referencePath, 'reference fixture');
      const reference = service.registerStoredTrace({id: referenceTraceId, filename: 'reference.trace', size: 17, filePath: referencePath});
      await writeTraceMetadata({id: referenceTraceId, filename: reference.filename, size: reference.size,
        uploadedAt: new Date().toISOString(), status: 'ready', path: referencePath,
        tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'});
      jest.spyOn(service, 'getOrLoadTrace').mockImplementation(async id => id === referenceTraceId ? reference : trace);
      let failedTraceId: string | undefined;
      let failedRunId: string | undefined;
      jest.spyOn(service, 'ensureProcessorForLease').mockImplementation(async (id, leaseId, _mode, leaseScope) => {
        if (id === failedTraceId) {
          const lease = getTraceProcessorLeaseStore().getLeaseById(leaseScope!, leaseId)!;
          failedRunId = lease.holders[0].metadata?.runId as string | undefined;
          throw new Error('fixture lease preparation failed');
        }
        return readyProcessor(id);
      });
      jest.spyOn(service, 'runWithLeases').mockImplementation(async (_contexts, callback) => callback());
      jest.spyOn(service, 'cleanupLeaseProcessor').mockReturnValue(true);
      setTraceProcessorServiceForTests(service);
      const persist = jest.spyOn(persistence, 'persistAgentTurn');
      const analyze = jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (_query, id, _traceId, options) => {
        // This assertion runs inside the runtime, after authentic HTTP admission.
        const parent = db!.prepare(`SELECT s.created_by, s.trace_id, r.id FROM analysis_runs r
          JOIN analysis_sessions s ON s.id = r.session_id WHERE r.id = ?`).get(options!.runId!);
        if (rejectParents) expect(parent).toBeUndefined();
        else expect(parent).toEqual({created_by: 'analyst-user', trace_id: traceId, id: options!.runId});
        expect(db!.prepare('SELECT email, display_name, idp_subject, created_at, updated_at FROM users WHERE id = ?').get('analyst-user'))
          .toEqual(expectedProfile);
        const conclusion = 'Local history completion fixture';
        return {sessionId: id!, success: true, findings: [], hypotheses: [], conclusion, confidence: 1,
          rounds: 1, totalDurationMs: 1, completion: {schemaVersion: 1, runtimeKind: 'claude-agent-sdk',
            status: 'completed', runId: options!.runId!, attemptId: 'attempt-local', candidateRef: 'candidate-local',
            conclusionFingerprint: analysisDeliveryFingerprint(conclusion)}};
      });
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);
      jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
        input.owner.assertAuthorized(); input.context?.dispose(); return {result: input.result};
      });
      const app = makeApp();
      const response = await analystHeaders(request(app).post('/api/agent/v1/analyze')).send({traceId, referenceTraceId, query: 'Return the local fixture'});
      if (response.status !== 200) throw new Error(JSON.stringify(response.body));
      sessionId = response.body.sessionId;
      const runId = response.body.runId;
      let status: request.Response | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
        if (['completed', 'failed'].includes(status.body.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(analyze).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalled();
      const historyScope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user', sessionId: sessionId!, traceId, runId};
      const history = new AnalysisHistoryStore(db);
      if (rejectParents) {
        expect(status!.body).toMatchObject({status: 'failed', error: 'analysis_history_parent_not_authorized'});
        expect(history.list(historyScope)).toEqual([]);
      } else {
        expect(status!.body.status).toBe('completed');
        const turns = history.list(historyScope);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({answer: 'Local history completion fixture', completionStatus: 'completed'});
        for (const mismatch of [{userId: 'other'}, {workspaceId: 'other'}, {tenantId: 'other'}, {traceId: 'other'}, {runId: 'other'}]) {
          expect(() => history.append({...historyScope, ...mismatch}, {...turns[0], traceId: mismatch.traceId ?? traceId}))
            .toThrow('analysis_history_parent_not_authorized');
        }
        expect(db.prepare('SELECT email, display_name, idp_subject, created_at, updated_at FROM users WHERE id = ?').get('analyst-user'))
          .toEqual(expectedProfile);
        expect(db.prepare('SELECT DISTINCT event_type FROM agent_events WHERE run_id = ?').all(runId))
          .toEqual([{event_type: 'analysis_completed'}]);
        // The same session already has one admitted run. A later failed admission
        // must not inherit that readiness, and a following retry must still work.
        for (const failureSide of [traceId, referenceTraceId]) {
          failedTraceId = failureSide;
          failedRunId = undefined;
          const requestBody = {traceId, referenceTraceId, query: 'Retry local history fixture'};
          const before = analyze.mock.calls.length;
          const failed = await analystHeaders(request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`)).send(requestBody);
          if (failed.status !== 409) throw new Error(JSON.stringify(failed.body));
          expect(failed.body.error).toBe('fixture lease preparation failed');
          expect(failedRunId).toBeDefined();
          expect(db.prepare('SELECT id FROM analysis_runs WHERE id = ?').get(failedRunId!)).toBeUndefined();
          expect(analyze).toHaveBeenCalledTimes(before);
          expect(history.list(historyScope)).toHaveLength(before);
          failedTraceId = undefined;
          const retried = await analystHeaders(request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`)).send(requestBody);
          expect(retried.status).toBe(200);
          expect(retried.body.sessionId).toBe(sessionId);
          expect(retried.body.runId).not.toBe(failedRunId);
          for (let attempt = 0; attempt < 100; attempt++) {
            status = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
            if (['completed', 'failed'].includes(status.body.status)) break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(status!.body.status).toBe('completed');
          expect(history.list(historyScope)).toHaveLength(before + 1);
          expect(db.prepare('SELECT id FROM analysis_runs WHERE id = ?').get(retried.body.runId)).toBeDefined();
          expect(db.prepare('SELECT email, display_name, idp_subject, created_at, updated_at FROM users WHERE id = ?').get('analyst-user'))
            .toEqual(expectedProfile);
        }
      }
      expect(process.env[ENTERPRISE_FEATURE_FLAG_ENV]).toBe('false');
    } finally {
      if (sessionId) { agentRoutesCancellationTestSeam.deleteSession(sessionId); sessionContextManager.remove(sessionId); }
      getTraceProcessorLeaseStore().close(); setTraceProcessorLeaseStoreForTests(null);
      resetAnalysisHistoryStoreForTests(); resetAnalysisRunStoreForTests(); resetAgentEventStoreForTests();
      db?.close();
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it.each(['ordinary', 'smart'] as const)('uses a private run lease for personal %s analysis without enabling enterprise', async preset => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-personal-analysis-lease-'));
    let sessionId: string | undefined;
    try {
      const traceId = `personal-${preset}`;
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'synthetic fixture bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';
      const service = new TraceProcessorService(process.env.UPLOAD_DIR);
      const trace = service.registerStoredTrace({id: traceId, filename: `${traceId}.trace`, size: 23, filePath: tracePath});
      await writeTraceMetadata({id: traceId, filename: trace.filename, size: trace.size,
        uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath,
        tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'});
      jest.spyOn(service, 'getOrLoadTrace').mockResolvedValue(trace);
      jest.spyOn(service, 'getAnalysisRunProcessorPolicy').mockImplementation((_id, lease) => ({sourceKind: 'local_file',
        requiresIsolation: !lease?.leaseId, reason: lease?.leaseId ? 'trusted' : 'shared_tainted'}));
      const ensure = jest.spyOn(service, 'ensureProcessorForLease').mockImplementation(async (id, leaseId, mode, scope) => {
        expect(mode).toBe('isolated');
        expect(scope).toBeDefined();
        const lease = getTraceProcessorLeaseStore().getLeaseById(scope!, leaseId)!;
        expect(lease.holders[0].metadata?.analysisRunPrivate).toBe(true);
        return readyProcessor(id);
      });
      const group = jest.spyOn(service, 'runWithLeases').mockImplementation(async contexts => {
        expect(contexts).toEqual([expect.objectContaining({traceId, mode: 'isolated', leaseScope: expect.any(Object)})]);
        // Stop before either engine: this route test must never invoke a provider or native Trace.
        throw new Error('mocked run boundary reached');
      });
      const cleanup = jest.spyOn(service, 'cleanupLeaseProcessor').mockReturnValue(true);
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);
      setTraceProcessorServiceForTests(service);
      const response = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze')).send({
        traceId, query: 'Analyze this Trace', ...(preset === 'smart' ? {options: {preset: 'smart'}} : {}),
      });
      expect(response.status).toBe(200);
      sessionId = response.body.sessionId;
      expect(response.body.leaseId).toBeUndefined();
      for (let i = 0; i < 10 && cleanup.mock.calls.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(group).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(process.env[ENTERPRISE_FEATURE_FLAG_ENV]).toBe('false');
    } finally {
      if (sessionId) agentRoutesCancellationTestSeam.deleteSession(sessionId);
      getTraceProcessorLeaseStore().close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('cancels detached source enrichment without changing the completed primary run', async () => {
    const sessionId = 'session-source-enrichment-cancel';
    const runId = `${sessionId}:1`;
    const abortSession = jest.fn();
    const cleanupSession = jest.fn();
    const run = {
      runId,
      requestId: 'request-source-enrichment-cancel',
      sequence: 1,
      query: '完整审查源码',
      startedAt: Date.now(),
      completedAt: Date.now(),
      status: 'completed' as const,
      privateContext: NO_PRIVATE_CONTEXT,
    };
    const session = {
      sessionId,
      status: 'completed' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      traceId: 'trace-source-enrichment-cancel',
      query: run.query,
      sseClients: [],
      sseEventSeq: 0,
      sseEventBuffer: [],
      runSequence: 1,
      activeRun: run,
      lastRun: run,
      runRegistry: {[runId]: run},
      analysisSourceEnrichment: {
        runId,
        status: 'running' as const,
        startedAt: Date.now(),
      },
      orchestrator: {abortSession, cleanupSession},
      logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn()},
    } as any;
    agentRoutesCancellationTestSeam.setSession(sessionId, session);
    try {
      const result = await agentRoutesCancellationTestSeam.cancelSessionRun(
        sessionId,
        runId,
        'cancel source supplement',
      );

      expect(result).toMatchObject({
        outcome: 'source_enrichment_cancelled',
        runStatus: 'completed',
      });
      expect(session.status).toBe('completed');
      expect(run.status).toBe('completed');
      expect(session.analysisSourceEnrichment.status).toBe('cancelled');
      expect(abortSession).toHaveBeenCalledWith(
        `${sessionId}:${runId}:analysis-source-enrichment`,
      );
      expect(session.sseEventBuffer.map((event: any) => event.eventType)).toEqual([
        'analysis_source_enrichment_cancelled',
        'end',
      ]);
    } finally {
      agentRoutesCancellationTestSeam.deleteSession(sessionId);
    }
  });

  describe('deliver first, verify after', () => {
    beforeEach(() => agentRoutesCancellationTestSeam.setReviewStopWatchdogMs(25));
    afterEach(() => agentRoutesCancellationTestSeam.setReviewStopWatchdogMs(15_000));
    const selection = {codeAwareMode: 'off' as const};
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'};
    const liveSession = (sessionId: string, extra: Record<string, unknown> = {}) => {
      const runId = `${sessionId}:1`;
      // The marker admission fixes from the session's selection.
      const run = {runId, requestId: `request-${sessionId}`, sequence: 1, query: 'trace 时长',
        startedAt: Date.now(), status: 'running' as const, privateContext: resolveAnalysisPrivateContext(extra)};
      const abortSession = jest.fn();
      const session = {sessionId, status: 'running' as const, createdAt: Date.now(), lastActivityAt: Date.now(),
        traceId: `trace-${sessionId}`, query: run.query, sseClients: [], sseEventSeq: 0, sseEventBuffer: [],
        runSequence: 1, activeRun: run, lastRun: run, runRegistry: {[runId]: run},
        tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId,
        orchestrator: {abortSession, cleanupSession: jest.fn()},
        logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn()}, ...extra} as any;
      agentRoutesCancellationTestSeam.setSession(sessionId, session);
      const finalizationRun = agentRoutesCancellationTestSeam.createHttpFinalizationRun(session, runId, selection,
        scope, contextAuthorization.buildAnalysisContextAuthorizationFingerprint(selection, scope));
      return {session, runId, run, finalizationRun, abortSession};
    };

    it('broadcasts the provisional answer and then stops only the review on cancel', async () => {
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      const persist = jest.spyOn(agentEventStore, 'persistSerializedAgentEvent').mockImplementation(() => undefined as never);
      const {session, runId, run, finalizationRun, abortSession} = liveSession('session-provisional-review-stop');
      try {
        agentRoutesCancellationTestSeam.broadcastAnswer(session, 'Trace 时长为 12.3 秒。', finalizationRun, 'zh-CN', {provisional: true});
        expect(finalizationRun.stop.provisionalDelivered).toBe(true);
        const conclusion = session.sseEventBuffer.find((event: any) => event.eventType === 'conclusion');
        expect(JSON.parse(conclusion.eventData)).toMatchObject({type: 'conclusion', runId,
          data: {conclusion: 'Trace 时长为 12.3 秒。', provisional: true, verification: 'pending'}});
        expect(persist.mock.calls.map(call => (call[1] as {eventType: string}).eventType)).toContain('conclusion');

        const result = await agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
        expect(result).toMatchObject({outcome: 'review_stop_requested', runStatus: 'running'});
        expect(finalizationRun.stop.signal.aborted).toBe(true);
        // The run is not cancelled: it keeps ownership, finalizes and persists its verdict.
        expect(finalizationRun.controller.signal.aborted).toBe(false);
        expect(finalizationRun.owner.isCurrent()).toBe(true);
        expect(session.status).toBe('running');
        expect(run.status).toBe('running');
        expect(session.cancellationInFlightRunId).toBeUndefined();
        expect(abortSession).not.toHaveBeenCalled();
        expect(session.sseEventBuffer.map((event: any) => event.eventType)).not.toContain('analysis_cancelled');
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it('wires the provisional answer and a review-only stop through analyze, cancel and persisted history', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-provisional-http-'));
      let sessionId: string | undefined;
      let db: ReturnType<typeof openEnterpriseDb> | undefined;
      try {
        const traceId = 'provisional-http-trace';
        const tracePath = path.join(tmpDir, 'provisional.trace');
        await fs.writeFile(tracePath, 'fixture trace');
        delete process.env.SMARTPERFETTO_API_KEY;
        process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
        process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
        process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
        process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
        process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
        process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
        process.env.SMARTPERFETTO_AI_ENABLED = 'true';
        db = openEnterpriseDb();
        db.prepare(`INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
          VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', 100, 100)`).run();
        db.prepare(`INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
          VALUES ('analyst-user', 'tenant-a', 'analyst@example.test', 'Analyst', 'idp-a', 100, 100)`).run();
        const service = new TraceProcessorService(process.env.UPLOAD_DIR);
        const trace = service.registerStoredTrace({id: traceId, filename: 'provisional.trace', size: 13, filePath: tracePath});
        await writeTraceMetadata({id: traceId, filename: trace.filename, size: trace.size,
          uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath,
          tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'});
        jest.spyOn(service, 'getOrLoadTrace').mockResolvedValue(trace);
        jest.spyOn(service, 'ensureProcessorForLease').mockImplementation(async id => readyProcessor(id));
        jest.spyOn(service, 'runWithLease').mockImplementation(async (_context, callback) => callback());
        jest.spyOn(service, 'runWithLeases').mockImplementation(async (_contexts, callback) => callback());
        jest.spyOn(service, 'cleanupLeaseProcessor').mockReturnValue(true);
        setTraceProcessorServiceForTests(service);
        const body = 'Trace duration is 12.3 s.';
        jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (_query, id, _traceId, options) => ({
          sessionId: id!, success: true, findings: [], hypotheses: [], conclusion: body, confidence: 1,
          rounds: 1, totalDurationMs: 1, completion: {schemaVersion: 1, runtimeKind: 'claude-agent-sdk',
            status: 'completed', runId: options!.runId!, attemptId: 'attempt', candidateRef: 'candidate',
            conclusionFingerprint: analysisDeliveryFingerprint(body)}}));
        jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);
        let provisionalSent!: () => void;
        const provisional = new Promise<void>(resolve => {provisionalSent = resolve;});
        const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
          input.owner.assertAuthorized();
          input.onProvisionalAnswer?.({conclusion: input.result.conclusion});
          provisionalSent();
          const stop = input.reviewStopSignal!;
          await new Promise(resolve => stop.aborted ? resolve(undefined) : stop.addEventListener('abort', resolve, {once: true}));
          input.owner.signal.throwIfAborted();
          input.context?.dispose();
          return {result: {...input.result, claimVerificationResult: {schemaVersion: 'claim_verifier@2', policy: 'record_only',
            status: 'not_checked', passed: false, checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [],
            issues: [], notCheckedReason: 'cancelled_by_user'}}};
        });
        const app = makeApp();
        const response = await analystHeaders(request(app).post('/api/agent/v1/analyze')).send({traceId, query: 'trace 时长'});
        if (response.status !== 200) throw new Error(JSON.stringify(response.body));
        sessionId = response.body.sessionId;
        const runId = response.body.runId;
        await provisional;
        expect(finalize.mock.calls[0][0]).toEqual(expect.objectContaining({reviewStopSignal: expect.any(Object),
          onProvisionalAnswer: expect.any(Function)}));
        const stopped = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({runId});
        expect(stopped.status).toBe(200);
        expect(stopped.body).toMatchObject({success: true, runId, status: 'review_stop_requested', runStatus: 'running'});
        let status: request.Response | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          status = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
          if (['completed', 'failed', 'cancelled'].includes(status.body.status)) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(status!.body.status).toBe('completed');
        const turns = new AnalysisHistoryStore(db).list({tenantId: 'tenant-a', workspaceId: 'workspace-a',
          userId: 'analyst-user', sessionId: sessionId!, traceId, runId});
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({answer: body});
      } finally {
        if (sessionId) { agentRoutesCancellationTestSeam.deleteSession(sessionId); sessionContextManager.remove(sessionId); }
        getTraceProcessorLeaseStore().close(); setTraceProcessorLeaseStoreForTests(null);
        resetAnalysisHistoryStoreForTests(); resetAnalysisRunStoreForTests(); resetAgentEventStoreForTests();
        db?.close();
        await fs.rm(tmpDir, {recursive: true, force: true});
      }
    });

    it('keeps the read body as an unverified partial turn when a force stop outlives the watchdog', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-provisional-fallback-http-'));
      let sessionId: string | undefined;
      let db: ReturnType<typeof openEnterpriseDb> | undefined;
      try {
        const traceId = 'provisional-http-trace';
        const tracePath = path.join(tmpDir, 'provisional.trace');
        await fs.writeFile(tracePath, 'fixture trace');
        delete process.env.SMARTPERFETTO_API_KEY;
        process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
        process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
        process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
        process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
        process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
        process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
        process.env.SMARTPERFETTO_AI_ENABLED = 'true';
        db = openEnterpriseDb();
        db.prepare(`INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
          VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', 100, 100)`).run();
        db.prepare(`INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
          VALUES ('analyst-user', 'tenant-a', 'analyst@example.test', 'Analyst', 'idp-a', 100, 100)`).run();
        const service = new TraceProcessorService(process.env.UPLOAD_DIR);
        const trace = service.registerStoredTrace({id: traceId, filename: 'provisional.trace', size: 13, filePath: tracePath});
        await writeTraceMetadata({id: traceId, filename: trace.filename, size: trace.size,
          uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath,
          tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'});
        jest.spyOn(service, 'getOrLoadTrace').mockResolvedValue(trace);
        jest.spyOn(service, 'ensureProcessorForLease').mockImplementation(async id => readyProcessor(id));
        jest.spyOn(service, 'runWithLease').mockImplementation(async (_context, callback) => callback());
        jest.spyOn(service, 'runWithLeases').mockImplementation(async (_contexts, callback) => callback());
        jest.spyOn(service, 'cleanupLeaseProcessor').mockReturnValue(true);
        setTraceProcessorServiceForTests(service);
        const body = 'Trace duration is 12.3 s.';
        jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (_query, id, _traceId, options) => ({
          sessionId: id!, success: true, findings: [], hypotheses: [], conclusion: body, confidence: 1,
          rounds: 1, totalDurationMs: 1, completion: {schemaVersion: 1, runtimeKind: 'claude-agent-sdk',
            status: 'completed', runId: options!.runId!, attemptId: 'attempt', candidateRef: 'candidate',
            conclusionFingerprint: analysisDeliveryFingerprint(body)}}));
        jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);
        let provisionalSent!: () => void;
        const provisional = new Promise<void>(resolve => {provisionalSent = resolve;});
        const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
          input.owner.assertAuthorized();
          input.onProvisionalAnswer?.({conclusion: input.result.conclusion});
          provisionalSent();
          // A finalization that ignores the review stop and never settles on its own.
          const owner = input.owner.signal;
          await new Promise(resolve => owner.aborted ? resolve(undefined) : owner.addEventListener('abort', resolve, {once: true}));
          input.context?.dispose();
          throw owner.reason;
        });
        const app = makeApp();
        const response = await analystHeaders(request(app).post('/api/agent/v1/analyze')).send({traceId, query: 'trace 时长'});
        if (response.status !== 200) throw new Error(JSON.stringify(response.body));
        sessionId = response.body.sessionId;
        const runId = response.body.runId;
        await provisional;
        expect(finalize.mock.calls[0][0]).toEqual(expect.objectContaining({reviewStopSignal: expect.any(Object),
          onProvisionalAnswer: expect.any(Function)}));
        const stopped = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({runId});
        expect(stopped.body).toMatchObject({success: true, runId, status: 'review_stop_requested', runStatus: 'running'});
        const forced = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({runId});
        expect(forced.status).toBe(200);
        expect(forced.body).toMatchObject({success: true, runId, status: 'completed', outcome: 'review_not_finished'});
        expect(finalize.mock.calls[0][0].owner.signal.aborted).toBe(true);
        let status: request.Response | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          status = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
          if (['completed', 'failed', 'cancelled'].includes(status.body.status)) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(status!.body.status).toBe('completed');
        const turns = new AnalysisHistoryStore(db).list({tenantId: 'tenant-a', workspaceId: 'workspace-a',
          userId: 'analyst-user', sessionId: sessionId!, traceId, runId});
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({answer: body, partial: true, completionStatus: 'incomplete',
          terminationReason: 'review_not_finished'});
        const events = (agentRoutesCancellationTestSeam.getSession(sessionId!) as any).sseEventBuffer as any[];
        const types = events.map(event => event.eventType);
        expect(types).toContain('analysis_completed');
        expect(types).not.toContain('analysis_cancelled');
        expect(types).not.toContain('error');
      } finally {
        if (sessionId) { agentRoutesCancellationTestSeam.deleteSession(sessionId); sessionContextManager.remove(sessionId); }
        getTraceProcessorLeaseStore().close(); setTraceProcessorLeaseStoreForTests(null);
        resetAnalysisHistoryStoreForTests(); resetAnalysisRunStoreForTests(); resetAgentEventStoreForTests();
        db?.close();
        await fs.rm(tmpDir, {recursive: true, force: true});
      }
    });

    it('broadcasts the final answer without a pending cue when no review was dispatched', () => {
      const {session, runId, finalizationRun} = liveSession('session-finalized-no-review');
      try {
        expect(agentRoutesCancellationTestSeam.broadcastAnswer(session, 'Trace 时长为 12.3 秒。',
          finalizationRun, 'zh-CN', {provisional: false})).toBe(true);
        const conclusion = session.sseEventBuffer.find((event: any) => event.eventType === 'conclusion');
        const data = JSON.parse(conclusion.eventData);
        expect(data).toMatchObject({type: 'conclusion', runId, data: {conclusion: 'Trace 时长为 12.3 秒。'}});
        expect(data.data).not.toHaveProperty('provisional');
        expect(data.data).not.toHaveProperty('verification');
        // Not a provisional answer: a stop is still the full cancel.
        expect(finalizationRun.stop.provisionalDelivered).toBe(false);
        expect(agentRoutesCancellationTestSeam.broadcastAnswer(session, '  ', finalizationRun, 'en', {provisional: false})).toBe(false);
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it('sends the final answer before report generation when finalization dispatched no review', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-no-review-http-'));
      let sessionId: string | undefined;
      let db: ReturnType<typeof openEnterpriseDb> | undefined;
      try {
        const traceId = 'no-review-http-trace';
        const tracePath = path.join(tmpDir, 'no-review.trace');
        await fs.writeFile(tracePath, 'fixture trace');
        delete process.env.SMARTPERFETTO_API_KEY;
        process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
        process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
        process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
        process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
        process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
        process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
        process.env.SMARTPERFETTO_AI_ENABLED = 'true';
        db = openEnterpriseDb();
        db.prepare(`INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
          VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', 100, 100)`).run();
        db.prepare(`INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
          VALUES ('analyst-user', 'tenant-a', 'analyst@example.test', 'Analyst', 'idp-a', 100, 100)`).run();
        const service = new TraceProcessorService(process.env.UPLOAD_DIR);
        const trace = service.registerStoredTrace({id: traceId, filename: 'no-review.trace', size: 13, filePath: tracePath});
        await writeTraceMetadata({id: traceId, filename: trace.filename, size: trace.size,
          uploadedAt: new Date().toISOString(), status: 'ready', path: tracePath,
          tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user'});
        jest.spyOn(service, 'getOrLoadTrace').mockResolvedValue(trace);
        jest.spyOn(service, 'ensureProcessorForLease').mockImplementation(async id => readyProcessor(id));
        jest.spyOn(service, 'runWithLease').mockImplementation(async (_context, callback) => callback());
        jest.spyOn(service, 'runWithLeases').mockImplementation(async (_contexts, callback) => callback());
        jest.spyOn(service, 'cleanupLeaseProcessor').mockReturnValue(true);
        setTraceProcessorServiceForTests(service);
        const body = 'Trace duration is 12.3 s.';
        jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (_query, id, _traceId, options) => ({
          sessionId: id!, success: true, findings: [], hypotheses: [], conclusion: body, confidence: 1,
          rounds: 1, totalDurationMs: 1, completion: {schemaVersion: 1, runtimeKind: 'claude-agent-sdk',
            status: 'completed', runId: options!.runId!, attemptId: 'attempt', candidateRef: 'candidate',
            conclusionFingerprint: analysisDeliveryFingerprint(body)}}));
        jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);
        const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
          input.context?.dispose();
          return {result: {...input.result, claimVerificationResult: {schemaVersion: 'claim_verifier@2', policy: 'record_only',
            status: 'partial', passed: false, checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [],
            issues: [], notCheckedReason: 'not_required'}}};
        });
        const app = makeApp();
        const response = await analystHeaders(request(app).post('/api/agent/v1/analyze')).send({traceId, query: 'trace 时长'});
        if (response.status !== 200) throw new Error(JSON.stringify(response.body));
        sessionId = response.body.sessionId;
        let status: request.Response | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          status = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
          if (['completed', 'failed', 'cancelled'].includes(status.body.status)) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(status!.body.status).toBe('completed');
        expect(finalize).toHaveBeenCalledTimes(1);
        const events = (agentRoutesCancellationTestSeam.getSession(sessionId!) as any).sseEventBuffer as any[];
        const types = events.map(event => event.eventType);
        expect(types).toContain('conclusion');
        expect(types.indexOf('conclusion')).toBeLessThan(types.indexOf('analysis_completed'));
        const conclusions = events.filter(event => event.eventType === 'conclusion').map(event => JSON.parse(event.eventData).data);
        expect(conclusions).toEqual([{conclusion: body}]);
        expect(events.some(event => event.eventType === 'progress' &&
          JSON.parse(event.eventData).data?.phase === 'final_review')).toBe(false);
      } finally {
        if (sessionId) { agentRoutesCancellationTestSeam.deleteSession(sessionId); sessionContextManager.remove(sessionId); }
        getTraceProcessorLeaseStore().close(); setTraceProcessorLeaseStoreForTests(null);
        resetAnalysisHistoryStoreForTests(); resetAnalysisRunStoreForTests(); resetAgentEventStoreForTests();
        db?.close();
        await fs.rm(tmpDir, {recursive: true, force: true});
      }
    });

    it('keeps the first stop review-only and lets a force stop fall back to a cancel without a fallback body', async () => {
        const {session, runId, finalizationRun, abortSession} = liveSession('session-provisional-force-stop');
        try {
          agentRoutesCancellationTestSeam.broadcastAnswer(session, 'body', finalizationRun, 'en', {provisional: true});
          // The first stop is review-only whatever the review's state (a finished
          // review keeps its verdict and the turn persists); only the next is a force stop.
          await expect(agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId))
            .resolves.toMatchObject({outcome: 'review_stop_requested'});
          expect(finalizationRun.controller.signal.aborted).toBe(false);
          // The force stop first waits (up to the watchdog) for the run to commit.
          const forced = await agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
          expect(forced).toMatchObject({outcome: 'cancelled', runStatus: 'cancelled'});
          expect(finalizationRun.controller.signal.aborted).toBe(true);
          expect(abortSession).toHaveBeenCalled();
          expect(session.sseEventBuffer.map((event: any) => event.eventType)).toEqual(
            ['conclusion', 'analysis_cancelled', 'end']);
        } finally {
          finalizationRun.release();
          agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
        }
      });

    it('lets a finalized commit that lands during a force stop win over the stop', async () => {
      agentRoutesCancellationTestSeam.setReviewStopWatchdogMs(5_000);
      const {session, runId, run, finalizationRun, abortSession} = liveSession('session-provisional-force-commit');
      try {
        agentRoutesCancellationTestSeam.broadcastAnswer(session, 'body', finalizationRun, 'en', {provisional: true});
        await agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
        const forced = agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
        // The review finished just before the save: the run claims and commits its turn.
        expect(finalizationRun.claimTerminal('finalized')).toBe(true);
        (run as {status: string}).status = 'completed';
        session.status = 'completed';
        finalizationRun.release();
        await expect(forced).resolves.toMatchObject({outcome: 'committed', runStatus: 'completed'});
        expect(finalizationRun.controller.signal.aborted).toBe(false);
        expect(abortSession).not.toHaveBeenCalled();
        expect(session.sseEventBuffer.map((event: any) => event.eventType)).not.toContain('analysis_cancelled');
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it('runs the fallback commit once when the watchdog elapses after a review-only stop', async () => {
      const {session, runId, run, finalizationRun, abortSession} = liveSession('session-provisional-watchdog');
      // Stands in for the executing run's commit (covered end to end over HTTP below).
      const commit = jest.fn(() => {
        if (!finalizationRun.claimTerminal('review_not_finished')) return false;
        (run as {status: string}).status = 'completed';
        session.status = 'completed';
        return true;
      });
      finalizationRun.commitReviewNotFinished = commit;
      try {
        agentRoutesCancellationTestSeam.broadcastAnswer(session, 'body', finalizationRun, 'en', {provisional: true});
        await agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(commit).toHaveBeenCalledTimes(1);
        expect(finalizationRun.terminal).toBe('review_not_finished');
        await expect(agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId))
          .resolves.toMatchObject({outcome: 'run_not_cancellable', runStatus: 'completed'});
        expect(abortSession).not.toHaveBeenCalled();
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it.each([
      ['private knowledge', {codeAwareMode: 'provider_send', codebaseIds: ['app-source']}, false],
      ['revoked authorization', {}, true],
    ] as const)('keeps the body live-only for %s: the watchdog becomes the full cancel', async (_label, extra, revoke) => {
      const {session, runId, finalizationRun, abortSession} = liveSession(`session-provisional-excluded-${revoke}`, extra);
      const commit = jest.fn(() => true);
      finalizationRun.commitReviewNotFinished = commit;
      try {
        agentRoutesCancellationTestSeam.broadcastAnswer(session, 'body', finalizationRun, 'en', {provisional: true});
        await agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
        if (revoke) {
          jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => {
            throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
          });
        }
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(commit).not.toHaveBeenCalled();
        expect(finalizationRun.controller.signal.aborted).toBe(true);
        expect(abortSession).toHaveBeenCalled();
        expect(session.status).toBe('cancelled');
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it('does not deliver a provisional answer for a deleted or superseded session', () => {
      const {session, finalizationRun} = liveSession('session-provisional-deleted');
      try {
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
        expect(agentRoutesCancellationTestSeam.broadcastAnswer(session, 'body', finalizationRun, 'en', {provisional: true})).toBe(false);
        expect(finalizationRun.stop.provisionalDelivered).toBe(false);
        expect(session.sseEventBuffer).toEqual([]);
      } finally {
        finalizationRun.release();
      }
    });

    it('keeps full cancellation before the provisional answer', async () => {
      const {session, runId, finalizationRun, abortSession} = liveSession('session-provisional-full-cancel');
      try {
        const result = await agentRoutesCancellationTestSeam.cancelSessionRun(session.sessionId, runId);
        expect(result).toMatchObject({outcome: 'cancelled', runStatus: 'cancelled'});
        expect(finalizationRun.controller.signal.aborted).toBe(true);
        expect(abortSession).toHaveBeenCalled();
        expect(session.sseEventBuffer.map((event: any) => event.eventType)).toEqual(['analysis_cancelled', 'end']);
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it('keeps a private provisional answer live-only and owner-projected', () => {
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      const persist = jest.spyOn(agentEventStore, 'persistSerializedAgentEvent').mockImplementation(() => undefined as never);
      const {session, finalizationRun} = liveSession('session-provisional-private',
        {codeAwareMode: 'provider_send', codebaseIds: ['app-source']});
      try {
        const body = 'The source marker explains the wait.';
        agentRoutesCancellationTestSeam.broadcastAnswer(session, body, finalizationRun, 'en', {provisional: true});
        const conclusion = session.sseEventBuffer.find((event: any) => event.eventType === 'conclusion');
        expect(JSON.parse(conclusion.eventData).data).toEqual({provisional: true, verification: 'pending',
          conclusion: projectOwnerConclusion({sessionId: session.sessionId, conclusion: body, success: true, language: 'en'})});
        expect(persist).not.toHaveBeenCalled();
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });

    it('ignores a provisional answer for a run that no longer owns the session', () => {
      const {session, finalizationRun} = liveSession('session-provisional-stale');
      try {
        session.activeRun = {...session.activeRun, runId: `${session.sessionId}:2`};
        agentRoutesCancellationTestSeam.broadcastAnswer(session, 'late body', finalizationRun, 'en', {provisional: true});
        expect(finalizationRun.stop.provisionalDelivered).toBe(false);
        expect(session.sseEventBuffer).toEqual([]);
      } finally {
        finalizationRun.release();
        agentRoutesCancellationTestSeam.deleteSession(session.sessionId);
      }
    });
  });

  it('persists terminal attribution when the runtime fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-runtime-failure-'));
    const app = makeApp();
    let sessionId: string | undefined;
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | undefined;
    try {
      const traceId = 'trace-runtime-failure';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';

      await writeTraceMetadata({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: tracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockResolvedValue(
        traceProcessorService.registerStoredTrace({id: traceId, filename: `${traceId}.trace`, size: 11, filePath: tracePath}));
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease')
        .mockResolvedValue(readyProcessor(traceId));
      jest.spyOn(traceProcessorService, 'runWithLease')
        .mockImplementation(async (_context, callback) => callback());
      setTraceProcessorServiceForTests(traceProcessorService);

      jest.spyOn(ClaudeRuntime.prototype, 'analyze')
        .mockRejectedValue(new Error('runtime failure canary'));
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession')
        .mockImplementation(() => undefined);

      const analyzeResponse = await analystHeaders(
        request(app).post('/api/agent/v1/analyze'),
      ).send({
        traceId,
        query: 'fail this analysis',
      });
      expect(analyzeResponse.status).toBe(200);
      sessionId = analyzeResponse.body.sessionId;
      const runId = analyzeResponse.body.runId;

      let statusResponse: request.Response | undefined;
      let manifest = getRunManifestStore().getByRunId(
        { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
        runId,
      );
      for (let attempt = 0; attempt < 50; attempt++) {
        statusResponse = await analystHeaders(
          request(app).get(`/api/agent/v1/${sessionId}/status`),
        );
        manifest = getRunManifestStore().getByRunId(
          { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
          runId,
        );
        if (statusResponse.body.status === 'failed' && manifest) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(statusResponse?.body).toEqual(expect.objectContaining({
        status: 'failed',
        error: 'runtime failure canary',
      }));
      expect(manifest).toEqual(expect.objectContaining({
        runId,
        turns: 0,
      }));
    } finally {
      if (sessionId) {
        await analystHeaders(request(app).delete(`/api/agent/v1/${sessionId}`));
        sessionContextManager.remove(sessionId);
      }
      leaseStore = getTraceProcessorLeaseStore();
      leaseStore.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it.each([false, true])('does not start the runtime when its run is cancelled while lease startup is pending (enterprise=%s)', async enterprise => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-lease-cancel-'));
    const app = makeApp();
    let sessionId: string | undefined;
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | undefined;
    let resolveLease: ((processor: TraceProcessor) => void) | undefined;
    let signalLeaseEntered: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    let signalAbortEntered: (() => void) | undefined;
    const leaseEntered = new Promise<void>((resolve) => {
      signalLeaseEntered = resolve;
    });
    const leaseReady = new Promise<TraceProcessor>((resolve) => {
      resolveLease = resolve;
    });
    const abortEntered = new Promise<void>((resolve) => {
      signalAbortEntered = resolve;
    });
    const abortReady = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });

    try {
      const traceId = 'trace-cancelled-during-lease-start';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = String(enterprise);
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';

      await writeTraceMetadata({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: tracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockResolvedValue(
        traceProcessorService.registerStoredTrace({id: traceId, filename: `${traceId}.trace`, size: 11, filePath: tracePath}));
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease').mockImplementation(() => {
        if (!signalLeaseEntered) throw new Error('lease entry signal is unavailable');
        signalLeaseEntered();
        return leaseReady;
      });
      const runWithLeaseSpy = jest
        .spyOn(traceProcessorService, 'runWithLease')
        .mockImplementation(async (_context, callback) => callback());
      setTraceProcessorServiceForTests(traceProcessorService);

      const runtimeResult: AnalysisResult = {
        sessionId: 'should-not-run',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'should not run',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      };
      const analyzeSpy = jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockResolvedValue(runtimeResult);
      const abortSpy = jest.spyOn(ClaudeRuntime.prototype, 'abortSession').mockImplementation(() => {
        signalAbortEntered?.();
        return abortReady;
      });
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);

      const analyzePromise = analystHeaders(request(app).post('/api/agent/v1/analyze'))
        .send({ traceId, query: 'analyze after lease startup' })
        .then((response) => response);
      await leaseEntered;

      const scope = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      };
      leaseStore = getTraceProcessorLeaseStore();
      const lease = leaseStore.listLeases(scope, { traceId })[0];
      const holder = lease?.holders[0];
      const metadataSessionId = holder?.metadata?.sessionId;
      const runId = holder?.holderRef;
      if (typeof metadataSessionId !== 'string') {
        throw new Error('agent lease did not expose its owning session');
      }
      if (typeof runId !== 'string') {
        throw new Error('agent lease did not expose its owning run');
      }
      sessionId = metadataSessionId;

      const missingRunResponse = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`));
      expect(missingRunResponse.status).toBe(400);
      expect(missingRunResponse.body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'RUN_ID_REQUIRED',
        }),
      );
      expect(abortSpy).not.toHaveBeenCalled();

      const unknownRunResponse = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({
        runId: 'run-does-not-exist',
      });
      expect(unknownRunResponse.status).toBe(404);
      expect(unknownRunResponse.body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'RUN_NOT_FOUND',
          runId: 'run-does-not-exist',
        }),
      );
      expect(abortSpy).not.toHaveBeenCalled();

      const cancelPromise = analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`))
        .send({ runId })
        .then((response) => response);
      await abortEntered;

      const nextRunDuringCancellation = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({ traceId, query: 'must wait until cancellation settles' });
      expect(nextRunDuringCancellation.status).toBe(409);
      expect(nextRunDuringCancellation.body).toEqual(
        expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId,
        }),
      );
      expect(analyzeSpy).not.toHaveBeenCalled();

      resolveAbort?.();
      const cancelResponse = await cancelPromise;
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          runId,
          outcome: 'cancelled',
        }),
      );
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(getRunManifestStore().getByRunId(
        { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
        runId,
      )).toEqual(expect.objectContaining({
        runId,
        turns: 0,
      }));

      const nextRunAfterAbortBeforeLease = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({ traceId, query: 'must still wait for lease startup to settle' });
      expect(nextRunAfterAbortBeforeLease.status).toBe(409);
      expect(nextRunAfterAbortBeforeLease.body).toEqual(
        expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId,
        }),
      );

      const repeatedCancelResponse = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({
        runId,
      });
      expect(repeatedCancelResponse.status).toBe(200);
      expect(repeatedCancelResponse.body).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          runId,
          outcome: 'already_cancelled',
        }),
      );
      expect(abortSpy).toHaveBeenCalledTimes(1);

      if (!resolveLease) throw new Error('lease resolver is unavailable');
      resolveLease(readyProcessor(traceId));

      const analyzeResponse = await analyzePromise;
      expect(analyzeResponse.status).toBe(200);
      expect(analyzeResponse.body.runId).toBe(runId);
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(runWithLeaseSpy).not.toHaveBeenCalled();
      if (!enterprise) {
        const db = openEnterpriseDb();
        try { expect(db.prepare('SELECT id FROM analysis_runs WHERE id = ?').get(runId)).toBeUndefined(); }
        finally { db.close(); }
      }

      const statusResponse = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe('cancelled');
      expect(statusResponse.body.observability).toEqual(
        expect.objectContaining({
          runId,
          status: 'cancelled',
        }),
      );
    } finally {
      resolveAbort?.();
      resolveLease?.(readyProcessor('cleanup-cancelled-during-lease-start'));
      await new Promise((resolve) => setImmediate(resolve));
      if (sessionId) {
        await analystHeaders(request(app).delete(`/api/agent/v1/${sessionId}`));
        sessionContextManager.remove(sessionId);
      }
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('does not project a runtime success that arrives after the exact run was cancelled (enterprise=%s)', async enterprise => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-late-success-'));
    const app = makeApp();
    let sessionId: string | undefined;
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | undefined;
    let resolveAnalysis: ((result: AnalysisResult) => void) | undefined;
    let signalAnalysisEntered: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    let signalAbortEntered: (() => void) | undefined;
    const analysisEntered = new Promise<void>((resolve) => {
      signalAnalysisEntered = resolve;
    });
    const pendingAnalysis = new Promise<AnalysisResult>((resolve) => {
      resolveAnalysis = resolve;
    });
    const abortEntered = new Promise<void>((resolve) => {
      signalAbortEntered = resolve;
    });
    const abortReady = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });

    try {
      const traceId = 'trace-late-runtime-success';
      const referenceTraceId = 'trace-late-runtime-success-reference';
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = String(enterprise);
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';

      for (const id of [traceId, referenceTraceId]) {
        const tracePath = path.join(tmpDir, `${id}.trace`);
        await fs.writeFile(tracePath, 'trace bytes');
        await writeTraceMetadata({
          id,
          filename: `${id}.trace`,
          size: 11,
          uploadedAt: new Date().toISOString(),
          status: 'ready',
          path: tracePath,
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        });
      }

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockImplementation(async id =>
        traceProcessorService.registerStoredTrace({id, filename: `${id}.trace`, size: 11, filePath: path.join(tmpDir, `${id}.trace`)}));
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease').mockImplementation(async (id) => readyProcessor(id));
      const runWithLeaseSpy = jest
        .spyOn(traceProcessorService, 'runWithLease')
        .mockImplementation(async (_context, callback) => callback());
      setTraceProcessorServiceForTests(traceProcessorService);

      const runtimeResult: AnalysisResult = {
        sessionId: 'late-runtime-success',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'must not be projected after cancellation',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      };
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async () => {
        signalAnalysisEntered?.();
        return pendingAnalysis;
      });
      const abortSpy = jest.spyOn(ClaudeRuntime.prototype, 'abortSession').mockImplementation(() => {
        signalAbortEntered?.();
        return abortReady;
      });
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);

      const analyzeResponse = await analystHeaders(request(app).post('/api/agent/v1/analyze')).send({
        traceId,
        referenceTraceId,
        query: 'resolve successfully after cancellation',
      });
      expect(analyzeResponse.status).toBe(200);
      sessionId = analyzeResponse.body.sessionId;
      const runId = analyzeResponse.body.runId;
      expect(typeof sessionId).toBe('string');
      expect(typeof runId).toBe('string');
      await analysisEntered;

      const cancelPromise = analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`))
        .send({ runId })
        .then(response => response);
      await abortEntered;
      expect(abortSpy).toHaveBeenCalledTimes(1);

      resolveAnalysis?.(runtimeResult);
      await pendingAnalysis;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const nextRunBeforeAbortSettles = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({
        traceId,
        referenceTraceId,
        query: 'must wait for cancellation cleanup to settle',
      });
      expect(nextRunBeforeAbortSettles.status).toBe(409);
      expect(nextRunBeforeAbortSettles.body).toEqual(
        expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId,
        }),
      );

      resolveAbort?.();
      const cancelResponse = await cancelPromise;
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          runId,
        }),
      );

      expect(runWithLeaseSpy).not.toHaveBeenCalled();
      const statusResponse = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe('cancelled');
      expect(statusResponse.body.result).toBeUndefined();
      expect(getRunManifestStore().getByRunId(
        {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
        runId,
      )).toEqual(expect.objectContaining({
        runId,
        turns: 0,
      }));

      const reportResponse = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/report`));
      expect(reportResponse.status).not.toBe(200);

      const nextRunAfterSettle = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({
        traceId,
        referenceTraceId,
        query: 'start after the cancelled runtime settled',
      });
      expect(nextRunAfterSettle.status).toBe(200);
      expect(nextRunAfterSettle.body.runId).not.toBe(runId);
    } finally {
      resolveAbort?.();
      resolveAnalysis?.({
        sessionId: 'cleanup-late-runtime-success',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'cleanup',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      });
      await new Promise((resolve) => setImmediate(resolve));
      if (sessionId) {
        await analystHeaders(request(app).delete(`/api/agent/v1/${sessionId}`));
        sessionContextManager.remove(sessionId);
      }
      leaseStore = getTraceProcessorLeaseStore();
      leaseStore.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});


describe('HTTP shared finalization ownership', () => {
  function fixture(id: string) {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    const runId = `${id}:run`;
    const run = {runId, requestId: `${id}:request`, sequence: 1, query: 'fact', startedAt: Date.now(), status: 'running',
      privateContext: NO_PRIVATE_CONTEXT};
    const emitter = new EventEmitter();
    const native: AnalysisResult = {sessionId: id, success: false, conclusion: 'exact\r\nbody',
      findings: [], hypotheses: [], confidence: 0.2, rounds: 1, totalDurationMs: 1};
    const analyze = jest.fn(async (_query: string, _sessionId: string, _traceId: string,
      _options?: import('../../agent/core/orchestratorTypes').AnalysisOptions) => native);
    const orchestrator = Object.assign(emitter, {analyze, abortSession: jest.fn(), cleanupSession: jest.fn()});
    const session = {sessionId: id, traceId: 'trace-a', query: 'fact', createdAt: Date.now(), lastActivityAt: Date.now(),
      status: 'running', activeRun: run, lastRun: run, runRegistry: {[runId]: run}, runSequence: 1,
      sseClients: [], sseEventSeq: 0, sseEventBuffer: [], dataEnvelopes: [], hypotheses: [],
      conclusionHistory: [], conversationSteps: [], agentDialogue: [], agentResponses: [], orchestrator,
      logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), close: jest.fn(),
        timed: async <T>(_component: string, _label: string, operation: () => Promise<T>) => operation()},
    } as any;
    agentRoutesCancellationTestSeam.setSession(id, session);
    jest.spyOn(contextAuthorization, 'buildAnalysisContextAuthorizationFingerprint').mockReturnValue('fixed-auth');
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => undefined);
    jest.spyOn(persistence, 'persistAgentTurn').mockImplementation(() => undefined);
    jest.spyOn(persistence, 'refreshPersistedAgentSnapshot').mockImplementation(() => undefined);
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'http-finalizer'});
    const attach = (input: {evidenceAccess?: 'read_new' | 'existing_only'; unavailable?: boolean; deadlineMs?: number;
      runId?: string; referenceTraceId?: string; evidenceReadView?: EvidenceReadView} = {}) => {
      const ownedId = input.runId ?? runId;
      const candidate = {runId: ownedId, attemptId: 'attempt', candidateRef: 'candidate',
        conclusionFingerprint: analysisDeliveryFingerprint(native.conclusion)};
      attachFinalizationContext(native, {runId: ownedId, sessionId: id, deadlineMs: input.deadlineMs ?? Date.now() + 5000,
        strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-a', referenceTraceId: input.referenceTraceId},
        evidenceReadView: input.evidenceReadView,
        turnIntent: {schemaVersion: 1, status: input.unavailable ? 'unavailable' : 'resolved',
          source: input.unavailable ? 'fallback' : 'semantic', registryFingerprint: registry.registryFingerprint,
          taskKind: 'fact', sceneId: 'general', scope: 'scene_wide', recommendedComplexity: 'full',
          deliverable: 'answer', evidenceAccess: input.evidenceAccess ?? 'existing_only'},
        deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate,
          completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}, outputOrigin: 'sdk_final'},
      });
    };
    return {session, native, runId, analyze, orchestrator, attach};
  }

  it.each(['existing_only', 'unavailable', 'missing_context', 'expired'] as const)(
    'takes the exact result once and skips all hidden acquisition for %s', async mode => {
      const id = `http-native-${mode}`;
      const f = fixture(id);
      if (mode !== 'missing_context') f.attach({unavailable: mode === 'unavailable',
        evidenceAccess: mode === 'expired' ? 'read_new' : 'existing_only',
        deadlineMs: mode === 'expired' ? Date.now() - 1 : undefined});
      const raw = createDataEnvelope({columns: ['value'], rows: [[42]]},
        {type: 'sql_result', source: 'query', title: 'fact', evidenceRefId: 'data:http:raw'});
      f.analyze.mockImplementation(async () => {
        f.orchestrator.emit('update', {type: 'data', content: raw, timestamp: Date.now()});
        return f.native;
      });
      const summarySpy = jest.spyOn(summary, 'executeManagedTraceSummaryV1');
      const comparisonSpy = jest.spyOn(comparison, 'buildRawTraceComparisonReportSection');
      const sourceSpy = jest.spyOn(sourceSupplement, 'runAnalysisSourceSupplement');
      const query = jest.fn();
      const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
        expect(input.result).toBe(f.native);
        expect(takeFinalizationContext(f.native)).toBeUndefined();
        expect(input.owner.runId).toBe(f.runId);
        expect(input.comparisonIdentity).toBeUndefined();
        expect(input.dataEnvelopes).toContain(raw);
        expect(input.caseRetrieval).toEqual({status: 'not_checked', recommendations: []});
        input.owner.assertAuthorized();
        input.context?.dispose();
        return {result: input.result};
      });
      try {
        await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
          runContext: f.session.activeRun, traceProcessorService: {query}, executeStateTimeline: true,
          generateTracks: false,
        });
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(f.analyze.mock.calls[0][3]?.runId).toBe(f.runId);
        expect(summarySpy).not.toHaveBeenCalled();
        expect(comparisonSpy).not.toHaveBeenCalled();
        expect(sourceSpy).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(persistence.persistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({result: f.native}));
        expect(f.session.result.conclusion).toBe('exact\r\nbody');
        expect(f.session.status).toBe('failed');
        const completedEvent = f.session.sseEventBuffer.find((event: any) => event.eventType === 'analysis_completed');
        expect(JSON.parse(completedEvent.eventData).data).toMatchObject({success: false, terminalRunStatus: 'failed'});
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    });

  it.each(['captured', 'uncaptured', 'conflicting'] as const)(
    'passes %s comparison identities through the actual shared finalizer without new acquisition', async mode => {
      const id = `http-comparison-${mode}`;
      const f = fixture(id);
      const store = new ArtifactStore();
      const capturedIdentities: IdentityResolutionV1[] = [];
      const envelopes = (mode === 'conflicting' ? [1, 2, 3] : [1, 2]).map(upid => {
        const side = upid === 2 ? 'reference' : 'current';
        const traceId = side === 'current' ? 'trace-a' : 'trace-b';
        const identity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: `identity:${upid}`,
          status: 'verified', target: {traceId, traceSide: side, upid, source: 'skill_param'},
          processes: [{upid, packageName: `app.${side}`, confidence: 1, matchSources: ['upid']}], threads: [], warnings: []};
        const data = {columns: ['value'], rows: [[42]]};
        const envelope = createDataEnvelope(data, {type: 'skill_result', source: 'native', title: side,
          traceId, traceSide: side, evidenceRefId: `evidence:${upid}`, identityResolution: identity,
          scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'target', fields: ['value'],
            scope: {mode: 'exact_upid', traceId, traceSide: side, upid, identityRefId: identity.identityRefId}}]}});
        if (mode !== 'uncaptured') store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), {
          meta: envelope.meta, display: envelope.display,
        });
        capturedIdentities.push(identity);
        // Transport metadata cannot replace the frozen native record.
        if (mode === 'captured') envelope.meta.identityResolution = {...identity, status: 'ambiguous', processes: []};
        return envelope;
      });
      f.attach({referenceTraceId: 'trace-b', evidenceReadView: store.createEvidenceReadView({ownerKey: f.runId,
        allowedTraces: [{traceId: 'trace-a', traceSide: 'current'}, {traceId: 'trace-b', traceSide: 'reference'}]})});
      f.analyze.mockImplementation(async () => {
        for (const envelope of envelopes) f.orchestrator.emit('update', {type: 'data', content: envelope, timestamp: Date.now()});
        return f.native;
      });
      const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult');
      const query = jest.fn();
      const comparisonSpy = jest.spyOn(comparison, 'buildRawTraceComparisonReportSection');
      try {
        await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'Compare', 'trace-a', {
          runContext: f.session.activeRun, referenceTraceId: 'trace-b', traceProcessorService: {query}, generateTracks: false,
        });
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(f.session.result.deliveryAssurance.identity).toBe(mode === 'captured' ? 'passed' : 'not_checked');
        if (mode === 'captured') expect(f.session.result.identityResolutions).toEqual(capturedIdentities);
        expect(f.session.result.conclusion).toBe(f.native.conclusion);
        expect(query).not.toHaveBeenCalled();
        expect(comparisonSpy).not.toHaveBeenCalled();
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    },
  );

  describe('display-only answer draft', () => {
    const drafts = (writes: string[]) => writes.join('').split('\n\n').filter(Boolean).flatMap(frame => {
      const type = /^event: (.+)$/m.exec(frame)?.[1];
      if (type !== 'answer_token' && type !== 'answer_segment_reset') return [];
      return [{type, hasId: /^id: /m.test(frame), data: JSON.parse(/^data: (.+)$/m.exec(frame)![1])}];
    });

    async function runWithDrafts(id: string, extra: {runtimeKind?: string; options?: Record<string, unknown>} = {}) {
      const f = fixture(id);
      f.session.runtimeKind = extra.runtimeKind ?? 'openai-agents-sdk';
      f.attach();
      const writes: string[] = [];
      f.session.sseClients.push({write: (chunk: string) => { writes.push(chunk); return true; }});
      f.analyze.mockImplementation(async () => {
        const emit = (type: string, content: unknown) => f.orchestrator.emit('update', {type, content, timestamp: Date.now()});
        emit('answer_token', {token: 'Pre-tool text', runId: f.runId, attempt: 0});
        emit('answer_segment_reset', {runId: f.runId, attempt: 1});
        emit('answer_token', {token: 'Answer body', runId: f.runId, attempt: 1});
        emit('answer_token', {token: 'LATE_OLD_SEGMENT', runId: f.runId, attempt: 0});
        emit('answer_token', {token: 'FOREIGN_RUN', runId: 'another-run', attempt: 1});
        emit('conclusion', {conclusion: 'RAW_RUNTIME_CONCLUSION'});
        return f.native;
      });
      jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
        input.context?.dispose();
        return {result: input.result};
      });
      await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, traceProcessorService: {query: jest.fn()}, generateTracks: false,
        ...(extra.options ?? {}),
      });
      return {f, writes};
    }

    it('streams drafts live only: coalesced, reset-ordered, never buffered for replay', async () => {
      const id = 'http-draft-live';
      try {
        const {f, writes} = await runWithDrafts(id);
        const delivered = drafts(writes);
        expect(delivered.map(event => [event.type, event.data.data.token ?? null, event.data.data.attempt])).toEqual([
          ['answer_segment_reset', null, 1],
          ['answer_token', 'Answer body', 1],
        ]);
        expect(delivered.every(event => !event.hasId && event.data.runId === f.runId)).toBe(true);
        // A reconnect replays the ring buffer and the durable store; neither holds a draft.
        const replayable = f.session.sseEventBuffer.map((event: any) => event.eventType);
        expect(replayable).not.toContain('answer_token');
        expect(replayable).not.toContain('answer_segment_reset');
        expect(JSON.stringify(f.session.sseEventBuffer)).not.toContain('RAW_RUNTIME_CONCLUSION');
        expect(writes.join('')).not.toContain('Pre-tool text');
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    });

    it('streams no draft for a runtime without the reset contract', async () => {
      const id = 'http-draft-incapable';
      try {
        const {writes} = await runWithDrafts(id, {runtimeKind: 'opencode'});
        expect(drafts(writes)).toEqual([]);
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    });

    it('streams an owner-projected draft for a session with source access, live only', async () => {
      const id = 'http-draft-private';
      const project = jest.spyOn(streamingProjection, 'projectOwnerCodeAwareStreamingUpdate');
      try {
        const {f, writes} = await runWithDrafts(id, {options: {codeAwareMode: 'provider_send', codebaseIds: ['app-source']}});
        expect(project).toHaveBeenCalledWith(id, expect.objectContaining({type: 'answer_token'}), true, expect.any(String));
        expect(drafts(writes).map(event => [event.type, event.data.data.token ?? null, event.data.data.attempt])).toEqual([
          ['answer_segment_reset', null, 1],
          ['answer_token', 'Answer body', 1],
        ]);
        expect(drafts(writes).every(event => !event.hasId)).toBe(true);
        expect(JSON.stringify(f.session.sseEventBuffer)).not.toContain('Answer body');
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    });

    it('streams no draft for a private session whose owner projection fails', async () => {
      const id = 'http-draft-private-failure';
      const actual = streamingProjection.projectOwnerCodeAwareStreamingUpdate;
      jest.spyOn(streamingProjection, 'projectOwnerCodeAwareStreamingUpdate').mockImplementation((...args) => {
        if (args[1].type === 'answer_token') throw new Error('private guard unavailable');
        return actual(...args);
      });
      try {
        const {writes} = await runWithDrafts(id, {options: {codeAwareMode: 'provider_send', codebaseIds: ['app-source']}});
        expect(drafts(writes).filter(event => event.type === 'answer_token')).toEqual([]);
        expect(writes.join('')).not.toContain('Answer body');
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    });
  });

  it('does not retire or delete a replacement session after authorization cleanup yields', async () => {
    const id = 'http-authorization-replacement'; const f = fixture(id); f.attach();
    const replacement = {...f.session, activeRun: {...f.session.activeRun, runId: 'replacement-run'}};
    const replacementOwner = agentRoutesCancellationTestSeam.createHttpFinalizationRun(
      replacement, 'replacement-run', {}, {}, 'fixed-auth',
    );
    f.orchestrator.cleanupSession.mockImplementation(() => {
      agentRoutesCancellationTestSeam.setSession(id, replacement);
      return Promise.resolve();
    });
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      input.context?.dispose(); throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
    });
    try {
      await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      expect(replacementOwner.owner.isCurrent()).toBe(true);
      expect(replacement.status).toBe('running');
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
    } finally {replacementOwner.release(); agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('keeps a private run question out of the strict session log', async () => {
    const id = 'http-private-log-placeholder'; const f = fixture(id);
    const question = 'PRIVATE_LOG_QUESTION about Foo::bar';
    f.session.outputLanguage = 'en';
    f.session.activeRun.privateContext = {codebase: true, knowledge: false};
    f.native.success = true; f.attach();
    jest.spyOn(reports, 'persistReport').mockImplementation(() => undefined);
    jest.spyOn(snapshots, 'persistCompletedAnalysisResultSnapshot').mockReturnValue(null);
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      input.context?.dispose(); return {result: input.result};
    });
    try {
      await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, question, 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      expect(f.analyze).toHaveBeenCalledTimes(1);
      // Logs are a strict surface: the creator's question never reaches them.
      expect(f.session.logger.info).toHaveBeenCalledWith('AgentDrivenAnalysis', 'Starting agent-driven analysis',
        expect.objectContaining({query: 'Private source or knowledge analysis request (original content not persisted)'}));
      const logger = f.session.logger;
      expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]))
        .not.toContain('PRIVATE_LOG_QUESTION');
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('does not launch an automatic source supplement for a legacy deep_supplement activation', async () => {
    const id = 'http-no-automatic-source-supplement'; const f = fixture(id);
    f.native.success = true; f.attach({evidenceAccess: 'read_new'});
    f.session.sourceActivation = 'deep_supplement'; f.session.sourceAuthorization = {codeAwareMode: 'metadata_only', codebaseIds: ['source']};
    const supplement = jest.spyOn(sourceSupplement, 'runAnalysisSourceSupplement');
    jest.spyOn(reports, 'persistReport').mockImplementation(() => undefined);
    jest.spyOn(snapshots, 'persistCompletedAnalysisResultSnapshot').mockReturnValue(null);
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      input.context?.dispose(); return {result: input.result};
    });
    try {
      await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, '审查源码中的阻塞原因', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      expect(supplement).not.toHaveBeenCalled();
      expect(f.session.analysisSourceEnrichment).toBeUndefined();
      expect(f.analyze).toHaveBeenCalledTimes(1);
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('takes and disposes context before an outer native-settlement callback cancels the run', async () => {
    const id = 'http-cancel-after-native';
    const f = fixture(id); f.attach();
    let taken: RuntimeFinalizationContext | undefined;
    const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult');
    f.session.logger.timed = async (_component: string, _label: string, operation: () => Promise<AnalysisResult>) => {
      const result = await operation();
      expect(takeFinalizationContext(result)).toBeUndefined();
      agentRoutesCancellationTestSeam.abortHttpFinalizationRuns(f.session, f.runId);
      return result;
    };
    try {
      await expect(agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      })).rejects.toMatchObject({name: 'AbortError'});
      expect(finalize).not.toHaveBeenCalled();
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
      expect(f.session.result).toBeUndefined();
      expect(taken).toBeUndefined();
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('rejects a runtime context belonging to a different run without adopting its identity', async () => {
    const id = 'http-wrong-context';
    const f = fixture(id); f.attach({runId: 'runtime-other-run'});
    const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult');
    try {
      await expect(agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      })).rejects.toThrow('finalization_run_identity_mismatch');
      expect(finalize).not.toHaveBeenCalled();
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
      expect(f.session.result).toBeUndefined();
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('keeps finalizer cancellation alive after native settlement and cannot commit a late result', async () => {
    const id = 'http-cancel-in-finalizer';
    const f = fixture(id); f.attach();
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => {notifyStarted = resolve;});
    const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      notifyStarted();
      try {await new Promise<never>((_resolve, reject) => {
        input.owner.signal.addEventListener('abort', () => reject(input.owner.signal.reason), {once: true});
      });} finally {input.context?.dispose();}
      return {result: input.result};
    });
    try {
      const pending = agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      await started;
      await agentRoutesCancellationTestSeam.cancelSessionRun(id, f.runId, 'cancel finalization');
      await pending;
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
      expect(f.session.result).toBeUndefined();
      expect(f.session.conclusionHistory).toEqual([]);
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });
});
