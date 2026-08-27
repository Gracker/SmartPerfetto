// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {z} from 'zod';

import {
  McpToolRegistry,
  MCP_NAME_PREFIX,
  buildAllowedTools,
  filterByExposure,
  resolveMcpToolPlanCapability,
  type McpToolDefinition,
  type McpToolRegistration,
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
  it('accepts legacy exported definitions without plan capability and derives a safe default', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('legacy'), 'legacy_runtime_tool', 'public');
    const registered = registry.list()[0];
    const legacyDefinition: McpToolDefinition = {
      name: registered.name,
      shared: registered.shared,
      tool: registered.tool,
      exposure: registered.exposure,
    };

    expect(legacyDefinition.planCapability).toBeUndefined();
    expect(resolveMcpToolPlanCapability(legacyDefinition)).toBe('evidence');
    expect(registry.list()[0].planCapability).toBe('evidence');
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

  it('keeps the source-use control classification and request-shaped views in parity', () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(stub('trace'), 'execute_sql', 'public');
    registry.registerSdk(
      stub('source-control'),
      'record_source_use_decision',
      'requires_codebase_permission',
    );
    const denied = {sessionId: 's1', hasCodebaseAccess: false};
    const allowed = {sessionId: 's1', hasCodebaseAccess: true};

    expect(registry.listForRequest(denied).map(def => def.name))
      .toEqual(['execute_sql']);
    expect(registry.buildAllowedTools(denied))
      .toEqual([`${MCP_NAME_PREFIX}execute_sql`]);
    expect(registry.listForRequest(allowed)).toContainEqual(expect.objectContaining({
      name: 'record_source_use_decision',
      planCapability: 'control',
    }));
    expect(registry.buildAllowedTools(allowed)).toContain(
      `${MCP_NAME_PREFIX}record_source_use_decision`,
    );

    const deniedTools = ((registry.buildSdkServer({scope: denied}) as any).instance?.tools ?? [])
      .map((entry: {name: string}) => entry.name.replace(MCP_NAME_PREFIX, ''));
    const allowedTools = ((registry.buildSdkServer({scope: allowed}) as any).instance?.tools ?? [])
      .map((entry: {name: string}) => entry.name.replace(MCP_NAME_PREFIX, ''));
    expect(deniedTools).not.toContain('record_source_use_decision');
    expect(allowedTools).toContain('record_source_use_decision');
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
