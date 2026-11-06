// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { tool, type Tool } from '@openai/agents';
import type { McpToolDefinition } from '../../../agentv3/mcpToolRegistry';
import {
  createJsonSchemaFromZodRawShape,
  deduplicateNullableSchemaDescriptions,
  normalizeRuntimeToolArgs,
  normalizeRuntimeToolExtra,
  sharedToolSpecFromClaudeSdkTool,
  stringifyRuntimeToolResult,
  type SharedToolSpec,
} from '../../runtimeToolSpec';
import { isTraceProcessorQueryCancelledError } from '../../../services/traceProcessorCancellation';
import {projectRuntimeToolEventPayload} from '../../../services/security/runtimeToolEventProjection';
import type {OpenAiTypedFinalInvocation, createOpenAiTypedFinalAttempt} from './openAiTypedFinalAdmission';

type TypedFinalAttempt = ReturnType<typeof createOpenAiTypedFinalAttempt>;
export interface OpenAiToolAdapterOptions {
  onAdapted?(definition: McpToolDefinition, installed: Tool): void;
  /** Runtime-owned attempt lookup, never an MCP extra value or a model parameter. */
  currentFinalAttempt?(): TypedFinalAttempt | undefined;
}

function getSharedToolSpec(definition: McpToolDefinition): SharedToolSpec {
  if (definition.shared) return definition.shared;
  try {
    return sharedToolSpecFromClaudeSdkTool(
      definition.name,
      definition.tool,
      definition.exposure,
      {summary: definition.summary, requires: definition.requires, role: definition.role, evidenceEffect: definition.evidenceEffect},
    );
  } catch {
    throw new Error(`Cannot adapt MCP tool ${definition.name}: unsupported SDK descriptor shape`);
  }
}

/**
 * The identity of one tool call. The SDK's Chat Completions converter stamps
 * every function call of a response with the same `id` (the response id, or
 * FAKE_ID when the provider sends none); only `callId` tells parallel calls
 * apart, so `id` is a fallback for items that carry no call id at all.
 */
export function openAiToolCallKey(item: unknown): string | undefined {
  const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
  for (const candidate of [record.callId, record.call_id, record.id]) {
    if (typeof candidate === 'string' && candidate.trim() && candidate !== 'unknown') return candidate;
  }
  return undefined;
}

function extractOpenAIToolCallId(details: unknown): string | undefined {
  const value = details as {toolCall?: unknown; toolCallId?: unknown} | undefined;
  const candidate = openAiToolCallKey(value?.toolCall) ?? value?.toolCallId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

/**
 * Adapts SmartPerfetto's existing in-process Claude MCP tool registry to
 * OpenAI Agents SDK function tools. The SmartPerfetto tool contract remains
 * the single source of truth; only the SDK adapter changes.
 */
export function createOpenAIToolsFromMcpDefinitions(
  definitions: readonly McpToolDefinition[],
  options: OpenAiToolAdapterOptions = {},
): Tool[] {
  return definitions.map((definition) => {
    const shared = getSharedToolSpec(definition);
    let installed: Tool;
    const adapted = tool({
      name: definition.name,
      description: shared.description,
      parameters: createJsonSchemaFromZodRawShape(shared.inputSchema) as any,
      strict: true,
      execute: async (args, runContext, details) => {
        const finalRole = shared.role === 'final_candidate_submission';
        const attempt = finalRole ? options.currentFinalAttempt?.() : undefined;
        if (finalRole && !attempt) throw new Error('final_submission_attempt_unavailable');
        const invocation: OpenAiTypedFinalInvocation | undefined = attempt
          ? await attempt.stageInvocation({tool: installed, context: runContext, toolCall: details?.toolCall}) : undefined;
        const normalizedArgs = normalizeRuntimeToolArgs(args, shared.inputSchema) as Record<string, unknown>;
        const contextSignal = (runContext?.context as { signal?: AbortSignal } | undefined)?.signal;
        const signal = details?.signal || contextSignal;
        const toolCallId = extractOpenAIToolCallId(details);
        const result = await shared.handler(normalizedArgs, normalizeRuntimeToolExtra({
          runtime: 'openai-agents-sdk',
          signal,
          toolCallId,
        }));
        const output = stringifyRuntimeToolResult(result);
        if (attempt && invocation) attempt.markPrivateHandlerSuccess(invocation,
          {output, documentJson: normalizedArgs.documentJson});
        return output;
      },
      errorFunction: (_context, error) => {
        if (isTraceProcessorQueryCancelledError(error)) {
          throw error;
        }
        if (shared.role === 'final_candidate_submission') {
          return stringifyRuntimeToolResult(projectRuntimeToolEventPayload(shared.role, {error, result: {isError: true}}).result);
        }
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
          success: false,
          error: message,
          tool: definition.name,
        });
      },
    });
    // SDK has now produced its strict schema. Preserve its parser/handler and
    // the shared source schema; only the provider-facing annotations differ.
    installed = {...adapted, parameters: deduplicateNullableSchemaDescriptions(adapted.parameters)};
    options.onAdapted?.(definition, installed);
    return installed;
  });
}
