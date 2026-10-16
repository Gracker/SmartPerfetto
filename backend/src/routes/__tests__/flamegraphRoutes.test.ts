// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import flamegraphRoutes from '../flamegraphRoutes';
import {selectRuntimeForProvider} from '../../agentRuntime/runtimeSelection';
import {hasClaudeCredentials, sdkEnvForProviderEnv} from '../../agentv3/claudeConfig';
import {
  authenticate,
} from '../../middleware/auth';
import {DEFAULT_DEV_USER_ID, DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID} from '../../utils/localDevIdentity';
import {AI_CAPABILITY_ENV_KEY} from '../../services/aiCapabilityPolicy';
import {
  analyzeFlamegraph,
  buildFlamegraphFromPerfettoSummaryRows,
  getFlamegraphAvailability,
} from '../../services/flamegraphAnalyzer';
import {readTraceMetadataForContext} from '../../services/traceMetadataStore';
import {getTraceProcessorService} from '../../services/traceProcessorService';
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

jest.mock('../../services/flamegraphAnalyzer', () => ({
  ...(jest.requireActual('../../services/flamegraphAnalyzer') as object),
  analyzeFlamegraph: jest.fn(),
  getFlamegraphAvailability: jest.fn(),
}));

jest.mock('../../services/traceMetadataStore', () => {
  const actual = jest.requireActual('../../services/traceMetadataStore') as Record<string, unknown>;
  return {...actual, readTraceMetadataForContext: jest.fn()};
});

jest.mock('../../services/traceProcessorService', () => ({
  getTraceProcessorService: jest.fn(),
}));

const actualMetadataStore = jest.requireActual('../../services/traceMetadataStore') as {
  readTraceMetadataForContext: (...args: any[]) => Promise<unknown>;
};
const mockQuery = sdkQuery as unknown as jest.Mock<(...args: any[]) => any>;
const mockSelection = selectRuntimeForProvider as unknown as jest.Mock<(...args: any[]) => any>;
const mockCreateSdkEnv = sdkEnvForProviderEnv as unknown as jest.Mock<(...args: any[]) => any>;
const mockHasClaudeCredentials = hasClaudeCredentials as unknown as jest.Mock<(...args: any[]) => any>;
const mockAnalyze = analyzeFlamegraph as unknown as jest.Mock<(...args: any[]) => any>;
const mockAvailability = getFlamegraphAvailability as unknown as jest.Mock<(...args: any[]) => any>;
const mockReadMetadata = readTraceMetadataForContext as unknown as jest.Mock<(...args: any[]) => any>;
const mockGetTraceProcessorService = getTraceProcessorService as unknown as jest.Mock<(...args: any[]) => any>;
const mockGetOrLoadTrace = jest.fn<(...args: any[]) => any>();

const ANALYST_CONTEXT = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
  authType: 'sso',
  roles: ['analyst'],
  scopes: [],
  requestId: 'req-test',
};
const VIEWER_CONTEXT = {...ANALYST_CONTEXT, roles: ['viewer']};

async function appWithContext(context: object) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.requestContext = context;
    next();
  });
  app.use('/api/flamegraph', flamegraphRoutes);
  return loopbackServers.listen(app);
}

/** The production chain in local keyless mode: `authenticate`, then the router. */
async function appWithAuthentication() {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    void authenticate(req as any, res, next);
  });
  app.use('/api/flamegraph', flamegraphRoutes);
  return loopbackServers.listen(app);
}

function analysisFixture() {
  return buildFlamegraphFromPerfettoSummaryRows(
    [
      {id: 1, parentId: null, name: 'android.os.Looper.loopOnce', mappingName: 'framework.jar', selfCount: 0, cumulativeCount: 10},
      {id: 2, parentId: 1, name: 'com.demo.ImageDecoder.decode', mappingName: 'base.apk', selfCount: 10, cumulativeCount: 10},
    ],
    {sampleCount: 10, sourceTable: 'linux_perf_samples_summary_tree'},
  );
}

function sdkStream(result: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {type: 'result', subtype: 'success', result};
    },
    close: jest.fn(),
  };
}

// Exactly what frontend/assistant-flamegraph.js sends.
const STATIC_ASSET_BODY = {includeAi: true, maxNodes: 3000};

const savedEnv = new Map(
  [AI_CAPABILITY_ENV_KEY, 'SMARTPERFETTO_API_KEY', 'UPLOAD_DIR'].map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  restoreEnv();
  delete process.env[AI_CAPABILITY_ENV_KEY];
  mockGetOrLoadTrace.mockResolvedValue({id: 'trace-1'});
  mockGetTraceProcessorService.mockReturnValue({getOrLoadTrace: mockGetOrLoadTrace});
  mockReadMetadata.mockResolvedValue({id: 'trace-1'});
  mockAnalyze.mockResolvedValue(analysisFixture());
  mockAvailability.mockResolvedValue({available: true, sampleSource: 'linux_perf_samples_summary_tree', availableSources: [], missing: [], warnings: []});
  mockSelection.mockReturnValue({kind: 'claude-agent-sdk', source: 'provider'});
  mockCreateSdkEnv.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
    mockProviderService.getRawEffectiveProvider.mockReturnValue({id: 'provider-a'});
    mockProviderService.getEnvForProviderConfig.mockReturnValue({ANTHROPIC_API_KEY: 'profile-key'});
  mockHasClaudeCredentials.mockReturnValue(true);
  mockQuery.mockImplementation(() => sdkStream('## model summary'));
});

afterEach(async () => {
  await loopbackServers.close();
  restoreEnv();
});

describe('flamegraph routes: validation and ownership', () => {
  it('rejects an unsafe trace id with a coded 400 before any lookup', async () => {
    const analyze = await request(await appWithContext(ANALYST_CONTEXT)).post('/api/flamegraph/..%2Fsecret/analyze').send({});
    const availability = await request(await appWithContext(ANALYST_CONTEXT)).get('/api/flamegraph/..%2Fsecret/availability');

    for (const res of [analyze, availability]) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({success: false, code: 'invalid_trace_id'});
    }
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('rejects an invalid body with a coded 400 before loading any trace', async () => {
    const res = await request(await appWithContext(ANALYST_CONTEXT))
      .post('/api/flamegraph/trace-1/analyze')
      .send({maxNodes: 'lots', startTs: 'yesterday', question: 'x'.repeat(501)});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({success: false, code: 'invalid_request_body'});
    expect(res.body.issues.map((issue: {path: string}) => issue.path))
      .toEqual(expect.arrayContaining(['maxNodes', 'startTs', 'question']));
    expect(mockReadMetadata).not.toHaveBeenCalled();
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });

  it('answers trace_not_found without loading a processor when the caller cannot read the trace', async () => {
    mockReadMetadata.mockResolvedValue(null);

    const analyze = await request(await appWithContext(ANALYST_CONTEXT)).post('/api/flamegraph/trace-1/analyze').send({});
    const availability = await request(await appWithContext(ANALYST_CONTEXT)).get('/api/flamegraph/trace-1/availability');

    for (const res of [analyze, availability]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({success: false, code: 'trace_not_found'});
    }
    expect(mockReadMetadata).toHaveBeenCalledWith('trace-1', ANALYST_CONTEXT);
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('keeps unexpected failures opaque', async () => {
    mockAnalyze.mockRejectedValue(new Error('SQL failed near /Users/someone/secret.trace'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(await appWithContext(ANALYST_CONTEXT))
      .post('/api/flamegraph/trace-1/analyze')
      .set('Accept-Language', 'en')
      .send({includeAi: false});
    consoleError.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({success: false, code: 'flamegraph_failed', error: 'Flamegraph analysis failed'});
  });

  it('no longer serves the summarize endpoint that sent client-supplied analysis to a model', async () => {
    const res = await request(await appWithContext(ANALYST_CONTEXT))
      .post('/api/flamegraph/trace-1/summarize')
      .send({analysis: analysisFixture()});

    expect(res.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('passes a disconnect signal to the analyzer', async () => {
    await request(await appWithContext(ANALYST_CONTEXT)).post('/api/flamegraph/trace-1/analyze').send({includeAi: false});

    const runOptions = mockAnalyze.mock.calls[0][3] as {signal?: unknown};
    expect(runOptions.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('flamegraph routes: AI summary gate', () => {
  it('gives a viewer the rule summary without any model call', async () => {
    const res = await request(await appWithContext(VIEWER_CONTEXT)).post('/api/flamegraph/trace-1/analyze').send(STATIC_ASSET_BODY);

    expect(res.status).toBe(200);
    expect(res.body.analysis.available).toBe(true);
    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'permission_denied'});
    expect(res.body.aiSummary.warnings[0]).toContain('agent:run');
    // Permission is checked before the provider is read.
    expect(mockProviderService.getRawEffectiveProvider).not.toHaveBeenCalled();
    expect(mockCreateSdkEnv).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('respects the global AI switch before any provider lookup', async () => {
    process.env[AI_CAPABILITY_ENV_KEY] = 'false';

    const res = await request(await appWithContext(ANALYST_CONTEXT)).post('/api/flamegraph/trace-1/analyze').send(STATIC_ASSET_BODY);

    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'ai_disabled'});
    expect(mockSelection).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not send the statistics to a non-Claude runtime', async () => {
    mockSelection.mockReturnValue({kind: 'opencode', source: 'provider'});

    const res = await request(await appWithContext(ANALYST_CONTEXT)).post('/api/flamegraph/trace-1/analyze').send(STATIC_ASSET_BODY);

    expect(res.body.aiSummary).toMatchObject({generated: false, fallbackReason: 'runtime_not_supported'});
    expect(res.body.aiSummary.warnings[0]).toContain('opencode');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('runs an analyst summary in the isolated one-shot configuration of the caller scope', async () => {
    const res = await request(await appWithContext(ANALYST_CONTEXT))
      .post('/api/flamegraph/trace-1/analyze')
      .send({...STATIC_ASSET_BODY, question: '为什么这么热？'});

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toMatchObject({generated: true, model: 'profile-model', summary: '## model summary'});
    const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledTimes(1);
    expect(mockProviderService.getRawEffectiveProvider).toHaveBeenCalledWith(scope);
    expect(mockCreateSdkEnv).toHaveBeenCalledWith({ANTHROPIC_API_KEY: 'profile-key'});
    const {prompt, options} = mockQuery.mock.calls[0][0] as {prompt: string; options: Record<string, unknown>};
    // The prompt comes from the strategy template, comments stripped.
    expect(prompt).toContain('self_count');
    expect(prompt).toContain('用户问题：为什么这么热？');
    expect(prompt).not.toContain('SPDX');
    expect(prompt).not.toContain('{{');
    expect(options).toMatchObject({
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
    });
  });

  it('omits the AI summary when includeAi is false', async () => {
    const res = await request(await appWithContext(ANALYST_CONTEXT)).post('/api/flamegraph/trace-1/analyze').send({includeAi: false});

    expect(res.status).toBe(200);
    expect(res.body.aiSummary).toBeUndefined();
    expect(mockSelection).not.toHaveBeenCalled();
  });
});

describe('flamegraph routes: the static page request in local keyless mode', () => {
  let uploadDir: string;

  async function writeTraceMetadata(id: string, owner: {tenantId: string; workspaceId: string; userId: string}) {
    const tracesDir = path.join(uploadDir, 'traces');
    await fs.mkdir(tracesDir, {recursive: true});
    const tracePath = path.join(tracesDir, `${id}.trace`);
    await fs.writeFile(tracePath, `trace-${id}`);
    await fs.writeFile(path.join(tracesDir, `${id}.json`), JSON.stringify({
      id,
      filename: `${id}.trace`,
      size: 16,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      path: tracePath,
      ...owner,
    }));
  }

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-flamegraph-'));
    process.env.UPLOAD_DIR = uploadDir;
    delete process.env.SMARTPERFETTO_API_KEY;
    mockReadMetadata.mockImplementation((...args: any[]) => actualMetadataStore.readTraceMetadataForContext(...args));
  });

  afterEach(async () => {
    await loopbackServers.close();
    await fs.rm(uploadDir, {recursive: true, force: true});
  });

  it('serves a local trace to the header-less availability and analyze requests', async () => {
    await writeTraceMetadata('trace-local', {
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: DEFAULT_DEV_USER_ID,
    });
    const app = await appWithAuthentication();

    const availability = await request(app).get('/api/flamegraph/trace-local/availability');
    const analyze = await request(app)
      .post('/api/flamegraph/trace-local/analyze')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(STATIC_ASSET_BODY));

    expect(availability.status).toBe(200);
    expect(availability.body).toMatchObject({success: true, available: true});
    expect(analyze.status).toBe(200);
    expect(analyze.body.success).toBe(true);
    expect(analyze.body.aiSummary).toMatchObject({generated: true});
    expect(mockAnalyze.mock.calls[0][2]).toEqual({maxNodes: 3000});
  });

  it('does not serve a trace owned by another workspace', async () => {
    await writeTraceMetadata('trace-foreign', {tenantId: DEFAULT_TENANT_ID, workspaceId: 'workspace-b', userId: 'someone'});
    const app = await appWithAuthentication();

    const res = await request(app)
      .post('/api/flamegraph/trace-foreign/analyze')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(STATIC_ASSET_BODY));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({success: false, code: 'trace_not_found'});
    expect(mockGetOrLoadTrace).not.toHaveBeenCalled();
  });
});
