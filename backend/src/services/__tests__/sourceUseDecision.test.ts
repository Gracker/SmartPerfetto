// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  MAX_SOURCE_REFERENCE_COUNT,
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  normalizeSourceReferencePath,
  sanitizeSourceReference,
  sanitizeSourceReferences,
  sanitizeSourceUseDecision,
} from '../codebase/sourceUseDecision';

describe('source use decision contract', () => {
  it.each([
    'src/MainActivity.kt',
    'proto/events.proto',
    'build/settings.gradle',
    'kernel/board.dtsi',
    'app/lib/widget.dart',
    'native/CMakeLists.cmake',
    'queries/startup.sql',
    'docs/README.md',
  ])('accepts a canonical policy or legacy-contract source path: %s', filePath => {
    expect(normalizeSourceReferencePath(`./${filePath}`)).toBe(filePath);
  });

  it.each([
    '/Users/demo/Secret.kt',
    'C:\\private\\Secret.kt',
    '../outside/Secret.kt',
    'src/../Secret.kt',
    'src//Secret.kt',
    'src/Secret.kt\u0000.txt',
    'https://example.test/Secret.kt',
    'src/not-source.txt',
  ])('rejects unsafe or unsupported source paths: %s', filePath => {
    expect(normalizeSourceReferencePath(filePath)).toBeUndefined();
  });

  it('normalizes references and assigns deterministic IDs from safe metadata', () => {
    const input = {
      id: 'caller-controlled-id',
      referenceId: 'source-a1b2c3',
      codebaseId: 'codebase-a',
      filePath: '.\\src\\MainActivity.kt',
      lineRange: {start: 12, end: 19},
      symbol: 'MainActivity.onCreate',
      buildId: 'build-7',
      commitHash: 'a'.repeat(40),
      sourceGeneration: 'codebase_7',
      lookupKind: 'body',
    } as const;

    const first = sanitizeSourceReference(input);
    const second = sanitizeSourceReference({...input, id: 'different-id'});

    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^source-ref-v1-[a-f0-9]{24}$/),
      referenceId: 'source-a1b2c3',
      codebaseId: 'codebase-a',
      filePath: 'src/MainActivity.kt',
      lineRange: {start: 12, end: 19},
      lookupKind: 'body',
    }));
  });

  it('deduplicates references and enforces the canonical maximum count', () => {
    const duplicate = {
      referenceId: 'source-duplicate',
      codebaseId: 'codebase-a',
      filePath: 'src/Duplicate.kt',
      lookupKind: 'body',
    } as const;
    const inputs = [duplicate, duplicate, ...Array.from(
      {length: MAX_SOURCE_REFERENCE_COUNT + 10},
      (_, index) => ({
        referenceId: `source-${index}`,
        codebaseId: 'codebase-a',
        filePath: `src/Source${index}.kt`,
        lookupKind: 'indexed' as const,
      }),
    )];

    const sanitized = sanitizeSourceReferences(inputs);

    expect(sanitized).toHaveLength(MAX_SOURCE_REFERENCE_COUNT);
    expect(new Set(sanitized.map(reference => reference.id)).size).toBe(MAX_SOURCE_REFERENCE_COUNT);
    expect(sanitized[0]).toEqual(expect.objectContaining({referenceId: 'source-duplicate'}));
  });

  it('rejects overlong required fields and drops overlong optional metadata', () => {
    expect(sanitizeSourceReference({
      referenceId: 'source-1',
      codebaseId: 'c'.repeat(161),
      filePath: 'src/Main.kt',
      lookupKind: 'body',
    })).toBeUndefined();
    expect(normalizeSourceReferencePath(`${'a'.repeat(513)}.kt`)).toBeUndefined();
    expect(sanitizeSourceReference({
      referenceId: 'source-1',
      codebaseId: 'codebase-a',
      filePath: 'src/Main.kt',
      symbol: 's'.repeat(257),
      lookupKind: 'body',
    })).toEqual(expect.not.objectContaining({symbol: expect.anything()}));
  });

  it('keeps only bounded authorization metadata and enum-like reasons', () => {
    const decision = sanitizeSourceUseDecision({
      schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
      codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['codebase-a', 'codebase-a', 'bad path'],
      status: 'search_incomplete',
      reasonCode: 'search_incomplete',
      attemptedTools: ['search_codebase', 'x'.repeat(129)],
      queriedCodebaseIds: ['codebase-a', 'codebase-b'],
      usedCodebaseIds: ['codebase-a', 'codebase-b'],
      coverageComplete: false,
      incompleteReasons: ['backend_degraded', 'time_budget', 'PRIVATE REASON CANARY'],
      references: [{
        referenceId: 'source-safe',
        codebaseId: 'codebase-a',
        filePath: 'src/Main.kt',
        lookupKind: 'body',
        query: 'PRIVATE_QUERY_CANARY',
        snippet: 'PRIVATE_SNIPPET_CANARY',
        rootPath: '/PRIVATE_ROOT_CANARY',
      }, {
        referenceId: 'source-other',
        codebaseId: 'codebase-b',
        filePath: 'src/Other.kt',
        lookupKind: 'body',
      }],
      query: 'PRIVATE_DECISION_QUERY_CANARY',
    });

    expect(decision).toEqual({
      schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
      codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['codebase-a'],
      status: 'search_incomplete',
      reasonCode: 'search_incomplete',
      attemptedTools: ['search_codebase'],
      queriedCodebaseIds: ['codebase-a'],
      usedCodebaseIds: ['codebase-a'],
      coverageComplete: false,
      incompleteReasons: ['backend_degraded', 'time_budget'],
      references: [expect.objectContaining({
        id: expect.stringMatching(/^source-ref-v1-/),
        codebaseId: 'codebase-a',
        filePath: 'src/Main.kt',
        lookupKind: 'body',
      })],
    });
    expect(JSON.stringify(decision)).not.toContain('PRIVATE_');
  });
});
