// backend/src/services/providerManager/connectionTester.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentRuntimeKind, DualSurfaceProviderType, ProviderConfig, ProviderType, TestResult } from './types';

const TEST_REQUEST_TIMEOUT_MS = 10000;
const TEST_TOTAL_TIMEOUT_MS = 15000;
const TEST_RESPONSE_BODY_TIMEOUT_MS = 3000;
const DUAL_SURFACE_PROVIDER_TYPES: DualSurfaceProviderType[] = [
  'deepseek',
  'glm',
  'qwen',
  'qwen_coding',
  'kimi_code',
  'kimi',
  'doubao',
  'minimax',
  'xiaomi',
  'tencent_token_plan',
  'tencent_coding_plan',
  'hunyuan',
  'qianfan',
  'stepfun',
  'siliconflow',
  'huawei',
];
const CLAUDE_RUNTIME_TYPES: ProviderType[] = ['anthropic', 'bedrock', 'vertex', ...DUAL_SURFACE_PROVIDER_TYPES, 'custom'];
const OPENAI_RUNTIME_TYPES: ProviderType[] = ['openai', 'ollama', ...DUAL_SURFACE_PROVIDER_TYPES, 'custom'];

interface RequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export async function testProviderConnection(provider: ProviderConfig): Promise<TestResult> {
  const start = Date.now();
  try {
    const totalTimeoutMs = getTimeoutMs('PROVIDER_TEST_TOTAL_TIMEOUT_MS', TEST_TOTAL_TIMEOUT_MS);
    const result = await withTimeout(
      runTest(provider),
      totalTimeoutMs,
      () => new Error(`Provider connection test timed out after ${totalTimeoutMs / 1000}s`),
    );
    return { ...result, latencyMs: Date.now() - start };
  } catch (err: any) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err.message || 'Connection test failed',
    };
  }
}

async function runTest(provider: ProviderConfig): Promise<Omit<TestResult, 'latencyMs'>> {
  if (provider.type === 'bedrock') return testBedrock(provider);
  if (provider.type === 'vertex') return testVertex(provider);
  if (provider.type === 'ollama') return testOllama(provider);

  if (resolveAgentRuntime(provider) === 'openai-agents-sdk') {
    return testOpenAICompatible(provider);
  }
  return testAnthropic(provider);
}

function resolveAgentRuntime(provider: ProviderConfig): AgentRuntimeKind {
  if (
    provider.connection.agentRuntime &&
    provider.connection.agentRuntime !== 'claude-agent-sdk' &&
    provider.connection.agentRuntime !== 'openai-agents-sdk'
  ) {
    throw new Error(`Invalid agent runtime: ${provider.connection.agentRuntime}`);
  }
  if (
    provider.connection.agentRuntime === 'claude-agent-sdk' ||
    provider.connection.agentRuntime === 'openai-agents-sdk'
  ) {
    if (!supportsRuntime(provider.type, provider.connection.agentRuntime)) {
      throw new Error(`Provider type "${provider.type}" does not support ${provider.connection.agentRuntime}`);
    }
    return provider.connection.agentRuntime;
  }
  if (provider.type === 'openai' || provider.type === 'ollama') return 'openai-agents-sdk';
  if (
    provider.type === 'custom' &&
    (provider.connection.openaiProtocol || provider.connection.openaiBaseUrl || provider.connection.openaiApiKey)
  ) {
    const hasClaudeSurface = Boolean(
      provider.connection.claudeBaseUrl ||
      provider.connection.claudeApiKey ||
      provider.connection.claudeAuthToken,
    );
    return hasClaudeSurface ? 'claude-agent-sdk' : 'openai-agents-sdk';
  }
  return 'claude-agent-sdk';
}

function supportsRuntime(type: ProviderType, runtime: AgentRuntimeKind): boolean {
  return runtime === 'openai-agents-sdk'
    ? OPENAI_RUNTIME_TYPES.includes(type)
    : CLAUDE_RUNTIME_TYPES.includes(type);
}

function sharedKeyShouldUseClaudeAuthToken(type: ProviderType): boolean {
  return [
    'deepseek',
    'qwen',
    'qwen_coding',
    'kimi',
    'doubao',
    'minimax',
    'tencent_token_plan',
    'tencent_coding_plan',
    'hunyuan',
    'qianfan',
    'stepfun',
    'huawei',
  ].includes(type);
}

function getClaudeBaseUrl(provider: ProviderConfig, defaultBaseUrl: string): string {
  return provider.connection.claudeBaseUrl || provider.connection.baseUrl || defaultBaseUrl;
}

function getOpenAIBaseUrl(provider: ProviderConfig, defaultBaseUrl: string): string {
  return provider.connection.openaiBaseUrl || provider.connection.baseUrl || defaultBaseUrl;
}

function getOpenAIApiKey(provider: ProviderConfig): string | undefined {
  return provider.connection.openaiApiKey || provider.connection.apiKey;
}

async function testAnthropic(provider: ProviderConfig): Promise<Omit<TestResult, 'latencyMs'>> {
  const defaultBaseUrl = provider.type === 'deepseek'
    ? 'https://api.deepseek.com/anthropic'
    : 'https://api.anthropic.com';
  const baseUrl = getClaudeBaseUrl(provider, defaultBaseUrl);
  const apiKey = provider.connection.claudeApiKey ||
    (!provider.connection.claudeAuthToken && !sharedKeyShouldUseClaudeAuthToken(provider.type)
      ? provider.connection.apiKey
      : undefined);
  const authToken = provider.connection.claudeAuthToken ||
    (!provider.connection.claudeApiKey && sharedKeyShouldUseClaudeAuthToken(provider.type)
      ? provider.connection.apiKey
      : undefined);
  if (!apiKey && !authToken) return { success: false, error: 'API key or auth token is required' };

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.models.primary || 'claude-sonnet-4-20250514',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  if (res.ok) return { success: true, modelVerified: true };

  const body = await safeJson(res);
  if (res.status === 401) return { success: false, error: 'Invalid API key (401 Unauthorized)' };
  if (res.status === 403) return { success: false, error: 'Access denied (403 Forbidden)' };
  if (res.status === 404) return { success: false, error: `Model not found: ${provider.models.primary}` };
  return { success: false, error: body?.error?.message || `API error: ${res.status}` };
}

async function testBedrock(provider: ProviderConfig): Promise<Omit<TestResult, 'latencyMs'>> {
  const region = provider.connection.awsRegion || 'us-east-1';
  const baseUrl = provider.connection.baseUrl ||
    `https://bedrock-runtime.${region}.amazonaws.com`;

  if (provider.connection.awsBearerToken) {
    return testBedrockWithBearer(provider, baseUrl);
  }
  if (provider.connection.awsAccessKeyId && provider.connection.awsSecretAccessKey) {
    return testBedrockWithSigV4(provider, baseUrl, region);
  }
  if (provider.connection.awsProfile) {
    return { success: false, error: 'AWS Profile auth requires AWS SDK — use Access Key or Bearer Token for connection test' };
  }
  return { success: false, error: 'No AWS credentials configured (need Bearer Token or Access Key)' };
}

async function testBedrockWithBearer(
  provider: ProviderConfig,
  baseUrl: string,
): Promise<Omit<TestResult, 'latencyMs'>> {
  const model = provider.models.primary || 'anthropic.claude-sonnet-4-20250514-v1:0';
  const url = `${baseUrl.replace(/\/+$/, '')}/model/${model}/invoke`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.connection.awsBearerToken}`,
    },
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  if (res.ok) return { success: true, modelVerified: true };
  if (res.status === 401 || res.status === 403) {
    return { success: false, error: `AWS auth failed (${res.status}) — check Bearer Token` };
  }
  const body = await safeJson(res);
  return { success: false, error: body?.message || `Bedrock error: ${res.status}` };
}

async function testBedrockWithSigV4(
  provider: ProviderConfig,
  baseUrl: string,
  region: string,
): Promise<Omit<TestResult, 'latencyMs'>> {
  const model = provider.models.primary || 'anthropic.claude-sonnet-4-20250514-v1:0';
  const payload = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  const url = `${baseUrl.replace(/\/+$/, '')}/model/${model}/invoke`;
  const headers = await signAwsRequest({
    method: 'POST',
    url,
    region,
    service: 'bedrock',
    accessKeyId: provider.connection.awsAccessKeyId!,
    secretAccessKey: provider.connection.awsSecretAccessKey!,
    sessionToken: provider.connection.awsSessionToken,
    body: payload,
  });

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });

  if (res.ok) return { success: true, modelVerified: true };
  if (res.status === 401 || res.status === 403) {
    return { success: false, error: `AWS SigV4 auth failed (${res.status}) — check Access Key / Secret` };
  }
  const body = await safeJson(res);
  return { success: false, error: body?.message || `Bedrock error: ${res.status}` };
}

async function testVertex(provider: ProviderConfig): Promise<Omit<TestResult, 'latencyMs'>> {
  const projectId = provider.connection.gcpProjectId;
  const region = provider.connection.gcpRegion || 'us-central1';
  if (!projectId) return { success: false, error: 'GCP Project ID is required' };

  // Vertex requires OAuth — can only test if env has GOOGLE_APPLICATION_CREDENTIALS
  // For now, validate the endpoint is reachable
  const model = provider.models.primary || 'claude-sonnet-4@20250514';
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/anthropic/models/${model}:streamRawPredict`;

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // 401/403 means endpoint reachable but auth needed — partial success
    if (res.status === 401 || res.status === 403) {
      return { success: true, modelVerified: false, error: 'Endpoint reachable but OAuth required (run gcloud auth)' };
    }
    if (res.ok) return { success: true, modelVerified: true };
    const body = await safeJson(res);
    return { success: false, error: body?.error?.message || `Vertex error: ${res.status}` };
  } catch (err: any) {
    if (err.cause?.code === 'ENOTFOUND') {
      return { success: false, error: `DNS resolution failed — check region: ${region}` };
    }
    throw err;
  }
}

async function testOpenAICompatible(provider: ProviderConfig): Promise<Omit<TestResult, 'latencyMs'>> {
  const type = provider.type;
  const defaults: Record<string, string> = {
    deepseek: 'https://api.deepseek.com/v1',
    openai: 'https://api.openai.com/v1',
    custom: '',
  };
  const baseUrl = getOpenAIBaseUrl(provider, defaults[type] || '');
  if (!baseUrl) return { success: false, error: 'Base URL is required' };

  const apiKey = getOpenAIApiKey(provider) || '';

  // Try /models endpoint first (lightest check)
  const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(modelsUrl, { method: 'GET', headers });

  if (res.ok) return { success: true, modelVerified: false };
  if (res.status === 401) return { success: false, error: 'Invalid API key (401 Unauthorized)' };
  if (res.status === 403) return { success: false, error: 'Access denied (403 Forbidden)' };

  // Some proxies don't support /models — try chat completion
  const chatUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const chatRes = await fetchWithTimeout(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.models.primary,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  if (chatRes.ok) return { success: true, modelVerified: true };
  if (chatRes.status === 401) return { success: false, error: 'Invalid API key (401 Unauthorized)' };
  const body = await safeJson(chatRes);
  return { success: false, error: body?.error?.message || `API error: ${chatRes.status}` };
}

async function testOllama(provider: ProviderConfig): Promise<Omit<TestResult, 'latencyMs'>> {
  const baseUrl = getOpenAIBaseUrl(provider, 'http://localhost:11434/v1')
    .replace(/\/v1\/?$/, '');
  const tagsUrl = `${baseUrl.replace(/\/+$/, '')}/api/tags`;

  try {
    const res = await fetchWithTimeout(tagsUrl, { method: 'GET', headers: {} });
    if (!res.ok) {
      return { success: false, error: `Ollama returned ${res.status}` };
    }
    const data = await safeJson(res);
    const models: string[] = (data?.models || []).map((m: any) => m.name || m.model);
    const target = provider.models.primary;
    if (target && models.length > 0) {
      const found = models.some(m => m === target || m.startsWith(`${target}:`));
      if (!found) {
        return { success: true, modelVerified: false, error: `Connected but model "${target}" not found. Available: ${models.slice(0, 5).join(', ')}` };
      }
      return { success: true, modelVerified: true };
    }
    return { success: true, modelVerified: false };
  } catch (err: any) {
    if (err.cause?.code === 'ECONNREFUSED') {
      return { success: false, error: `Cannot connect to Ollama at ${baseUrl} — is it running?` };
    }
    throw err;
  }
}

// --- Utilities ---

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = getTimeoutMs('PROVIDER_TEST_REQUEST_TIMEOUT_MS', TEST_REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Connection timed out after ${timeoutMs / 1000}s`);
    }
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Connection refused — server not reachable at ${new URL(url).origin}`);
    }
    if (err.cause?.code === 'ENOTFOUND') {
      throw new Error(`DNS resolution failed for ${new URL(url).hostname}`);
    }
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(res: Response): Promise<any> {
  try {
    const body = await readResponseTextWithTimeout(res);
    if (!body) return null;
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function readResponseTextWithTimeout(res: Response): Promise<string | null> {
  const timeoutMs = getTimeoutMs('PROVIDER_TEST_RESPONSE_BODY_TIMEOUT_MS', TEST_RESPONSE_BODY_TIMEOUT_MS);
  return withTimeout(
    res.text(),
    timeoutMs,
    () => {
      cancelResponseBody(res);
      return new Error(`Response body timed out after ${timeoutMs / 1000}s`);
    },
  );
}

function cancelResponseBody(res: Response): void {
  try {
    void res.body?.cancel();
  } catch {
    // Best-effort cleanup only; the caller will return a normal test failure.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(createError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getTimeoutMs(envName: string, fallbackMs: number): number {
  const raw = process.env[envName];
  if (!raw) return fallbackMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

// --- Minimal AWS SigV4 signer (for Bedrock test without full AWS SDK) ---

interface SigV4Params {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  body: string;
}

async function signAwsRequest(params: SigV4Params): Promise<Record<string, string>> {
  const { method, url, region, service, accessKeyId, secretAccessKey, sessionToken, body } = params;
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);

  const host = parsedUrl.host;
  const path = parsedUrl.pathname;

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-date': amzDate,
    'content-type': 'application/json',
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaderKeys = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join('');

  const payloadHash = await sha256Hex(body);
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaderKeys, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderKeys}, Signature=${signature}`;

  return {
    'Authorization': authHeader,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };
}

async function sha256Hex(data: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

async function hmacHex(key: Buffer | string, data: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

async function hmacDigest(key: Buffer | string, data: string): Promise<Buffer> {
  const crypto = await import('crypto');
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

async function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<Buffer> {
  const kDate = await hmacDigest(`AWS4${key}`, dateStamp);
  const kRegion = await hmacDigest(kDate, region);
  const kService = await hmacDigest(kRegion, service);
  return hmacDigest(kService, 'aws4_request');
}
