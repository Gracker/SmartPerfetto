// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const mockGetEnvForProvider = jest.fn((_id: string, _scope?: unknown): Record<string, string> | null => null);
jest.mock('../../services/providerManager', () => ({
  ...(jest.requireActual('../../services/providerManager') as object),
  getProviderService: () => ({getEnvForProvider: mockGetEnvForProvider}),
}));

import {
  asRuntimeDiagnosticsPayload,
  getRuntimeDiagnosticModel,
  getRuntimeDiagnosticProviderMode,
  getRuntimeDiagnostics,
} from '../runtimeDiagnostics';

describe('runtime diagnostics resolver', () => {
  it('resolves public Pi diagnostics through the shared diagnostics path', () => {
    const diagnostics = getRuntimeDiagnostics({
      kind: 'pi-agent-core',
      source: 'env',
    }, {
      env: {
        SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"pi-test","provider":"test"}',
      },
    });

    expect(diagnostics).toMatchObject({
      runtime: 'pi-agent-core',
      configured: true,
      experimental: false,
      modelConfigured: true,
    });
  });

  it('reads a Pi provider selection from that provider env, not the process env', () => {
    mockGetEnvForProvider.mockReturnValueOnce({
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"catalog":{"providers":["deepseek"],"id":"deepseek-flash"}}',
    });
    const diagnostics = getRuntimeDiagnostics({kind: 'pi-agent-core', source: 'provider', providerId: 'deepseek-pi'},
      {env: {}});

    expect(mockGetEnvForProvider).toHaveBeenCalledWith('deepseek-pi', undefined);
    expect(diagnostics).toMatchObject({runtime: 'pi-agent-core', configured: true, modelConfigured: true});
  });

  it('resolves hidden experimental diagnostics without exposing them as production descriptors', () => {
    const diagnostics = getRuntimeDiagnostics({
      kind: 'experimental-opencode',
      source: 'env',
    }, {
      env: {
        SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH: '/tmp/opencode-sdk.js',
      },
    });

    expect(diagnostics).toMatchObject({
      runtime: 'experimental-opencode',
      configured: false,
      experimental: true,
      modulePath: '/tmp/opencode-sdk.js',
    });
  });

  it.each(['claude-agent-sdk', 'openai-agents-sdk', 'pi-agent-core', 'opencode'])(
    'offers surface-neutral setup for unconfigured runtimes (%s)', (runtime) => {
      const diagnostics = asRuntimeDiagnosticsPayload({
        runtime, configured: false, configHint: 'Runtime-specific requirement',
      }, runtime, {SMARTPERFETTO_OUTPUT_LANGUAGE: 'en'});
      expect(diagnostics.configHint).toContain('Use the configuration entry point for the process');
      expect(diagnostics.configHint).toContain('Providers');
      expect(diagnostics.configHint).toContain('Runtime-specific requirement');
      const hint = String(diagnostics.configHint);
      expect(hint.indexOf('Providers')).toBeLessThan(hint.indexOf('backend/.env'));
      expect(hint).toContain('~/.smartperfetto/runtime/data/providers.json');
      expect(hint).toContain('same SMARTPERFETTO_BACKEND_DATA_DIR');
      expect(hint).not.toContain('First open the Web UI');
    },
  );

  it.each([
    ['en', true, 'may use the local qodercli login', 'Qoder Agent SDK is installed'],
    ['zh-CN', true, '可以使用本机 qodercli 登录态', 'Qoder Agent SDK 已安装'],
    ['en', false, 'explicitly install the optional SDK', 'Qoder Agent SDK is not installed'],
    ['zh-CN', false, '显式安装可选 SDK', 'Qoder Agent SDK 未安装'],
  ] as const)(
    'keeps Qoder local-login diagnostics accurate (%s, installed=%s)',
    (language, sdkInstalled, expected, prefix) => {
      const diagnostics = asRuntimeDiagnosticsPayload({
        runtime: 'qoder-agent-sdk',
        configured: false,
        sdkInstalled,
      }, 'qoder-agent-sdk', {SMARTPERFETTO_OUTPUT_LANGUAGE: language});
      expect(diagnostics.configured).toBe(false);
      expect(diagnostics.configHint).toContain(prefix);
      expect(diagnostics.configHint).toContain(expected);
      expect(diagnostics.configHint).not.toContain('Providers');
      expect(diagnostics.configHint).not.toContain('SMARTPERFETTO_BACKEND_DATA_DIR');
    },
  );

  it('normalizes model and provider mode to stable strings', () => {
    expect(getRuntimeDiagnosticModel({
      runtime: 'openai-agents-sdk',
      configured: true,
      model: 'glm-5',
    })).toBe('glm-5');
    expect(getRuntimeDiagnosticProviderMode({
      runtime: 'openai-agents-sdk',
      configured: true,
      providerMode: 'openai_chat_completions_compatible',
    })).toBe('openai_chat_completions_compatible');
    expect(getRuntimeDiagnosticModel({
      runtime: 'pi-agent-core',
      configured: true,
      modelConfigured: true,
    })).toBe('pi-agent-core');
    expect(getRuntimeDiagnosticModel({
      runtime: 'pi-agent-core',
      configured: false,
      modelConfigured: false,
    })).toBe('');
    expect(getRuntimeDiagnosticModel({
      runtime: 'opencode',
      configured: false,
      modelConfigured: false,
    })).toBe('opencode');
    expect(getRuntimeDiagnosticProviderMode({
      runtime: 'opencode',
      configured: true,
    })).toBe('opencode');
  });

  it('fails closed for malformed diagnostics without dumping payload contents', () => {
    expect(() => asRuntimeDiagnosticsPayload({
      configured: true,
      apiKey: 'sk-should-not-leak',
    }, 'bad-runtime')).toThrow('Runtime diagnostics for bad-runtime must include a string runtime');
    expect(() => asRuntimeDiagnosticsPayload({
      runtime: 'bad-runtime',
      apiKey: 'sk-should-not-leak',
    }, 'bad-runtime')).toThrow('Runtime diagnostics for bad-runtime must include a boolean configured flag');

    for (const value of [
      { configured: true, apiKey: 'sk-should-not-leak' },
      { runtime: 'bad-runtime', apiKey: 'sk-should-not-leak' },
    ]) {
      try {
        asRuntimeDiagnosticsPayload(value, 'bad-runtime');
      } catch (error) {
        expect(String(error)).not.toContain('sk-should-not-leak');
      }
    }
  });
});
