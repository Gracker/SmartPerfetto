// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { createOpenAIToolsFromMcpDefinitions } from '../openAiToolAdapter';
import { createTraceProcessorQueryCancelledError } from '../../services/traceProcessorCancellation';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {McpToolRegistry} from '../../agentv3/mcpToolRegistry';
import {Agent, OpenAIProvider, Runner, RunContext, setTracingDisabled, tool} from '@openai/agents';
import OpenAI from 'openai';
import {createJsonSchemaFromZodRawShape, preserveRuntimeLiteralStrings} from '../../agentRuntime/runtimeToolSpec';
import {chatCompletionResponse} from '../../../tests/helpers/openAiRuntimeFixture';
import {AUTHORED_FINAL_SUBMISSION_PENDING_ACK} from '../../agentRuntime/authoredFinalSubmission';
import type {createOpenAiTypedFinalAttempt} from '../../agentRuntime/engines/openai/openAiTypedFinalAdmission';

describe('createOpenAIToolsFromMcpDefinitions', () => {
  it('binds private hooks to the actual returned tool and exact handler document, without an extra capability', async () => {
    const documentJson = '  {"literal":"null","bodyParts":["  exact  "]}  ';
    const order: string[] = [];
    const registry = new McpToolRegistry();
    registry.registerShared({name: 'registered_final_fixture', role: 'final_candidate_submission', exposure: 'internal',
      evidenceEffect: 'none', description: 'Fixture final role', inputSchema: {documentJson: preserveRuntimeLiteralStrings(z.string())},
      handler: async args => {
        order.push('handler'); expect(args).toEqual({documentJson});
        return {content: [{type: 'text', text: AUTHORED_FINAL_SUBMISSION_PENDING_ACK}]};
      }});
    const invocation = Object.freeze({kind: 'openai_typed_final_invocation' as const});
    // This is an adapter ordering test. Actual admission/SDK gates have their own real-run suite.
    const stage = jest.fn<ReturnType<typeof createOpenAiTypedFinalAttempt>['stageInvocation']>(async (_call) => {
      order.push('stage'); return invocation;
    });
    const success = jest.fn<ReturnType<typeof createOpenAiTypedFinalAttempt>['markPrivateHandlerSuccess']>((_invocation, _result) => {
      order.push('success');
    });
    const bridge = {stageInvocation: stage, markPrivateHandlerSuccess: success} as unknown as ReturnType<typeof createOpenAiTypedFinalAttempt>;
    const mapped = jest.fn();
    const [installed] = createOpenAIToolsFromMcpDefinitions(registry.list(), {currentFinalAttempt: () => bridge, onAdapted: mapped});
    if (installed.type !== 'function') throw new Error('Expected installed function tool');
    const context = new RunContext();
    const call = {type: 'function_call' as const, name: installed.name, callId: 'call', arguments: JSON.stringify({documentJson})};
    const output = await installed.invoke(context, call.arguments, {toolCall: call});
    expect(output).toBe(AUTHORED_FINAL_SUBMISSION_PENDING_ACK);
    expect(order).toEqual(['stage', 'handler', 'success']);
    expect(mapped).toHaveBeenCalledWith(registry.list()[0], installed);
    expect(stage).toHaveBeenCalledWith({tool: installed, context, toolCall: call});
    expect(success).toHaveBeenCalledWith(invocation, {output: AUTHORED_FINAL_SUBMISSION_PENDING_ACK, documentJson});
  });

  it.each([false, true])('does not expose typed raw errors or treat extra values as a private bridge (bound=%s)', async bound => {
    const handler = jest.fn(async () => {throw new Error('PRIVATE_TYPED_ARGUMENT_CANARY');});
    const registry = new McpToolRegistry();
    registry.registerShared({name: 'registered_final_fixture', role: 'final_candidate_submission', exposure: 'internal',
      evidenceEffect: 'none', description: 'Fixture final role', inputSchema: {documentJson: preserveRuntimeLiteralStrings(z.string())}, handler});
    const success = jest.fn();
    const bridge = {stageInvocation: async () => ({kind: 'openai_typed_final_invocation'}), markPrivateHandlerSuccess: success} as unknown as ReturnType<typeof createOpenAiTypedFinalAttempt>;
    const [installed] = createOpenAIToolsFromMcpDefinitions(registry.list(), bound ? {currentFinalAttempt: () => bridge} : {});
    if (installed.type !== 'function') throw new Error('Expected installed function tool');
    const call = {type: 'function_call' as const, name: installed.name, callId: 'untrusted-call',
      arguments: JSON.stringify({documentJson: 'PRIVATE_TYPED_ARGUMENT_CANARY'})};
    const output = await installed.invoke(new RunContext({privateBridge: bridge}), call.arguments, {toolCall: call});
    expect(String(output)).toContain('submission_rejected');
    expect(String(output)).not.toContain('PRIVATE_TYPED_ARGUMENT_CANARY');
    expect(handler).toHaveBeenCalledTimes(bound ? 1 : 0);
    expect(success).not.toHaveBeenCalled();
  });
  it('sends de-duplicated strict annotations on two actual SDK dispatches with unchanged argument parsing', async () => {
    const inputSchema = {text: z.string(), filter: z.string().optional().describe('Filter annotation retained once.')};
    const handler = jest.fn(async (_args: Record<string, unknown>) => ({content: [{type: 'text' as const, text: 'read result'}]}));
    const registry = new McpToolRegistry();
    registry.registerShared({name: 'read_fixture', description: 'Read fixture', inputSchema, exposure: 'public', handler});
    const registeredShape = registry.list()[0].shared.inputSchema;
    const original = createJsonSchemaFromZodRawShape(registeredShape);
    const before = JSON.stringify(original);
    const baseline = tool({name: 'read_fixture', description: 'Read fixture', parameters: original as any,
      strict: true, execute: async () => 'read result'});
    const [adapted] = createOpenAIToolsFromMcpDefinitions(registry.list());
    const fetchImpl = jest.fn<typeof fetch>()
      .mockResolvedValueOnce(chatCompletionResponse('first', {role: 'assistant', tool_calls: [{index: 0, id: 'call-1', type: 'function',
        function: {name: 'read_fixture', arguments: JSON.stringify({text: 'yes', filter: null, planPhaseId: null})}}]}, 'tool_calls'))
      .mockResolvedValueOnce(chatCompletionResponse('second', {role: 'assistant', content: 'Done'}, 'stop'));
    setTracingDisabled(true);
    const provider = new OpenAIProvider({openAIClient: new OpenAI({apiKey: 'fixture-only', baseURL: 'https://fixture.invalid/v1', fetch: fetchImpl}), useResponses: false});
    try {
      const runner = new Runner({modelProvider: provider, tracingDisabled: true});
      const stream = await runner.run(new Agent({name: 'fixture', model: 'fixture-model', tools: [adapted]}), 'Read once', {maxTurns: 3, stream: true});
      for await (const _event of stream) { /* Consume the native SDK stream normally. */ }
      await stream.completed;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchImpl.mock.calls) {
        const schema = JSON.parse(String(init!.body)).tools[0].function.parameters;
        expect(schema.properties.filter).toEqual({description: 'Filter annotation retained once.', anyOf: [{type: 'string'}, {type: 'null'}]});
        expect(schema.required).toEqual(baseline.parameters.required);
        expect(schema.additionalProperties).toBe(false);
        expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(Buffer.byteLength(JSON.stringify(baseline.parameters)));
      }
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({text: 'yes'});
      expect(JSON.stringify(original)).toBe(before);
      expect(registry.list()[0].shared.inputSchema).toBe(registeredShape);
    } finally {await provider.close();}
  });
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
