// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {redactObjectForLLM} from '../llmPrivacy';

describe('redactObjectForLLM', () => {
  it('keeps an own __proto__ key as redacted data instead of a prototype', () => {
    const {value} = redactObjectForLLM(JSON.parse('[{"__proto__":{"token":"abc","safe":"value"}}]'));
    const [item] = value as object[];

    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(JSON.stringify(item)).toBe('{"__proto__":{"token":"<REDACTED>","safe":"value"}}');
  });
});
