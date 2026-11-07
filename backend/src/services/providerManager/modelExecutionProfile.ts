// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';
import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {isProductionAgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {isFinalSubmissionMode, type FinalSubmissionMode} from '../../agentRuntime/finalSubmissionConfig';
import {resolveConclusionDeclarationSyntax} from '../../agent/core/conclusionAuthoring';
import type {ConclusionDeclarationSyntax} from '../../agent/core/conclusionContract';

export const MODEL_EXECUTION_PROFILE_RULESET = 'model_execution_profile_rules@5';
export type ModelExecutionProtocol = 'chat_completions' | 'responses' | 'anthropic_messages' | 'native' | 'unknown';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningSetting = Readonly<{mode: 'disabled'} | {mode: 'enabled'; effort?: ReasoningEffort}>;
export type ModelControlSurface = 'openai_chat' | 'openai_responses' | 'pi_stream' | 'claude_effort' | 'opencode_agent_options' | 'none';
export type ModelFactSource = 'official' | 'installed_sdk' | 'contract_test' | 'runtime_observation';
export type ModelFactReason = 'unrecognized_endpoint_model_protocol' | 'native_model_unknown' | 'capability_unsupported';
export type ModelCapabilityFact<T> =
  | Readonly<{status: 'supported'; value: T; source: ModelFactSource; evidenceId: string}>
  | Readonly<{status: 'unsupported'; reason: ModelFactReason; source: ModelFactSource; evidenceId: string}>
  | Readonly<{status: 'unknown'; reason: ModelFactReason}>;

/** Caller projects these facts from the installed SDK/model; no catalog or SDK is loaded here. */
export interface SdkModelCapabilities {
  readonly surface: ModelControlSurface;
  readonly thinking: 'required' | 'optional' | 'none' | 'unknown';
  readonly efforts?: readonly ReasoningEffort[];
  readonly nativeDefault?: ReasoningSetting;
  readonly reasoningRoundtrip: 'supported' | 'unsupported' | 'unknown';
  readonly source: 'installed_sdk' | 'contract_test';
}

/** Already resolved values from the same captured config the runtime will use. */
export interface ModelEffectiveSettings {
  /** Captured output configuration, not a claim of actual transport adoption. */
  readonly finalSubmission?: FinalSubmissionMode;
  readonly declarationSyntax?: ConclusionDeclarationSyntax;
  readonly authoredReasoning?: ReasoningSetting;
  readonly sdkEffectiveReasoning?: ReasoningSetting;
  readonly maxOutputTokens?: number;
  readonly maxTurns?: number;
  readonly quickMaxTurns?: number;
  readonly quickTargetTurns?: number;
  readonly fullPerTurnMs?: number;
  readonly quickPerTurnMs?: number;
  readonly fullRequestTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly maxRunTimeoutMs?: number;
  readonly classifierTimeoutMs?: number;
  readonly maxHistoryBytes?: number;
}

export interface ResolveModelExecutionProfileInput {
  readonly runtimeKind: AgentRuntimeKind;
  readonly protocol: ModelExecutionProtocol;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly sdk: Readonly<{packageName: string; version: string; adapterContractVersion: string}>;
  readonly sdkCapabilities: SdkModelCapabilities;
  readonly effective: ModelEffectiveSettings;
}

export interface ModelExecutionFingerprint {
  readonly schemaVersion: 'model_execution_fingerprint@1';
  readonly value: string;
}

export interface ResolvedModelExecutionProfile {
  readonly schemaVersion: 'model_execution_profile@1';
  readonly rulesetVersion: typeof MODEL_EXECUTION_PROFILE_RULESET;
  readonly runtimeKind: AgentRuntimeKind;
  readonly protocol: ModelExecutionProtocol;
  readonly model: Readonly<{
    identity: 'configured' | 'native_default_unknown';
    requestedId?: string;
    documentedRevision?: string;
    revisionEvidence: 'documented_alias' | 'unknown';
    revisionEvidenceId?: string;
  }>;
  readonly endpoint: Readonly<{
    origin?: string;
    family: 'glm_coding' | 'glm_standard' | 'deepseek' | 'other';
    identityHash: string;
  }>;
  readonly sdk: ResolveModelExecutionProfileInput['sdk'];
  readonly server: Readonly<{
    thinking: ModelCapabilityFact<'required' | 'optional' | 'none'>;
    /** Canonical effort levels used for new candidate controls. */
    efforts: ModelCapabilityFact<readonly ReasoningEffort[]>;
    /** Accepted authored spellings; documenting a server mapping never rewrites the SDK input. */
    effortAliases: ModelCapabilityFact<readonly Readonly<{accepted: ReasoningEffort; documented: ReasoningEffort}>[]>;
    defaultReasoning: ModelCapabilityFact<ReasoningSetting>;
    toolReasoning: ModelCapabilityFact<'verbatim_native_context'>;
    /** Observed function-call primitive only; neither strict-final nor analysis quality. */
    functionTools: ModelCapabilityFact<'function_call_arguments'>;
    /** JSON syntax control only, not schema conformance, tools compatibility or quality. */
    jsonOutput?: ModelCapabilityFact<'json_object'>;
    /** Documented parameter facts only, not available context/output budget or effective settings. Older profiles may omit this fact. */
    outputTokens?: ModelCapabilityFact<Readonly<{
      parameter: 'max_tokens';
      range: Readonly<{minimum: number; maximum: number}>;
      defaults: Readonly<{thinkingDisabled: number; thinkingEnabled: number; thinkingEnabledMaxEffort: number}>;
    }>>;
  }>;
  readonly adapter: SdkModelCapabilities;
  readonly effective: ModelEffectiveSettings;
  readonly fingerprint: ModelExecutionFingerprint;
}

const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type OpenAIAnalysisReasoningEffort = ReasoningEffort | 'none';

/** Shared config/snapshot boundary: never reflect an invalid environment value. */
export function parseOpenAIAnalysisReasoningEffort(value: string | undefined): OpenAIAnalysisReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (value === 'none') return value;
  const effort = EFFORTS.find(effort => effort === value);
  if (effort) return effort;
  throw new Error('invalid_configuration:openai_analysis_reasoning_effort');
}

const PROTOCOLS: readonly ModelExecutionProtocol[] = ['chat_completions', 'responses', 'anthropic_messages', 'native', 'unknown'];
const SURFACES: readonly ModelControlSurface[] = ['openai_chat', 'openai_responses', 'pi_stream', 'claude_effort', 'opencode_agent_options', 'none'];
const NUMERIC_SETTINGS = ['maxOutputTokens', 'maxTurns', 'quickMaxTurns', 'quickTargetTurns', 'fullPerTurnMs',
  'quickPerTurnMs', 'fullRequestTimeoutMs', 'streamIdleTimeoutMs', 'maxRunTimeoutMs', 'classifierTimeoutMs', 'maxHistoryBytes'] as const;
const GLM_EVIDENCE = 'zai-chat-completion-thinking-2026-11-05';
const DEEPSEEK_EVIDENCE = 'deepseek-thinking-mode-2026-11-05';
const DEEPSEEK_REVISION_EVIDENCE = 'deepseek-models-pricing-2026-11-05';
const DEEPSEEK_OUTPUT_TOKENS_EVIDENCE = 'deepseek-chat-completion-max-tokens-2026-11-06';

function invalid(): never {throw new Error('model_execution_invalid_configuration');}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) invalid();
  return value;
}
function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function reasoning(value: ReasoningSetting | undefined): ReasoningSetting | undefined {
  if (value === undefined) return undefined;
  if (value?.mode === 'disabled') {
    if ('effort' in value && value.effort !== undefined) invalid();
    return {mode: 'disabled'};
  }
  if (value?.mode !== 'enabled' || (value.effort !== undefined && !EFFORTS.includes(value.effort))) invalid();
  return {mode: 'enabled', ...(value.effort !== undefined ? {effort: value.effort} : {})};
}
function effectiveSettings(input: ModelEffectiveSettings): ModelEffectiveSettings {
  if (!input || typeof input !== 'object') invalid();
  if (input.finalSubmission !== undefined && !isFinalSubmissionMode(input.finalSubmission)) invalid();
  let declarationSyntax: ConclusionDeclarationSyntax | undefined;
  if (input.declarationSyntax !== undefined) {
    try {declarationSyntax = resolveConclusionDeclarationSyntax(input.declarationSyntax);} catch {invalid();}
  }
  const authoredReasoning = reasoning(input.authoredReasoning);
  const sdkEffectiveReasoning = reasoning(input.sdkEffectiveReasoning);
  const numbers: Partial<Record<typeof NUMERIC_SETTINGS[number], number>> = {};
  for (const key of NUMERIC_SETTINGS) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) invalid();
    numbers[key] = value;
  }
  return {...(input.finalSubmission !== undefined ? {finalSubmission: input.finalSubmission} : {}),
    ...(declarationSyntax !== undefined ? {declarationSyntax} : {}),
    ...(authoredReasoning ? {authoredReasoning} : {}),
    ...(sdkEffectiveReasoning ? {sdkEffectiveReasoning} : {}), ...numbers};
}
function adapterFacts(input: SdkModelCapabilities): SdkModelCapabilities {
  if (!input || !SURFACES.includes(input.surface) || !['required', 'optional', 'none', 'unknown'].includes(input.thinking) ||
    !['supported', 'unsupported', 'unknown'].includes(input.reasoningRoundtrip) ||
    !['installed_sdk', 'contract_test'].includes(input.source)) invalid();
  if (input.efforts !== undefined && (!Array.isArray(input.efforts) || input.efforts.some(level => !EFFORTS.includes(level)))) invalid();
  const nativeDefault = reasoning(input.nativeDefault);
  return {surface: input.surface, thinking: input.thinking,
    ...(input.efforts !== undefined ? {efforts: EFFORTS.filter(level => input.efforts!.includes(level))} : {}),
    ...(nativeDefault ? {nativeDefault} : {}), reasoningRoundtrip: input.reasoningRoundtrip, source: input.source};
}
function endpointIdentity(baseUrl: string | undefined, protocol: ModelExecutionProtocol): ResolvedModelExecutionProfile['endpoint'] {
  if (baseUrl === undefined) return {family: 'other', identityHash: hash(['endpoint_unknown'])};
  if (typeof baseUrl !== 'string') invalid();
  let url: URL;
  try {url = new URL(baseUrl);} catch {return {family: 'other', identityHash: hash(['endpoint_invalid', baseUrl])};}
  const path = url.pathname.replace(/\/+$/, '');
  let family: ResolvedModelExecutionProfile['endpoint']['family'] = 'other';
  if (url.protocol === 'https:' && !url.username && !url.password) {
    if (['https://open.bigmodel.cn', 'https://api.z.ai'].includes(url.origin)) {
      if (['/api/coding/paas/v4', '/api/coding/paas/v4/chat/completions'].includes(path)) family = 'glm_coding';
      else if (['/api/paas/v4', '/api/paas/v4/chat/completions'].includes(path)) family = 'glm_standard';
    } else if (url.origin === 'https://api.deepseek.com') {
      const paths = protocol === 'chat_completions' ? ['', '/v1', '/chat/completions', '/v1/chat/completions']
        : protocol === 'responses' ? ['', '/v1', '/responses', '/v1/responses']
        : protocol === 'anthropic_messages' ? ['/anthropic', '/anthropic/v1'] : [];
      if (paths.includes(path)) family = 'deepseek';
    }
  }
  return {...(url.protocol === 'http:' || url.protocol === 'https:' ? {origin: url.origin} : {}),
    family, identityHash: hash(['endpoint', url.href])};
}
function supported<T>(value: T, evidenceId: string): ModelCapabilityFact<T> {
  return {status: 'supported', value, source: 'official', evidenceId};
}

/** R5 scheduler-constructed reports: function tools ran, while both analyses failed.
 * Exact report SHA-256 identifies primitive evidence, never typed-final adoption.
 * No alias, protocol or endpoint-family extrapolation is admitted here.
 */
const OBSERVED_FUNCTION_TOOLS = [
  {endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash',
    evidenceId: 'r5-glm-function-tools:sha256:2929107c4bba84eaa4281995c65bda9144c7f31a86bdbfe83840749577a26092'},
  {endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
    evidenceId: 'r5-deepseek-function-tools:sha256:a0f3c52aea032fda638b74b05f287bec6b190fac2b794072e0ea80fb9e1ea0ed'},
] as const;

function observedFunctionTools(baseUrl: string | undefined, modelId: string | undefined,
  protocol: ModelExecutionProtocol, unknown: ModelCapabilityFact<never>): ModelCapabilityFact<'function_call_arguments'> {
  if (!baseUrl || protocol !== 'chat_completions') return unknown;
  let url: URL;
  try {url = new URL(baseUrl);} catch {return unknown;}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return unknown;
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const observation = OBSERVED_FUNCTION_TOOLS.find(item => item.endpoint === endpoint && item.model === modelId);
  return observation ? {status: 'supported', value: 'function_call_arguments', source: 'runtime_observation',
    evidenceId: observation.evidenceId} : unknown;
}

/** https://api-docs.deepseek.com/api/create-chat-completion/ (checked 2026-11-06).
 * This is the max_tokens parameter range, still subject to total input+output context;
 * it neither states the context size nor chooses/observes an effective model mode.
 */
function documentedOutputTokens(baseUrl: string | undefined, modelId: string | undefined,
  protocol: ModelExecutionProtocol, unknown: ModelCapabilityFact<never>): ResolvedModelExecutionProfile['server']['outputTokens'] {
  if (!baseUrl || protocol !== 'chat_completions' ||
    (modelId !== 'deepseek-flash' && modelId !== 'deepseek-v4-pro')) return unknown;
  let url: URL;
  try {url = new URL(baseUrl);} catch {return unknown;}
  // Independently check the original URL: the older endpoint-family facts have a broader contract.
  // The raw delimiter check also rejects empty userinfo/query/fragment markers normalized away by URL.
  if (url.protocol !== 'https:' || url.origin !== 'https://api.deepseek.com' ||
    url.username || url.password || url.search || url.hash || /[?@#]/.test(baseUrl) ||
    !['', '/v1', '/chat/completions', '/v1/chat/completions'].includes(url.pathname.replace(/\/$/, ''))) return unknown;
  return supported({parameter: 'max_tokens', range: {minimum: 1, maximum: 393216},
    defaults: {thinkingDisabled: 8192, thinkingEnabled: 65536, thinkingEnabledMaxEffort: 131072}}, DEEPSEEK_OUTPUT_TOKENS_EVIDENCE);
}

/** Official JSON-mode parameter, checked 2026-11-07:
 * https://docs.z.ai/guides/capabilities/struct-output
 * https://api-docs.deepseek.com/api/create-chat-completion/
 * Accept the exact base and dispatch URLs of the admitted endpoints. */
function documentedJsonOutput(baseUrl: string | undefined, modelId: string | undefined,
  protocol: ModelExecutionProtocol, unknown: ModelCapabilityFact<never>): ResolvedModelExecutionProfile['server']['jsonOutput'] {
  if (!baseUrl || protocol !== 'chat_completions') return unknown;
  let url: URL;
  try {url = new URL(baseUrl);} catch {return unknown;}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[?@#]/.test(baseUrl)) return unknown;
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  if (modelId === 'glm-5.3-flash' && ['https://open.bigmodel.cn/api/coding/paas/v4',
    'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'].includes(endpoint)) {
    return supported('json_object', 'glm-json-output-2026-11-07');
  }
  if (modelId === 'deepseek-flash' && ['https://api.deepseek.com/v1',
    'https://api.deepseek.com/v1/chat/completions'].includes(endpoint)) {
    return supported('json_object', 'deepseek-json-output-2026-11-07');
  }
  return unknown;
}

function serverFacts(modelId: string | undefined, endpoint: ResolvedModelExecutionProfile['endpoint'], protocol: ModelExecutionProtocol,
  baseUrl: string | undefined): {
  model: ResolvedModelExecutionProfile['model']; server: ResolvedModelExecutionProfile['server'];
} {
  const model: ResolvedModelExecutionProfile['model'] = {identity: modelId === undefined ? 'native_default_unknown' : 'configured',
    ...(modelId !== undefined ? {requestedId: modelId} : {}), revisionEvidence: 'unknown'};
  const unknown: ModelCapabilityFact<never> = {status: 'unknown', reason: modelId === undefined
    ? 'native_model_unknown' : 'unrecognized_endpoint_model_protocol'};
  const server: ResolvedModelExecutionProfile['server'] = {thinking: unknown, efforts: unknown, effortAliases: unknown,
    defaultReasoning: unknown, toolReasoning: unknown, functionTools: observedFunctionTools(baseUrl, modelId, protocol, unknown),
    jsonOutput: documentedJsonOutput(baseUrl, modelId, protocol, unknown),
    outputTokens: documentedOutputTokens(baseUrl, modelId, protocol, unknown)};
  // Small protocol facts, not a provider model catalog. Preserve the exact requested ID.
  // https://docs.z.ai/api-reference/llm/chat-completion
  if (['glm_coding', 'glm_standard'].includes(endpoint.family) && protocol === 'chat_completions' &&
    (modelId === 'glm-5.3-flash' || modelId === 'glm-5.3')) {
    return {model, server: {...server, thinking: supported('required', GLM_EVIDENCE),
      efforts: supported(['low', 'high', 'max'], GLM_EVIDENCE), effortAliases: supported([], GLM_EVIDENCE),
      defaultReasoning: supported({mode: 'enabled', effort: 'max'}, GLM_EVIDENCE),
      toolReasoning: supported('verbatim_native_context', GLM_EVIDENCE)}};
  }
  // https://api-docs.deepseek.com/quick_start/pricing/
  // https://api-docs.deepseek.com/guides/thinking_mode/
  const flash = modelId !== undefined && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(modelId);
  if (endpoint.family === 'deepseek' && ['chat_completions', 'responses', 'anthropic_messages'].includes(protocol) &&
    (flash || modelId === 'deepseek-v4-pro')) {
    return {model: {...model, documentedRevision: flash ? 'DeepSeek-V4.1-Flash-1017' : 'DeepSeek-V4-Pro-0813',
      revisionEvidence: 'documented_alias', revisionEvidenceId: DEEPSEEK_REVISION_EVIDENCE},
    server: {...server, thinking: supported('optional', DEEPSEEK_EVIDENCE),
      efforts: supported(['low', 'high', 'max'], DEEPSEEK_EVIDENCE),
      effortAliases: supported([{accepted: 'minimal', documented: 'low'}, {accepted: 'medium', documented: 'high'},
        {accepted: 'xhigh', documented: 'high'}], DEEPSEEK_EVIDENCE),
      defaultReasoning: supported({mode: 'enabled', effort: 'high'}, DEEPSEEK_EVIDENCE),
      toolReasoning: supported('verbatim_native_context', DEEPSEEK_EVIDENCE)}};
  }
  return {model, server};
}

/** Pure, secret-free current-run receipt. It neither replaces nor migrates provider snapshot hashes. */
export function resolveModelExecutionProfile(input: ResolveModelExecutionProfileInput): ResolvedModelExecutionProfile {
  if (!input || !isProductionAgentRuntimeKind(input.runtimeKind) || !PROTOCOLS.includes(input.protocol)) invalid();
  const modelId = input.modelId === undefined ? undefined : identifier(input.modelId);
  const sdk = {packageName: identifier(input.sdk?.packageName), version: identifier(input.sdk?.version),
    adapterContractVersion: identifier(input.sdk?.adapterContractVersion)};
  const endpoint = endpointIdentity(input.baseUrl, input.protocol);
  const facts = serverFacts(modelId, endpoint, input.protocol, input.baseUrl);
  const body: Omit<ResolvedModelExecutionProfile, 'fingerprint'> = {schemaVersion: 'model_execution_profile@1',
    rulesetVersion: MODEL_EXECUTION_PROFILE_RULESET,
    runtimeKind: input.runtimeKind, protocol: input.protocol, model: facts.model, endpoint, sdk,
    server: facts.server, adapter: adapterFacts(input.sdkCapabilities), effective: effectiveSettings(input.effective)};
  return freeze({...body, fingerprint: {schemaVersion: 'model_execution_fingerprint@1' as const, value: hash(body)}});
}
