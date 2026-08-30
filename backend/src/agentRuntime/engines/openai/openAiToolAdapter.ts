// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { tool, type Tool } from '@openai/agents';
import type { McpToolDefinition } from '../../../agentv3/mcpToolRegistry';
import {
  createJsonSchemaFromZodRawShape,
  normalizeRuntimeToolArgs,
  normalizeRuntimeToolExtra,
  sharedToolSpecFromClaudeSdkTool,
  stringifyRuntimeToolResult,
  type SharedToolSpec,
} from '../../runtimeToolSpec';
import { isTraceProcessorQueryCancelledError } from '../../../services/traceProcessorCancellation';

function getSharedToolSpec(definition: McpToolDefinition): SharedToolSpec {
  if (definition.shared) return definition.shared;
  try {
    return sharedToolSpecFromClaudeSdkTool(
      definition.name,
      definition.tool,
      definition.exposure,
      {summary: definition.summary, requires: definition.requires},
    );
  } catch {
    throw new Error(`Cannot adapt MCP tool ${definition.name}: unsupported SDK descriptor shape`);
  }
}

function extractOpenAIToolCallId(details: unknown): string | undefined {
  const value = details as {
    toolCall?: { id?: unknown };
    toolCallId?: unknown;
  } | undefined;
  const candidate = value?.toolCall?.id ?? value?.toolCallId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
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
    const shared = getSharedToolSpec(definition);
    return tool({
      name: definition.name,
      description: shared.description,
      parameters: createJsonSchemaFromZodRawShape(shared.inputSchema) as any,
      strict: true,
      execute: async (args, runContext, details) => {
        const normalizedArgs = normalizeRuntimeToolArgs(args) as Record<string, unknown>;
        const contextSignal = (runContext?.context as { signal?: AbortSignal } | undefined)?.signal;
        const signal = details?.signal || contextSignal;
        const toolCallId = extractOpenAIToolCallId(details);
        const result = await shared.handler(normalizedArgs, normalizeRuntimeToolExtra({
          runtime: 'openai-agents-sdk',
          signal,
          toolCallId,
        }));
        return stringifyRuntimeToolResult(result);
      },
      errorFunction: (_context, error) => {
        if (isTraceProcessorQueryCancelledError(error)) {
          throw error;
        }
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
