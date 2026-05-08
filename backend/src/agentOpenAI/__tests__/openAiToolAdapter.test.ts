// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { createOpenAIToolsFromMcpDefinitions } from '../openAiToolAdapter';

describe('createOpenAIToolsFromMcpDefinitions', () => {
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
    expect(JSON.stringify(functionTool.parameters)).not.toContain('propertyNames');

    let output = await functionTool.invoke(
      {} as any,
      JSON.stringify({ skillId: 'startup_analysis', params: null }),
    );

    expect(handler).toHaveBeenCalledWith({ skillId: 'startup_analysis' }, {});
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
      {},
    );
    expect(output).toBe('{"skillId":"startup_analysis","params":{"enable_startup_details":false}}');
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
});
