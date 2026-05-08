// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { McpToolDefinition } from '../agentv3/mcpToolRegistry';

interface ClaudeSdkToolLike {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function isClaudeSdkToolLike(value: unknown): value is ClaudeSdkToolLike {
  const toolLike = value as Partial<ClaudeSdkToolLike>;
  return !!toolLike
    && typeof toolLike.name === 'string'
    && typeof toolLike.description === 'string'
    && typeof toolLike.inputSchema === 'object'
    && typeof toolLike.handler === 'function';
}

function stringifyToolResult(result: unknown): string {
  const maybeResult = result as { content?: Array<Record<string, unknown>> };
  if (Array.isArray(maybeResult?.content)) {
    return maybeResult.content.map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    }).join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function sanitizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchema(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // The OpenAI structured-output/tool schema subset does not need these
    // metadata/validation keywords here. `additionalProperties` already
    // carries the useful record-value constraint for z.record(...).
    if (key === '$schema' || key === 'propertyNames') {
      continue;
    }
    sanitized[key] = sanitizeJsonSchema(nested);
  }
  return sanitized;
}

function createOpenAIParameters(inputSchema: z.ZodRawShape): Record<string, unknown> {
  const zodObject = z.object(inputSchema);
  const jsonSchema = z.toJSONSchema(zodObject);
  return sanitizeJsonSchema(jsonSchema) as Record<string, unknown>;
}

function parseJsonContainerString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeOpenAIToolArgs(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parseJsonContainerString(value);
    return parsed === value ? value : normalizeOpenAIToolArgs(parsed);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeOpenAIToolArgs(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeOpenAIToolArgs(nested)]),
  );
}

/**
 * Adapts SmartPerfetto's existing in-process Claude MCP tool registry to
 * OpenAI Agents SDK function tools. The SmartPerfetto tool contract remains
 * the single source of truth; only the SDK adapter changes.
 */
export function createOpenAIToolsFromMcpDefinitions(
  definitions: readonly McpToolDefinition[],
): Tool[] {
  return definitions.map((definition) => {
    if (!isClaudeSdkToolLike(definition.tool)) {
      throw new Error(`Cannot adapt MCP tool ${definition.name}: unsupported SDK descriptor shape`);
    }

    const sdkTool = definition.tool;
    return tool({
      name: definition.name,
      description: sdkTool.description,
      parameters: createOpenAIParameters(sdkTool.inputSchema) as any,
      strict: true,
      execute: async (args) => {
        const normalizedArgs = normalizeOpenAIToolArgs(args) as Record<string, unknown>;
        const result = await sdkTool.handler(normalizedArgs, {});
        return stringifyToolResult(result);
      },
      errorFunction: (_context, error) => {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
          success: false,
          error: message,
          tool: definition.name,
        });
      },
    });
  });
}
