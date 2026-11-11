// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {access} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {resolveModelExecutionProfile, type ReasoningEffort, type ReasoningSetting, type ResolveModelExecutionProfileInput} from '../../../services/providerManager/modelExecutionProfile';
import {resolveModelExecutionPolicy, type ModelExecutionPolicyReceipt} from '../../modelExecutionPolicy';
import os from 'node:os';
import path, {resolve as resolvePath} from 'node:path';
import type {
  Api,
  Credential,
  DeferredCancelOptions,
  DeferredFetchOptions,
  Model,
  Models,
  ModelThinkingLevel,
  AssistantMessage,
  ProviderAuth,
  ProviderEnv,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from '@earendil-works/pi-ai';
import {
  piProviderApiKeyEnvNames,
  piStreamEnvKeys,
  routeUsesAwsCredentialChain,
  type PiAgentCoreModelConfig,
  type PiModelRoute,
  type PiRouteApi,
} from './piAgentCoreConfig';
import {isRuntimeCandidateAdmitted} from '../../runtimeCandidateAdmission';
import type {RuntimeModelDispatchPurpose} from '../../runtimePerformance';

type EnvLike = Record<string, string | undefined>;

type PiAiModule = typeof import('@earendil-works/pi-ai');
interface PiAiProviderCatalogModule {
  builtinProviders(): Array<{
    id: string;
    name: string;
    baseUrl?: string;
    headers?: Record<string, string | null>;
    auth: Parameters<PiAiModule['createProvider']>[0]['auth'];
  }>;
  /** One generated catalog model (no network refresh); undefined when absent. */
  getBuiltinModel(provider: string, modelId: string): Record<string, unknown> | undefined;
  /** Every generated catalog model of one provider. */
  getBuiltinModels?(provider: string): Array<Record<string, unknown>> | undefined;
}

const importEsmModule = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

const PI_API_MODULES = {
  'anthropic-messages': ['anthropic-messages.lazy', 'anthropicMessagesApi'],
  'azure-openai-responses': ['azure-openai-responses.lazy', 'azureOpenAIResponsesApi'],
  'bedrock-converse-stream': ['bedrock-converse-stream.lazy', 'bedrockConverseStreamApi'],
  'google-generative-ai': ['google-generative-ai.lazy', 'googleGenerativeAIApi'],
  'google-vertex': ['google-vertex.lazy', 'googleVertexApi'],
  'mistral-conversations': ['mistral-conversations.lazy', 'mistralConversationsApi'],
  'openai-codex-responses': ['openai-codex-responses.lazy', 'openAICodexResponsesApi'],
  'openai-completions': ['openai-completions.lazy', 'openAICompletionsApi'],
  'openai-responses': ['openai-responses.lazy', 'openAIResponsesApi'],
  'pi-messages': ['pi-messages.lazy', 'piMessagesApi'],
  // SmartPerfetto's Anthropic Messages over Vertex AI: the anthropic-messages
  // streams with an injected AnthropicVertex client (see vertexProviderStreams).
  'anthropic-vertex': ['anthropic-messages.lazy', 'anthropicMessagesApi'],
} as const;

type SupportedPiApi = keyof typeof PI_API_MODULES;
const ANTHROPIC_VERTEX_API = 'anthropic-vertex' satisfies PiRouteApi & SupportedPiApi;
const ANTHROPIC_API_HOST = 'api.anthropic.com';
const CLAUDE_LINEAGE_APIS: readonly string[] = ['anthropic-messages', 'bedrock-converse-stream'];
const SCENE_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['low', 'medium', 'high'];
/** Below this output cap a gateway model's thinking can use the whole allowance. */
const PI_MIN_THINKING_OUTPUT_TOKENS = 4_096;
/**
 * Provider retries for an unestablished request (408/409/429/5xx, connection
 * errors), as the retired Claude engine's SDK retried. pi-ai's own default is
 * none, and pi-agent-core does not forward a count. A caller that sets one,
 * such as the single-shot intent transport, keeps it.
 */
export const PI_PROVIDER_MAX_RETRIES = 2;

export type PiAgentCoreProviderModels = Models;

export interface PiStreamPurposePolicy {
  outputOnly?: true;
  sdkIdentity?: ResolveModelExecutionProfileInput['sdk'];
  onExecutionPolicy?: (receipt: ModelExecutionPolicyReceipt) => void;
}
/**
 * Wraps `Models.streamSimple`, which accepts a plain Context and normalizes it itself.
 * Pi agent transcripts (already normalized) and tool-free one-shot calls both fit.
 */
export type PiStreamFunction = Models['streamSimple'];
export class PiModelExecutionConfigurationError extends Error {
  constructor() {super('pi_model_execution_invalid_configuration');}
}

export interface PiAgentCoreProviderRuntime {
  model: Model<Api>;
  models: PiAgentCoreProviderModels;
  streamFn: PiStreamFunction;
  streamFnForPurpose?: (purpose: RuntimeModelDispatchPurpose, policy?: PiStreamPurposePolicy) => PiStreamFunction;
  /** The authored reasoning level, including a catalog reference's resolved default; undefined: provider default. */
  thinkingLevel: ModelThinkingLevel | undefined;
  /** Each run takes its level from the budget and scene, as the retired Claude engine did on this route. */
  runThinkingFollowsScene?: boolean;
  /**
   * pi-ai's own reading of a failed assistant turn: a context overflow, a transient
   * provider failure worth re-sending (quota and billing limits are not), or neither.
   */
  classifyFailedTurn?: (message: AssistantMessage) => PiFailedTurnClass;
}

export type PiFailedTurnClass = 'context_overflow' | 'transient' | 'other';

export type PiAgentCoreProviderRuntimeLoader = (
  config: PiAgentCoreModelConfig,
  env: EnvLike,
) => Promise<PiAgentCoreProviderRuntime>;

function requiredConfigString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Pi model field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Pi model field ${field} must be a positive finite number`);
  }
  return value;
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Pi model field ${field} must be a non-negative finite number`);
  }
  return value;
}

function requiredModelInput(value: unknown): Array<'text' | 'image'> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(entry => entry !== 'text' && entry !== 'image')
  ) {
    throw new Error('Pi model field input must contain text and/or image');
  }
  return [...new Set(value)];
}

function capturedAuthContext(env: EnvLike) {
  const captured = {...env};
  const configuredCredentialsPath = captured.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const allowedCredentialsPath = configuredCredentialsPath && !configuredCredentialsPath.startsWith('~')
    ? resolvePath(configuredCredentialsPath)
    : undefined;
  return {
    env: async (name: string) => captured[name]?.trim() || undefined,
    fileExists: async (candidatePath: string) => {
      if (
        !allowedCredentialsPath ||
        !candidatePath ||
        candidatePath.startsWith('~') ||
        resolvePath(candidatePath) !== allowedCredentialsPath
      ) {
        return false;
      }
      try {
        await access(allowedCredentialsPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const UNSAFE_BEDROCK_NATIVE_CHAIN_KEYS = [
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
] as const;

function capturePiStreamEnv(api: SupportedPiApi, env: EnvLike): ProviderEnv | undefined {
  const captured: ProviderEnv = {};
  const keys = piStreamEnvKeys(api);
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) captured[key] = value;
  }
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/**
 * A Bedrock route with a named AWS profile resolves explicit keys from that
 * profile and its configuration's own shared files (bedrockChainAuth); an
 * ambient AWS_PROFILE or shared-file location then selects nothing, so it is
 * not a fallback.
 */
const BEDROCK_PROFILE_ROUTE_AMBIENT_EXEMPT = new Set(['AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']);

/** Every process-env input an in-process AWS credential chain can read. */
const BEDROCK_CHAIN_INPUT_KEYS = [
  ...UNSAFE_BEDROCK_NATIVE_CHAIN_KEYS,
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;

/**
 * The AWS SDK chains read the process env themselves, so before one loads,
 * every input it can read must hold exactly the selected configuration's own
 * value (both absent included); otherwise it would resolve another
 * configuration's or the host's identity. A profile route passes its profile
 * and shared-file paths explicitly, so those keys are exempt there.
 */
function assertBedrockChainInputsScoped(scopedEnv: EnvLike, exempt?: ReadonlySet<string>): void {
  for (const key of BEDROCK_CHAIN_INPUT_KEYS) {
    if (exempt?.has(key)) continue;
    if ((process.env[key]?.trim() || undefined) !== (scopedEnv[key]?.trim() || undefined)) {
      throw new Error(`Pi bedrock-converse-stream cannot resolve AWS credentials: ${key} in the process ` +
        'environment is not the selected configuration\'s own');
    }
  }
}

function assertNoAmbientPiStreamEnvFallback(
  api: SupportedPiApi,
  scopedEnv: ProviderEnv | undefined,
  ambientExempt?: ReadonlySet<string>,
): void {
  for (const key of piStreamEnvKeys(api)) {
    if (ambientExempt?.has(key)) continue;
    const ambientValue = process.env[key]?.trim();
    const scopedValue = scopedEnv?.[key]?.trim();
    if (ambientValue && !scopedValue) {
      throw new Error(
        `Pi ${api} cannot use ambient ${key} outside the selected runtime environment`,
      );
    }
  }
}

function assertSafeBedrockCredentialSnapshot(
  api: SupportedPiApi,
  scopedEnv: EnvLike,
): void {
  if (api !== 'bedrock-converse-stream') return;
  for (const key of UNSAFE_BEDROCK_NATIVE_CHAIN_KEYS) {
    if (scopedEnv[key]?.trim()) {
      throw new Error(
        `Pi bedrock-converse-stream does not support ${key}; use a scoped bearer token ` +
        'or explicit AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY credentials',
      );
    }
  }
}

function withScopedPiStreamOptions<T extends {env?: ProviderEnv}>(
  api: SupportedPiApi,
  streamEnv: ProviderEnv | undefined,
  options: T | undefined,
  ambientExempt?: ReadonlySet<string>,
): T {
  const resolvedEnv = {...streamEnv, ...options?.env};
  assertNoAmbientPiStreamEnvFallback(
    api,
    Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    ambientExempt,
  );
  return {
    ...(options ?? {}),
    ...(Object.keys(resolvedEnv).length > 0 ? {env: resolvedEnv} : {}),
  } as T;
}

function withCapturedProviderStreams(
  providerStreams: ProviderStreams,
  streamEnv: ProviderEnv | undefined,
  api: SupportedPiApi,
  ambientExempt?: ReadonlySet<string>,
): ProviderStreams {
  return {
    stream: (model, context, options) => providerStreams.stream(
      model,
      context,
      withScopedPiStreamOptions<StreamOptions>(api, streamEnv, options, ambientExempt),
    ),
    streamSimple: (model, context, options) => providerStreams.streamSimple(
      model,
      context,
      withScopedPiStreamOptions<SimpleStreamOptions>(api, streamEnv, options, ambientExempt),
    ),
    ...(providerStreams.fetchDeferred ? {
      fetchDeferred: (model, handle, options) => providerStreams.fetchDeferred!(
        model,
        handle,
        withScopedPiStreamOptions<DeferredFetchOptions>(api, streamEnv, options, ambientExempt),
      ),
    } : {}),
    ...(providerStreams.cancelDeferred ? {
      cancelDeferred: (model, handle, options) => providerStreams.cancelDeferred!(
        model,
        handle,
        withScopedPiStreamOptions<DeferredCancelOptions>(api, streamEnv, options, ambientExempt),
      ),
    } : {}),
  };
}

function withCapturedPiStreamEnv(
  auth: ProviderAuth,
  streamEnv: ProviderEnv | undefined,
  api: SupportedPiApi,
  ambientExempt?: ReadonlySet<string>,
  consumedKeys?: readonly string[],
): ProviderAuth {
  if (!auth.apiKey) return auth;
  const apiKey = auth.apiKey;
  return {
    ...auth,
    apiKey: {
      ...apiKey,
      resolve: async input => {
        const result = await apiKey.resolve(input);
        if (!result) return undefined;
        const resolvedEnv = {...streamEnv, ...result.env};
        assertNoAmbientPiStreamEnvFallback(api, resolvedEnv, ambientExempt);
        // Keys the in-process credential chain already consumed never reach the native client.
        for (const key of consumedKeys ?? []) delete resolvedEnv[key];
        return {
          ...result,
          ...(Object.keys(resolvedEnv).length > 0 ? {env: resolvedEnv} : {}),
        };
      },
    },
  };
}

function asPiModel(model: Record<string, unknown>): Model<Api> {
  const id = requiredConfigString(model.id, 'id');
  const provider = requiredConfigString(model.provider, 'provider');
  const api = requiredConfigString(model.api, 'api');
  if (!Object.prototype.hasOwnProperty.call(PI_API_MODULES, api)) {
    throw new Error(`Unsupported Pi model API: ${api}`);
  }
  const baseUrl = requiredConfigString(model.baseUrl, 'baseUrl');
  if (typeof model.reasoning !== 'boolean') {
    throw new Error('Pi model field reasoning must be a boolean');
  }
  if (!model.cost || typeof model.cost !== 'object' || Array.isArray(model.cost)) {
    throw new Error('Pi model field cost must be an object');
  }
  const cost = model.cost as Record<string, unknown>;
  return {
    ...model,
    id,
    name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id,
    provider,
    api,
    baseUrl,
    reasoning: model.reasoning,
    input: requiredModelInput(model.input),
    cost: {
      ...cost,
      input: requiredNonNegativeNumber(cost.input, 'cost.input'),
      output: requiredNonNegativeNumber(cost.output, 'cost.output'),
      cacheRead: requiredNonNegativeNumber(cost.cacheRead, 'cost.cacheRead'),
      cacheWrite: requiredNonNegativeNumber(cost.cacheWrite, 'cost.cacheWrite'),
    },
    contextWindow: requiredPositiveNumber(model.contextWindow, 'contextWindow'),
    maxTokens: requiredPositiveNumber(model.maxTokens, 'maxTokens'),
  } as Model<Api>;
}

function validateCredential(
  value: Credential | undefined,
  api: SupportedPiApi,
): Credential | undefined {
  if (!value) return undefined;
  if (value.type === 'api_key') {
    if (value.key !== undefined && (typeof value.key !== 'string' || !value.key.trim())) {
      throw new Error('Pi API-key credential key must be a non-empty string when provided');
    }
    if (
      value.env !== undefined &&
      (!value.env || typeof value.env !== 'object' || Array.isArray(value.env))
    ) {
      throw new Error('Pi API-key credential env must be an object');
    }
    const allowedEnvKeys = new Set([
      ...piStreamEnvKeys(api),
    ]);
    for (const [key, envValue] of Object.entries(value.env ?? {})) {
      if (!allowedEnvKeys.has(key) || typeof envValue !== 'string' || !envValue.trim()) {
        throw new Error(`Pi API-key credential env entry is not allowed: ${key}`);
      }
    }
    const credential = structuredClone(value);
    assertSafeBedrockCredentialSnapshot(api, credential.env ?? {});
    return credential;
  }
  if (value.type === 'oauth') {
    if (
      typeof value.refresh !== 'string' || !value.refresh ||
      typeof value.access !== 'string' || !value.access ||
      typeof value.expires !== 'number' || !Number.isFinite(value.expires)
    ) {
      throw new Error('Pi OAuth credential requires refresh, access, and a finite expires timestamp');
    }
    return structuredClone(value);
  }
  throw new Error('Pi credential type must be api_key or oauth');
}

async function loadProviderStreams(
  api: SupportedPiApi,
  moduleLoader: (specifier: string) => Promise<unknown>,
): Promise<ProviderStreams> {
  const [moduleName, factoryName] = PI_API_MODULES[api];
  const module = await moduleLoader(
    `@earendil-works/pi-ai/api/${moduleName}`,
  ) as Record<string, unknown>;
  const factory = module[factoryName];
  if (typeof factory !== 'function') {
    throw new Error(`Pi API module ${moduleName} does not export ${factoryName}`);
  }
  return (factory as () => ProviderStreams)();
}

export async function loadPiProviderRuntimeModules(
  api: SupportedPiApi,
  env: EnvLike,
  moduleLoader: (specifier: string) => Promise<unknown> = importEsmModule,
): Promise<{
  piAi: PiAiModule;
  catalog: PiAiProviderCatalogModule;
  providerStreams: ProviderStreams;
}> {
  if (isRuntimeCandidateAdmitted('task7', env)) {
    const [piAi, catalog, providerStreams] = await Promise.all([
      moduleLoader('@earendil-works/pi-ai') as Promise<PiAiModule>,
      moduleLoader('@earendil-works/pi-ai/providers/all') as Promise<PiAiProviderCatalogModule>,
      loadProviderStreams(api, moduleLoader),
    ]);
    return {piAi, catalog, providerStreams};
  }
  const piAi = await moduleLoader('@earendil-works/pi-ai') as PiAiModule;
  const catalog = await moduleLoader('@earendil-works/pi-ai/providers/all') as PiAiProviderCatalogModule;
  const providerStreams = await loadProviderStreams(api, moduleLoader);
  return {piAi, catalog, providerStreams};
}

const LOWEST_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low'];

/** The installed builtin catalog entry a reference names, with the configured endpoint. */
export async function resolvePiCatalogModel(
  reference: NonNullable<PiAgentCoreModelConfig['catalog']>,
  moduleLoader: (specifier: string) => Promise<unknown> = importEsmModule,
): Promise<Record<string, unknown>> {
  const catalog = await moduleLoader('@earendil-works/pi-ai/providers/all') as PiAiProviderCatalogModule;
  for (const providerId of reference.providers) {
    const found = catalog.getBuiltinModel(providerId, reference.id);
    if (found) return {...found, ...(reference.baseUrl ? {baseUrl: reference.baseUrl} : {})};
  }
  throw new Error(`Pi catalog has no model ${reference.id} under ${reference.providers.join(', ')}`);
}

/**
 * Limits for a route model the installed catalog does not have: the template's
 * declared limits, else these conservative defaults. The output defaults match
 * what the retired engines requested (the Claude Agent SDK's 32k output cap on
 * Anthropic surfaces); cost is unknown and recorded as zero, never used to gate.
 */
export const PI_SYNTHESIZED_MODEL_DEFAULTS = {
  /** Claude surfaces take the window the retired engine assumed; a smaller one starves long runs' output. */
  contextWindow: {
    'anthropic-messages': 200_000,
    'anthropic-vertex': 200_000,
    'bedrock-converse-stream': 200_000,
    'openai-completions': 128_000,
    'openai-responses': 128_000,
  } satisfies Record<PiRouteApi, number>,
  maxTokens: {
    'anthropic-messages': 32_000,
    'anthropic-vertex': 32_000,
    'bedrock-converse-stream': 32_000,
    'openai-completions': 16_384,
    'openai-responses': 16_384,
  } satisfies Record<PiRouteApi, number>,
} as const;

function endpointHost(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== 'string') return undefined;
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A route's model: the installed catalog entry when a builtin provider serves
 * this id with this API on this endpoint host (or is the only provider serving
 * this API, as with Bedrock), with the route's own base URL; otherwise a model
 * synthesized on the route's API and endpoint. A synthesized model takes
 * limits from a same-host catalog entry for this id (any API), else the
 * template, else the defaults above, and does not send the newer
 * `eager_input_streaming` tool field to an Anthropic-compatible gateway. It
 * keeps reasoning off, except on a gateway serving a non-Claude model, where
 * sending nothing leaves the endpoint on its own, much heavier default: there
 * it uses the adaptive thinking the retired Claude engine sent.
 */
export async function resolvePiRouteModel(
  route: PiModelRoute,
  moduleLoader: (specifier: string) => Promise<unknown> = importEsmModule,
): Promise<Record<string, unknown>> {
  const catalog = await moduleLoader('@earendil-works/pi-ai/providers/all') as PiAiProviderCatalogModule;
  const host = endpointHost(route.baseUrl);
  const providers = catalog.builtinProviders().map(provider => ({
    id: provider.id,
    models: catalog.getBuiltinModels?.(provider.id) ?? [],
  }));
  const sameHost = (model: Record<string, unknown>) => host !== undefined && endpointHost(model.baseUrl) === host;
  if (route.api !== ANTHROPIC_VERTEX_API) {
    const serving = providers.filter(provider => provider.models.some(model => model.api === route.api));
    const candidates = serving.length === 1
      ? serving
      : serving.filter(provider => provider.models.some(model => model.api === route.api && sameHost(model)));
    for (const provider of candidates) {
      const found = catalog.getBuiltinModel(provider.id, route.id);
      if (found && found.api === route.api) return {...found, baseUrl: route.baseUrl};
    }
  }
  const peer = providers.flatMap(provider => provider.models).find(model => model.id === route.id && sameHost(model));
  const anthropicSurface = route.api === 'anthropic-messages' || route.api === ANTHROPIC_VERTEX_API;
  const adaptiveGateway = servesAdaptiveGatewayModel(route.api, host, route.id);
  return {
    id: route.id,
    name: route.id,
    api: route.api,
    provider: route.provider,
    baseUrl: route.baseUrl,
    reasoning: adaptiveGateway,
    input: Array.isArray(peer?.input) ? peer.input : ['text'],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: typeof peer?.contextWindow === 'number' ? peer.contextWindow
      : route.limits?.contextWindow ?? PI_SYNTHESIZED_MODEL_DEFAULTS.contextWindow[route.api],
    maxTokens: typeof peer?.maxTokens === 'number' ? peer.maxTokens
      : route.limits?.maxTokens ?? PI_SYNTHESIZED_MODEL_DEFAULTS.maxTokens[route.api],
    ...(anthropicSurface && host !== ANTHROPIC_API_HOST ? {compat: {supportsEagerToolInputStreaming: false,
      ...(adaptiveGateway ? {forceAdaptiveThinking: true} : {})}} : {}),
  };
}

/** The configured model record: the full model, or a catalog reference or route resolved through the installed SDK. */
export function resolvePiModelRecord(
  config: PiAgentCoreModelConfig,
  moduleLoader: (specifier: string) => Promise<unknown> = importEsmModule,
): Promise<Record<string, unknown>> {
  if (config.catalog) return resolvePiCatalogModel(config.catalog, moduleLoader);
  if (config.route) return resolvePiRouteModel(config.route, moduleLoader);
  return Promise.resolve(config.model);
}

/**
 * An Anthropic-compatible token sent as `Authorization: Bearer` (what the
 * retired runtime sent for ANTHROPIC_AUTH_TOKEN), resolved from the scoped env
 * per request and never written into the model JSON. A stored API key, when
 * one is configured too, still travels as `x-api-key`.
 */
function bearerTokenAuth(tokenEnv: string, capturedEnv: EnvLike): ProviderAuth {
  return {
    apiKey: {
      name: 'Anthropic-compatible auth token',
      resolve: async ({credential, signal}) => {
        signal.throwIfAborted();
        const token = capturedEnv[tokenEnv]?.trim();
        if (!token) return undefined;
        return {
          auth: {
            ...(credential?.key ? {apiKey: credential.key} : {}),
            headers: {authorization: `Bearer ${token}`},
          },
          source: tokenEnv,
        };
      },
    },
  };
}

/** Vertex authenticates through the injected client's Google credentials, not a request key. */
function vertexGoogleAuth(capturedEnv: EnvLike): ProviderAuth {
  const source = capturedEnv.GOOGLE_APPLICATION_CREDENTIALS?.trim()
    ? 'GOOGLE_APPLICATION_CREDENTIALS' : 'Google application default credentials';
  return {
    apiKey: {
      name: 'Google Vertex credentials',
      resolve: async ({signal}) => {
        signal.throwIfAborted();
        return {auth: {}, source};
      },
    },
  };
}

interface AwsProfileCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

const AWS_CREDENTIAL_REFRESH_MARGIN_MS = 60_000;

/**
 * Bedrock credentials resolved in-process on each request into explicit
 * scoped keys: a named profile strictly from its shared config/credentials
 * files, or the AWS SDK default chain when the configuration enabled Bedrock
 * without naming a credential. Temporary credentials are reused until shortly
 * before they expire.
 */
function bedrockChainAuth(aws: NonNullable<PiModelRoute['aws']>, scopedEnv: EnvLike): ProviderAuth {
  const {region, profile} = aws;
  let current: AwsProfileCredentials | undefined;
  let pending: Promise<AwsProfileCredentials> | undefined;
  const load = async (): Promise<AwsProfileCredentials> => {
    assertBedrockChainInputsScoped(scopedEnv, profile ? BEDROCK_PROFILE_ROUTE_AMBIENT_EXEMPT : undefined);
    if (profile) {
      const {fromIni} = await import('@aws-sdk/credential-provider-ini');
      // The selected configuration's own shared files, never the process env's.
      return fromIni({
        profile,
        filepath: scopedEnv.AWS_SHARED_CREDENTIALS_FILE?.trim() || path.join(os.homedir(), '.aws', 'credentials'),
        configFilepath: scopedEnv.AWS_CONFIG_FILE?.trim() || path.join(os.homedir(), '.aws', 'config'),
      })();
    }
    const {defaultProvider} = await import('@aws-sdk/credential-provider-node');
    return defaultProvider()();
  };
  const fresh = (value: AwsProfileCredentials | undefined) => value
    && (!value.expiration || value.expiration.getTime() - Date.now() > AWS_CREDENTIAL_REFRESH_MARGIN_MS);
  return {
    apiKey: {
      name: profile ? `AWS profile ${profile}` : 'AWS default credential chain',
      resolve: async ({signal}) => {
        signal.throwIfAborted();
        if (!fresh(current)) {
          pending ??= load().finally(() => { pending = undefined; });
          current = await pending;
        }
        const credentials = current!;
        return {
          auth: {},
          env: {
            AWS_ACCESS_KEY_ID: credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            ...(credentials.sessionToken ? {AWS_SESSION_TOKEN: credentials.sessionToken} : {}),
            AWS_REGION: region,
          },
          source: profile ? 'AWS profile' : 'AWS default credential chain',
        };
      },
    },
  };
}

/**
 * The anthropic-messages streams over Vertex AI: each request gets the
 * injected AnthropicVertex client (AnthropicOptions.client), authenticated by
 * the explicit credentials file, or Google ADC when none is configured. The simple-stream path maps options the
 * way pi-ai's anthropic streamSimple does for a model without reasoning.
 */
async function vertexProviderStreams(
  anthropic: ProviderStreams,
  route: PiModelRoute,
  credentialsFile: string | undefined,
  moduleLoader: (specifier: string) => Promise<unknown>,
): Promise<ProviderStreams> {
  if (!route.vertex) throw new Error('Pi anthropic-vertex route requires vertex.projectId and vertex.region');
  const [{AnthropicVertex}, {GoogleAuth}, simpleOptions] = await Promise.all([
    import('@anthropic-ai/vertex-sdk'),
    import('google-auth-library'),
    moduleLoader('@earendil-works/pi-ai/api/simple-options') as Promise<{
      buildBaseOptions(model: Model<Api>, context: unknown, options?: SimpleStreamOptions, apiKey?: string): StreamOptions;
    }>,
  ]);
  const client = new AnthropicVertex({
    projectId: route.vertex.projectId,
    region: route.vertex.region,
    baseURL: route.baseUrl,
    googleAuth: new GoogleAuth({
      ...(credentialsFile ? {keyFile: credentialsFile} : {}),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }),
  });
  const asAnthropic = (model: Model<Api>) => ({...model, api: 'anthropic-messages'}) as Model<Api>;
  return {
    stream: (model, context, options) => anthropic.stream(asAnthropic(model), context,
      {...options, client} as StreamOptions),
    streamSimple: (model, context, options) => anthropic.stream(asAnthropic(model), context, {
      ...simpleOptions.buildBaseOptions(asAnthropic(model), context, options, options?.apiKey),
      toolChoice: (options as {toolChoice?: unknown} | undefined)?.toolChoice,
      thinkingEnabled: false,
      client,
    } as StreamOptions),
  };
}

export async function createPiAgentCoreProviderRuntime(
  config: PiAgentCoreModelConfig,
  env: EnvLike,
  moduleLoader: (specifier: string) => Promise<unknown> = importEsmModule,
): Promise<PiAgentCoreProviderRuntime> {
  const model = asPiModel(await resolvePiModelRecord(config, moduleLoader));
  const api = model.api as SupportedPiApi;
  const providerId = model.provider;
  if (config.credential && (config.apiKey || config.apiKeyEnv)) {
    throw new Error('Pi credential cannot be combined with apiKey or apiKeyEnv');
  }

  const capturedEnv = {...env};
  const credential = validateCredential(config.credential, api);
  const credentialEnv = credential?.type === 'api_key' ? credential.env : undefined;
  const authEnv = {...capturedEnv, ...credentialEnv};
  const bedrockChain = routeUsesAwsCredentialChain(config.route) ? config.route!.aws : undefined;
  // A chain route consumes the native chain keys in-process; only other routes must not carry them.
  if (!bedrockChain) assertSafeBedrockCredentialSnapshot(api, authEnv);
  const ambientExempt = bedrockChain?.profile ? BEDROCK_PROFILE_ROUTE_AMBIENT_EXEMPT : undefined;

  const {piAi, catalog, providerStreams: loadedStreams} = await loadPiProviderRuntimeModules(
    api,
    env,
    moduleLoader,
  );
  const providerStreams = api === ANTHROPIC_VERTEX_API
    ? await vertexProviderStreams(loadedStreams, config.route!, authEnv.GOOGLE_APPLICATION_CREDENTIALS?.trim(), moduleLoader)
    : loadedStreams;
  const supportedLevels = piAi.getSupportedThinkingLevels(model);
  // Only a model synthesized for the route: a catalog entry keeps its own reasoning defaults.
  const adaptiveGateway = config.route !== undefined && config.thinkingLevel === undefined
    && model.provider === config.route.provider
    && (model as Model<'anthropic-messages'>).compat?.forceAdaptiveThinking === true
    && servesAdaptiveGatewayModel(model.api, endpointHost(model.baseUrl), model.id);
  const authoredLevel = config.thinkingLevel ?? (config.catalog?.defaultThinkingLevel === 'lowest_supported'
    ? LOWEST_THINKING_LEVELS.find(level => supportedLevels.includes(level)) : undefined);
  const assertSupportedLevel = (level: ModelThinkingLevel | undefined) => {
    if (level !== undefined && !supportedLevels.includes(level)) {
      throw new PiModelExecutionConfigurationError();
    }
  };
  assertSupportedLevel(authoredLevel);
  const credentials = new piAi.InMemoryCredentialStore();
  const builtinProvider = catalog.builtinProviders().find(candidate => candidate.id === providerId);
  const providerAuth = builtinProvider?.auth ?? {
    apiKey: piAi.envApiKeyAuth(
      `${providerId} API key`,
      piProviderApiKeyEnvNames(providerId, config.apiKeyEnv),
    ),
  };
  if (config.authTokenEnv && api !== 'anthropic-messages') {
    throw new Error('Pi authTokenEnv applies only to an anthropic-messages model');
  }
  if (bedrockChain) assertBedrockChainInputsScoped(authEnv, ambientExempt);
  const baseAuth = bedrockChain ? bedrockChainAuth(bedrockChain, authEnv)
    : api === ANTHROPIC_VERTEX_API ? vertexGoogleAuth(authEnv)
      : config.authTokenEnv ? bearerTokenAuth(config.authTokenEnv, capturedEnv)
        : providerAuth;
  const streamEnv = capturePiStreamEnv(api, authEnv);
  const auth = withCapturedPiStreamEnv(
    baseAuth,
    streamEnv,
    api,
    ambientExempt,
    bedrockChain ? UNSAFE_BEDROCK_NATIVE_CHAIN_KEYS : undefined,
  );
  const explicitApiKey = config.apiKey?.trim()
    || (config.apiKeyEnv ? capturedEnv[config.apiKeyEnv]?.trim() : undefined);
  const initialCredential: Credential | undefined = credential ?? (
    explicitApiKey ? {type: 'api_key', key: explicitApiKey} : undefined
  );

  if (initialCredential?.type === 'oauth' && !auth.oauth) {
    throw new Error(`Pi provider ${providerId} does not support OAuth credentials`);
  }
  if (initialCredential?.type === 'api_key' && !auth.apiKey) {
    throw new Error(`Pi provider ${providerId} does not support API-key credentials`);
  }
  if (initialCredential) {
    await credentials.modify(providerId, async () => initialCredential);
  }

  const models = piAi.createModels({
    credentials,
    authContext: capturedAuthContext(authEnv),
  });
  models.setProvider(piAi.createProvider({
    id: providerId,
    name: builtinProvider?.name ?? providerId,
    baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : builtinProvider?.baseUrl,
    headers: builtinProvider?.headers,
    auth,
    models: [model],
    api: withCapturedProviderStreams(providerStreams, streamEnv, api, ambientExempt),
  }));

  const nativeStream = models.streamSimple.bind(models);
  const officialGlm = isOfficialGlmModel(model);
  const identity = (value: Model<Api>) => ({id: value.id, api: value.api, provider: value.provider, baseUrl: value.baseUrl,
    reasoning: value.reasoning, maxTokens: value.maxTokens, contextWindow: value.contextWindow,
    thinkingLevelMap: value.thinkingLevelMap,
    compat: value.api === 'openai-completions' ? (value as Model<'openai-completions'>).compat : undefined});
  const capturedIdentity = structuredClone(identity(model));
  const asSetting = (level: ModelThinkingLevel | undefined): ReasoningSetting | undefined => level === undefined
    ? undefined : level === 'off' ? {mode: 'disabled'} : {mode: 'enabled', effort: level};
  const streamFnForPurpose = (purpose: RuntimeModelDispatchPurpose, policy?: PiStreamPurposePolicy): PiStreamFunction => {
    // Per-invocation selection: cached provider runtimes must never retain a run's observer or output cap.
    return (sentModel, context, options) => {
      let requestedLevel: ModelThinkingLevel | undefined;
      let streamMaxTokens = options?.maxTokens;
      const stageCandidate = purpose === 'classification' || purpose === 'review' ||
        purpose === 'continuation' && policy?.outputOnly === true;
      let selected: ReturnType<typeof resolveModelExecutionPolicy>;
      try {
        if (!isDeepStrictEqual(identity(sentModel), capturedIdentity)) throw new PiModelExecutionConfigurationError();
        const levels = piAi.getSupportedThinkingLevels(sentModel);
        const compat = sentModel.api === 'openai-completions' ? (sentModel as Model<'openai-completions'>).compat : undefined;
        const knownThinkingFormat = compat?.thinkingFormat === 'zai' || compat?.thinkingFormat === 'deepseek';
        const protocol = sentModel.api === 'openai-completions' ? 'chat_completions'
          : sentModel.api === 'openai-responses' || sentModel.api === 'azure-openai-responses' ? 'responses'
          : sentModel.api === 'anthropic-messages' || sentModel.api === ANTHROPIC_VERTEX_API ? 'anthropic_messages' : 'unknown';
        const sdkLevel = (options as SimpleStreamOptions | undefined)?.reasoning ?? authoredLevel ?? (adaptiveGateway ? 'low' : undefined);
        const profileInput: ResolveModelExecutionProfileInput = {runtimeKind: 'pi-agent-core', protocol, modelId: sentModel.id,
          baseUrl: sentModel.baseUrl, sdk: policy?.sdkIdentity ?? {packageName: '@earendil-works/pi-ai',
            version: 'unknown', adapterContractVersion: 'pi-native-purpose@1'},
          sdkCapabilities: {surface: protocol === 'unknown' ? 'none' : 'pi_stream',
            thinking: protocol === 'unknown' ? 'unknown' : !sentModel.reasoning ? 'none' : sentModel.api === 'openai-completions' && !knownThinkingFormat
              ? 'unknown' : levels.includes('off') ? 'optional' : 'required',
            ...(sentModel.api !== 'openai-completions' || compat?.supportsReasoningEffort === true
              ? {efforts: levels.filter((level): level is ReasoningEffort => level !== 'off')} : {}),
            reasoningRoundtrip: 'unknown', source: 'installed_sdk'},
          effective: {authoredReasoning: asSetting(authoredLevel), sdkEffectiveReasoning: asSetting(sdkLevel),
            maxOutputTokens: options?.maxTokens}};
        const profile = resolveModelExecutionProfile(profileInput);
        selected = resolveModelExecutionPolicy({profile, purpose, outputOnly: policy?.outputOnly,
          selection: stageCandidate ? 'minimum_legal_candidate' : 'preserve'});
        if (selected.status === 'unsupported') throw new PiModelExecutionConfigurationError();
        // A tightly capped call must not spend its cap thinking; both surveyed gateways accept `disabled`.
        // Anything with room to write, such as a closeout, keeps the run's level.
        const tightlyCapped = options?.maxTokens !== undefined && options.maxTokens < PI_MIN_THINKING_OUTPUT_TOKENS;
        requestedLevel = adaptiveGateway && stageCandidate ? (tightlyCapped ? 'off' : sdkLevel)
          : selected.controls.surface === 'pi_stream' ? selected.controls.reasoning
            : stageCandidate && authoredLevel !== undefined ? authoredLevel : sdkLevel;
        assertSupportedLevel(requestedLevel);
        // A cap sized for the text alone would let thinking truncate the answer it precedes; a tight cap is the caller's.
        if (stageCandidate && !tightlyCapped && requestedLevel && requestedLevel !== 'off') streamMaxTokens = sentModel.maxTokens;
        const nativeMapped = requestedLevel && sentModel.thinkingLevelMap?.[requestedLevel];
        const sdkEffective = requestedLevel === undefined ? undefined : requestedLevel === 'off' ? asSetting('off')
          : typeof nativeMapped === 'string'
            ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(nativeMapped)
              ? {mode: 'enabled' as const, effort: nativeMapped as ReasoningEffort} : undefined
            : asSetting(requestedLevel);
        // Bind the receipt to the SDK's final selected/mapped setting and the actual stream cap.
        selected = resolveModelExecutionPolicy({profile: resolveModelExecutionProfile({...profileInput,
          effective: {...profileInput.effective, sdkEffectiveReasoning: sdkEffective, maxOutputTokens: streamMaxTokens}}), purpose, outputOnly: policy?.outputOnly,
          selection: stageCandidate ? 'minimum_legal_candidate' : 'preserve'});
        if (selected.status === 'unsupported') throw new PiModelExecutionConfigurationError();
      } catch {throw new PiModelExecutionConfigurationError();}
      try {policy?.onExecutionPolicy?.(selected.receipt);} catch { /* Observers never change a stream. */ }
      const scopedOptions: SimpleStreamOptions = {...options};
      scopedOptions.maxRetries ??= PI_PROVIDER_MAX_RETRIES;
      if (streamMaxTokens !== undefined) scopedOptions.maxTokens = streamMaxTokens;
      if (requestedLevel && requestedLevel !== 'off') scopedOptions.reasoning = requestedLevel;
      else delete scopedOptions.reasoning;
      if (officialGlm && requestedLevel === undefined) {
        const onPayload = options?.onPayload;
        scopedOptions.onPayload = async (payload, payloadModel) => {
          // Remove only the SDK-generated default, before the caller's hook.
          let prepared = payload;
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const body = payload as Record<string, unknown>;
            const thinking = body.thinking as Record<string, unknown> | undefined;
            if (thinking?.type === 'disabled' && Object.keys(thinking).length === 1) {
              prepared = {...body};
              delete (prepared as Record<string, unknown>).thinking;
            }
          }
          const replacement = await onPayload?.(prepared, payloadModel);
          return replacement === undefined ? prepared : replacement;
        };
      }
      return nativeStream(sentModel, context, scopedOptions);
    };
  };
  // A route the retired Claude engine served keeps its reasoning depth, on a catalog model too.
  const runThinkingFollowsScene = config.route !== undefined && config.thinkingLevel === undefined && model.reasoning
    && CLAUDE_LINEAGE_APIS.includes(api) && SCENE_THINKING_LEVELS.every(level => supportedLevels.includes(level));
  const classifyFailedTurn = (message: AssistantMessage): PiFailedTurnClass =>
    piAi.isContextOverflow(message, model.contextWindow) ? 'context_overflow'
      : piAi.isRetryableAssistantError(message) ? 'transient' : 'other';
  return {model, models, streamFn: streamFnForPurpose('answer_turn'), streamFnForPurpose, thinkingLevel: authoredLevel,
    runThinkingFollowsScene, classifyFailedTurn};
}

/** A non-Claude model behind an Anthropic-compatible gateway; Claude ids keep their own per-model thinking rules. */
function servesAdaptiveGatewayModel(api: unknown, host: string | undefined, modelId: string): boolean {
  return api === 'anthropic-messages' && host !== undefined && host !== ANTHROPIC_API_HOST &&
    !/claude|opus|sonnet|haiku/i.test(modelId);
}

function isOfficialGlmModel(model: Model<Api>): boolean {
  if (model.api !== 'openai-completions' || !model.reasoning) return false;
  const compat = (model as Model<'openai-completions'>).compat;
  if (compat?.thinkingFormat !== undefined && compat.thinkingFormat !== 'zai') return false;
  try {
    const url = new URL(model.baseUrl);
    return !url.username && !url.password &&
      (url.origin === 'https://open.bigmodel.cn' || url.origin === 'https://api.z.ai');
  } catch {
    return false;
  }
}
