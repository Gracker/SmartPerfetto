// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { createOpenAIToolsFromMcpDefinitions } from '../openAiToolAdapter';
import { createTraceProcessorQueryCancelledError } from '../../services/traceProcessorCancellation';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {McpToolRegistry} from '../../agentv3/mcpToolRegistry';

describe('createOpenAIToolsFromMcpDefinitions', () => {
  it('keeps producer facts through a real registry and OpenAI adapter despite notes and large output', async () => {
    const registry = new McpToolRegistry();
    registry.registerShared({
      name: 'execute_sql', description: 'Read data', inputSchema: {}, exposure: 'public',
      handler: async () => createRuntimeToolResult({success: false, planPhaseId: 'p1', error: 'x'.repeat(14000)}, {
        decorate: text => '[accuracy] {"success":true}\n' + text,
      }),
    });
    const [adapted] = createOpenAIToolsFromMcpDefinitions(registry.list());
    const output = await (adapted as any).invoke({} as any, '{}');
    expect(readRuntimeToolResultFacts(output)).toEqual({success: false, planPhaseId: 'p1'});
  });
  it('converts optional Claude MCP Zod fields into OpenAI strict-compatible JSON Schema', async () => {
    const handler = jest.fn(async (args: Record<string, unknown>, _extra: unknown) => ({
      content: [{ type: 'text', text: JSON.stringify(args) }],
    }));

    const [adapted] = createOpenAIToolsFromMcpDefinitions([
      {
        name: 'invoke_skill',
        tool: {
          name: 'invoke_skill',
          description: 'Invoke a SmartPerfetto skill',
          inputSchema: {
            skillId: z.string(),
            params: z.record(z.string(), z.any()).optional().describe('Optional skill parameters'),
          },
          handler,
        },
        exposure: 'core',
      },
    ] as any);

    expect(adapted.type).toBe('function');
    const functionTool = adapted as any;
    expect(functionTool.name).toBe('invoke_skill');
    expect(functionTool.parameters.required).toEqual(['skillId', 'params']);
    expect(functionTool.parameters.properties.params.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'null' })]),
    );
    expect(functionTool.parameters.properties.params.anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'string' })]),
    );
    expect(JSON.stringify(functionTool.parameters)).not.toContain('propertyNames');
    expect(JSON.stringify(functionTool.parameters)).not.toContain('"additionalProperties":{}');

    let output = await functionTool.invoke(
      {} as any,
      JSON.stringify({ skillId: 'startup_analysis', params: null }),
    );

    expect(handler).toHaveBeenCalledWith(
      { skillId: 'startup_analysis' },
      { runtime: 'openai-agents-sdk', signal: undefined },
    );
    expect(output).toBe('{"skillId":"startup_analysis"}');

    output = await functionTool.invoke(
      {} as any,
      JSON.stringify({
        skillId: 'startup_analysis',
        params: '{"enable_startup_details": false}',
      }),
    );

    expect(handler).toHaveBeenLastCalledWith(
      { skillId: 'startup_analysis', params: { enable_startup_details: false } },
      { runtime: 'openai-agents-sdk', signal: undefined },
    );
    expect(output).toBe('{"skillId":"startup_analysis","params":{"enable_startup_details":false}}');
  });

  it('passes tool-call AbortSignal from OpenAI run details to shared handlers', async () => {
    const handler = jest.fn(async (_args: Record<string, unknown>, extra: any) => ({
      content: [{ type: 'text', text: JSON.stringify({ aborted: extra.signal?.aborted ?? null }) }],
    }));
    const [adapted] = createOpenAIToolsFromMcpDefinitions([
      {
        name: 'invoke_skill',
        tool: {
          name: 'invoke_skill',
          description: 'Invoke a SmartPerfetto skill',
          inputSchema: { skillId: z.string() },
          handler,
        },
        exposure: 'core',
      },
    ] as any);
    const functionTool = adapted as any;
    const detailController = new AbortController();
    const contextController = new AbortController();

    await functionTool.invoke(
      { context: { signal: contextController.signal } } as any,
      JSON.stringify({ skillId: 'startup_analysis' }),
      { signal: detailController.signal },
    );

    expect(handler).toHaveBeenCalledWith(
      { skillId: 'startup_analysis' },
      { runtime: 'openai-agents-sdk', signal: detailController.signal },
    );
  });

  it('passes the per-call id, not the response id Chat Completions shares across parallel calls', async () => {
    const handler = jest.fn(async (_args: Record<string, unknown>, _extra: any) => ({
      content: [{ type: 'text', text: '{}' }],
    }));
    const [adapted] = createOpenAIToolsFromMcpDefinitions([
      {
        name: 'invoke_skill',
        tool: {name: 'invoke_skill', description: 'Invoke a SmartPerfetto skill', inputSchema: {skillId: z.string()}, handler},
        exposure: 'core',
      },
    ] as any);
    for (const callId of ['call-1', 'call-2']) {
      await (adapted as any).invoke({} as any, JSON.stringify({skillId: 'startup_analysis'}),
        {toolCall: {type: 'function_call', id: 'chatcmpl-shared', callId, name: 'invoke_skill', arguments: '{}'}});
    }
    expect(handler.mock.calls.map(([, extra]) => extra.toolCallId)).toEqual(['call-1', 'call-2']);
  });

  it('rethrows cancellation errors instead of returning model-visible JSON', async () => {
    const [adapted] = createOpenAIToolsFromMcpDefinitions([
      {
        name: 'invoke_skill',
        tool: {
          name: 'invoke_skill',
          description: 'Invoke a SmartPerfetto skill',
          inputSchema: { skillId: z.string() },
          handler: jest.fn(async () => {
            throw createTraceProcessorQueryCancelledError();
          }),
        },
        exposure: 'core',
      },
    ] as any);
    const functionTool = adapted as any;

    await expect(functionTool.invoke(
      {} as any,
      JSON.stringify({ skillId: 'startup_analysis' }),
    )).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exposes OpenAI tools by short MCP names used in system prompts', () => {
    const tools = createOpenAIToolsFromMcpDefinitions([
      {
        name: 'submit_hypothesis',
        tool: {
          name: 'submit_hypothesis',
          description: 'Submit a hypothesis',
          inputSchema: { statement: z.string() },
          handler: jest.fn(async () => ({ content: [{ type: 'text', text: '{"success":true}' }] })),
        },
        exposure: 'internal',
      },
    ] as any);

    expect((tools[0] as any).name).toBe('submit_hypothesis');
  });

  it('fails closed when the registry entry is not a Claude SDK-like descriptor', () => {
    expect(() => createOpenAIToolsFromMcpDefinitions([
      {
        name: 'broken_tool',
        tool: { description: 'missing schema and handler' },
        exposure: 'public',
      },
    ] as any)).toThrow(
      'Cannot adapt MCP tool broken_tool: unsupported SDK descriptor shape',
    );
  });
});
