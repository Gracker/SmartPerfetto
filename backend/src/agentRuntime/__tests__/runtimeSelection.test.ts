// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { TraceProcessorService } from '../../services/traceProcessorService';

let provider: any;
let providerEnv: Record<string, string> | null;

function createMockOrchestrator(runtime: string): any {
  const orchestrator = new EventEmitter() as any;
  orchestrator.runtime = runtime;
  orchestrator.analyze = jest.fn();
  orchestrator.reset = jest.fn();
  return orchestrator;
}

function expectEventEmitterContract(orchestrator: any): void {
  expect(typeof orchestrator.on).toBe('function');
  expect(typeof orchestrator.off).toBe('function');
  expect(typeof orchestrator.emit).toBe('function');
  expect(typeof orchestrator.removeAllListeners).toBe('function');
}

function expectDirectUpdateEvents(orchestrator: any): void {
  expectEventEmitterContract(orchestrator);
  const updates: any[] = [];
  const handler = (update: any) => updates.push(update);
  const update = { type: 'progress', message: 'runtime progress' };

  orchestrator.on('update', handler);
  orchestrator.emit('update', update);
  orchestrator.off('update', handler);

  expect(updates).toEqual([update]);
}

jest.mock('../../services/providerManager', () => ({
  getProviderService: () => ({
    getRawProvider: jest.fn(() => provider),
    getRawEffectiveProvider: jest.fn(() => provider),
    getEnvForProvider: jest.fn(() => providerEnv),
    resolveAgentRuntime: jest.fn((p: any) => p.connection.agentRuntime),
  }),
}));

describe('resolveAgentRuntimeSelection', () => {
  const originalRuntime = process.env.SMARTPERFETTO_AGENT_RUNTIME;
  const originalAiEnabled = process.env.SMARTPERFETTO_AI_ENABLED;
  const originalExperimentalEnabled = process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME;
  const originalExperimentalRuntime = process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME;
  // The no-provider default depends on Claude credentials in env (hasClaudeCredentials); isolate them.
  const originalEnv = {...process.env};

  beforeEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
      delete process.env[key];
    }
    provider = undefined;
    providerEnv = null;
    delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    delete process.env.SMARTPERFETTO_AI_ENABLED;
    delete process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME;
    delete process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME;
    delete process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = {...originalEnv};
    if (originalRuntime === undefined) delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    else process.env.SMARTPERFETTO_AGENT_RUNTIME = originalRuntime;
    if (originalAiEnabled === undefined) delete process.env.SMARTPERFETTO_AI_ENABLED;
    else process.env.SMARTPERFETTO_AI_ENABLED = originalAiEnabled;
    if (originalExperimentalEnabled === undefined) delete process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME;
    else process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME = originalExperimentalEnabled;
    if (originalExperimentalRuntime === undefined) delete process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME;
    else process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME = originalExperimentalRuntime;
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
      providerName: 'OpenAI',
      providerType: 'openai',
    });
  });

  it('uses Pi Agent Core by default when no provider, snapshot, env runtime or Claude credentials exist', async () => {
    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection()).toEqual({
      kind: 'pi-agent-core',
      source: 'default',
    });
  });

  it('runs an env-only setup with Claude credentials on Pi', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-only';
    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection()).toEqual({
      kind: 'pi-agent-core',
      source: 'default',
    });
  });

  it.each(['claude-agent-sdk', 'openai-agents-sdk', 'opencode', 'qoder-agent-sdk', 'experimental-pi-agent-core'])(
    'maps a retired SMARTPERFETTO_AGENT_RUNTIME=%s to Pi with one deprecation warning', async (value) => {
      process.env.SMARTPERFETTO_AGENT_RUNTIME = value;
      const logger = (await import('../../utils/logger')).default;
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
        expect(resolveAgentRuntimeSelection()).toEqual({kind: 'pi-agent-core', source: 'env'});
        expect(resolveAgentRuntimeSelection(null)).toEqual({kind: 'pi-agent-core', source: 'env'});
        expect(warn.mock.calls.filter(([, message]) => String(message).includes('SMARTPERFETTO_AGENT_RUNTIME'))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

  it('selects the hidden legacy runtime only through SMARTPERFETTO_LEGACY_AGENT_RUNTIME', async () => {
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'claude-agent-sdk';
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';
    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    // The old variable maps to the effective runtime, which the opt-in decides.
    expect(resolveAgentRuntimeSelection(null)).toEqual({kind: 'claude-agent-sdk', source: 'env'});
    // A recorded pin resolves through the same function.
    expect(resolveAgentRuntimeSelection(null, 'pi-agent-core')).toEqual({kind: 'claude-agent-sdk', source: 'snapshot'});
    delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    expect(resolveAgentRuntimeSelection(null)).toEqual({kind: 'claude-agent-sdk', source: 'env'});
  });

  it('fails closed on an unknown legacy runtime opt-in', async () => {
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'opencode';
    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(() => resolveAgentRuntimeSelection(null)).toThrow('Unsupported SMARTPERFETTO_LEGACY_AGENT_RUNTIME="opencode"');
  });

  it('accepts public Pi agent-core through SMARTPERFETTO_AGENT_RUNTIME', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'pi-agent-core';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection(null)).toEqual({
      kind: 'pi-agent-core',
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
    // A recorded retired label keeps its precedence; its execution re-resolves to Pi.
    expect(resolveAgentRuntimeSelection(undefined, 'claude-agent-sdk')).toMatchObject({
      kind: 'pi-agent-core',
      source: 'snapshot',
    });
  });

  it('uses snapshot runtime override before env fallback when Provider Manager is bypassed', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection(null, 'claude-agent-sdk')).toEqual({
      kind: 'pi-agent-core',
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
      kind: 'pi-agent-core',
      source: 'default',
    });
  });

  it('uses env runtime when providerId is explicitly null and env is configured', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'openai-agents-sdk';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection(null)).toEqual({
      kind: 'pi-agent-core',
      source: 'env',
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

  it('lets an explicit custom Pi provider pin the public runtime', async () => {
    provider = {
      id: 'provider-pi',
      name: 'Pi Custom',
      type: 'custom',
      connection: {
        agentRuntime: 'pi-agent-core',
        piAgentCoreModelJson: '{"id":"pi-test","provider":"test"}',
      },
    };
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection('provider-pi')).toMatchObject({
      kind: 'pi-agent-core',
      source: 'provider',
      providerId: 'provider-pi',
      providerName: 'Pi Custom',
      providerType: 'custom',
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

  it('ignores the retired experimental runtime switches', async () => {
    process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME = '1';
    process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME = 'experimental-opencode';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection(null)).toEqual({kind: 'pi-agent-core', source: 'default'});
    delete process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME;
    expect(resolveAgentRuntimeSelection(null)).toEqual({kind: 'pi-agent-core', source: 'default'});
  });

  it('lets an active Provider Manager runtime win over the hidden experimental env', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };
    process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME = '1';
    process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME = 'experimental-pi-agent-core';

    const { resolveAgentRuntimeSelection } = await import('../runtimeSelection');
    expect(resolveAgentRuntimeSelection()).toMatchObject({
      kind: 'openai-agents-sdk',
      source: 'provider',
      providerId: 'provider-openai',
    });
  });

  it('passes the resolved legacy Claude runtime selection snapshot into the runtime instance', async () => {
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'claude-agent-sdk';
    const claudeRuntime = createMockOrchestrator('claude');
    const createClaudeRuntime = jest.fn(() => claudeRuntime);
    jest.doMock('../engines/claude', () => ({ createClaudeRuntime }));

    const traceProcessorService = { kind: 'trace-processor' } as unknown as TraceProcessorService;
    const { createAgentOrchestrator } = await import('../runtimeSelection');
    const orchestrator = createAgentOrchestrator({ traceProcessorService });

    expect(orchestrator).toBe(claudeRuntime);
    expectDirectUpdateEvents(orchestrator);
    expect(createClaudeRuntime).toHaveBeenCalledWith(
      traceProcessorService,
      undefined,
      { kind: 'claude-agent-sdk', source: 'env' },
    );
  });

  it('blocks runtime creation while leaving runtime selection inspectable when AI is disabled', async () => {
    process.env.SMARTPERFETTO_AI_ENABLED = 'false';
    process.env.SMARTPERFETTO_LEGACY_AGENT_RUNTIME = 'claude-agent-sdk';
    const claudeRuntime = createMockOrchestrator('claude');
    const createClaudeRuntime = jest.fn(() => claudeRuntime);
    jest.doMock('../engines/claude', () => ({ createClaudeRuntime }));

    const traceProcessorService = { kind: 'trace-processor' } as unknown as TraceProcessorService;
    const { createAgentOrchestrator, resolveAgentRuntimeSelection } = await import('../runtimeSelection');

    expect(resolveAgentRuntimeSelection()).toEqual({
      kind: 'claude-agent-sdk',
      source: 'env',
    });
    expect(() => createAgentOrchestrator({ traceProcessorService })).toThrow('AI is disabled');
    expect(createClaudeRuntime).not.toHaveBeenCalled();
  });

  it('passes the resolved OpenAI provider selection snapshot into the runtime instance', async () => {
    provider = {
      id: 'provider-openai',
      name: 'OpenAI',
      type: 'openai',
      connection: { agentRuntime: 'openai-agents-sdk' },
    };
    const claudeRuntime = createMockOrchestrator('claude');
    const openAIRuntime = createMockOrchestrator('openai');
    const createClaudeRuntime = jest.fn(() => claudeRuntime);
    const createOpenAIRuntime = jest.fn(() => openAIRuntime);
    jest.doMock('../engines/claude', () => ({ createClaudeRuntime }));
    jest.doMock('../engines/openai', () => ({ createOpenAIRuntime }));

    const traceProcessorService = { kind: 'trace-processor' } as any;
    const { createAgentOrchestrator } = await import('../runtimeSelection');
    const orchestrator = createAgentOrchestrator({ traceProcessorService });

    expect(orchestrator).toBe(openAIRuntime);
    expectDirectUpdateEvents(orchestrator);
    expect(createOpenAIRuntime).toHaveBeenCalledWith(
      traceProcessorService,
      {
        kind: 'openai-agents-sdk',
        source: 'provider',
        providerId: 'provider-openai',
        providerName: 'OpenAI',
        providerType: 'openai',
      },
    );
    expect(createClaudeRuntime).not.toHaveBeenCalled();
  });

  it('passes provider-isolated env overlay into the public Pi runtime', async () => {
    provider = {
      id: 'provider-pi',
      name: 'Pi Provider',
      type: 'custom',
      connection: { agentRuntime: 'pi-agent-core' },
    };
    providerEnv = {
      SMARTPERFETTO_AGENT_RUNTIME: 'pi-agent-core',
      SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH: '/provider/pi-agent-core.mjs',
      SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"id":"provider-pi"}',
      SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT: 'provider pi prompt',
    };
    const originalProcessPiModule = process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH;
    const originalProcessOpenCodeProject = process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR;
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH = '/process/pi-agent-core.mjs';
    process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR = '/process/opencode';
    const piRuntime = createMockOrchestrator('pi');
    const createPiAgentCoreRuntime = jest.fn((_input: any) => piRuntime);
    jest.doMock('../engines/pi/piAgentCoreRuntime', () => ({ createPiAgentCoreRuntime }));

    try {
      const traceProcessorService = { kind: 'trace-processor' } as any;
      const { createAgentOrchestrator } = await import('../runtimeSelection');
      const orchestrator = createAgentOrchestrator({ traceProcessorService, providerId: 'provider-pi' });

      expect(orchestrator).toBe(piRuntime);
      expectDirectUpdateEvents(orchestrator);
      const runtimeInput = createPiAgentCoreRuntime.mock.calls[0][0] as any;
      expect(runtimeInput.selection).toMatchObject({
        kind: 'pi-agent-core',
        source: 'provider',
        providerId: 'provider-pi',
      });
      expect(runtimeInput.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH)
        .toBe('/provider/pi-agent-core.mjs');
      expect(runtimeInput.env.SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON)
        .toBe('{"id":"provider-pi"}');
      expect(runtimeInput.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR).toBeUndefined();
    } finally {
      if (originalProcessPiModule === undefined) delete process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH;
      else process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH = originalProcessPiModule;
      if (originalProcessOpenCodeProject === undefined) delete process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR;
      else process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR = originalProcessOpenCodeProject;
      jest.dontMock('../engines/pi/piAgentCoreRuntime');
    }
  });

  it('passes provider-isolated env overlay into the public OpenCode runtime', async () => {
    provider = {
      id: 'provider-opencode',
      name: 'OpenCode Provider',
      type: 'custom',
      connection: { agentRuntime: 'opencode' },
    };
    providerEnv = {
      SMARTPERFETTO_AGENT_RUNTIME: 'opencode',
      OPENAI_BASE_URL: 'https://provider-opencode.example/v1',
      OPENAI_MODEL: 'opencode-provider-model',
      SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH: '/provider/opencode-sdk.mjs',
      SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/provider/opencode-project',
      SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["node","provider-mcp.js"]',
    };
    const originalProcessOpenCodeProject = process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR;
    const originalProcessPiModule = process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH;
    process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR = '/process/opencode';
    process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH = '/process/pi-agent-core.mjs';
    const openCodeRuntime = createMockOrchestrator('opencode');
    const OpenCodeRuntime = jest.fn((_input: any, _options: any) => openCodeRuntime);
    jest.doMock('../engines/opencode/openCodeRuntime', () => ({ OpenCodeRuntime }));

    try {
      const traceProcessorService = { kind: 'trace-processor' } as any;
      const { createAgentOrchestrator } = await import('../runtimeSelection');
      const orchestrator = createAgentOrchestrator({
        traceProcessorService,
        providerId: 'provider-opencode',
      });

      expect(orchestrator).toBe(openCodeRuntime);
      expectDirectUpdateEvents(orchestrator);
      const [runtimeInput, runtimeOptions] = OpenCodeRuntime.mock.calls[0] as any[];
      expect(runtimeInput.selection).toMatchObject({
        kind: 'opencode',
        source: 'provider',
        providerId: 'provider-opencode',
      });
      expect(runtimeOptions.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR)
        .toBe('/provider/opencode-project');
      expect(runtimeOptions.env.SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON)
        .toBe('["node","provider-mcp.js"]');
      expect(runtimeOptions.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH).toBeUndefined();
    } finally {
      if (originalProcessOpenCodeProject === undefined) delete process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR;
      else process.env.SMARTPERFETTO_OPENCODE_PROJECT_DIR = originalProcessOpenCodeProject;
      if (originalProcessPiModule === undefined) delete process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH;
      else process.env.SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH = originalProcessPiModule;
      jest.dontMock('../engines/opencode/openCodeRuntime');
    }
  });

  it('creates Pi, not a retired experimental runtime, when the experimental switch is still set', async () => {
    process.env.SMARTPERFETTO_ENABLE_EXPERIMENTAL_AGENT_RUNTIME = '1';
    process.env.SMARTPERFETTO_EXPERIMENTAL_AGENT_RUNTIME = 'experimental-opencode';

    const traceProcessorService = { kind: 'trace-processor' } as any;
    const { createAgentOrchestrator } = await import('../runtimeSelection');
    const orchestrator = createAgentOrchestrator({ traceProcessorService, providerId: null });

    expect((orchestrator as any).constructor?.name).toBe('PiAgentCoreRuntime');
    expectDirectUpdateEvents(orchestrator);
  });

  it('creates the public Pi runtime as the direct orchestrator', async () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = 'pi-agent-core';

    const traceProcessorService = { kind: 'trace-processor' } as any;
    const { createAgentOrchestrator } = await import('../runtimeSelection');
    const orchestrator = createAgentOrchestrator({ traceProcessorService, providerId: null });

    expect(orchestrator).not.toBeUndefined();
    expect((orchestrator as any).constructor?.name).toBe('PiAgentCoreRuntime');
    expectDirectUpdateEvents(orchestrator);
  });

  it('keeps AnalysisHarness out of runtime selection source', () => {
    const source = fs.readFileSync(path.join(__dirname, '../runtimeSelection.ts'), 'utf8');

    expect(source).not.toMatch(/AnalysisHarness/);
    expect(source).not.toMatch(/createAnalysisHarness/);
    expect(source).not.toMatch(/SMARTPERFETTO_ANALYSIS_HARNESS/);
    expect(source).not.toMatch(/isAnalysisHarnessEnabled/);
  });
});
