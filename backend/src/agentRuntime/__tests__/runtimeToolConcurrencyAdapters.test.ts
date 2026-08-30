// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {z} from 'zod';

import {McpToolRegistry, type McpToolDefinition} from '../../agentv3/mcpToolRegistry';
import {createOpenAIToolsFromMcpDefinitions} from '../engines/openai/openAiToolAdapter';
import {createPiAgentCoreToolFromSharedSpec} from '../engines/pi/piAgentCoreRuntime';
import {dispatchOpenCodeBridgeRequest} from '../engines/opencode/openCodeRuntime';
import type {SharedToolSpec} from '../runtimeToolSpec';
import {
  createRuntimePerformanceRecorder,
  type RuntimePerformanceRecorder,
} from '../runtimePerformance';
import {
  createRuntimeToolConcurrencyCoordinator,
  SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV,
} from '../runtimeToolConcurrency';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';

const originalAdmission = process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES;

beforeEach(() => {
  process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = 'task5';
});

afterEach(() => {
  if (originalAdmission === undefined) delete process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES;
  else process.env.SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES = originalAdmission;
});

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function textResult(text: string) {
  return {content: [{type: 'text' as const, text}]};
}

function createNoopAttributionSink(
  runtimePerformanceRecorder = createRuntimePerformanceRecorder(),
  runId = 'run-tool-concurrency-adapter-test',
): RunManifestAttributionSink {
  return {
    identity: {
      runId,
      sessionId: `session-${runId}`,
      scope: {tenantId: 'tenant-test', workspaceId: 'workspace-test'},
    },
    runtimePerformanceRecorder,
    recordScene: jest.fn(),
    recordRuntime: jest.fn(),
    recordMode: jest.fn(),
    recordAdaptiveRouting: jest.fn(),
    recordCapabilityManifest: jest.fn(),
    recordSkillRegistry: jest.fn(),
    startSkillInvocation: jest.fn(() => 'skill-invocation-test'),
    finishSkillInvocation: jest.fn(),
    recordUnknownSkillInvocation: jest.fn(),
    recordSqlStatement: jest.fn(),
    recordPromptTemplate: jest.fn(),
    recordInjection: jest.fn(),
    recordToolAllowlist: jest.fn(),
    recordTurn: jest.fn(),
  };
}

function sdkToolsByName(registry: McpToolRegistry): Record<string, {handler: (...args: unknown[]) => Promise<unknown>}> {
  return Object.fromEntries(
    registry.list().map(definition => [definition.name, definition.tool]),
  ) as Record<string, {handler: (...args: unknown[]) => Promise<unknown>}>;
}

function createCoordinatedDefinitions(registry = new McpToolRegistry()) {
  const lookupGate = createDeferred<string>();
  const modulesGate = createDeferred<string>();
  const started: string[] = [];

  const makeSpec = (name: 'lookup_sql_schema' | 'list_stdlib_modules', gate: typeof lookupGate): SharedToolSpec => ({
    name,
    description: `${name} test tool`,
    exposure: 'public',
    inputSchema: {keyword: z.string().optional(), namespace: z.string().optional()},
    concurrency: {mode: 'commutative_read'},
    handler: async (_args, extra) => {
      started.push(`${extra.runtime ?? 'claude-sdk'}:${name}`);
      return textResult(await gate.promise);
    },
  });

  registry.registerShared(makeSpec('lookup_sql_schema', lookupGate));
  registry.registerShared(makeSpec('list_stdlib_modules', modulesGate));

  return {
    registry,
    definitions: registry.list(),
    started,
    lookupGate,
    modulesGate,
  };
}

function createMixedDefinitions(registry = new McpToolRegistry()) {
  const lookupGate = createDeferred<string>();
  const writerGate = createDeferred<string>();
  const modulesGate = createDeferred<string>();
  const started: string[] = [];

  const makeSpec = (
    name: 'lookup_sql_schema' | 'execute_sql' | 'list_stdlib_modules',
    gate: typeof lookupGate,
    concurrency?: SharedToolSpec['concurrency'],
  ): SharedToolSpec => ({
    name,
    description: `${name} test tool`,
    exposure: 'public',
    inputSchema: {keyword: z.string().optional(), query: z.string().optional(), namespace: z.string().optional()},
    ...(concurrency ? {concurrency} : {}),
    handler: async (_args, extra) => {
      started.push(`${extra.runtime ?? 'claude-sdk'}:${name}`);
      return textResult(await gate.promise);
    },
  });

  registry.registerShared(makeSpec('lookup_sql_schema', lookupGate, {mode: 'commutative_read'}));
  registry.registerShared(makeSpec('execute_sql', writerGate));
  registry.registerShared(makeSpec('list_stdlib_modules', modulesGate, {mode: 'commutative_read'}));

  return {
    registry,
    definitions: registry.list(),
    started,
    lookupGate,
    writerGate,
    modulesGate,
  };
}

function createFallbackDefinitions(
  runtimePerformanceRecorder: RuntimePerformanceRecorder,
  registry: McpToolRegistry,
) {
  const writerGate = createDeferred<string>();
  const demotedGate = createDeferred<string>();
  const started: string[] = [];

  const makeSpec = (
    name: 'execute_sql' | 'fetch_artifact',
    gate: typeof writerGate,
    concurrency?: SharedToolSpec['concurrency'],
  ): SharedToolSpec => ({
    name,
    description: `${name} fallback test tool`,
    exposure: 'public',
    inputSchema: {query: z.string().optional(), artifactId: z.string().optional()},
    ...(concurrency ? {concurrency} : {}),
    handler: async (_args, extra) => {
      started.push(`${extra.runtime ?? 'claude-sdk'}:${name}:${extra.toolCallId ?? 'missing-id'}`);
      return textResult(await gate.promise);
    },
  });

  registry.registerShared(makeSpec('execute_sql', writerGate));
  registry.registerShared(makeSpec('fetch_artifact', demotedGate, {mode: 'commutative_read'}));

  return {
    definitions: registry.list(),
    started,
    writerGate,
    demotedGate,
    runtimePerformanceRecorder,
  };
}

function extractResultText(value: unknown): string {
  const result = value as any;
  if (typeof result === 'string') return result;
  if (typeof result?.content === 'string') return result.content;
  if (Array.isArray(result?.content)) return String(result.content[0]?.text ?? '');
  if (result?.result !== undefined) return extractResultText(result.result);
  if (result?.details !== undefined) return extractResultText(result.details);
  return JSON.stringify(result);
}

type AdapterPairInvoker = (
  definitions: readonly McpToolDefinition[],
  registry: McpToolRegistry,
  signal?: AbortSignal,
) => [Promise<unknown>, Promise<unknown>];

type AdapterFallbackInvoker = (
  definitions: readonly McpToolDefinition[],
  registry: McpToolRegistry,
  signal?: AbortSignal,
) => [Promise<unknown>, Promise<unknown>];

type AdapterSingleInvoker = (
  definitions: readonly McpToolDefinition[],
  registry: McpToolRegistry,
  signal?: AbortSignal,
) => Promise<unknown>;

const adapterPairCases: Array<[string, AdapterPairInvoker]> = [
  ['Claude SDK MCP', (_definitions, registry, signal) => {
    const registered = sdkToolsByName(registry);
    return [
      registered.lookup_sql_schema.handler({keyword: 'frame'}, {signal, toolCallId: 'claude-order-1'}),
      registered.list_stdlib_modules.handler({namespace: 'android'}, {signal, toolCallId: 'claude-order-2'}),
    ];
  }],
  ['OpenAI function tools', (definitions, _registry, signal) => {
    const tools = createOpenAIToolsFromMcpDefinitions(definitions) as any[];
    const lookupTool = tools.find(tool => tool.name === 'lookup_sql_schema');
    const modulesTool = tools.find(tool => tool.name === 'list_stdlib_modules');
    return [
      lookupTool.invoke({context: {signal}}, '{"keyword":"frame"}', {signal, toolCall: {id: 'openai-order-1'}}),
      modulesTool.invoke({context: {signal}}, '{"namespace":"android"}', {signal, toolCall: {id: 'openai-order-2'}}),
    ];
  }],
  ['Pi Agent Core', (definitions, _registry, signal) => {
    const allowedToolNames = new Set(definitions.map(definition => definition.name));
    const tools = definitions.map(definition => createPiAgentCoreToolFromSharedSpec(definition.shared, {
      allowedToolNames,
      runtimeKind: 'pi-agent-core',
    }));
    return [
      tools[0].execute('pi-order-1', {keyword: 'frame'}, signal),
      tools[1].execute('pi-order-2', {namespace: 'android'}, signal),
    ];
  }],
  ['OpenCode bridge', (definitions, _registry, signal) => [
    dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-order-1',
      method: 'tools/call',
      params: {name: 'lookup_sql_schema', arguments: {keyword: 'frame'}},
    }, undefined, {getSignal: () => signal}),
    dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-order-2',
      method: 'tools/call',
      params: {name: 'list_stdlib_modules', arguments: {namespace: 'android'}},
    }, undefined, {getSignal: () => signal}),
  ]],
  ['Qoder SDK MCP', (_definitions, registry, signal) => {
    const registered = sdkToolsByName(registry);
    return [
      registered.lookup_sql_schema.handler({keyword: 'frame'}, {runtime: 'qoder-agent-sdk', signal, toolCallId: 'qoder-order-1'}),
      registered.list_stdlib_modules.handler({namespace: 'android'}, {runtime: 'qoder-agent-sdk', signal, toolCallId: 'qoder-order-2'}),
    ];
  }],
];

const adapterFallbackCases: Array<[string, AdapterFallbackInvoker]> = [
  ['Claude SDK MCP', (_definitions, registry, signal) => {
    const registered = sdkToolsByName(registry);
    return [
      registered.execute_sql.handler({query: 'select 1'}, {signal, toolCallId: 'claude-fallback-writer'}),
      registered.fetch_artifact.handler({artifactId: 'art-1'}, {signal, toolCallId: 'claude-fallback-demoted'}),
    ];
  }],
  ['OpenAI function tools', (definitions, _registry, signal) => {
    const tools = createOpenAIToolsFromMcpDefinitions(definitions) as any[];
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    return [
      byName.execute_sql.invoke({context: {signal}}, '{"query":"select 1"}', {signal, toolCall: {id: 'openai-fallback-writer'}}),
      byName.fetch_artifact.invoke({context: {signal}}, '{"artifactId":"art-1"}', {signal, toolCall: {id: 'openai-fallback-demoted'}}),
    ];
  }],
  ['Pi Agent Core', (definitions, _registry, signal) => {
    const allowedToolNames = new Set(definitions.map(definition => definition.name));
    const byName = Object.fromEntries(definitions.map(definition => [
      definition.name,
      createPiAgentCoreToolFromSharedSpec(definition.shared, {
        allowedToolNames,
        runtimeKind: 'pi-agent-core',
      }),
    ]));
    return [
      byName.execute_sql.execute('pi-fallback-writer', {query: 'select 1'}, signal),
      byName.fetch_artifact.execute('pi-fallback-demoted', {artifactId: 'art-1'}, signal),
    ];
  }],
  ['OpenCode bridge', (definitions, _registry, signal) => [
    dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-fallback-writer',
      method: 'tools/call',
      params: {name: 'execute_sql', arguments: {query: 'select 1'}},
    }, undefined, {getSignal: () => signal}),
    dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-fallback-demoted',
      method: 'tools/call',
      params: {name: 'fetch_artifact', arguments: {artifactId: 'art-1'}},
    }, undefined, {getSignal: () => signal}),
  ]],
  ['Qoder SDK MCP', (_definitions, registry, signal) => {
    const registered = sdkToolsByName(registry);
    return [
      registered.execute_sql.handler({query: 'select 1'}, {runtime: 'qoder-agent-sdk', signal, toolCallId: 'qoder-fallback-writer'}),
      registered.fetch_artifact.handler({artifactId: 'art-1'}, {runtime: 'qoder-agent-sdk', signal, toolCallId: 'qoder-fallback-demoted'}),
    ];
  }],
];

const adapterLookupCases: Array<[string, AdapterSingleInvoker]> = [
  ['Claude SDK MCP', (_definitions, registry, signal) => {
    const registered = sdkToolsByName(registry);
    return registered.lookup_sql_schema.handler(
      {keyword: 'frame'},
      {signal, toolCallId: 'claude-cancel-lookup'},
    );
  }],
  ['OpenAI function tools', (definitions, _registry, signal) => {
    const tools = createOpenAIToolsFromMcpDefinitions(definitions) as any[];
    const lookupTool = tools.find(tool => tool.name === 'lookup_sql_schema');
    return lookupTool.invoke(
      {context: {signal}},
      '{"keyword":"frame"}',
      {signal, toolCall: {id: 'openai-cancel-lookup'}},
    );
  }],
  ['Pi Agent Core', (definitions, _registry, signal) => {
    const allowedToolNames = new Set(definitions.map(definition => definition.name));
    const definition = definitions.find(item => item.name === 'lookup_sql_schema')!;
    const tool = createPiAgentCoreToolFromSharedSpec(definition.shared, {
      allowedToolNames,
      runtimeKind: 'pi-agent-core',
    });
    return tool.execute('pi-cancel-lookup', {keyword: 'frame'}, signal);
  }],
  ['OpenCode bridge', (definitions, _registry, signal) =>
    dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-cancel-lookup',
      method: 'tools/call',
      params: {name: 'lookup_sql_schema', arguments: {keyword: 'frame'}},
    }, undefined, {getSignal: () => signal})],
  ['Qoder SDK MCP', (_definitions, registry, signal) => {
    const registered = sdkToolsByName(registry);
    return registered.lookup_sql_schema.handler(
      {keyword: 'frame'},
      {runtime: 'qoder-agent-sdk', signal, toolCallId: 'qoder-cancel-lookup'},
    );
  }],
];

async function expectConcurrentSafeReads(
  invoke: (definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => [Promise<unknown>, Promise<unknown>],
): Promise<void> {
  const {definitions, registry, started, lookupGate, modulesGate} = createCoordinatedDefinitions();
  const [lookup, modules] = invoke(definitions, registry);

  await flushPromises();
  expect(started).toHaveLength(2);

  modulesGate.resolve('modules-result');
  lookupGate.resolve('lookup-result');
  await expect(Promise.all([lookup, modules])).resolves.toEqual([
    expect.anything(),
    expect.anything(),
  ]);
}

describe('runtime tool concurrency adapter boundaries', () => {
  it('lets Claude SDK MCP handlers overlap admitted safe reads', async () => {
    await expectConcurrentSafeReads((_definitions, registry) => {
      const registered = sdkToolsByName(registry);
      return [
        registered.lookup_sql_schema.handler({keyword: 'frame'}, {toolCallId: 'claude-1'}),
        registered.list_stdlib_modules.handler({namespace: 'android'}, {toolCallId: 'claude-2'}),
      ];
    });
  });

  it('lets OpenAI function tools overlap admitted safe reads and preserves model order', async () => {
    const {definitions, started, lookupGate, modulesGate} = createCoordinatedDefinitions();
    const tools = createOpenAIToolsFromMcpDefinitions(definitions) as any[];
    const lookupTool = tools.find(tool => tool.name === 'lookup_sql_schema');
    const modulesTool = tools.find(tool => tool.name === 'list_stdlib_modules');

    const lookup = lookupTool.invoke({context: {}}, '{"keyword":"frame"}', {toolCall: {id: 'openai-1'}});
    const modules = modulesTool.invoke({context: {}}, '{"namespace":"android"}', {toolCall: {id: 'openai-2'}});
    await flushPromises();
    expect(started).toEqual([
      'openai-agents-sdk:lookup_sql_schema',
      'openai-agents-sdk:list_stdlib_modules',
    ]);

    modulesGate.resolve('modules-result');
    lookupGate.resolve('lookup-result');
    await expect(Promise.all([lookup, modules])).resolves.toEqual([
      'lookup-result',
      'modules-result',
    ]);
  });

  it('lets Pi Agent Core tools overlap admitted safe reads', async () => {
    await expectConcurrentSafeReads((definitions) => {
      const allowedToolNames = new Set(definitions.map(definition => definition.name));
      const tools = definitions.map(definition => createPiAgentCoreToolFromSharedSpec(definition.shared, {
        allowedToolNames,
        runtimeKind: 'pi-agent-core',
      }));
      return [
        tools[0].execute('pi-1', {keyword: 'frame'}, undefined),
        tools[1].execute('pi-2', {namespace: 'android'}, undefined),
      ];
    });
  });

  it('lets OpenCode bridge calls overlap admitted safe reads and keeps JSON-RPC ids stable', async () => {
    const {definitions, started, lookupGate, modulesGate} = createCoordinatedDefinitions();
    const lookup = dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-1',
      method: 'tools/call',
      params: {name: 'lookup_sql_schema', arguments: {keyword: 'frame'}},
    });
    const modules = dispatchOpenCodeBridgeRequest(definitions, {
      jsonrpc: '2.0',
      id: 'rpc-2',
      method: 'tools/call',
      params: {name: 'list_stdlib_modules', arguments: {namespace: 'android'}},
    });

    await flushPromises();
    expect(started).toEqual([
      'opencode:lookup_sql_schema',
      'opencode:list_stdlib_modules',
    ]);

    modulesGate.resolve('modules-result');
    lookupGate.resolve('lookup-result');
    await expect(Promise.all([lookup, modules])).resolves.toEqual([
      expect.objectContaining({id: 'rpc-1', result: textResult('lookup-result')}),
      expect.objectContaining({id: 'rpc-2', result: textResult('modules-result')}),
    ]);
  });

  it('passes the real OpenCode JSON-RPC id into shared tool timing as toolCallId', async () => {
    let observedToolCallId: string | undefined;
    const registry = new McpToolRegistry();
    registry.registerShared({
      name: 'lookup_sql_schema',
      description: 'OpenCode id test',
      exposure: 'public',
      inputSchema: {keyword: z.string().optional()},
      concurrency: {mode: 'commutative_read'},
      handler: async (_args, extra) => {
        observedToolCallId = extra.toolCallId;
        return textResult('ok');
      },
    });

    await dispatchOpenCodeBridgeRequest(registry.list(), {
      jsonrpc: '2.0',
      id: 'rpc-real-tool-call-id',
      method: 'tools/call',
      params: {name: 'lookup_sql_schema', arguments: {keyword: 'frame'}},
    });

    expect(observedToolCallId).toBe('rpc-real-tool-call-id');
  });

  it('keeps registry-bound RunManifest timing on the correct run when a stale extra sink is supplied', async () => {
    const boundRecorder = createRuntimePerformanceRecorder();
    const staleRecorder = createRuntimePerformanceRecorder();
    const boundSink = createNoopAttributionSink(boundRecorder, 'run-registry-bound');
    const staleSink = createNoopAttributionSink(staleRecorder, 'run-registry-stale');
    let observedRunId: string | undefined;
    const registry = new McpToolRegistry({runManifestAttributionSink: boundSink});
    registry.registerShared({
      name: 'lookup_sql_schema',
      description: 'Registry sink test',
      exposure: 'public',
      inputSchema: {keyword: z.string().optional()},
      concurrency: {mode: 'commutative_read'},
      handler: async (_args, extra) => {
        observedRunId = extra.runManifestAttributionSink?.identity.runId;
        return textResult('ok');
      },
    });

    await registry.list()[0].shared.handler(
      {keyword: 'frame'},
      {toolCallId: 'raw-stale-extra-id', runManifestAttributionSink: staleSink},
    );

    expect(observedRunId).toBe('run-registry-bound');
    expect(boundRecorder.seal().tools).toHaveLength(1);
    expect(staleRecorder.seal().tools).toEqual([]);
  });

  it.each(adapterPairCases)(
    'preserves %s result order when safe reads complete out of order',
    async (_name, invoke) => {
      const {definitions, registry, lookupGate, modulesGate} = createCoordinatedDefinitions();
      const [lookup, modules] = invoke(definitions, registry);
      await flushPromises();

      modulesGate.resolve('modules-result');
      lookupGate.resolve('lookup-result');

      const results = await Promise.all([lookup, modules]);
      expect(results.map(extractResultText)).toEqual([
        expect.stringContaining('lookup-result'),
        expect.stringContaining('modules-result'),
      ]);
    },
  );

  it.each(adapterFallbackCases)(
    'records %s scheduler wait, effective exclusive mode, and fallback reason for non-admitted reads',
    async (_name, invoke) => {
      let now = 100;
      const runtimePerformanceRecorder = createRuntimePerformanceRecorder({now: () => now});
      const registry = new McpToolRegistry({
        toolConcurrencyCoordinator: createRuntimeToolConcurrencyCoordinator({now: () => now}),
        runManifestAttributionSink: createNoopAttributionSink(runtimePerformanceRecorder),
      } as any);
      const {definitions, started, writerGate, demotedGate} =
        createFallbackDefinitions(runtimePerformanceRecorder, registry);

      const [writer, demoted] = invoke(definitions, registry);
      await flushPromises();
      expect(started).toHaveLength(1);
      now = 123;
      writerGate.resolve('writer-result');
      await expect(writer).resolves.toEqual(expect.anything());
      await flushPromises();
      expect(started).toHaveLength(2);
      demotedGate.resolve('demoted-result');
      await expect(demoted).resolves.toEqual(expect.anything());

      const receipt = runtimePerformanceRecorder.seal();
      expect(receipt.tools).toEqual([
        expect.objectContaining({
          mode: 'exclusive',
          schedulerWaitMs: 0,
        }),
        expect.objectContaining({
          mode: 'exclusive',
          schedulerWaitMs: 23,
          fallbackReason: 'commutative_read_not_admitted',
        }),
      ]);
    },
  );

  it.each(adapterLookupCases)(
    'cancels queued %s safe reads without starting the aborted handler or leaking queue state',
    async (_name, invoke) => {
      const registry = new McpToolRegistry();
      const writerGate = createDeferred<string>();
      registry.registerShared({
        name: 'execute_sql',
        description: 'Queue blocker',
        exposure: 'public',
        inputSchema: {},
        handler: async () => textResult(await writerGate.promise),
      });
      const {definitions, started, lookupGate} = createCoordinatedDefinitions(registry);
      const abort = new AbortController();
      const registered = sdkToolsByName(registry);
      const writer = registered.execute_sql.handler({}, {toolCallId: 'writer'});
      await flushPromises();

      const lookup = invoke(definitions, registry, abort.signal);
      abort.abort();
      await flushPromises();

      expect(started).toEqual([]);
      writerGate.resolve('writer-result');
      await expect(writer).resolves.toEqual(expect.anything());
      const cancelled = await Promise.allSettled([lookup]);
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].status).toMatch(/fulfilled|rejected/);

      const afterCancel = registered.lookup_sql_schema.handler(
        {keyword: 'after-cancel'},
        {toolCallId: 'after-cancel'},
      );
      await flushPromises();
      lookupGate.resolve('after-cancel-result');
      await expect(afterCancel).resolves.toEqual(expect.anything());
    },
  );

  it('keeps the Qoder SDK MCP server path on the same coordinated shared handlers', async () => {
    await expectConcurrentSafeReads((_definitions, registry) => {
      const registered = sdkToolsByName(registry);
      return [
        registered.lookup_sql_schema.handler({keyword: 'frame'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-1'}),
        registered.list_stdlib_modules.handler({namespace: 'android'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-2'}),
      ];
    });
  });

  it.each([
    ['Claude SDK MCP', (definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => {
      const registered = sdkToolsByName(registry);
      return [
        registered.lookup_sql_schema.handler({keyword: 'frame'}, {toolCallId: 'claude-rollback-1'}),
        registered.list_stdlib_modules.handler({namespace: 'android'}, {toolCallId: 'claude-rollback-2'}),
      ];
    }],
    ['OpenAI function tools', (definitions: readonly McpToolDefinition[]) => {
      const tools = createOpenAIToolsFromMcpDefinitions(definitions) as any[];
      const lookupTool = tools.find(tool => tool.name === 'lookup_sql_schema');
      const modulesTool = tools.find(tool => tool.name === 'list_stdlib_modules');
      return [
        lookupTool.invoke({context: {}}, '{"keyword":"frame"}', {toolCall: {id: 'openai-rollback-1'}}),
        modulesTool.invoke({context: {}}, '{"namespace":"android"}', {toolCall: {id: 'openai-rollback-2'}}),
      ];
    }],
    ['Pi Agent Core', (definitions: readonly McpToolDefinition[]) => {
      const allowedToolNames = new Set(definitions.map(definition => definition.name));
      const tools = definitions.map(definition => createPiAgentCoreToolFromSharedSpec(definition.shared, {
        allowedToolNames,
        runtimeKind: 'pi-agent-core',
      }));
      return [
        tools[0].execute('pi-rollback-1', {keyword: 'frame'}, undefined),
        tools[1].execute('pi-rollback-2', {namespace: 'android'}, undefined),
      ];
    }],
    ['OpenCode bridge', (definitions: readonly McpToolDefinition[]) => [
      dispatchOpenCodeBridgeRequest(definitions, {
        jsonrpc: '2.0',
        id: 'rpc-rollback-1',
        method: 'tools/call',
        params: {name: 'lookup_sql_schema', arguments: {keyword: 'frame'}},
      }),
      dispatchOpenCodeBridgeRequest(definitions, {
        jsonrpc: '2.0',
        id: 'rpc-rollback-2',
        method: 'tools/call',
        params: {name: 'list_stdlib_modules', arguments: {namespace: 'android'}},
      }),
    ]],
    ['Qoder SDK MCP', (_definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => {
      const registered = sdkToolsByName(registry);
      return [
        registered.lookup_sql_schema.handler({keyword: 'frame'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-rollback-1'}),
        registered.list_stdlib_modules.handler({namespace: 'android'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-rollback-2'}),
      ];
    }],
  ] as Array<[string, (definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => [Promise<unknown>, Promise<unknown>]]>)(
    'forces %s safe reads back through the exclusive path when the rollback flag is false',
    async (_name, invoke) => {
      const coordinator = createRuntimeToolConcurrencyCoordinator({
        env: {
          SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES: 'task5',
          [SMARTPERFETTO_SAFE_TOOL_CONCURRENCY_ENV]: 'false',
        },
      });
      const registry = new McpToolRegistry({toolConcurrencyCoordinator: coordinator});
      const {definitions, started, lookupGate, modulesGate} = createCoordinatedDefinitions(registry);
      const [lookup, modules] = invoke(definitions, registry);

      await flushPromises();
      expect(started).toHaveLength(1);

      lookupGate.resolve('lookup-result');
      await expect(lookup).resolves.toEqual(expect.anything());
      await flushPromises();
      expect(started).toHaveLength(2);

      modulesGate.resolve('modules-result');
      await expect(modules).resolves.toEqual(expect.anything());
    },
  );

  it.each([
    ['Claude SDK MCP', (definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => {
      const registered = sdkToolsByName(registry);
      return [
        registered.lookup_sql_schema.handler({keyword: 'frame'}, {toolCallId: 'claude-mixed-1'}),
        registered.execute_sql.handler({query: 'select 1'}, {toolCallId: 'claude-mixed-2'}),
        registered.list_stdlib_modules.handler({namespace: 'android'}, {toolCallId: 'claude-mixed-3'}),
      ];
    }],
    ['OpenAI function tools', (definitions: readonly McpToolDefinition[]) => {
      const tools = createOpenAIToolsFromMcpDefinitions(definitions) as any[];
      const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
      return [
        byName.lookup_sql_schema.invoke({context: {}}, '{"keyword":"frame"}', {toolCall: {id: 'openai-mixed-1'}}),
        byName.execute_sql.invoke({context: {}}, '{"query":"select 1"}', {toolCall: {id: 'openai-mixed-2'}}),
        byName.list_stdlib_modules.invoke({context: {}}, '{"namespace":"android"}', {toolCall: {id: 'openai-mixed-3'}}),
      ];
    }],
    ['Pi Agent Core', (definitions: readonly McpToolDefinition[]) => {
      const allowedToolNames = new Set(definitions.map(definition => definition.name));
      const byName = Object.fromEntries(definitions.map(definition => [
        definition.name,
        createPiAgentCoreToolFromSharedSpec(definition.shared, {
          allowedToolNames,
          runtimeKind: 'pi-agent-core',
        }),
      ]));
      return [
        byName.lookup_sql_schema.execute('pi-mixed-1', {keyword: 'frame'}, undefined),
        byName.execute_sql.execute('pi-mixed-2', {query: 'select 1'}, undefined),
        byName.list_stdlib_modules.execute('pi-mixed-3', {namespace: 'android'}, undefined),
      ];
    }],
    ['OpenCode bridge', (definitions: readonly McpToolDefinition[]) => [
      dispatchOpenCodeBridgeRequest(definitions, {
        jsonrpc: '2.0',
        id: 'rpc-mixed-1',
        method: 'tools/call',
        params: {name: 'lookup_sql_schema', arguments: {keyword: 'frame'}},
      }),
      dispatchOpenCodeBridgeRequest(definitions, {
        jsonrpc: '2.0',
        id: 'rpc-mixed-2',
        method: 'tools/call',
        params: {name: 'execute_sql', arguments: {query: 'select 1'}},
      }),
      dispatchOpenCodeBridgeRequest(definitions, {
        jsonrpc: '2.0',
        id: 'rpc-mixed-3',
        method: 'tools/call',
        params: {name: 'list_stdlib_modules', arguments: {namespace: 'android'}},
      }),
    ]],
    ['Qoder SDK MCP', (_definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => {
      const registered = sdkToolsByName(registry);
      return [
        registered.lookup_sql_schema.handler({keyword: 'frame'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-mixed-1'}),
        registered.execute_sql.handler({query: 'select 1'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-mixed-2'}),
        registered.list_stdlib_modules.handler({namespace: 'android'}, {runtime: 'qoder-agent-sdk', toolCallId: 'qoder-mixed-3'}),
      ];
    }],
  ] as Array<[string, (definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => [Promise<unknown>, Promise<unknown>, Promise<unknown>]]>)(
    'keeps %s mixed safe/exclusive batches fair and serializes later reads behind the writer',
    async (_name, invoke) => {
      const {definitions, registry, started, lookupGate, writerGate, modulesGate} = createMixedDefinitions();
      const [lookup, writer, modules] = invoke(definitions, registry);

      await flushPromises();
      expect(started).toHaveLength(1);
      expect(started[0]).toContain('lookup_sql_schema');

      lookupGate.resolve('lookup-result');
      await expect(lookup).resolves.toEqual(expect.anything());
      await flushPromises();
      expect(started).toHaveLength(2);
      expect(started[1]).toContain('execute_sql');

      writerGate.resolve('writer-result');
      await expect(writer).resolves.toEqual(expect.anything());
      await flushPromises();
      expect(started).toHaveLength(3);
      expect(started[2]).toContain('list_stdlib_modules');

      modulesGate.resolve('modules-result');
      await expect(modules).resolves.toEqual(expect.anything());
    },
  );
});
