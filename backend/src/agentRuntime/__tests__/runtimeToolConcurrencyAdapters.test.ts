// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {z} from 'zod';

import {McpToolRegistry, type McpToolDefinition, type RuntimeAcquisitionPolicy} from '../../agentv3/mcpToolRegistry';
import {createOpenAIToolsFromMcpDefinitions} from '../engines/openai/openAiToolAdapter';
import {createPiAgentCoreToolFromSharedSpec} from '../engines/pi/piAgentCoreRuntime';
import {createClaudeSdkToolFromSharedSpec} from '../engines/claude/claudeSdkTools';
import {createRuntimePerformanceScope} from '../runtimePerformanceContext';
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
import {createRuntimeToolResult} from '../runtimeToolResult';
import {RuntimeToolResultAuditRecorder} from '../runtimeToolResultAudit';

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
    registry.list().map(definition => [definition.name, createClaudeSdkToolFromSharedSpec(definition.shared)]),
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

  it('keeps registry-bound attribution but suppresses observations when a stale extra sink is supplied', async () => {
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
    expect(boundRecorder.seal().tools).toEqual([]);
    expect(boundRecorder.activitySnapshot().observation).toBe('partial');
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

  it.each([
    ['Claude SDK MCP', (_definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => {
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
    ['Claude SDK MCP', (_definitions: readonly McpToolDefinition[], registry: McpToolRegistry) => {
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

describe('tool-result handoff audit at the outermost registry boundary', () => {
  const REMINDER = 'Pacing reminder: submit the scene timeline soon.';

  function createAuditedRegistry(handler: SharedToolSpec['handler']) {
    const toolResultAuditRecorder = new RuntimeToolResultAuditRecorder();
    const sink = {...createNoopAttributionSink(), toolResultAuditRecorder};
    const acquisitionPolicy: RuntimeAcquisitionPolicy = {
      admit: () => undefined,
      complete: (_toolName, result) => ({
        ...result,
        content: (result.content as Array<{type: 'text'; text: string}>).map(block => ({
          ...block, text: `${block.text}\n\n${REMINDER}`,
        })),
      }),
    };
    const registry = new McpToolRegistry({runManifestAttributionSink: sink, acquisitionPolicy} as any);
    registry.registerShared({
      name: 'invoke_skill',
      description: 'audited acquisition tool',
      exposure: 'public',
      inputSchema: {skillId: z.string().optional()},
      evidenceEffect: 'acquire',
      handler,
    });
    return {registry, definitions: registry.list(), toolResultAuditRecorder};
  }

  const skillResult = () => createRuntimeToolResult({
    success: true,
    skillId: 'startup_analysis',
    rows: 'x'.repeat(4_000),
    vendorOverride: {vendor: 'xiaomi', displayName: 'Xiaomi', additionalStepIds: ['a']},
  }, {facts: {success: true, planPhaseId: 'p1'}});

  // Claude ids are injected here; its in-process SDK handler may not supply one.
  const invokers: Array<[string, (definitions: readonly McpToolDefinition[], registry: McpToolRegistry,
    signal?: AbortSignal) => Promise<unknown>]> = [
    ['Claude SDK MCP', (_definitions, registry, signal) =>
      sdkToolsByName(registry).invoke_skill.handler({skillId: 'startup_analysis'}, {signal, toolCallId: 'call-claude'})],
    ['OpenAI function tools', (definitions, _registry, signal) => {
      const tool = (createOpenAIToolsFromMcpDefinitions(definitions) as any[])[0];
      return tool.invoke({context: {signal}}, '{"skillId":"startup_analysis"}', {signal, toolCall: {id: 'call-openai'}});
    }],
    ['Pi Agent Core', (definitions, _registry, signal) => createPiAgentCoreToolFromSharedSpec(definitions[0].shared, {
      allowedToolNames: new Set(['invoke_skill']),
      runtimeKind: 'pi-agent-core',
    }).execute('call-pi', {skillId: 'startup_analysis'}, signal)],
  ];

  it.each(invokers)('records one %s handoff that includes wrapper-added text', async (_name, invoke) => {
    const {registry, definitions, toolResultAuditRecorder} = createAuditedRegistry(async () => skillResult());
    await invoke(definitions, registry);

    const {results} = toolResultAuditRecorder.seal();
    expect(results).toHaveLength(1);
    const expectedText = `${skillResult().content[0].text}\n\n${REMINDER}`;
    expect(results[0]).toEqual({
      toolName: 'invoke_skill',
      toolCallId: expect.stringMatching(/^call-/),
      skillId: 'startup_analysis',
      outcome: 'returned',
      facts: {success: true, planPhaseIdPresent: true},
      content: {textBlocks: 1, otherBlocks: 0, chars: expectedText.length, bytes: expectedText.length},
      payloadFields: {vendorOverride: 'verbatim'},
      vendorOverride: {vendor: 'xiaomi', additionalStepCount: 1},
    });
  });

  it('records a cancelled call and a throwing call without a result', async () => {
    const abort = new AbortController();
    const cancelled = createAuditedRegistry(async () => {
      abort.abort();
      return skillResult();
    });
    await sdkToolsByName(cancelled.registry).invoke_skill.handler({}, {signal: abort.signal, toolCallId: 'call-c'})
      .catch(() => undefined);
    expect(cancelled.toolResultAuditRecorder.seal().results).toEqual([
      expect.objectContaining({toolName: 'invoke_skill', toolCallId: 'call-c', outcome: 'cancelled'}),
    ]);

    const throwing = createAuditedRegistry(async () => {
      throw new Error('handler exploded');
    });
    await expect(sdkToolsByName(throwing.registry).invoke_skill.handler({}, {toolCallId: 'call-t'}))
      .rejects.toThrow('handler exploded');
    expect(throwing.toolResultAuditRecorder.seal().results)
      .toEqual([{toolName: 'invoke_skill', toolCallId: 'call-t', outcome: 'threw'}]);
  });
});


describe('shared invocation activity across runtime adapters', () => {
  it.each(adapterLookupCases)('%s counts exact repeated calls at the shared handoff boundary', async (_name, invoke) => {
    const recorder = createRuntimePerformanceRecorder();
    const registry = new McpToolRegistry({runManifestAttributionSink: createNoopAttributionSink(recorder)});
    registry.registerShared({name: 'lookup_sql_schema', description: 'Read schema', exposure: 'public',
      inputSchema: {keyword: z.string()}, handler: async () => createRuntimeToolResult({success: true, value: 'private'})});
    await invoke(registry.list(), registry);
    await invoke(registry.list(), registry);
    expect(recorder.activitySnapshot()).toMatchObject({observation: 'observed', attempted: 2, dispatched: 2,
      returned: 2, succeeded: 2, repeatedExactCalls: 1, inFlight: 0});
    expect(JSON.stringify(recorder.activitySnapshot())).not.toContain('private');
  });

  it.each(adapterLookupCases)('%s keeps no-manifest callbacks bound when transport loses async context', async (_name, invoke) => {
    const recorder = createRuntimePerformanceRecorder();
    const scope = createRuntimePerformanceScope({identity: {runId: 'private-run', sessionId: 'private-session',
      scope: {tenantId: 'tenant', workspaceId: 'workspace'}}, recorder, assertCurrent() {}});
    const registry = scope.run(() => {
      const registry = new McpToolRegistry();
      registry.registerShared({name: 'lookup_sql_schema', description: 'Read', exposure: 'public',
        inputSchema: {keyword: z.string()}, handler: async () => createRuntimeToolResult({success: true})});
      return registry;
    });
    await invoke(registry.list(), registry);
    expect(recorder.activitySnapshot()).toMatchObject({observation: 'observed', attempted: 1, returned: 1});
    scope.dispose();
    const sealed = recorder.seal();
    await invoke(registry.list(), registry);
    expect(recorder.seal()).toBe(sealed);
    expect(sealed.activity?.attempted).toBe(1);
  });

  it('observes repeated acquisition refusals without treating them as handler execution or malfunction', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const handler = jest.fn(async () => createRuntimeToolResult({success: true}));
    const registry = new McpToolRegistry({runManifestAttributionSink: createNoopAttributionSink(recorder),
      canInvokeTool: () => false});
    registry.registerShared({name: 'execute_sql', description: 'SQL', exposure: 'public', evidenceEffect: 'acquire',
      inputSchema: {query: z.string()}, handler});
    const tool = registry.list()[0].shared;
    await tool.handler({query: 'private'}, {});
    await tool.handler({query: 'private'}, {});
    expect(handler).not.toHaveBeenCalled();
    expect(recorder.activitySnapshot()).toMatchObject({attempted: 2, refused: 2, failed: 0,
      succeeded: 0, repeatedExactCalls: 1});
  });

  it('observes authorization rejection without invoking the handler or manufacturing success', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const denied = new Error('authorization_revoked');
    const handler = jest.fn(async () => createRuntimeToolResult({success: true}));
    const reject = (): never => {throw denied;};
    const registry = new McpToolRegistry({runManifestAttributionSink: createNoopAttributionSink(recorder),
      runAuthorization: {enforced: true, assertCurrent: reject, assertCurrentInTurn: reject, revoke: reject,
        settled: async () => undefined}});
    registry.registerShared({name: 'lookup_sql_schema', description: 'read', exposure: 'public', inputSchema: {}, handler});
    await expect(registry.list()[0].shared.handler({}, {})).rejects.toBe(denied);
    expect(handler).not.toHaveBeenCalled();
    expect(recorder.activitySnapshot()).toMatchObject({attempted: 1, threw: 1, returned: 0, succeeded: 0});
  });

  it('records cancellation while queued separately from entering the execution callback', async () => {
    const recorder = createRuntimePerformanceRecorder();
    const registry = new McpToolRegistry({runManifestAttributionSink: createNoopAttributionSink(recorder)});
    const gate = createDeferred();
    registry.registerShared({name: 'execute_sql', description: 'SQL', exposure: 'public',
      inputSchema: {}, handler: async () => {await gate.promise; return createRuntimeToolResult({success: true});}});
    const tool = registry.list()[0].shared;
    const first = tool.handler({}, {});
    const abort = new AbortController();
    const queued = tool.handler({}, {signal: abort.signal});
    abort.abort();
    await expect(queued).rejects.toThrow();
    gate.resolve(); await first;
    expect(recorder.activitySnapshot()).toMatchObject({attempted: 2, dispatched: 1, returned: 1, cancelled: 1, inFlight: 0});
  });
});
