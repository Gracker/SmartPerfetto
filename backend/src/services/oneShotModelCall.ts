// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// One isolated, one-shot model call for the product's auxiliary summaries
// (critical-path, comparison conclusion, flamegraph, scene stage 1/3), on the
// Claude Agent SDK or Pi Agent Core. This module owns every safeguard they share:
//   - the AI capability gate, the caller's permission and cancellation, all
//     checked before the provider is read;
//   - one provider read for the caller's scope: runtime, SDK env and config
//     all come from that record;
//   - credentials checked in the resolved profile env, never raw process env;
//   - SDK options detached from user settings, tools, skills, plugins, MCP
//     servers and resumable transcripts (the classifier transport's options);
//     Pi uses the same tool-free transport as its classifier and review;
//   - one AbortController for caller cancellation and the wall-clock deadline,
//     `close()` on every exit, and a tool-use or refusal reply treated as a
//     failed call.
// Raw SDK error text goes to the log only; callers get a reason code.
// The Claude SDK branch (its isolated options and stream reading) lives in the
// Claude engine (`agentRuntime/engines/claude/claudeOneShot.ts`).

import {selectRuntimeForProvider, type ResolvedAgentRuntimeKind} from '../agentRuntime/runtimeSelection';
import {
  loadClaudeConfig,
  runtimeConfigForProviderEnv,
  sdkEnvForProviderEnv,
  type EffortLevel,
} from '../agentv3/claudeConfig';
import {
  runIsolatedClaudeOneShot,
  type ClaudeOneShotContext,
} from '../agentRuntime/engines/claude/claudeOneShot';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {AiSummary} from '../types/criticalPathContract';
import {
  effectiveOneShotTimeoutMs,
  type OneShotCallInput,
  type OneShotFallbackReason,
  type OneShotResult,
} from '../agentRuntime/oneShotContract';
import {
  AI_CAPABILITY_ENV_KEY,
  type AiCapabilityFeature,
  type AiCapabilityPolicyV1,
  getAiCapabilityPolicy,
  isAiFeatureEnabled,
} from './aiCapabilityPolicy';
import {getProviderService, type ProviderScope} from './providerManager';
import {mergeIsolatedProviderEnv} from './providerManager/envIsolation';
import {readPiAgentCoreModelConfig} from '../agentRuntime/engines/pi/piAgentCoreConfig';
import {createPiAgentCoreProviderRuntime} from '../agentRuntime/engines/pi/piAgentCoreProvider';
import {runPiIntentTransport} from '../agentRuntime/engines/pi/piIntentTransport';

/** The Pi runtime env of the resolved provider (process env with the provider's env applied), read once. */
export interface PiOneShotContext {
  env: Record<string, string | undefined>;
}

/** A provider whose runtime is known; only Claude and Pi carry a one-shot context. */
export type ResolvedOneShotProvider =
  | {kind: 'resolved'; runtime: 'claude-agent-sdk'; claude: ClaudeOneShotContext}
  | {kind: 'resolved'; runtime: 'pi-agent-core'; pi: PiOneShotContext}
  | {kind: 'resolved'; runtime: Exclude<ResolvedAgentRuntimeKind, 'claude-agent-sdk' | 'pi-agent-core'>};

export type OneShotProvider = {kind: 'unavailable'} | ResolvedOneShotProvider;

/** Whether the provider's runtime can answer a one-shot call at all. */
export function oneShotRuntimeSupported(provider: ResolvedOneShotProvider): boolean {
  return provider.runtime === 'claude-agent-sdk' || provider.runtime === 'pi-agent-core';
}

/**
 * The caller's provider, read from the store once: its runtime, and for the
 * Claude runtime the SDK env and config built from that same record. Every
 * further read would open the store (and its secrets) again. Never throws: a
 * provider that cannot be resolved is `unavailable`.
 */
export function resolveOneShotProvider(input: {
  providerId?: string | null;
  providerScope?: ProviderScope;
  logLabel: string;
}): OneShotProvider {
  try {
    const svc = getProviderService();
    const {providerId, providerScope} = input;
    const provider = typeof providerId === 'string'
      ? svc.getRawProvider(providerId, providerScope)
      : providerId === null ? undefined : svc.getRawEffectiveProvider(providerScope);
    if (typeof providerId === 'string' && !provider) throw new Error(`Provider not found: ${providerId}`);
    const runtime = selectRuntimeForProvider(provider).kind;
    if (runtime !== 'claude-agent-sdk' && runtime !== 'pi-agent-core') return {kind: 'resolved', runtime};
    const providerEnv = provider ? svc.getEnvForProviderConfig(provider) : null;
    if (runtime === 'pi-agent-core') {
      return {kind: 'resolved', runtime, pi: {env: mergeIsolatedProviderEnv(process.env, providerEnv)}};
    }
    return {
      kind: 'resolved',
      runtime,
      claude: {
        env: sdkEnvForProviderEnv(providerEnv),
        config: runtimeConfigForProviderEnv(loadClaudeConfig(), providerEnv),
      },
    };
  } catch (error: unknown) {
    console.warn(`[${input.logLabel}] Provider resolution failed:`, error instanceof Error ? error.message : error);
    return {kind: 'unavailable'};
  }
}

/** Upper bound for a one-shot summary reply; summaries are short prose. */
const PI_ONE_SHOT_OUTPUT_BYTES = 64 * 1024;

export interface OneShotPiInput extends Omit<OneShotCallInput, 'tier' | 'effort'> {
  /** From `resolveOneShotProvider`; no further provider reads happen here. */
  pi: PiOneShotContext;
}

/**
 * One isolated, tool-free Pi call through the pinned provider runtime: the same
 * transport as Pi classification and review. The `review` purpose selects that
 * no-tool, minimal-reasoning policy; a one-shot call outside an analysis run
 * records no run telemetry. Pi has one configured model, so there is no light
 * tier. Never throws; the reason says what happened.
 */
export async function runIsolatedPiOneShot(input: OneShotPiInput): Promise<OneShotResult> {
  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected'};
  let config: ReturnType<typeof readPiAgentCoreModelConfig>;
  try {
    config = readPiAgentCoreModelConfig(input.pi.env);
  } catch (error: unknown) {
    console.warn(`[${input.logLabel}] Pi model configuration invalid:`, error instanceof Error ? error.message : error);
    return {ok: false, reason: 'failed'};
  }
  if (!config) return {ok: false, reason: 'credentials_missing'};
  const model = typeof config.model.id === 'string' ? config.model.id : undefined;
  const withModel = model ? {model} : {};
  try {
    const providerRuntime = await createPiAgentCoreProviderRuntime(config, input.pi.env);
    const result = await runPiIntentTransport({
      prompt: input.prompt,
      systemPrompt: '',
      signal: input.signal,
      deadlineMs: Date.now() + effectiveOneShotTimeoutMs(input.timeoutMs),
      outputByteLimit: PI_ONE_SHOT_OUTPUT_BYTES,
      providerRuntime,
      purpose: 'review',
    });
    if (result.status === 'ok') {
      return {ok: true, text: result.text.trim(), model: result.actualModel ?? model ?? providerRuntime.model.id};
    }
    if (result.reason === 'timeout') return {ok: false, reason: 'timed_out', ...withModel};
    console.warn(`[${input.logLabel}] Pi one-shot call unavailable: ${result.reason}`);
    return {ok: false, reason: 'failed', ...withModel};
  } catch (error: unknown) {
    if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected', ...withModel};
    console.warn(`[${input.logLabel}] Pi one-shot call failed:`, error instanceof Error ? error.message : error);
    return {ok: false, reason: 'failed', ...withModel};
  }
}

/** One isolated call on whichever runtime the provider resolved to. */
export async function runIsolatedOneShot(
  input: OneShotCallInput & {provider: ResolvedOneShotProvider},
): Promise<OneShotResult> {
  const {provider, ...call} = input;
  if (provider.runtime === 'claude-agent-sdk') return runIsolatedClaudeOneShot({...call, claude: provider.claude});
  if (provider.runtime === 'pi-agent-core') return runIsolatedPiOneShot({...call, pi: provider.pi});
  return {ok: false, reason: 'runtime_not_supported'};
}

/** Resolve the caller's provider once, then make one isolated call on its runtime. */
export async function runResolvedOneShot(
  input: OneShotCallInput & {providerScope?: ProviderScope},
): Promise<OneShotResult & {runtime?: ResolvedAgentRuntimeKind}> {
  const {providerScope, ...call} = input;
  const provider = resolveOneShotProvider({providerScope, logLabel: input.logLabel});
  if (provider.kind === 'unavailable') return {ok: false, reason: 'runtime_unavailable'};
  return {...await runIsolatedOneShot({...call, provider}), runtime: provider.runtime};
}

/** What falls back, named in its own warnings (e.g. "critical-path AI diagnosis"). */
export interface OneShotSummaryLabel {
  zh: string;
  en: string;
}

/** The localized explanation of one fallback reason. */
export function oneShotFallbackWarning(
  reason: OneShotFallbackReason,
  label: OneShotSummaryLabel,
  language: OutputLanguage,
  runtime = '',
): string {
  switch (reason) {
    case 'ai_disabled':
      return localize(
        language,
        `AI 已由 ${AI_CAPABILITY_ENV_KEY} 关闭，已返回规则兜底总结。`,
        `AI is disabled by ${AI_CAPABILITY_ENV_KEY}; a deterministic rule summary was returned.`,
      );
    case 'permission_denied':
      return localize(
        language,
        '当前账号没有运行 AI 分析的权限（agent:run），已返回规则兜底总结。',
        'This account may not run AI analysis (agent:run); a deterministic rule summary was returned.',
      );
    case 'runtime_not_supported':
      return localize(
        language,
        `当前 Provider 使用 ${runtime} 运行时，${label.zh}只支持 Pi Agent Core 和 Claude Agent SDK，已返回规则兜底总结。`,
        `The active provider uses the ${runtime} runtime; the ${label.en} supports only Pi Agent Core and the Claude Agent SDK, so a deterministic rule summary was returned.`,
      );
    case 'runtime_unavailable':
      return localize(
        language,
        '无法解析当前 AI Provider，已返回规则兜底总结。',
        'The active AI provider could not be resolved; a deterministic rule summary was returned.',
      );
    case 'credentials_missing':
      return localize(
        language,
        'AI 模型未配置，已返回规则兜底总结。',
        'No AI model is configured; a deterministic rule summary was returned.',
      );
    case 'client_disconnected':
      return localize(
        language,
        `客户端已断开，${label.zh}已取消。`,
        `The client disconnected, so the ${label.en} was cancelled.`,
      );
    case 'timed_out':
      return localize(
        language,
        `${label.zh}超时，已返回规则兜底总结。`,
        `The ${label.en} timed out; a deterministic rule summary was returned.`,
      );
    case 'failed':
      // The provider's own error text stays in the server log.
      return localize(
        language,
        `${label.zh}失败，已返回规则兜底总结。`,
        `The ${label.en} failed; a deterministic rule summary was returned.`,
      );
    case 'empty_response':
      return localize(
        language,
        'AI 没有返回有效内容，已返回规则兜底总结。',
        'The AI returned no valid content; a deterministic rule summary was returned.',
      );
  }
}

export interface OneShotSummaryInput {
  feature: AiCapabilityFeature;
  label: OneShotSummaryLabel;
  logLabel: string;
  outputLanguage: OutputLanguage;
  /** The deterministic summary; built only when no model answers. */
  ruleSummary: () => string;
  /** The model prompt, built only once every gate has passed; undefined: no template. */
  buildPrompt: () => {prompt: string; redactionApplied: boolean} | undefined;
  timeoutMs: number;
  tier?: 'main' | 'light';
  effort?: EffortLevel;
  /** Defaults to the process-wide `SMARTPERFETTO_AI_ENABLED` policy. */
  aiPolicy?: AiCapabilityPolicyV1;
  /** Whether the caller may start model work (`agent:run`); false never calls a model. */
  aiPermitted?: boolean;
  signal?: AbortSignal;
  providerScope?: ProviderScope;
}

/**
 * An optional model narrative with the deterministic summary as its fallback.
 * The operator switch, the caller's permission and cancellation are checked
 * before the provider is read; the provider is read once. Never throws for
 * policy, permission, provider or model failures.
 */
export async function runOneShotSummary(input: OneShotSummaryInput): Promise<AiSummary> {
  const degrade = (
    reason: OneShotFallbackReason,
    extra: Pick<AiSummary, 'model' | 'redactionApplied'> = {},
    runtime = '',
  ): AiSummary => ({
    generated: false,
    ...extra,
    summary: input.ruleSummary(),
    warnings: [oneShotFallbackWarning(reason, input.label, input.outputLanguage, runtime)],
    fallbackReason: reason,
  });

  if (!isAiFeatureEnabled(input.feature, input.aiPolicy ?? getAiCapabilityPolicy())) return degrade('ai_disabled');
  if (input.aiPermitted === false) return degrade('permission_denied');
  if (input.signal?.aborted) return degrade('client_disconnected');
  const provider = resolveOneShotProvider({providerScope: input.providerScope, logLabel: input.logLabel});
  if (provider.kind === 'unavailable') return degrade('runtime_unavailable');
  if (!oneShotRuntimeSupported(provider)) return degrade('runtime_not_supported', {}, provider.runtime);

  const built = input.buildPrompt();
  if (!built) return degrade('failed');
  const result = await runIsolatedOneShot({
    prompt: built.prompt,
    provider,
    tier: input.tier ?? 'main',
    effort: input.effort,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    logLabel: input.logLabel,
  });
  const attempted = {...(result.model ? {model: result.model} : {}), redactionApplied: built.redactionApplied};
  if (!result.ok) return degrade(result.reason, attempted);
  return {generated: true, ...attempted, model: result.model, summary: result.text, warnings: []};
}
