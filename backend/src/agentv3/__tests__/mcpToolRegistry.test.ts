// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect, jest} from '@jest/globals';
import {z} from 'zod';
import type {RuntimeToolDefinition, RuntimeToolExtra, SharedToolSpec} from '../../agentRuntime/runtimeToolSpec';
import type {RuntimeToolInvocationEvent, RuntimeToolObserver} from '../../agentRuntime/runtimeToolObserver';
import * as runtimeToolSpec from '../../agentRuntime/runtimeToolSpec';
import {createClaudeSdkMcpServer, createClaudeSdkToolFromSharedSpec} from '../../agentRuntime/engines/claude/claudeSdkTools';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {recordPlanOrPrePlanToolCall} from '../planToolCallRecorder';
import {isPolicyRefusalResult} from '../toolNarration';
import {createRuntimeRunAuthorization, isIssuedRunAuthorizationCheck} from '../../agentRuntime/runAuthorizationFence';
import {RuntimeExecutionGuard} from '../../agentRuntime/runtimeExecutionGuard';
import type {AnalysisPlanV3} from '../types';

import {
  McpToolRegistry,
  MCP_NAME_PREFIX,
  buildAllowedTools,
  filterByExposure,
  type McpToolDefinition,
  isToolAllowedForScope,
} from '../mcpToolRegistry';

/** Stub tool definition with the shape `defineRuntimeTool(...)` returns. */
function stub(name: string): RuntimeToolDefinition {
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

/** The descriptor the Claude engine hands to its in-process SDK server, called with plain arguments. */
const claudeDescriptor = (definition: McpToolDefinition) =>
  createClaudeSdkToolFromSharedSpec(definition.shared) as unknown as RuntimeToolDefinition;

describe('McpToolRegistry — basic registration', () => {
  it('keeps a role-tagged tool out of plan and evidence attribution', async () => {
    const observe = jest.fn<(event: RuntimeToolInvocationEvent) => void>();
    const acquisitionObserver = jest.fn<RuntimeToolObserver>();
    const admit = jest.fn(() => undefined);
    const events: RuntimeToolInvocationEvent[] = [];
    const registry = new McpToolRegistry({acquisitionPolicy: {observe, admit}, acquisitionObserver,
      toolObserver: event => { events.push(event); }});
    registry.registerTool(stub('final_native'), 'final_native', 'internal', {
      role: 'final_candidate_submission', evidenceEffect: 'none',
    });
    const [definition] = registry.list();
    expect(definition.shared.role).toBe('final_candidate_submission');
    expect(definition.shared.inputSchema).not.toHaveProperty('planPhaseId');
    await definition.shared.handler({q: 'private document'}, {});
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({role: 'final_candidate_submission', phase: 'completed'});
    expect(JSON.stringify(events)).not.toContain('private document');
    expect(observe).not.toHaveBeenCalled();
    expect(acquisitionObserver).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('does not infer a role from names or input and never uses it to bypass authorization', async () => {
    const ordinary = new McpToolRegistry();
    ordinary.registerTool(stub('submit_final_document'), 'submit_final_document', 'internal');
    expect(ordinary.list()[0].shared.role).toBeUndefined();
    expect(ordinary.list()[0].shared.inputSchema).toHaveProperty('planPhaseId');
    await ordinary.list()[0].shared.handler({role: 'final_candidate_submission'}, {role: 'final_candidate_submission'});
    expect(ordinary.list()[0].shared.role).toBeUndefined();

    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    const registry = new McpToolRegistry({requestScope: {sessionId: 's', hasCodebaseAccess: false}});
    registry.registerShared({name: 'final', description: 'Final', role: 'final_candidate_submission',
      exposure: 'requires_codebase_permission', evidenceEffect: 'none', inputSchema: {}, handler: body});
    expect(registry.listForRequest()).toEqual([]);
    expect(registry.listForRequest({sessionId: 's', hasCodebaseAccess: true})).toEqual([]);
    const closed = new McpToolRegistry({canInvokeTool: () => false});
    closed.registerShared({name: 'final', description: 'Final', role: 'final_candidate_submission',
      exposure: 'internal', evidenceEffect: 'none', inputSchema: {}, handler: body});
    expect(isPolicyRefusalResult(await closed.list()[0].shared.handler({}, {}))).toBe(true);
    expect(body).not.toHaveBeenCalled();
  });

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

  it('does not turn a factory-issued public fence into new private checks for ordinary tools', async () => {
    const lease = new RuntimeExecutionGuard().begin({runtime: 'openai-agents-sdk', sessionId: 'public-tool'});
    const {fence} = createRuntimeRunAuthorization({options: {}, executionLease: lease});
    const check = jest.spyOn(fence, 'assertCurrentInTurn');
    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    try {
      expect(isIssuedRunAuthorizationCheck(fence)).toBe(true);
      expect(fence.enforced).toBe(false);
      const registry = new McpToolRegistry({runAuthorization: fence});
      registry.registerShared({name: 'execute_sql', description: 'sql', inputSchema: {},
        handler: body, exposure: 'public', evidenceEffect: 'acquire'});
      await registry.list()[0].shared.handler({}, {});
      expect(body).toHaveBeenCalledTimes(1);
      expect(check).not.toHaveBeenCalled();
    } finally {check.mockRestore(); lease.settle();}
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
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    registry.registerTool(stub('b'), 'invoke_skill', 'public');
    registry.registerTool(stub('c'), 'submit_plan', 'internal');

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('execute_sql');
    expect(list[1].name).toBe('invoke_skill');
    expect(list[2].name).toBe('submit_plan');
  });

  it('does not deduplicate by name — call sites control uniqueness', () => {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('a'), 'dup', 'public');
    registry.registerTool(stub('b'), 'dup', 'public');
    expect(registry.size()).toBe(2);
  });

  it('registerTool carries summary + requires into the ACI', () => {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('x'), 'execute_sql', 'public', {
      summary: 'Run SQL on the active trace.',
      requires: ['traceProcessor'],
    });
    const aci = registry.getAci();
    expect(aci[0].summary).toBe('Run SQL on the active trace.');
    expect(aci[0].requires).toEqual(['traceProcessor']);
  });
});

describe('McpToolRegistry — allowedTools shape', () => {
  it('gives every evidence-capable descriptor explicit attribution without guessing from active state', async () => {
    const registry = new McpToolRegistry({requestScope: {sessionId: 's1', hasCodebaseAccess: true}});
    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    registry.registerTool({name: 'read_codebase_file', description: 'Read source', inputSchema: {}, handler: body},
      'read_codebase_file', 'requires_codebase_permission', {evidenceEffect: 'acquire'});
    const definition = registry.list()[0];
    expect(z.safeParse(definition.shared.inputSchema.planPhaseId, 'p2').success).toBe(true);
    const descriptor = claudeDescriptor(definition);
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
    registry.registerTool(stub('stored'), 'stored', 'public', {evidenceEffect: 'read_existing'});
    registry.registerTool(stub('guide'), 'guide', 'internal', {evidenceEffect: 'none'});
    registry.registerTool(stub('new'), 'new', 'public', {evidenceEffect: 'acquire'});
    registry.registerTool(stub('unknown'), 'unknown', 'public');
    registry.registerTool(stub('source'), 'source', 'requires_codebase_permission', {evidenceEffect: 'none'});
    scope.allowNewEvidence = true;
    scope.hasCodebaseAccess = true;

    const expected = ['stored', 'guide'];
    for (const viewScope of [undefined, scope]) {
      expect(registry.listForRequest(viewScope).map(def => def.name)).toEqual(expected);
      expect(registry.buildAllowedTools(viewScope)).toEqual(expected.map(name => MCP_NAME_PREFIX + name));
      expect(registry.getAci(viewScope).map(def => def.toolName)).toEqual(expected);
      const server = createClaudeSdkMcpServer(registry.listForRequest(viewScope)) as unknown as {instance: {tools: Array<{name: string}>}};
      expect(server.instance.tools.map(def => def.name.replace(MCP_NAME_PREFIX, ''))).toEqual(expected);
    }
    expect(registry.list().map(def => def.name)).toEqual(expected);
    expect(registry.size()).toBe(expected.length);
    expect(registry.buildPublicApiContract().tools.map(def => def.toolName)).toEqual(expected);
    expect(registry.probeCapabilities(scope).codeAwareAvailable).toBe(false);
  });

  it('allows a supplied view scope to narrow a permissive bound scope', () => {
    const registry = new McpToolRegistry({requestScope: {sessionId: 's1', hasCodebaseAccess: true}});
    registry.registerTool(stub('new'), 'new', 'public', {evidenceEffect: 'acquire'});
    registry.registerTool(stub('source'), 'source', 'requires_codebase_permission', {evidenceEffect: 'read_existing'});
    registry.registerTool(stub('stored'), 'stored', 'public', {evidenceEffect: 'read_existing'});
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
    const factory = jest.spyOn(runtimeToolSpec, 'withRuntimeToolConcurrency');
    try {
      const registry = new McpToolRegistry({
        requestScope: {sessionId: 's1', hasCodebaseAccess: true, allowNewEvidence: false},
        toolObserver: event => {events.push(event);},
      });
      registry.registerTool({name: 'held', description: 'Held tool', inputSchema: {}, handler: body},
        'held', 'public', {evidenceEffect});
      // The registered runtime spec and its SDK descriptor, which discovery hides.
      const shared = factory.mock.results[0].value as SharedToolSpec;
      const descriptor = claudeDescriptor({name: shared.name, shared, exposure: shared.exposure});
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
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    registry.registerTool(stub('b'), 'submit_plan', 'internal');

    const allowed = registry.buildAllowedTools();
    expect(allowed).toEqual([
      `${MCP_NAME_PREFIX}execute_sql`,
      `${MCP_NAME_PREFIX}submit_plan`,
    ]);
  });

  it('filters codebase tools through request-scoped allowedTools', () => {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    registry.registerTool(stub('b'), 'lookup_app_source', 'requires_codebase_permission');

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
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    registry.registerTool(stub('b'), 'submit_plan', 'internal');
    registry.registerTool(stub('c'), 'lookup_app_source', 'requires_codebase_permission');
    registry.registerTool(stub('d'), 'old_tool', 'deprecated');

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
    registry.registerTool(stub('one'), 'one', 'public');
    registry.registerTool(stub('two'), 'two', 'internal');
    const defs: readonly McpToolDefinition[] = registry.list();
    expect(buildAllowedTools(defs)).toEqual([
      `${MCP_NAME_PREFIX}one`,
      `${MCP_NAME_PREFIX}two`,
    ]);
  });

  it('keeps codebase-permission tools out of every view of a request without codebase access', () => {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('trace'), 'execute_sql', 'public');
    registry.registerTool(
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

    const deniedTools = ((createClaudeSdkMcpServer(registry.listForRequest(denied)) as any).instance?.tools ?? [])
      .map((entry: {name: string}) => entry.name.replace(MCP_NAME_PREFIX, ''));
    const allowedTools = ((createClaudeSdkMcpServer(registry.listForRequest(allowed)) as any).instance?.tools ?? [])
      .map((entry: {name: string}) => entry.name.replace(MCP_NAME_PREFIX, ''));
    expect(deniedTools).not.toContain('search_codebase');
    expect(allowedTools).toContain('search_codebase');
  });
});

describe('McpToolRegistry — filterByExposure', () => {
  function seed(): McpToolDefinition[] {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('execute_sql'), 'execute_sql', 'public');
    registry.registerTool(stub('submit_plan'), 'submit_plan', 'internal');
    registry.registerTool(stub('old_tool'), 'old_tool', 'deprecated');
    registry.registerTool(stub('invoke_skill'), 'invoke_skill', 'public');
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
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    registry.registerTool(stub('b'), 'submit_plan', 'internal');

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
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    registry.registerTool(stub('b'), 'invoke_skill', 'public', {
      summary: 'Run a skill.',
    });
    const aci = registry.getAci();
    expect(aci[0].summary).toBe('');
    expect(aci[1].summary).toBe('Run a skill.');
  });

  it('hides requires_codebase_permission tools from request scopes without access', () => {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('a'), 'list_codebases', 'public-readonly');
    registry.registerTool(stub('b'), 'lookup_app_source', 'requires_codebase_permission');

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
    registry.registerTool(stub('a'), 'execute_sql', 'public');
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

describe('McpToolRegistry — Claude SDK server', () => {
  it('builds the SDK server the Claude runtime passes to query() from the registry definitions', () => {
    const registry = new McpToolRegistry();
    registry.registerTool(stub('a'), 'execute_sql', 'public');
    const server = createClaudeSdkMcpServer(registry.list());
    // The SDK server is opaque; we only verify it's not null and has
    // a recognizable shape (the SDK's helper returns an object).
    expect(server).toBeTruthy();
    expect(typeof server).toBe('object');
    expect(server.name).toBe('smartperfetto');
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
    const handler = surface === 'shared' ? definition.shared.handler : claudeDescriptor(definition).handler;
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
    const sdkTool = claudeDescriptor(definition);
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
    registry.registerTool({
      name: 'execute_sql', description: 'Execute SQL', inputSchema: {}, handler,
    }, 'execute_sql', 'public');
    const sdkTool = claudeDescriptor(registry.list()[0]);

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
    const sdkTool = claudeDescriptor(registry.list()[0]);
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
