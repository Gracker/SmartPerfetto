// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  mergeSourceUseStatus,
  referenceHasReadBody,
  MAX_SOURCE_REFERENCE_COUNT,
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  normalizeSourceReferencePath,
  sanitizeSourceReference,
  sanitizeSourceReferences,
  sanitizeSourceUseDecision,
  sourceReferenceCounts,
  sourceUseDecisionForClient,
  type SourceReferenceV1,
} from '../codebase/sourceUseDecision';
import {projectStoredConclusionSourceMetadata} from '../security/analysisDeliveryProjection';

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
    '源码/启动流程.kt',
    'feature modules/Main Screen.kt',
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
    'C:relative/Secret.kt',
    'src/hidden\u202efile.kt',
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

  it('caps metadata-only source decisions below corroborated', () => {
    const decision = sanitizeSourceUseDecision({
      schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
      codeAwareMode: 'metadata_only',
      selectedCodebaseIds: ['codebase-a'],
      status: 'corroborated',
      reasonCode: 'search_incomplete',
      attemptedTools: ['query_code_graph'],
      queriedCodebaseIds: ['codebase-a'],
      usedCodebaseIds: ['codebase-a'],
      references: [{
        referenceId: 'graph-ref',
        codebaseId: 'codebase-a',
        filePath: 'src/Main.kt',
        lookupKind: 'graph',
      }],
    });

    expect(decision).toEqual(expect.objectContaining({
      codeAwareMode: 'metadata_only',
      status: 'located',
    }));
    expect(decision).not.toHaveProperty('reasonCode');
  });

  it('counts a located range as read only inside a body window of the same file and generation', () => {
    const ref = (lookupKind: SourceReferenceV1['lookupKind'], start: number, end: number, sourceGeneration?: string) =>
      sanitizeSourceReference({referenceId: `${lookupKind}-${start}-${end}`, codebaseId: 'app', filePath: 'src/A.kt',
        lineRange: {start, end}, lookupKind, ...(sourceGeneration ? {sourceGeneration} : {})})!;
    const hit = ref('search_hit', 12, 14, 'live-1');

    expect(referenceHasReadBody(hit, [ref('body', 10, 20, 'live-1')])).toBe(true);
    expect(referenceHasReadBody(hit, [ref('body', 13, 20, 'live-1')])).toBe(false);
    expect(referenceHasReadBody(hit, [ref('metadata', 10, 20, 'live-1')])).toBe(false);
    // The file changed between the search and the read.
    expect(referenceHasReadBody(hit, [ref('body', 10, 20, 'live-2')])).toBe(false);
    // An unknown generation is never the same one.
    expect(referenceHasReadBody(ref('search_hit', 12, 14), [ref('body', 10, 20)])).toBe(false);
    expect(referenceHasReadBody(ref('body', 1, 2), [])).toBe(true);
    // Adjacent windows of one known version cover together, as a written citation is judged; of two versions, never.
    const wide = ref('search_hit', 15, 25, 'live-1');
    expect(referenceHasReadBody(wide, [ref('body', 10, 20, 'live-1'), ref('body', 21, 30, 'live-1')])).toBe(true);
    expect(referenceHasReadBody(wide, [ref('body', 10, 20, 'live-1'), ref('body', 22, 30, 'live-1')])).toBe(false);
    expect(referenceHasReadBody(wide, [ref('body', 10, 20, 'live-1'), ref('body', 21, 30, 'live-2')])).toBe(false);
  });

  it('gives clients read/located counts by the verdicts\' rule, and never fingerprints them', () => {
    const ref = (lookupKind: SourceReferenceV1['lookupKind'], start: number, end: number, sourceGeneration?: string) =>
      sanitizeSourceReference({referenceId: `${lookupKind}-${start}-${end}-${sourceGeneration}`, codebaseId: 'app',
        filePath: 'src/界面 模块/A.kt', lineRange: {start, end}, lookupKind,
        ...(sourceGeneration ? {sourceGeneration} : {})})!;
    // Two adjacent windows read lines 10-30; a hit inside them is read, one of another version or unknown is not.
    const references = [ref('body', 10, 20, 'live-1'), ref('body', 21, 30, 'live-1'), ref('search_hit', 15, 25, 'live-1'),
      ref('search_hit', 15, 25, 'live-2'), ref('search_hit', 31, 32, 'live-1'), ref('search_hit', 12, 13)];
    expect(sourceReferenceCounts(references)).toEqual({located: 6, read: 3});
    // Bounds at the backend's own limits stay countable (no second, narrower parser).
    const far = [ref('body', 2_000_000_000, 2_000_000_009, 'g'.repeat(256)),
      ref('search_hit', 2_000_000_001, 2_000_000_002, 'g'.repeat(256))];
    expect(sourceReferenceCounts(far)).toEqual({located: 2, read: 2});

    const decision = sanitizeSourceUseDecision({schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
      codeAwareMode: 'provider_send', selectedCodebaseIds: ['app'], status: 'corroborated', attemptedTools: [],
      queriedCodebaseIds: ['app'], usedCodebaseIds: ['app'], references})!;
    const forClient = sourceUseDecisionForClient(decision)!;
    expect(forClient.referenceCounts).toEqual({located: 6, read: 3});
    expect(forClient.references).toBe(decision.references);
    // Derived, so a sanitized copy (what every fingerprint reads) never carries it.
    expect(sanitizeSourceUseDecision(forClient)).toEqual(decision);
    expect(sanitizeSourceUseDecision(forClient)).not.toHaveProperty('referenceCounts');
    const empty = {...decision, references: []};
    expect(sourceUseDecisionForClient(empty)).toBe(empty);
    expect(sourceUseDecisionForClient(undefined)).toBeUndefined();
  });

  it('keeps a binding to a reference the model cited in its visible form, without the internal referenceId', () => {
    const issued = sanitizeSourceReference({referenceId: 'source_internal', codebaseId: 'app', filePath: 'src/A.kt',
      lineRange: {start: 1, end: 5}, sourceGeneration: 'live-1', lookupKind: 'body'})!;
    const {referenceId: _internal, ...visible} = issued;
    const decision = {schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION, codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['app'], status: 'corroborated' as const, attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['app'], usedCodebaseIds: ['app'], references: [issued]};
    const contract = {schemaVersion: 'conclusion_contract_v1', sourceReferences: [visible],
      sourceClaimBindings: [{claimId: 'c', mechanismStatus: 'compatible', sourceReferenceIds: [visible.id],
        traceEvidenceRefIds: []}]};

    const projected = projectStoredConclusionSourceMetadata(contract, decision) as typeof contract;

    expect(visible.id).toBe(issued.id);
    expect(projected.sourceClaimBindings).toEqual([expect.objectContaining({sourceReferenceIds: [issued.id]})]);
  });

  it.each([
    // [current, observedPositive, observedIncomplete, runIncomplete, completeAbsence, expected]
    ['search_incomplete', 'located', false, true, false, 'located'],
    ['located', undefined, true, true, false, 'located'],
    ['located', 'corroborated', false, false, false, 'corroborated'],
    ['corroborated', 'located', false, false, false, 'corroborated'],
    ['attempted', undefined, true, true, false, 'search_incomplete'],
    ['pending', undefined, false, false, true, 'not_found_complete'],
    ['not_found_complete', undefined, false, true, false, 'search_incomplete'],
    ['pending', undefined, false, false, false, 'attempted'],
    ['not_needed', 'located', false, false, false, 'not_needed'],
    ['not_needed', undefined, true, true, false, 'search_incomplete'],
  ] as const)('merges %s with a %s lookup into the strongest finding', (
    current, observedPositive, observedIncomplete, runIncomplete, observedCompleteAbsence, expected) => {
    expect(mergeSourceUseStatus({current, observedPositive, observedIncomplete, runIncomplete,
      observedCompleteAbsence})).toBe(expected);
  });
});
