// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
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
import { ENTERPRISE_DB_PATH_ENV } from '../../services/enterpriseDb';
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
  clearRunManifestLifecyclesForTests();
  resetRunManifestStoreForTests();
  restoreEnvironment();
});

describe('agent analyze cancellation races', () => {
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
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockResolvedValue({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        filePath: tracePath,
        uploadTime: new Date(),
        status: 'ready',
      });
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

  it('does not start the runtime when its run is cancelled while lease startup is pending', async () => {
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
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockResolvedValue({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        filePath: tracePath,
        uploadTime: new Date(),
        status: 'ready',
      });
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

  it('does not project a runtime success that arrives after the exact run was cancelled', async () => {
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
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
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
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockImplementation(async (id) => ({
        id,
        filename: `${id}.trace`,
        size: 11,
        filePath: path.join(tmpDir, `${id}.trace`),
        uploadTime: new Date(),
        status: 'ready',
      }));
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
