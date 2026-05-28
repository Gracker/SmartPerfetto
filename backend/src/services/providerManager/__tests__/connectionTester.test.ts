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
    expect(result.error).toBe('Responses API model probe failed: 500');
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

  it('does not pass OpenAI-compatible providers on /models reachability alone', async () => {
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/models')) {
        return jsonResponse({ data: [] });
      }
      if (url.endsWith('/chat/completions')) {
        return jsonResponse({ error: { message: 'model does not exist' } }, 404);
      }
      return jsonResponse({}, 500);
    }) as any;

    const result = await testProviderConnection(customOpenAIProvider());

    expect(result.success).toBe(false);
    expect(result.error).toBe('Model or endpoint not found (Chat Completions API, 404)');
    expect(calls).toEqual(['https://example.test/v1/chat/completions']);
  });

  it('passes chat-completions providers only after a primary model probe succeeds', async () => {
    let requestBody: any;
    globalThis.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return jsonResponse({ id: 'chatcmpl-test' });
    }) as any;

    const result = await testProviderConnection(customOpenAIProvider());

    expect(result).toMatchObject({ success: true, modelVerified: true });
    expect(requestBody).toMatchObject({
      model: 'gpt-test',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('passes responses providers only after a primary model probe succeeds', async () => {
    let requestUrl = '';
    let requestBody: any;
    globalThis.fetch = jest.fn(async (url: string, init: RequestInit) => {
      requestUrl = url;
      requestBody = JSON.parse(String(init.body));
      return jsonResponse({ id: 'resp-test' });
    }) as any;

    const result = await testProviderConnection(openAIProvider());

    expect(result).toMatchObject({ success: true, modelVerified: true });
    expect(requestUrl).toBe('https://example.test/v1/responses');
    expect(requestBody).toMatchObject({
      model: 'gpt-test',
      input: 'hi',
      max_output_tokens: 1,
    });
  });

  it('defaults historical custom OpenAI-compatible providers to chat completions', async () => {
    let requestUrl = '';
    globalThis.fetch = jest.fn(async (url: string) => {
      requestUrl = url;
      return jsonResponse({ id: 'chatcmpl-test' });
    }) as any;

    const result = await testProviderConnection(customOpenAIProvider({
      connection: {
        agentRuntime: 'openai-agents-sdk',
        openaiBaseUrl: 'https://legacy.example/v1',
        openaiApiKey: 'sk-legacy',
      },
    }));

    expect(result).toMatchObject({ success: true, modelVerified: true });
    expect(requestUrl).toBe('https://legacy.example/v1/chat/completions');
  });

  it('fails Ollama when the configured primary model is not installed', async () => {
    globalThis.fetch = jest.fn(async () => jsonResponse({
      models: [{ name: 'qwen3:8b' }],
    })) as any;

    const result = await testProviderConnection(ollamaProvider());

    expect(result.success).toBe(false);
    expect(result.modelVerified).toBe(false);
    expect(result.error).toContain('model "missing-model" not found');
  });

  it('fails Ollama when tags list the model but the chat probe fails', async () => {
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'missing-model' }] });
      }
      return jsonResponse({ error: 'model load failed' }, 400);
    }) as any;

    const result = await testProviderConnection(ollamaProvider());

    expect(result.success).toBe(false);
    expect(result.error).toBe('model load failed');
    expect(calls).toEqual([
      'http://localhost:11434/api/tags',
      'http://localhost:11434/v1/chat/completions',
    ]);
  });

  it('probes the concrete Ollama tag when primary model omits the tag', async () => {
    let requestBody: any;
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'qwen3:8b' }] });
      }
      requestBody = JSON.parse(String(init?.body));
      return requestBody.model === 'qwen3:8b'
        ? jsonResponse({ id: 'chatcmpl-test' })
        : jsonResponse({ error: 'model not found' }, 404);
    }) as any;

    const result = await testProviderConnection(ollamaProvider({
      models: {
        primary: 'qwen3',
        light: 'qwen3',
      },
    }));

    expect(result).toMatchObject({ success: true, modelVerified: true });
    expect(requestBody).toMatchObject({ model: 'qwen3:8b' });
  });

  it('fails Ollama when an untagged primary model matches multiple installed tags', async () => {
    globalThis.fetch = jest.fn(async () => jsonResponse({
      models: [{ name: 'qwen3:8b' }, { name: 'qwen3:14b' }],
    })) as any;

    const result = await testProviderConnection(ollamaProvider({
      models: {
        primary: 'qwen3',
        light: 'qwen3',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.modelVerified).toBe(false);
    expect(result.error).toContain('matches multiple installed tags');
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

function customOpenAIProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'custom-provider-test',
    name: 'Custom Provider Test',
    category: 'custom',
    type: 'custom',
    isActive: false,
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    models: {
      primary: 'gpt-test',
      light: 'gpt-test-mini',
    },
    connection: {
      agentRuntime: 'openai-agents-sdk',
      openaiBaseUrl: 'https://example.test/v1',
      openaiApiKey: 'sk-test',
      openaiProtocol: 'chat_completions',
    },
    ...overrides,
  };
}

function ollamaProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'ollama-provider-test',
    name: 'Ollama Provider Test',
    category: 'official',
    type: 'ollama',
    isActive: false,
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    models: {
      primary: 'missing-model',
      light: 'missing-model',
    },
    connection: {
      openaiBaseUrl: 'http://localhost:11434/v1',
      agentRuntime: 'openai-agents-sdk',
      openaiProtocol: 'chat_completions',
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
