// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  childEnvironments,
  fetchBackendDiagnostics,
  validateBackendHealth,
} = require('../e2e/dual-trace-e2e-services.cjs');

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
