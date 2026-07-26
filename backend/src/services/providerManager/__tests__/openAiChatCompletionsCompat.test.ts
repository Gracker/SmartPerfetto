// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { buildOpenAIChatCompletionsTokenLimit } from '../openAiChatCompletionsCompat';

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
