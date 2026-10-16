// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** OpenAI runtime test configuration and a fake chat-completions transport. */

import type {OpenAIAgentConfig} from '../../src/agentRuntime/engines/openai/openAiConfig';

export function createOpenAiConfigForTest(overrides: Partial<OpenAIAgentConfig> = {}): OpenAIAgentConfig {
  return {model: 'pinned-primary', lightModel: 'pinned-light', apiKey: 'test-only',
    baseURL: 'https://provider.invalid/v1', protocol: 'responses', cwd: process.cwd(),
    maxOutputTokens: 1024, maxTurns: 3, quickMaxTurns: 2, quickTargetTurns: 1,
    fullPathPerTurnMs: 60_000, fullRequestTimeoutMs: 60_000, streamIdleTimeoutMs: 60_000,
    maxRunTimeoutMs: 120_000, maxHistoryBytes: 4 * 1024 * 1024, quickPathPerTurnMs: 30_000,
    classifierTimeoutMs: 10_000, outputLanguage: 'zh-CN', ...overrides};
}

/** One streamed chat-completions response, as the provider sends it. */
export function chatCompletionResponse(id: string, delta: unknown, finishReason: string): Response {
  return new Response([
    {id, object: 'chat.completion.chunk', created: 1, model: 'pinned-primary', choices: [{index: 0, delta, finish_reason: null}]},
    {id, object: 'chat.completion.chunk', created: 1, model: 'pinned-primary', choices: [{index: 0, delta: {}, finish_reason: finishReason}]},
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
  {headers: {'content-type': 'text/event-stream'}});
}

/** A response whose only content is one tool call, with id `${id}-call`. */
export function chatCompletionToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return chatCompletionResponse(id, {role: 'assistant',
    tool_calls: [{index: 0, id: `${id}-call`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}, 'tool_calls');
}
