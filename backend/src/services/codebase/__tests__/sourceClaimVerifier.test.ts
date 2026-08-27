// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import {
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  sanitizeSourceReference,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../sourceUseDecision';
import {
  attachSourceUseToAnalysisResult,
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
  traceIds?: Record<string, string[]>;
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
  return verifySourceClaimBindings({
    conclusionContract,
    verifiedTraceEvidenceRefIdsByClaimId: input.traceIds ?? {
      'claim-1': ['data:trace-1'],
      'claim-2': ['data:trace-2'],
    },
  });
}

describe('verifySourceClaimBindings', () => {
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
      traceIds: {'claim-1': [], 'claim-2': ['data:trace-2']},
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

  test('never promotes graph-only evidence to corroborated', () => {
    const sourceReference = reference('graph');
    const result = verify({sourceReference});

    expect(result.status).toBe('partial');
    expect(result.bindings[0]?.mechanismStatus).toBe('compatible');
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
});
