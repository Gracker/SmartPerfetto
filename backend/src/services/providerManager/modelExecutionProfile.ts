// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';
import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {isProductionAgentRuntimeKind} from '../../agentRuntime/runtimeKinds';

export const MODEL_EXECUTION_PROFILE_RULESET = 'model_execution_profile_rules@2';
export type ModelExecutionProtocol = 'chat_completions' | 'responses' | 'anthropic_messages' | 'native' | 'unknown';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningSetting = Readonly<{mode: 'disabled'} | {mode: 'enabled'; effort?: ReasoningEffort}>;
export type ModelControlSurface = 'openai_chat' | 'openai_responses' | 'pi_stream' | 'claude_effort' | 'opencode_agent_options' | 'none';
export type ModelFactSource = 'official' | 'installed_sdk' | 'contract_test';
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
  const authoredReasoning = reasoning(input.authoredReasoning);
  const sdkEffectiveReasoning = reasoning(input.sdkEffectiveReasoning);
  const numbers: Partial<Record<typeof NUMERIC_SETTINGS[number], number>> = {};
  for (const key of NUMERIC_SETTINGS) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) invalid();
    numbers[key] = value;
  }
  return {...(authoredReasoning ? {authoredReasoning} : {}),
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
function serverFacts(modelId: string | undefined, endpoint: ResolvedModelExecutionProfile['endpoint'], protocol: ModelExecutionProtocol): {
  model: ResolvedModelExecutionProfile['model']; server: ResolvedModelExecutionProfile['server'];
} {
  const model: ResolvedModelExecutionProfile['model'] = {identity: modelId === undefined ? 'native_default_unknown' : 'configured',
    ...(modelId !== undefined ? {requestedId: modelId} : {}), revisionEvidence: 'unknown'};
  const unknown: ModelCapabilityFact<never> = {status: 'unknown', reason: modelId === undefined
    ? 'native_model_unknown' : 'unrecognized_endpoint_model_protocol'};
  const server: ResolvedModelExecutionProfile['server'] = {thinking: unknown, efforts: unknown, effortAliases: unknown,
    defaultReasoning: unknown, toolReasoning: unknown};
  // Small protocol facts, not a provider model catalog. Preserve the exact requested ID.
  // https://docs.z.ai/api-reference/llm/chat-completion
  if (['glm_coding', 'glm_standard'].includes(endpoint.family) && protocol === 'chat_completions' &&
    (modelId === 'glm-5.3-flash' || modelId === 'glm-5.3')) {
    return {model, server: {thinking: supported('required', GLM_EVIDENCE),
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
    server: {thinking: supported('optional', DEEPSEEK_EVIDENCE),
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
  const facts = serverFacts(modelId, endpoint, input.protocol);
  const body: Omit<ResolvedModelExecutionProfile, 'fingerprint'> = {schemaVersion: 'model_execution_profile@1',
    rulesetVersion: MODEL_EXECUTION_PROFILE_RULESET,
    runtimeKind: input.runtimeKind, protocol: input.protocol, model: facts.model, endpoint, sdk,
    server: facts.server, adapter: adapterFacts(input.sdkCapabilities), effective: effectiveSettings(input.effective)};
  return freeze({...body, fingerprint: {schemaVersion: 'model_execution_fingerprint@1' as const, value: hash(body)}});
}
