// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, it, expect} from '@jest/globals';
import {z} from 'zod';

import {McpToolRegistry} from '../mcpToolRegistry';
import {
  dispatch,
  runStdioLoop,
  RPC_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestSource,
  type ResponseSink,
} from '../standaloneMcpServer';

/** Minimal SDK-tool stub that pretends to be the shape `tool()`
 * from `@anthropic-ai/claude-agent-sdk` returns. */
function stubSdkTool(opts: {
  name?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  handler?: (args: unknown) => Promise<unknown> | unknown;
}): unknown {
  return {
    name: opts.name ?? 'stub_tool',
    description: opts.description ?? '',
    inputSchema: opts.inputSchema ?? {},
    handler: opts.handler ?? (async () => ({content: [{type: 'text', text: 'ok'}]})),
  };
}

describe('dispatch — initialize', () => {
  it('returns protocolVersion + serverInfo + tools capability', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(resp?.id).toBe(1);
    const result = resp!.result as {
      protocolVersion: string;
      serverInfo: {name: string};
      capabilities: {tools: object};
    };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('smartperfetto');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('drops notifications (no id) silently', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      method: 'initialize',
    });
    expect(resp).toBeNull();
  });
});

describe('dispatch — tools/list', () => {
  it('returns ONLY public exposure tools', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({description: 'public alpha'}),
      'alpha',
      'public',
    );
    registry.registerSdk(
      stubSdkTool({description: 'internal beta'}),
      'beta',
      'internal',
    );
    registry.registerSdk(
      stubSdkTool({description: 'deprecated gamma'}),
      'gamma',
      'deprecated',
    );

    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const tools = (resp!.result as {tools: Array<{name: string}>}).tools;
    expect(tools.map(t => t.name)).toEqual(['alpha']);
  });

  it('does not expose requires_codebase_permission tools to standalone hosts', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({description: 'public alpha'}),
      'alpha',
      'public',
    );
    registry.registerSdk(
      stubSdkTool({description: 'source lookup'}),
      'lookup_app_source',
      'requires_codebase_permission',
    );

    const listResp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/list',
    });
    const tools = (listResp!.result as {tools: Array<{name: string}>}).tools;
    expect(tools.map(t => t.name)).toEqual(['alpha']);

    const callResp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {name: 'lookup_app_source', arguments: {query: 'MainActivity'}},
    });
    expect(callResp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(callResp!.error?.message).toMatch(/not exposed/);
  });

  it('descriptor carries name + description + JSON Schema from shared input schema', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        name: 'alpha',
        description: 'Describe the thing.',
        inputSchema: {q: z.string()},
      }),
      'alpha',
      'public',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    const tools = (resp!.result as {tools: Array<unknown>}).tools as Array<{
      name: string;
      description: string;
      inputSchema: unknown;
    }>;
    expect(tools[0].name).toBe('alpha');
    expect(tools[0].description).toBe('Describe the thing.');
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      properties: {q: {type: 'string'}},
      required: ['q'],
    });
  });

  it('parse-error sentinel surfaces as a real PARSE_ERROR (Codex round E P2#5)', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: null,
      method: '__parse_error__',
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.PARSE_ERROR);
    expect(resp!.id).toBeNull();
  });
});

describe('dispatch — tools/call', () => {
  it('invokes the handler and returns its result', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async (args: unknown) => ({
          content: [{type: 'text', text: `got ${JSON.stringify(args)}`}],
        }),
      }),
      'echo',
      'public',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {name: 'echo', arguments: {q: 'hello'}},
    });
    expect((resp!.result as {content: Array<{text: string}>}).content[0].text).toBe(
      'got {"q":"hello"}',
    );
  });

  it('400/METHOD_NOT_FOUND for unknown tool', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {name: 'unknown'},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('refuses to call internal tools (hidden from external hosts)', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({}),
      'submit_plan',
      'internal',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {name: 'submit_plan'},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(resp!.error?.message).toMatch(/not exposed/);
  });

  it('surfaces handler exceptions as TOOL_EXECUTION_FAILED', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async () => {
          throw new Error('boom');
        },
      }),
      'broken',
      'public',
    );
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {name: 'broken'},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(resp!.error?.message).toBe('boom');
  });

  it('INVALID_PARAMS when name is missing', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {},
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
  });
});

describe('dispatch — unknown methods', () => {
  it('METHOD_NOT_FOUND for any other method name', async () => {
    const registry = new McpToolRegistry();
    const resp = await dispatch(registry, {
      jsonrpc: '2.0',
      id: 9,
      method: 'resources/list',
    });
    expect(resp!.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });
});

// ----------------------------------------------------------------------
// runStdioLoop — drive the dispatcher with a fake source/sink so we
// don't need to spawn a subprocess to validate the loop semantics.
// ----------------------------------------------------------------------

class ScriptedSource implements RequestSource {
  private idx = 0;
  constructor(private requests: (JsonRpcRequest | null)[]) {}
  async next(): Promise<JsonRpcRequest | null> {
    if (this.idx >= this.requests.length) return null;
    return this.requests[this.idx++];
  }
}

class CollectingSink implements ResponseSink {
  responses: JsonRpcResponse[] = [];
  send(r: JsonRpcResponse): void {
    this.responses.push(r);
  }
}

describe('runStdioLoop', () => {
  it('processes a sequence of requests in order', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async (args: unknown) => ({
          content: [{type: 'text', text: 'echo'}],
        }),
      }),
      'echo',
      'public',
    );
    const source = new ScriptedSource([
      {jsonrpc: '2.0', id: 1, method: 'initialize'},
      {jsonrpc: '2.0', id: 2, method: 'tools/list'},
      {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'echo'}},
      null,
    ]);
    const sink = new CollectingSink();
    await runStdioLoop(registry, source, sink);
    expect(sink.responses).toHaveLength(3);
    expect(sink.responses[0].id).toBe(1);
    expect(sink.responses[1].id).toBe(2);
    expect(sink.responses[2].id).toBe(3);
  });

  it('keeps running after a tool failure', async () => {
    const registry = new McpToolRegistry();
    registry.registerSdk(
      stubSdkTool({
        handler: async () => {
          throw new Error('intentional');
        },
      }),
      'broken',
      'public',
    );
    registry.registerSdk(
      stubSdkTool({handler: async () => ({content: [{type: 'text', text: 'ok'}]})}),
      'fine',
      'public',
    );
    const source = new ScriptedSource([
      {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'broken'}},
      {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'fine'}},
      null,
    ]);
    const sink = new CollectingSink();
    await runStdioLoop(registry, source, sink);
    expect(sink.responses).toHaveLength(2);
    expect(sink.responses[0].error?.code).toBe(RPC_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(sink.responses[1].result).toBeDefined();
  });
});

// ----------------------------------------------------------------------
// Public result contract of the shared evidence tools. External hosts parse
// these results directly, so a row-shape change must be detectable.
// ----------------------------------------------------------------------

describe('public evidence tool result shape', () => {
  async function publicRegistry(): Promise<McpToolRegistry> {
    const {createClaudeMcpServer} = await import('../claudeMcpServer');
    const {ArtifactStore} = await import('../artifactStore');
    const {SkillExecutor} = await import('../../services/skillEngine/skillExecutor');
    const rows = Array.from({length: 60}, (_, index) => [index, `slice-${index}`, (index * 7) % 60]);
    const traceProcessorService = {
      query: async () => ({columns: ['id', 'slice_name', 'dur'], rows, durationMs: 1}),
    } as never;
    const mcp = createClaudeMcpServer({
      traceId: 'trace-public-contract', sessionId: 'session-public-contract', traceProcessorService,
      skillExecutor: new SkillExecutor(traceProcessorService), artifactStore: new ArtifactStore(),
      emitUpdate: () => {}, androidInternalsPackStore: null,
    });
    const registry = new McpToolRegistry();
    for (const definition of mcp.toolDefinitions) registry.registerShared(definition.shared);
    return registry;
  }
  const callJson = async (registry: McpToolRegistry, id: number, name: string, args: Record<string, unknown>) => {
    const resp = await dispatch(registry, {jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});
    expect(resp!.error).toBeUndefined();
    return (resp!.result as {structuredContent: Record<string, any>}).structuredContent;
  };

  it('lists execute_sql and fetch_artifact and returns rows that name their own artifact-wide index', async () => {
    const registry = await publicRegistry();
    const listed = await dispatch(registry, {jsonrpc: '2.0', id: 30, method: 'tools/list'});
    const names = (listed!.result as {tools: Array<{name: string}>}).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['execute_sql', 'fetch_artifact']));

    const summary = await callJson(registry, 31, 'execute_sql', {sql: 'SELECT id, name AS slice_name, dur FROM slice'});
    expect(summary).toMatchObject({mode: 'summary', rowShape: 'indexed_rows@1'});
    // Samples are sorted by dur, so sample position 0 is row 17 and says so.
    expect(summary.sampleRows[0]).toEqual({rowIndex: 17, values: [17, 'slice-17', 59]});
    const page = await callJson(registry, 32, 'fetch_artifact',
      {artifactId: summary.artifactId, detail: 'rows', offset: 50, limit: 2});
    expect(page).toMatchObject({rowShape: 'indexed_rows@1'});
    expect(page.rows[0]).toEqual({rowIndex: 50, values: [50, 'slice-50', 50]});
  });
});
