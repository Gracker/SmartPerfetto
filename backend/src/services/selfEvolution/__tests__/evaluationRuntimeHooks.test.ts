// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  extractObservedTokenCount,
} from '../evaluationRuntimeHooks';

describe('evaluation runtime hooks', () => {
  it('normalizes common SDK usage shapes including cache tokens', () => {
    expect(extractObservedTokenCount({
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
    })).toBe(22);
    expect(extractObservedTokenCount({
      usage: {
        inputTokens: 5,
        outputTokens: 4,
        cacheRead: 3,
        cacheWrite: 2,
      },
    })).toBe(14);
    expect(extractObservedTokenCount({
      tokens: {totalTokens: 19, input: 100, output: 100},
    })).toBe(19);
  });
});
