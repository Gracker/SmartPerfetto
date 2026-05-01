// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SceneType } from './sceneClassifier';
import { getRegisteredScenes } from './strategyLoader';
import { DEFAULT_OUTPUT_LANGUAGE, outputLanguageDisplayName, parseOutputLanguage, type OutputLanguage } from './outputLanguage';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface ClaudeAgentConfig {
  model: string;
  /** Lightweight model for auxiliary single-turn calls (verifier, classifier, summarizer).
   *  When using a third-party proxy that maps only one model, set CLAUDE_LIGHT_MODEL
   *  to the same value as CLAUDE_MODEL so all SDK calls route to the same endpoint. */
  lightModel: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  cwd: string;
  effort: EffortLevel;
  /** Enable sub-agent delegation (frame-expert, system-expert, startup-expert). Default: false */
  enableSubAgents: boolean;
  /** Enable conclusion verification (heuristic + LLM). Default: false */
  enableVerification: boolean;
  /** Per sub-agent timeout in ms. Sub-agents exceeding this are stopped via stopTask(). Default: 120000 (2min) */
  subAgentTimeoutMs: number;
  /** Sub-agent model shorthand. Defaults to 'sonnet'.
   *  Accepted values: 'haiku' | 'sonnet' | 'opus' | 'inherit' (inherit orchestrator model). */
  subAgentModel?: 'inherit' | 'haiku' | 'sonnet' | 'opus';
  /** Per-turn timeout (ms) for the full analysis pipeline. Default: 60_000 (60s/turn).
   *  Raise via CLAUDE_FULL_PER_TURN_MS for slower LLMs (DeepSeek / Ollama / GLM). */
  fullPathPerTurnMs: number;
  /** Per-turn timeout (ms) for the quick analysis pipeline. Default: 40_000 (40s/turn).
   *  Override via CLAUDE_QUICK_PER_TURN_MS. */
  quickPathPerTurnMs: number;
  /** Timeout (ms) for the single-turn verifier LLM call. Default: 60_000.
   *  Override via CLAUDE_VERIFIER_TIMEOUT_MS (raise when CLAUDE_LIGHT_MODEL is not Haiku). */
  verifierTimeoutMs: number;
  /** Timeout (ms) for the single-turn query complexity classifier. Default: 30_000.
   *  Override via CLAUDE_CLASSIFIER_TIMEOUT_MS. */
  classifierTimeoutMs: number;
  /** User-facing output language. Default: zh-CN. Override via SMARTPERFETTO_OUTPUT_LANGUAGE=en. */
  outputLanguage: OutputLanguage;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_LIGHT_MODEL = 'claude-haiku-4-5';
// Scrolling pipeline: 1 time-range + 1 scrolling_analysis + 2-3 deep-drill (blocking_chain/binder_root_cause)
// + 1-2 jank_frame_detail + hypothesis submit/resolve + conclusion = ~20-25 turns.
// Default keeps extra headroom for slower third-party models and larger traces.
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_QUICK_MAX_TURNS = 10;
const DEFAULT_EFFORT: EffortLevel = 'high';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadClaudeConfig(overrides?: Partial<ClaudeAgentConfig>): ClaudeAgentConfig {
  return {
    model: overrides?.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,
    lightModel: process.env.CLAUDE_LIGHT_MODEL ?? DEFAULT_LIGHT_MODEL,
    maxTurns: overrides?.maxTurns
      ?? (process.env.CLAUDE_MAX_TURNS ? parseInt(process.env.CLAUDE_MAX_TURNS, 10) : DEFAULT_MAX_TURNS),
    maxBudgetUsd: overrides?.maxBudgetUsd
      ?? (process.env.CLAUDE_MAX_BUDGET_USD ? parseFloat(process.env.CLAUDE_MAX_BUDGET_USD) : undefined),
    cwd: overrides?.cwd ?? process.env.CLAUDE_CWD ?? process.cwd(),
    effort: (overrides?.effort ?? process.env.CLAUDE_EFFORT ?? DEFAULT_EFFORT) as EffortLevel,
    enableSubAgents: overrides?.enableSubAgents ?? process.env.CLAUDE_ENABLE_SUB_AGENTS === 'true',
    enableVerification: overrides?.enableVerification ?? (process.env.CLAUDE_ENABLE_VERIFICATION !== 'false'),
    subAgentTimeoutMs: overrides?.subAgentTimeoutMs
      ?? (process.env.CLAUDE_SUB_AGENT_TIMEOUT_MS ? parseInt(process.env.CLAUDE_SUB_AGENT_TIMEOUT_MS, 10) : 120_000),
    subAgentModel: (process.env.CLAUDE_SUB_AGENT_MODEL as ClaudeAgentConfig['subAgentModel']) || undefined,
    fullPathPerTurnMs: overrides?.fullPathPerTurnMs
      ?? (process.env.CLAUDE_FULL_PER_TURN_MS ? parseInt(process.env.CLAUDE_FULL_PER_TURN_MS, 10) : 60_000),
    quickPathPerTurnMs: overrides?.quickPathPerTurnMs
      ?? (process.env.CLAUDE_QUICK_PER_TURN_MS ? parseInt(process.env.CLAUDE_QUICK_PER_TURN_MS, 10) : 40_000),
    verifierTimeoutMs: overrides?.verifierTimeoutMs
      ?? (process.env.CLAUDE_VERIFIER_TIMEOUT_MS ? parseInt(process.env.CLAUDE_VERIFIER_TIMEOUT_MS, 10) : 60_000),
    classifierTimeoutMs: overrides?.classifierTimeoutMs
      ?? (process.env.CLAUDE_CLASSIFIER_TIMEOUT_MS ? parseInt(process.env.CLAUDE_CLASSIFIER_TIMEOUT_MS, 10) : 30_000),
    outputLanguage: overrides?.outputLanguage
      ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
  };
}

/**
 * Resolve effort level by scene type.
 * Deterministic pipelines (scrolling/startup/anr) use 'medium' since the workflow is prescriptive.
 * Open-ended queries ('general') use the configured default (typically 'high').
 */
export function resolveEffort(config: ClaudeAgentConfig, sceneType?: SceneType): EffortLevel {
  // Env override always wins (read directly, not via config which may have overrides)
  if (process.env.CLAUDE_EFFORT) return process.env.CLAUDE_EFFORT as EffortLevel;
  if (!sceneType) return config.effort;

  const scenes = getRegisteredScenes();
  const scene = scenes.find(s => s.scene === sceneType);
  if (scene?.effort) return scene.effort as EffortLevel;
  return config.effort;
}

export interface BedrockStatus {
  enabled: boolean;
  hasAuth: boolean;
  authMethod?: 'bearer_token' | 'iam_credentials' | 'profile_or_chain';
  region: string;
  baseUrl?: string;
  missing?: string[];
}

/**
 * Detects whether AWS Bedrock is configured and whether its authentication
 * credentials are complete. Supports three auth paths:
 *   1. Bearer token: AWS_BEARER_TOKEN_BEDROCK
 *   2. IAM credentials: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN)
 *   3. AWS profile / default credential chain: AWS_PROFILE or implicit chain resolution
 */
export function detectBedrock(): BedrockStatus {
  const enabled = Boolean(process.env.CLAUDE_CODE_USE_BEDROCK);
  if (!enabled) return { enabled: false, hasAuth: false, region: 'us-east-1' };

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const baseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL || undefined;

  if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
    return { enabled: true, hasAuth: true, authMethod: 'bearer_token', region, baseUrl };
  }

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return { enabled: true, hasAuth: true, authMethod: 'iam_credentials', region, baseUrl };
  }

  if (process.env.AWS_PROFILE) {
    return { enabled: true, hasAuth: true, authMethod: 'profile_or_chain', region, baseUrl };
  }

  // CLAUDE_CODE_USE_BEDROCK is set but no explicit credentials found.
  // The SDK will still attempt the default AWS credential chain (EC2 metadata,
  // ECS task role, ~/.aws/credentials, etc.), so we treat this as potentially valid.
  const missing: string[] = [];
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) missing.push('AWS_BEARER_TOKEN_BEDROCK');
  if (!process.env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID');
  if (!process.env.AWS_PROFILE) missing.push('AWS_PROFILE');

  return {
    enabled: true,
    hasAuth: true,
    authMethod: 'profile_or_chain',
    region,
    baseUrl,
    missing,
  };
}

/**
 * Returns true when any supported Claude credential source is present:
 * direct API key, proxy base URL, or AWS Bedrock.
 */
export function hasClaudeCredentials(): boolean {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_BASE_URL ||
    detectBedrock().enabled
  );
}

export function getClaudeRuntimeDiagnostics() {
  const bedrock = detectBedrock();
  const credentialSources: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) credentialSources.push('anthropic_api_key');
  if (process.env.ANTHROPIC_BASE_URL) credentialSources.push('anthropic_compatible_proxy');
  if (bedrock.enabled) credentialSources.push(`bedrock:${bedrock.authMethod}`);

  const providerMode = process.env.ANTHROPIC_BASE_URL
    ? 'anthropic_compatible_proxy'
    : bedrock.enabled
      ? 'aws_bedrock'
      : process.env.ANTHROPIC_API_KEY
        ? 'anthropic_direct'
        : 'unconfigured';

  return {
    runtime: 'claude-agent-sdk',
    providerMode,
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    lightModel: process.env.CLAUDE_LIGHT_MODEL || DEFAULT_LIGHT_MODEL,
    outputLanguage: {
      value: parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE),
      displayName: outputLanguageDisplayName(parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE)),
      env: 'SMARTPERFETTO_OUTPUT_LANGUAGE',
      default: DEFAULT_OUTPUT_LANGUAGE,
    },
    configured: hasClaudeCredentials(),
    credentialSources,
    baseUrlConfigured: !!process.env.ANTHROPIC_BASE_URL,
    bedrock: {
      enabled: bedrock.enabled,
      authMethod: bedrock.authMethod,
      region: bedrock.region,
      baseUrlConfigured: !!bedrock.baseUrl,
    },
    configHint: process.env.ANTHROPIC_BASE_URL
      ? 'Using Anthropic-compatible proxy. Ensure the mapped model supports streaming and tool/function calling.'
      : 'Set ANTHROPIC_API_KEY for Anthropic direct access, or ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY for a third-party Anthropic-compatible proxy.',
  };
}

export function explainClaudeRuntimeError(message: string): string {
  const lower = message.toLowerCase();
  const quotaOrAuth =
    lower.includes('out of') ||
    lower.includes('extra usage') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('not logged in') ||
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('process exited with code 1');

  if (!quotaOrAuth) return message;

  return `${message}\n\n` +
    'SmartPerfetto is currently using the Claude Agent SDK runtime. ' +
    'If your Claude subscription/API quota is unavailable, configure an Anthropic-compatible proxy instead: ' +
    'set ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_MODEL, and CLAUDE_LIGHT_MODEL in backend/.env, then restart the backend. ' +
    'Provider switchers such as CC Switch manage Claude Code/Codex/Gemini CLI configs, but SmartPerfetto does not automatically read Codex CLI or Gemini CLI credentials.';
}

/**
 * Check if ClaudeRuntime (agentv3) is the active orchestrator.
 * Defaults to true — agentv2 is deprecated. Set AI_SERVICE=deepseek to use legacy path.
 */
export function isClaudeCodeEnabled(): boolean {
  const service = process.env.AI_SERVICE;
  // Default to claude-code when AI_SERVICE is not set
  if (!service) return true;
  if (service === 'claude-code') return true;
  // Legacy path — log deprecation warning once
  if (!isClaudeCodeEnabled._warned) {
    isClaudeCodeEnabled._warned = true;
    console.warn(`[ClaudeConfig] AI_SERVICE="${service}" uses deprecated agentv2 runtime. Migrate to AI_SERVICE=claude-code.`);
  }
  return false;
}
isClaudeCodeEnabled._warned = false;

/**
 * Create a lightweight config for quick (factual) queries.
 * Reduces maxTurns, effort, and disables verification/sub-agents
 * to optimize for fast response on simple questions.
 */
export function createQuickConfig(baseConfig: ClaudeAgentConfig): ClaudeAgentConfig {
  return {
    ...baseConfig,
    maxTurns: parsePositiveIntEnv('CLAUDE_QUICK_MAX_TURNS', DEFAULT_QUICK_MAX_TURNS),
    effort: 'low',
    enableVerification: false,
    enableSubAgents: false,
  };
}

/**
 * Create a sanitized copy of process.env for SDK subprocess spawning.
 * When a providerId is given, overlays that provider's env vars.
 * When no providerId is given, uses the active provider from providerManager.
 * Falls back to raw process.env when no provider is configured.
 */
export function createSdkEnv(sessionOverrideProviderId?: string): Record<string, string | undefined> {
  const env = { ...process.env };

  // Lazy import to avoid circular dependency at module load time
  const { getProviderService } = require('../services/providerManager');
  const svc = getProviderService();

  const providerEnv = sessionOverrideProviderId
    ? svc.getEnvForProvider(sessionOverrideProviderId)
    : svc.getEffectiveEnv();

  if (sessionOverrideProviderId && !providerEnv) {
    console.warn(`[createSdkEnv] Provider ${sessionOverrideProviderId} not found, falling back to env`);
  }
  if (providerEnv) Object.assign(env, providerEnv);

  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  return env;
}

/**
 * Resolve the effective ClaudeAgentConfig based on the active provider or session override.
 * Unlike loadClaudeConfig() which only reads process.env at construction time,
 * this reads the currently active provider's env vars at call time.
 */
export function resolveRuntimeConfig(baseConfig: ClaudeAgentConfig, providerId?: string): ClaudeAgentConfig {
  // Lazy import to avoid circular dependency
  const { getProviderService } = require('../services/providerManager');
  const svc = getProviderService();

  const providerEnv = providerId
    ? svc.getEnvForProvider(providerId)
    : svc.getEffectiveEnv();

  if (!providerEnv) return baseConfig;

  return {
    ...baseConfig,
    model: providerEnv.CLAUDE_MODEL || baseConfig.model,
    lightModel: providerEnv.CLAUDE_LIGHT_MODEL || baseConfig.lightModel,
    maxTurns: providerEnv.CLAUDE_MAX_TURNS
      ? parseInt(providerEnv.CLAUDE_MAX_TURNS, 10) : baseConfig.maxTurns,
    maxBudgetUsd: providerEnv.CLAUDE_MAX_BUDGET_USD
      ? parseFloat(providerEnv.CLAUDE_MAX_BUDGET_USD) : baseConfig.maxBudgetUsd,
    effort: (providerEnv.CLAUDE_EFFORT || baseConfig.effort) as EffortLevel,
    enableSubAgents: providerEnv.CLAUDE_ENABLE_SUB_AGENTS
      ? providerEnv.CLAUDE_ENABLE_SUB_AGENTS === 'true' : baseConfig.enableSubAgents,
    enableVerification: providerEnv.CLAUDE_ENABLE_VERIFICATION !== undefined
      ? providerEnv.CLAUDE_ENABLE_VERIFICATION !== 'false' : baseConfig.enableVerification,
    fullPathPerTurnMs: providerEnv.CLAUDE_FULL_PER_TURN_MS
      ? parseInt(providerEnv.CLAUDE_FULL_PER_TURN_MS, 10) : baseConfig.fullPathPerTurnMs,
    quickPathPerTurnMs: providerEnv.CLAUDE_QUICK_PER_TURN_MS
      ? parseInt(providerEnv.CLAUDE_QUICK_PER_TURN_MS, 10) : baseConfig.quickPathPerTurnMs,
    verifierTimeoutMs: providerEnv.CLAUDE_VERIFIER_TIMEOUT_MS
      ? parseInt(providerEnv.CLAUDE_VERIFIER_TIMEOUT_MS, 10) : baseConfig.verifierTimeoutMs,
    classifierTimeoutMs: providerEnv.CLAUDE_CLASSIFIER_TIMEOUT_MS
      ? parseInt(providerEnv.CLAUDE_CLASSIFIER_TIMEOUT_MS, 10) : baseConfig.classifierTimeoutMs,
    subAgentModel: (providerEnv.CLAUDE_SUB_AGENT_MODEL as ClaudeAgentConfig['subAgentModel'])
      || baseConfig.subAgentModel,
  };
}
