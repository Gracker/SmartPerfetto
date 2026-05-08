// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

let provider: any;

jest.mock('../../services/providerManager', () => ({
  getProviderService: () => ({
    getRawProvider: jest.fn(() => provider),
    getRawEffectiveProvider: jest.fn(() => provider),
    resolveAgentRuntime: jest.fn((p: any) => p.connection.agentRuntime),
  }),
}));

describe('resolveAgentRuntimeSelection', () => {
  const originalRuntime = process.env.SMARTPERFETTO_AGENT_RUNTIME;

  beforeEach(() => {
    provider = undefined;
    delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    jest.resetModules();
  });

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    else process.env.SMARTPERFETTO_AGENT_RUNTIME = originalRuntime;
  });

  it('uses the active provider runtime before env fallbacks', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection()).toMatchObject({
      kind: 'openai-agents-sdk',
      source: 'provider',
      providerId: 'provider-openai',
    });
  });

  it('uses explicit SMARTPERFETTO_AGENT_RUNTIME when no provider is active', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection()).toMatchObject({
      kind: 'openai-agents-sdk',
      source: 'env',
    });
  });

  it('uses snapshot runtime override before active provider fallback', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection(undefined, 'claude-agent-sdk')).toMatchObject({
      kind: 'claude-agent-sdk',
      source: 'snapshot',
    });
  });

  it('uses env/default fallback when providerId is explicitly null', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection(null)).toMatchObject({
      kind: 'claude-agent-sdk',
      source: 'default',
    });
  });

  it('lets explicit providerId win over snapshot runtime override', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection('provider-openai', 'claude-agent-sdk')).toMatchObject({
      kind: 'openai-agents-sdk',
      source: 'provider',
      providerId: 'provider-openai',
    });
  });

  it('throws when an explicit providerId does not exist', async () => {
    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');

    expect(() => resolveAgentRuntimeSelection('missing-provider')).toThrow(
      'Provider not found: missing-provider',
    );
  });

  it('rejects provider names as runtime env values', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'deepseek';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(() => resolveAgentRuntimeSelection()).toThrow(
      'Unsupported SMARTPERFETTO_AGENT_RUNTIME="deepseek"'
    );
  });
});
