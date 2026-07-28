// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  clearProviderRuntimeEnv,
  mergeIsolatedProviderEnv,
  providerSubprocessEnv,
} from '../envIsolation';

describe('provider runtime environment isolation', () => {
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
      QODERCLI_PATH: '/qodercli',
      SMARTPERFETTO_QODER_SYSTEM_PROMPT: 'qoder prompt',
      UNRELATED_APPLICATION_VALUE: 'exclude',
    })).toEqual({
      PATH: '/usr/bin',
      QODER_MODEL: 'qoder-model',
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
});
