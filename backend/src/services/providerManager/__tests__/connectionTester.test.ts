// backend/src/services/providerManager/__tests__/connectionTester.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

const mockRequestProviderEndpoint = jest.fn();

jest.mock('../providerEndpointRequest', () => ({
  requestProviderEndpoint: (...args: unknown[]) => mockRequestProviderEndpoint(...args),
}));

import { testProviderConnection } from '../connectionTester';
import type { ProviderConfig } from '../types';

describe('Provider connection tester', () => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    'PROVIDER_TEST_REQUEST_TIMEOUT_MS',
    'PROVIDER_TEST_TOTAL_TIMEOUT_MS',
    'PROVIDER_TEST_RESPONSE_BODY_TIMEOUT_MS',
  ];

  beforeEach(() => {
    mockRequestProviderEndpoint.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await globalThis.fetch(url, init);
      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        cancelBody: () => response.body?.cancel(),
      };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockRequestProviderEndpoint.mockReset();
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

  it('validates custom Pi Agent Core providers locally without network fetch', async () => {
    globalThis.fetch = jest.fn() as any;

    const result = await testProviderConnection(customPiProvider());

    expect(result).toMatchObject({
      success: true,
      modelVerified: false,
      error: 'Pi Agent Core provider configuration is syntactically valid; runtime smoke runs during analysis.',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fails Vertex connection tests on unauthenticated 401 or 403 responses', async () => {
    globalThis.fetch = jest.fn(async () => jsonResponse({
      error: { message: 'Request had invalid authentication credentials.' },
    }, 401)) as any;

    const result = await testProviderConnection({
      ...openAIProvider(),
      type: 'vertex',
      connection: {
        gcpProjectId: 'demo-project',
        gcpRegion: 'us-central1',
      },
      models: {
        primary: 'claude-sonnet-4@20250514',
        light: 'claude-haiku-4@20250514',
      },
    });

    expect(result.success).toBe(false);
    expect(result.modelVerified).toBe(false);
    expect(result.error).toContain('Vertex auth failed (401)');
  });

  it('fails custom Pi Agent Core providers with invalid model JSON', async () => {
    const result = await testProviderConnection(customPiProvider({
      connection: {
        agentRuntime: 'pi-agent-core',
        piAgentCoreModelJson: '{"id":',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Pi Agent Core model JSON is invalid');
  });

  it('validates custom OpenCode providers with model JSON locally without network fetch', async () => {
    globalThis.fetch = jest.fn() as any;

    const result = await testProviderConnection(customOpenCodeProvider());

    expect(result).toMatchObject({
      success: true,
      modelVerified: false,
      error: 'OpenCode provider configuration is syntactically valid; runtime smoke runs during analysis.',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('accepts custom OpenCode providers backed by OpenAI-compatible fields', async () => {
    const result = await testProviderConnection(customOpenCodeProvider({
      models: {
        primary: 'opencode-model',
        light: 'opencode-light',
      },
      connection: {
        agentRuntime: 'opencode',
        openaiBaseUrl: 'https://example.test/v1',
        openaiApiKey: 'sk-test',
        openaiProtocol: 'chat_completions',
      },
    }));

    expect(result).toMatchObject({
      success: true,
      modelVerified: false,
      error: 'OpenCode will use the OpenAI-compatible provider fields through its server runtime.',
    });
  });

  it('fails custom OpenCode providers with invalid model JSON', async () => {
    const result = await testProviderConnection(customOpenCodeProvider({
      connection: {
        agentRuntime: 'opencode',
        openCodeModelJson: '{"modelID":',
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('OpenCode model JSON is invalid');
  });

  it('validates custom Qoder providers locally without an Anthropic network probe', async () => {
    globalThis.fetch = jest.fn() as any;

    const result = await testProviderConnection(customQoderProvider());

    expect(result).toMatchObject({
      success: true,
      modelVerified: false,
      error: 'Qoder provider configuration is syntactically valid; SDK and authentication smoke checks run during analysis.',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a custom Qoder provider without a PAT or CLI path', async () => {
    const result = await testProviderConnection(customQoderProvider({
      connection: { agentRuntime: 'qoder-agent-sdk' },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Qoder Agent SDK requires a Personal Access Token or Qoder CLI path');
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

function customPiProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'custom-pi-provider-test',
    name: 'Custom Pi Provider Test',
    category: 'custom',
    type: 'custom',
    isActive: false,
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    models: {
      primary: 'pi-model',
      light: 'pi-light',
    },
    connection: {
      agentRuntime: 'pi-agent-core',
      piAgentCoreModelJson: '{"id":"pi-test","provider":"test"}',
    },
    ...overrides,
  };
}

function customOpenCodeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'custom-opencode-provider-test',
    name: 'Custom OpenCode Provider Test',
    category: 'custom',
    type: 'custom',
    isActive: false,
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    models: {
      primary: 'opencode-model',
      light: 'opencode-light',
    },
    connection: {
      agentRuntime: 'opencode',
      openCodeModelJson: '{"providerID":"smartperfetto","modelID":"opencode-test"}',
    },
    ...overrides,
  };
}

function customQoderProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'custom-qoder-provider-test',
    name: 'Custom Qoder Provider Test',
    category: 'custom',
    type: 'custom',
    isActive: false,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    models: {
      primary: 'ultimate',
      light: 'ultimate',
    },
    connection: {
      agentRuntime: 'qoder-agent-sdk',
      qoderAccessToken: 'qoder-test-token',
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
