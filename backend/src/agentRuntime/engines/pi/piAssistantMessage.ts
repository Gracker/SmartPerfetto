// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentMessage} from '@earendil-works/pi-agent-core';
import type {AssistantMessage, ToolCall} from '@earendil-works/pi-ai';

/** Whether a Pi assistant message asked for a tool; its content blocks are the only evidence. */
export function piAssistantMessageHasToolCall(message: {content?: unknown} | undefined): boolean {
  return Array.isArray(message?.content)
    && message.content.some(part => (part as {type?: unknown} | undefined)?.type === 'toolCall');
}

/** The installed SDK rejects every tool call in a length-stopped assistant response. */
export function piOutputLimitedToolCalls(message: unknown): ToolCall[] {
  const value = message as Partial<AssistantMessage> | undefined;
  if (value?.role !== 'assistant' || value.stopReason !== 'length' || !Array.isArray(value.content)) return [];
  return value.content.filter((part): part is ToolCall => part?.type === 'toolCall');
}

/** Add batch-level guidance to the last SDK rejection in the model-facing context. */
export async function addPiOutputLimitToolFeedback(messages: AgentMessage[]): Promise<AgentMessage[]> {
  let assistantIndex = messages.length - 1;
  while (assistantIndex >= 0 && messages[assistantIndex].role !== 'assistant') assistantIndex--;
  const calls = piOutputLimitedToolCalls(messages[assistantIndex]);
  if (calls.length === 0) return messages;
  const lastCallId = calls[calls.length - 1].id;
  const resultIndex = messages.findIndex((message, index) => index > assistantIndex &&
    message.role === 'toolResult' && message.isError && message.toolCallId === lastCallId);
  const result = messages[resultIndex];
  if (result?.role !== 'toolResult') return messages;
  // Count exact repeats of the parsed wire arguments, preserving key order.
  const distinctCalls = new Set(calls.map(call => JSON.stringify([call.name, call.arguments]))).size;
  const repeatedCalls = calls.length - distinctCalls;
  const text = `The output token limit rejected all ${calls.length} tool calls in that response. ` +
    (repeatedCalls ? `${repeatedCalls} repeated an identical tool call. ` : '') +
    'Re-issue only the smallest necessary set of distinct calls with complete arguments. ' +
    'Do not repeat calls within a response or enumerate the same inventory by batches of prefixes.';
  if (result.content.some(part => part.type === 'text' && part.text === text)) return messages;
  return messages.map((message, index) => index === resultIndex
    ? {...result, content: [...result.content, {type: 'text', text}]}
    : message);
}
