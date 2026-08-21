// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import type { IOrchestrator } from '../../agent/core/orchestratorTypes';
import {
  RuntimeRegistry,
  createRuntimeRegistry,
  createRuntimeRegistryForSelection,
  type RuntimeEngineDefinition,
  type RuntimeFactoryInput,
} from '../runtimeRegistry';
import {
  PRODUCTION_RUNTIME_DESCRIPTORS,
  getProductionEngineCapabilities,
  isProductionAgentRuntimeKind,
  listProductionRuntimeKinds,
  supportsRuntimeProviderType,
} from '../runtimeDescriptors';
import {
  type EngineCapabilities,
} from '../runtimeDescriptorTypes';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
} from '../runtimeKinds';

function fakeCapabilities(kind = 'fake-runtime'): EngineCapabilities {
  return {
    kind,
    displayName: 'Fake Runtime',
    production: false,
    publicRuntime: false,
    promptCache: { systemPromptDynamicBoundary: false },
  };
}

describe('runtime registry', () => {
  it('keeps registry instance API limited to orchestrator creation', () => {
    expect(Object.getOwnPropertyNames(RuntimeRegistry.prototype).sort()).toEqual([
      'constructor',
      'createOrchestrator',
    ]);
  });

  it('derives public production runtimes from descriptors', () => {
    const descriptorKinds = PRODUCTION_RUNTIME_DESCRIPTORS.map(descriptor => descriptor.kind);
    const expectedKinds = [
      'claude-agent-sdk',
      'openai-agents-sdk',
      'pi-agent-core',
      'opencode',
      'qoder-agent-sdk',
    ];

    expect(descriptorKinds).toEqual(expectedKinds);
    expect(listProductionRuntimeKinds()).toEqual(expectedKinds);
    expect(isProductionAgentRuntimeKind('claude-agent-sdk')).toBe(true);
    expect(isProductionAgentRuntimeKind('openai-agents-sdk')).toBe(true);
    expect(isProductionAgentRuntimeKind('pi-agent-core')).toBe(true);
    expect(isProductionAgentRuntimeKind('opencode')).toBe(true);
    expect(isProductionAgentRuntimeKind('qoder-agent-sdk')).toBe(true);
    expect(isProductionAgentRuntimeKind('fake-third-party-runtime')).toBe(false);
  });

  it('exposes slim runtime capabilities as descriptor truth', () => {
    const claude = getProductionEngineCapabilities('claude-agent-sdk');
    const openai = getProductionEngineCapabilities('openai-agents-sdk');
    const pi = getProductionEngineCapabilities('pi-agent-core');
    const opencode = getProductionEngineCapabilities('opencode');
    const qoder = getProductionEngineCapabilities('qoder-agent-sdk');

    expect(claude).toBe(getProductionEngineCapabilities('claude-agent-sdk'));
    expect(openai).toBe(getProductionEngineCapabilities('openai-agents-sdk'));
    expect(pi).toBe(getProductionEngineCapabilities('pi-agent-core'));
    expect(opencode).toBe(getProductionEngineCapabilities('opencode'));
    expect(qoder).toBe(getProductionEngineCapabilities('qoder-agent-sdk'));
    expect(claude).toEqual({
      kind: 'claude-agent-sdk',
      displayName: 'Claude Agent SDK',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: true },
    });
    expect(openai).toEqual({
      kind: 'openai-agents-sdk',
      displayName: 'OpenAI Agents SDK',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
    });
    expect(pi).toEqual({
      kind: 'pi-agent-core',
      displayName: 'Pi Agent Core',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
    });
    expect(opencode).toEqual({
      kind: 'opencode',
      displayName: 'OpenCode',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
    });
    expect(qoder).toEqual({
      kind: 'qoder-agent-sdk',
      displayName: 'Qoder Agent SDK',
      production: true,
      publicRuntime: true,
      promptCache: { systemPromptDynamicBoundary: false },
    });
    for (const capabilities of [claude, openai, pi, opencode, qoder]) {
      expect(capabilities).not.toHaveProperty('toolTransport');
      expect(capabilities).not.toHaveProperty('continuationPolicy');
      expect(capabilities).not.toHaveProperty('snapshotState');
    }
  });

  it('derives provider compatibility from runtime descriptors', () => {
    expect(supportsRuntimeProviderType('anthropic', 'claude-agent-sdk')).toBe(true);
    expect(supportsRuntimeProviderType('deepseek', 'claude-agent-sdk')).toBe(true);
    expect(supportsRuntimeProviderType('deepseek', 'openai-agents-sdk')).toBe(true);
    expect(supportsRuntimeProviderType('openai', 'openai-agents-sdk')).toBe(true);
    expect(supportsRuntimeProviderType('openai', 'claude-agent-sdk')).toBe(false);
    expect(supportsRuntimeProviderType('custom', 'pi-agent-core')).toBe(true);
    expect(supportsRuntimeProviderType('custom', 'opencode')).toBe(true);
    expect(supportsRuntimeProviderType('anthropic', 'opencode')).toBe(false);
  });

  it('requires every production runtime to expose session-scoped cancellation', () => {
    const traceProcessorService = { kind: 'trace-processor' } as any;
    const registry = createRuntimeRegistry(PRODUCTION_RUNTIME_DESCRIPTORS);

    for (const kind of listProductionRuntimeKinds()) {
      const orchestrator = registry.createOrchestrator(kind, {
        traceProcessorService,
        selection: { kind, source: 'default' },
      });

      expect(typeof orchestrator.abortSession).toBe('function');
    }
  });

  it('creates runtimes through registered definitions', () => {
    const orchestrator = { analyze: jest.fn(), reset: jest.fn() } as unknown as IOrchestrator;
    const createOrchestrator = jest.fn((_input: any) => orchestrator);
    const definition: RuntimeEngineDefinition = {
      kind: 'fake-runtime',
      capabilities: fakeCapabilities('fake-runtime'),
      createOrchestrator,
    };
    const registry = createRuntimeRegistry([definition]);
    const traceProcessorService = { kind: 'trace-processor' } as any;
    const selection = { kind: 'fake-runtime', source: 'default' as const };

    expect(registry.createOrchestrator('fake-runtime', {
      traceProcessorService,
      selection,
    })).toBe(orchestrator);
    expect(createOrchestrator).toHaveBeenCalledWith({
      traceProcessorService,
      selection,
    });
  });

  it('fails closed for unknown, duplicate, and mismatched registrations', () => {
    const definition: RuntimeEngineDefinition = {
      kind: 'fake-runtime',
      capabilities: fakeCapabilities('fake-runtime'),
      createOrchestrator: jest.fn(() => ({}) as IOrchestrator),
    };
    const registry = createRuntimeRegistry([definition]);
    const traceProcessorService = { kind: 'trace-processor' } as any;
    const selection = { kind: 'missing-runtime', source: 'default' as const };

    expect(() => registry.createOrchestrator('missing-runtime', {
      traceProcessorService,
      selection,
    })).toThrow(
      'Unsupported agent runtime: missing-runtime',
    );
    expect(() => createRuntimeRegistry([definition, definition])).toThrow(
      'Runtime already registered: fake-runtime',
    );
    expect(() => createRuntimeRegistry([{
      ...definition,
      kind: 'fake-runtime-alias',
    }])).toThrow(
      'Runtime registration mismatch: fake-runtime-alias != fake-runtime',
    );
  });

  it('registers experimental Pi runtime directly without definition indirection', () => {
    jest.isolateModules(() => {
      const orchestrator = { analyze: jest.fn(), reset: jest.fn() } as unknown as IOrchestrator;
      const createPiAgentCoreRuntime = jest.fn((_input: RuntimeFactoryInput) => orchestrator);
      const getPiAgentCoreEngineCapabilities = jest.fn((kind: string) => fakeCapabilities(kind));
      const createPiAgentCoreRuntimeDefinition = jest.fn(() => {
        throw new Error('definition factory should not be called');
      });

      jest.doMock('../engines/pi/piAgentCoreRuntime', () => ({
        createPiAgentCoreRuntime,
        createPiAgentCoreRuntimeDefinition,
        getPiAgentCoreEngineCapabilities,
      }));

      const registryModule = require('../runtimeRegistry') as typeof import('../runtimeRegistry');
      const registry = registryModule.createRuntimeRegistryForSelection(
        EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
      );
      const input = {
        traceProcessorService: { kind: 'trace-processor' } as any,
        selection: {
          kind: EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND,
          source: 'env' as const,
        },
      };

      expect(registry.createOrchestrator(EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND, input))
        .toBe(orchestrator);
      expect(createPiAgentCoreRuntime).toHaveBeenCalledWith(input);
      expect(getPiAgentCoreEngineCapabilities)
        .toHaveBeenCalledWith(EXPERIMENTAL_PI_AGENT_CORE_RUNTIME_KIND);
      expect(createPiAgentCoreRuntimeDefinition).not.toHaveBeenCalled();

      jest.dontMock('../engines/pi/piAgentCoreRuntime');
    });
  });

  it('registers experimental OpenCode runtime directly without definition indirection', () => {
    jest.isolateModules(() => {
      const orchestrator = { analyze: jest.fn(), reset: jest.fn() } as unknown as IOrchestrator;
      const OpenCodeRuntime = jest.fn((_input: RuntimeFactoryInput) => orchestrator);
      const getOpenCodeEngineCapabilities = jest.fn((kind: string) => fakeCapabilities(kind));
      const createOpenCodeRuntimeDefinition = jest.fn(() => {
        throw new Error('definition factory should not be called');
      });

      jest.doMock('../engines/opencode/openCodeRuntime', () => ({
        OpenCodeRuntime,
        createOpenCodeRuntimeDefinition,
        getOpenCodeEngineCapabilities,
      }));

      const registryModule = require('../runtimeRegistry') as typeof import('../runtimeRegistry');
      const registry = registryModule.createRuntimeRegistryForSelection(
        EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      );
      const input = {
        traceProcessorService: { kind: 'trace-processor' } as any,
        selection: {
          kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
          source: 'env' as const,
        },
      };

      expect(registry.createOrchestrator(EXPERIMENTAL_OPENCODE_RUNTIME_KIND, input))
        .toBe(orchestrator);
      expect(OpenCodeRuntime).toHaveBeenCalledWith(input);
      expect(getOpenCodeEngineCapabilities)
        .toHaveBeenCalledWith(EXPERIMENTAL_OPENCODE_RUNTIME_KIND);
      expect(createOpenCodeRuntimeDefinition).not.toHaveBeenCalled();

      jest.dontMock('../engines/opencode/openCodeRuntime');
    });
  });

  it('keeps direct registry construction out of non-test runtime code', () => {
    const srcRoot = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];

    function visit(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          visit(absolute);
          continue;
        }
        if (!entry.isFile() || !absolute.endsWith('.ts')) continue;
        if (absolute.endsWith(path.join('agentRuntime', 'runtimeRegistry.ts'))) continue;

        const text = fs.readFileSync(absolute, 'utf8');
        if (
          /\bcreateRuntimeRegistry\s*\(/.test(text) ||
          /\bnew\s+RuntimeRegistry\b/.test(text) ||
          /\bproductionRuntimeRegistry\b/.test(text) ||
          /\bcreateProductionRuntimeRegistry\b/.test(text)
        ) {
          offenders.push(path.relative(srcRoot, absolute));
        }
      }
    }

    visit(srcRoot);

    expect(offenders).toEqual([]);
  });
});
