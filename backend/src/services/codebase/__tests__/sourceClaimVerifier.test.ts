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
  type SourceClaimBindingV1,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../sourceUseDecision';
import {
  attachSourceUseToAnalysisResult,
  finalizeSourceAwareAnalysisResultWithProjection,
  projectSafeSourceProvenance,
  verifySourceClaimBindings,
} from '../sourceClaimVerifier';
import {extractSourceCitations, matchSourceCitation} from '../sourceCitations';

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
  claim?: Partial<NonNullable<ConclusionContract['claims']>[number]>;
  binding?: Record<string, unknown> | null;
  matchedTraceIds?: Record<string, string[]>;
  body?: string;
}) {
  const sourceReference = input.sourceReference ?? reference();
  const sourceUseDecision = input.sourceUseDecision ?? decision(sourceReference);
  const conclusionContract = contract();
  conclusionContract.claims![0] = {...conclusionContract.claims![0]!, ...input.claim};
  conclusionContract.sourceUseDecision = sourceUseDecision;
  conclusionContract.sourceReferences = [sourceReference];
  conclusionContract.sourceClaimBindings = input.binding === null ? [] : [input.binding as any ?? {
    claimId: 'claim-1',
    sourceReferenceIds: [sourceReference.id],
    traceEvidenceRefIds: ['data:trace-1'],
  }];
  return verifySourceClaimBindings({
    conclusionContract,
    actualSourceUseDecision: sourceUseDecision,
    matchedTraceEvidenceRefIdsByClaimId: input.matchedTraceIds ?? {'claim-1': ['data:trace-1'], 'claim-2': ['data:trace-2']},
    body: input.body ?? 'Foo.run blocks the main thread at src/main/Foo.kt:L12-L18.',
  });
}

const statusOf = (result: ReturnType<typeof verify>, claimId = 'claim-1') =>
  result.claims.find(claim => claim.claimId === claimId)?.status;

describe('verifySourceClaimBindings', () => {
  // R2'' acceptance: source-dependent claims are identified by structure and judged per claim.
  test('a codebase-population causal claim without a binding is unbound and never passes', () => {
    const result = verify({binding: null, claim: {semantics: {schemaVersion: 'claim_semantics@1', predicate: 'anything.at.all',
      polarity: 'affirmed', discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'codebase'}}}});
    expect(statusOf(result)).toBe('unbound');
    expect(result.status).toBe('partial');
    expect(result.issues).toContainEqual(expect.objectContaining({claimId: 'claim-1', severity: 'warning',
      code: 'source_claim_unbound'}));
  });

  test('a trace-population claim whose text writes a source location is source-dependent', () => {
    const result = verify({binding: null, claim: {text: 'The wait starts in StartupHooks.kt:28.'}});
    expect(statusOf(result)).toBe('unbound');
    expect(result.status).not.toBe('passed');
  });

  test('a bound reference this run never issued is invalid and fails', () => {
    const result = verify({binding: {claimId: 'claim-1', sourceReferenceIds: ['source-ref-v1-fabricated'],
      traceEvidenceRefIds: []}});
    expect(statusOf(result)).toBe('invalid');
    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({severity: 'error', code: 'source_reference_not_returned'}));
  });

  test('a claim bound only to search hits is location_only', () => {
    const result = verify({sourceReference: reference('search_hit')});
    expect(statusOf(result)).toBe('location_only');
    expect(result.status).toBe('partial');
  });

  test('a body reference without verified same-claim Trace evidence is source_only', () => {
    const result = verify({binding: {claimId: 'claim-1', sourceReferenceIds: [reference().id], traceEvidenceRefIds: []}});
    expect(statusOf(result)).toBe('source_only');
    expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_claim_trace_unlinked'}));
  });

  test('a body reference with matched same-claim Trace evidence and a visible citation is trace_linked', () => {
    const result = verify({});
    expect(statusOf(result)).toBe('trace_linked');
    expect(result.status).toBe('passed');
    expect(result.citations).toEqual([expect.objectContaining({filePath: 'src/main/Foo.kt', status: 'verified_body',
      sourceReferenceId: reference().id})]);
    expect(JSON.stringify(result)).not.toMatch(/proven|因果成立|已证明/);
  });

  test('a knowledge reference is neither a source reference nor Trace evidence', () => {
    const knowledgeReference = 'kref-00000000-0000-0000-0000-000000000000';
    const asSource = verify({binding: {claimId: 'claim-1', sourceReferenceIds: [knowledgeReference],
      traceEvidenceRefIds: ['data:trace-1']}});
    expect(statusOf(asSource)).toBe('invalid');
    expect(asSource.status).toBe('failed');
    expect(asSource.issues).toContainEqual(expect.objectContaining({severity: 'error', code: 'source_reference_not_returned'}));
    const asTrace = verify({binding: {claimId: 'claim-1', sourceReferenceIds: [reference().id],
      traceEvidenceRefIds: [knowledgeReference]}});
    expect(statusOf(asTrace)).toBe('invalid');
    expect(asTrace.status).toBe('failed');
    expect(asTrace.issues).toContainEqual(expect.objectContaining({code: 'source_binding_trace_support_missing'}));
  });

  test('Trace evidence of another claim is invalid', () => {
    const result = verify({binding: {claimId: 'claim-1', sourceReferenceIds: [reference().id],
      traceEvidenceRefIds: ['data:trace-2']}});
    expect(statusOf(result)).toBe('invalid');
    expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_binding_trace_cross_claim'}));
  });

  test('a claim whose source the answer never cites cannot reach trace_linked', () => {
    const result = verify({body: 'Foo.run blocks the main thread.'});
    expect(statusOf(result)).toBe('source_only');
    expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_claim_not_visible'}));
  });

  test('an unmatched location in the claim\'s visible answer block demotes it to unbound', () => {
    const result = verify({body: 'Foo.run blocks at src/main/Foo.kt:L12-L18, called from src/main/Missing.kt:L80.'});
    expect(statusOf(result)).toBe('unbound');
    expect(result.citations.map(citation => citation.status)).toEqual(['verified_body', 'unmatched']);
  });

  test('retired declaration fields are ignored, never judged', () => {
    const result = verify({binding: {claimId: 'claim-1', mechanismStatus: 'corroborated', reason: 'ignored',
      sourceReferenceIds: [reference().id], traceEvidenceRefIds: ['data:trace-1']}});
    expect(statusOf(result)).toBe('trace_linked');
    expect(result.bindings).toEqual([{claimId: 'claim-1', sourceReferenceIds: [reference().id],
      traceEvidenceRefIds: ['data:trace-1']}]);
  });

  test('declared source with no current execution ledger stays unchecked', () => {
    const declaration = contract();
    declaration.sourceClaimBindings = [{claimId: 'claim-1', sourceReferenceIds: ['source-ref-v1-x'], traceEvidenceRefIds: []}];
    expect(verifySourceClaimBindings({conclusionContract: declaration})).toMatchObject({status: 'partial',
      issues: [expect.objectContaining({code: 'source_claim_semantics_unchecked'})]});
  });

  describe('citations tie to a claim only through its own file version and lines', () => {
    const live = (overrides: Partial<SourceReferenceV1>) => sanitizeSourceReference({id: 'x', referenceId: 'lookup-x',
      codebaseId: 'app-source', filePath: 'src/main/Foo.kt', lineRange: {start: 10, end: 20}, lookupKind: 'body',
      sourceGeneration: 'live-1', ...overrides})!;
    const run = (references: SourceReferenceV1[], boundIds: string[], body: string) => {
      const declaration = contract();
      const sourceUseDecision = {...decision(references[0]!), references};
      declaration.sourceUseDecision = sourceUseDecision;
      declaration.sourceReferences = references;
      declaration.sourceClaimBindings = [{claimId: 'claim-1', sourceReferenceIds: boundIds, traceEvidenceRefIds: ['data:trace-1']}];
      return verifySourceClaimBindings({conclusionContract: declaration, actualSourceUseDecision: sourceUseDecision,
        matchedTraceEvidenceRefIdsByClaimId: {'claim-1': ['data:trace-1']}, body});
    };

    test('a wide read window does not make a citation of other lines visible for the claim', () => {
      const hit = live({referenceId: 'lookup-h', lookupKind: 'search_hit', lineRange: {start: 10, end: 20}});
      const window = live({referenceId: 'lookup-w', lineRange: {start: 1, end: 100}});
      const result = run([hit, window], [hit.id], 'Foo.run blocks the main thread, see src/main/Foo.kt:L80.');
      expect(statusOf(result)).toBe('source_only');
      expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_claim_not_visible'}));
      expect(statusOf(run([hit, window], [hit.id], 'Foo.run blocks the main thread at src/main/Foo.kt:L12.')))
        .toBe('trace_linked');
    });

    test('a binding pins an ambiguous citation for its claim only, and the answer keeps the ambiguity', () => {
      const a = live({referenceId: 'lookup-a'});
      const b = live({referenceId: 'lookup-b', sourceGeneration: 'live-2'});
      const result = run([a, b], [a.id], 'Foo.run blocks the main thread at src/main/Foo.kt:L12.');
      expect(result.citations[0]).toMatchObject({status: 'ambiguous'});
      expect(statusOf(result)).toBe('trace_linked');
      expect(result.status).toBe('partial');
      expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_citation_ambiguous'}));
    });

    test('a claim bound to two candidate versions does not pick one', () => {
      const a = live({referenceId: 'lookup-a'});
      const b = live({referenceId: 'lookup-b', sourceGeneration: 'live-2'});
      expect(statusOf(run([a, b], [a.id, b.id], 'Foo.run blocks the main thread at src/main/Foo.kt:L12.'))).toBe('unbound');
      expect(statusOf(run([a, b], [b.id, a.id], 'Foo.run blocks the main thread at src/main/Foo.kt:L12.'))).toBe('unbound');
    });

    test('a binding past the stored candidate list still counts against a unique pin', () => {
      const versions = Array.from({length: 18}, (_, index) =>
        live({referenceId: `lookup-${index}`, sourceGeneration: `live-${index}`}));
      const body = 'Foo.run blocks the main thread at src/main/Foo.kt:L12.';
      for (const bound of [[versions[0]!.id, versions[17]!.id], [versions[17]!.id, versions[0]!.id]]) {
        expect(statusOf(run(versions, bound, body))).toBe('unbound');
      }
      const result = run(versions, [versions[17]!.id], body);
      expect(statusOf(result)).toBe('trace_linked');
      expect(result.citations[0]!.candidateReferenceIds).toHaveLength(16);
    });

    test('a claim text past the extraction limit is reported and keeps the answer partial', () => {
      const a = live({});
      const declaration = contract();
      const sourceUseDecision = {...decision(a), references: [a]};
      declaration.claims![0] = {...declaration.claims![0]!,
        text: Array.from({length: 201}, (_, index) => `src/main/Foo.kt:L${(index % 11) + 10}`).join(' ')};
      declaration.sourceUseDecision = sourceUseDecision;
      declaration.sourceClaimBindings = [{claimId: 'claim-1', sourceReferenceIds: [a.id], traceEvidenceRefIds: ['data:trace-1']}];
      const result = verifySourceClaimBindings({conclusionContract: declaration, actualSourceUseDecision: sourceUseDecision,
        matchedTraceEvidenceRefIdsByClaimId: {'claim-1': ['data:trace-1']}, body: 'Foo.run blocks at src/main/Foo.kt:L12.'});
      expect(statusOf(result)).toBe('source_only');
      expect(result.status).toBe('partial');
      expect(result.issues).toContainEqual(expect.objectContaining({claimId: 'claim-1',
        code: 'source_citation_extraction_truncated'}));
    });

    test('locations past the extraction limit keep every claim short of trace_linked', () => {
      const a = live({});
      const extra = Array.from({length: 200}, (_, index) => `Other.kt:${index + 1}`).join(' ');
      const result = run([a], [a.id], `Foo.run blocks at src/main/Foo.kt:L12.\n\n${extra}`);
      expect(statusOf(result)).toBe('source_only');
      expect(result.issues).toContainEqual(expect.objectContaining({code: 'source_citation_extraction_truncated'}));
    });
  });

  test('a run with no source-dependent claim and no cited location has nothing to check', () => {
    const declaration = contract();
    declaration.sourceClaimBindings = [];
    expect(verifySourceClaimBindings({conclusionContract: declaration, actualSourceUseDecision: decision(reference()),
      body: 'Plain trace answer.'}).status).toBe('not_checked');
  });
});

describe('matchSourceCitation', () => {
  const ref = (overrides: Partial<SourceReferenceV1>) => sanitizeSourceReference({id: 'source-ref-v1-a', codebaseId: 'app-a',
    filePath: 'app/src/Foo.kt', lineRange: {start: 10, end: 30}, lookupKind: 'body', sourceGeneration: 'live-1', ...overrides})!;
  const cite = (text: string) => extractSourceCitations(text).citations[0]!;

  test('a full path inside a read window is verified_body; a search hit only locates', () => {
    expect(matchSourceCitation(cite('app/src/Foo.kt:L12-L14'), [ref({})]).status).toBe('verified_body');
    expect(matchSourceCitation(cite('app/src/Foo.kt:L12'), [ref({lookupKind: 'search_hit'})]).status).toBe('located');
    expect(matchSourceCitation(cite('app/src/Foo.kt:L90'), [ref({})]).status).toBe('unmatched');
  });

  test('a short path that fits files in two codebases or two content versions is ambiguous', () => {
    expect(matchSourceCitation(cite('Foo.kt:L12'), [ref({}), ref({id: 'source-ref-v1-b', codebaseId: 'app-b'})]).status)
      .toBe('ambiguous');
    expect(matchSourceCitation(cite('Foo.kt:L12'), [ref({}), ref({id: 'source-ref-v1-c', sourceGeneration: 'live-2'})]).status)
      .toBe('ambiguous');
    // The issued id is the canonical reference identity.
    expect(matchSourceCitation(cite('src/Foo.kt:L12'), [ref({})])).toMatchObject({status: 'verified_body',
      sourceReferenceId: ref({}).id});
  });

  test('extraction reads Unicode paths, and spaced paths when quoted', () => {
    expect(extractSourceCitations('see `src/功能目录/My Feature/Foo.kt:L10-L12` and src/功能/Bar.kt:5').citations.map(item =>
      [item.citation, item.filePath])).toEqual([
      ['src/功能目录/My Feature/Foo.kt:L10-L12', 'src/功能目录/My Feature/Foo.kt'], ['src/功能/Bar.kt:5', 'src/功能/Bar.kt']]);
  });

  test('extraction reads source extensions with line numbers and ignores other text', () => {
    expect(extractSourceCitations('see app/src/Foo.kt:L10-L20, Bar.java:7 and v1.2:3 or Foo.kt').citations.map(item => item.citation))
      .toEqual(['app/src/Foo.kt:L10-L20', 'Bar.java:7']);
  });

  test('every written line must be returned by one file version; overlap or a file-only reference is not enough', () => {
    expect(matchSourceCitation(cite('app/src/Foo.kt:L20-L80'), [ref({})]).status).toBe('unmatched');
    expect(matchSourceCitation(cite('app/src/Foo.kt:L12'), [ref({lineRange: undefined})]).status).toBe('unmatched');
    // Adjacent windows of one version cover together; two versions never do.
    const next = ref({id: 'source-ref-v1-n', lineRange: {start: 31, end: 50}});
    expect(matchSourceCitation(cite('app/src/Foo.kt:L20-L40'), [ref({}), next]).status).toBe('verified_body');
    expect(matchSourceCitation(cite('app/src/Foo.kt:L20-L40'),
      [ref({}), ref({id: 'source-ref-v1-n', lineRange: {start: 31, end: 50}, sourceGeneration: 'live-2'})]).status)
      .toBe('unmatched');
    // Covered by a read window and a search hit together: located, not read.
    expect(matchSourceCitation(cite('app/src/Foo.kt:L20-L40'), [ref({}),
      ref({id: 'source-ref-v1-n', lineRange: {start: 31, end: 50}, lookupKind: 'search_hit'})]).status).toBe('located');
  });

  test('references with no known generation never cover lines together', () => {
    const a = ref({id: 'source-ref-v1-a', sourceGeneration: undefined, lineRange: {start: 10, end: 20}});
    const b = ref({id: 'source-ref-v1-b', referenceId: 'lookup-b', sourceGeneration: undefined, lineRange: {start: 21, end: 30}});
    expect(matchSourceCitation(cite('app/src/Foo.kt:L10-L30'), [a, b]).status).toBe('unmatched');
    expect(matchSourceCitation(cite('app/src/Foo.kt:L12-L18'), [a, b]).status).toBe('verified_body');
  });

  test('a range is read whole: an end that does not parse never shrinks to its first line', () => {
    const single = ref({lineRange: {start: 20, end: 20}});
    for (const written of ['app/src/Foo.kt:L20-L99999999999', '`app/src/Foo.kt:L20-L99999999999`', 'app/src/Foo.kt:L30-L20']) {
      const extracted = extractSourceCitations(written).citations;
      expect(extracted.every(item => matchSourceCitation(item, [single]).status !== 'verified_body')).toBe(true);
    }
    expect(extractSourceCitations('app/src/Foo.kt:L20-L30x').citations).toEqual([]);
    // Every common separator is a range, never its first line alone; a dash ending a sentence is not.
    for (const separator of ['-', '–', '—', '~', '～', ' - ']) {
      expect(extractSourceCitations(`app/src/Foo.kt:L12${separator}L20`).citations[0]?.lineRange).toEqual({start: 12, end: 20});
    }
    expect(extractSourceCitations('见 app/src/Foo.kt:12-。').citations[0]?.lineRange).toEqual({start: 12, end: 12});
    expect(extractSourceCitations('（app/src/Foo.kt:L12）').citations[0]?.lineRange).toEqual({start: 12, end: 12});
    expect(matchSourceCitation(cite('app/src/Foo.kt:L20'), [single]).status).toBe('verified_body');
  });

  test('extraction says when it stopped before the last written location', () => {
    const many = Array.from({length: 201}, (_, index) => `Foo.kt:${index + 1}`).join(' ');
    expect(extractSourceCitations(many)).toMatchObject({truncated: true});
    expect(extractSourceCitations(many).citations).toHaveLength(200);
    expect(extractSourceCitations('Foo.kt:1').truncated).toBe(false);
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
    } as SourceClaimBindingV1];

    const unverified = projectSafeSourceProvenance({
      conclusionContract,
      actualSourceUseDecision: conclusionContract.sourceUseDecision,
    });
    // A declaration no verifier saw is a candidate, never an accepted binding.
    expect(unverified?.sourceClaimBindings).toEqual([]);

    const verification = verifySourceClaimBindings({conclusionContract, actualSourceUseDecision: sourceUseDecision,
      matchedTraceEvidenceRefIdsByClaimId: {'claim-1': ['data:trace-1']}, body: 'Foo.run blocks at src/main/Foo.kt:L12.'});
    const projected = projectSafeSourceProvenance({
      conclusionContract,
      actualSourceUseDecision: conclusionContract.sourceUseDecision,
      sourceClaimVerificationResult: verification,
    });

    expect(projected).toEqual({
      sourceUseDecision: expect.objectContaining({
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        status: 'corroborated',
        references: [sourceReference],
      }),
      sourceClaimBindings: [{
        claimId: 'claim-1',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['data:trace-1'],
      }],
      sourceClaimStatuses: [expect.objectContaining({claimId: 'claim-1', status: 'trace_linked'})],
      sourceCitations: [expect.objectContaining({status: 'verified_body'})],
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
