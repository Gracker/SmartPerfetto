// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {access} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {resolveModelExecutionProfile, type ReasoningEffort, type ReasoningSetting, type ResolveModelExecutionProfileInput} from '../../../services/providerManager/modelExecutionProfile';
import {resolveModelExecutionPolicy, type ModelExecutionPolicyReceipt} from '../../modelExecutionPolicy';
import {resolve as resolvePath} from 'node:path';
import type {
  Api,
  Credential,
  DeferredCancelOptions,
  DeferredFetchOptions,
  Model,
  Models,
  ModelThinkingLevel,
  ProviderAuth,
  ProviderEnv,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from '@earendil-works/pi-ai';
import {
  piProviderApiKeyEnvNames,
  piStreamEnvKeys,
  type PiAgentCoreModelConfig,
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
} as const;

type SupportedPiApi = keyof typeof PI_API_MODULES;

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
}

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

function assertNoAmbientPiStreamEnvFallback(
  api: SupportedPiApi,
  scopedEnv: ProviderEnv | undefined,
): void {
  for (const key of piStreamEnvKeys(api)) {
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
): T {
  const resolvedEnv = {...streamEnv, ...options?.env};
  assertNoAmbientPiStreamEnvFallback(
    api,
    Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
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
): ProviderStreams {
  return {
    stream: (model, context, options) => providerStreams.stream(
      model,
      context,
      withScopedPiStreamOptions<StreamOptions>(api, streamEnv, options),
    ),
    streamSimple: (model, context, options) => providerStreams.streamSimple(
      model,
      context,
      withScopedPiStreamOptions<SimpleStreamOptions>(api, streamEnv, options),
    ),
    ...(providerStreams.fetchDeferred ? {
      fetchDeferred: (model, handle, options) => providerStreams.fetchDeferred!(
        model,
        handle,
        withScopedPiStreamOptions<DeferredFetchOptions>(api, streamEnv, options),
      ),
    } : {}),
    ...(providerStreams.cancelDeferred ? {
      cancelDeferred: (model, handle, options) => providerStreams.cancelDeferred!(
        model,
        handle,
        withScopedPiStreamOptions<DeferredCancelOptions>(api, streamEnv, options),
      ),
    } : {}),
  };
}

function withCapturedPiStreamEnv(
  auth: ProviderAuth,
  streamEnv: ProviderEnv | undefined,
  api: SupportedPiApi,
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
        assertNoAmbientPiStreamEnvFallback(api, resolvedEnv);
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

/** The configured model record: the full model, or a catalog reference resolved through the installed SDK. */
export function resolvePiModelRecord(
  config: PiAgentCoreModelConfig,
  moduleLoader: (specifier: string) => Promise<unknown> = importEsmModule,
): Promise<Record<string, unknown>> {
  return config.catalog ? resolvePiCatalogModel(config.catalog, moduleLoader) : Promise.resolve(config.model);
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
  assertSafeBedrockCredentialSnapshot(api, authEnv);

  const {piAi, catalog, providerStreams} = await loadPiProviderRuntimeModules(
    api,
    env,
    moduleLoader,
  );
  const supportedLevels = piAi.getSupportedThinkingLevels(model);
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
  const baseAuth = builtinProvider?.auth ?? {
    apiKey: piAi.envApiKeyAuth(
      `${providerId} API key`,
      piProviderApiKeyEnvNames(providerId, config.apiKeyEnv),
    ),
  };
  const streamEnv = capturePiStreamEnv(api, authEnv);
  const auth = withCapturedPiStreamEnv(
    baseAuth,
    streamEnv,
    api,
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
    api: withCapturedProviderStreams(providerStreams, streamEnv, api),
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
      let selected: ReturnType<typeof resolveModelExecutionPolicy>;
      try {
        if (!isDeepStrictEqual(identity(sentModel), capturedIdentity)) throw new PiModelExecutionConfigurationError();
        const levels = piAi.getSupportedThinkingLevels(sentModel);
        const compat = sentModel.api === 'openai-completions' ? (sentModel as Model<'openai-completions'>).compat : undefined;
        const knownThinkingFormat = compat?.thinkingFormat === 'zai' || compat?.thinkingFormat === 'deepseek';
        const protocol = sentModel.api === 'openai-completions' ? 'chat_completions'
          : sentModel.api === 'openai-responses' || sentModel.api === 'azure-openai-responses' ? 'responses'
          : sentModel.api === 'anthropic-messages' ? 'anthropic_messages' : 'unknown';
        const stageCandidate = purpose === 'classification' || purpose === 'review' ||
          purpose === 'continuation' && policy?.outputOnly === true;
        const sdkLevel = (options as SimpleStreamOptions | undefined)?.reasoning ?? authoredLevel;
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
        requestedLevel = selected.controls.surface === 'pi_stream' ? selected.controls.reasoning
          : stageCandidate && authoredLevel !== undefined ? authoredLevel : sdkLevel;
        assertSupportedLevel(requestedLevel);
        const nativeMapped = requestedLevel && sentModel.thinkingLevelMap?.[requestedLevel];
        const sdkEffective = requestedLevel === undefined ? undefined : requestedLevel === 'off' ? asSetting('off')
          : typeof nativeMapped === 'string'
            ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(nativeMapped)
              ? {mode: 'enabled' as const, effort: nativeMapped as ReasoningEffort} : undefined
            : asSetting(requestedLevel);
        // Bind the receipt to the SDK's final selected/mapped setting and the actual stream cap.
        selected = resolveModelExecutionPolicy({profile: resolveModelExecutionProfile({...profileInput,
          effective: {...profileInput.effective, sdkEffectiveReasoning: sdkEffective}}), purpose, outputOnly: policy?.outputOnly,
          selection: stageCandidate ? 'minimum_legal_candidate' : 'preserve'});
        if (selected.status === 'unsupported') throw new PiModelExecutionConfigurationError();
      } catch {throw new PiModelExecutionConfigurationError();}
      try {policy?.onExecutionPolicy?.(selected.receipt);} catch { /* Observers never change a stream. */ }
      const scopedOptions: SimpleStreamOptions = {...options};
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
  return {model, models, streamFn: streamFnForPurpose('answer_turn'), streamFnForPurpose, thinkingLevel: authoredLevel};
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
