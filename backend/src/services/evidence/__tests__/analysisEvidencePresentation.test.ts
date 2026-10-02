// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../../agent/core/orchestratorTypes';
import type {SafeSourceProvenanceProjection} from '../../codebase/sourceClaimVerifier';
import {
  parseClosedAnalysisEvidencePresentation,
  projectAnalysisEvidenceForDisplay,
} from '../analysisEvidencePresentation';
import {projectOwnerAnalysisResult} from '../../security/privateAnalysisProjection';

const CANARY = 'PRIVATE_CREDENTIAL_CANARY';

describe('analysis evidence presentation', () => {
  test('projects every formal evidence family without changing status or null/zero/false values', () => {
    const {result, sourceProvenance} = fixture();
    addUnknown(result.conclusionContract!.claims![0], 'rawSemantics', {apiKey: CANARY});
    addUnknown(result.claimSupport![0], 'credentialToken', CANARY);
    addUnknown(result.claimSupport![0].anchors[0], 'privateBody', CANARY);
    addUnknown(result.claimVerificationResult!, 'unknownVerifier', CANARY);
    addUnknown(result.claimVerificationResult!.claimResults[0].deterministicProof!.nativeRows![0], 'secret', CANARY);
    addUnknown(result.identityResolutions![0], 'unknownIdentity', CANARY);
    addUnknown(result.investigationAssessment!, 'unknownInvestigation', CANARY);
    addUnknown(result.deliveryAssurance!, 'unknownDelivery', CANARY);
    addUnknown(sourceProvenance.sourceUseDecision, 'unknownSource', CANARY);
    const before = structuredClone({result, sourceProvenance});

    const projected = projectAnalysisEvidenceForDisplay({result, sourceProvenance});

    expect(projected).toBeDefined();
    expect(JSON.stringify(projected)).not.toContain(CANARY);
    expect(projected?.claimVerificationResult).toMatchObject({status: 'failed', passed: false});
    expect(projected?.claims[0].references[0]).toMatchObject({rowIndex: 0, value: null});
    expect(projected?.claimSupport[0].anchors[0].cells?.[0]).toMatchObject({
      rowIndex: 0, actualValue: null, isSqlNull: false,
    });
    expect(projected?.claimVerificationResult?.claimResults[0].deterministicProof?.nativeRows?.[0])
      .toMatchObject({id: 0, anchorId: 'anchor-1'});
    expect(projected?.investigationAssessment?.evidenceRecords?.[0]).toMatchObject({
      rowIndex: 0, cpu: null, value: null,
    });
    expect({result, sourceProvenance}).toEqual(before);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  test('keeps not-checked triage detail through the writer and the strict reader', () => {
    const input = fixture();
    Object.assign(input.result.claimVerificationResult!, {
      notCheckedReason: 'invalid_declarations', notCheckedDetail: 'invalid_relation_proposal:invalid_kind',
    });
    const projected = projectAnalysisEvidenceForDisplay(input);
    expect(projected?.claimVerificationResult).toMatchObject({notCheckedDetail: 'invalid_relation_proposal:invalid_kind'});
    expect(parseClosedAnalysisEvidencePresentation(JSON.parse(JSON.stringify(projected)))?.claimVerificationResult)
      .toMatchObject({notCheckedReason: 'invalid_declarations', notCheckedDetail: 'invalid_relation_proposal:invalid_kind'});
  });

  test('strict reader rejects unknown fields in every major nested family', () => {
    const valid = projectAnalysisEvidenceForDisplay(fixture());
    expect(valid).toBeDefined();
    const mutate = (change: (value: Record<string, any>) => void) => {
      const value = jsonClone(valid) as Record<string, any>;
      change(value);
      expect(parseClosedAnalysisEvidencePresentation(value)).toBeUndefined();
    };

    mutate(value => { value.claims[0].unknown = CANARY; });
    mutate(value => { value.claimSupport[0].anchors[0].context.unknown = CANARY; });
    mutate(value => { value.claimSupport[0].relations = [{
      schemaVersion: 'evidence_relation@1', id: 'relation-1', kind: 'derived', direction: 'subject_to_object',
      verificationStatus: 'rejected', reasonCode: 'invented_reason', subjectAnchorId: 'anchor-1',
      directEvidenceAnchorIds: ['anchor-1'], supportLevel: 'unsupported',
    }]; });
    mutate(value => { value.claimVerificationResult.claimResults[0].deterministicProof.nativeRows[0].unknown = CANARY; });
    mutate(value => { value.identityResolutions[0].processes[0].unknown = CANARY; });
    mutate(value => { value.investigationAssessment.evidenceRecords[0].unknown = CANARY; });
    mutate(value => { value.deliveryAssurance.unknown = CANARY; });
    mutate(value => { value.sourceUseDecision.references[0].unknown = CANARY; });
    mutate(value => { value.sourceClaimBindings[0].reason = CANARY; });
  });

  test('rejects non-JSON structures while preserving valid dynamic JSON maps', () => {
    const valid = projectAnalysisEvidenceForDisplay(fixture());
    expect(valid).toBeDefined();
    const dynamic = jsonClone(valid) as Record<string, any>;
    dynamic.claims[0].artifactRefs = [{artifactId: 'artifact-1', rowIndex: 0,
      rowSelector: {'display name': {nested: [null, false, 0, 'ok']}}}];
    expect(parseClosedAnalysisEvidencePresentation(dynamic)?.claims[0].artifactRefs?.[0].rowSelector)
      .toEqual({'display name': {nested: [null, false, 0, 'ok']}});

    const cases: Array<(value: Record<string, any>) => void> = [
      value => { value.claims[0].text = undefined; },
      value => { value.claimSupport[0].anchors[0].confidence = Number.NaN; },
      value => { value.claims[0].references = new Array(1); },
      value => { Object.defineProperty(value.claims[0], 'hidden', {value: CANARY, enumerable: false}); },
      value => { Object.defineProperty(value.claims[0], 'text', {get: () => CANARY, enumerable: true}); },
      value => { value.claims[0][Symbol('secret')] = CANARY; },
      value => { value.claims[0].references[0].rowSelector = {key: undefined}; },
      value => { value.claims[0].artifactRefs = [{artifactId: 'artifact', rowSelector: {outer: {key: undefined}}}]; },
      value => { value.claims[0].artifactRefs = [{artifactId: 'artifact', rowSelector: {outer: [{key: undefined}]}}]; },
      value => { value.claims[0].self = value.claims[0]; },
      // JSON.parse keeps __proto__ as an own key, which zod (strictObject included) drops silently.
      value => { value.claims[0] = {...value.claims[0], ...JSON.parse('{"__proto__":"unknown"}')}; },
      value => { value.claims[0].artifactRefs = [{artifactId: 'artifact', rowSelector: JSON.parse('{"__proto__":{"k":1}}')}]; },
      value => { value.claims[0].artifactRefs = [{artifactId: 'artifact', rowSelector: {outer: [JSON.parse('{"__proto__":1}')]}}]; },
    ];
    for (const change of cases) {
      const value = jsonClone(valid) as Record<string, any>;
      change(value);
      expect(parseClosedAnalysisEvidencePresentation(value)).toBeUndefined();
    }
  });

  test('writer omits optional undefined fields but rejects invalid dynamic values without blocking callers', () => {
    const {result, sourceProvenance} = fixture();
    result.claimSupport![0].inferenceReason = undefined;
    expect(projectAnalysisEvidenceForDisplay({result, sourceProvenance})?.claimSupport[0])
      .not.toHaveProperty('inferenceReason');

    result.conclusionContract!.claims![0].references[0].rowSelector = {bad: undefined as never};
    expect(projectAnalysisEvidenceForDisplay({result, sourceProvenance})).toBeUndefined();

    const nestedObject = fixture();
    nestedObject.result.conclusionContract!.claims![0].artifactRefs = [{
      artifactId: 'artifact', rowSelector: {outer: {bad: undefined}},
    }];
    expect(projectAnalysisEvidenceForDisplay(nestedObject)).toBeUndefined();

    const nestedArray = fixture();
    nestedArray.result.conclusionContract!.claims![0].artifactRefs = [{
      artifactId: 'artifact', rowSelector: {outer: [{bad: undefined}]},
    }];
    expect(projectAnalysisEvidenceForDisplay(nestedArray)).toBeUndefined();

    // zod drops an own __proto__ key, so the projection would no longer match the claim it shows.
    const protoSelector = fixture();
    protoSelector.result.conclusionContract!.claims![0].references[0].rowSelector =
      JSON.parse('{"__proto__":"main","pid":1}');
    expect(projectAnalysisEvidenceForDisplay(protoSelector)).toBeUndefined();

    const nestedProto = fixture();
    nestedProto.result.conclusionContract!.claims![0].artifactRefs = [{
      artifactId: 'artifact', rowSelector: {outer: [JSON.parse('{"__proto__":{"k":1}}')]},
    }];
    expect(projectAnalysisEvidenceForDisplay(nestedProto)).toBeUndefined();
  });

  test('accepts a full owner-projected result with scope provenance and retained investigation rows', () => {
    const {result, sourceProvenance} = fixture();
    result.claimSupport![0].anchors[0].scopeProvenance = {
      version: 'process_scope_evidence@1',
      entries: [{
        role: 'target',
        scope: {mode: 'exact_upid', traceId: 'trace-1', traceSide: 'current', upid: 1},
        fields: ['value'], availability: 'available',
      }],
    };
    const firstRecord = result.investigationAssessment!.evidenceRecords![0];
    result.investigationAssessment = {...result.investigationAssessment!, evidenceRecords: Array.from({length: 12}, (_, index) => ({
      ...firstRecord,
      recordId: `record-${index + 1}`,
      rowIndex: index,
      value: index === 0 ? null : index,
    }))};
    const ownerResult = projectOwnerAnalysisResult('session-1', result, 'en');

    const projected = projectAnalysisEvidenceForDisplay({result: ownerResult, sourceProvenance});

    expect(projected).toBeDefined();
    expect(projected?.claimSupport[0].anchors[0].scopeProvenance?.entries[0]).toMatchObject({
      role: 'target', scope: {upid: 1}, availability: 'available',
    });
    expect(projected?.investigationAssessment?.evidenceRecords).toHaveLength(12);
    expect(projected?.investigationAssessment?.evidenceRecords?.[0].value).toBeNull();
    expect(projected?.investigationAssessment?.evidenceRecords?.[11].value).toBe(11);
  });
});

function fixture(): {result: AnalysisResult; sourceProvenance: SafeSourceProvenanceProjection} {
  const candidate = {candidateRef: 'candidate-1', runId: 'run-1', attemptId: 'attempt-1', conclusionFingerprint: 'a'.repeat(64)};
  const binding = {...candidate, conclusionContractFingerprint: 'b'.repeat(64), evidenceFingerprint: 'c'.repeat(64),
    requirementsFingerprint: 'd'.repeat(64), registryFingerprint: 'registry', intentFingerprint: 'e'.repeat(64)};
  const sourceReference = {id: 'source-1', codebaseId: 'app', filePath: 'src/Main.kt', lookupKind: 'body' as const};
  const result: AnalysisResult = {
    sessionId: 'session-1', success: false, findings: [], hypotheses: [], conclusion: 'conclusion',
    confidence: 0.5, rounds: 1, totalDurationMs: 10,
    conclusionContract: {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'claim-1', text: 'claim', kind: 'numeric',
        references: [{evidenceRefId: 'evidence-1', rowIndex: 0, column: 'value', value: null}],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric_cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows'}, numeric: {operator: 'eq', value: 0, unit: 'ms'}}}],
      bindingEligibility: 'eligible', uncertainties: [], nextSteps: [],
    },
    claimSupport: [{
      claimId: 'claim-1', kind: 'numeric', text: 'claim', bindingEligibility: 'eligible', supportLevel: 'unsupported',
      anchors: [{
        anchorId: 'anchor-1', version: 'evidence_contract@1', evidenceRefId: 'evidence-1',
        context: {traceId: 'trace-1', captureId: 'capture-1', producerKind: 'execute_sql'},
        cells: [{column: 'value', rowIndex: 0, value: 0, actualValue: null, isSqlNull: false}],
        confidence: 0,
      }],
    }],
    claimVerificationResult: {
      schemaVersion: 'claim_verifier@2', status: 'failed', policy: 'record_only', passed: false,
      checkedClaimCount: 1, unsupportedClaimCount: 1,
      claimResults: [{claimId: 'claim-1', status: 'unsupported',
        referenceCells: [{evidenceRefId: 'evidence-1', anchorId: 'anchor-1', status: 'matched'}],
        deterministicProof: {kind: 'numeric_cell', status: 'rejected', reason: 'mismatch',
          anchorIds: ['anchor-1'], evidenceRefIds: ['evidence-1'], nativeRows: [{
            anchorId: 'anchor-1', evidenceRefId: 'evidence-1', captureId: 'capture-1', traceId: 'trace-1',
            traceSide: 'current', relation: 'slice', idColumn: 'id', id: 0, schemaFingerprint: 'f'.repeat(64),
          }]}, propositionCoverage: {status: 'none', covered: [], uncovered: ['numeric'], reason: 'mismatch'}}],
      issues: [{claimId: 'claim-1', severity: 'error', code: 'value_mismatch', message: 'mismatch'}],
    },
    identityResolutions: [{
      version: 'identity_contract@1', identityRefId: 'identity-1',
      target: {traceId: 'trace-1', upid: 0, source: 'selection'}, status: 'verified',
      processes: [{upid: 0, pid: 0, matchSources: [], confidence: 0}], threads: [], warnings: [],
      recommendedParams: {'target upid': 0, enabled: false},
    }],
    investigationAssessment: {
      schemaVersion: 1, binding: {...binding, ledgerFingerprint: '1'.repeat(64), evidenceRecordsFingerprint: '2'.repeat(64)},
      status: 'coverage_incomplete', requirements: [{
        requirementId: 'cpu', domain: 'cpu', applicability: 'applicable', coverage: 'missing',
        contentLocations: [{start: 0, end: 1}], evidenceRecordIds: ['record-1'], scopeMatch: 'matched',
        evidenceStatus: 'insufficient', acquisition: 'insufficient',
      }],
      evidenceRecords: [{
        recordId: 'record-1', captureId: 'capture-1', rowIndex: 0, skillId: 'skill', stepId: 'step',
        definitionFingerprint: '3'.repeat(64), selectedSqlHash: '4'.repeat(64), traceId: 'trace-1',
        traceSide: 'current', origin: 'current_run', domain: 'cpu', metricId: 'runtime', status: 'observed',
        window: {start: 0, end: '1'}, cpu: null, value: null, coverage: 0, denominator: '0',
      }],
    },
    deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'failed',
      source: 'not_applicable', identity: 'passed', report: 'coverage_incomplete', investigation: 'coverage_incomplete'},
  };
  const sourceProvenance: SafeSourceProvenanceProjection = {
    sourceUseDecision: {
      schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send', selectedCodebaseIds: ['app'],
      status: 'corroborated', attemptedTools: ['lookup_app_source'], queriedCodebaseIds: ['app'], usedCodebaseIds: ['app'],
      coverageComplete: false, references: [sourceReference],
    },
    sourceClaimBindings: [{claimId: 'claim-1', mechanismStatus: 'compatible',
      sourceReferenceIds: ['source-1'], traceEvidenceRefIds: ['evidence-1']}],
  };
  return {result, sourceProvenance};
}

function addUnknown(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
