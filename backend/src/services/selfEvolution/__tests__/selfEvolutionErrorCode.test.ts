// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {selfEvolutionErrorCode} from '../selfEvolutionErrorCode';

describe('selfEvolutionErrorCode', () => {
  it('keeps a code and replaces any other message, such as a parser quoting stored text', () => {
    expect(selfEvolutionErrorCode(new Error('proposal_action_conflict'), 'fallback_code')).toBe('proposal_action_conflict');
    let parserError: unknown;
    try {
      JSON.parse('{"overlay":[EVOLUTION-CANARY-2c5 x]}');
    } catch (error) {
      parserError = error;
    }
    // V8 quotes the ten or so characters around the failure.
    expect(String(parserError)).toContain('EVOLUTION-');
    expect(selfEvolutionErrorCode(parserError, 'fallback_code')).toBe('fallback_code');
  });

  it('takes the fallback for anything thrown that is not an Error', () => {
    for (const thrown of ['curation_proposal_not_found', undefined, null, 404]) {
      expect(selfEvolutionErrorCode(thrown, 'fallback_code')).toBe('fallback_code');
    }
  });
});
