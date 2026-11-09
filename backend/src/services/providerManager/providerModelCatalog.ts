// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'crypto';
import {
  requestProviderEndpoint,
  type ProviderEndpointResponse,
} from './providerEndpointRequest';
import {firstNonBlank} from './providerTypes';
import {isDualSurfaceProviderType} from './providerRuntimeMatrix';
import type {
  ModelOption,
  ProviderConfig,
  ProviderScope,
  ProviderTemplate,
} from './types';

const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FAILED_CATALOG_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2500;
const DEFAULT_MAX_CACHE_ENTRIES = 128;
const MAX_DISCOVERED_MODELS = 200;
const MAX_MODEL_ID_LENGTH = 200;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/;
const SPECIALIZED_MODEL_ID =
  /(?:^|[._:/-])(?:embed(?:ding)?s?|rerank(?:er|ing)?|ranker|moderation|realtime|audio|transcrib(?:e|er|ing|tion)?|tts|whisper|dall-e|image|sora|search|ocr|clip|siglip|guard|classifier|classification|reward)(?:$|[._:/-])/i;
const SPECIALIZED_MODEL_FAMILY =
  /(?:^|\/)(?:bge|e5|gte|colpali)(?:[._:/-]|$)/i;

const PROVIDER_MODEL_FAMILY: Partial<Record<ProviderConfig['type'], RegExp>> = {
  anthropic: /^claude-/i,
  deepseek: /^deepseek-/i,
  openai: /^(?:ft:)?(?:gpt-|chatgpt-|o[1-9](?:-|$)|codex-|computer-use-)/i,
};

type ProviderEndpointRequest = typeof requestProviderEndpoint;

export interface DiscoveredProviderModelCatalog {
  models: ModelOption[];
  fetchedAt: string;
  cached: boolean;
}

interface CachedCatalog {
  catalog?: DiscoveredProviderModelCatalog;
  expiresAtMs: number;
}

interface ProviderModelCatalogOptions {
  now?: () => number;
  request?: ProviderEndpointRequest;
  ttlMs?: number;
  requestTimeoutMs?: number;
  maxCacheEntries?: number;
}

interface CatalogRequest {
  url: string;
  headers: Record<string, string>;
  responseKind: 'openai' | 'ollama';
  providerType: ProviderConfig['type'];
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function anthropicModelsUrl(baseUrl: string): string {
  return /\/v1\/?$/i.test(baseUrl)
    ? appendPath(baseUrl, 'models')
    : appendPath(baseUrl, 'v1/models');
}

function openAIBaseUrl(
  provider: ProviderConfig,
  template: ProviderTemplate,
): string | undefined {
  return (
    firstNonBlank(provider.connection.openaiBaseUrl, provider.connection.baseUrl, template.defaultConnection?.openaiBaseUrl) ??
    (provider.type === 'openai' ? 'https://api.openai.com/v1' : undefined)
  );
}

function anthropicBaseUrl(
  provider: ProviderConfig,
  template: ProviderTemplate,
): string | undefined {
  return (
    firstNonBlank(provider.connection.claudeBaseUrl, provider.connection.baseUrl, template.defaultConnection?.claudeBaseUrl) ??
    (provider.type === 'anthropic' ? 'https://api.anthropic.com' : undefined)
  );
}

function resolveCatalogRequest(
  provider: ProviderConfig,
  template: ProviderTemplate,
): CatalogRequest | undefined {
  if (provider.type === 'bedrock' || provider.type === 'vertex') return undefined;

  if (provider.type === 'ollama') {
    const baseUrl = openAIBaseUrl(provider, template)?.replace(/\/v1\/?$/i, '');
    if (!baseUrl) return undefined;
    return {
      url: appendPath(baseUrl, 'api/tags'),
      headers: {},
      responseKind: 'ollama',
      providerType: provider.type,
    };
  }

  const shouldUseOpenAI =
    provider.type === 'openai' ||
    isDualSurfaceProviderType(provider.type) ||
    provider.connection.agentRuntime === 'openai-agents-sdk' ||
    !!firstNonBlank(provider.connection.openaiBaseUrl);
  if (shouldUseOpenAI) {
    const baseUrl = openAIBaseUrl(provider, template);
    const apiKey =
      provider.connection.openaiApiKey || provider.connection.apiKey;
    if (!baseUrl || !apiKey || apiKey.startsWith('****')) return undefined;
    return {
      url: appendPath(baseUrl, 'models'),
      headers: {Authorization: `Bearer ${apiKey}`},
      responseKind: 'openai',
      providerType: provider.type,
    };
  }

  const baseUrl = anthropicBaseUrl(provider, template);
  const apiKey = provider.connection.claudeApiKey || provider.connection.apiKey;
  const authToken = provider.connection.claudeAuthToken;
  if (!baseUrl || (!apiKey && !authToken)) return undefined;
  if (apiKey?.startsWith('****') || authToken?.startsWith('****')) return undefined;
  return {
    url: anthropicModelsUrl(baseUrl),
    headers: {
      'anthropic-version': '2023-06-01',
      ...(apiKey
        ? {'x-api-key': apiKey}
        : {Authorization: `Bearer ${authToken}`}),
    },
    responseKind: 'openai',
    providerType: provider.type,
  };
}

function isAnalysisModelId(
  id: string,
  providerType: ProviderConfig['type'],
): boolean {
  if (
    !id ||
    id.length > MAX_MODEL_ID_LENGTH ||
    !SAFE_MODEL_ID.test(id)
  ) {
    return false;
  }
  if (SPECIALIZED_MODEL_ID.test(id) || SPECIALIZED_MODEL_FAMILY.test(id)) {
    return false;
  }
  const family = PROVIDER_MODEL_FAMILY[providerType];
  return !family || family.test(id);
}

function modelTier(id: string): ModelOption['tier'] {
  return /(?:flash|mini|nano|haiku|turbo|instant|fast|small|lite)/i.test(id)
    ? 'light'
    : 'primary';
}

function parseCatalogModels(
  text: string,
  kind: CatalogRequest['responseKind'],
  providerType: ProviderConfig['type'],
): ModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Provider model catalog returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Provider model catalog returned an invalid object');
  }
  const record = parsed as Record<string, unknown>;
  const entries = kind === 'ollama' ? record.models : record.data;
  if (!Array.isArray(entries)) {
    throw new Error('Provider model catalog response omitted its model list');
  }

  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const rawId = kind === 'ollama' ? row.name ?? row.model : row.id;
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!isAnalysisModelId(id, providerType) || seen.has(id)) continue;
    seen.add(id);
    models.push({id, name: id, tier: modelTier(id)});
    if (models.length >= MAX_DISCOVERED_MODELS) break;
  }
  if (models.length === 0) {
    throw new Error('Provider model catalog returned no usable analysis models');
  }
  return models;
}

function scopeFingerprint(scope: ProviderScope): string {
  return createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.workspaceId, scope.userId ?? '']))
    .digest('hex');
}

function providerFingerprint(
  provider: ProviderConfig,
  template: ProviderTemplate,
  scope: ProviderScope,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scope: scopeFingerprint(scope),
        providerId: provider.id,
        type: provider.type,
        updatedAt: provider.updatedAt,
        models: provider.models,
        connection: provider.connection,
        templateConnection: template.defaultConnection,
      }),
    )
    .digest('hex');
}

async function responseTextWithin(
  response: ProviderEndpointResponse,
  timeoutMs: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          response.cancelBody();
          reject(new Error('Provider model catalog response timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function mergeModelOptions(
  curated: readonly ModelOption[],
  discovered: readonly ModelOption[],
): ModelOption[] {
  const availableModels = [...curated];
  const seen = new Set(availableModels.map((model) => model.id));
  for (const model of discovered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    availableModels.push(model);
  }
  return availableModels;
}

export class ProviderModelCatalogService {
  private readonly now: () => number;
  private readonly request: ProviderEndpointRequest;
  private readonly ttlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, CachedCatalog>();
  private readonly inFlight = new Map<
    string,
    Promise<DiscoveredProviderModelCatalog>
  >();

  constructor(options: ProviderModelCatalogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.request = options.request ?? requestProviderEndpoint;
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxCacheEntries =
      options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  async discover(
    provider: ProviderConfig,
    template: ProviderTemplate,
    scope: ProviderScope,
  ): Promise<DiscoveredProviderModelCatalog | undefined> {
    const request = resolveCatalogRequest(provider, template);
    if (!request) return undefined;
    const key = providerFingerprint(provider, template, scope);
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > now) {
      return cached.catalog ? {...cached.catalog, cached: true} : undefined;
    }
    const pending = this.inFlight.get(key);
    if (cached?.catalog) {
      if (!pending) {
        void this.refreshCatalog(key, request, cached.catalog).catch(
          () => undefined,
        );
      }
      return {...cached.catalog, cached: true};
    }
    if (pending) return pending;

    return this.refreshCatalog(key, request);
  }

  private async fetchCatalog(
    catalogRequest: CatalogRequest,
  ): Promise<DiscoveredProviderModelCatalog> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.request(
        catalogRequest.url,
        {method: 'GET', headers: catalogRequest.headers, signal: controller.signal},
        this.requestTimeoutMs,
      );
      if (!response.ok) {
        response.cancelBody();
        throw new Error(`Provider model catalog returned HTTP ${response.status}`);
      }
      const text = await responseTextWithin(response, this.requestTimeoutMs);
      return {
        models: parseCatalogModels(
          text,
          catalogRequest.responseKind,
          catalogRequest.providerType,
        ),
        fetchedAt: new Date(this.now()).toISOString(),
        cached: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private refreshCatalog(
    key: string,
    request: CatalogRequest,
    staleCatalog?: DiscoveredProviderModelCatalog,
  ): Promise<DiscoveredProviderModelCatalog> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const discovery = this.fetchCatalog(request)
      .then(catalog => {
        this.insertCache(key, catalog, this.ttlMs);
        return catalog;
      })
      .catch(error => {
        this.insertCache(key, staleCatalog, FAILED_CATALOG_RETRY_MS);
        if (staleCatalog) return {...staleCatalog, cached: true};
        throw error;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, discovery);
    return discovery;
  }

  private insertCache(
    key: string,
    catalog: DiscoveredProviderModelCatalog | undefined,
    ttlMs: number,
  ): void {
    const now = this.now();
    for (const [candidate, entry] of this.cache) {
      if (entry.expiresAtMs <= now) this.cache.delete(candidate);
    }
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, {catalog, expiresAtMs: now + ttlMs});
  }
}

let catalogService: ProviderModelCatalogService | undefined;

export function getProviderModelCatalogService(): ProviderModelCatalogService {
  catalogService ??= new ProviderModelCatalogService();
  return catalogService;
}

export function resetProviderModelCatalogService(): void {
  catalogService = undefined;
}
