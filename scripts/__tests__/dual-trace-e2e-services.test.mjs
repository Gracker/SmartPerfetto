// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {startHangingOpenAIStub} = require('../e2e/hanging-openai-stub.cjs');
const {
  childEnvironments,
  configureServices,
  fetchBackendDiagnostics,
  resolveRealProvider,
  validateBackendHealth,
} = require('../e2e/dual-trace-e2e-services.cjs');

test('provider stub completes streamed tool-free intent and holds only the analysis stream', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-trace-streamed-intent-'));
  const stub = await startHangingOpenAIStub(path.join(directory, 'provider.log'), 'test-key');
  const controller = new AbortController();
  const headers = {'Content-Type': 'application/json', Authorization: 'Bearer test-key'};
  try {
    const intent = await fetch(`${stub.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({model: 'test-model', stream: true, temperature: 0,
        messages: [{role: 'user', content: 'Compare the two startup traces'}]}),
    });
    assert.equal(intent.status, 200);
    assert.equal(intent.headers.get('content-type'), 'text/event-stream');
    const events = (await intent.text()).split('\n\n').filter(Boolean);
    const first = JSON.parse(events[0].slice('data: '.length));
    assert.equal(JSON.parse(first.choices[0].delta.content).taskKind, 'comparison');
    assert.equal(JSON.parse(events[1].slice('data: '.length)).choices[0].finish_reason, 'stop');
    assert.equal(events[2], 'data: [DONE]');
    assert.equal(stub.snapshot().active, 0);

    const analysis = await fetch(`${stub.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({model: 'test-model', stream: true,
        stream_options: {include_usage: true}, parallel_tool_calls: false,
        tools: [], messages: [{role: 'user', content: 'Compare the two startup traces'}]}),
    });
    assert.equal(analysis.status, 200);
    assert.equal(stub.snapshot().active, 1);
    assert.deepEqual(stub.snapshot().requests.map(({kind, validationErrors}) => ({kind, validationErrors})), [
      {kind: 'classification', validationErrors: []},
      {kind: 'analysis', validationErrors: []},
    ]);
    controller.abort();
    const deadline = Date.now() + 2000;
    while (stub.snapshot().active && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(stub.snapshot().active, 0);
    assert.equal(stub.snapshot().closed, 2);
  } finally {
    controller.abort();
    await stub.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('real browser E2E requires Coding Plan credentials without a paid provider fallback', () => {
  assert.throws(() => resolveRealProvider({
    DEEPSEEK_API_KEY: 'other-provider', OPENAI_API_KEY: 'other-provider',
  }), /GLM_API_KEY is required/);
  const provider = resolveRealProvider({GLM_API_KEY: 'coding-plan-test-key'});
  assert.equal(provider.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
  assert.equal(provider.model, 'glm-5.3');
  assert.equal(provider.lightModel, 'glm-5.3-flash');
  for (const key of ['GLM_MODEL', 'GLM_LIGHT_MODEL']) {
    assert.throws(() => resolveRealProvider({GLM_API_KEY: 'test-key', [key]: 'deepseek-v4-pro'}),
      /GLM model IDs for both main and light models/);
  }
  for (const baseUrl of [
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.deepseek.com/v1',
    'https://open.bigmodel.cn/api/coding/paas/v4?paid=1',
    'https://user@open.bigmodel.cn/api/coding/paas/v4',
  ]) {
    assert.throws(() => resolveRealProvider({GLM_API_KEY: 'test-key', GLM_BASE_URL: baseUrl}),
      /official GLM Coding Plan endpoint/);
  }
});

test('browser E2E isolates the selected provider credential and preserves the default stub', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-trace-provider-test-'));
  const workspace = {envFile: path.join(directory, '.env')};
  try {
    const real = resolveRealProvider({GLM_API_KEY: 'coding-plan-test-key'});
    const services = await configureServices(workspace, real);
    assert.equal(services.backendEnvironment.OPENAI_BASE_URL, real.baseUrl);
    assert.equal(services.backendEnvironment.OPENAI_API_KEY, real.apiKey);
    assert.equal(services.backendEnvironment.OPENAI_LIGHT_MODEL, real.lightModel);
    assert.equal(services.backendEnvironment.DEEPSEEK_API_KEY, undefined);
    const children = childEnvironments(workspace, services, real.baseUrl);
    for (const environment of [children.frontend, children.playwright]) {
      assert.equal(environment.OPENAI_API_KEY, undefined);
      assert.equal(environment.GLM_API_KEY, undefined);
      assert.equal(environment.DEEPSEEK_API_KEY, undefined);
    }
    const stub = await configureServices(workspace, 'http://127.0.0.1:9999');
    assert.equal(stub.backendEnvironment.OPENAI_BASE_URL, 'http://127.0.0.1:9999/v1');
    assert.equal(stub.backendEnvironment.OPENAI_MODEL, 'smartperfetto-e2e-hang');
    assert.equal(stub.backendEnvironment.OPENAI_MAX_OUTPUT_TOKENS, '1024');
    assert.equal(stub.backendEnvironment.OPENAI_MAX_TURNS, '5');
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('dual-trace browser runs with the locale used by product-copy assertions', () => {
  const workspace = {
    runId: 'test-run',
    envFile: '/tmp/test.env',
    artifactDir: '/tmp/artifacts',
    fixtureDir: '/tmp/fixtures',
  };
  const services = {
    backendPort: 3000,
    frontendPort: 10000,
    backendUrl: 'http://127.0.0.1:3000',
    frontendUrl: 'http://127.0.0.1:10000',
    backendEnvironment: {},
    traceProcessorPortMin: 20000,
    traceProcessorPortMax: 20015,
  };

  const environments = childEnvironments(
    workspace,
    services,
    'http://127.0.0.1:9999',
  );

  assert.equal(environments.playwright.SMARTPERFETTO_E2E_LOCALE, 'zh-CN');
});

test('dual-trace diagnostics use the authenticated runtime health endpoint', async () => {
  let request;
  const diagnostics = {
    status: 'OK',
    environment: 'test',
    aiEngine: {
      runtime: 'openai-agents-sdk',
      source: 'env',
      providerMode: 'openai_chat_completions_compatible',
      configured: true,
      aiEnabled: true,
      authRequired: true,
    },
  };

  const result = await fetchBackendDiagnostics(
    'http://127.0.0.1:3000/',
    'test-key',
    async (url, options) => {
      request = {url, options};
      return {
        ok: true,
        status: 200,
        json: async () => diagnostics,
      };
    },
  );

  assert.equal(request.url, 'http://127.0.0.1:3000/api/runtime-health');
  assert.equal(request.options.headers['x-api-key'], 'test-key');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(result, diagnostics);
  assert.doesNotThrow(() => validateBackendHealth(result));
});

test('dual-trace diagnostics reject unauthenticated or forbidden responses', async () => {
  await assert.rejects(
    fetchBackendDiagnostics(
      'http://127.0.0.1:3000',
      'bad-key',
      async () => ({ok: false, status: 403}),
    ),
    /Authenticated runtime health returned HTTP 403/,
  );
});

test('dual-trace diagnostics retry a cold runtime-health timeout', async () => {
  let attempts = 0;
  const diagnostics = {
    status: 'OK',
    environment: 'test',
    aiEngine: {
      runtime: 'openai-agents-sdk',
      source: 'env',
      providerMode: 'openai_chat_completions_compatible',
      configured: true,
      aiEnabled: true,
      authRequired: true,
    },
  };

  const result = await fetchBackendDiagnostics(
    'http://127.0.0.1:3000',
    'test-key',
    async () => {
      attempts += 1;
      if (attempts === 1) {
        const timeout = new Error('cold runtime health');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      return {
        ok: true,
        status: 200,
        json: async () => diagnostics,
      };
    },
    {attempts: 3, retryDelayMs: 0},
  );

  assert.equal(attempts, 2);
  assert.deepEqual(result, diagnostics);
});
