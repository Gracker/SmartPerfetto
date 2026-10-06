// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {EventEmitter} from 'events';
import express from 'express';
import request from 'supertest';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import criticalPathRoutes from '../criticalPathRoutes';
import {authenticate} from '../../middleware/auth';
import {rejectEnterpriseUnscopedApi} from '../../middleware/enterpriseRouteBoundary';
import {bindWorkspaceRouteContext, requireWorkspaceRouteContext} from '../../middleware/workspaceRouteContext';
import {clientDisconnectSignal} from '../clientDisconnect';
import {selectRuntimeForProvider} from '../../agentRuntime/runtimeSelection';
import {hasClaudeCredentials, sdkEnvForProviderEnv} from '../../agentv3/claudeConfig';
import {AI_CAPABILITY_ENV_KEY} from '../../services/aiCapabilityPolicy';
import {summarizeCriticalPathWithAi} from '../../services/criticalPathAiSummary';
import {CriticalPathInputError, analyzeCriticalPath} from '../../services/criticalPathAnalyzer';
import {readTraceMetadataForContext} from '../../services/traceMetadataStore';
import {getTraceProcessorService} from '../../services/traceProcessorService';
import {renderCriticalPathAnalysis} from '../../services/criticalPathLocalization';
import type {CriticalPathAnalysis} from '../../types/criticalPathContract';

import {createLoopbackServerFixture} from '../../../tests/helpers/loopbackServer';

const loopbackServers = createLoopbackServerFixture();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('../../agentRuntime/runtimeSelection', () => ({
  selectRuntimeForProvider: jest.fn(),
}));

// One provider read per summary: the store is faked so the test can count it.
const mockProviderService = {
  getRawEffectiveProvider: jest.fn<(...args: any[]) => any>(),
  getRawProvider: jest.fn<(...args: any[]) => any>(),
  getEnvForProviderConfig: jest.fn<(...args: any[]) => any>(),
};
jest.mock('../../services/providerManager', () => ({
  ...(jest.requireActual('../../services/providerManager') as object),
  getProviderService: () => mockProviderService,
}));

jest.mock('../../agentv3/claudeConfig', () => ({
  sdkEnvForProviderEnv: jest.fn(),
  hasClaudeCredentials: jest.fn(),
  loadClaudeConfig: jest.fn(() => ({model: 'env-model'})),
  runtimeConfigForProviderEnv: jest.fn(() => ({model: 'profile-model'})),
  getSdkBinaryOption: jest.fn(() => ({})),
  resolveClaudeSdkPermissionOptions: jest.fn(() => ({permissionMode: 'dontAsk'})),
}));

jest.mock('../../services/criticalPathAnalyzer', () => ({
  ...(jest.requireActual('../../services/criticalPathAnalyzer') as object),
  analyzeCriticalPath: jest.fn(),
}));

jest.mock('../../services/traceMetadataStore', () => ({
  ...(jest.requireActual('../../services/traceMetadataStore') as object),
  readTraceMetadataForContext: jest.fn(),
}));

jest.mock('../../services/traceProcessorService', () => ({
  getTraceProcessorService: jest.fn(),
}));

const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const mockSelection = selectRuntimeForProvider as unknown as jest.Mock<(...args: any[]) => any>;
const mockCreateSdkEnv = sdkEnvForProviderEnv as unknown as jest.Mock<(...args: any[]) => any>;
const mockHasClaudeCredentials = hasClaudeCredentials as unknown as jest.Mock<(...args: any[]) => any>;
const mockAnalyze = analyzeCriticalPath as unknown as jest.Mock<(...args: any[]) => any>;
const mockReadMetadata = readTraceMetadataForContext as unknown as jest.Mock<(...args: any[]) => any>;
const mockGetTraceProcessorService = getTraceProcessorService as unknown as jest.Mock<(...args: any[]) => any>;
const mockGetOrLoadTrace = jest.fn<(...args: any[]) => any>();

const REQUEST_CONTEXT = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'dev',
  roles: ['org_admin'],
  scopes: ['*'],
  requestId: 'req-test',
};
const PROVIDER_SCOPE = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};

// A viewer may read the trace but not start model work (`agent:run`).
const VIEWER_CONTEXT = {...REQUEST_CONTEXT, roles: ['viewer'], scopes: []};

async function makeApp(context: object = REQUEST_CONTEXT) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.requestContext = context;
    next();
  });
  app.use('/api/critical-path', criticalPathRoutes);
  return loopbackServers.listen(app);
}

function analysisFixture(): CriticalPathAnalysis {
  return renderCriticalPathAnalysis({
    available: true,
    task: {
      threadStateId: 1,
      utid: 10,
      startTs: 1_000,
      dur: 50_000_000,
      durationMs: 50,
      processName: 'com.example',
      threadName: 'main',
      state: 'S',
    },
    totalMs: 50,
    blockingMs: 40,
    selfMs: 10,
    externalBlockingPercentage: 80,
    wakeupChain: [],
    moduleBreakdown: [],
    anomalies: [],
    summary: '',
    recommendationIds: [],
    recommendations: [],
    warningCodes: [],
    warnings: [],
    rawRows: 1,
    truncated: false,
    quantification: {
      counterfactual: {
        longestSegmentKey: '10|1000|30001000',
        longestSegmentDurMs: 30,
        bestCaseDurationMs: 20,
        maxSavingMs: 30,
        longestSegmentDurNs: 30_000_000,
        bestCaseDurationNs: 20_000_000,
        maxSavingNs: 30_000_000,
        noteCode: 'best_case_only',
        note: '',
      },
      frameImpacts: [],
      hypotheses: [],
      warnings: [],
    },
  }, 'zh-CN');
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), {code});
}

function sdkStream(result: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {type: 'result', subtype: 'success', result};
    },
    close: jest.fn(),
  };
}

const VALID_BODY = {threadStateId: 42, outputLanguage: 'en'};

describe('POST /api/critical-path/:traceId/analyze', () => {
  const savedAiEnabled = process.env[AI_CAPABILITY_ENV_KEY];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[AI_CAPABILITY_ENV_KEY];
    mockGetOrLoadTrace.mockResolvedValue({id: 'trace-1'});
    mockGetTraceProcessorService.mockReturnValue({getOrLoadTrace: mockGetOrLoadTrace});
    mockReadMetadata.mockResolvedValue({id: 'trace-1'});
    mockAnalyze.mockResolvedValue(analysisFixture());
    mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'provider'});
    mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockProviderService.getRawEffectiveProvider.mockReturnValue({id: 'provider-a'});
    mockProviderService.getEnvForProviderConfig.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockHasClaudeCredentials.mockReturnValue(true);
    mockQuery.mockImplementation(() => sdkStream('## model summary'));
  });

  afterEach(async () => {
    await loopbackServers.close();
    if (savedAiEnabled === undefined) delete process.env[AI_CAPABILITY_ENV_KEY];
    else process.env[AI_CAPABILITY_ENV_KEY] = savedAiEnabled;
  });

  it('degrades to the deterministic summary with a warning when AI is disabled', async () => {
    process.env[AI_CAPABILITY_ENV_KEY] = 'false';

    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'ai_disabled'});
    expect(res.body.aiSummary.warnings[0]).toContain('SMARTPERFETTO_AI_ENABLED');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSelection).not.toHaveBeenCalled();
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
  });

  it('describes the counterfactual as a best case with a bounded saving', async () => {
    process.env[AI_CAPABILITY_ENV_KEY] = 'false';

    const en = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);
    const zh = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({threadStateId: 42, outputLanguage: 'zh-CN'});

    expect(en.body.aiSummary.summary).toContain('best-case task duration of 20.00 ms');
    expect(en.body.aiSummary.summary).toContain('a saving of at most 30.00 ms');
    expect(en.body.aiSummary.summary).not.toMatch(/upper bound/i);
    expect(zh.body.aiSummary.summary).toContain('任务时长最好可降至 20.00 ms');
    expect(zh.body.aiSummary.summary).toContain('至多节省 30.00 ms');
    expect(zh.body.aiSummary.summary).not.toContain('上界');
  });

  it('rejects an invalid body with a coded 400 before loading any trace', async () => {
    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({threadStateId: 'not-a-number', maxSegments: 5});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'invalid_request_body'});
    expect(res.body.issues.map((issue: {path: string}) => issue.path))
      .toEqual(expect.arrayContaining(['threadStateId', 'maxSegments']));
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockGetTraceProcessorService).not.toHaveBeenCalled();
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects an unsafe trace id with a coded 400', async () => {
    const res = await request(await makeApp())
      .post('/api/critical-path/..%2Fsecret/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'invalid_trace_id'});
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('returns trace_not_found when the trace is not readable by the caller', async () => {
    mockReadMetadata.mockResolvedValue(null);

    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({success: false, code: 'trace_not_found'});
    expect(mockReadMetadata).toHaveBeenCalledWith('trace-1', REQUEST_CONTEXT);
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('maps an unknown thread_state to a coded 404', async () => {
    mockAnalyze.mockRejectedValue(new CriticalPathInputError('thread_state_not_found', 'thread_state 42 not found'));

    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      code: 'thread_state_not_found',
      error: 'The selected thread_state was not found in this trace',
    });
  });

  it('passes a disconnect signal into the engine so a gone client stops the analysis', async () => {
    const response = await request(await makeApp()).post('/api/critical-path/trace-1/analyze').send(VALID_BODY);

    expect(response.status).toBe(200);
    const options = mockAnalyze.mock.calls[0][2] as {signal?: unknown};
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps an invalid selector name to a coded 400', async () => {
    mockAnalyze.mockRejectedValueOnce(new CriticalPathInputError('invalid_name', 'thread_name must be printable'));

    const response = await request(await makeApp()).post('/api/critical-path/trace-1/analyze').send(VALID_BODY);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({success: false, code: 'invalid_name'});
  });

  it('maps other engine input errors to a coded 400', async () => {
    mockAnalyze.mockRejectedValue(new CriticalPathInputError('missing_selector', 'threadStateId or utid/startTs/dur is required'));

    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({outputLanguage: 'en'});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'missing_selector'});
  });

  it('keeps unexpected failures opaque, including coded non-engine errors', async () => {
    for (const error of [
      new Error('SQL failed near /Users/someone/secret.trace'),
      codedError('ENOENT: /Users/someone/secret.trace', 'ENOENT'),
    ]) {
      mockAnalyze.mockRejectedValueOnce(error);
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await request(await makeApp())
        .post('/api/critical-path/trace-1/analyze')
        .send(VALID_BODY);
      consoleError.mockRestore();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        code: 'critical_path_failed',
        error: 'Critical path analysis failed',
      });
    }
  });

  it('runs the Claude summary in the isolated one-shot SDK configuration', async () => {
    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toMatchObject({
      generated: true,
      model: 'profile-model',
      summary: '## model summary',
    });
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledTimes(1);
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledWith(PROVIDER_SCOPE);
    expect(mockProviderService.getEnvForProviderConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateSdkEnv).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockHasClaudeCredentials).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const {prompt, options} = mockQuery.mock.calls[0][0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    // The model reads the counterfactual through its best-case fields only.
    expect(prompt).toContain('"bestCaseDurationMs":20');
    expect(prompt).toContain('"maxSavingMs":30');
    expect(prompt).not.toContain('bestCaseDurationNs');
    expect(options).toMatchObject({
      model: 'profile-model',
      maxTurns: 1,
      settingSources: [],
      tools: [],
      allowedTools: [],
      skills: [],
      plugins: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      permissionMode: 'dontAsk',
      env: {ANTHROPIC_API_KEY: 'profile-key'},
    });
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options).not.toHaveProperty('resume');
  });

  it('never puts a raw binder or monitor method name into the prompt', async () => {
    const analysis = analysisFixture();
    const segment = {
      startTs: 1_000, dur: 30_000_000, startOffsetMs: 0, durationMs: 30, utid: 40,
      threadName: 'binder:55', processName: 'system_server', state: 'S',
      slices: [], moduleIds: [], modules: [], reasonItems: [], reasons: [],
      semantics: {
        segmentKey: '40|1000|30001000', utid: 40, upid: 8, startTs: 1_000, endTs: 30_001_000,
        binderTxns: [{
          binderTxnId: 1, binderReplyId: 2, side: 'client', interfaceName: 'com.secret.IVault',
          methodName: 'unlockVaultWithPin', isSync: true, isMainThread: true, clientProcess: 'com.example',
          clientThread: 'main', serverProcess: 'system_server', serverThread: 'binder:55', clientUtid: 10,
          serverUtid: 40, clientTid: 100, serverTid: 1055, durMs: 30, eventDurMs: 30,
        }],
        monitorContention: [{
          rowId: 5, side: 'blocked', shortBlockedMethod: 'readSecretLedger()', shortBlockingMethod: 'writeSecretLedger()',
          blockedThreadName: 'main', blockingThreadName: 'worker', blockedTid: 100, blockingTid: 101,
          blockedUtid: 10, blockingUtid: 41, durMs: 3, eventDurMs: 12, isBlockedThreadMain: true,
        }],
        ioSignals: [], gcEvents: [], cpuCompetition: [], wakeSources: [],
      },
    };
    mockAnalyze.mockResolvedValue({...analysis, wakeupChain: [segment]});

    const res = await request(await makeApp()).post('/api/critical-path/trace-1/analyze').send(VALID_BODY);

    expect(res.status).toBe(200);
    const {prompt} = mockQuery.mock.calls[0][0] as {prompt: string};
    for (const raw of ['unlockVaultWithPin', 'com.secret.IVault', 'readSecretLedger', 'writeSecretLedger']) {
      expect(prompt).not.toContain(raw);
    }
    expect(prompt).toContain('<method_');
    expect(prompt).toContain('<blockedmethod_');
  });

  it('gives a viewer the deterministic summary without any model call', async () => {
    const viewer = await request(await makeApp(VIEWER_CONTEXT))
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(viewer.status).toBe(200);
    expect(viewer.body.analysis).toBeDefined();
    expect(viewer.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'permission_denied'});
    expect(viewer.body.aiSummary.warnings[0]).toContain('agent:run');
    // Permission is checked before the provider is read.
    expect(mockProviderService.getRawEffectiveProvider).not.toHaveBeenCalled();
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();

    // The same request from an analyst reaches the model.
    const analyst = await request(await makeApp({...REQUEST_CONTEXT, roles: ['analyst'], scopes: []}))
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(analyst.body.aiSummary).toMatchObject({generated: true, summary: '## model summary'});
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns the deterministic summary when the active runtime is not Claude', async () => {
    mockSelection.mockReturnValue({kind: 'openai-agents-sdk', source: 'provider'});

    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'runtime_not_supported'});
    expect(res.body.aiSummary.warnings[0]).toContain('openai-agents-sdk');
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('checks credentials in the resolved profile env, not the process env', async () => {
    mockHasClaudeCredentials.mockReturnValue(false);

    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send(VALID_BODY);

    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'credentials_missing'});
    expect(mockHasClaudeCredentials).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('omits the AI summary when includeAi is false', async () => {
    const res = await request(await makeApp())
      .post('/api/critical-path/trace-1/analyze')
      .send({...VALID_BODY, includeAi: false});

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('summarizeCriticalPathWithAi cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'default'});
    mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'env-key'});
    mockProviderService.getRawEffectiveProvider.mockReturnValue(undefined);
    mockProviderService.getEnvForProviderConfig.mockReturnValue(null);
    mockHasClaudeCredentials.mockReturnValue(true);
  });

  it('never starts a model call for an already disconnected client', async () => {
    const caller = new AbortController();
    caller.abort();

    const summary = await summarizeCriticalPathWithAi(analysisFixture(), undefined, 'en', {
      signal: caller.signal,
    });

    expect(summary).toMatchObject({generated: false, fallbackReason: 'client_disconnected'});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('aborts the SDK subprocess when the client disconnects mid-call', async () => {
    const caller = new AbortController();
    let sdkAbort: AbortController | undefined;
    mockQuery.mockImplementation((params: any) => {
      sdkAbort = params.options.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            sdkAbort!.signal.addEventListener('abort', () => resolve(), {once: true});
          });
          throw new Error('aborted by caller');
        },
        close: jest.fn(),
      };
    });

    const pending = summarizeCriticalPathWithAi(analysisFixture(), undefined, 'en', {
      signal: caller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sdkAbort?.signal.aborted).toBe(false);
    caller.abort();
    const summary = await pending;

    expect(sdkAbort?.signal.aborted).toBe(true);
    expect(summary).toMatchObject({generated: false, fallbackReason: 'client_disconnected'});
  });
});

describe('clientDisconnectSignal', () => {
  function fakeResponse(writableEnded: boolean) {
    return Object.assign(new EventEmitter(), {writableEnded});
  }

  it('aborts when the response closes before it was fully written', () => {
    const res = fakeResponse(false);
    const signal = clientDisconnectSignal(res);
    res.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('does not abort on the close that follows a completed response', () => {
    const res = fakeResponse(true);
    const signal = clientDisconnectSignal(res);
    res.emit('close');
    expect(signal.aborted).toBe(false);
  });
});

describe('critical-path route mounts', () => {
  const envKeys = ['SMARTPERFETTO_ENTERPRISE', 'SMARTPERFETTO_SSO_TRUSTED_HEADERS', 'SMARTPERFETTO_API_KEY', AI_CAPABILITY_ENV_KEY];
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  /** The production chain: global auth, the legacy mount behind the enterprise gate, the workspace mount. */
  async function mountedApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      void authenticate(req as any, res, next);
    });
    app.use(
      '/api/workspaces/:workspaceId/critical-path',
      bindWorkspaceRouteContext,
      (req, res, next) => {
        void authenticate(req as any, res, next);
      },
      requireWorkspaceRouteContext,
      criticalPathRoutes,
    );
    app.use('/api/critical-path', rejectEnterpriseUnscopedApi, criticalPathRoutes);
    return loopbackServers.listen(app);
  }

  function sso(test: request.Test, role: string, scopes: string, workspaceId = 'workspace-a'): request.Test {
    return test
      .set('X-SmartPerfetto-SSO-User-Id', 'user-a')
      .set('X-SmartPerfetto-SSO-Email', 'user-a@example.test')
      .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
      .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
      .set('X-SmartPerfetto-SSO-Roles', role)
      .set('X-SmartPerfetto-SSO-Scopes', scopes);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SMARTPERFETTO_ENTERPRISE = 'true';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
    delete process.env.SMARTPERFETTO_API_KEY;
    delete process.env[AI_CAPABILITY_ENV_KEY];
    mockGetOrLoadTrace.mockResolvedValue({id: 'trace-1'});
    mockGetTraceProcessorService.mockReturnValue({getOrLoadTrace: mockGetOrLoadTrace});
    mockReadMetadata.mockResolvedValue({id: 'trace-1'});
    mockAnalyze.mockResolvedValue(analysisFixture());
    mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'provider'});
    mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockProviderService.getRawEffectiveProvider.mockReturnValue({id: 'provider-a'});
    mockProviderService.getEnvForProviderConfig.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockHasClaudeCredentials.mockReturnValue(true);
    mockQuery.mockImplementation(() => sdkStream('## model summary'));
  });

  afterEach(async () => {
    await loopbackServers.close();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps the legacy mount closed in enterprise mode and serves the workspace mount', async () => {
    const app = await mountedApp();

    const legacy = await sso(request(app).post('/api/critical-path/trace-1/analyze'), 'analyst', 'trace:read,agent:run')
      .send(VALID_BODY);
    expect(legacy.status).toBe(410);
    expect(legacy.body.code).toBe('ENTERPRISE_WORKSPACE_ROUTE_REQUIRED');

    const scoped = await sso(
      request(app).post('/api/workspaces/workspace-a/critical-path/trace-1/analyze'), 'analyst', 'trace:read,agent:run',
    ).send(VALID_BODY);
    expect(scoped.status).toBe(200);
    expect(scoped.body.aiSummary).toMatchObject({generated: true});
    expect(mockReadMetadata).toHaveBeenCalledWith('trace-1', expect.objectContaining({
      tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a',
    }));
  });

  it('answers 404 for another workspace\'s path without reading the trace', async () => {
    const res = await sso(
      request(await mountedApp()).post('/api/workspaces/workspace-b/critical-path/trace-1/analyze'), 'analyst', 'trace:read,agent:run',
    ).send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('gives a workspace viewer the rule summary without a model call', async () => {
    const res = await sso(
      request(await mountedApp()).post('/api/workspaces/workspace-a/critical-path/trace-1/analyze'), 'viewer', 'trace:read',
    ).send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'permission_denied'});
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
