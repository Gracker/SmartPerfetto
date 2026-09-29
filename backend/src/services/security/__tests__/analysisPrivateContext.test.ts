// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';
import {describe, expect, it} from '@jest/globals';

import {
  NO_PRIVATE_CONTEXT,
  decodePrivateContextColumn,
  decodePrivateContextJson,
  encodePrivateContextColumn,
  privateContextRestrictsAudience,
  resolveAnalysisPrivateContext,
  unionPrivateContexts,
  unrestrictedPrivateContextSql,
} from '../analysisPrivateContext';

describe('analysis private context marker', () => {
  it('follows the authorized selection, not whether material was used', () => {
    expect(resolveAnalysisPrivateContext({codeAwareMode: 'provider_send', codebaseIds: ['app']}))
      .toEqual({codebase: true, knowledge: false});
    expect(resolveAnalysisPrivateContext({codeAwareMode: 'metadata_only', codebaseIds: ['app'],
      knowledgeSourceIds: ['kb']})).toEqual({codebase: true, knowledge: true});
    expect(resolveAnalysisPrivateContext({knowledgeSourceIds: ['kb']}))
      .toEqual({codebase: false, knowledge: true});
    // An unset mode normalizes to metadata_only: the run still has source tools.
    expect(resolveAnalysisPrivateContext({codebaseIds: ['app']})).toEqual({codebase: true, knowledge: false});
    // With code-aware analysis off the run has no source tools at all.
    expect(resolveAnalysisPrivateContext({codeAwareMode: 'off', codebaseIds: ['app']})).toEqual(NO_PRIVATE_CONTEXT);
    expect(resolveAnalysisPrivateContext({codeAwareMode: 'provider_send', codebaseIds: []})).toEqual(NO_PRIVATE_CONTEXT);
    expect(resolveAnalysisPrivateContext({})).toEqual(NO_PRIVATE_CONTEXT);
  });

  it('restricts marked and unknown artifacts alike', () => {
    expect(privateContextRestrictsAudience(NO_PRIVATE_CONTEXT)).toBe(false);
    expect(privateContextRestrictsAudience({codebase: true, knowledge: false})).toBe(true);
    expect(privateContextRestrictsAudience({codebase: false, knowledge: true})).toBe(true);
    expect(privateContextRestrictsAudience('unknown')).toBe(true);
    expect(privateContextRestrictsAudience(undefined)).toBe(true);
  });

  it('keeps an unknown input unknown when combining sources', () => {
    expect(unionPrivateContexts([NO_PRIVATE_CONTEXT, {codebase: true, knowledge: false},
      {codebase: false, knowledge: true}])).toEqual({codebase: true, knowledge: true});
    expect(unionPrivateContexts([NO_PRIVATE_CONTEXT, NO_PRIVATE_CONTEXT])).toEqual(NO_PRIVATE_CONTEXT);
    expect(unionPrivateContexts([{codebase: true, knowledge: false}, 'unknown'])).toBe('unknown');
    expect(unionPrivateContexts([])).toEqual(NO_PRIVATE_CONTEXT);
  });

  it('round-trips through storage and reads anything malformed as unknown', () => {
    for (const marker of [NO_PRIVATE_CONTEXT, {codebase: true, knowledge: false},
      {codebase: false, knowledge: true}, {codebase: true, knowledge: true}]) {
      expect(decodePrivateContextColumn(encodePrivateContextColumn(marker))).toEqual(marker);
      expect(decodePrivateContextJson(JSON.parse(JSON.stringify(marker)))).toEqual(marker);
    }
    expect(encodePrivateContextColumn('unknown')).toBeNull();
    // An object deserialized from before markers existed carries none.
    expect(encodePrivateContextColumn(undefined)).toBeNull();
    for (const malformed of [null, undefined, -1, 4, 1.5, '1']) {
      expect(decodePrivateContextColumn(malformed)).toBe('unknown');
    }
    for (const malformed of [null, undefined, true, {codebase: 'yes', knowledge: false}, {codebase: true}]) {
      expect(decodePrivateContextJson(malformed)).toBe('unknown');
    }
  });

  it('treats only a stored 0 as unrestricted in SQL', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, private_context INTEGER)');
      db.exec("INSERT INTO runs VALUES ('public', 0), ('codebase', 1), ('knowledge', 2), ('unknown', NULL)");
      expect(db.prepare(`SELECT id FROM runs WHERE ${unrestrictedPrivateContextSql('private_context')}`).all())
        .toEqual([{id: 'public'}]);
    } finally {
      db.close();
    }
  });
});
