// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type EnvCredentialSourceStyle = 'health' | 'env';

const PLACEHOLDER_VALUES = new Set([
  'sk-ant-xxx',
  'sk-proxy-xxx',
  'xxx',
  'placeholder',
]);

function label(style: EnvCredentialSourceStyle, envName: string, healthName: string): string {
  return style === 'env' ? envName : healthName;
}

export function hasConcreteEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lower)) return false;
  if (lower.startsWith('your_')) return false;
  if (lower.startsWith('replace_with_')) return false;
  if (lower.startsWith('example_')) return false;
  if (/^<[^>]+>$/.test(trimmed)) return false;
  return true;
}

export function redactUrlForDiagnostics(value: string | undefined): string | undefined {
  if (!value || !hasConcreteEnvValue(value)) return undefined;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed
      .replace(/\/\/[^/@\s]+@/, '//')
      .replace(/[?#].*$/, '');
  }
}

export function isEnabledEnvFlag(value: string | undefined): boolean {
  if (!value || !hasConcreteEnvValue(value)) return false;
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function collectEnvCredentialSources(
  env: Record<string, string | undefined> = process.env,
  style: EnvCredentialSourceStyle = 'health',
): string[] {
  const sources: string[] = [];

  if (hasConcreteEnvValue(env.ANTHROPIC_API_KEY)) {
    sources.push(label(style, 'ANTHROPIC_API_KEY', 'anthropic_api_key'));
  }
  if (hasConcreteEnvValue(env.ANTHROPIC_AUTH_TOKEN)) {
    sources.push(label(style, 'ANTHROPIC_AUTH_TOKEN', 'anthropic_auth_token'));
  }
  if (hasConcreteEnvValue(env.ANTHROPIC_BASE_URL)) {
    sources.push(label(style, 'ANTHROPIC_BASE_URL', 'anthropic_base_url'));
  }
  if (hasConcreteEnvValue(env.OPENAI_API_KEY)) {
    sources.push(label(style, 'OPENAI_API_KEY', 'openai_api_key'));
  }
  if (hasConcreteEnvValue(env.OPENAI_BASE_URL)) {
    sources.push(label(style, 'OPENAI_BASE_URL', 'openai_base_url'));
  }
  if (hasConcreteEnvValue(env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON)) {
    sources.push(label(style, 'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON', 'pi_agent_core_model_json'));
  }
  if (hasConcreteEnvValue(env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH)) {
    sources.push(label(style, 'SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH', 'pi_agent_core_module_path'));
  }
  if (hasConcreteEnvValue(env.SMARTPERFETTO_OPENCODE_MODEL_JSON)) {
    sources.push(label(style, 'SMARTPERFETTO_OPENCODE_MODEL_JSON', 'opencode_model_json'));
  }
  if (hasConcreteEnvValue(env.SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH)) {
    sources.push(label(style, 'SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH', 'opencode_sdk_module_path'));
  }
  if (hasConcreteEnvValue(env.QODER_PERSONAL_ACCESS_TOKEN)) {
    sources.push(label(style, 'QODER_PERSONAL_ACCESS_TOKEN', 'qoder_personal_access_token'));
  }
  if (hasConcreteEnvValue(env.QODERCLI_PATH)) {
    sources.push(label(style, 'QODERCLI_PATH', 'qodercli_path'));
  }
  if (hasConcreteEnvValue(env.QODER_MODEL)) {
    sources.push(label(style, 'QODER_MODEL', 'qoder_model'));
  }

  if (isEnabledEnvFlag(env.CLAUDE_CODE_USE_BEDROCK)) {
    if (hasConcreteEnvValue(env.AWS_BEARER_TOKEN_BEDROCK)) {
      sources.push(label(style, 'AWS_BEARER_TOKEN_BEDROCK', 'aws_bedrock_bearer_token'));
    }
    if (hasConcreteEnvValue(env.AWS_ACCESS_KEY_ID) && hasConcreteEnvValue(env.AWS_SECRET_ACCESS_KEY)) {
      sources.push(label(style, 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY', 'aws_bedrock_iam_credentials'));
    }
    if (hasConcreteEnvValue(env.AWS_PROFILE)) {
      sources.push(label(style, 'AWS_PROFILE', 'aws_bedrock_profile'));
    }
    if (!sources.some(source => source.includes('AWS_') || source.startsWith('aws_bedrock'))) {
      sources.push(label(style, 'CLAUDE_CODE_USE_BEDROCK', 'aws_bedrock_enabled'));
    }
  }

  if (isEnabledEnvFlag(env.CLAUDE_CODE_USE_VERTEX)) {
    sources.push(label(style, 'CLAUDE_CODE_USE_VERTEX', 'google_vertex_enabled'));
    if (hasConcreteEnvValue(env.ANTHROPIC_VERTEX_PROJECT_ID)) {
      sources.push(label(style, 'ANTHROPIC_VERTEX_PROJECT_ID', 'google_vertex_project'));
    }
    if (hasConcreteEnvValue(env.CLOUD_ML_REGION)) {
      sources.push(label(style, 'CLOUD_ML_REGION', 'google_vertex_region'));
    }
  }

  return sources;
}
