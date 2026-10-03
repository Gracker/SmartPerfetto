// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary} from '../../security/codeAwareOutputRegistry';
import {
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  sanitizeSourceReference,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../sourceUseDecision';
import {
  attachSourceUseToAnalysisResult,
  finalizeSourceAwareAnalysisResultWithProjection,
  projectSafeSourceProvenance,
  verifySourceClaimBindings,
} from '../sourceClaimVerifier';

function reference(
  lookupKind: SourceReferenceV1['lookupKind'] = 'body',
  codebaseId = 'app-source',
): SourceReferenceV1 {
  return sanitizeSourceReference({
    id: 'model-controlled-id',
    referenceId: 'lookup-1',
    codebaseId,
    filePath: 'src/main/Foo.kt',
    lineRange: {start: 10, end: 20},
    symbol: 'Foo.run',
    lookupKind,
  })!;
}

function decision(
  sourceReference: SourceReferenceV1,
  overrides: Partial<SourceUseDecisionV1> = {},
): SourceUseDecisionV1 {
  return {
    schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
    codeAwareMode: 'provider_send',
    selectedCodebaseIds: ['app-source'],
    status: sourceReference.lookupKind === 'body' || sourceReference.lookupKind === 'indexed'
      ? 'corroborated'
      : 'located',
    attemptedTools: ['read_codebase_file'],
    queriedCodebaseIds: ['app-source'],
    usedCodebaseIds: ['app-source'],
    coverageComplete: true,
    references: [sourceReference],
    ...overrides,
  };
}

function contract(claimText = 'Foo.run overlaps the verified trace occurrence'): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [{rank: 1, statement: claimText}],
    clusters: [],
    evidenceChain: [],
    claims: [{
      id: 'claim-1',
      kind: 'causal',
      text: claimText,
      references: [{evidenceRefId: 'data:trace-1'}],
    }, {
      id: 'claim-2',
      kind: 'numeric',
      text: 'Another trace claim',
      references: [{evidenceRefId: 'data:trace-2'}],
    }],
    sourceClaimBindings: [],
    uncertainties: [],
    nextSteps: [],
  };
}

function verify(input: {
  sourceReference?: SourceReferenceV1;
  sourceUseDecision?: SourceUseDecisionV1;
  claimText?: string;
  binding?: Record<string, unknown>;
  matchedTraceIds?: Record<string, string[]>;
  verifiedOccurrenceTraceIds?: Record<string, string[]>;
}) {
  const sourceReference = input.sourceReference ?? reference();
  const sourceUseDecision = input.sourceUseDecision ?? decision(sourceReference);
  const conclusionContract = contract(input.claimText);
  conclusionContract.sourceUseDecision = sourceUseDecision;
  conclusionContract.sourceReferences = [sourceReference];
  conclusionContract.sourceClaimBindings = [input.binding as any ?? {
    claimId: 'claim-1',
    mechanismStatus: 'corroborated',
    sourceReferenceIds: [sourceReference.id],
    traceEvidenceRefIds: ['data:trace-1'],
  }];
  const matchedTraceIds = input.matchedTraceIds ?? {
    'claim-1': ['data:trace-1'],
    'claim-2': ['data:trace-2'],
  };
  return verifySourceClaimBindings({
    conclusionContract,
    actualSourceUseDecision: sourceUseDecision,
    matchedTraceEvidenceRefIdsByClaimId: matchedTraceIds,
    verifiedTraceOccurrenceRefIdsByClaimId:
      input.verifiedOccurrenceTraceIds ?? matchedTraceIds,
  });
}

describe('verifySourceClaimBindings', () => {
  test.each(['compatible', 'corroborated', 'ambiguous', 'unverified'] as const)(
    'does not accept an empty %s binding when selected source was never read', mechanismStatus => {
      const declaration = contract('The selected source has not been investigated.');
      declaration.sourceClaimBindings = [{claimId: 'claim-1', mechanismStatus,
        sourceReferenceIds: [], traceEvidenceRefIds: []}];
      const unusedSource = decision(reference(), {status: 'not_needed', reasonCode: 'not_needed',
        attemptedTools: [], queriedCodebaseIds: [], usedCodebaseIds: [], references: []});
      for (const semanticsPolicy of ['declared', 'legacy'] as const) {
        const result = verifySourceClaimBindings({conclusionContract: declaration,
          actualSourceUseDecision: unusedSource, semanticsPolicy});
        expect(result.status).toBe('failed');
        expect(result.bindings).toEqual([]);
        expect(result.issues).toContainEqual(expect.objectContaining({claimId: 'claim-1',
          severity: 'error', code: 'source_reference_not_returned'}));
      }
    });

  test('rejects a binding whose malformed source IDs sanitize to an empty list', () => {
    const result = verify({binding: {claimId: 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: ['', 'invalid source id'], traceEvidenceRefIds: []}});
    expect(result.status).toBe('failed');
    expect(result.bindings).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_reference_not_returned'}));
  });

  test.each(['metadata', 'body'] as const)('still accepts a compatible binding to actual %s evidence', lookupKind => {
    const source = reference(lookupKind);
    const result = verify({sourceReference: source,
      sourceUseDecision: decision(source, {codeAwareMode: lookupKind === 'metadata' ? 'metadata_only' : 'provider_send'}),
      binding: {claimId: 'claim-1', mechanismStatus: 'compatible',
        sourceReferenceIds: [source.id], traceEvidenceRefIds: []}});
    expect(result.status).toBe('passed');
    expect(result.bindings).toEqual([{claimId: 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: [source.id], traceEvidenceRefIds: []}]);
  });

  test.each(['referenceId', 'chunkId'] as const)('binds an unambiguous tool-visible %s from the current ledger', key => {
    const source = sanitizeSourceReference({[key]: 'returned-lookup', codebaseId: 'app-source',
      filePath: '源码/Startup Hooks.kt', lineRange: {start: 10, end: 20}, lookupKind: 'body'})!;
    const result = verify({sourceReference: source, binding: {claimId: 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: ['returned-lookup'], traceEvidenceRefIds: []}});
    expect(result.status).toBe('passed');
    expect(result.bindings[0]?.sourceReferenceIds).toEqual([source.id]);
  });

  test('rejects ambiguous legacy aliases while keeping each issued canonical ID usable', () => {
    const first = reference();
    const second = sanitizeSourceReference({...first, lineRange: {start: 10, end: 30}})!;
    const actual = decision(first, {references: [first, second]});
    const binding = {claimId: 'claim-1', mechanismStatus: 'compatible', traceEvidenceRefIds: []};
    expect(verify({sourceUseDecision: actual, binding: {...binding, sourceReferenceIds: [first.referenceId]}})
      .issues).toContainEqual(expect.objectContaining({code: 'source_reference_not_returned'}));
    expect(verify({sourceUseDecision: actual, binding: {...binding, sourceReferenceIds: [second.id]}}).status).toBe('passed');
  });

  test('does not accept model-created aliases or a reference from a previous run', () => {
    const source = reference();
    const declaration = contract();
    declaration.sourceReferences = [{...source, id: 'model-alias'}];
    declaration.sourceClaimBindings = [{claimId: 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: ['model-alias'], traceEvidenceRefIds: []}];
    expect(verifySourceClaimBindings({conclusionContract: declaration, actualSourceUseDecision: decision(source)})
      .issues).toContainEqual(expect.objectContaining({code: 'source_reference_not_returned'}));
    declaration.sourceClaimBindings[0].sourceReferenceIds = [source.id];
    expect(verifySourceClaimBindings({conclusionContract: declaration,
      actualSourceUseDecision: decision(source, {status: 'pending', references: []})})
      .issues).toContainEqual(expect.objectContaining({code: 'source_reference_not_returned'}));
  });

  test('does not promote source text and a verified interval into a native mechanism proof', () => {
    const source = reference();
    const declaration = contract();
    declaration.bindingEligibility = 'eligible';
    declaration.claims![0].semantics = {schemaVersion: 'claim_semantics@1', predicate: 'interval.overlap',
      polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows'}};
    declaration.sourceClaimBindings = [{claimId: 'claim-1', mechanismStatus: 'corroborated',
      sourceReferenceIds: [source.id], traceEvidenceRefIds: ['data:trace-1']}];
    const verified = verifySourceClaimBindings({conclusionContract: declaration, actualSourceUseDecision: decision(source),
      semanticsPolicy: 'declared', matchedTraceEvidenceRefIdsByClaimId: {'claim-1': ['data:trace-1']},
      verifiedTraceOccurrenceRefIdsByClaimId: {'claim-1': ['data:trace-1']}});
    expect(verified).toMatchObject({status: 'partial', bindings: [{mechanismStatus: 'compatible'}],
      issues: [{code: 'source_binding_mechanism_unverified'}]});
    expect(declaration.sourceClaimBindings[0].mechanismStatus).toBe('corroborated');
  });

  test.each(['missing', 'duplicate'] as const)('does not manufacture source claim identity for %s IDs', kind => {
    const source = reference();
    const declaration = contract();
    if (kind === 'missing') delete declaration.claims![0].id;
    else declaration.claims![1].id = declaration.claims![0].id;
    declaration.sourceClaimBindings = [{claimId: kind === 'missing' ? 'Q1' : 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: [source.id], traceEvidenceRefIds: []}];
    const verified = verifySourceClaimBindings({conclusionContract: declaration, actualSourceUseDecision: decision(source),
      semanticsPolicy: 'declared'});
    expect(verified.status).toBe('partial');
    expect(verified.bindings).toEqual([]);
  });
  test.each(['源码不存在', 'The implementation is absent', '这只是任意展示文字'])(
    'uses declared source semantics independently from wording: %s', text => {
      const source = reference();
      const declaration = contract(text);
      declaration.bindingEligibility = 'eligible';
      declaration.claims![0].semantics = {schemaVersion: 'claim_semantics@1', predicate: 'source.existence',
        polarity: 'negated', discourse: 'asserted', quantifier: 'all', modality: 'certain', scope: {population: 'codebase'}};
      declaration.sourceClaimBindings = [{claimId: 'claim-1', mechanismStatus: 'compatible',
        sourceReferenceIds: [source.id], traceEvidenceRefIds: []}];
      for (const status of ['corroborated', 'search_incomplete'] as const) {
        const verified = verifySourceClaimBindings({conclusionContract: declaration,
          actualSourceUseDecision: decision(source, {status, coverageComplete: true}), semanticsPolicy: 'declared'});
        expect(verified.status).toBe('partial');
        expect(verified.issues).toEqual([expect.objectContaining({severity: 'warning', code: 'source_absence_requires_complete_search'})]);
      }
    });

  test('still reports actual unauthorized references when declared semantics are unchecked', () => {
    const source = reference();
    const declaration = contract();
    declaration.sourceClaimBindings = [{claimId: 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: ['never-returned'], traceEvidenceRefIds: []}];
    const verified = verifySourceClaimBindings({conclusionContract: declaration,
      actualSourceUseDecision: decision(source), semanticsPolicy: 'declared'});
    expect(verified.status).toBe('failed');
    expect(verified.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'source_claim_semantics_unchecked', 'source_reference_not_returned',
    ]));
  });

  test('accepts corroborated provider body evidence bound to a verified trace occurrence', () => {
    const result = verify({});

    expect(result.status).toBe('passed');
    expect(result.issues).toEqual([]);
    expect(result.bindings).toEqual([
      expect.objectContaining({
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        traceEvidenceRefIds: ['data:trace-1'],
      }),
    ]);
  });

  test('downgrades metadata-only corroboration to compatible with an explicit issue', () => {
    const sourceReference = reference('metadata');
    const result = verify({
      sourceReference,
      sourceUseDecision: decision(sourceReference, {
        codeAwareMode: 'metadata_only',
        status: 'located',
      }),
    });

    expect(result.status).toBe('partial');
    expect(result.bindings[0]?.mechanismStatus).toBe('compatible');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_strength_downgraded'}),
    ]));
  });

  test('rejects fabricated references not returned by this run', () => {
    const result = verify({
      binding: {
        claimId: 'claim-1',
        mechanismStatus: 'compatible',
        sourceReferenceIds: ['source-ref-v1-fabricated000000000000'],
        traceEvidenceRefIds: [],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.bindings).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_reference_not_returned'}),
    ]));
  });

  test('rejects references outside the selected codebase partition', () => {
    const wrongPartitionReference = reference('body', 'other-source');
    const selectedReference = reference();
    const sourceUseDecision = decision(selectedReference) as SourceUseDecisionV1 & {references: SourceReferenceV1[]};
    sourceUseDecision.references = [selectedReference, wrongPartitionReference];
    const result = verify({
      sourceReference: wrongPartitionReference,
      sourceUseDecision,
      binding: {
        claimId: 'claim-1',
        mechanismStatus: 'compatible',
        sourceReferenceIds: [wrongPartitionReference.id],
        traceEvidenceRefIds: [],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_reference_outside_selection'}),
    ]));
  });

  test('downgrades corroboration without a claimed verified trace occurrence', () => {
    const sourceReference = reference();
    const result = verify({
      sourceReference,
      matchedTraceIds: {'claim-1': [], 'claim-2': ['data:trace-2']},
      verifiedOccurrenceTraceIds: {'claim-1': [], 'claim-2': ['data:trace-2']},
      binding: {
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: [],
      },
    });

    expect(result.status).toBe('partial');
    expect(result.bindings[0]?.mechanismStatus).toBe('compatible');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_trace_support_missing'}),
    ]));
  });

  test('rejects trace evidence that belongs to another claim', () => {
    const sourceReference = reference();
    const result = verify({
      sourceReference,
      binding: {
        claimId: 'claim-1',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['data:trace-2'],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.bindings).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_trace_cross_claim'}),
    ]));
  });

  test('accepts partial same-claim membership but downgrades corroboration without a verified occurrence', () => {
    const result = verify({
      matchedTraceIds: {'claim-1': ['data:trace-1']},
      verifiedOccurrenceTraceIds: {'claim-1': []},
    });

    expect(result.status).toBe('partial');
    expect(result.bindings[0]).toEqual(expect.objectContaining({
      claimId: 'claim-1',
      mechanismStatus: 'compatible',
      traceEvidenceRefIds: ['data:trace-1'],
    }));
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_binding_trace_occurrence_not_verified'}),
    ]));
  });

  test('never verifies contract-declared source context without an actual accessor decision', () => {
    const sourceReference = reference();
    const fabricatedDecision = decision(sourceReference);
    const conclusionContract = contract();
    conclusionContract.sourceUseDecision = fabricatedDecision;
    conclusionContract.sourceReferences = [sourceReference];
    conclusionContract.sourceClaimBindings = [{
      claimId: 'claim-1',
      mechanismStatus: 'corroborated',
      sourceReferenceIds: [sourceReference.id],
      traceEvidenceRefIds: ['data:trace-1'],
    }];

    const result = verifySourceClaimBindings({
      conclusionContract,
      matchedTraceEvidenceRefIdsByClaimId: {'claim-1': ['data:trace-1']},
      verifiedTraceOccurrenceRefIdsByClaimId: {'claim-1': ['data:trace-1']},
    });

    expect(result.status).toBe('not_checked');
    expect(result.bindings).toEqual([]);
  });

  test('rejects negative source-absence claims when search coverage is incomplete', () => {
    const sourceReference = reference('metadata');
    const result = verify({
      sourceReference,
      sourceUseDecision: decision(sourceReference, {
        status: 'search_incomplete',
        reasonCode: 'search_incomplete',
        coverageComplete: false,
        incompleteReasons: ['result_limit'],
      }),
      claimText: '源码中不存在 Foo.run 的实现',
      binding: {
        claimId: 'claim-1',
        mechanismStatus: 'compatible',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: [],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.bindings).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_absence_requires_complete_search'}),
    ]));
  });

  test('rejects a negative source claim on incomplete run coverage even after source was located', () => {
    const sourceReference = reference('body');
    const result = verify({
      sourceReference,
      // A later read located source; one earlier search still did not finish.
      sourceUseDecision: decision(sourceReference, {status: 'corroborated', coverageComplete: false,
        incompleteReasons: ['time_budget']}),
      claimText: '源码中不存在 Foo.run 的实现',
      binding: {claimId: 'claim-1', mechanismStatus: 'compatible', sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: []},
    });

    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source_absence_requires_complete_search'}),
    ]));
  });

  test.each([
    [{start: 10, end: 20}, 'corroborated'],
    [{start: 13, end: 20}, 'compatible'],
  ] as const)('upgrades a bound search hit only when a read window covers its whole range (%j)', (window, expected) => {
    const hit = sanitizeSourceReference({referenceId: 'hit-1', codebaseId: 'app-source', filePath: 'src/main/Foo.kt',
      lineRange: {start: 12, end: 14}, sourceGeneration: 'live-1', lookupKind: 'search_hit'})!;
    const read = sanitizeSourceReference({referenceId: 'read-1', codebaseId: 'app-source', filePath: 'src/main/Foo.kt',
      lineRange: window, sourceGeneration: 'live-1', lookupKind: 'body'})!;
    const result = verify({sourceReference: hit,
      sourceUseDecision: decision(hit, {status: 'corroborated', references: [hit, read]})});

    expect(result.bindings[0]?.mechanismStatus).toBe(expected);
  });

  test('never promotes graph-only evidence to corroborated', () => {
    const sourceReference = reference('graph');
    const result = verify({sourceReference});

    expect(result.status).toBe('partial');
    expect(result.bindings[0]?.mechanismStatus).toBe('compatible');
  });
});

describe('projectSafeSourceProvenance', () => {
  test('keeps only canonical returned references and binding identifiers', () => {
    const sourceReference = reference('body');
    const sourceUseDecision = decision(sourceReference);
    const conclusionContract = contract();
    conclusionContract.sourceUseDecision = {
      ...sourceUseDecision,
      references: [{
        ...sourceReference,
        rootPath: '/Users/chris/private-source',
        snippet: 'SECRET_SNIPPET_CANARY',
        query: 'SECRET_QUERY_CANARY',
      } as any],
    };
    conclusionContract.sourceReferences = conclusionContract.sourceUseDecision.references;
    conclusionContract.sourceClaimBindings = [{
      claimId: 'claim-1',
      mechanismStatus: 'compatible',
      sourceReferenceIds: [sourceReference.id],
      traceEvidenceRefIds: ['data:trace-1'],
      reason: 'SECRET_BINDING_REASON_CANARY',
    }];

    const projected = projectSafeSourceProvenance({
      conclusionContract,
      actualSourceUseDecision: conclusionContract.sourceUseDecision,
    });

    expect(projected).toEqual({
      sourceUseDecision: expect.objectContaining({
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        status: 'corroborated',
        references: [sourceReference],
      }),
      sourceClaimBindings: [{
        claimId: 'claim-1',
        mechanismStatus: 'compatible',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['data:trace-1'],
      }],
    });
    expect(JSON.stringify(projected)).not.toContain('/Users/chris');
    expect(JSON.stringify(projected)).not.toContain('SECRET_');
  });

  test('drops body references and corroboration from metadata-only projections', () => {
    const bodyReference = reference('body');
    const metadataDecision = decision(bodyReference, {
      codeAwareMode: 'metadata_only',
      status: 'corroborated',
    });
    const conclusionContract = contract();
    conclusionContract.sourceUseDecision = metadataDecision;
    conclusionContract.sourceReferences = [bodyReference];
    conclusionContract.sourceClaimBindings = [{
      claimId: 'claim-1',
      mechanismStatus: 'corroborated',
      sourceReferenceIds: [bodyReference.id],
      traceEvidenceRefIds: ['data:trace-1'],
    }];

    const projected = projectSafeSourceProvenance({conclusionContract});

    expect(projected?.sourceUseDecision.status).toBe('located');
    expect(projected?.sourceUseDecision.references).toEqual([]);
    expect(projected?.sourceClaimBindings).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain('"mechanismStatus":"corroborated"');
  });

  test('fails closed when an explicit current-run decision is absent or invalid', () => {
    const sourceReference = reference('body');
    const conclusionContract = contract();
    conclusionContract.sourceUseDecision = decision(sourceReference);
    conclusionContract.sourceReferences = [sourceReference];

    expect(projectSafeSourceProvenance({
      conclusionContract,
      actualSourceUseDecision: undefined,
    })).toBeUndefined();
    expect(projectSafeSourceProvenance({
      conclusionContract,
      actualSourceUseDecision: {schemaVersion: 'wrong'},
    })).toBeUndefined();
  });
});

describe('attachSourceUseToAnalysisResult', () => {
  test('attaches the actual accessor decision without changing chat narrative bytes', () => {
    const sourceReference = reference();
    const actualDecision = decision(sourceReference);
    const analysisResult: AnalysisResult = {
      sessionId: 'session-source',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'compact chat narrative',
      conclusionContract: contract(),
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 10,
    };
    analysisResult.conclusionContract!.sourceUseDecision = {
      ...actualDecision,
      selectedCodebaseIds: ['fabricated-source'],
    };

    const attached = attachSourceUseToAnalysisResult(analysisResult, {
      getSourceUseDecision: () => actualDecision,
    });

    expect(attached).toBe(analysisResult);
    expect(attached.conclusion).toBe('compact chat narrative');
    expect(attached.conclusionContract?.sourceUseDecision).toEqual(actualDecision);
    expect(attached.conclusionContract?.sourceReferences).toEqual([sourceReference]);
  });

  test('carries actual sanitized context even before a conclusion contract is derived', () => {
    const sourceReference = reference();
    const actualDecision = decision(sourceReference);
    const analysisResult: AnalysisResult = {
      sessionId: 'session-source',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'plain runtime narrative',
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 10,
    };

    attachSourceUseToAnalysisResult(analysisResult, {
      getSourceUseDecision: () => actualDecision,
    });

    expect(analysisResult.sourceUseDecision).toEqual(actualDecision);
    expect(analysisResult.sourceReferences).toEqual([sourceReference]);
    expect(analysisResult.conclusionContract).toBeUndefined();
  });

  test('strips fabricated provider-send body provenance when no actual accessor exists', () => {
    const sourceReference = reference('body');
    const fabricatedDecision = decision(sourceReference);
    const conclusionContract = contract();
    conclusionContract.sourceUseDecision = fabricatedDecision;
    conclusionContract.sourceReferences = [sourceReference];
    conclusionContract.sourceClaimBindings = [{
      claimId: 'claim-1',
      mechanismStatus: 'corroborated',
      sourceReferenceIds: [sourceReference.id],
      traceEvidenceRefIds: ['data:trace-1'],
    }];
    const analysisResult: AnalysisResult = {
      sessionId: 'session-no-accessor',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'chat stays byte-identical',
      conclusionContract,
      claimSupport: [{
        claimId: 'claim-1',
        kind: 'causal',
        text: 'trace support remains',
        anchors: [],
        supportLevel: 'verified',
      }],
      claimVerificationResult: {
        schemaVersion: 'claim_verifier@1',
        status: 'passed',
        policy: 'record_only',
        passed: true,
        checkedClaimCount: 1,
        unsupportedClaimCount: 0,
        claimResults: [{
          claimId: 'claim-1',
          status: 'verified',
          referenceResults: [{evidenceRefId: 'data:trace-1', status: 'matched'}],
        }],
        issues: [],
      },
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 10,
    };

    attachSourceUseToAnalysisResult(analysisResult, undefined);

    expect(analysisResult.conclusion).toBe('chat stays byte-identical');
    expect(analysisResult.claimSupport).toHaveLength(1);
    expect(analysisResult.claimVerificationResult?.status).toBe('passed');
    expect(analysisResult.sourceUseDecision).toBeUndefined();
    expect(analysisResult.sourceReferences).toBeUndefined();
    expect(analysisResult.sourceClaimVerificationResult).toBeUndefined();
    expect(analysisResult.conclusionContract).not.toHaveProperty('sourceUseDecision');
    expect(analysisResult.conclusionContract).not.toHaveProperty('sourceReferences');
    expect(analysisResult.conclusionContract).not.toHaveProperty('sourceClaimBindings');
  });

  test('clears stale source sidecars when a later run has no accessor', () => {
    const sourceReference = reference();
    const staleDecision = decision(sourceReference);
    const analysisResult: AnalysisResult = {
      sessionId: 'session-stale-source',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'new run conclusion',
      conclusionContract: contract(),
      sourceUseDecision: staleDecision,
      sourceReferences: [sourceReference],
      sourceClaimVerificationResult: {
        schemaVersion: 'source_claim_verifier@1',
        status: 'passed',
        bindings: [],
        issues: [],
      },
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 10,
    };
    analysisResult.conclusionContract!.sourceUseDecision = staleDecision;
    analysisResult.conclusionContract!.sourceReferences = [sourceReference];

    attachSourceUseToAnalysisResult(analysisResult, undefined);

    expect(analysisResult.sourceUseDecision).toBeUndefined();
    expect(analysisResult.sourceReferences).toBeUndefined();
    expect(analysisResult.sourceClaimVerificationResult).toBeUndefined();
    expect(JSON.stringify(analysisResult.conclusionContract)).not.toContain(sourceReference.id);
  });

  test('invalidates investigation assessment and context when source contract changes without changing native completion', () => {
    const sourceReference = reference();
    const staleDecision = decision(sourceReference);
    const assessment: NonNullable<AnalysisResult['investigationAssessment']> = {
      schemaVersion: 1, status: 'checked', binding: {candidateRef: 'candidate', runId: 'run', attemptId: 'attempt',
        conclusionFingerprint: '', conclusionContractFingerprint: '', evidenceFingerprint: '',
        requirementsFingerprint: '', registryFingerprint: '', intentFingerprint: '', ledgerFingerprint: ''},
      requirements: [{requirementId: 'old-scope', domain: 'scheduling', applicability: 'applicable', coverage: 'covered',
        acquisition: 'observed', evidenceStatus: 'observed', scopeMatch: 'matched', contentLocations: [],
        evidenceRecordIds: ['STALE_SOURCE_INVESTIGATION_REF']}], evidenceRecords: [],
    };
    const completion: NonNullable<AnalysisResult['completion']> = {schemaVersion: 1, runtimeKind: 'openai-agents-sdk',
      status: 'completed', candidateRef: 'candidate', runId: 'run', attemptId: 'attempt', conclusionFingerprint: ''};
    const result: AnalysisResult = {sessionId: 'source-investigation-invalidation', success: true, findings: [], hypotheses: [],
      conclusion: 'Original answer remains unchanged.', confidence: 0.8, rounds: 1, totalDurationMs: 10,
      completion, conclusionContract: {...contract(), sourceUseDecision: staleDecision, sourceReferences: [sourceReference]},
      sourceUseDecision: staleDecision, investigationAssessment: assessment};
    const projected = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {
      context: {entry: 'runtime_draft', investigationAssessment: assessment},
    });
    expect(projected.result.investigationAssessment).toBeUndefined();
    expect(projected.deliveryContext?.entry).toBe('runtime_draft');
    expect(projected.deliveryContext && projected.deliveryContext.entry !== 'historical_restore'
      ? projected.deliveryContext.investigationAssessment : undefined).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('STALE_SOURCE_INVESTIGATION_REF');
    expect(projected.result.conclusion).toBe('Original answer remains unchanged.');
    expect(projected.result.completion).toBe(completion);
  });

  test('invalidates investigation after identity-only projection with body, source and claims unchanged', () => {
    const sessionId = 'identity-only-investigation-projection';
    const secret = 'PRIVATE_IDENTITY_ONLY_VALUE';
    const conclusion = 'The original task observation remains unchanged.';
    const candidate = {candidateRef: 'candidate', runId: 'run', attemptId: 'attempt',
      conclusionFingerprint: analysisDeliveryFingerprint(conclusion)};
    const completion: NonNullable<AnalysisResult['completion']> = {...candidate, schemaVersion: 1,
      runtimeKind: 'openai-agents-sdk', status: 'completed'};
    const assessment: NonNullable<AnalysisResult['investigationAssessment']> = {
      schemaVersion: 1, status: 'checked', binding: {...candidate, conclusionContractFingerprint: '', evidenceFingerprint: '',
        requirementsFingerprint: '', registryFingerprint: '', intentFingerprint: '', ledgerFingerprint: ''},
      requirements: [], evidenceRecords: [],
    };
    const result: AnalysisResult = {sessionId, success: true, findings: [], hypotheses: [], conclusion,
      confidence: 0.8, rounds: 1, totalDurationMs: 10, completion, investigationAssessment: assessment,
      identityResolutions: [{version: 'identity_contract@1', identityRefId: secret, target: {traceId: 'trace', source: 'selection'},
        status: 'verified', processes: [], threads: [], warnings: []}]};
    const originalIdentity = structuredClone(result.identityResolutions);
    registerCodeAwareCanary(sessionId, secret);
    try {
      const projected = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {
        context: {entry: 'runtime_draft', acceptedCandidate: candidate, completion, investigationAssessment: assessment},
      });
      expect(projected.result.identityResolutions).not.toEqual(originalIdentity);
      expect(JSON.stringify(projected.result.identityResolutions)).not.toContain(secret);
      expect(projected.result.conclusion).toBe(conclusion);
      expect(projected.conclusionProjection.disposition).toBe('preserved');
      expect(projected.result.conclusionContract).toBeUndefined();
      expect(projected.result.claimSupport).toBeUndefined();
      expect(projected.result.claimVerificationResult).toBeUndefined();
      expect(projected.result.sourceUseDecision).toBeUndefined();
      expect(projected.result.sourceReferences).toBeUndefined();
      expect(projected.result.sourceClaimVerificationResult).toBeUndefined();
      expect(projected.result.investigationAssessment).toBeUndefined();
      expect(projected.deliveryContext && projected.deliveryContext.entry !== 'historical_restore'
        ? projected.deliveryContext.investigationAssessment : undefined).toBeUndefined();
      expect(projected.result.completion).toBe(completion);
      expect(projected.deliveryContext && projected.deliveryContext.entry !== 'historical_restore'
        ? projected.deliveryContext.completion : undefined).toBe(completion);
    } finally {clearCodeAwareOutputGuards(sessionId);}
  });
});
