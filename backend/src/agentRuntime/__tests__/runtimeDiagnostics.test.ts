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

  it.each(['opencode', 'qoder-agent-sdk', 'experimental-opencode', 'experimental-pi-agent-core'])(
    'refuses diagnostics for %s, which names no engine', (kind) => {
      expect(() => getRuntimeDiagnostics({kind, source: 'env'}, {env: {}}))
        .toThrow(`Unsupported agent runtime diagnostics: ${kind}`);
    },
  );

  it.each(['claude-agent-sdk', 'openai-agents-sdk', 'pi-agent-core'])(
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
      runtime: 'claude-agent-sdk',
      configured: false,
    })).toBe('');
    expect(getRuntimeDiagnosticProviderMode({
      runtime: 'pi-agent-core',
      configured: true,
    })).toBe('pi-agent-core');
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
