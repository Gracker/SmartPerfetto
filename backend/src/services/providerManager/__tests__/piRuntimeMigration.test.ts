// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parsePiAgentCoreModelConfig} from '../../../agentRuntime/engines/pi/piAgentCoreConfig';
import {createPiAgentCoreProviderRuntime, PI_SYNTHESIZED_MODEL_DEFAULTS, resolvePiRouteModel} from '../../../agentRuntime/engines/pi/piAgentCoreProvider';
import type {RecordedProductionRuntimeKind} from '../../../agentRuntime/runtimeKinds';
import {resetRuntimeDeprecationWarningsForTests} from '../../../agentRuntime/legacyRuntimeFallback';
import {piRequestOrigin, runtimeEnvFor, withEnvOnlyPiModel} from '../piProviderCatalog';
import {reconcileRecordedProviderPin} from '../providerPinContinuity';
import {supportedAgentRuntimesForType, withProviderRecordFacts} from '../providerRuntimeMatrix';
import {ProviderService} from '../providerService';
import {legacyProviderRuntimeSnapshot, resolveProviderRuntimeSnapshot} from '../providerSnapshot';
import {withMigratedAgentRuntime} from '../retiredRuntime';
import {officialTemplates} from '../templates';
import type {ProviderConfig, ProviderConnection, ProviderType} from '../types';
import {installedPiCatalogLoader} from './installedPiCatalog';

type Env = Record<string, string | undefined>;

/** What a request goes out as: the API surface, request origin, model id and credential form. */
interface RequestTarget {
  api: string;
  origin: string | undefined;
  model: string | undefined;
  auth: string;
  /** The credential value sent (or the profile/file that yields it). */
  credential?: string;
}

/** The runtime each template defaulted to before Pi became the only runtime (frozen for these fixtures). */
const PREVIOUS_TEMPLATE_RUNTIME: Record<ProviderType, RecordedProductionRuntimeKind | undefined> = {
  anthropic: undefined,
  bedrock: undefined,
  vertex: undefined,
  deepseek: 'pi-agent-core',
  glm: 'pi-agent-core',
  qwen: 'claude-agent-sdk',
  qwen_coding: 'claude-agent-sdk',
  kimi_code: 'claude-agent-sdk',
  kimi: 'claude-agent-sdk',
  doubao: 'claude-agent-sdk',
  minimax: 'claude-agent-sdk',
  xiaomi: 'claude-agent-sdk',
  tencent_token_plan: 'claude-agent-sdk',
  tencent_coding_plan: 'claude-agent-sdk',
  hunyuan: 'claude-agent-sdk',
  qianfan: 'claude-agent-sdk',
  stepfun: 'claude-agent-sdk',
  siliconflow: 'claude-agent-sdk',
  huawei: 'claude-agent-sdk',
  openai: 'openai-agents-sdk',
  ollama: 'openai-agents-sdk',
  custom: 'claude-agent-sdk',
};

function credentialsFor(type: ProviderType): Partial<ProviderConnection> {
  switch (type) {
    case 'anthropic': return {apiKey: 'sk-test-anthropic'};
    case 'bedrock': return {awsBearerToken: 'bedrock-bearer-token'};
    case 'vertex': return {gcpProjectId: 'demo-project'};
    case 'openai': return {openaiApiKey: 'sk-test-openai'};
    case 'ollama': return {};
    case 'custom': return {apiKey: 'sk-test-custom', claudeBaseUrl: 'https://gateway.example/anthropic'};
    default: return {apiKey: `sk-test-${type}`};
  }
}

/** A stored profile created from a template before the migration, on `runtime` (undefined: none recorded). */
function templateRecord(type: ProviderType, runtime: RecordedProductionRuntimeKind | undefined,
  connection: Partial<ProviderConnection> = {}): ProviderConfig {
  const template = officialTemplates.find(candidate => candidate.type === type)!;
  const {agentRuntime: _currentDefault, ...defaults} = template.defaultConnection ?? {};
  return {
    id: `provider-${type}`, name: template.displayName, category: type === 'custom' ? 'custom' : 'official', type,
    isActive: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    models: type === 'custom' ? {primary: 'custom-primary', light: 'custom-light'} : {...template.defaultModels},
    connection: {...defaults, ...(runtime ? {agentRuntime: runtime} : {}), ...credentialsFor(type), ...connection},
  };
}

/**
 * The oracle: what the retired runtime called, read from the env it received
 * (the same legacy env the hidden opt-in still builds). Written independently
 * of the Pi resolver so the endpoint-preservation invariant is not circular.
 */
function previousTarget(env: Env, runtime: RecordedProductionRuntimeKind): RequestTarget {
  if (runtime === 'claude-agent-sdk') {
    if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
      const region = env.AWS_REGION ?? 'us-east-1';
      return {api: 'bedrock-converse-stream',
        origin: piRequestOrigin(env.ANTHROPIC_BEDROCK_BASE_URL ?? `https://bedrock-runtime.${region}.amazonaws.com`),
        model: env.CLAUDE_MODEL,
        ...(env.AWS_BEARER_TOKEN_BEDROCK ? {auth: 'bedrock-bearer', credential: env.AWS_BEARER_TOKEN_BEDROCK}
          : env.AWS_PROFILE ? {auth: 'bedrock-profile', credential: env.AWS_PROFILE}
            : env.AWS_ACCESS_KEY_ID ? {auth: 'bedrock-keys', credential: env.AWS_ACCESS_KEY_ID}
              // The AWS SDK's default chain: shared files, SSO, web identity, container or instance role.
              : {auth: 'bedrock-default-chain'})};
    }
    if (env.CLAUDE_CODE_USE_VERTEX === '1') {
      const credentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      // Claude Code's Vertex endpoint: CLOUD_ML_REGION (default us-east5), multi-region "us"/"eu", or an explicit base URL.
      const region = env.CLOUD_ML_REGION ?? 'us-east5';
      const vertexOrigin = env.ANTHROPIC_VERTEX_BASE_URL ?? (region === 'global' ? 'https://aiplatform.googleapis.com/v1'
        : region === 'us' || region === 'eu' ? `https://aiplatform.${region}.rep.googleapis.com/v1`
          : `https://${region}-aiplatform.googleapis.com/v1`);
      return {api: 'anthropic-vertex', origin: piRequestOrigin(vertexOrigin),
        model: env.CLAUDE_MODEL, ...(credentialsFile ? {auth: 'google-credentials-file', credential: credentialsFile}
          : {auth: 'google-adc'})};
    }
    const auth = env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY ? 'x-api-key+bearer'
      : env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key';
    return {api: 'anthropic-messages', origin: piRequestOrigin(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'),
      model: env.CLAUDE_MODEL, auth, credential: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY};
  }
  return {api: runtime === 'opencode' || env.OPENAI_AGENTS_PROTOCOL === 'chat_completions' ? 'openai-completions' : 'openai-responses',
    origin: piRequestOrigin(env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'), model: env.OPENAI_MODEL,
    auth: 'bearer', credential: env.OPENAI_API_KEY};
}

/** What Pi will call with this env. */
function effectiveTarget(env: Env): RequestTarget {
  const config = parsePiAgentCoreModelConfig(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON!);
  if (config.catalog) {
    return {api: `catalog:${config.catalog.providers.join(',')}`, origin: piRequestOrigin(config.catalog.baseUrl),
      model: config.catalog.id, auth: `catalog-key:${config.apiKeyEnv}`, credential: env[config.apiKeyEnv!]};
  }
  const route = config.route!;
  const base = {api: route.api, origin: piRequestOrigin(route.baseUrl), model: route.id};
  if (route.api === 'bedrock-converse-stream') {
    return {...base, ...(route.aws?.profile ? {auth: 'bedrock-profile', credential: route.aws.profile}
      : route.aws?.defaultChain ? {auth: 'bedrock-default-chain'}
        : env.AWS_BEARER_TOKEN_BEDROCK ? {auth: 'bedrock-bearer', credential: env.AWS_BEARER_TOKEN_BEDROCK}
          : {auth: 'bedrock-keys', credential: env.AWS_ACCESS_KEY_ID})};
  }
  if (route.api === 'anthropic-vertex') {
    return {...base, ...(env.GOOGLE_APPLICATION_CREDENTIALS
      ? {auth: 'google-credentials-file', credential: env.GOOGLE_APPLICATION_CREDENTIALS} : {auth: 'google-adc'})};
  }
  if (route.api === 'anthropic-messages') {
    const auth = config.authTokenEnv && config.apiKeyEnv ? 'x-api-key+bearer' : config.authTokenEnv ? 'bearer' : 'x-api-key';
    return {...base, auth, credential: env[config.authTokenEnv ?? config.apiKeyEnv!]};
  }
  return {...base, auth: 'bearer', credential: env[config.apiKeyEnv!]};
}

const ENV_KEYS = ['SMARTPERFETTO_LEGACY_AGENT_RUNTIME', 'GOOGLE_APPLICATION_CREDENTIALS', 'SMARTPERFETTO_AGENT_RUNTIME',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OPENAI_MODEL', 'OPENAI_AGENTS_PROTOCOL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION',
  'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_BASE_URL', 'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let dir: string;
let svc: ProviderService;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/managed/vertex-credentials.json';
  resetRuntimeDeprecationWarningsForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-migration-'));
  svc = new ProviderService(path.join(dir, 'providers.json'));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, {recursive: true, force: true});
});

/** The Pi env a stored record yields after the read-time migration, as the store serves it. */
function piEnvOf(record: ProviderConfig): Record<string, string> {
  return svc.getEnvForProviderConfig(withMigratedAgentRuntime(record));
}

describe('migration mapping: every template on the runtime it ran on before', () => {
  // template type -> [api, request origin, model, auth form]; the reviewed mapping table.
  const EXPECTED: Record<ProviderType, [string, string, string, string]> = {
    anthropic: ['anthropic-messages', 'https://api.anthropic.com', 'claude-sonnet-5', 'x-api-key'],
    bedrock: ['bedrock-converse-stream', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'us.anthropic.claude-sonnet-5', 'bedrock-bearer'],
    vertex: ['anthropic-vertex', 'https://us-central1-aiplatform.googleapis.com/v1', 'claude-sonnet-5', 'google-credentials-file'],
    deepseek: ['catalog:deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', 'catalog-key:DEEPSEEK_API_KEY'],
    glm: ['catalog:zai-coding-cn,zai', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', 'catalog-key:ZAI_CODING_CN_API_KEY'],
    qwen: ['anthropic-messages', 'https://dashscope.aliyuncs.com/apps/anthropic', 'qwen3.8-flash', 'bearer'],
    qwen_coding: ['anthropic-messages', 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic', 'qwen3-coder-plus', 'bearer'],
    kimi_code: ['anthropic-messages', 'https://api.kimi.com/coding', 'kimi-for-coding', 'bearer'],
    kimi: ['anthropic-messages', 'https://api.moonshot.cn/anthropic', 'kimi-k2.7-code-highspeed', 'bearer'],
    doubao: ['anthropic-messages', 'https://ark.cn-beijing.volces.com/api/coding', 'ark-code-latest', 'bearer'],
    minimax: ['anthropic-messages', 'https://api.minimaxi.com/anthropic', 'MiniMax-M3', 'bearer'],
    xiaomi: ['anthropic-messages', 'https://token-plan-sgp.xiaomimimo.com/anthropic', 'mimo-v2.5-pro', 'bearer'],
    tencent_token_plan: ['anthropic-messages', 'https://api.lkeap.cloud.tencent.com/plan/anthropic', 'tc-code-latest', 'bearer'],
    tencent_coding_plan: ['anthropic-messages', 'https://api.lkeap.cloud.tencent.com/coding/anthropic', 'tc-code-latest', 'bearer'],
    hunyuan: ['anthropic-messages', 'https://api.hunyuan.cloud.tencent.com/anthropic', 'hunyuan-2.0-thinking-20251109', 'bearer'],
    qianfan: ['anthropic-messages', 'https://qianfan.baidubce.com/anthropic', 'deepseek-v4-flash', 'bearer'],
    stepfun: ['anthropic-messages', 'https://api.stepfun.com/step_plan', 'step-3.7-flash', 'bearer'],
    siliconflow: ['anthropic-messages', 'https://api.siliconflow.com', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'bearer'],
    huawei: ['anthropic-messages', 'https://api.modelarts-maas.com/anthropic', 'deepseek-v4-pro', 'bearer'],
    openai: ['openai-responses', 'https://api.openai.com/v1', 'gpt-5.6-terra', 'bearer'],
    ollama: ['openai-completions', 'http://localhost:11434/v1', 'qwen3:30b', 'bearer'],
    custom: ['anthropic-messages', 'https://gateway.example/anthropic', 'custom-primary', 'x-api-key'],
  };

  it('covers every provider template', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(officialTemplates.map(template => template.type).sort());
  });

  it.each(officialTemplates.map(template => template.type))('%s keeps its endpoint, model and credential form', (type) => {
    const record = templateRecord(type, PREVIOUS_TEMPLATE_RUNTIME[type]);
    const env = piEnvOf(record);
    const [api, origin, model, auth] = EXPECTED[type];
    expect(env.SMARTPERFETTO_AGENT_RUNTIME).toBe('pi-agent-core');
    expect(effectiveTarget(env)).toMatchObject({api, origin, model, auth});
    // No Claude/OpenAI surface env reaches Pi.
    expect(Object.keys(env).filter(key => /^(ANTHROPIC_|CLAUDE_|OPENAI_)/.test(key))).toEqual([]);
    // Nothing synthesized is persisted: the migrated record holds no model JSON.
    expect(withMigratedAgentRuntime(record).connection.piAgentCoreModelJson).toBeUndefined();
  });

  // Every template on each retired runtime its type supported, and with no runtime recorded.
  const RETIRED: Array<[ProviderType, RecordedProductionRuntimeKind | undefined]> = officialTemplates.flatMap(template =>
    (['claude-agent-sdk', 'openai-agents-sdk', undefined] as const)
      .map(runtime => [template.type, runtime] as [ProviderType, RecordedProductionRuntimeKind | undefined]),
  ).filter(([type, runtime]) => {
    if (runtime === 'openai-agents-sdk') return !['anthropic', 'bedrock', 'vertex'].includes(type);
    if (runtime === 'claude-agent-sdk') return !['openai', 'ollama'].includes(type);
    return true;
  });

  it.each(RETIRED)('endpoint-preservation invariant: %s previously on %s', (type, runtime) => {
    const record = templateRecord(type, runtime);
    // The runtime that record ran on (an unrecorded one was the type's default).
    const previous = runtime ?? (['openai', 'ollama'].includes(type) ? 'openai-agents-sdk' : 'claude-agent-sdk');
    const legacyEnv: Env = {...svc.getEnvForProviderUnderRuntime(record, previous)};
    const before = previousTarget(legacyEnv, previous);
    const after = effectiveTarget(piEnvOf(record));
    expect(after).toEqual(before);
    expect(after.credential).toBeTruthy();
  });

  it('honours OPENAI_AGENTS_PROTOCOL on an OpenAI profile', () => {
    const chat = templateRecord('openai', 'openai-agents-sdk', {openaiProtocol: 'chat_completions'});
    expect(effectiveTarget(piEnvOf(chat))).toMatchObject({api: 'openai-completions', origin: 'https://api.openai.com/v1'});
    const responses = templateRecord('openai', 'openai-agents-sdk');
    expect(effectiveTarget(piEnvOf(responses))).toMatchObject({api: 'openai-responses'});
  });

  it('sends a placeholder key to a local Ollama endpoint, as the OpenAI runtime did', () => {
    const env = piEnvOf(templateRecord('ollama', 'openai-agents-sdk'));
    expect(effectiveTarget(env)).toMatchObject({auth: 'bearer', credential: 'ollama'});
  });

  it.each([
    ['AWS profile', {awsBearerToken: undefined, awsProfile: 'analysis'}, 'bedrock-profile', 'analysis'],
    ['IAM keys', {awsBearerToken: undefined, awsAccessKeyId: 'AKIDEXAMPLE', awsSecretAccessKey: 'secret'}, 'bedrock-keys', 'AKIDEXAMPLE'],
  ] as const)('maps Bedrock %s credentials without ambient fallback', (_name, connection, auth, credential) => {
    const record = templateRecord('bedrock', undefined, {...connection, awsRegion: 'eu-central-1'});
    const env = piEnvOf(record);
    expect(effectiveTarget(env)).toMatchObject({api: 'bedrock-converse-stream', auth, credential,
      origin: 'https://bedrock-runtime.eu-central-1.amazonaws.com'});
    // A profile travels as its name in the route (fingerprinted with the region), never as resolved keys or AWS_PROFILE.
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_REGION).toBe('eu-central-1');
  });

  it('never sends a credential-less Bedrock provider to the host AWS identity', () => {
    const env = piEnvOf(templateRecord('bedrock', undefined, {awsBearerToken: undefined}));
    expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBeUndefined();
    expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE).toBe('bedrock_credentials_missing');
  });

  it('refuses a provider model JSON that names an AWS credential chain', () => {
    for (const aws of [{region: 'us-east-1', profile: 'prod-admin'}, {region: 'us-east-1', defaultChain: true}]) {
      const env = piEnvOf(templateRecord('custom', 'pi-agent-core', {piAgentCoreModelJson: JSON.stringify({route: {
        api: 'bedrock-converse-stream', provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-5',
        baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', aws}})}));
      expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBeUndefined();
      expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE).toBe('model_json_credential_chain');
    }
  });

  it('normalizes a short Bedrock model id the way the Claude runtime did', () => {
    const record = templateRecord('bedrock', undefined, {});
    record.models = {primary: 'claude-sonnet-5', light: 'claude-haiku-4-5'};
    expect(effectiveTarget(piEnvOf(record)).model).toBe('us.anthropic.claude-sonnet-5');
  });

  it('uses Google ADC for Vertex without a credentials file, as the Claude runtime did', () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const env = piEnvOf(templateRecord('vertex', undefined));
    expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE).toBeUndefined();
    expect(effectiveTarget(env)).toMatchObject({api: 'anthropic-vertex', auth: 'google-adc'});
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('sends a dual-surface provider\'s own claudeApiKey as x-api-key and claudeAuthToken as Bearer', () => {
    expect(effectiveTarget(piEnvOf(templateRecord('qwen', 'claude-agent-sdk', {apiKey: undefined, claudeApiKey: 'sk-claude-key'}))))
      .toMatchObject({auth: 'x-api-key', credential: 'sk-claude-key'});
    expect(effectiveTarget(piEnvOf(templateRecord('qwen', 'claude-agent-sdk', {apiKey: undefined, claudeAuthToken: 'claude-token'}))))
      .toMatchObject({auth: 'bearer', credential: 'claude-token'});
  });
});

describe('migration mapping: custom provider shapes', () => {
  const custom = (connection: Partial<ProviderConnection>, models = {primary: 'gw-model', light: 'gw-light'}): ProviderConfig => ({
    ...templateRecord('custom', undefined), models, connection: connection as ProviderConnection,
  });

  it.each([
    ['Claude fields', {agentRuntime: 'claude-agent-sdk', claudeBaseUrl: 'https://gw.example/anthropic', claudeAuthToken: 'tok'},
      ['anthropic-messages', 'https://gw.example/anthropic', 'gw-model', 'bearer']],
    ['OpenAI fields', {agentRuntime: 'openai-agents-sdk', openaiBaseUrl: 'https://gw.example/v1', openaiApiKey: 'sk-gw',
      openaiProtocol: 'chat_completions'}, ['openai-completions', 'https://gw.example/v1', 'gw-model', 'bearer']],
    ['OpenAI fields without a recorded runtime', {openaiBaseUrl: 'https://gw.example/v1', openaiApiKey: 'sk-gw'},
      ['openai-completions', 'https://gw.example/v1', 'gw-model', 'bearer']],
    ['Claude env overrides', {agentRuntime: 'claude-agent-sdk'}, ['anthropic-messages', 'https://override.example/anthropic', 'gw-model', 'bearer']],
    ['OpenCode on OpenAI fields', {agentRuntime: 'opencode', openaiBaseUrl: 'https://oc.example/v1', openaiApiKey: 'sk-oc',
      openCodeSdkModulePath: '/tmp/sdk.mjs'}, ['openai-completions', 'https://oc.example/v1', 'gw-model', 'bearer']],
    ['OpenCode model JSON with an endpoint', {agentRuntime: 'opencode',
      openCodeModelJson: '{"providerID":"x","modelID":"oc-json-model","baseURL":"https://json.example/v1","apiKey":"sk-json"}'},
    ['openai-completions', 'https://json.example/v1', 'oc-json-model', 'bearer']],
  ] as const)('%s', (_name, connection, [api, origin, model, auth]) => {
    const record = custom(connection as Partial<ProviderConnection>);
    if (_name === 'Claude env overrides') {
      record.custom = {envOverrides: {ANTHROPIC_BASE_URL: 'https://override.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok-override'}};
    }
    expect(effectiveTarget(piEnvOf(record))).toMatchObject({api, origin, model, auth});
    const migrated = withMigratedAgentRuntime(record);
    // A recorded retired runtime becomes Pi; an unrecorded one stays unrecorded (its inference is deterministic).
    expect(migrated.connection.agentRuntime).toBe('agentRuntime' in connection ? 'pi-agent-core' : undefined);
    expect(migrated.connection.openCodeModelJson).toBeUndefined();
    expect(migrated.connection.openCodeSdkModulePath).toBeUndefined();
    expect(withMigratedAgentRuntime(migrated)).toBe(migrated);
  });

  it.each([
    ['OpenCode model JSON without an endpoint', {agentRuntime: 'opencode', openCodeModelJson: '{"modelID":"m"}'},
      'opencode_model_json_untranslatable'],
    ['Qoder', {agentRuntime: 'qoder-agent-sdk', qoderAccessToken: 'pat'}, 'qoder_untranslatable'],
    ['Qoder recorded only by its fields', {qoderCliPath: '/usr/local/bin/qodercli'}, 'qoder_untranslatable'],
  ] as const)('keeps an untranslatable %s profile explicit', (_name, connection, reason) => {
    const record = custom(connection as Partial<ProviderConnection>);
    expect(withMigratedAgentRuntime(record).connection).toEqual(record.connection);
    const env = piEnvOf(record);
    expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBeUndefined();
    expect(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE).toBe(reason);
  });

  it('keeps an explicit Pi model JSON as the user override', () => {
    const explicit = '{"id":"m","provider":"p","api":"openai-completions","baseUrl":"https://explicit.example/v1"}';
    const record = custom({agentRuntime: 'claude-agent-sdk', claudeBaseUrl: 'https://gw.example/anthropic', apiKey: 'k',
      piAgentCoreModelJson: explicit});
    expect(piEnvOf(record).SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBe(explicit);
  });
});

describe('read-time migration of stored profiles', () => {
  it('migrates providers.json on read, idempotently, and persists only on the next save', () => {
    const file = path.join(dir, 'providers.json');
    const stored = [templateRecord('qwen', 'claude-agent-sdk'), {...templateRecord('kimi', 'openai-agents-sdk'), id: 'kimi-openai', isActive: false}];
    fs.writeFileSync(file, JSON.stringify(stored));
    const service = new ProviderService(file);

    expect(service.getRaw('provider-qwen')!.connection).toMatchObject({agentRuntime: 'pi-agent-core', apiSurface: 'claude'});
    expect(service.getRaw('kimi-openai')!.connection).toMatchObject({agentRuntime: 'pi-agent-core', apiSurface: 'openai'});
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].connection.agentRuntime).toBe('claude-agent-sdk');

    service.update('provider-qwen', {name: 'Renamed'});
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).find((p: ProviderConfig) => p.id === 'provider-qwen');
    expect(saved.connection).toMatchObject({agentRuntime: 'pi-agent-core', apiSurface: 'claude'});
    expect(saved.connection.piAgentCoreModelJson).toBeUndefined();
    // The saved profile still resolves to the same endpoint, and later edits keep applying.
    service.update('provider-qwen', {models: {primary: 'qwen3.8-max'}});
    expect(effectiveTarget(service.getEnvForProvider('provider-qwen')!)).toMatchObject({
      origin: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.8-max', auth: 'bearer'});
  });

  it('offers only Pi to every provider type, and no template defaults to a retired runtime', () => {
    for (const template of officialTemplates) {
      expect(supportedAgentRuntimesForType(template.type)).toEqual(['pi-agent-core']);
      expect([undefined, 'pi-agent-core']).toContain(template.defaultConnection?.agentRuntime);
    }
  });
});

describe('the hidden legacy runtime opt-in', () => {
  it('outranks the provider record, reads only the process env, and never enters provider env', () => {
    const record = withMigratedAgentRuntime(templateRecord('qwen', 'claude-agent-sdk'));
    expect(svc.resolveAgentRuntime(record)).toBe('pi-agent-core');
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'claude-agent-sdk';
    expect(svc.resolveAgentRuntime(record)).toBe('claude-agent-sdk');
    const env = svc.getEnvForProviderConfig(record);
    expect(env).toMatchObject({SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
      ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-test-qwen'});
    expect(env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME).toBeUndefined();
    // A record that ran on another engine stays on Pi, whose route keeps its own endpoint and key.
    expect(svc.resolveAgentRuntime(templateRecord('openai', undefined))).toBe('pi-agent-core');
  });

  it('cannot be set through a provider profile', () => {
    expect(() => svc.create({name: 'x', category: 'custom', type: 'custom', models: {primary: 'm', light: 'm'},
      connection: {claudeBaseUrl: 'https://gw.example/anthropic'},
      custom: {envOverrides: {SMARTPERFETTO_LEGACY_AGENT_RUNTIME: 'claude-agent-sdk'}}}))
      .toThrow('Custom provider env override is not allowed: SMARTPERFETTO_LEGACY_AGENT_RUNTIME');
  });
});

describe('env-only setups', () => {
  const target = (env: Env) => effectiveTarget(withEnvOnlyPiModel(env));

  it.each([
    ['Anthropic API key', {ANTHROPIC_API_KEY: 'sk-ant'}, ['anthropic-messages', 'https://api.anthropic.com', 'claude-sonnet-5', 'x-api-key']],
    ['Anthropic-compatible token gateway', {ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://gw.example/anthropic',
      CLAUDE_MODEL: 'gw-model'}, ['anthropic-messages', 'https://gw.example/anthropic', 'gw-model', 'bearer']],
    ['OpenAI Responses', {SMARTPERFETTO_AGENT_RUNTIME: 'openai-agents-sdk', OPENAI_API_KEY: 'sk-oa', OPENAI_MODEL: 'gpt-5.5',
      OPENAI_AGENTS_PROTOCOL: 'responses'}, ['openai-responses', 'https://api.openai.com/v1', 'gpt-5.5', 'bearer']],
    ['OpenAI-compatible Chat Completions', {OPENAI_API_KEY: 'sk-oa', OPENAI_BASE_URL: 'https://gw.example/v1',
      OPENAI_MODEL: 'gw-chat', OPENAI_AGENTS_PROTOCOL: 'chat_completions'}, ['openai-completions', 'https://gw.example/v1', 'gw-chat', 'bearer']],
    ['Ollama', {SMARTPERFETTO_AGENT_RUNTIME: 'openai-agents-sdk', OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'ollama', OPENAI_MODEL: 'qwen3:8b', OPENAI_AGENTS_PROTOCOL: 'chat_completions'},
    ['openai-completions', 'http://localhost:11434/v1', 'qwen3:8b', 'bearer']],
    ['Bedrock bearer token', {CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', AWS_BEARER_TOKEN_BEDROCK: 'bt',
      CLAUDE_MODEL: 'us.anthropic.claude-sonnet-5'}, ['bedrock-converse-stream', 'https://bedrock-runtime.us-west-2.amazonaws.com',
      'us.anthropic.claude-sonnet-5', 'bedrock-bearer']],
    ['Bedrock IAM keys', {CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 's',
      CLAUDE_MODEL: 'us.anthropic.claude-sonnet-5'}, ['bedrock-converse-stream', 'https://bedrock-runtime.us-east-1.amazonaws.com',
      'us.anthropic.claude-sonnet-5', 'bedrock-keys']],
    ['Vertex', {CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLOUD_ML_REGION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json'}, ['anthropic-vertex', 'https://aiplatform.googleapis.com/v1', 'claude-sonnet-5',
      'google-credentials-file']],
  ] as const)('%s', (_name, env, [api, origin, model, auth]) => {
    expect(target(env)).toMatchObject({api, origin, model, auth});
  });

  it.each([
    ['a named AWS_PROFILE', {AWS_PROFILE: 'analysis'}, {auth: 'bedrock-profile', credential: 'analysis'}],
    ['no named credential (the AWS default chain)', {}, {auth: 'bedrock-default-chain'}],
  ] as const)('keeps env-only Bedrock with %s working, as the Claude runtime did', (_name, credentials, expected) => {
    const env: Env = {CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', CLAUDE_MODEL: 'us.anthropic.claude-sonnet-5', ...credentials};
    expect(target(env)).toMatchObject({api: 'bedrock-converse-stream', ...expected,
      origin: 'https://bedrock-runtime.us-west-2.amazonaws.com'});
    expect(target(env)).toEqual(previousTarget(env, 'claude-agent-sdk'));
  });

  it.each([
    ['no region (Claude Code defaulted to us-east5)', {}, 'https://us-east5-aiplatform.googleapis.com/v1'],
    ['the "eu" multi-region', {CLOUD_ML_REGION: 'eu'}, 'https://aiplatform.eu.rep.googleapis.com/v1'],
    ['an explicit Vertex base URL', {ANTHROPIC_VERTEX_BASE_URL: 'https://vertex-proxy.example/v1'}, 'https://vertex-proxy.example/v1'],
  ] as const)('keeps env-only Vertex with %s on the endpoint Claude Code called', (_name, extra, origin) => {
    const env: Env = {CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLAUDE_MODEL: 'claude-sonnet-5',
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS, ...extra};
    expect(target(env)).toMatchObject({api: 'anthropic-vertex', origin: piRequestOrigin(origin)});
    expect(target(env)).toEqual(previousTarget(env, 'claude-agent-sdk'));
  });

  it('reports a per-model Vertex region override instead of guessing its model mapping', () => {
    const env: Env = {CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'proj', VERTEX_REGION_CLAUDE_5_SONNET: 'europe-west1'};
    expect(withEnvOnlyPiModel(env).SMARTPERFETTO_PI_AGENT_CORE_MODEL_UNAVAILABLE).toBe('vertex_model_region_override');
  });

  it('refuses placeholder keys instead of guessing', () => {
    const placeholder: Env = {ANTHROPIC_API_KEY: 'sk-ant-xxx'};
    expect(withEnvOnlyPiModel(placeholder).SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON).toBeUndefined();
  });

  it('keeps an explicit Pi model JSON untouched', () => {
    const env = {SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"x"}', ANTHROPIC_API_KEY: 'sk-ant'};
    expect(withEnvOnlyPiModel(env)).toBe(env);
  });
});

describe('Pi model resolution against the installed pi-ai catalog', () => {
  const loader = installedPiCatalogLoader();
  const resolve = async (record: ProviderConfig) => {
    const config = parsePiAgentCoreModelConfig(piEnvOf(record).SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON);
    return {config, model: await resolvePiRouteModel(config.route!, loader)};
  };

  it.each([
    ['anthropic', undefined, 'anthropic'],
    ['bedrock', undefined, 'amazon-bedrock'],
    ['minimax', 'claude-agent-sdk', 'minimax-cn'],
    ['openai', 'openai-agents-sdk', 'openai'],
  ] as const)('uses the catalog model where it serves %s on the same API and host', async (type, runtime, provider) => {
    const {config, model} = await resolve(templateRecord(type, runtime));
    expect(model).toMatchObject({provider, api: config.route!.api, id: config.route!.id, baseUrl: config.route!.baseUrl});
  });

  it.each([
    ['kimi', 'claude-agent-sdk', {contextWindow: 262_144, maxTokens: 262_144}],
    ['kimi_code', 'claude-agent-sdk', {contextWindow: 1_048_576, maxTokens: 32_768}],
    ['qwen', 'claude-agent-sdk', {contextWindow: PI_SYNTHESIZED_MODEL_DEFAULTS.contextWindow['anthropic-messages'],
      maxTokens: PI_SYNTHESIZED_MODEL_DEFAULTS.maxTokens['anthropic-messages']}],
    ['ollama', 'openai-agents-sdk', {contextWindow: PI_SYNTHESIZED_MODEL_DEFAULTS.contextWindow['openai-completions'],
      maxTokens: PI_SYNTHESIZED_MODEL_DEFAULTS.maxTokens['openai-completions']}],
    ['vertex', undefined, {contextWindow: PI_SYNTHESIZED_MODEL_DEFAULTS.contextWindow['anthropic-vertex'],
      maxTokens: PI_SYNTHESIZED_MODEL_DEFAULTS.maxTokens['anthropic-vertex']}],
  ] as const)('synthesizes %s on its previous API and endpoint with catalog-peer or default limits', async (type, runtime, limits) => {
    const {config, model} = await resolve(templateRecord(type, runtime));
    const adaptiveGateway = config.route!.api === 'anthropic-messages';
    expect(model).toMatchObject({provider: config.route!.provider, api: config.route!.api, baseUrl: config.route!.baseUrl,
      reasoning: adaptiveGateway, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, ...limits});
    if (config.route!.api !== 'openai-completions') {
      expect(model.compat).toEqual({supportsEagerToolInputStreaming: false, ...(adaptiveGateway ? {forceAdaptiveThinking: true} : {})});
    }
  });

  it('takes limits from a same-host catalog entry for an OpenAI model on Chat Completions', async () => {
    const {model} = await resolve(templateRecord('openai', 'openai-agents-sdk', {openaiProtocol: 'chat_completions'}));
    expect(model).toMatchObject({api: 'openai-completions', provider: 'smartperfetto-openai', contextWindow: 272_000, maxTokens: 128_000});
  });
});

describe('thinking on an Anthropic-compatible gateway', () => {
  const catalog = {builtinProviders: () => [], getBuiltinModels: () => [], getBuiltinModel: () => undefined} as Record<string, unknown>;
  const context = {messages: [], tools: []} as never;

  // Jest's sandbox gives structuredClone results another realm's prototypes, which the runtime's deep-equal identity check rejects.
  beforeEach(() => {jest.spyOn(globalThis, 'structuredClone').mockImplementation(value => ({...(value as object)}) as never);});
  afterEach(() => {jest.restoreAllMocks();});

  async function gatewayRuntime(modelId: string, catalogModule: Record<string, unknown> = catalog) {
    const sent: Array<Record<string, any>> = [];
    const piAi = {
      getSupportedThinkingLevels: () => ['off', 'minimal', 'low', 'medium', 'high'],
      InMemoryCredentialStore: class {async modify(_id: string, update: () => Promise<unknown>) {return update();}},
      envApiKeyAuth: () => ({apiKey: {name: 'test', resolve: async () => undefined}}),
      createProvider: (provider: unknown) => provider,
      createModels: () => ({setProvider: () => undefined, streamSimple: (_model: unknown, _context: unknown, options: Record<string, any>) => {
        sent.push(options);
        return {};
      }}),
    };
    const loader = async (specifier: string) => specifier.endsWith('/providers/all') ? catalogModule
      : specifier.includes('/api/') ? new Proxy({}, {get: (_target, key) => key === 'then' ? undefined : () => ({stream: () => undefined, streamSimple: () => undefined})})
        : piAi;
    const record = {...templateRecord('kimi', 'claude-agent-sdk'), models: {primary: modelId, light: modelId}};
    const env = piEnvOf(record);
    const config = parsePiAgentCoreModelConfig(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON);
    return {sent, runtime: await createPiAgentCoreProviderRuntime(config, env, loader as never)};
  }

  it('gives a non-Claude model the adaptive thinking the retired engine sent', async () => {
    const {runtime, sent} = await gatewayRuntime('kimi-test');
    expect(runtime).toMatchObject({thinkingLevel: undefined, runThinkingFollowsScene: true, model: {reasoning: true}});
    await runtime.streamFn(runtime.model, context, {reasoning: 'medium'} as never);
    expect(sent[0].reasoning).toBe('medium');
    expect(runtime.model.compat).toMatchObject({forceAdaptiveThinking: true});
  });

  it.each(['classification', 'review'] as const)('disables thinking for a capped %s call', async purpose => {
    const {runtime, sent} = await gatewayRuntime('kimi-test');
    await runtime.streamFnForPurpose!(purpose)(runtime.model, context, {maxTokens: 1024} as never);
    expect(sent[0].reasoning).toBeUndefined();
  });

  it('keeps the scene depth on a catalog model the retired engine served', async () => {
    const entry = {id: 'kimi-test', api: 'anthropic-messages', provider: 'catalog', baseUrl: 'https://x.example',
      reasoning: true, input: ['text'], cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0}, contextWindow: 100_000, maxTokens: 8_000};
    const {runtime} = await gatewayRuntime('kimi-test', {builtinProviders: () => [{id: 'catalog', name: 'catalog', auth: {}}],
      getBuiltinModels: () => [entry], getBuiltinModel: () => entry});
    expect(runtime).toMatchObject({runThinkingFollowsScene: true, thinkingLevel: undefined, model: {provider: 'catalog', contextWindow: 100_000}});
  });

  it('leaves a Claude model behind a relay on its own thinking rules', async () => {
    const {runtime, sent} = await gatewayRuntime('claude-sonnet-5');
    expect(runtime.runThinkingFollowsScene).toBe(false);
    expect(runtime.thinkingLevel).toBeUndefined();
    expect(runtime.model.reasoning).toBe(false);
    await runtime.streamFn(runtime.model, context, {} as never);
    expect(sent[0].reasoning).toBeUndefined();
  });
});

describe('per-run limits an operator set before the migration', () => {
  it('carries a provider\'s tuning to Pi', () => {
    const env = piEnvOf({...templateRecord('kimi', 'claude-agent-sdk'),
      tuning: {maxTurns: 20, maxBudgetUsd: 1.5, effort: 'medium', fullPerTurnMs: 1_000, quickPerTurnMs: 2_000, classifierTimeoutMs: 3_000}});
    expect(env).toMatchObject({AGENT_MAX_TURNS: '20', AGENT_FULL_REQUEST_TIMEOUT_MS: '20000', AGENT_QUICK_PER_TURN_MS: '2000',
      AGENT_CLASSIFIER_TIMEOUT_MS: '3000', SMARTPERFETTO_PI_MAX_BUDGET_USD: '1.5', SMARTPERFETTO_PI_EFFORT: 'medium'});
  });

  it('adds nothing without tuning', () => {
    expect(Object.keys(piEnvOf(templateRecord('kimi', 'claude-agent-sdk'))).filter(key => key.startsWith('AGENT_'))).toEqual([]);
  });

  it('caps the full deadline as the retired engines did', () => {
    expect(piEnvOf({...templateRecord('kimi', 'claude-agent-sdk'), tuning: {fullPerTurnMs: 120_000}}))
      .toMatchObject({AGENT_FULL_REQUEST_TIMEOUT_MS: String(20 * 60_000)});
  });

  it('reads the env the retired runtime used, and an explicit Pi setting wins', () => {
    const env = runtimeEnvFor({ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_MAX_TURNS: '30', CLAUDE_QUICK_MAX_TURNS: '12', CLAUDE_MAX_BUDGET_USD: '2',
      CLAUDE_EFFORT: 'Low', AGENT_QUICK_PER_TURN_MS: '999', CLAUDE_QUICK_PER_TURN_MS: '5', CLAUDE_FULL_REQUEST_TIMEOUT_MS: '7000'}, null, 'pi-agent-core');
    expect(env).toMatchObject({AGENT_MAX_TURNS: '30', AGENT_QUICK_MAX_TURNS: '12', SMARTPERFETTO_PI_MAX_BUDGET_USD: '2',
      SMARTPERFETTO_PI_EFFORT: 'low', AGENT_QUICK_PER_TURN_MS: '999', AGENT_FULL_REQUEST_TIMEOUT_MS: '7000'});
  });

  it('lets a provider inherit a process limit it did not set, and its own tuning wins', () => {
    const base = {CLAUDE_MAX_TURNS: '30', CLAUDE_MAX_BUDGET_USD: '2'};
    expect(runtimeEnvFor(base, {SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core', AGENT_MAX_TURNS: '9'}, 'pi-agent-core'))
      .toMatchObject({AGENT_MAX_TURNS: '9', SMARTPERFETTO_PI_MAX_BUDGET_USD: '2'});
  });

  it('falls back to the Claude names for an OpenAI env-only setup, as the OpenAI runtime did', () => {
    expect(runtimeEnvFor({OPENAI_API_KEY: 'sk-oai', CLAUDE_MAX_TURNS: '30'}, null, 'pi-agent-core')).toMatchObject({AGENT_MAX_TURNS: '30'});
    expect(runtimeEnvFor({OPENAI_API_KEY: 'sk-oai', OPENAI_MAX_TURNS: '8', CLAUDE_MAX_TURNS: '30'}, null, 'pi-agent-core')).toMatchObject({AGENT_MAX_TURNS: '8'});
  });

  it('ignores an unrecognized effort', () => {
    expect(runtimeEnvFor({ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_EFFORT: 'banana'}, null, 'pi-agent-core').SMARTPERFETTO_PI_EFFORT).toBeUndefined();
  });
});

describe('recovered pins across the migration (compatibility predicate)', () => {
  function storeRecords(records: ProviderConfig[]): ProviderService {
    const file = path.join(dir, 'providers.json');
    fs.writeFileSync(file, JSON.stringify(records));
    return new ProviderService(file);
  }

  /** The hash a session recorded before the migration: the record under its old runtime. */
  function recordedPin(service: ProviderService, providerId: string | null, runtime: RecordedProductionRuntimeKind) {
    return {providerId, runtimeKind: runtime, analysisContextFingerprint: 'fp-1',
      snapshotHash: legacyProviderRuntimeSnapshot(service, providerId, runtime)!.snapshotHash};
  }

  it('rebinds a provider pin when the legacy hash, origin, model and authorization are unchanged', () => {
    const service = storeRecords([templateRecord('qwen', 'claude-agent-sdk')]);
    const recorded = recordedPin(service, 'provider-qwen', 'claude-agent-sdk');
    const current = resolveProviderRuntimeSnapshot(service, 'provider-qwen');
    expect(current.snapshot.runtimeKind).toBe('pi-agent-core');
    expect(current.snapshotHash).not.toBe(recorded.snapshotHash);
    expect(reconcileRecordedProviderPin(service, recorded, current, {currentAnalysisContextFingerprint: 'fp-1', now: 7}))
      .toEqual({status: 'migrated', note: {at: 7, fromRuntimeKind: 'claude-agent-sdk', toRuntimeKind: 'pi-agent-core',
        previousProviderSnapshotHash: recorded.snapshotHash}});
  });

  it('rebinds an env-only pin the same way', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example/anthropic';
    process.env.CLAUDE_MODEL = 'gw-model';
    const recorded = recordedPin(svc, null, 'claude-agent-sdk');
    const current = resolveProviderRuntimeSnapshot(svc, null);
    expect(reconcileRecordedProviderPin(svc, recorded, current, {currentAnalysisContextFingerprint: 'fp-1'}).status).toBe('migrated');
  });

  it.each([
    ['a changed authorization fingerprint', (s: ProviderService) => s, 'fp-2'],
    ['a changed endpoint', (s: ProviderService) => {
      s.update('provider-qwen', {connection: {claudeBaseUrl: 'https://other.example/anthropic', apiKey: 'sk-test-qwen'}});
      return s;
    }, 'fp-1'],
    ['a changed model', (s: ProviderService) => { s.update('provider-qwen', {models: {primary: 'qwen3.8-max'}}); return s; }, 'fp-1'],
  ] as const)('keeps the explicit outcome for %s', (_name, mutate, fingerprint) => {
    const service = storeRecords([templateRecord('qwen', 'claude-agent-sdk')]);
    const recorded = recordedPin(service, 'provider-qwen', 'claude-agent-sdk');
    mutate(service);
    const current = resolveProviderRuntimeSnapshot(service, 'provider-qwen');
    expect(reconcileRecordedProviderPin(service, recorded, current, {currentAnalysisContextFingerprint: fingerprint}).status)
      .toBe('changed');
  });

  it('never treats an origin change as compatible, even when the legacy hash matches', () => {
    // An explicit Pi model JSON does not enter the Claude runtime's snapshot, but it moves Pi's endpoint.
    const service = storeRecords([templateRecord('qwen', 'claude-agent-sdk', {
      piAgentCoreModelJson: '{"route":{"api":"anthropic-messages","provider":"p","id":"qwen3.8-flash","baseUrl":"https://elsewhere.example/anthropic"}}',
    })]);
    const recorded = recordedPin(service, 'provider-qwen', 'claude-agent-sdk');
    expect(legacyProviderRuntimeSnapshot(service, 'provider-qwen', 'claude-agent-sdk')!.snapshotHash).toBe(recorded.snapshotHash);
    const current = resolveProviderRuntimeSnapshot(service, 'provider-qwen');
    expect(reconcileRecordedProviderPin(service, recorded, current, {currentAnalysisContextFingerprint: 'fp-1'}).status).toBe('changed');
  });

  it('keeps an unchanged pin unchanged, including under the legacy opt-in', () => {
    const service = storeRecords([templateRecord('qwen', 'claude-agent-sdk')]);
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'claude-agent-sdk';
    const recorded = recordedPin(service, 'provider-qwen', 'claude-agent-sdk');
    const current = resolveProviderRuntimeSnapshot(service, 'provider-qwen');
    expect(current.snapshot.runtimeKind).toBe('claude-agent-sdk');
    expect(reconcileRecordedProviderPin(service, recorded, current, {currentAnalysisContextFingerprint: 'fp-1'}).status).toBe('unchanged');
  });

  it.each([
    ['an OpenAI-only custom profile', templateRecord('custom', undefined, {
      claudeBaseUrl: undefined, openaiBaseUrl: 'https://gw.example/v1', apiKey: 'sk-shared'}), 'provider-custom'],
    ['a dual-surface profile that ran on its OpenAI surface', templateRecord('qwen', 'openai-agents-sdk'), 'provider-qwen'],
    ['a profile that already ran on Pi', templateRecord('deepseek', 'pi-agent-core'), 'provider-deepseek'],
  ] as const)('keeps %s on Pi under a Claude opt-in, never on another engine\'s endpoint', (_name, record, id) => {
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'claude-agent-sdk';
    const service = storeRecords([record]);
    expect(resolveProviderRuntimeSnapshot(service, id).snapshot.runtimeKind).toBe('pi-agent-core');
  });

  it('keeps a pin that already ran on Pi byte-identical', () => {
    const service = storeRecords([templateRecord('deepseek', 'pi-agent-core')]);
    const before = legacyProviderRuntimeSnapshot(service, 'provider-deepseek', 'pi-agent-core')!.snapshotHash;
    expect(resolveProviderRuntimeSnapshot(service, 'provider-deepseek').snapshotHash).toBe(before);
  });
});

describe('recovered pins against hashes the retired runtime itself computed', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'retiredRuntimePins.json'), 'utf8')) as {
    providers: ProviderConfig[];
    envOnly: Record<string, Env>;
    snapshotHashes: Record<string, string>;
  };
  // The capture ran with every provider-related variable cleared; so does each case here.
  const CAPTURE_ENV = /^(ANTHROPIC|CLAUDE|OPENAI|AWS|GOOGLE|DEEPSEEK|SMARTPERFETTO_AGENT_RUNTIME|SMARTPERFETTO_PI)/;
  let hostEnv: Env;
  beforeEach(() => {
    hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => CAPTURE_ENV.test(key)));
    for (const key of Object.keys(hostEnv)) delete process.env[key];
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (CAPTURE_ENV.test(key)) delete process.env[key];
    Object.assign(process.env, hostEnv);
  });

  it.each(golden.providers.map(provider => [provider.id, provider] as const))(
    'rebinds %s: its frozen legacy hash, origin and model still match after the read-time migration', (id, provider) => {
      const file = path.join(dir, 'providers.json');
      fs.writeFileSync(file, JSON.stringify(golden.providers));
      const service = new ProviderService(file);
      const runtime = provider.connection.agentRuntime as RecordedProductionRuntimeKind;
      expect(legacyProviderRuntimeSnapshot(service, id, runtime)?.snapshotHash).toBe(golden.snapshotHashes[id]);
      const recorded = {providerId: id, runtimeKind: runtime, analysisContextFingerprint: 'fp-1',
        snapshotHash: golden.snapshotHashes[id]};
      const current = resolveProviderRuntimeSnapshot(service, id);
      expect(reconcileRecordedProviderPin(service, recorded, current, {currentAnalysisContextFingerprint: 'fp-1'}).status)
        .toBe('migrated');
    });

  it.each(Object.keys(golden.envOnly))('rebinds an env-only %s pin', runtime => {
    Object.assign(process.env, golden.envOnly[runtime], {SMARTPERFETTO_AGENT_RUNTIME: runtime});
    const hash = golden.snapshotHashes[`env:${runtime}`];
    expect(legacyProviderRuntimeSnapshot(svc, null, runtime as RecordedProductionRuntimeKind)?.snapshotHash).toBe(hash);
    const recorded = {providerId: null, runtimeKind: runtime, analysisContextFingerprint: 'fp-1', snapshotHash: hash};
    expect(reconcileRecordedProviderPin(svc, recorded, resolveProviderRuntimeSnapshot(svc, null),
      {currentAnalysisContextFingerprint: 'fp-1'}).status).toBe('migrated');
  });
});

describe('selection deprecations', () => {
  it('logs one deprecation for an old SMARTPERFETTO_AGENT_RUNTIME value', async () => {
    const logger = (await import('../../../utils/logger')).default;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      const {agentRuntimeFromEnv} = await import('../../../agentRuntime/legacyRuntimeFallback');
      expect(agentRuntimeFromEnv()).toBe('pi-agent-core');
      expect(agentRuntimeFromEnv()).toBe('pi-agent-core');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('recorded runtime labels outside provider profiles', () => {
  it('keeps a CLI session\'s recorded runtime label as provenance and drops an unknown one', async () => {
    const {readConfig} = await import('../../../cli-user/io/sessionStore');
    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir);
    const sp = {config: path.join(sessionDir, 'config.json')} as Parameters<typeof readConfig>[0];
    const base = {sessionId: 's', tracePath: '/t', traceId: 't', createdAt: 1, lastTurnAt: 1, turnCount: 1};
    // The label is provenance: the resume resolves the effective runtime through runtime selection.
    fs.writeFileSync(sp.config, JSON.stringify({...base, agentRuntimeKind: 'opencode'}));
    expect(readConfig(sp)?.agentRuntimeKind).toBe('opencode');
    fs.writeFileSync(sp.config, JSON.stringify({...base, agentRuntimeKind: 'claude-agent-sdk'}));
    expect(readConfig(sp)?.agentRuntimeKind).toBe('claude-agent-sdk');
    fs.writeFileSync(sp.config, JSON.stringify({...base, agentRuntimeKind: 'agentv2'}));
    expect(readConfig(sp)).not.toHaveProperty('agentRuntimeKind');
  });

  it('normalizes session snapshots that name retired or experimental runtimes without failing', async () => {
    const snapshots = await import('../../../agentv3/sessionStateSnapshot');
    const base = {version: 1, sessionId: 's', traceId: 't'} as unknown as Parameters<typeof snapshots.normalizeSessionStateSnapshot>[0];
    const experimental = snapshots.normalizeSessionStateSnapshot({...base, agentRuntimeKind: 'experimental-pi-agent-core'});
    expect(experimental.engineState).toBeUndefined();
    expect(snapshots.getSnapshotRuntimeKind(experimental)).toBe('experimental-pi-agent-core');
    const retired = snapshots.normalizeSessionStateSnapshot({...base, agentRuntimeKind: 'qoder-agent-sdk',
      agentRuntimeProviderSnapshotHash: 'h'});
    expect(retired.engineState?.kind).toBe('qoder-agent-sdk');
    expect(snapshots.getSnapshotRuntimeKind({agentRuntimeKind: 'agentv2' as never})).toBeUndefined();
    // A rebind is an audit note distinct from a break, and survives the next restore.
    const notes = snapshots.continuityBreaksAfterRestore(undefined, 'h-old', 'claude-agent-sdk');
    expect(notes).toEqual([expect.objectContaining({reason: 'retired_runtime_rebound', fromRuntimeKind: 'claude-agent-sdk',
      previousProviderHash: 'h-old'})]);
    expect(snapshots.continuityBreaksAfterRestore(notes, undefined)).toEqual(notes);
  });

  it('rebinds a recovered conversation only for the verified migration of its own pin', async () => {
    const {ConversationSessionService} = await import('../../../assistant/application/conversationSessionService');
    const authorization = await import('../../resolvedAnalysisContext');
    const owner = {tenantId: 'tenant-m', workspaceId: 'workspace-m', userId: 'user-m'};
    const fingerprint = authorization.buildAnalysisContextAuthorizationFingerprint({}, owner);
    const descriptor = {version: 1 as const, ...owner, sessionId: 'migrated-conversation', traceContext: {kind: 'none' as const},
      providerId: null, providerFollowsActive: false, runtimeKind: 'claude-agent-sdk' as const, providerSnapshotHash: 'h-claude',
      analysisContextFingerprint: fingerprint, status: 'completed' as const, createdAt: 1, lastActivityAt: 2,
      lastRun: {runId: 'r', turnIndex: 0, query: 'q', status: 'completed' as const, startedAt: 1}};
    const input = {query: '', sessionId: descriptor.sessionId, owner, traceContext: descriptor.traceContext, providerId: null,
      runtimeKind: 'pi-agent-core' as const, providerSnapshotHash: 'h-pi', analysisContextFingerprint: fingerprint};
    const service = new ConversationSessionService({createRuntime: () => ({run: async () => ({kind: 'answered', message: 'ok'}),
      cancel: async () => undefined})});
    expect(() => service.restoreSession(descriptor, [], input)).toThrow('no longer matches');
    const note = {at: 3, fromRuntimeKind: 'opencode' as const, toRuntimeKind: 'pi-agent-core' as const, previousProviderSnapshotHash: 'h-claude'};
    expect(() => service.restoreSession(descriptor, [], {...input, runtimeMigration: note})).toThrow('no longer matches');
    const verified = {...note, fromRuntimeKind: 'claude-agent-sdk' as const};
    const session = service.restoreSession(descriptor, [], {...input, runtimeMigration: verified});
    expect(session).toMatchObject({runtimeKind: 'pi-agent-core', providerSnapshotHash: 'h-pi', runtimeMigration: verified});
  });
});

describe('withProviderRecordFacts', () => {
  it('reports the surface a record really uses, even with none recorded', () => {
    expect(withProviderRecordFacts({type: 'custom', connection: {openaiBaseUrl: 'https://llm.example/v1'}}))
      .toMatchObject({effectiveApiSurface: 'openai', supportedRuntimes: ['pi-agent-core']});
    expect(withProviderRecordFacts({type: 'custom', connection: {claudeBaseUrl: 'https://llm.example'}}).effectiveApiSurface).toBe('claude');
    expect(withProviderRecordFacts({type: 'custom', connection: {agentRuntime: 'pi-agent-core', piAgentCoreModelJson: '{}'}}))
      .not.toHaveProperty('effectiveApiSurface');
  });
});
