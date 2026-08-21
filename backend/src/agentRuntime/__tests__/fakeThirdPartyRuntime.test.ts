// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import type { IOrchestrator } from '../../agent/core/orchestratorTypes';
import type { AgentRuntimeKind } from '../../services/providerManager/types';
import { isAgentRuntimeKind } from '../../services/providerManager';
import { createAnalysisRunSpec } from '../analysisRunSpec';
import type { RuntimeSelection } from '../runtimeSelection';
import { resolveAgentRuntimeSelection } from '../runtimeSelection';
import { createRuntimeRegistry } from '../runtimeRegistry';
import type { EngineCapabilities } from '../runtimeDescriptorTypes';

type IsExact<T, U> =
  (<G>() => G extends T ? 1 : 2) extends
  (<G>() => G extends U ? 1 : 2)
    ? ((<G>() => G extends U ? 1 : 2) extends
       (<G>() => G extends T ? 1 : 2) ? true : false)
    : false;

const fakeKind = 'fake-third-party-runtime';

const fakeCapabilities: EngineCapabilities = {
  kind: fakeKind,
  displayName: 'Fake Third-Party Runtime',
  production: false,
  publicRuntime: false,
  promptCache: { systemPromptDynamicBoundary: false },
};

describe('fake third-party runtime contract', () => {
  const originalRuntime = process.env.SMARTPERFETTO_AGENT_RUNTIME;

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.SMARTPERFETTO_AGENT_RUNTIME;
    else process.env.SMARTPERFETTO_AGENT_RUNTIME = originalRuntime;
  });

  it('keeps fake third-party runtime out of the public Provider Manager runtime kind', () => {
    const publicRuntimeKindStillExact:
      IsExact<
        AgentRuntimeKind,
        'claude-agent-sdk' | 'openai-agents-sdk' | 'pi-agent-core' | 'opencode' | 'qoder-agent-sdk'
      > = true;

    expect(publicRuntimeKindStillExact).toBe(true);
    expect(isAgentRuntimeKind('claude-agent-sdk')).toBe(true);
    expect(isAgentRuntimeKind('openai-agents-sdk')).toBe(true);
    expect(isAgentRuntimeKind('pi-agent-core')).toBe(true);
    expect(isAgentRuntimeKind('opencode')).toBe(true);
    expect(isAgentRuntimeKind('qoder-agent-sdk')).toBe(true);
    expect(isAgentRuntimeKind(fakeKind)).toBe(false);
  });

  it('keeps fake third-party runtime out of public env selection', () => {
    process.env.SMARTPERFETTO_AGENT_RUNTIME = fakeKind;

    expect(() => resolveAgentRuntimeSelection(null)).toThrow(
      `Unsupported SMARTPERFETTO_AGENT_RUNTIME="${fakeKind}"`,
    );
  });

  it('can register a fake runtime in a test-only registry', () => {
    const orchestrator = { analyze: jest.fn(), reset: jest.fn() } as unknown as IOrchestrator;
    const createOrchestrator = jest.fn((_input: any) => orchestrator);
    const registry = createRuntimeRegistry([{
      kind: fakeKind,
      capabilities: fakeCapabilities,
      createOrchestrator,
    }]);
    const traceProcessorService = { kind: 'trace-processor' } as any;
    const selection: RuntimeSelection<typeof fakeKind> = {
      kind: fakeKind,
      source: 'default',
    };

    expect(registry.createOrchestrator(fakeKind, {
      traceProcessorService,
      selection,
    })).toBe(orchestrator);
    expect(createOrchestrator).toHaveBeenCalledWith({
      traceProcessorService,
      selection,
    });
  });

  it('rejects a test-only runtime when sealing a production analysis run spec', () => {
    const selection: RuntimeSelection<typeof fakeKind> = {
      kind: fakeKind,
      source: 'default',
    };

    expect(() => createAnalysisRunSpec({
      query: 'analyze startup',
      sessionId: 'session-fake',
      traceId: 'trace-fake',
      runtimeSelection: selection,
      engineCapabilities: fakeCapabilities,
      sceneType: 'startup',
      outputLanguage: 'en',
      resolvedMode: 'full',
    }))
      .toThrow(`Unsupported production analysis runtime: ${fakeKind}`);
  });
});
