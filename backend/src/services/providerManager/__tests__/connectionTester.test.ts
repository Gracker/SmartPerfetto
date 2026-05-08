// backend/src/services/providerManager/__tests__/connectionTester.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { testProviderConnection } from '../connectionTester';
import type { ProviderConfig } from '../types';

describe('Provider connection tester', () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    'PROVIDER_TEST_REQUEST_TIMEOUT_MS',
    'PROVIDER_TEST_TOTAL_TIMEOUT_MS',
    'PROVIDER_TEST_RESPONSE_BODY_TIMEOUT_MS',
  ];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) delete process.env[key];
  });

  it('returns a bounded failure when an error response body never finishes', async () => {
    process.env.PROVIDER_TEST_REQUEST_TIMEOUT_MS = '100';
    process.env.PROVIDER_TEST_TOTAL_TIMEOUT_MS = '500';
    process.env.PROVIDER_TEST_RESPONSE_BODY_TIMEOUT_MS = '20';

    const cancel = jest.fn();
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: () => new Promise<string>(() => {}),
      body: { cancel },
    })) as any;

    const started = Date.now();
    const result = await testProviderConnection(openAIProvider());

    expect(result.success).toBe(false);
    expect(result.error).toBe('API error: 500');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cancel).toHaveBeenCalled();
  });

  it('returns a bounded failure when fetch ignores abort signals', async () => {
    process.env.PROVIDER_TEST_REQUEST_TIMEOUT_MS = '20';
    process.env.PROVIDER_TEST_TOTAL_TIMEOUT_MS = '80';
    process.env.PROVIDER_TEST_RESPONSE_BODY_TIMEOUT_MS = '20';

    globalThis.fetch = jest.fn(() => new Promise<Response>(() => {})) as any;

    const started = Date.now();
    const result = await testProviderConnection(openAIProvider());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Provider connection test timed out after 0.08s');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

function openAIProvider(): ProviderConfig {
  return {
    id: 'provider-test',
    name: 'Provider Test',
    category: 'official',
    type: 'openai',
    isActive: false,
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    models: {
      primary: 'gpt-test',
      light: 'gpt-test-mini',
    },
    connection: {
      openaiBaseUrl: 'https://example.test/v1',
      openaiApiKey: 'sk-test',
    },
  };
}
