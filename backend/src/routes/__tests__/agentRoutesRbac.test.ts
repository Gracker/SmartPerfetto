// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { EnhancedSessionContext, sessionContextManager } from '../../agent/context/enhancedSessionContext';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import {
  deleteTraceMetadata,
  ENTERPRISE_DATA_DIR_ENV,
  writeTraceMetadata,
} from '../../services/traceMetadataStore';
import {
  persistSerializedAgentEvent,
  resetAgentEventStoreForTests,
} from '../../services/agentEventStore';
import {
  getAnalysisRunLifecycle,
  resetAnalysisRunStoreForTests,
} from '../../services/analysisRunStore';
import {
  getTraceProcessorLeaseStore,
  setTraceProcessorLeaseStoreForTests,
} from '../../services/traceProcessorLeaseStore';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import { clearRunManifestLifecyclesForTests } from '../../services/selfEvolution/runManifestLifecycle';
import { resetRunManifestStoreForTests } from '../../services/selfEvolution/runManifestStore';
import {
  TraceProcessorService,
  setTraceProcessorServiceForTests,
  type TraceProcessor,
} from '../../services/traceProcessorService';
import { ClaudeRuntime } from '../../agentRuntime/engines/claude';
import type { AnalysisOptions, AnalysisResult } from '../../agent/core/orchestratorTypes';
import type { TracePairContext } from '../../agentv3/types';
import * as defaultCodebaseServices from '../../services/codebase/defaultCodebaseServices';
import * as externalKnowledgeServices from '../../services/externalKnowledgeSourceRegistry';
import {getProviderService, resetProviderService} from '../../services/providerManager';
import agentRoutes, {resolveConclusionSceneIdHint} from '../agentRoutes';

const originalApiKey = process.env.SMARTPERFETTO_API_KEY;
const originalSsoTrustedHeaders = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
const originalEnterprise = process.env[ENTERPRISE_FEATURE_FLAG_ENV];
const originalEnterpriseDbPath = process.env[ENTERPRISE_DB_PATH_ENV];
const originalEnterpriseDataDir = process.env[ENTERPRISE_DATA_DIR_ENV];
const originalUploadDir = process.env.UPLOAD_DIR;
const originalAgentRuntime = process.env.SMARTPERFETTO_AGENT_RUNTIME;
const originalAiEnabled = process.env.SMARTPERFETTO_AI_ENABLED;
const originalCodeAware = process.env.SMARTPERFETTO_CODE_AWARE;
const originalOutputLanguage = process.env.SMARTPERFETTO_OUTPUT_LANGUAGE;
const originalBackendDataDir = process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
const originalBackendLogDir = process.env.SMARTPERFETTO_BACKEND_LOG_DIR;
const originalProviderDataDir = process.env.PROVIDER_DATA_DIR_OVERRIDE;

type DeferredRuntime = {
  promise: Promise<unknown>;
  reject: (error: unknown) => void;
  settled: boolean;
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/agent/v1', agentRoutes);
  return app;
}

function viewerHeaders(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'viewer-user')
    .set('X-SmartPerfetto-SSO-Email', 'viewer@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'viewer')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,report:read');
}

function analystHeaders(req: request.Test): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'analyst-user')
    .set('X-SmartPerfetto-SSO-Email', 'analyst@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read');
}

function scopedAnalystHeaders(
  req: request.Test,
  options: { userId: string; workspaceId: string; email?: string },
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', options.userId)
    .set('X-SmartPerfetto-SSO-Email', options.email ?? `${options.userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', options.workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read');
}

function scopedViewerHeaders(
  req: request.Test,
  options: { userId: string; workspaceId: string; email?: string },
): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', options.userId)
    .set('X-SmartPerfetto-SSO-Email', options.email ?? `${options.userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', options.workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'viewer')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,report:read');
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function createDeferredRuntime(deferreds: DeferredRuntime[]): DeferredRuntime {
  let rejectRuntime!: (error: unknown) => void;
  const promise = new Promise<unknown>((_resolve, reject) => {
    rejectRuntime = reject;
  });
  const deferred: DeferredRuntime = {
    promise,
    reject: (error: unknown) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectRuntime(error);
    },
    settled: false,
  };
  deferreds.push(deferred);
  return deferred;
}

async function rejectPendingDeferredRuntimes(
  deferreds: DeferredRuntime[],
  label: string,
): Promise<void> {
  for (const [index, deferred] of deferreds.entries()) {
    deferred.reject(new Error(`${label} ${index}`));
  }
  if (deferreds.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function minimalSessionSnapshot(
  sessionId: string,
  traceId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'quota_exceeded',
): any {
  const now = Date.now();
  return {
    version: 1,
    snapshotTimestamp: now,
    sessionId,
    traceId,
    conversationSteps: [],
    queryHistory: [{ turn: 1, query: 'resume this persisted session', timestamp: now }],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    analysisNotes: [],
    analysisPlan: null,
    planHistory: [],
    uncertaintyFlags: [],
    runSequence: 1,
    conversationOrdinal: 0,
    activeRun: {
      runId: `run-${sessionId}-1`,
      requestId: `req-${sessionId}-1`,
      sequence: 1,
      query: 'resume this persisted session',
      startedAt: now - 100,
      completedAt: now,
      status,
    },
    lastRun: {
      runId: `run-${sessionId}-1`,
      requestId: `req-${sessionId}-1`,
      sequence: 1,
      query: 'resume this persisted session',
      startedAt: now - 100,
      completedAt: now,
      status,
    },
  };
}

afterEach(async () => {
  jest.restoreAllMocks();
  setTraceProcessorServiceForTests(null);
  setTraceProcessorLeaseStoreForTests(null);
  SessionPersistenceService.resetForTests();
  resetAgentEventStoreForTests();
  resetAnalysisRunStoreForTests();
  clearRunManifestLifecyclesForTests();
  resetRunManifestStoreForTests();
  resetProviderService();
  if (originalApiKey === undefined) {
    delete process.env.SMARTPERFETTO_API_KEY;
  } else {
    process.env.SMARTPERFETTO_API_KEY = originalApiKey;
  }
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalSsoTrustedHeaders);
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnterprise);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnterpriseDbPath);
  restoreEnvValue(ENTERPRISE_DATA_DIR_ENV, originalEnterpriseDataDir);
  restoreEnvValue('UPLOAD_DIR', originalUploadDir);
  restoreEnvValue('SMARTPERFETTO_AGENT_RUNTIME', originalAgentRuntime);
  restoreEnvValue('SMARTPERFETTO_AI_ENABLED', originalAiEnabled);
  restoreEnvValue('SMARTPERFETTO_CODE_AWARE', originalCodeAware);
  restoreEnvValue('SMARTPERFETTO_OUTPUT_LANGUAGE', originalOutputLanguage);
  restoreEnvValue('SMARTPERFETTO_BACKEND_DATA_DIR', originalBackendDataDir);
  restoreEnvValue('SMARTPERFETTO_BACKEND_LOG_DIR', originalBackendLogDir);
  restoreEnvValue('PROVIDER_DATA_DIR_OVERRIDE', originalProviderDataDir);
  sessionContextManager.remove('session-resume-integration');
});

describe('agent route RBAC', () => {
  it('prefers the executed analysis skill over ambiguous trace wording', () => {
    expect(resolveConclusionSceneIdHint({
      sessionId: 'scene-evidence-test',
      query: '检查这个启动 Trace 是否包含 ANR',
      findings: [],
      intent: {
        primaryGoal: '检查这个启动 Trace 是否包含 ANR',
        aspects: ['startup'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
        followUpType: 'initial',
      },
      dataEnvelopes: [{meta: {skillId: 'anr_analysis'}} as any],
    })).toBe('anr');
  });

  it('runs a no-Trace conversation through the lightweight contract and streams the answer', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'zh-CN';
    const analyze = jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
      _query,
      sessionId,
      traceId,
      options = {},
    ) => ({
      sessionId,
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: '先确认目标。\n<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"你更关注启动还是滑动？"} -->',
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 5,
    }));
    const app = makeApp();

    const started = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
      .send({query: '帮我分析性能需求'});

    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      success: true,
      status: 'running',
      traceContextAttached: false,
    });
    expect(analyze).toHaveBeenCalledWith(
      expect.stringContaining('当前没有附加 Trace'),
      expect.stringContaining(started.body.runId),
      expect.stringContaining('conversation-no-trace:'),
      expect.objectContaining({
        analysisMode: 'fast',
        assistantSurface: 'conversation',
        conversationTraceAttached: false,
      }),
    );

    const streamed = await analystHeaders(request(app).get(
      `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
    ));
    expect(streamed.status).toBe(200);
    expect(streamed.text).toContain('event: run_completed');
    expect(streamed.text).toContain('needs_user_input');
    expect(streamed.text).not.toContain('smartperfetto:conversation-control');
  });

  it('forwards the latest normalized selection context on every conversation turn', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const receivedOptions: AnalysisOptions[] = [];
    jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
      _query,
      sessionId,
      _traceId,
      options = {},
    ) => {
      receivedOptions.push(options);
      return {
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '回答',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      };
    });
    const app = makeApp();
    const selectedSlice = {
      kind: 'track_event',
      source: 'track_event_selection',
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
      name: 'monitor contention',
      threadName: 'main',
      processName: 'com.example.app',
    };

    const first = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
      .send({
        query: '分析当前选择',
        options: {selectionContext: selectedSlice},
      });
    expect(first.status).toBe(202);
    await analystHeaders(request(app).get(
      `/api/agent/v1/conversation/${first.body.sessionId}/stream?runId=${first.body.runId}`,
    ));

    const second = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
      .send({
        sessionId: first.body.sessionId,
        query: '现在不看选区了',
      });
    expect(second.status).toBe(202);
    await analystHeaders(request(app).get(
      `/api/agent/v1/conversation/${second.body.sessionId}/stream?runId=${second.body.runId}`,
    ));

    expect(receivedOptions[0].selectionContext).toEqual(selectedSlice);
    expect(receivedOptions[1].selectionContext).toBeUndefined();
  });

  it('does not let a conversation bypass registered-source RBAC', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    const analyze = jest.spyOn(ClaudeRuntime.prototype, 'analyze');

    const response = await viewerHeaders(request(makeApp()).post('/api/agent/v1/conversation'))
      .send({
        query: 'review this source',
        options: {
          codeAwareMode: 'metadata_only',
          codebaseIds: ['private-app'],
        },
      });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('accounts for a conversation run and isolates its full-analysis handoff', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-accounting-'));
    try {
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'enterprise-data');
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
      ) => ({
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: [
          '这个问题需要完整因果分析。',
          '<!-- smartperfetto:conversation-control {"kind":"recommend_full","handoff":{"question":"为什么卡顿？","scope":"当前交互","assumptions":[],"evidence":[]}} -->',
        ].join('\n'),
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      }));
      const app = makeApp();
      const owner = {userId: 'conversation-owner', workspaceId: 'workspace-a'};
      const other = {userId: 'conversation-other', workspaceId: 'workspace-a'};

      const started = await scopedAnalystHeaders(
        request(app).post('/api/agent/v1/conversation'),
        owner,
      ).send({query: '给我完整根因'});
      expect(started.status).toBe(202);
      const streamed = await scopedAnalystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
      ), owner);
      expect(streamed.text).toContain('recommend_full');

      expect(getAnalysisRunLifecycle({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: owner.userId,
      }, started.body.runId)).toMatchObject({status: 'completed'});

      const hidden = await scopedAnalystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/full-handoff`,
      ), other);
      expect(hidden.status).toBe(404);

      const visible = await scopedAnalystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/full-handoff`,
      ), owner);
      expect(visible.status).toBe(200);
      expect(visible.body.handoff).toMatchObject({
        question: '为什么卡顿？',
        scope: '当前交互',
      });
    } finally {
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('hides cancellation from non-owners and settles the owner run as cancelled', async () => {
    let rejectRuntime: ((error: Error) => void) | undefined;
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(() => (
      new Promise((_resolve, reject) => {
        rejectRuntime = reject;
      })
    ));
    jest.spyOn(ClaudeRuntime.prototype, 'abortSession').mockImplementation(async () => {
      rejectRuntime?.(new Error('Analysis aborted'));
    });
    const app = makeApp();
    const owner = {userId: 'cancel-owner', workspaceId: 'workspace-a'};
    const other = {userId: 'cancel-other', workspaceId: 'workspace-a'};

    const started = await scopedAnalystHeaders(
      request(app).post('/api/agent/v1/conversation'),
      owner,
    ).send({query: '继续分析'});
    expect(started.status).toBe(202);

    const hidden = await scopedAnalystHeaders(request(app).post(
      `/api/agent/v1/conversation/${started.body.sessionId}/cancel`,
    ), other).send({runId: started.body.runId});
    expect(hidden.status).toBe(404);

    const cancelled = await scopedAnalystHeaders(request(app).post(
      `/api/agent/v1/conversation/${started.body.sessionId}/cancel`,
    ), owner).send({runId: started.body.runId});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({success: true, status: 'cancelled'});
  });

  it('rechecks agent:run permission on every conversation endpoint', async () => {
    let rejectRuntime: ((error: Error) => void) | undefined;
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(() => (
      new Promise((_resolve, reject) => {
        rejectRuntime = reject;
      })
    ));
    const app = makeApp();
    const owner = {userId: 'permission-owner', workspaceId: 'workspace-a'};
    const started = await scopedAnalystHeaders(
      request(app).post('/api/agent/v1/conversation'),
      owner,
    ).send({query: '继续分析'});
    expect(started.status).toBe(202);

    const streamDenied = await scopedViewerHeaders(request(app).get(
      `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
    ), owner);
    const cancelDenied = await scopedViewerHeaders(request(app).post(
      `/api/agent/v1/conversation/${started.body.sessionId}/cancel`,
    ), owner).send({runId: started.body.runId});
    const handoffDenied = await scopedViewerHeaders(request(app).get(
      `/api/agent/v1/conversation/${started.body.sessionId}/full-handoff`,
    ), owner);

    expect(streamDenied.status).toBe(403);
    expect(cancelDenied.status).toBe(403);
    expect(handoffDenied.status).toBe(403);
    rejectRuntime?.(new Error('test cleanup'));
  });

  it('requires a fresh conversation after provider or language changes', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'zh-CN';
    jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
      _query,
      sessionId,
    ) => ({
      sessionId,
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: '回答',
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 5,
    }));
    const app = makeApp();
    const started = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
      .send({query: '第一轮'});
    expect(started.status).toBe(202);
    await analystHeaders(request(app).get(
      `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
    ));

    const providerChanged = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
      .send({sessionId: started.body.sessionId, query: '第二轮', providerId: 'another-provider'});
    expect(providerChanged.status).toBe(409);
    expect(providerChanged.body.code).toBe('CONVERSATION_PROVIDER_CHANGED');

    const languageChanged = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
      .send({
        sessionId: started.body.sessionId,
        query: 'second turn',
        options: {outputLanguage: 'en'},
      });
    expect(languageChanged.status).toBe(409);
    expect(languageChanged.body.code).toBe('CONVERSATION_LANGUAGE_CHANGED');
  });

  it('pins the implicit active provider and rejects active provider switches', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-provider-pin-'));
    try {
      process.env.PROVIDER_DATA_DIR_OVERRIDE = tmpDir;
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      resetProviderService();
      const providerScope = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      };
      const providerService = getProviderService();
      const createProvider = (name: string) => providerService.create({
        name,
        category: 'official',
        type: 'deepseek',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          apiKey: `test-${name}`,
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
        },
      }, providerScope);
      const firstProvider = createProvider('conversation-provider-a');
      const secondProvider = createProvider('conversation-provider-b');
      providerService.activate(firstProvider.id, providerScope);
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
      ) => ({
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '回答',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      }));
      const app = makeApp();
      const started = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({query: '第一轮'});
      expect(started.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
      ));

      providerService.activate(secondProvider.id, providerScope);
      const changed = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({sessionId: started.body.sessionId, query: '第二轮'});

      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CONVERSATION_PROVIDER_CHANGED');
    } finally {
      resetProviderService();
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('rejects a same-provider runtime snapshot change between conversation turns', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-provider-snapshot-'));
    try {
      process.env.PROVIDER_DATA_DIR_OVERRIDE = tmpDir;
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      resetProviderService();
      const providerScope = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      };
      const providerService = getProviderService();
      const provider = providerService.create({
        name: 'conversation-runtime-provider',
        category: 'official',
        type: 'deepseek',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          apiKey: 'test-runtime-provider',
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
        },
      }, providerScope);
      providerService.activate(provider.id, providerScope);
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
      ) => ({
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '回答',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      }));
      const app = makeApp();
      const started = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({query: '第一轮'});
      expect(started.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
      ));

      providerService.update(provider.id, {
        connection: {agentRuntime: 'openai-agents-sdk'},
      }, providerScope);
      const changed = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({sessionId: started.body.sessionId, query: '第二轮'});

      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CONVERSATION_PROVIDER_SNAPSHOT_CHANGED');
    } finally {
      resetProviderService();
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('keeps an explicitly selected non-active provider pinned when later turns omit providerId', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-explicit-provider-pin-'));
    try {
      process.env.PROVIDER_DATA_DIR_OVERRIDE = tmpDir;
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      resetProviderService();
      const providerScope = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      };
      const providerService = getProviderService();
      const createProvider = (name: string) => providerService.create({
        name,
        category: 'official',
        type: 'deepseek',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          apiKey: `test-${name}`,
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
        },
      }, providerScope);
      const explicitProvider = createProvider('conversation-explicit-provider');
      const activeProvider = createProvider('conversation-active-provider');
      providerService.activate(activeProvider.id, providerScope);
      const analyze = jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
      ) => ({
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '回答',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      }));
      const app = makeApp();
      const started = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({query: '第一轮', providerId: explicitProvider.id});
      expect(started.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
      ));

      const continued = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({sessionId: started.body.sessionId, query: '第二轮'});
      expect(continued.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${continued.body.sessionId}/stream?runId=${continued.body.runId}`,
      ));

      expect(analyze).toHaveBeenCalledTimes(2);
      expect(analyze).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({providerId: explicitProvider.id}),
      );
    } finally {
      resetProviderService();
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('rechecks the active provider after an awaited Trace load before starting the next turn', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-provider-toc-'));
    const traceId = 'conversation-provider-toc-trace';
    let releaseSecondLoad: (() => void) | undefined;
    try {
      process.env.PROVIDER_DATA_DIR_OVERRIDE = path.join(tmpDir, 'providers');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      resetProviderService();
      const providerScope = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      };
      const providerService = getProviderService();
      const createProvider = (name: string) => providerService.create({
        name,
        category: 'official',
        type: 'deepseek',
        models: {primary: 'deepseek-chat', light: 'deepseek-chat'},
        connection: {
          apiKey: `test-${name}`,
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
          openaiBaseUrl: 'https://api.deepseek.com/v1',
        },
      }, providerScope);
      const firstProvider = createProvider('conversation-toc-provider-a');
      const secondProvider = createProvider('conversation-toc-provider-b');
      providerService.activate(firstProvider.id, providerScope);

      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
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
      let loadCount = 0;
      let markSecondLoadStarted!: () => void;
      const secondLoadStarted = new Promise<void>((resolve) => {
        markSecondLoadStarted = resolve;
      });
      const secondLoadRelease = new Promise<void>((resolve) => {
        releaseSecondLoad = resolve;
      });
      const getOrLoadTrace = jest.fn(async () => {
        loadCount += 1;
        if (loadCount === 2) {
          markSecondLoadStarted();
          await secondLoadRelease;
        }
        return {
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        };
      });
      setTraceProcessorServiceForTests({getOrLoadTrace} as any);
      const analyze = jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
      ) => ({
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '回答',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      }));
      const app = makeApp();
      const started = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({query: '第一轮', traceId});
      expect(started.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${started.body.sessionId}/stream?runId=${started.body.runId}`,
      ));

      const pendingSecondResponse = analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({sessionId: started.body.sessionId, query: '第二轮'})
        .then(response => response);
      await secondLoadStarted;
      providerService.activate(secondProvider.id, providerScope);
      releaseSecondLoad?.();
      const changed = await pendingSecondResponse;

      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CONVERSATION_PROVIDER_CHANGED');
      expect(analyze).toHaveBeenCalledTimes(1);
    } finally {
      releaseSecondLoad?.();
      await deleteTraceMetadata(traceId);
      resetProviderService();
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('requires a fresh conversation when Trace identity changes and revalidates retained Trace access', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-trace-boundary-'));
    try {
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      const tracePaths = new Map<string, string>();
      for (const traceId of ['conversation-trace-a', 'conversation-trace-b']) {
        const tracePath = path.join(tmpDir, `${traceId}.trace`);
        tracePaths.set(traceId, tracePath);
        await fs.writeFile(tracePath, 'trace bytes');
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
      }
      const getOrLoadTrace = jest.fn(async (traceId: string) => ({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        filePath: tracePaths.get(traceId),
        uploadTime: new Date(),
        status: 'ready',
      }));
      setTraceProcessorServiceForTests({getOrLoadTrace} as any);
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
      ) => ({
        sessionId,
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: '回答',
        confidence: 0.8,
        rounds: 1,
        totalDurationMs: 5,
      }));
      const app = makeApp();

      const noTrace = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({query: '先讨论问题'});
      expect(noTrace.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${noTrace.body.sessionId}/stream?runId=${noTrace.body.runId}`,
      ));
      const attachedLater = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({
          sessionId: noTrace.body.sessionId,
          traceId: 'conversation-trace-a',
          query: '现在看 Trace',
        });
      expect(attachedLater.status).toBe(409);
      expect(attachedLater.body.code).toBe('CONVERSATION_TRACE_CHANGED');

      const attached = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({traceId: 'conversation-trace-a', query: '分析 Trace A'});
      expect(attached.status).toBe(202);
      await analystHeaders(request(app).get(
        `/api/agent/v1/conversation/${attached.body.sessionId}/stream?runId=${attached.body.runId}`,
      ));
      const changed = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({
          sessionId: attached.body.sessionId,
          traceId: 'conversation-trace-b',
          query: '切换到 Trace B',
        });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CONVERSATION_TRACE_CHANGED');

      await deleteTraceMetadata('conversation-trace-a');
      const retainedButDeleted = await analystHeaders(request(app).post('/api/agent/v1/conversation'))
        .send({sessionId: attached.body.sessionId, query: '继续分析'});
      expect(retainedButDeleted.status).toBe(404);
      expect(retainedButDeleted.body.code).toBe('TRACE_NOT_UPLOADED');
      expect(getOrLoadTrace).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('allows a selected codebase without an index when its registered root is available', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-route-on-demand-source-'));
    const root = path.join(tmpDir, 'app');
    await fs.mkdir(root);
    const rootRealpath = await fs.realpath(root);
    try {
      delete process.env.SMARTPERFETTO_API_KEY;
      delete process.env.SMARTPERFETTO_CODE_AWARE;
      process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'zh-CN';
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      jest.spyOn(defaultCodebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue({
        get: jest.fn(() => ({
          codebaseId: 'codebase-unindexed',
          lifecycleState: 'active',
          rootRealpath,
          indexGeneration: 1,
          chunkCount: 0,
          consent: {sendToProvider: false, consentHash: 'consent'},
        })),
      } as any);
      const traceService = {getOrLoadTrace: jest.fn()};
      setTraceProcessorServiceForTests(traceService as any);

      const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
        .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read,codebase:read')
        .send({
          traceId: 'trace-a',
          query: 'analyze with source',
          options: {
            analysisMode: 'fast',
            codeAwareMode: 'metadata_only',
            codebaseIds: ['codebase-unindexed'],
          },
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual(expect.objectContaining({
        success: false,
        code: 'TRACE_NOT_UPLOADED',
      }));
      expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('rejects a selected codebase when its registered root is unavailable', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    delete process.env.SMARTPERFETTO_CODE_AWARE;
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    jest.spyOn(defaultCodebaseServices, 'getDefaultCodebaseRegistry').mockReturnValue({
      get: jest.fn(() => ({
        codebaseId: 'codebase-missing-root',
        lifecycleState: 'active',
        rootRealpath: '/definitely/missing/smartperfetto/source',
        indexGeneration: 1,
        chunkCount: 0,
        consent: {sendToProvider: false, consentHash: 'consent'},
      })),
    } as any);
    const traceService = {getOrLoadTrace: jest.fn()};
    setTraceProcessorServiceForTests(traceService as any);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
      .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read,codebase:read')
      .send({
        traceId: 'trace-a',
        query: 'analyze with source',
        options: {
          codeAwareMode: 'metadata_only',
          codebaseIds: ['codebase-missing-root'],
        },
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE',
    }));
    expect(res.body.error).toContain('registered root');
    expect(res.body.error).toContain('unavailable');
    expect(res.body.error).not.toContain('index');
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects an activated knowledge source whose generation contains no chunks', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'en';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    jest.spyOn(externalKnowledgeServices, 'getDefaultExternalKnowledgeSourceRegistry')
      .mockReturnValue({
        get: jest.fn(() => ({
          sourceId: 'wiki-empty',
          indexGeneration: 2,
          activeGeneration: 'knowledge_2_empty',
          contentFingerprint: 'b'.repeat(64),
          indexedChunkCount: 0,
          rightsAcknowledged: true,
          sendToProvider: true,
        })),
      } as any);
    const traceService = {getOrLoadTrace: jest.fn()};
    setTraceProcessorServiceForTests(traceService as any);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
      .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read,codebase:read')
      .send({
        traceId: 'trace-a',
        query: 'analyze with private knowledge',
        options: {knowledgeSourceIds: ['wiki-empty']},
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      code: 'ANALYSIS_CONTEXT_SOURCE_UNAVAILABLE',
    }));
    expect(res.body.error).toContain('inactive or not consented');
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects viewer analyze requests before trace access is evaluated', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';

    const res = await viewerHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
      .send({ traceId: 'trace-a', query: 'analyze this trace' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(res.body.details).toContain('agent:run');
  });

  it('enforces feedback RBAC, run ownership, and scoped event storage', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-feedback-rbac-'));
    const deferreds: DeferredRuntime[] = [];
    try {
      const traceId = 'trace-feedback-rbac';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env.SMARTPERFETTO_BACKEND_DATA_DIR = path.join(tmpDir, 'data');
      process.env.SMARTPERFETTO_BACKEND_LOG_DIR = path.join(tmpDir, 'logs');
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'enterprise-data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        getTrace: jest.fn(() => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(() => createDeferredRuntime(deferreds).promise),
        query: jest.fn(async () => ({columns: [], rows: [], durationMs: 1})),
      } as any);

      const app = makeApp();
      const analyze = await analystHeaders(
        request(app).post('/api/agent/v1/analyze'),
      ).send({traceId, query: 'analyze for feedback'});
      expect(analyze.status).toBe(200);

      const viewerOwner = viewerHeaders(
        request(app).post(`/api/agent/v1/${analyze.body.sessionId}/feedback`),
      )
        .set('X-SmartPerfetto-SSO-User-Id', 'analyst-user')
        .send({rating: 'positive', runId: analyze.body.runId});
      expect((await viewerOwner).status).toBe(403);

      const crossWorkspace = await scopedAnalystHeaders(
        request(app).post(`/api/agent/v1/${analyze.body.sessionId}/feedback`),
        {userId: 'analyst-user', workspaceId: 'workspace-b'},
      ).send({rating: 'positive', runId: analyze.body.runId});
      expect(crossWorkspace.status).toBe(404);

      const stored = await analystHeaders(
        request(app).post(`/api/agent/v1/${analyze.body.sessionId}/feedback`),
      )
        .set('Idempotency-Key', 'feedback-rbac-request')
        .send({rating: 'positive', runId: analyze.body.runId});
      expect(stored.status).toBe(200);
      expect(stored.body).toMatchObject({
        success: true,
        storageDisposition: 'stored_scoped',
        idempotencyKey: 'feedback-rbac-request',
      });
      const feedbackLog = path.join(
        tmpDir,
        'logs',
        'feedback',
        'tenant-a',
        'workspace-a',
        'feedback.jsonl',
      );
      const lines = (await fs.readFile(feedbackLog, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        eventId: stored.body.eventId,
        feedbackId: stored.body.feedbackId,
        runId: analyze.body.runId,
        scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
      });
    } finally {
      await rejectPendingDeferredRuntimes(deferreds, 'feedback test cleanup');
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('rejects analyze requests after tenant tombstone before trace access is evaluated', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-tombstone-'));
    try {
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');

      const db = openEnterpriseDb();
      const now = Date.now();
      try {
        db.prepare(`
          INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
          VALUES ('tenant-a', 'Tenant A', 'tombstoned', 'enterprise', ?, ?)
        `).run(now, now);
        db.prepare(`
          INSERT INTO tenant_tombstones
            (tenant_id, requested_by, requested_at, purge_after, status, proof_hash)
          VALUES
            ('tenant-a', NULL, ?, ?, 'tombstoned', NULL)
        `).run(now, now + 7 * 24 * 60 * 60 * 1000);
      } finally {
        db.close();
      }
      const traceService = { getOrLoadTrace: jest.fn() };
      setTraceProcessorServiceForTests(traceService as any);

      const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
        .send({ traceId: 'trace-a', query: 'analyze this trace' });

      expect(res.status).toBe(423);
      expect(res.body).toEqual(expect.objectContaining({
        success: false,
        code: 'TENANT_TOMBSTONED',
        status: 'tombstoned',
      }));
      expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects analyze requests while AI is disabled before trace access is evaluated', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    const traceService = { getOrLoadTrace: jest.fn() };
    setTraceProcessorServiceForTests(traceService as unknown as TraceProcessorService);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
      .send({ traceId: 'trace-a', query: 'analyze this trace' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'AI_DISABLED',
      feature: 'agent_analyze',
    });
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it('localizes Smart option validation before trace access', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'true';
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'zh-CN';
    const traceService = {getOrLoadTrace: jest.fn()};
    setTraceProcessorServiceForTests(traceService as unknown as TraceProcessorService);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
      .send({
        traceId: 'trace-a',
        referenceTraceId: 'trace-b',
        query: 'Analyze this trace',
        options: {
          preset: 'smart',
          outputLanguage: 'en',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      code: 'SMART_COMPARISON_UNSUPPORTED',
      error: 'Smart Analysis does not support dual-trace comparison yet',
    });
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it.each([
    [
      'source mode',
      {codeAwareMode: 'off', codebaseIds: ['source-a']},
      'CODEBASE_IDS_REQUIRE_CODE_AWARE_MODE',
      '选择源码库时，源码感知模式必须是 metadata_only 或 provider_send',
    ],
    [
      'RAG allowlist',
      {knowledgeSourceIds: Array.from({length: 33}, (_, index) => `wiki-${index}`)},
      'ANALYSIS_SOURCE_ALLOWLIST_TOO_LARGE',
      'knowledgeSourceIds 最多允许 32 个唯一 ID',
    ],
  ])('localizes %s validation in Chinese before trace access', async (
    _label,
    options,
    code,
    error,
  ) => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'true';
    process.env.SMARTPERFETTO_OUTPUT_LANGUAGE = 'zh-CN';
    const traceService = {getOrLoadTrace: jest.fn()};
    setTraceProcessorServiceForTests(traceService as unknown as TraceProcessorService);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
      .send({traceId: 'trace-a', query: '分析性能', options});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code, error});
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects session run requests while AI is disabled before trace access is evaluated', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    const traceService = { getOrLoadTrace: jest.fn() };
    setTraceProcessorServiceForTests(traceService as unknown as TraceProcessorService);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/sessions/session-a/runs'))
      .send({ traceId: 'trace-a', query: 'continue analysis' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'AI_DISABLED',
      feature: 'agent_analyze',
    });
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects scene reconstruction start while AI is disabled before trace access is evaluated', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    const traceService = { getOrLoadTrace: jest.fn() };
    setTraceProcessorServiceForTests(traceService as unknown as TraceProcessorService);

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/scene-reconstruct'))
      .send({ traceId: 'trace-a' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'AI_DISABLED',
      feature: 'scene_reconstruct_start',
    });
    expect(traceService.getOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects resume requests while AI is disabled before persistence restore is evaluated', async () => {
    delete process.env.SMARTPERFETTO_API_KEY;
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';

    const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/resume'))
      .send({ sessionId: 'session-disabled' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'AI_DISABLED',
      feature: 'agent_resume',
    });
  });

  it('rejects analyze when the scoped trace processor lease is draining', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-lease-'));
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | null = null;
    try {
      const traceId = 'trace-draining';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
      } as any);

      const scope = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user' };
      leaseStore = getTraceProcessorLeaseStore();
      const lease = leaseStore.acquireHolder(scope, traceId, {
        holderType: 'manual_register',
        holderRef: 'port:9100',
      });
      leaseStore.markStarting(scope, lease.id);
      leaseStore.markReady(scope, lease.id);
      leaseStore.beginDraining(scope, lease.id);

      const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
        .send({ traceId, query: 'analyze this trace' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRACE_PROCESSOR_LEASE_UNAVAILABLE');
    } finally {
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('selects an isolated lease for full analysis runs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-lease-mode-'));
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | null = null;
    try {
      const traceId = 'trace-full-analysis';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        getTrace: jest.fn(() => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(async (_lease, fn: () => Promise<unknown>) => fn()),
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      } as any);

      const res = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
        .send({
          traceId,
          query: 'analyze this trace',
          options: { analysisMode: 'full' },
        });

      expect(res.status).toBe(200);
      expect(res.body.leaseState).toBe('active');
      expect(res.body.leaseMode).toBe('isolated');
      expect(res.body.leaseModeReason).toBe('full_analysis');
      expect(res.body.leaseQueueLength).toBe(0);

      const scope = { tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'analyst-user' };
      leaseStore = getTraceProcessorLeaseStore();
      const leases = leaseStore.listLeases(scope, { traceId });
      const analysisLease = leases.find(lease => lease.id === res.body.leaseId);
      expect(analysisLease).toMatchObject({
        id: res.body.leaseId,
        mode: 'isolated',
      });
      expect(['active', 'idle']).toContain(analysisLease?.state);
    } finally {
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replays persisted terminal SSE events before falling back to the in-memory buffer', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-event-replay-'));
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | null = null;
    const deferreds: DeferredRuntime[] = [];
    try {
      const traceId = 'trace-agent-event-replay';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        getTrace: jest.fn(() => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(() => createDeferredRuntime(deferreds).promise),
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      } as any);

      const analyzeRes = await analystHeaders(request(makeApp()).post('/api/agent/v1/analyze'))
        .send({ traceId, query: 'analyze this trace' });

      expect(analyzeRes.status).toBe(200);
      const { sessionId, runId } = analyzeRes.body;
      const persistedRun = getAnalysisRunLifecycle({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      }, runId);
      expect(persistedRun).toEqual(expect.objectContaining({
        id: runId,
        status: 'running',
      }));
      expect(persistedRun?.heartbeatAt).toEqual(expect.any(Number));
      persistSerializedAgentEvent({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
        sessionId,
        runId,
        traceId,
        query: 'analyze this trace',
      }, {
        cursor: 99,
        eventType: 'analysis_completed',
        eventData: JSON.stringify({
          type: 'analysis_completed',
          data: {
            conclusion: [
              '综合结论：',
              '完成综合结论输出。冷启动TTID=1912ms，主因是主线程模拟负载过重。',
              '',
              '分阶段证据摘要：',
              '启动概览采集: 获取启动概览：冷启动dur=1338ms，TTID=1912ms。',
            ].join('\n'),
            confidence: 0.9,
            findings: [],
            reportUrl: '/api/reports/report-from-db',
            analysisReceipt: {
              schemaVersion: 1,
              runId,
              sessionId,
              traceId,
              mode: 'full',
              resolvedMode: 'full',
              providerId: 'provider-a',
              generatedAt: 1_777_000_002_000,
              traceEvidence: {
                sqlCount: 2,
                skillCount: 1,
                dataEnvelopeCount: 3,
                artifactCount: 1,
                evidenceRefCount: 4,
              },
              nonEvidenceContext: {
                frontendPrequeryCount: 0,
                memoryHintCount: 0,
                conversationContextCount: 2,
                strategyHintCount: 1,
              },
              claimAudit: {
                totalClaims: 2,
                verifiedClaims: 2,
                unsupportedClaims: 0,
                uncertainClaims: 0,
              },
              qualityGates: {
                finalReportContract: 'passed',
                claimVerification: 'passed',
                identityResolution: 'passed',
              },
              outputs: {
                reportId: 'report-from-db',
                reportUrl: '/api/reports/report-from-db',
              },
            },
            uiActionProposals: [{
              schemaVersion: 1,
              id: 'ui-pin_evidence-db',
              kind: 'pin_evidence',
              title: '固定启动证据',
              reason: '用于后续追问',
              source: { evidenceRefId: 'data:startup:summary:123' },
              payload: { evidenceRefId: 'data:startup:summary:123' },
              requiresConfirmation: true,
            }],
          },
        }),
        createdAt: 1_777_000_002_000,
      });

      const streamRes = await analystHeaders(
        request(makeApp())
          .get(`/api/agent/v1/${sessionId}/stream?lastEventId=100`)
          .set('Last-Event-ID', '98')
          .set('Accept', 'text/event-stream'),
      );

      expect(streamRes.status).toBe(200);
      expect(streamRes.text).toContain('id: 99');
      expect(streamRes.text).toContain('event: analysis_completed');
      expect(streamRes.text).toContain('/api/reports/report-from-db');
      expect(streamRes.text).toContain('"analysisReceipt"');
      expect(streamRes.text).toContain('"uiActionProposals"');
      expect(streamRes.text).toContain('ui-pin_evidence-db');
      expect(streamRes.text).toContain('"schemaVersion":1');
      expect(streamRes.text).toContain(`"runId":"${runId}"`);
      expect(streamRes.text).toContain('"claimVerification":"passed"');
      expect(streamRes.text).toContain('"partial":true');
      expect(streamRes.text).toContain('最终结果质量闸门');

      const legacyQueryStreamRes = await analystHeaders(
        request(makeApp())
          .get(`/api/agent/v1/${sessionId}/stream?lastEventId=98`)
          .set('Accept', 'text/event-stream'),
      );

      expect(legacyQueryStreamRes.status).toBe(200);
      expect(legacyQueryStreamRes.text).toContain('id: 99');
      expect(legacyQueryStreamRes.text).toContain('event: analysis_completed');
      expect(legacyQueryStreamRes.text).toContain('/api/reports/report-from-db');
      expect(legacyQueryStreamRes.text).toContain('"analysisReceipt"');
      expect(legacyQueryStreamRes.text).toContain('"uiActionProposals"');
      expect(legacyQueryStreamRes.text).toContain('ui-pin_evidence-db');
      expect(legacyQueryStreamRes.text).toContain('"schemaVersion":1');
      expect(legacyQueryStreamRes.text).toContain(`"runId":"${runId}"`);
      expect(legacyQueryStreamRes.text).toContain('"claimVerification":"passed"');
      expect(legacyQueryStreamRes.text).toContain('"partial":true');
      expect(legacyQueryStreamRes.text).toContain('最终结果质量闸门');
      leaseStore = getTraceProcessorLeaseStore();
      expect(leaseStore.listLeases({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      }, { traceId })).toHaveLength(1);
    } finally {
      await rejectPendingDeferredRuntimes(deferreds, 'event replay cleanup');
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replays buffered frontend traceContext data on first session stream connect', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-trace-context-replay-'));
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | null = null;
    const deferreds: DeferredRuntime[] = [];
    try {
      const traceId = 'trace-context-replay';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        getTrace: jest.fn(() => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(() => createDeferredRuntime(deferreds).promise),
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      } as any);

      const app = makeApp();
      const analyzeRes = await analystHeaders(request(app).post('/api/agent/v1/analyze'))
        .send({
          traceId,
          query: 'selection fact',
          traceContext: [{
            label: 'Selected FPS summary',
            columns: ['metric', 'value'],
            rows: [['janky_frames', 21]],
          }],
          options: { analysisMode: 'fast' },
        });

      expect(analyzeRes.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 0));

      const cancelRes = await analystHeaders(
        request(app).post(`/api/agent/v1/${analyzeRes.body.sessionId}/cancel`),
      ).send({ runId: analyzeRes.body.runId });
      expect(cancelRes.status).toBe(200);

      const streamRes = await analystHeaders(
        request(app)
          .get(`/api/agent/v1/${analyzeRes.body.sessionId}/stream`)
          .set('Accept', 'text/event-stream'),
      );

      expect(streamRes.status).toBe(200);
      expect(streamRes.text).toContain('event: data');
      expect(streamRes.text).toContain('data:frontend_prequery:current:');
      expect(streamRes.text).toContain('"sourceToolCallId":"frontend-prequery:');
      expect(streamRes.text).toContain('event: analysis_cancelled');
      leaseStore = getTraceProcessorLeaseStore();
      expect(leaseStore.listLeases({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      }, { traceId })).toHaveLength(1);
    } finally {
      await rejectPendingDeferredRuntimes(deferreds, 'trace context replay cleanup');
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes dual-trace pane context through continued comparison session runs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-dual-pane-'));
    const capturedOptions: AnalysisOptions[] = [];
    const analyzeResult = (sessionId: string): AnalysisResult => ({
      sessionId,
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'ok',
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 1,
    });
    const waitForAnalyzeCallCount = async (count: number): Promise<void> => {
      for (let attempt = 0; attempt < 20 && capturedOptions.length < count; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(capturedOptions).toHaveLength(count);
    };

    try {
      const traceId = 'trace-dual-pane-current';
      const referenceTraceId = 'trace-dual-pane-reference';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      const referenceTracePath = path.join(tmpDir, `${referenceTraceId}.trace`);
      await fs.writeFile(tracePath, 'current trace bytes');
      await fs.writeFile(referenceTracePath, 'reference trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';

      await writeTraceMetadata({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 19,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: tracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });
      await writeTraceMetadata({
        id: referenceTraceId,
        filename: `${referenceTraceId}.trace`,
        size: 21,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: referenceTracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockImplementation(async (id: string) => ({
        id,
        filename: `${id}.trace`,
        size: id === referenceTraceId ? 21 : 19,
        filePath: id === referenceTraceId ? referenceTracePath : tracePath,
        uploadTime: new Date(),
        status: 'ready',
      }));
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease').mockResolvedValue({
        id: 'processor-dual-pane',
        traceId,
        status: 'ready',
        activeQueries: 0,
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
        queryRaw: jest.fn(async () => Buffer.alloc(0)),
        destroy: jest.fn(),
      });
      jest.spyOn(traceProcessorService, 'runWithLease').mockImplementation(async (_context, callback) => callback());
      jest.spyOn(traceProcessorService, 'runWithLeases').mockImplementation(async (_contexts, callback) => callback());
      jest.spyOn(traceProcessorService, 'query').mockResolvedValue({
        columns: [],
        rows: [],
        durationMs: 1,
      });
      setTraceProcessorServiceForTests(traceProcessorService);
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async (
        _query,
        sessionId,
        _traceId,
        options = {},
      ) => {
        capturedOptions.push(options);
        return analyzeResult(sessionId);
      });

      const initialTracePairContext: TracePairContext = {
        schemaVersion: 1,
        layout: 'horizontal',
        primarySide: 'left',
        referenceSide: 'right',
        activeSide: 'left',
        workspaceOpen: true,
        splitPercent: 55,
        aliases: { left: 'current', right: 'reference', main: 'current', baseline: 'reference' },
        panes: [
          {
            side: 'left',
            traceSide: 'current',
            traceId,
            traceName: 'current.trace',
            active: true,
            visualState: 'live',
          },
          {
            side: 'right',
            traceSide: 'reference',
            traceId: referenceTraceId,
            traceName: 'reference.trace',
            visualState: 'live',
          },
        ],
      };
      const continuedTracePairContext: TracePairContext = {
        schemaVersion: 1,
        layout: 'vertical',
        primarySide: 'top',
        referenceSide: 'bottom',
        activeSide: 'bottom',
        workspaceOpen: true,
        splitPercent: 42,
        maximizedTraceSide: 'reference',
        minimizedTraceSides: ['current'],
        aliases: { top: 'current', bottom: 'reference', current: 'current', reference: 'reference' },
        panes: [
          {
            side: 'top',
            traceSide: 'current',
            traceId,
            traceName: 'current.trace',
            visualState: 'context_only',
          },
          {
            side: 'bottom',
            traceSide: 'reference',
            traceId: referenceTraceId,
            traceName: 'reference.trace',
            active: true,
            visualState: 'live',
          },
        ],
      };

      const app = makeApp();
      const firstRun = await analystHeaders(request(app).post('/api/agent/v1/analyze'))
        .send({
          traceId,
          referenceTraceId,
          query: '对比左右两个 trace',
          options: {
            analysisMode: 'auto',
            tracePairContext: initialTracePairContext,
          },
        });
      expect(firstRun.status).toBe(200);
      await waitForAnalyzeCallCount(1);

      const continuedRun = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${firstRun.body.sessionId}/runs`),
      ).send({
        traceId,
        query: '现在对比上面和下面的启动耗时',
        options: {
          analysisMode: 'auto',
          tracePairContext: continuedTracePairContext,
        },
      });
      expect(continuedRun.status).toBe(200);
      await waitForAnalyzeCallCount(2);

      expect(capturedOptions[0]).toEqual(expect.objectContaining({
        referenceTraceId,
        tracePairContext: initialTracePairContext,
      }));
      expect(capturedOptions[1]).toEqual(expect.objectContaining({
        referenceTraceId,
        tracePairContext: continuedTracePairContext,
      }));
    } finally {
      delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replays buffered quick pre-evidence data when the first session stream connects after completion', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-completed-data-replay-'));
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | null = null;
    try {
      const traceId = 'completed-data-replay';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

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
      jest.spyOn(traceProcessorService, 'getTrace').mockReturnValue({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        filePath: tracePath,
        uploadTime: new Date(),
        status: 'ready',
      });
      const readyProcessor: TraceProcessor = {
        id: `processor-${traceId}`,
        traceId,
        status: 'ready',
        activeQueries: 0,
        query: jest.fn(async () => ({
          columns: [],
          rows: [],
          durationMs: 1,
        })),
        queryRaw: jest.fn(async () => Buffer.alloc(0)),
        destroy: jest.fn(),
      };
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease').mockResolvedValue(readyProcessor);
      jest.spyOn(traceProcessorService, 'runWithLease').mockImplementation(async (_context, callback) => callback());
      jest.spyOn(traceProcessorService, 'query').mockResolvedValue({
        columns: [
          'android_device_manufacturer',
          'android_build_fingerprint',
          'android_sdk_version',
          'android_soc_model',
          'system_name',
          'system_release',
          'system_machine',
          'source_table',
        ],
        rows: [[
          'OPPO',
          'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.2a01376:user/release-keys',
          36,
          'SM8750',
          'Linux',
          '6.6.89-android15',
          'aarch64',
          'metadata',
        ]],
        durationMs: 1,
      });
      setTraceProcessorServiceForTests(traceProcessorService);

      const app = makeApp();
      const analyzeRes = await analystHeaders(request(app).post('/api/agent/v1/analyze'))
        .send({
          traceId,
          query: '设备型号是什么？',
          options: { analysisMode: 'auto' },
        });

      expect(analyzeRes.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 25));

      const streamRes = await analystHeaders(
        request(app)
          .get(`/api/agent/v1/${analyzeRes.body.sessionId}/stream`)
          .set('Accept', 'text/event-stream'),
      );

      expect(streamRes.status).toBe(200);
      expect(streamRes.text).toContain('event: data');
      expect(streamRes.text).toContain('runtime_trace_fact:device_info');
      expect(streamRes.text).toContain('data:runtime_trace_fact:device_info:current:');
      expect(streamRes.text).toContain('event: analysis_completed');
      expect(streamRes.text).toContain('"actualTurns":0');
      const streamedReceipt = streamRes.text.match(
        /"analysisReceipt":\{"schemaVersion":2,"runManifestId":"([^"]+)"/,
      );
      expect(streamedReceipt?.[1]).toEqual(expect.any(String));

      const statusRes = await analystHeaders(
        request(app).get(`/api/agent/v1/${analyzeRes.body.sessionId}/status`),
      );
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.result.analysisReceipt).toEqual(expect.objectContaining({
        schemaVersion: 2,
        runManifestId: streamedReceipt?.[1],
      }));
      leaseStore = getTraceProcessorLeaseStore();
      expect(leaseStore.listLeases({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      }, { traceId }).length).toBeGreaterThanOrEqual(1);
    } finally {
      leaseStore?.close();
      delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps concurrent analyzes isolated when one user cancels their own run', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-concurrency-'));
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | null = null;
    const sessionIds: string[] = [];
    const deferreds: DeferredRuntime[] = [];
    try {
      const traces = new Map<string, { traceId: string; workspaceId: string; userId: string; tracePath: string }>();
      for (const item of [
        { traceId: 'trace-concurrent-a', workspaceId: 'workspace-a', userId: 'analyst-a' },
        { traceId: 'trace-concurrent-b', workspaceId: 'workspace-b', userId: 'analyst-b' },
      ]) {
        const tracePath = path.join(tmpDir, `${item.traceId}.trace`);
        await fs.writeFile(tracePath, `${item.traceId} bytes`);
        traces.set(item.traceId, { ...item, tracePath });
      }

      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

      for (const item of traces.values()) {
        await writeTraceMetadata({
          id: item.traceId,
          filename: `${item.traceId}.trace`,
          size: 16,
          uploadedAt: new Date().toISOString(),
          status: 'ready',
          path: item.tracePath,
          tenantId: 'tenant-a',
          workspaceId: item.workspaceId,
          userId: item.userId,
        });
      }

      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async (traceId: string) => {
          const item = traces.get(traceId);
          if (!item) throw new Error(`missing trace fixture: ${traceId}`);
          return {
            id: item.traceId,
            filename: `${item.traceId}.trace`,
            size: 16,
            filePath: item.tracePath,
            uploadTime: new Date(),
            status: 'ready',
          };
        }),
        getTrace: jest.fn((traceId: string) => {
          const item = traces.get(traceId);
          if (!item) return undefined;
          return {
            id: item.traceId,
            filename: `${item.traceId}.trace`,
            size: 16,
            filePath: item.tracePath,
            uploadTime: new Date(),
            status: 'ready',
          };
        }),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(() => createDeferredRuntime(deferreds).promise),
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      } as any);

      const app = makeApp();
      const [analyzeA, analyzeB] = await Promise.all([
        scopedAnalystHeaders(
          request(app).post('/api/agent/v1/analyze'),
          { userId: 'analyst-a', workspaceId: 'workspace-a' },
        ).send({ traceId: 'trace-concurrent-a', query: 'analyze trace a' }),
        scopedAnalystHeaders(
          request(app).post('/api/agent/v1/analyze'),
          { userId: 'analyst-b', workspaceId: 'workspace-b' },
        ).send({ traceId: 'trace-concurrent-b', query: 'analyze trace b' }),
      ]);

      expect(analyzeA.status).toBe(200);
      expect(analyzeB.status).toBe(200);
      sessionIds.push(analyzeA.body.sessionId, analyzeB.body.sessionId);
      expect(analyzeA.body.sessionId).not.toBe(analyzeB.body.sessionId);
      expect(analyzeA.body.runId).not.toBe(analyzeB.body.runId);

      const [crossRunStream, missingRunStream] = await Promise.all([
        scopedAnalystHeaders(
          request(app)
            .get(`/api/agent/v1/runs/${analyzeB.body.runId}/stream`)
            .set('Accept', 'text/event-stream'),
          { userId: 'analyst-a', workspaceId: 'workspace-a' },
        ),
        scopedAnalystHeaders(
          request(app)
            .get('/api/agent/v1/runs/run-missing-security/stream')
            .set('Accept', 'text/event-stream'),
          { userId: 'analyst-a', workspaceId: 'workspace-a' },
        ),
      ]);
      expect(crossRunStream.status).toBe(404);
      expect(crossRunStream.body).toEqual({ success: false, error: 'Run not found' });
      expect(missingRunStream.status).toBe(404);
      expect(missingRunStream.body).toEqual({ success: false, error: 'Run not found' });

      const [cancelA, statusB] = await Promise.all([
        scopedAnalystHeaders(
          request(app).post(`/api/agent/v1/${analyzeA.body.sessionId}/cancel`),
          { userId: 'analyst-a', workspaceId: 'workspace-a' },
        ).send({ runId: analyzeA.body.runId }),
        scopedAnalystHeaders(
          request(app).get(`/api/agent/v1/${analyzeB.body.sessionId}/status`),
          { userId: 'analyst-b', workspaceId: 'workspace-b' },
        ),
      ]);

      expect(cancelA.status).toBe(200);
      expect(cancelA.body).toEqual(expect.objectContaining({
        sessionId: analyzeA.body.sessionId,
        status: 'cancelled',
      }));
      expect(getAnalysisRunLifecycle({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-a',
      }, analyzeA.body.runId)).toEqual(expect.objectContaining({
        id: analyzeA.body.runId,
        status: 'cancelled',
      }));
      const readTerminalEventCounts = () => {
        const db = openEnterpriseDb();
        try {
          return db.prepare(`
            SELECT event_type AS eventType, COUNT(*) AS count
            FROM agent_events
            WHERE run_id = ?
              AND event_type IN ('analysis_cancelled', 'end')
            GROUP BY event_type
            ORDER BY event_type
          `).all(analyzeA.body.runId);
        } finally {
          db.close();
        }
      };
      const enterpriseDb = openEnterpriseDb();
      try {
        expect(enterpriseDb.prepare('SELECT status FROM analysis_sessions WHERE id = ?')
          .get(analyzeA.body.sessionId)).toEqual({ status: 'cancelled' });
      } finally {
        enterpriseDb.close();
      }
      expect(readTerminalEventCounts()).toEqual([
        { eventType: 'analysis_cancelled', count: 1 },
        { eventType: 'end', count: 1 },
      ]);
      const cancelledStream = await scopedAnalystHeaders(
        request(app)
          .get(`/api/agent/v1/${analyzeA.body.sessionId}/stream`)
          .set('Accept', 'text/event-stream'),
        { userId: 'analyst-a', workspaceId: 'workspace-a' },
      );
      expect(cancelledStream.status).toBe(200);
      expect(cancelledStream.text).toContain('event: analysis_cancelled');
      expect(cancelledStream.text).toContain('event: end');
      const repeatedCancelledStream = await scopedAnalystHeaders(
        request(app)
          .get(`/api/agent/v1/${analyzeA.body.sessionId}/stream`)
          .set('Accept', 'text/event-stream'),
        { userId: 'analyst-a', workspaceId: 'workspace-a' },
      );
      expect(repeatedCancelledStream.status).toBe(200);
      expect(repeatedCancelledStream.text).toContain('event: analysis_cancelled');
      expect(repeatedCancelledStream.text).toContain('event: end');
      expect(readTerminalEventCounts()).toEqual([
        { eventType: 'analysis_cancelled', count: 1 },
        { eventType: 'end', count: 1 },
      ]);
      expect(statusB.status).toBe(200);
      expect(statusB.body).toEqual(expect.objectContaining({
        sessionId: analyzeB.body.sessionId,
        status: 'running',
      }));

      const crossStatus = await scopedAnalystHeaders(
        request(app).get(`/api/agent/v1/${analyzeB.body.sessionId}/status`),
        { userId: 'analyst-a', workspaceId: 'workspace-a' },
      );
      expect(crossStatus.status).toBe(404);

      const cancelB = await scopedAnalystHeaders(
        request(app).post(`/api/agent/v1/${analyzeB.body.sessionId}/cancel`),
        { userId: 'analyst-b', workspaceId: 'workspace-b' },
      ).send({ runId: analyzeB.body.runId });
      expect(cancelB.status).toBe(200);

      leaseStore = getTraceProcessorLeaseStore();
      expect(leaseStore.listLeases({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-a',
      }, { traceId: 'trace-concurrent-a' })).toHaveLength(1);
      expect(leaseStore.listLeases({
        tenantId: 'tenant-a',
        workspaceId: 'workspace-b',
        userId: 'analyst-b',
      }, { traceId: 'trace-concurrent-b' })).toHaveLength(1);
    } finally {
      await rejectPendingDeferredRuntimes(deferreds, 'concurrency cleanup');
      for (const sessionId of sessionIds) {
        sessionContextManager.remove(sessionId);
      }
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  for (const lateOutcome of ['reject', 'success'] as const) {
    it(`keeps a same-session replacement run isolated when cancelled run A resolves late with ${lateOutcome}`, async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `smartperfetto-agent-same-session-${lateOutcome}-`));
      const sessionIds: string[] = [];
      const deferreds: Array<{
        promise: Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }> = [];
      const makeDeferred = () => {
        let resolve!: (value: unknown) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const deferred = { promise, resolve, reject };
        deferreds.push(deferred);
        return deferred;
      };

      try {
        const abortSpy = jest.spyOn(ClaudeRuntime.prototype, 'abortSession')
          .mockImplementation(() => undefined);
        const traceId = `trace-same-session-${lateOutcome}`;
        const tracePath = path.join(tmpDir, `${traceId}.trace`);
        await fs.writeFile(tracePath, `${traceId} bytes`);

        delete process.env.SMARTPERFETTO_API_KEY;
        process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
        process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
        process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
        process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
        process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

        await writeTraceMetadata({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 16,
          uploadedAt: new Date().toISOString(),
          status: 'ready',
          path: tracePath,
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        });

        setTraceProcessorServiceForTests({
          getOrLoadTrace: jest.fn(async () => ({
            id: traceId,
            filename: `${traceId}.trace`,
            size: 16,
            filePath: tracePath,
            uploadTime: new Date(),
            status: 'ready',
          })),
          getTrace: jest.fn(() => ({
            id: traceId,
            filename: `${traceId}.trace`,
            size: 16,
            filePath: tracePath,
            uploadTime: new Date(),
            status: 'ready',
          })),
          ensureProcessorForLease: jest.fn(async () => undefined),
          runWithLease: jest.fn(() => makeDeferred().promise),
          query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
        } as any);

        const app = makeApp();
        const analyzeA = await analystHeaders(
          request(app).post('/api/agent/v1/analyze'),
        ).send({ traceId, query: 'run A' });
        expect(analyzeA.status).toBe(200);
        sessionIds.push(analyzeA.body.sessionId);
        expect(deferreds).toHaveLength(1);

        const cancelA = await analystHeaders(
          request(app).post(`/api/agent/v1/${analyzeA.body.sessionId}/cancel`),
        ).send({ runId: analyzeA.body.runId });
        expect(cancelA.status).toBe(200);
        expect(cancelA.body.status).toBe('cancelled');
        expect(abortSpy).toHaveBeenCalledTimes(1);

        const analyzeBBeforeSettle = await analystHeaders(
          request(app).post(`/api/agent/v1/sessions/${analyzeA.body.sessionId}/runs`),
        ).send({ traceId, query: 'run B' });
        expect(analyzeBBeforeSettle.status).toBe(409);
        expect(analyzeBBeforeSettle.body).toEqual(expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId: analyzeA.body.runId,
        }));
        expect(deferreds).toHaveLength(1);

        const repeatedCancelA = await analystHeaders(
          request(app).post(`/api/agent/v1/${analyzeA.body.sessionId}/cancel`),
        ).send({ runId: analyzeA.body.runId });
        expect(repeatedCancelA.status).toBe(200);
        expect(repeatedCancelA.body).toEqual(expect.objectContaining({
          runId: analyzeA.body.runId,
          outcome: 'already_cancelled',
        }));
        expect(abortSpy).toHaveBeenCalledTimes(1);

        const statusAfterRepeatedCancelA = await analystHeaders(
          request(app).get(`/api/agent/v1/${analyzeA.body.sessionId}/status`),
        );
        expect(statusAfterRepeatedCancelA.body).toEqual(expect.objectContaining({
          status: 'cancelled',
          observability: expect.objectContaining({ runId: analyzeA.body.runId }),
        }));

        if (lateOutcome === 'reject') {
          deferreds[0].reject(new Error('late run A failure'));
        } else {
          deferreds[0].resolve({
            sessionId: analyzeA.body.sessionId,
            success: true,
            findings: [],
            hypotheses: [],
            conclusion: 'late run A success should be ignored',
            confidence: 0.9,
            rounds: 1,
            totalDurationMs: 10,
          });
        }
        await new Promise(resolve => setTimeout(resolve, 0));

        const analyzeB = await analystHeaders(
          request(app).post(`/api/agent/v1/sessions/${analyzeA.body.sessionId}/runs`),
        ).send({ traceId, query: 'run B' });
        expect(analyzeB.status).toBe(200);
        expect(analyzeB.body.sessionId).toBe(analyzeA.body.sessionId);
        expect(analyzeB.body.runId).not.toBe(analyzeA.body.runId);
        expect(deferreds).toHaveLength(2);

        const statusAfterLateA = await analystHeaders(
          request(app).get(`/api/agent/v1/${analyzeA.body.sessionId}/status`),
        );
        expect(statusAfterLateA.status).toBe(200);
        expect(statusAfterLateA.body.status).toBe('running');
        expect(statusAfterLateA.body.observability).toEqual(expect.objectContaining({
          runId: analyzeB.body.runId,
        }));

        expect(getAnalysisRunLifecycle({
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        }, analyzeA.body.runId)).toEqual(expect.objectContaining({
          id: analyzeA.body.runId,
          status: 'cancelled',
        }));
        expect(getAnalysisRunLifecycle({
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        }, analyzeB.body.runId)).toEqual(expect.objectContaining({
          id: analyzeB.body.runId,
          status: 'running',
        }));

        const db = openEnterpriseDb();
        try {
          expect(db.prepare('SELECT status FROM analysis_sessions WHERE id = ?')
            .get(analyzeA.body.sessionId)).toEqual({ status: 'running' });
        } finally {
          db.close();
        }

        const runAStream = await analystHeaders(
          request(app)
            .get(`/api/agent/v1/runs/${analyzeA.body.runId}/stream`)
            .set('Accept', 'text/event-stream'),
        );
        expect(runAStream.status).toBe(200);
        expect(runAStream.text).toContain('event: analysis_cancelled');
        expect(runAStream.text).toContain(analyzeA.body.runId);
        expect(runAStream.text).not.toContain(analyzeB.body.runId);

        const cancelB = await analystHeaders(
          request(app).post(`/api/agent/v1/${analyzeA.body.sessionId}/cancel`),
        ).send({ runId: analyzeB.body.runId });
        expect(cancelB.status).toBe(200);
        deferreds[1].reject(new Error('cleanup B'));
        await new Promise(resolve => setTimeout(resolve, 0));
      } finally {
        for (const sessionId of sessionIds) {
          sessionContextManager.remove(sessionId);
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  }

  it('replays cancelled run A from the in-memory run ring after run B becomes current when persisted replay is unavailable', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-same-session-memory-'));
    const sessionIds: string[] = [];
    const deferreds: Array<{
      promise: Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }> = [];
    const makeDeferred = () => {
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const deferred = { promise, resolve, reject };
      deferreds.push(deferred);
      return deferred;
    };

    try {
      const traceId = 'trace-same-session-memory-replay';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, `${traceId} bytes`);

      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');

      await writeTraceMetadata({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 16,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: tracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });

      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 16,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        getTrace: jest.fn(() => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 16,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(() => makeDeferred().promise),
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      } as any);

      const app = makeApp();
      const analyzeA = await analystHeaders(
        request(app).post('/api/agent/v1/analyze'),
      ).send({ traceId, query: 'run A' });
      expect(analyzeA.status).toBe(200);
      sessionIds.push(analyzeA.body.sessionId);

      const cancelA = await analystHeaders(
        request(app).post(`/api/agent/v1/${analyzeA.body.sessionId}/cancel`),
      ).send({ runId: analyzeA.body.runId });
      expect(cancelA.status).toBe(200);
      expect(cancelA.body.status).toBe('cancelled');

      const analyzeBBeforeSettle = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${analyzeA.body.sessionId}/runs`),
      ).send({ traceId, query: 'run B' });
      expect(analyzeBBeforeSettle.status).toBe(409);
      expect(analyzeBBeforeSettle.body).toEqual(expect.objectContaining({
        code: 'CANCELLATION_IN_PROGRESS',
        runId: analyzeA.body.runId,
      }));

      deferreds[0].reject(new Error('late run A failure'));
      await new Promise(resolve => setTimeout(resolve, 0));

      const analyzeB = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${analyzeA.body.sessionId}/runs`),
      ).send({ traceId, query: 'run B' });
      expect(analyzeB.status).toBe(200);
      expect(analyzeB.body.sessionId).toBe(analyzeA.body.sessionId);
      expect(analyzeB.body.runId).not.toBe(analyzeA.body.runId);

      const db = openEnterpriseDb();
      try {
        db.prepare('DELETE FROM agent_events WHERE run_id = ?').run(analyzeA.body.runId);
      } finally {
        db.close();
      }

      const runAStream = await analystHeaders(
        request(app)
          .get(`/api/agent/v1/runs/${analyzeA.body.runId}/stream`)
          .set('Accept', 'text/event-stream'),
      );
      expect(runAStream.status).toBe(200);
      expect(runAStream.text).toContain('event: analysis_cancelled');
      expect(runAStream.text).toContain('event: end');
      expect(runAStream.text).toContain(analyzeA.body.runId);
      expect(runAStream.text).not.toContain(analyzeB.body.runId);

      const cancelB = await analystHeaders(
        request(app).post(`/api/agent/v1/${analyzeA.body.sessionId}/cancel`),
      ).send({ runId: analyzeB.body.runId });
      expect(cancelB.status).toBe(200);
      deferreds.forEach((deferred, index) => deferred.reject(new Error(`cleanup ${index}`)));
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      for (const sessionId of sessionIds) {
        sessionContextManager.remove(sessionId);
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resumes a persisted enterprise session and accepts an authorized respond action', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-resume-'));
    try {
      const traceId = 'trace-resume-integration';
      const sessionId = 'session-resume-integration';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      SessionPersistenceService.resetForTests();

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
      } as any);

      const context = new EnhancedSessionContext(sessionId, traceId);
      context.addTurn('resume this persisted session', {
        primaryGoal: 'resume_integration',
        aspects: ['agent_resume', 'respond'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
      });
      const persistence = SessionPersistenceService.getInstance();
      persistence.saveSession({
        id: sessionId,
        traceId,
        traceName: `${traceId}.trace`,
        question: 'resume this persisted session',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now(),
        messages: [],
        metadata: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        },
      });
      expect(persistence.saveSessionContext(sessionId, context)).toBe(true);

      const resumeRes = await analystHeaders(request(makeApp()).post('/api/agent/v1/resume'))
        .send({ sessionId, traceId });

      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body).toEqual(expect.objectContaining({
        success: true,
        sessionId,
        traceId,
        restored: true,
        status: 'completed',
      }));
      expect(resumeRes.body.restoredStats).toEqual(expect.objectContaining({
        turnCount: 1,
      }));

      const respondRes = await analystHeaders(
        request(makeApp())
          .post(`/api/agent/v1/${sessionId}/respond`)
          .send({ action: 'abort', runId: `run-${sessionId}-1` }),
      );

      expect(respondRes.status).toBe(404);
      expect(respondRes.body).toEqual(expect.objectContaining({
        success: false,
        sessionId,
        runId: `run-${sessionId}-1`,
        code: 'RUN_NOT_FOUND',
      }));
    } finally {
      sessionContextManager.remove('session-resume-integration');
      SessionPersistenceService.resetForTests();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves quota_exceeded status when resuming from a persisted run snapshot', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-resume-quota-'));
    const traceId = 'trace-resume-quota';
    const sessionId = 'session-resume-quota';
    try {
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      SessionPersistenceService.resetForTests();

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
      } as any);

      const context = new EnhancedSessionContext(sessionId, traceId);
      context.addTurn('resume this persisted session', {
        primaryGoal: 'resume_quota',
        aspects: ['agent_resume'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
      });
      const persistence = SessionPersistenceService.getInstance();
      persistence.saveSession({
        id: sessionId,
        traceId,
        traceName: `${traceId}.trace`,
        question: 'resume this persisted session',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now(),
        messages: [],
        metadata: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        },
      });
      expect(persistence.saveSessionStateSnapshot(
        sessionId,
        minimalSessionSnapshot(sessionId, traceId, 'quota_exceeded'),
        {
          sessionContext: context,
          owner: {
            tenantId: 'tenant-a',
            workspaceId: 'workspace-a',
            userId: 'analyst-user',
          },
        },
      )).toBe(true);

      const resumeRes = await analystHeaders(request(makeApp()).post('/api/agent/v1/resume'))
        .send({ sessionId, traceId });

      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body).toEqual(expect.objectContaining({
        success: true,
        sessionId,
        traceId,
        restored: true,
        status: 'quota_exceeded',
      }));
    } finally {
      sessionContextManager.remove(sessionId);
      SessionPersistenceService.resetForTests();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('marks recovered phase-summary results as partial during resume', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-resume-quality-'));
    const traceId = 'trace-resume-quality';
    const sessionId = 'session-resume-quality';
    try {
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      SessionPersistenceService.resetForTests();

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        getTrace: jest.fn(() => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
        ensureProcessorForLease: jest.fn(async () => undefined),
        runWithLease: jest.fn(async () => undefined),
        query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
      } as any);

      const context = new EnhancedSessionContext(sessionId, traceId);
      context.addTurn(
        '分析这个启动 trace',
        {
          primaryGoal: 'startup_quality_gate',
          aspects: ['agent_resume'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
        },
        {
          success: true,
          findings: [],
          message: [
            '综合结论：',
            '完成综合结论输出。冷启动TTID=1912ms，主因是主线程模拟负载过重。',
            '',
            '分阶段证据摘要：',
            '启动概览采集: 获取启动概览：冷启动dur=1338ms，TTID=1912ms。',
            '启动详情分析: 四象限：Q1=62.8%,Q4b=35.1%。',
          ].join('\n'),
          confidence: 0.9,
        },
      );
      const persistence = SessionPersistenceService.getInstance();
      persistence.saveSession({
        id: sessionId,
        traceId,
        traceName: `${traceId}.trace`,
        question: '分析这个启动 trace',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now(),
        messages: [],
        metadata: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        },
      });
      expect(persistence.saveSessionStateSnapshot(
        sessionId,
        minimalSessionSnapshot(sessionId, traceId, 'completed'),
        {
          sessionContext: context,
          owner: {
            tenantId: 'tenant-a',
            workspaceId: 'workspace-a',
            userId: 'analyst-user',
          },
        },
      )).toBe(true);

      const app = makeApp();
      const resumeRes = await analystHeaders(request(app).post('/api/agent/v1/resume'))
        .send({ sessionId, traceId });

      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.restoredStats.latestTurn).toEqual(expect.objectContaining({
        partial: true,
        terminationMessage: expect.stringContaining('最终结果质量闸门'),
      }));

      const statusRes = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.result).toEqual(expect.objectContaining({
        partial: true,
        terminationMessage: expect.stringContaining('最终结果质量闸门'),
      }));

      const turnsRes = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/turns`));
      expect(turnsRes.status).toBe(200);
      expect(turnsRes.body.latestTurn).toEqual(expect.objectContaining({
        partial: true,
        terminationMessage: expect.stringContaining('最终结果质量闸门'),
      }));

      const turnDetailRes = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/turns/latest`));
      expect(turnDetailRes.status).toBe(200);
      expect(turnDetailRes.body.turn).toEqual(expect.objectContaining({
        partial: true,
        terminationMessage: expect.stringContaining('最终结果质量闸门'),
        result: expect.objectContaining({
          partial: true,
          terminationMessage: expect.stringContaining('最终结果质量闸门'),
        }),
      }));
    } finally {
      sessionContextManager.remove(sessionId);
      SessionPersistenceService.resetForTests();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not restore an interrupted running snapshot as completed', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-resume-running-'));
    const traceId = 'trace-resume-running';
    const sessionId = 'session-resume-running';
    try {
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      SessionPersistenceService.resetForTests();

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
      setTraceProcessorServiceForTests({
        getOrLoadTrace: jest.fn(async () => ({
          id: traceId,
          filename: `${traceId}.trace`,
          size: 11,
          filePath: tracePath,
          uploadTime: new Date(),
          status: 'ready',
        })),
      } as any);

      const context = new EnhancedSessionContext(sessionId, traceId);
      context.addTurn(
        'previous completed analysis',
        {
          primaryGoal: 'previous_completed',
          aspects: ['agent_resume'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
        },
        {
          success: true,
          findings: [],
          message: 'previous completed conclusion',
          confidence: 0.8,
        },
      );
      const persistence = SessionPersistenceService.getInstance();
      persistence.saveSession({
        id: sessionId,
        traceId,
        traceName: `${traceId}.trace`,
        question: 'resume running session',
        createdAt: Date.now() - 1000,
        updatedAt: Date.now(),
        messages: [],
        metadata: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        },
      });
      expect(persistence.saveSessionStateSnapshot(
        sessionId,
        minimalSessionSnapshot(sessionId, traceId, 'running'),
        {
          sessionContext: context,
          owner: {
            tenantId: 'tenant-a',
            workspaceId: 'workspace-a',
            userId: 'analyst-user',
          },
        },
      )).toBe(true);

      const resumeRes = await analystHeaders(request(makeApp()).post('/api/agent/v1/resume'))
        .send({ sessionId, traceId });

      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body).toEqual(expect.objectContaining({
        success: true,
        sessionId,
        traceId,
        restored: true,
        status: 'failed',
      }));
    } finally {
      sessionContextManager.remove(sessionId);
      SessionPersistenceService.resetForTests();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
