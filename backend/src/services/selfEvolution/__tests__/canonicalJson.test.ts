// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {canonicalContentHash, canonicalJsonString, storedJsonContentHash} from '../canonicalJson';

describe('canonical JSON', () => {
  it('keeps an own __proto__ key as data, so its content is hashed', () => {
    const first = JSON.parse('{"finding": {"__proto__": {"text": "measured"}, "id": "f1"}}');
    const second = JSON.parse('{"finding": {"__proto__": {"text": "edited"}, "id": "f1"}}');

    expect(canonicalJsonString(first)).toBe('{"finding":{"__proto__":{"text":"measured"},"id":"f1"}}');
    expect(canonicalContentHash(first)).not.toBe(canonicalContentHash(second));
    expect(storedJsonContentHash(first)).not.toBe(storedJsonContentHash(second));
  });

  it('hashes the stored JSON form: undefined fields, Dates and non-finite numbers as a store reads them back', () => {
    const value = {at: new Date('2026-01-02T03:04:05Z'), skipped: undefined, samples: [1, undefined, Number.NaN]};
    expect(storedJsonContentHash(value)).toBe(canonicalContentHash({at: '2026-01-02T03:04:05.000Z', samples: [1, null, null]}));
  });
});
