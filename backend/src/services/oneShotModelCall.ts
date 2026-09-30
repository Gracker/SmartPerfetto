// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// One isolated, one-shot model call for the product's auxiliary summaries
// (critical-path, comparison conclusion, flamegraph). This module owns every
// safeguard they share:
//   - the AI capability gate, the caller's permission and cancellation, all
//     checked before the provider is read;
//   - one provider read for the caller's scope: runtime, SDK env and config
//     all come from that record;
//   - credentials checked in the resolved profile env, never raw process env;
//   - SDK options detached from user settings, tools, skills, plugins, MCP
//     servers and resumable transcripts (the classifier transport's options);
//   - one AbortController for caller cancellation and the wall-clock deadline,
//     `close()` on every exit, and a tool-use or refusal reply treated as a
//     failed call.
// Raw SDK error text goes to the log only; callers get a reason code.

import type {Options} from '@anthropic-ai/claude-agent-sdk';
import {claudeSdkQuery as sdkQuery} from '../agentRuntime/engines/claude/claudeSdkQuery';
import {selectRuntimeForProvider, type ResolvedAgentRuntimeKind} from '../agentRuntime/runtimeSelection';
import {claudeMessageHasToolUse} from '../agentRuntime/engines/claude/claudeSdkMessageGuards';
import {
  getSdkBinaryOption,
  hasClaudeCredentials,
  loadClaudeConfig,
  resolveClaudeSdkPermissionOptions,
  runtimeConfigForProviderEnv,
  sdkEnvForProviderEnv,
  type ClaudeAgentConfig,
  type EffortLevel,
} from '../agentv3/claudeConfig';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {AiSummary, AiSummaryFallbackReason} from '../types/criticalPathContract';
import {isPlainObject} from '../utils/llmJson';
import {
  AI_CAPABILITY_ENV_KEY,
  type AiCapabilityFeature,
  type AiCapabilityPolicyV1,
  getAiCapabilityPolicy,
  isAiFeatureEnabled,
} from './aiCapabilityPolicy';
import {getProviderService, type ProviderScope} from './providerManager';

/** Why a one-shot call produced no model answer. */
export type OneShotFallbackReason = AiSummaryFallbackReason;

/** The Claude SDK env and config of the resolved provider, read once. */
export interface ClaudeOneShotContext {
  env: Record<string, string | undefined>;
  config: ClaudeAgentConfig;
}

export type OneShotProvider =
  | {kind: 'unavailable'}
  | {kind: 'resolved'; runtime: ResolvedAgentRuntimeKind; claude?: ClaudeOneShotContext};

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
    if (runtime !== 'claude-agent-sdk') return {kind: 'resolved', runtime};
    const providerEnv = provider ? svc.getEnvForProviderConfig(provider) : null;
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

/**
 * SDK options for a one-shot call over untrusted, trace-derived text: one turn,
 * no tools, skills, plugins or MCP servers, no user settings, nothing persisted.
 */
export function isolatedClaudeOneShotOptions(input: {
  model: string;
  env: Record<string, string | undefined>;
  stderr: (data: string) => void;
  cwd?: string;
  effort?: EffortLevel;
  abortController?: AbortController;
}): Options {
  return {
    ...getSdkBinaryOption(input.env),
    model: input.model,
    ...(input.cwd ? {cwd: input.cwd} : {}),
    ...(input.effort ? {effort: input.effort} : {}),
    env: input.env,
    maxTurns: 1,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    skills: [],
    plugins: [],
    persistSession: false,
    ...resolveClaudeSdkPermissionOptions(),
    ...(input.abortController ? {abortController: input.abortController} : {}),
    stderr: input.stderr,
  };
}

export type OneShotClaudeResult =
  | {ok: true; text: string; model: string}
  | {ok: false; reason: OneShotFallbackReason; model?: string};

export interface OneShotClaudeInput {
  prompt: string;
  /** From `resolveOneShotProvider`; no further provider reads happen here. */
  claude: ClaudeOneShotContext;
  /** `light` uses the profile's light model and falls back to the main one. */
  tier: 'main' | 'light';
  effort?: EffortLevel;
  timeoutMs: number;
  signal?: AbortSignal;
  logLabel: string;
}

/**
 * One isolated Claude call with an already-resolved provider. Never throws for
 * model or cancellation failures; the reason says what happened.
 */
export async function runIsolatedClaudeOneShot(input: OneShotClaudeInput): Promise<OneShotClaudeResult> {
  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected'};
  const {env, config} = input.claude;
  const model = input.tier === 'light' ? (config.lightModel || config.model) : config.model;
  if (!hasClaudeCredentials(env)) return {ok: false, reason: 'credentials_missing', model};

  // One controller owns the SDK subprocess; the caller's cancellation and the
  // deadline both stop it through the same path.
  const abortController = new AbortController();
  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const stop = (): void => {
    abortController.abort();
    try {
      stream?.close();
    } catch {
      // ignore
    }
  };
  input.signal?.addEventListener('abort', stop, {once: true});
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 60_000);

  let text = '';
  let failed = false;
  try {
    stream = sdkQuery({
      prompt: input.prompt,
      options: isolatedClaudeOneShotOptions({
        model,
        env,
        cwd: config.cwd,
        effort: input.effort,
        abortController,
        stderr: (data: string) => console.warn(`[${input.logLabel}] SDK stderr: ${data.trimEnd()}`),
      }),
    });
    for await (const entry of stream) {
      if (abortController.signal.aborted) break;
      if (!isPlainObject(entry)) continue;
      const message = entry;
      if (claudeMessageHasToolUse(message) || (message.type === 'result' && message.stop_reason === 'tool_use')) {
        console.warn(`[${input.logLabel}] Model attempted a tool call in a tool-less one-shot call`);
        failed = true;
        break;
      }
      if (message.type === 'system'
        && (message.subtype === 'model_refusal_fallback' || message.subtype === 'model_refusal_no_fallback')) {
        failed = true;
        break;
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error === true || message.stop_reason === 'refusal') {
          failed = true;
          break;
        }
        text = typeof message.result === 'string' ? message.result : '';
      }
    }
  } catch (error: unknown) {
    if (!abortController.signal.aborted) {
      console.warn(`[${input.logLabel}] Model call failed:`, error);
      failed = true;
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', stop);
    try {
      stream?.close();
    } catch {
      // ignore
    }
  }

  if (input.signal?.aborted) return {ok: false, reason: 'client_disconnected', model};
  if (timedOut) return {ok: false, reason: 'timed_out', model};
  if (failed) return {ok: false, reason: 'failed', model};
  if (!text.trim()) return {ok: false, reason: 'empty_response', model};
  return {ok: true, text: text.trim(), model};
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
        `当前 Provider 使用 ${runtime} 运行时，${label.zh}只支持 Claude Agent SDK，已返回规则兜底总结。`,
        `The active provider uses the ${runtime} runtime; the ${label.en} supports only the Claude Agent SDK, so a deterministic rule summary was returned.`,
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
  if (!provider.claude) return degrade('runtime_not_supported', {}, provider.runtime);

  const built = input.buildPrompt();
  if (!built) return degrade('failed');
  const result = await runIsolatedClaudeOneShot({
    prompt: built.prompt,
    claude: provider.claude,
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
