// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {parseFlagValue} from '../utils/envFlag';

export const AI_CAPABILITY_ENV_KEY = 'SMARTPERFETTO_AI_ENABLED' as const;

export type AiCapabilityFeature =
  | 'trace_upload'
  | 'execute_sql'
  | 'invoke_deterministic_skill'
  | 'capture_config'
  | 'capture_android'
  | 'report_read'
  | 'provider_config_read'
  | 'provider_config_write'
  | 'provider_switch'
  | 'agent_analyze'
  | 'agent_resume'
  | 'scene_reconstruct_start'
  | 'provider_test'
  | 'cli_provider_test'
  | 'capture_analyze'
  | 'llm_skill_step'
  | 'critical_path_ai_summary'
  | 'comparison_ai_conclusion'
  | 'flamegraph_ai_summary';

export interface AiCapabilityPolicyV1 {
  schemaVersion: 1;
  aiEnabled: boolean;
  source: 'env' | 'system_default';
  disabledReason?: string;
  env?: {
    key: typeof AI_CAPABILITY_ENV_KEY;
    rawValue?: string;
    valid: boolean;
  };
  allowedDeterministicFeatures: AiCapabilityFeature[];
  blockedFeatures: AiCapabilityFeature[];
  blockingError?: {
    code: 'AI_DISABLED';
    message: string;
    retryable: false;
  };
}

export const AI_CAPABILITY_ALLOWED_DETERMINISTIC_FEATURES: readonly AiCapabilityFeature[] = [
  'trace_upload',
  'execute_sql',
  'invoke_deterministic_skill',
  'capture_config',
  'capture_android',
  'report_read',
  'provider_config_read',
  'provider_config_write',
  'provider_switch',
] as const;

export const AI_CAPABILITY_BLOCKED_FEATURES: readonly AiCapabilityFeature[] = [
  'agent_analyze',
  'agent_resume',
  'scene_reconstruct_start',
  'provider_test',
  'cli_provider_test',
  'capture_analyze',
  'llm_skill_step',
  'critical_path_ai_summary',
  'comparison_ai_conclusion',
  'flamegraph_ai_summary',
] as const;

export class AiDisabledError extends Error {
  readonly code = 'AI_DISABLED';
  readonly retryable = false;
  readonly feature: AiCapabilityFeature;
  readonly policy: AiCapabilityPolicyV1;

  constructor(feature: AiCapabilityFeature, policy: AiCapabilityPolicyV1) {
    super(policy.blockingError?.message ?? buildAiDisabledMessage(feature, policy));
    this.name = 'AiDisabledError';
    this.feature = feature;
    this.policy = policy;
  }
}

export function resolveAiCapabilityPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): AiCapabilityPolicyV1 {
  const rawValue = env[AI_CAPABILITY_ENV_KEY];
  if (rawValue === undefined) {
    return {
      schemaVersion: 1,
      aiEnabled: true,
      source: 'system_default',
      allowedDeterministicFeatures: [...AI_CAPABILITY_ALLOWED_DETERMINISTIC_FEATURES],
      blockedFeatures: [],
    };
  }

  const parsed = parseFlagValue(rawValue);

  if (parsed === true) {
    return {
      schemaVersion: 1,
      aiEnabled: true,
      source: 'env',
      env: {
        key: AI_CAPABILITY_ENV_KEY,
        rawValue,
        valid: true,
      },
      allowedDeterministicFeatures: [...AI_CAPABILITY_ALLOWED_DETERMINISTIC_FEATURES],
      blockedFeatures: [],
    };
  }

  if (parsed === false) {
    const policy = buildDisabledPolicy(rawValue, true, `AI is disabled by ${AI_CAPABILITY_ENV_KEY}=${rawValue}`);
    return policy;
  }

  return buildDisabledPolicy(
    rawValue,
    false,
    `AI is disabled because ${AI_CAPABILITY_ENV_KEY} has invalid value "${rawValue}". Use true/false, yes/no, on/off, enabled/disabled, or 1/0.`,
  );
}

export function getAiCapabilityPolicy(): AiCapabilityPolicyV1 {
  return resolveAiCapabilityPolicy(process.env);
}

export function isAiFeatureEnabled(feature: AiCapabilityFeature, policy = getAiCapabilityPolicy()): boolean {
  return policy.aiEnabled || !policy.blockedFeatures.includes(feature);
}

export function assertAiFeatureEnabled(feature: AiCapabilityFeature, policy = getAiCapabilityPolicy()): void {
  if (!isAiFeatureEnabled(feature, policy)) {
    throw new AiDisabledError(feature, policy);
  }
}

export function buildAiDisabledPayload(error: AiDisabledError): {
  success: false;
  code: 'AI_DISABLED';
  error: string;
  message: string;
  retryable: false;
  feature: AiCapabilityFeature;
  aiPolicy: AiCapabilityPolicyV1;
} {
  return {
    success: false,
    code: 'AI_DISABLED',
    error: error.message,
    message: error.message,
    retryable: false,
    feature: error.feature,
    aiPolicy: error.policy,
  };
}

function buildDisabledPolicy(
  rawValue: string,
  valid: boolean,
  disabledReason: string,
): AiCapabilityPolicyV1 {
  return {
    schemaVersion: 1,
    aiEnabled: false,
    source: 'env',
    disabledReason,
    env: {
      key: AI_CAPABILITY_ENV_KEY,
      rawValue,
      valid,
    },
    allowedDeterministicFeatures: [...AI_CAPABILITY_ALLOWED_DETERMINISTIC_FEATURES],
    blockedFeatures: [...AI_CAPABILITY_BLOCKED_FEATURES],
    blockingError: {
      code: 'AI_DISABLED',
      message: disabledReason,
      retryable: false,
    },
  };
}

function buildAiDisabledMessage(feature: AiCapabilityFeature, policy: AiCapabilityPolicyV1): string {
  const reason = policy.disabledReason ? ` ${policy.disabledReason}` : '';
  return `AI feature "${feature}" is disabled.${reason}`;
}
