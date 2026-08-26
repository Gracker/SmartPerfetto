// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {redactSecrets} from '../secretPatterns';

describe('redactSecrets', () => {
  it('redacts long unquoted secret assignments', () => {
    expect(redactSecrets('password=hunter2long')).toEqual({
      text: '[REDACTED_SECRET]',
      redactedCount: 1,
    });
    expect(redactSecrets('api_key: abcdefghijk')).toEqual({
      text: '[REDACTED_SECRET]',
      redactedCount: 1,
    });
  });

  it('does not treat short assignments, identifiers, or prose as secrets', () => {
    for (const input of [
      'password=short',
      'const passwordValidator = validatePassword(input);',
      'the password field must be at least eight characters',
    ]) {
      expect(redactSecrets(input)).toEqual({text: input, redactedCount: 0});
    }
  });
});
