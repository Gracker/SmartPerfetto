// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect, jest} from '@jest/globals';
import {z} from 'zod';
import type {ClaudeSdkToolLike, RuntimeToolExtra} from '../../agentRuntime/runtimeToolSpec';
import type {RuntimeToolInvocationEvent} from '../../agentRuntime/runtimeToolObserver';
import * as runtimeToolSpec from '../../agentRuntime/runtimeToolSpec';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {recordPlanOrPrePlanToolCall} from '../planToolCallRecorder';
import {isPolicyRefusalResult} from '../toolNarration';
import type {AnalysisPlanV3} from '../types';

import {
  McpToolRegistry,
  MCP_NAME_PREFIX,
  buildAllowedTools,
  filterByExposure,
  type McpToolDefinition,
  type McpToolRegistration,
  isToolAllowedForScope,
} from '../mcpToolRegistry';

/** Stub SDK tool object with the shape returned by Claude SDK `tool(...)`. */
function stub(name: string): unknown {
  return {
    name,
    description: `${name} description`,
    inputSchema: {q: z.string().optional()},
    annotations: {readOnlyHint: true},
    handler: async (args: Record<string, unknown>) => ({
      content: [{type: 'text' as const, text: JSON.stringify(args)}],
    }),
  };
}

describe('McpToolRegistry — basic registration', () => {
  it('closes held descriptors before execution without turning the refusal into a tool failure', async () => {
    let active = true;
    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    const registry = new McpToolRegistry({canInvokeTool: () => active});
    registry.registerShared({name: 'retained', description: 'read', inputSchema: {}, handler: body,
      exposure: 'public', evidenceEffect: 'read_existing'});
    const held = registry.list()[0].shared;
    await held.handler({}, {});
    active = false;
    const refused = await held.handler({}, {});
    expect(body).toHaveBeenCalledTimes(1);
    expect(isPolicyRefusalResult(refused)).toBe(true);
    expect(refused.structuredContent).toMatchObject({unsupportedReason: 'acquisition_closed'});
  });

  it('checks the run authorization before a tool runs and again before its result is handed back', async () => {
    const revoke = new Error('analysis_context_changed_restart_required');
    let checks = 0;
    let revokeAt = Infinity;
    const check = jest.fn(() => { if (++checks >= revokeAt) throw revoke; });
    const authorization = {enforced: true, assertCurrent: check, assertCurrentInTurn: check,
      revoke: (): never => { throw revoke; }, settled: async () => undefined};
    // The body reads a source file; consent is withdrawn while it runs.
    const body = jest.fn(async () => { revokeAt = checks + 1; return createRuntimeToolResult({success: true, text: 'body'}); });
    const registry = new McpToolRegistry({runAuthorization: authorization});
    registry.registerShared({name: 'read_codebase_file', description: 'read', inputSchema: {}, handler: body,
      exposure: 'public', evidenceEffect: 'read_existing'});
    const tool = registry.list()[0].shared;
    await expect(tool.handler({}, {})).rejects.toBe(revoke);
    expect(body).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(2);
    // Once revoked, the next call never reaches its body.
    await expect(tool.handler({}, {})).rejects.toBe(revoke);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('wraps no tool for a run whose fence is not enforced', async () => {
    const authorization = {enforced: false, assertCurrent: jest.fn(), assertCurrentInTurn: jest.fn(),
      revoke: (): never => { throw new Error('unused'); }, settled: async () => undefined};
    const registry = new McpToolRegistry({runAuthorization: authorization});
    registry.registerShared({name: 'execute_sql', description: 'sql', inputSchema: {},
      handler: async () => createRuntimeToolResult({success: true}), exposure: 'public', evidenceEffect: 'acquire'});
    await registry.list()[0].shared.handler({}, {});
    expect(authorization.assertCurrentInTurn).not.toHaveBeenCalled();
  });

  it('fails a call whose own check saw the revoke only after the run cancel settled', async () => {
    const revoke = new Error('analysis_context_changed_restart_required');
    let finish!: () => void;
    const cancelled = new Promise<void>(resolve => { finish = resolve; });
    // The wrapper's checks pass; the tool's own private-context check sees the revoke.
    const authorization = {enforced: true, assertCurrent: () => undefined, assertCurrentInTurn: () => undefined,
      revoke: (): never => { throw revoke; }, settled: () => cancelled};
    const registry = new McpToolRegistry({runAuthorization: authorization});
    registry.registerShared({name: 'read_codebase_file', description: 'read', inputSchema: {},
      handler: async () => { throw revoke; }, exposure: 'public', evidenceEffect: 'read_existing'});
    let outcome: unknown;
    const call = registry.list()[0].shared.handler({}, {}).catch(error => { outcome = error; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(outcome).toBeUndefined();
    finish();
    await call;
    expect(outcome).toBe(revoke);
  });

  it('fails a revoked tool call only after the run cancel settled', async () => {
    const revoke = new Error('analysis_context_changed_restart_required');
    let finish!: () => void;
    const cancelled = new Promise<void>(resolve => { finish = resolve; });
    const authorization = {enforced: true, assertCurrent: (): never => { throw revoke; },
      assertCurrentInTurn: (): never => { throw revoke; }, revoke: (): never => { throw revoke; }, settled: () => cancelled};
    const registry = new McpToolRegistry({runAuthorization: authorization});
    registry.registerShared({name: 'read_codebase_file', description: 'read', inputSchema: {},
      handler: async () => createRuntimeToolResult({success: true}), exposure: 'public', evidenceEffect: 'read_existing'});
    let outcome: unknown;
    const call = registry.list()[0].shared.handler({}, {}).catch(error => { outcome = error; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(outcome).toBeUndefined();
    finish();
    await call;
    expect(outcome).toBe(revoke);
  });

  it('rechecks acquisition after waiting behind an already running tool', async () => {
    let active = true;
    let release!: () => void;
    let admitted!: () => void;
    const started = new Promise<void>(resolve => {admitted = resolve;});
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const body = jest.fn(async () => {admitted(); await blocked; return createRuntimeToolResult({success: true});});
    const registry = new McpToolRegistry({canInvokeTool: () => active});
    registry.registerShared({name: 'serial', description: 'serial evidence', inputSchema: {}, handler: body,
      exposure: 'public', evidenceEffect: 'acquire'});
    const held = registry.list()[0].shared;
    const first = held.handler({}, {});
    await started;
    const queued = held.handler({}, {});
    active = false;
    release();
    await first;
    expect(isPolicyRefusalResult(await queued)).toBe(true);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('register preserves insertion order', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'invoke_skill', 'public');
    registry.registerSdk(stub('c'), 'submit_plan', 'internal');

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('execute_sql');
    expect(list[1].name).toBe('invoke_skill');
    expect(list[2].name).toBe('submit_plan');
  });

  it('does not deduplicate by name — call sites control uniqueness', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'dup', 'public');
    registry.registerSdk(stub('b'), 'dup', 'public');
    expect(registry.size()).toBe(2);
  });

  it('register accepts a full McpToolDefinition with summary + requires', () => {
    const registry = new McpToolRegistry();
    const def: McpToolRegistration = {
      tool: stub('x'),
      name: 'execute_sql',
      exposure: 'public',
      summary: 'Run SQL on the active trace.',
      requires: ['traceProcessor'],
    };
    registry.register(def);
    const aci = registry.getAci();
    expect(aci[0].summary).toBe('Run SQL on the active trace.');
    expect(aci[0].requires).toEqual(['traceProcessor']);
  });
});

describe('McpToolRegistry — allowedTools shape', () => {
  it('gives every evidence-capable descriptor explicit attribution without guessing from active state', async () => {
    const registry = new McpToolRegistry({requestScope: {sessionId: 's1', hasCodebaseAccess: true}});
    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    registry.registerSdk({name: 'read_codebase_file', description: 'Read source', inputSchema: {}, handler: body},
      'read_codebase_file', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
    const definition = registry.list()[0];
    expect(z.safeParse(definition.shared.inputSchema.planPhaseId, 'p2').success).toBe(true);
    const descriptor = definition.tool;
    if (!runtimeToolSpec.isClaudeSdkToolLike(descriptor)) throw new Error('Expected SDK descriptor');
    const plan: AnalysisPlanV3 = {phases: [
      {id: 'p1', name: 'Active', goal: 'Read', expectedTools: ['read_codebase_file'], status: 'in_progress'},
      {id: 'p2', name: 'Pending', goal: 'Read', expectedTools: ['read_codebase_file'], status: 'pending'},
    ], successCriteria: 'Resolve', submittedAt: 1, toolCallLog: []};
    const tracker = {current: plan};
    const implicit = await descriptor.handler({}, {});
    expect(recordPlanOrPrePlanToolCall(tracker, {toolName: definition.name, resultFacts: readRuntimeToolResultFacts(implicit)})?.matchedPhaseId)
      .toBeUndefined();
    const input = {planPhaseId: 'p2'};
    const explicit = await descriptor.handler(input, {});
    expect(recordPlanOrPrePlanToolCall(tracker, {toolName: definition.name, input, resultFacts: readRuntimeToolResultFacts(explicit)})?.matchedPhaseId)
      .toBe('p2');
    expect(body).toHaveBeenCalledTimes(2);
  });

  it('freezes the bound scope and keeps all discovery views restrict-only', () => {
    const scope = {sessionId: 's1', hasCodebaseAccess: false, allowNewEvidence: false};
    const registry = new McpToolRegistry({requestScope: scope});
    registry.registerSdk(stub('stored'), 'stored', 'public', {evidenceEffect: 'read_existing'});
    registry.registerSdk(stub('guide'), 'guide', 'internal', {evidenceEffect: 'none'});
    registry.registerSdk(stub('new'), 'new', 'public', {evidenceEffect: 'acquire'});
    registry.registerSdk(stub('unknown'), 'unknown', 'public');
    registry.registerSdk(stub('source'), 'source', 'requires_codebase_permission', {evidenceEffect: 'none'});
    scope.allowNewEvidence = true;
    scope.hasCodebaseAccess = true;

    const expected = ['stored', 'guide'];
    for (const viewScope of [undefined, scope]) {
      expect(registry.listForRequest(viewScope).map(def => def.name)).toEqual(expected);
      expect(registry.buildAllowedTools(viewScope)).toEqual(expected.map(name => MCP_NAME_PREFIX + name));
      expect(registry.getAci(viewScope).map(def => def.toolName)).toEqual(expected);
      const server = registry.buildSdkServer({scope: viewScope}) as unknown as {instance: {tools: Array<{name: string}>}};
      expect(server.instance.tools.map(def => def.name.replace(MCP_NAME_PREFIX, ''))).toEqual(expected);
    }
    expect(registry.list().map(def => def.name)).toEqual(expected);
    expect(registry.size()).toBe(expected.length);
    expect(registry.buildPublicApiContract().tools.map(def => def.toolName)).toEqual(expected);
    expect(registry.probeCapabilities(scope).codeAwareAvailable).toBe(false);
  });

  it('allows a supplied view scope to narrow a permissive bound scope', () => {
    const registry = new McpToolRegistry({requestScope: {sessionId: 's1', hasCodebaseAccess: true}});
    registry.registerSdk(stub('new'), 'new', 'public', {evidenceEffect: 'acquire'});
    registry.registerSdk(stub('source'), 'source', 'requires_codebase_permission', {evidenceEffect: 'read_existing'});
    registry.registerSdk(stub('stored'), 'stored', 'public', {evidenceEffect: 'read_existing'});
    expect(registry.listForRequest({sessionId: 's1', hasCodebaseAccess: false, allowNewEvidence: false})
      .map(def => def.name)).toEqual(['stored']);
    expect(registry.list()).toHaveLength(3);
  });

  it('executes explicitly declared existing reads and controls without acquiring evidence', async () => {
    const registry = new McpToolRegistry({
      requestScope: {sessionId: 's1', hasCodebaseAccess: false, allowNewEvidence: false},
    });
    const result = createRuntimeToolResult({success: true, value: 'stored'});
    const body = jest.fn(async () => result);
    for (const evidenceEffect of ['none', 'read_existing', 'background'] as const) {
      registry.registerShared({
        name: evidenceEffect, description: 'Existing capability', exposure: 'public',
        inputSchema: {}, handler: body, evidenceEffect,
      });
    }
    for (const definition of registry.list()) {
      expect(definition.shared.evidenceEffect).toBe(definition.evidenceEffect);
      await expect(definition.shared.handler({}, {})).resolves.toBe(result);
    }
    expect(body).toHaveBeenCalledTimes(3);
  });

  it('never paces or observes a background read as an acquisition', async () => {
    const events: RuntimeToolInvocationEvent[] = [];
    const admit = jest.fn(() => createRuntimeToolResult({success: false, action_required: 'wait'}));
    const registry = new McpToolRegistry({
      acquisitionObserver: event => {events.push(event);},
      acquisitionPolicy: {admit},
    });
    const result = createRuntimeToolResult({success: true});
    registry.registerShared({name: 'search_knowledge', description: 'Background knowledge', exposure: 'public',
      inputSchema: {}, handler: async () => result, evidenceEffect: 'background'});
    await expect(registry.list()[0].shared.handler({}, {})).resolves.toBe(result);
    expect(admit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it.each(['acquire', undefined] as const)('rejects held shared/SDK descriptors for effect=%s before executing the body', async evidenceEffect => {
    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    const events: RuntimeToolInvocationEvent[] = [];
    const factory = jest.spyOn(runtimeToolSpec, 'createClaudeSdkToolFromSharedSpec');
    try {
      const registry = new McpToolRegistry({
        requestScope: {sessionId: 's1', hasCodebaseAccess: true, allowNewEvidence: false},
        toolObserver: event => {events.push(event);},
      });
      registry.registerSdk({name: 'held', description: 'Held tool', inputSchema: {}, handler: body},
        'held', 'public', {evidenceEffect});
      const shared = factory.mock.calls[0][0];
      const descriptor = factory.mock.results[0].value;
      if (!runtimeToolSpec.isClaudeSdkToolLike(descriptor)) throw new Error('Expected SDK descriptor');
      for (const handler of [shared.handler, descriptor.handler]) {
        const result = await handler({}, {allowNewEvidence: true});
        expect(result.isError).toBe(true);
        expect(readRuntimeToolResultFacts(result)).toEqual({success: false});
      }
      expect(registry.list()).toEqual([]);
      expect(body).not.toHaveBeenCalled();
      expect(events.map(event => event.phase)).toEqual(['started', 'completed', 'started', 'completed']);
      for (const event of events) {
        if (event.phase === 'completed') expect(readRuntimeToolResultFacts(event.result)).toEqual({success: false});
      }
    } finally {
      factory.mockRestore();
    }
  });

  it('prefixes every short name with MCP_NAME_PREFIX', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'submit_plan', 'internal');

    const allowed = registry.buildAllowedTools();
    expect(allowed).toEqual([
      `${MCP_NAME_PREFIX}execute_sql`,
      `${MCP_NAME_PREFIX}submit_plan`,
    ]);
  });

  it('filters codebase tools through request-scoped allowedTools', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'lookup_app_source', 'requires_codebase_permission');

    expect(registry.buildAllowedTools({
      sessionId: 's1',
      hasCodebaseAccess: false,
    })).toEqual([`${MCP_NAME_PREFIX}execute_sql`]);
    expect(registry.buildAllowedTools({
      sessionId: 's1',
      hasCodebaseAccess: true,
    })).toEqual([
      `${MCP_NAME_PREFIX}execute_sql`,
      `${MCP_NAME_PREFIX}lookup_app_source`,
    ]);
  });

  it('listForRequest keeps non-deprecated tools and gates code-aware tools by permission', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'submit_plan', 'internal');
    registry.registerSdk(stub('c'), 'lookup_app_source', 'requires_codebase_permission');
    registry.registerSdk(stub('d'), 'old_tool', 'deprecated');

    expect(registry.listForRequest({
      sessionId: 's1',
      hasCodebaseAccess: false,
    }).map(def => def.name)).toEqual(['execute_sql', 'submit_plan']);
    expect(registry.listForRequest({
      sessionId: 's1',
      hasCodebaseAccess: true,
    }).map(def => def.name)).toEqual(['execute_sql', 'submit_plan', 'lookup_app_source']);
  });

  it('MCP_NAME_PREFIX matches the SDK contract', () => {
    expect(MCP_NAME_PREFIX).toBe('mcp__smartperfetto__');
  });

  it('buildAllowedTools (free function) matches registry method', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('one'), 'one', 'public');
    registry.registerSdk(stub('two'), 'two', 'internal');
    const defs: readonly McpToolDefinition[] = registry.list();
    expect(buildAllowedTools(defs)).toEqual([
      `${MCP_NAME_PREFIX}one`,
      `${MCP_NAME_PREFIX}two`,
    ]);
  });

  it('keeps codebase-permission tools out of every view of a request without codebase access', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('trace'), 'execute_sql', 'public');
    registry.registerSdk(
      stub('source-search'),
      'search_codebase',
      'requires_codebase_permission',
    );
    const denied = {sessionId: 's1', hasCodebaseAccess: false};
    const allowed = {sessionId: 's1', hasCodebaseAccess: true};

    expect(registry.listForRequest(denied).map(def => def.name))
      .toEqual(['execute_sql']);
    expect(registry.buildAllowedTools(denied))
      .toEqual([`${MCP_NAME_PREFIX}execute_sql`]);
    expect(registry.listForRequest(allowed)).toContainEqual(expect.objectContaining({
      name: 'search_codebase',
    }));
    expect(registry.buildAllowedTools(allowed)).toContain(
      `${MCP_NAME_PREFIX}search_codebase`,
    );

    const deniedTools = ((registry.buildSdkServer({scope: denied}) as any).instance?.tools ?? [])
      .map((entry: {name: string}) => entry.name.replace(MCP_NAME_PREFIX, ''));
    const allowedTools = ((registry.buildSdkServer({scope: allowed}) as any).instance?.tools ?? [])
      .map((entry: {name: string}) => entry.name.replace(MCP_NAME_PREFIX, ''));
    expect(deniedTools).not.toContain('search_codebase');
    expect(allowedTools).toContain('search_codebase');
  });
});

describe('McpToolRegistry — filterByExposure', () => {
  function seed(): McpToolDefinition[] {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('execute_sql'), 'execute_sql', 'public');
    registry.registerSdk(stub('submit_plan'), 'submit_plan', 'internal');
    registry.registerSdk(stub('old_tool'), 'old_tool', 'deprecated');
    registry.registerSdk(stub('invoke_skill'), 'invoke_skill', 'public');
    return [...registry.list()];
  }

  it('returns only entries matching the requested exposures', () => {
    const out = filterByExposure(seed(), ['public']);
    expect(out.map(d => d.name)).toEqual(['execute_sql', 'invoke_skill']);
  });

  it('supports multiple exposures', () => {
    const out = filterByExposure(seed(), ['public', 'deprecated']);
    expect(out.map(d => d.name)).toEqual([
      'execute_sql',
      'old_tool',
      'invoke_skill',
    ]);
  });

  it('empty exposure list yields empty output (no implicit "all")', () => {
    expect(filterByExposure(seed(), [])).toEqual([]);
  });
});

describe('McpToolRegistry — ACI snapshot', () => {
  it('emits one entry per registered tool with prefixed qualified name', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'submit_plan', 'internal');

    const aci = registry.getAci();
    expect(aci).toHaveLength(2);
    expect(aci[0]).toMatchObject({
      toolName: 'execute_sql',
      qualifiedName: `${MCP_NAME_PREFIX}execute_sql`,
      exposure: 'public',
    });
    expect(aci[1]).toMatchObject({
      toolName: 'submit_plan',
      qualifiedName: `${MCP_NAME_PREFIX}submit_plan`,
      exposure: 'internal',
    });
  });

  it('emits empty summary by default; populates explicit summaries when given', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    registry.registerSdk(stub('b'), 'invoke_skill', 'public', {
      summary: 'Run a skill.',
    });
    const aci = registry.getAci();
    expect(aci[0].summary).toBe('');
    expect(aci[1].summary).toBe('Run a skill.');
  });

  it('hides requires_codebase_permission tools from request scopes without access', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'list_codebases', 'public-readonly');
    registry.registerSdk(stub('b'), 'lookup_app_source', 'requires_codebase_permission');

    expect(registry.getAci({
      sessionId: 's1',
      hasCodebaseAccess: false,
    }).map(tool => tool.toolName)).toEqual(['list_codebases']);
    expect(registry.getAci({
      sessionId: 's1',
      hasCodebaseAccess: true,
    }).map(tool => tool.toolName)).toEqual(['list_codebases', 'lookup_app_source']);
  });

  it('records capability probe reasons without exposing code-aware tools implicitly', () => {
    const registry = new McpToolRegistry();

    expect(registry.probeCapabilities({
      sessionId: 's1',
      hasCodebaseAccess: false,
    })).toEqual({codeAwareAvailable: false, reason: 'no_permission'});
    expect(registry.probeCapabilities({
      sessionId: 's1',
      hasCodebaseAccess: true,
    })).toEqual({codeAwareAvailable: true});
  });
});

describe('McpToolRegistry — buildPublicApiContract', () => {
  it('produces a valid McpPublicApiContract with provenance', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    const contract = registry.buildPublicApiContract({
      serverVersion: '1.2.3',
      protocolVersion: '2024-11-05',
    });
    expect(contract.schemaVersion).toBe(1);
    expect(contract.source).toBe('mcpToolRegistry');
    expect(contract.tools).toHaveLength(1);
    expect(contract.serverVersion).toBe('1.2.3');
    expect(contract.protocolVersion).toBe('2024-11-05');
    expect(contract.coverage.length).toBeGreaterThan(0);
  });

  it('falls back to default versions when not supplied', () => {
    const registry = new McpToolRegistry();
    const contract = registry.buildPublicApiContract();
    expect(contract.serverVersion).toBe('1.0.0');
    expect(contract.protocolVersion).toBe('2024-11-05');
  });
});

describe('McpToolRegistry — buildSdkServer', () => {
  it('returns an SDK server that the runtime can pass to query()', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('a'), 'execute_sql', 'public');
    const server = registry.buildSdkServer();
    // The SDK server is opaque; we only verify it's not null and has
    // a recognizable shape (the SDK's helper returns an object).
    expect(server).toBeTruthy();
    expect(typeof server).toBe('object');
  });
});

describe('McpToolRegistry — invocation observation', () => {
  it.each(['shared', 'sdk'] as const)('does not delay %s read handlers for an inapplicable acquisition observer', async surface => {
    const events: RuntimeToolInvocationEvent[] = [];
    const registry = new McpToolRegistry({acquisitionObserver: event => {events.push(event);}});
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    registry.registerShared({name: 'existing_read', description: 'Read existing evidence', exposure: 'public',
      evidenceEffect: 'read_existing', inputSchema: {}, handler: async () => {
        started.push('body'); await gate; return {content: []};
      }});
    const definition = registry.list()[0];
    const handler = surface === 'shared' ? definition.shared.handler : (definition.tool as ClaudeSdkToolLike).handler;
    const pending = handler({}, {});
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(started).toEqual(['body']);
      expect(events).toEqual([]);
    } finally {release(); await pending;}
  });

  it('observes actual shared and SDK handlers with one stable ID per identical invocation', async () => {
    const events: RuntimeToolInvocationEvent[] = [];
    const result = {content: [{type: 'text' as const, text: 'unstructured result'}]};
    const handler = jest.fn(async (_params: Record<string, unknown>, _extra: RuntimeToolExtra) => result);
    const registry = new McpToolRegistry({toolObserver: event => {events.push(event);}});
    registry.registerShared({
      name: 'execute_sql', description: 'Execute SQL', exposure: 'public', inputSchema: {}, handler,
    });
    const definition = registry.list()[0];
    const sdkTool = definition.tool as ClaudeSdkToolLike;
    const params = {sql: 'select 1'};

    await expect(definition.shared.handler(params, {toolCallId: 'unknown'})).resolves.toBe(result);
    await expect(sdkTool.handler(params, {toolCallId: 'unknown'})).resolves.toBe(result);
    await expect(sdkTool.handler(params, {toolCallId: 'sdk-call-3'})).resolves.toBe(result);

    expect(events.map(event => event.phase)).toEqual([
      'started', 'completed', 'started', 'completed', 'started', 'completed',
    ]);
    const ids = events.filter(event => event.phase === 'started').map(event => event.toolCallId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('unknown');
    expect(ids[2]).toBe('sdk-call-3');
    for (let invocation = 0; invocation < 3; invocation += 1) {
      expect(events[invocation * 2 + 1]).toMatchObject({
        phase: 'completed', toolCallId: ids[invocation], toolName: 'execute_sql', result,
      });
      expect(handler.mock.calls[invocation][0]).toBe(params);
      expect(handler.mock.calls[invocation][1].toolCallId).toBe(ids[invocation]);
    }
  });

  it.each(['sync', 'async'] as const)('preserves original results and thrown errors when the %s observer throws', async mode => {
    const events: RuntimeToolInvocationEvent[] = [];
    const result = {content: [{type: 'text' as const, text: 'ok'}]};
    const failure = new Error('original handler failure');
    const handler = jest.fn(async () => result).mockResolvedValueOnce(result).mockRejectedValueOnce(failure);
    const registry = new McpToolRegistry({
      toolObserver: event => {
        events.push(event);
        if (mode === 'async') return Promise.reject(new Error('observer failure'));
        throw new Error('observer failure');
      },
    });
    registry.registerSdk({
      name: 'execute_sql', description: 'Execute SQL', inputSchema: {}, handler,
    }, 'execute_sql', 'public');
    const sdkTool = registry.list()[0].tool as ClaudeSdkToolLike;

    await expect(sdkTool.handler({}, {})).resolves.toBe(result);
    await expect(sdkTool.handler({}, {})).rejects.toBe(failure);
    expect(events.map(event => event.phase)).toEqual(['started', 'completed', 'started', 'failed']);
    expect(events[3]).toMatchObject({phase: 'failed', error: failure, toolCallId: events[2].toolCallId});
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('observes only handlers admitted for execution and ignores calls cancelled while queued', async () => {
    const events: RuntimeToolInvocationEvent[] = [];
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => {signalStarted = resolve;});
    const pending = new Promise<void>(resolve => {release = resolve;});
    const handler = jest.fn(async () => {
      signalStarted();
      await pending;
      return {content: [{type: 'text' as const, text: 'ok'}]};
    });
    const registry = new McpToolRegistry({toolObserver: event => {events.push(event);}});
    registry.registerShared({
      name: 'execute_sql', description: 'Execute SQL', exposure: 'public', inputSchema: {}, handler,
    });
    const sdkTool = registry.list()[0].tool as ClaudeSdkToolLike;
    const first = sdkTool.handler({}, {toolCallId: 'first'});
    await started;
    const controller = new AbortController();
    const second = sdkTool.handler({}, {toolCallId: 'queued', signal: controller.signal});
    const rejected = expect(second).rejects.toThrow();
    controller.abort();
    await rejected;
    release();
    await first;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.map(event => [event.phase, event.toolCallId])).toEqual([
      ['started', 'first'], ['completed', 'first'],
    ]);
  });
});

describe('isToolAllowedForScope', () => {
  const scope = (allowNewEvidence?: boolean) => ({sessionId: 's', hasCodebaseAccess: false,
    ...(allowNewEvidence === undefined ? {} : {allowNewEvidence})});
  it('admits acquisition only when the request admits new evidence; reads stay admitted', () => {
    const acquire = {exposure: 'public' as const, evidenceEffect: 'acquire' as const};
    expect(isToolAllowedForScope(acquire, undefined)).toBe(true);
    expect(isToolAllowedForScope(acquire, scope())).toBe(true);
    expect(isToolAllowedForScope(acquire, scope(true))).toBe(true);
    expect(isToolAllowedForScope(acquire, scope(false))).toBe(false);
    for (const evidenceEffect of ['none', 'read_existing', 'background'] as const) {
      expect(isToolAllowedForScope({exposure: 'public', evidenceEffect}, scope(false))).toBe(true);
    }
    expect(isToolAllowedForScope({exposure: 'deprecated', evidenceEffect: 'none'}, scope(true))).toBe(false);
    expect(isToolAllowedForScope({exposure: 'requires_codebase_permission', evidenceEffect: 'none'}, scope(true))).toBe(false);
  });
});
