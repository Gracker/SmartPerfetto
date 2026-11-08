// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  PI_AGENT_CORE_API_KEY_ENV,
  PI_AGENT_CORE_AUTH_TOKEN_ENV,
  PI_AGENT_CORE_MODEL_JSON_ENV,
  PI_AGENT_CORE_MODEL_UNAVAILABLE_ENV,
  parsePiAgentCoreModelConfig,
  routeUsesAwsCredentialChain,
  piProviderApiKeyEnvNames,
  type PiModelRoute,
} from '../../agentRuntime/engines/pi/piAgentCoreConfig';
import {hasConcreteEnvValue, isEnabledEnvFlag} from '../../agentRuntime/envCredentialSources';
import {mergeIsolatedProviderEnv} from './envIsolation';
import {
  CLAUDE_AGENT_RUNTIME_KIND,
  OPENAI_AGENT_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  PI_AGENT_CORE_RUNTIME_KIND,
  isRecordedProductionRuntimeKind,
  type RecordedProductionRuntimeKind,
} from '../../agentRuntime/runtimeKinds';
import {PI_CATALOG_ROUTES} from './providerTypes';
import type {ProviderConfig, ProviderType} from './types';

type PiCatalogProviderType = keyof typeof PI_CATALOG_ROUTES;
type EnvLike = Record<string, string | undefined>;

export function isPiCatalogProviderType(type: ProviderType): type is PiCatalogProviderType {
  return Object.prototype.hasOwnProperty.call(PI_CATALOG_ROUTES, type);
}

/**
 * The Pi env for a profile that already ran on Pi through a catalog route,
 * without an explicit model JSON: a deterministic catalog reference for the
 * primary model on the provider's own endpoint, the lowest supported
 * reasoning level unless one is authored, and the API key under Pi's own key
 * env for that catalog provider (never ANTHROPIC_* or OPENAI_*). Frozen: its
 * output is part of those profiles' provider snapshot.
 */
export function piCatalogProviderEnv(provider: ProviderConfig): Record<string, string> | undefined {
  if (!isPiCatalogProviderType(provider.type)) return undefined;
  const route = PI_CATALOG_ROUTES[provider.type];
  const {connection} = provider;
  const baseUrl = route.surface === 'openai'
    ? connection.openaiBaseUrl || connection.baseUrl
    : connection.claudeBaseUrl || connection.baseUrl;
  const keyEnv = piProviderApiKeyEnvNames(route.catalogProviders[0])[0];
  const apiKey = connection.apiKey?.trim();
  return {
    [PI_AGENT_CORE_MODEL_JSON_ENV]: JSON.stringify({
      catalog: {
        providers: route.catalogProviders,
        id: provider.models.primary,
        ...(baseUrl ? {baseUrl} : {}),
        defaultThinkingLevel: 'lowest_supported',
      },
      apiKeyEnv: keyEnv,
    }),
    ...(apiKey ? {[keyEnv]: apiKey} : {}),
  };
}

// The endpoints and models the retired engines used when their env named none.
// The defaults the retired Claude/OpenAI runtimes applied, frozen here: those
// engines are deleted after one release, and their configuration moves with them.
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';
const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';
const BEDROCK_DEFAULT_REGION = 'us-east-1';
const VERTEX_DEFAULT_REGION = 'us-east5';
const LOCAL_ENDPOINT_PLACEHOLDER_KEY = 'smartperfetto-local';

/** Why a retired runtime's configuration has no Pi equivalent; Pi reports it instead of guessing. */
export type PiRouteUnavailableReason =
  | 'credentials_missing'
  | 'bedrock_credentials_missing'
  | 'vertex_project_missing'
  | 'vertex_model_region_override'
  | 'model_json_credential_chain'
  | 'opencode_model_json_untranslatable'
  | 'qoder_untranslatable';

/** The credential a resolved route sends, kept out of the model JSON. */
interface PiRouteCredentials {
  /** Anthropic `x-api-key`, or the OpenAI-compatible Bearer key. */
  apiKey?: string;
  /** An Anthropic-compatible `Authorization: Bearer` token (ANTHROPIC_AUTH_TOKEN). */
  authToken?: string;
  /** Bedrock credentials the retired runtime read from env. */
  awsEnv?: Record<string, string>;
  /** The explicit Google credentials file a Vertex route authenticates with. */
  googleCredentialsFile?: string;
}

export type PiLegacyRouteResolution =
  | {status: 'resolved'; route: PiModelRoute; credentials: PiRouteCredentials}
  | {status: 'unavailable'; reason: PiRouteUnavailableReason};

interface PiLegacyRouteOptions {
  /** The Pi provider id a synthesized model is registered under. */
  provider: string;
  /**
   * The env is the operator's own process configuration (an env-only setup),
   * so Bedrock without a named credential may use the host's AWS default
   * chain. A provider record must name its credential.
   */
  hostCredentialChain?: boolean;
  /** Model limits a provider template declares for this model id. */
  limits?: PiModelRoute['limits'];
}

function concrete(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  return hasConcreteEnvValue(value) ? value!.trim() : undefined;
}

function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]';
  } catch {
    return false;
  }
}

function withLimits(route: PiModelRoute, limits: PiModelRoute['limits']): PiModelRoute {
  return limits && Object.keys(limits).length > 0 ? {...route, limits} : route;
}

/** The Vertex AI endpoint Claude Code called for a region. */
function vertexBaseUrl(region: string): string {
  if (region === 'global') return 'https://aiplatform.googleapis.com/v1';
  if (region === 'us' || region === 'eu') return `https://aiplatform.${region}.rep.googleapis.com/v1`;
  return `https://${region}-aiplatform.googleapis.com/v1`;
}

function claudeRoute(env: EnvLike, options: PiLegacyRouteOptions): PiLegacyRouteResolution {
  const id = concrete(env, 'CLAUDE_MODEL') ?? CLAUDE_DEFAULT_MODEL;
  if (isEnabledEnvFlag(env.CLAUDE_CODE_USE_BEDROCK)) {
    const region = concrete(env, 'AWS_REGION') ?? concrete(env, 'AWS_DEFAULT_REGION') ?? BEDROCK_DEFAULT_REGION;
    const baseUrl = concrete(env, 'ANTHROPIC_BEDROCK_BASE_URL') ?? `https://bedrock-runtime.${region}.amazonaws.com`;
    const route = (chain?: {profile: string} | {defaultChain: true}): PiModelRoute => withLimits({
      api: 'bedrock-converse-stream', provider: 'amazon-bedrock', id, baseUrl, aws: {region, ...chain}}, options.limits);
    // The precedence the retired runtime's AWS SDK applied: bearer token, then a named profile, then keys.
    const bearerToken = concrete(env, 'AWS_BEARER_TOKEN_BEDROCK');
    if (bearerToken) {
      return {status: 'resolved', route: route(), credentials: {awsEnv: {AWS_BEARER_TOKEN_BEDROCK: bearerToken}}};
    }
    const profile = concrete(env, 'AWS_PROFILE');
    if (profile) return {status: 'resolved', route: route({profile}), credentials: {}};
    const accessKeyId = concrete(env, 'AWS_ACCESS_KEY_ID');
    const secretAccessKey = concrete(env, 'AWS_SECRET_ACCESS_KEY');
    if (accessKeyId && secretAccessKey) {
      const sessionToken = concrete(env, 'AWS_SESSION_TOKEN');
      return {status: 'resolved', route: route(), credentials: {awsEnv: {
        AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey,
        ...(sessionToken ? {AWS_SESSION_TOKEN: sessionToken} : {}),
      }}};
    }
    // An env-only setup enabled Bedrock without naming a credential: the retired
    // runtime's AWS SDK fell back to the host's default chain (shared files, SSO,
    // web identity, container or instance role), so the route resolves that chain
    // in-process. A provider record never reaches the host identity this way.
    return options.hostCredentialChain
      ? {status: 'resolved', route: route({defaultChain: true}), credentials: {}}
      : {status: 'unavailable', reason: 'bedrock_credentials_missing'};
  }
  if (isEnabledEnvFlag(env.CLAUDE_CODE_USE_VERTEX)) {
    const projectId = concrete(env, 'ANTHROPIC_VERTEX_PROJECT_ID');
    if (!projectId) return {status: 'unavailable', reason: 'vertex_project_missing'};
    // An explicit credentials file when configured; otherwise Google ADC, as the retired runtime used.
    const credentialsFile = concrete(env, 'GOOGLE_APPLICATION_CREDENTIALS');
    // Claude Code's per-model VERTEX_REGION_* variables map through its own model
    // table; rather than guess that mapping, such a setup is reported explicitly.
    if (Object.keys(env).some(key => key.startsWith('VERTEX_REGION_') && concrete(env, key))) {
      return {status: 'unavailable', reason: 'vertex_model_region_override'};
    }
    const region = concrete(env, 'CLOUD_ML_REGION') ?? VERTEX_DEFAULT_REGION;
    const baseUrl = concrete(env, 'ANTHROPIC_VERTEX_BASE_URL') ?? vertexBaseUrl(region);
    return {status: 'resolved', route: withLimits({api: 'anthropic-vertex', provider: options.provider, id, baseUrl,
      vertex: {projectId, region}}, options.limits),
    credentials: credentialsFile ? {googleCredentialsFile: credentialsFile} : {}};
  }
  const apiKey = concrete(env, 'ANTHROPIC_API_KEY');
  const authToken = concrete(env, 'ANTHROPIC_AUTH_TOKEN');
  if (!apiKey && !authToken) return {status: 'unavailable', reason: 'credentials_missing'};
  const baseUrl = concrete(env, 'ANTHROPIC_BASE_URL') ?? ANTHROPIC_DEFAULT_BASE_URL;
  return {status: 'resolved', route: withLimits({api: 'anthropic-messages', provider: options.provider, id, baseUrl},
    options.limits), credentials: {...(apiKey ? {apiKey} : {}), ...(authToken ? {authToken} : {})}};
}

function openAiRoute(env: EnvLike, runtime: RecordedProductionRuntimeKind, options: PiLegacyRouteOptions): PiLegacyRouteResolution {
  const id = concrete(env, 'OPENAI_MODEL')
    ?? (runtime === OPENCODE_RUNTIME_KIND ? concrete(env, 'SMARTPERFETTO_OPENCODE_MODEL') : undefined);
  if (runtime === OPENCODE_RUNTIME_KIND && (!id || !concrete(env, 'OPENAI_BASE_URL'))) {
    return {status: 'unavailable', reason: 'opencode_model_json_untranslatable'};
  }
  const baseUrl = concrete(env, 'OPENAI_BASE_URL') ?? OPENAI_DEFAULT_BASE_URL;
  const apiKey = concrete(env, 'OPENAI_API_KEY') ?? (isLoopbackEndpoint(baseUrl) ? LOCAL_ENDPOINT_PLACEHOLDER_KEY : undefined);
  if (!apiKey) return {status: 'unavailable', reason: 'credentials_missing'};
  // OpenCode always spoke Chat Completions; the OpenAI Agents SDK chose per OPENAI_AGENTS_PROTOCOL.
  const api = runtime !== OPENCODE_RUNTIME_KIND && env.OPENAI_AGENTS_PROTOCOL?.trim() !== 'chat_completions'
    ? 'openai-responses' : 'openai-completions';
  return {status: 'resolved', route: withLimits({api, provider: options.provider, id: id ?? OPENAI_DEFAULT_MODEL,
    baseUrl}, options.limits), credentials: {apiKey}};
}

/**
 * The Pi route that calls exactly what a retired runtime called with this env
 * (the env that runtime received from a provider record, or an env-only
 * setup): the same API surface, request origin, model id and credential form.
 * This is the migration mapping; the Pi provider runtime later decides whether
 * the installed pi-ai catalog has this model on this endpoint and API, or
 * synthesizes it.
 */
export function resolvePiRouteFromLegacyEnv(
  env: EnvLike,
  runtime: RecordedProductionRuntimeKind,
  options: PiLegacyRouteOptions,
): PiLegacyRouteResolution {
  if (runtime === CLAUDE_AGENT_RUNTIME_KIND) return claudeRoute(env, options);
  if (runtime === OPENAI_AGENT_RUNTIME_KIND || runtime === OPENCODE_RUNTIME_KIND) return openAiRoute(env, runtime, options);
  return {status: 'unavailable', reason: 'qoder_untranslatable'};
}

/**
 * A Vertex provider record names no credential of its own: the retired runtime
 * authenticated it with the server's explicit GOOGLE_APPLICATION_CREDENTIALS
 * (or Google ADC when unset), so the legacy env carries the same value.
 */
export function withVertexHostCredentials<T extends EnvLike>(type: ProviderType, env: T): T {
  return type === 'vertex' ? {...env, GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS} : env;
}

/**
 * A provider's own Pi model JSON as Pi receives it. Only the migration mapping
 * derives an AWS credential-chain route (a named profile or the default
 * chain); a user-written one is refused, so a profile cannot point Pi at an
 * arbitrary credential on the server. Invalid JSON still fails at runtime.
 */
export function providerModelJsonEnv(modelJson: string): Record<string, string> {
  let namesCredentialChain = false;
  try {
    namesCredentialChain = routeUsesAwsCredentialChain(parsePiAgentCoreModelConfig(modelJson).route);
  } catch {
    // The runtime reports the parse error with its own context.
  }
  return namesCredentialChain
    ? {[PI_AGENT_CORE_MODEL_UNAVAILABLE_ENV]: 'model_json_credential_chain'}
    : {[PI_AGENT_CORE_MODEL_JSON_ENV]: modelJson};
}

/** The Pi env a route resolution adds: the route as Pi's model JSON, and its credential under Pi-owned keys. */
export function piEnvForLegacyRoute(resolution: PiLegacyRouteResolution): Record<string, string> {
  if (resolution.status === 'unavailable') return {[PI_AGENT_CORE_MODEL_UNAVAILABLE_ENV]: resolution.reason};
  const {route, credentials} = resolution;
  return {
    [PI_AGENT_CORE_MODEL_JSON_ENV]: JSON.stringify({
      route,
      ...(credentials.apiKey ? {apiKeyEnv: PI_AGENT_CORE_API_KEY_ENV} : {}),
      ...(credentials.authToken ? {authTokenEnv: PI_AGENT_CORE_AUTH_TOKEN_ENV} : {}),
    }),
    ...(credentials.apiKey ? {[PI_AGENT_CORE_API_KEY_ENV]: credentials.apiKey} : {}),
    ...(credentials.authToken ? {[PI_AGENT_CORE_AUTH_TOKEN_ENV]: credentials.authToken} : {}),
    ...(route.aws ? {AWS_REGION: route.aws.region} : {}),
    ...credentials.awsEnv,
    ...(credentials.googleCredentialsFile ? {GOOGLE_APPLICATION_CREDENTIALS: credentials.googleCredentialsFile} : {}),
  };
}

/** Scheme, host, port and base path: what two endpoints must share to be the same request target. */
export function piRequestOrigin(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * The runtime an env-only setup (no provider profile) ran on before Pi became
 * the only runtime: an explicit retired SMARTPERFETTO_AGENT_RUNTIME, else the
 * former default (Claude credentials, Bedrock or Vertex), else OpenAI
 * credentials. Undefined when the env configures no retired runtime.
 */
function previousEnvOnlyRuntime(env: EnvLike): RecordedProductionRuntimeKind | undefined {
  const selected = env.SMARTPERFETTO_AGENT_RUNTIME?.trim();
  if (selected && isRecordedProductionRuntimeKind(selected) && selected !== PI_AGENT_CORE_RUNTIME_KIND) return selected;
  if (concrete(env, 'ANTHROPIC_API_KEY') || concrete(env, 'ANTHROPIC_AUTH_TOKEN')
    || isEnabledEnvFlag(env.CLAUDE_CODE_USE_BEDROCK)
    || (isEnabledEnvFlag(env.CLAUDE_CODE_USE_VERTEX) && concrete(env, 'ANTHROPIC_VERTEX_PROJECT_ID'))) {
    return CLAUDE_AGENT_RUNTIME_KIND;
  }
  if (concrete(env, 'OPENAI_API_KEY') || concrete(env, 'OPENAI_BASE_URL')) return OPENAI_AGENT_RUNTIME_KIND;
  return undefined;
}

/**
 * An env-only setup as Pi runs it: an explicit Pi model JSON is kept;
 * otherwise the Claude, OpenAI, Bedrock or Vertex env the retired runtime read
 * becomes a Pi route through the same mapping a provider profile uses.
 * Derived on each read, never written anywhere.
 */
export function withEnvOnlyPiModel<T extends EnvLike>(env: T): T {
  if (env[PI_AGENT_CORE_MODEL_JSON_ENV]?.trim()) return env;
  const previous = previousEnvOnlyRuntime(env);
  if (!previous) return env;
  return {...env, ...piEnvForLegacyRoute(resolvePiRouteFromLegacyEnv(env, previous,
    {provider: 'smartperfetto-env', hostCredentialChain: true}))};
}

/**
 * The env a runtime of `kind` runs with: a provider's isolated env over the
 * base env, or for an env-only Pi setup the base env plus the Pi model its
 * retired runtime's env maps to. Every Pi consumer (runtime factory, one-shot
 * calls, triage, the pin snapshot) derives its env here.
 */
export function runtimeEnvFor(
  baseEnv: EnvLike,
  providerEnv: Record<string, string> | null | undefined,
  kind: string | undefined,
): Record<string, string | undefined> {
  const merged = mergeIsolatedProviderEnv(baseEnv, providerEnv);
  return !providerEnv && kind === PI_AGENT_CORE_RUNTIME_KIND ? withEnvOnlyPiModel(merged) : merged;
}
