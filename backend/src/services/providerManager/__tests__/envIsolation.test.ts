// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  clearProviderRuntimeEnv,
  isQoderByokEnvKey,
  mergeIsolatedProviderEnv,
  providerSubprocessEnv,
} from '../envIsolation';

describe('provider runtime environment isolation', () => {
  it('recognizes only the supported Qoder BYOK values as provider-scoped overrides', () => {
    expect([
      'QODER_BYOK_API_KEY',
      'QODER_BYOK_PROVIDER',
      'QODER_BYOK_BASE_URL',
      'QODER_BYOK_STYLE',
    ].every(isQoderByokEnvKey)).toBe(true);
    expect(isQoderByokEnvKey('QODERCLI_PATH')).toBe(false);
    expect(isQoderByokEnvKey('SMARTPERFETTO_QODER_SDK_MODULE_PATH')).toBe(false);
    expect(isQoderByokEnvKey('QODER_WORKER_RUNTIME_PATH')).toBe(false);
  });

  it('clears every runtime family, including Qoder, without touching system env', () => {
    const env: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      UNRELATED_APPLICATION_VALUE: 'keep',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
      SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH: '/pi.mjs',
      SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH: '/opencode.mjs',
      QODER_PERSONAL_ACCESS_TOKEN: 'qoder-secret',
      QODERCLI_PATH: '/qodercli',
      SMARTPERFETTO_QODER_SYSTEM_PROMPT: 'qoder prompt',
      SMARTPERFETTO_AGENT_RUNTIME: 'qoder-agent-sdk',
    };

    clearProviderRuntimeEnv(env);
    expect(env).toEqual({
      PATH: '/usr/bin',
      UNRELATED_APPLICATION_VALUE: 'keep',
    });
  });

  it('passes Qoder runtime inputs to provider subprocesses but excludes unrelated values', () => {
    expect(providerSubprocessEnv({
      PATH: '/usr/bin',
      QODER_MODEL: 'qoder-model',
      QODER_BYOK_API_KEY: 'qoder-byok-secret',
      QODER_BYOK_PROVIDER: 'deepseek',
      QODERCLI_PATH: '/qodercli',
      SMARTPERFETTO_QODER_SYSTEM_PROMPT: 'qoder prompt',
      UNRELATED_APPLICATION_VALUE: 'exclude',
    })).toEqual({
      PATH: '/usr/bin',
      QODER_MODEL: 'qoder-model',
      QODER_BYOK_PROVIDER: 'deepseek',
      QODERCLI_PATH: '/qodercli',
      SMARTPERFETTO_QODER_SYSTEM_PROMPT: 'qoder prompt',
    });
  });

  it('does not let ambient Qoder values leak into a managed provider snapshot env', () => {
    expect(mergeIsolatedProviderEnv({
      PATH: '/usr/bin',
      QODER_MODEL: 'ambient-model',
      QODER_WORKER_RUNTIME_PATH: '/ambient-worker.mjs',
      QODER_PERSONAL_ACCESS_TOKEN: 'ambient-secret',
    }, {
      SMARTPERFETTO_AGENT_RUNTIME: 'qoder-agent-sdk',
      QODER_MODEL: 'managed-model',
    })).toEqual({
      PATH: '/usr/bin',
      SMARTPERFETTO_AGENT_RUNTIME: 'qoder-agent-sdk',
      QODER_MODEL: 'managed-model',
    });
  });

  it('does not let ambient Pi provider credentials leak into a managed provider env', () => {
    expect(mergeIsolatedProviderEnv({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'ambient-deepseek',
      OPENROUTER_API_KEY: 'ambient-openrouter',
      MISTRAL_API_KEY: 'ambient-mistral',
      GEMINI_API_KEY: 'ambient-gemini',
      GOOGLE_APPLICATION_CREDENTIALS: '/ambient/google.json',
      AZURE_OPENAI_API_KEY: 'ambient-azure',
      HF_TOKEN: 'ambient-hugging-face',
    }, {
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"managed"}',
      DEEPSEEK_API_KEY: 'managed-deepseek',
    })).toEqual({
      PATH: '/usr/bin',
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"managed"}',
      DEEPSEEK_API_KEY: 'managed-deepseek',
    });
  });

  it('preserves a Claude Vertex service-account file while clearing Pi-only credentials', () => {
    expect(mergeIsolatedProviderEnv({
      PATH: '/usr/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/selected/vertex-service-account.json',
      DEEPSEEK_API_KEY: 'ambient-pi-secret',
      OPENROUTER_API_KEY: 'ambient-pi-secret',
    }, {
      SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'selected-project',
      CLOUD_ML_REGION: 'us-central1',
    })).toEqual({
      PATH: '/usr/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/selected/vertex-service-account.json',
      SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'selected-project',
      CLOUD_ML_REGION: 'us-central1',
    });
  });

  it('keeps Pi and Claude Vertex switches isolated without dropping shared system auth', () => {
    const baseEnv = {
      PATH: '/usr/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/selected/vertex-service-account.json',
      DEEPSEEK_API_KEY: 'ambient-pi-secret',
    };
    const piEnv = mergeIsolatedProviderEnv(baseEnv, {
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"managed"}',
      DEEPSEEK_API_KEY: 'selected-pi-secret',
    });
    expect(piEnv.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(piEnv.DEEPSEEK_API_KEY).toBe('selected-pi-secret');

    const vertexEnv = mergeIsolatedProviderEnv(baseEnv, {
      SMARTPERFETTO_AGENT_RUNTIME: 'claude-agent-sdk',
      CLAUDE_CODE_USE_VERTEX: '1',
    });
    expect(vertexEnv.GOOGLE_APPLICATION_CREDENTIALS)
      .toBe('/selected/vertex-service-account.json');
    expect(vertexEnv.DEEPSEEK_API_KEY).toBeUndefined();
  });
});
