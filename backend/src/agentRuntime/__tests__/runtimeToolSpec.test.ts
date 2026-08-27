// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import {
  RUNTIME_TOOL_DESCRIPTION_MAX_CHARS,
  compactRuntimeToolDescription,
  createClaudeSdkToolFromSharedSpec,
  createJsonSchemaFromZodRawShape,
  normalizeRuntimeToolArgs,
  sharedToolSpecFromClaudeSdkTool,
  stringifyRuntimeToolResult,
  type SharedToolSpec,
} from '../runtimeToolSpec';

function sdkTool(name: string) {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      q: z.string(),
      params: z.record(z.string(), z.any()).optional().describe('Optional params'),
    },
    annotations: { readOnlyHint: true },
    handler: jest.fn(async (args: Record<string, unknown>, _extra: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(args) }],
    })),
  };
}

describe('SharedToolSpec', () => {
  it('caps every provider-facing tool description at 1000 characters', () => {
    const description = `Use when: ${'bounded runtime contract '.repeat(60)}`;
    const compacted = compactRuntimeToolDescription(description);

    expect(RUNTIME_TOOL_DESCRIPTION_MAX_CHARS).toBe(1000);
    expect(compacted.length).toBeLessThanOrEqual(1000);
    expect(compacted).toContain('Use when:');
  });

  it('keeps complete head and tail sentences while dropping an oversized important middle', () => {
    const description = [
      'Use when: The first complete sentence establishes the contract.',
      ...Array.from({length: 12}, (_, index) => (
        `Middle sentence ${index} carries deliberately repetitive detail that can be omitted safely.`
      )),
      'The final complete sentence preserves the terminal safety boundary.',
    ].join(' ');

    const compacted = compactRuntimeToolDescription(description);

    expect(compacted.length).toBeLessThanOrEqual(RUNTIME_TOOL_DESCRIPTION_MAX_CHARS);
    expect(compacted).toContain('Use when: The first complete sentence establishes the contract.');
    expect(compacted).toContain('The final complete sentence preserves the terminal safety boundary.');
    expect(compacted).not.toContain('Middle sentence 6');
  });

  it('keeps short descriptions byte-identical', () => {
    const description = 'Short description with two sentences. Nothing needs compaction.';
    expect(compactRuntimeToolDescription(description)).toBe(description);
  });

  it('does not split an identifier dot while preserving head and tail sentences', () => {
    const description = [
      'Use when: Read actual_frame_timeline_slice.upid before joining process.',
      ...Array.from({length: 14}, (_, index) => (
        `Middle identifier detail ${index} is intentionally repetitive and removable.`
      )),
      'The final sentence remains complete after compaction.',
    ].join(' ');

    const compacted = compactRuntimeToolDescription(description);

    expect(compacted).toContain('actual_frame_timeline_slice.upid');
    expect(compacted).toContain('The final sentence remains complete after compaction.');
    expect(compacted).not.toContain('actual_frame_timeline_slice. upid');
  });

  it('keeps SQL safety head and tail sentences within its 500-character category budget', () => {
    const sqlSafetyParagraph = [
      'SQL safety rules: use s.name AS slice_name and qualified aliases so every joined column keeps an explicit owner.',
      'FrameTimeline rows expose upid and require a process join before process_name can be treated as verified identity.',
      ...Array.from({length: 6}, (_, index) => (
        `Middle self-time detail ${index} is deliberately repetitive and removable under pressure.`
      )),
      'The main-thread column is is_main_thread and must remain explicit in the compact contract.',
      'Use fetch_artifact for batch_frame_root_cause rows because skill artifacts are never SQL tables.',
    ].join(' ');
    const description = [
      `Run SQL safely. ${'Introductory detail remains bounded. '.repeat(12)}`,
      sqlSafetyParagraph,
      `Additional paragraph. ${'Low priority context. '.repeat(30)}`,
    ].join('\n\n');

    const compacted = compactRuntimeToolDescription(description);
    const sqlParagraph = compacted
      .split('\n')
      .find(paragraph => paragraph.startsWith('SQL safety rules:')) ?? '';

    expect(sqlParagraph.length).toBeLessThanOrEqual(500);
    expect(sqlParagraph).toContain('s.name AS slice_name');
    expect(sqlParagraph).toContain('FrameTimeline rows expose upid');
    expect(sqlParagraph).toContain('is_main_thread');
    expect(sqlParagraph).toContain('batch_frame_root_cause');
    expect(sqlParagraph).toContain('…');
    expect(sqlParagraph).not.toContain('Middle self-time detail 3');
    expect(sqlParagraph.indexOf('FrameTimeline')).toBeLessThan(sqlParagraph.indexOf('is_main_thread'));
  });

  it('builds a shared tool body from the existing Claude SDK descriptor shape', async () => {
    const existing = sdkTool('invoke_skill');
    const shared = sharedToolSpecFromClaudeSdkTool(
      'invoke_skill',
      existing,
      'public',
      { summary: 'Invoke a skill', requires: ['traceProcessor'] },
    );

    expect(shared).toMatchObject({
      name: 'invoke_skill',
      description: 'invoke_skill description',
      exposure: 'public',
      summary: 'Invoke a skill',
      requires: ['traceProcessor'],
      annotations: { readOnlyHint: true },
    });
    await shared.handler({ q: 'hello' }, {});
    expect(existing.handler).toHaveBeenCalledWith({ q: 'hello' }, {});
  });

  it('builds a Claude SDK-native descriptor from a shared spec', async () => {
    const existing = sdkTool('execute_sql');
    const shared = sharedToolSpecFromClaudeSdkTool('execute_sql', existing, 'public');
    const claude = createClaudeSdkToolFromSharedSpec(shared);

    expect(claude.name).toBe('execute_sql');
    expect(claude.description).toBe('execute_sql description');
    expect(claude.inputSchema).toBe(shared.inputSchema);
    expect(claude.annotations).toEqual({ readOnlyHint: true });

    const result = await claude.handler({ q: 'select 1' } as any, {});
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '{"q":"select 1"}',
    });
  });

  it('emits adapter-safe JSON Schema from the shared Zod raw shape', () => {
    const schema = createJsonSchemaFromZodRawShape({
      skillId: z.string(),
      params: z.record(z.string(), z.any()).optional().describe('Optional skill parameters'),
    });

    expect(schema.required).toEqual(['skillId']);
    expect((schema.properties as any).skillId).toMatchObject({ type: 'string' });
    expect((schema.properties as any).params).toMatchObject({ type: 'string' });
    expect(JSON.stringify(schema)).not.toContain('propertyNames');
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{}');
  });

  it('normalizes JSON container strings and stringifies MCP-style results', () => {
    expect(normalizeRuntimeToolArgs({
      params: '{"enable_startup_details": false}',
      list: ['{"a": 1}', 'plain'],
    })).toEqual({
      params: { enable_startup_details: false },
      list: [{ a: 1 }, 'plain'],
    });
    expect(stringifyRuntimeToolResult({
      content: [
        { type: 'text', text: 'first' },
        { type: 'json', payload: { ok: true } },
      ],
    })).toBe('first\n{"type":"json","payload":{"ok":true}}');
  });

  it('supports a fake third-party adapter without a production runtime value', async () => {
    const handler = jest.fn(async (args: Record<string, unknown>, _extra: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(args) }],
    }));
    const shared: SharedToolSpec = {
      name: 'third_party_probe',
      description: 'Probe shared tool body',
      exposure: 'public',
      inputSchema: { payload: z.string() },
      handler,
    };
    const fakeThirdPartyAdapter = {
      name: `third-party-test:${shared.name}`,
      schema: createJsonSchemaFromZodRawShape(shared.inputSchema),
      call: async (rawArgs: unknown) => shared.handler(
        normalizeRuntimeToolArgs(rawArgs) as Record<string, unknown>,
        { runtime: 'third-party-test-engine' },
      ),
    };

    const result = await fakeThirdPartyAdapter.call({ payload: '{"nested": true}' });

    expect(fakeThirdPartyAdapter.name).toBe('third-party-test:third_party_probe');
    expect(fakeThirdPartyAdapter.schema).toMatchObject({
      type: 'object',
      properties: { payload: { type: 'string' } },
    });
    expect(handler).toHaveBeenCalledWith(
      { payload: { nested: true } },
      { runtime: 'third-party-test-engine' },
    );
    expect((result.content[0] as any).text).toBe('{"payload":{"nested":true}}');
  });
});
