// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { collectEnvCredentialSources, hasConcreteEnvValue, isEnabledEnvFlag } from '../envCredentialSources';

describe('env credential source detection', () => {
  it('ignores documented placeholder values', () => {
    expect(hasConcreteEnvValue('your_deepseek_api_key_here')).toBe(false);
    expect(hasConcreteEnvValue('replace_with_a_strong_random_secret')).toBe(false);
    expect(hasConcreteEnvValue('sk-ant-xxx')).toBe(false);
    expect(hasConcreteEnvValue('sk-proxy-xxx')).toBe(false);
    expect(hasConcreteEnvValue('sk-real-value')).toBe(true);
  });

  it('collects only concrete runtime credential sources', () => {
    const sources = collectEnvCredentialSources({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'your_deepseek_api_key_here',
      OPENAI_API_KEY: 'sk-real-openai',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"modelID":"opencode-test"}',
      CLAUDE_CODE_USE_BEDROCK: 'false',
    }, 'env');

    expect(sources).toEqual([
      'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY',
      'SMARTPERFETTO_OPENCODE_MODEL_JSON',
    ]);
  });

  it('requires explicit true-like cloud flags', () => {
    expect(isEnabledEnvFlag('1')).toBe(true);
    expect(isEnabledEnvFlag('true')).toBe(true);
    expect(isEnabledEnvFlag('false')).toBe(false);
    expect(isEnabledEnvFlag('your_flag_here')).toBe(false);

    expect(collectEnvCredentialSources({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'prod',
      CLAUDE_CODE_USE_VERTEX: 'true',
      ANTHROPIC_VERTEX_PROJECT_ID: 'gcp-project',
      CLOUD_ML_REGION: 'us-central1',
    }, 'health')).toEqual([
      'aws_bedrock_profile',
      'google_vertex_enabled',
      'google_vertex_project',
      'google_vertex_region',
    ]);
  });

  it('reports Qoder BYOK credential source names without returning their values', () => {
    const sources = collectEnvCredentialSources({
      QODER_BYOK_API_KEY: 'deepseek-provider-secret',
      QODER_BYOK_PROVIDER: 'deepseek',
      QODER_BYOK_BASE_URL: 'https://api.deepseek.com/v1',
      QODER_BYOK_STYLE: 'openai',
      SMARTPERFETTO_QODER_SDK_MODULE_PATH: '/opt/qoder-sdk/index.js',
    }, 'env');

    expect(sources).toEqual([
      'QODER_BYOK_API_KEY',
      'QODER_BYOK_PROVIDER',
      'QODER_BYOK_BASE_URL',
      'QODER_BYOK_STYLE',
      'SMARTPERFETTO_QODER_SDK_MODULE_PATH',
    ]);
    expect(JSON.stringify(sources)).not.toContain('deepseek-provider-secret');
  });
});
