// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildOpenAIChatCompletionsTokenLimit,
  isOpenAIChatCompletionsOutputTruncated,
  readOpenAIChatCompletionsOutput,
} from '../openAiChatCompletionsCompat';

describe('OpenAI Chat Completions token-limit compatibility', () => {
  it.each([
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-sol-2026-07-24',
    'openai/gpt-5.6-sol',
    'accounts/example/models/gpt-5.6-terra-2026-07-24',
  ])('uses max_completion_tokens for %s', model => {
    expect(buildOpenAIChatCompletionsTokenLimit(model, 2048)).toEqual({
      max_completion_tokens: 2048,
    });
  });

  it.each([
    'gpt-5.4-mini',
    'deepseek-v4-pro',
    'qwen3:8b',
  ])('preserves max_tokens for compatible model %s', model => {
    expect(buildOpenAIChatCompletionsTokenLimit(model, 2048)).toEqual({
      max_tokens: 2048,
    });
  });
});

describe('readOpenAIChatCompletionsOutput', () => {
  it('reads content, finish reason, and reasoning usage', () => {
    expect(readOpenAIChatCompletionsOutput({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 42, completion_tokens_details: { reasoning_tokens: 39 } },
    })).toEqual({
      text: 'hi',
      finishReason: 'stop',
      completionTokens: 42,
      reasoningTokens: 39,
    });
  });

  it('normalizes an empty reasoning-only turn to empty text', () => {
    expect(readOpenAIChatCompletionsOutput({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 199 } },
    }).text).toBe('');
  });

  it('omits absent fields instead of inventing zeros', () => {
    expect(readOpenAIChatCompletionsOutput({ choices: [{ message: {} }] }))
      .toEqual({ text: '' });
  });

  it('tolerates a malformed or empty body', () => {
    expect(readOpenAIChatCompletionsOutput(undefined)).toEqual({ text: '' });
    expect(readOpenAIChatCompletionsOutput({ choices: [] })).toEqual({ text: '' });
    expect(readOpenAIChatCompletionsOutput({ choices: [{ message: { content: 7 } }] }))
      .toEqual({ text: '' });
  });
});

describe('isOpenAIChatCompletionsOutputTruncated', () => {
  it('trusts an explicit length finish reason', () => {
    expect(isOpenAIChatCompletionsOutputTruncated(
      { text: '', finishReason: 'length' }, 2048,
    )).toBe(true);
  });

  it('trusts an explicit non-length finish reason over usage', () => {
    expect(isOpenAIChatCompletionsOutputTruncated(
      { text: '', finishReason: 'stop', completionTokens: 2048 }, 2048,
    )).toBe(false);
  });

  it('falls back to usage when the gateway omits finish_reason', () => {
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 2048 }, 2048))
      .toBe(true);
    // Providers may bill a token or two below the cap on a truncated turn.
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 2040 }, 2048))
      .toBe(true);
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 400 }, 2048))
      .toBe(false);
  });

  it('reports not-truncated when usage is missing entirely', () => {
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '' }, 2048)).toBe(false);
  });

  it('reports not-truncated for a non-positive cap', () => {
    expect(isOpenAIChatCompletionsOutputTruncated({ text: '', completionTokens: 5 }, 0))
      .toBe(false);
  });
});
