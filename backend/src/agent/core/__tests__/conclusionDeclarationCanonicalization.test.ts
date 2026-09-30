// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from '@jest/globals';
import {
  CONCLUSION_CONTRACT_SIDECAR_MARKER,
  declaredContractForResult,
  hasConclusionContractDeclarations,
  isConclusionClaimDiagnostic,
  parseClaimSemanticsDeclaration,
  parseConclusionContractSidecar,
  parseDeclaredConclusionClaims,
  parseDeclaredRelationProposals,
  parseTypedConclusionContractJson,
  renderConclusionContractSidecar,
  wrapConclusionContractSidecarPayload,
} from '../conclusionContract';
import {deriveConclusionContract} from '../conclusionGenerator';
import {
  buildCandidateProtocolDiagnostic,
  canonicalizeAnalysisResult,
  inspectCandidateProtocol,
  sanitizeCandidateProtocolDiagnostic,
} from '../../../services/canonicalAnalysisResult';
import {projectConclusionProtocol} from '../../../services/security/conclusionProtocolProjection';
import {analysisDeliveryFingerprint} from '../../../types/analysisDelivery';
import {buildNativeDeclarationCompletionPrompt, requestNativeDeclarationCompletion} from '../../../agentRuntime/runtimeConclusionProtocol';
import type {AnalysisTurnIntent} from '../../../agentRuntime/analysisTurnIntent';
import type {AnalysisResult} from '../orchestratorTypes';

type Json = Record<string, any>;

/**
 * One canonical claim per distinct shape persisted by real GLM runs (2026-09-27):
 * captured.cell, numeric.cell cited by sourceToolCallId, subjectRefs that differ
 * from references, conditions with relationRefs, and an interval.bounds time
 * window. The full 36-run corpus is checked outside the repository.
 */
const REAL: Record<string, Json> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'conclusionDeclarationClaims.json'), 'utf8'));

const SOURCE_LOCATION_CLAIM = {
  id: 'source:location', text: 'The handler is declared in app/Main.kt lines 10-20.', kind: 'identity', references: [],
  semantics: {schemaVersion: 'claim_semantics@1', predicate: 'source.location', polarity: 'affirmed', discourse: 'asserted',
    quantifier: 'one', modality: 'certain', scope: {population: 'codebase'},
    source: {sourceReferenceId: 'source-ref-1', filePath: 'app/Main.kt', lineRange: {start: 10, end: 20}}},
};

const RELATION_PROPOSAL = {
  schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:running_ratio', kind: 'derived', direction: 'subject_to_object',
  subject: {evidenceRefId: 'data:sql_table:current:a:b:c', rowIndex: 0, column: 'running_ns', value: 5},
  object: {evidenceRefId: 'data:sql_table:current:a:b:d', rowIndex: 0, column: 'wall_ns', value: 10},
  metricColumn: 'running_ns', value: 0.5, unit: 'ratio',
};

const CLAIMS: Json[] = [...Object.values(REAL), SOURCE_LOCATION_CLAIM];
const RELATIONS: Json[] = [RELATION_PROPOSAL];

function verboseDeclaration(claims: unknown[], relationProposals: unknown[] = RELATIONS): Json {
  return {
    schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [{rank: 1, statement: '主线程在 Choreographer#doFrame 中耗时 > 16 ms & 需要关注。'}],
    clusters: [], evidenceChain: [{conclusionId: 'C1', text: 'data:sql_table 证据 <row 0>'}],
    claims, relationProposals, uncertainties: ['未采集 GPU 频率'], nextSteps: ['补采 GPU 频率'],
  };
}

/** JSON with `", "` and `": "` separators, as the pre-D0 template example wrote it. */
function spaced(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spaced).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${spaced(item)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** Today's verbose shape: the template's one root key per line, spaced separators inside. */
function templateStyle(declaration: Json): string {
  return `{\n${Object.entries(declaration).map(([key, value]) => `  ${JSON.stringify(key)}: ${spaced(value)}`).join(',\n')}\n}`;
}

const sidecar = (payload: string) => `结论正文。\n\n${wrapConclusionContractSidecarPayload(payload)}`;

function withoutSemanticsSchemaVersion(claims: Json[]): Json[] {
  return claims.map(claim => {
    if (!claim.semantics) return claim;
    const {schemaVersion: _version, ...semantics} = claim.semantics;
    return {...claim, semantics};
  });
}

function withoutRelationSchemaVersion(proposals: Json[]): Json[] {
  return proposals.map(({schemaVersion: _version, ...proposal}) => proposal);
}

function withIntegerTimeRanges(claims: Json[]): Json[] {
  return claims.map(claim => {
    const range = claim.semantics?.scope?.timeRangeNs;
    return range ? {...claim, semantics: {...claim.semantics, scope: {...claim.semantics.scope,
      timeRangeNs: {start: Number(range.start), end: Number(range.end)}}}} : claim;
  });
}

/** Everything a consumer reads from one declaration, serialized in the parser's own key order. */
function canonicalSurfaces(raw: string) {
  const parsed = parseConclusionContractSidecar(raw);
  const declared = declaredContractForResult(parsed.contract);
  const inspected = inspectCandidateProtocol(raw);
  const {rawChars: _rawChars, ...diagnostic} = buildCandidateProtocolDiagnostic(inspected, 'native', 1);
  const canonical = canonicalizeAnalysisResult({sessionId: 'session-canonical', success: true, findings: [], hypotheses: [],
    conclusion: raw, confidence: 0.5, rounds: 1, totalDurationMs: 1} as unknown as AnalysisResult);
  return {
    status: parsed.status,
    bindingEligibility: parsed.bindingEligibility,
    issues: JSON.stringify(parsed.issues),
    contract: JSON.stringify(parsed.contract),
    contractFingerprint: analysisDeliveryFingerprint(parsed.contract),
    claimsFingerprint: analysisDeliveryFingerprint(parsed.contract?.claims),
    declared: JSON.stringify(declared),
    declaredFingerprint: analysisDeliveryFingerprint(declared),
    narrative: inspected.canonicalBody,
    diagnostic: JSON.stringify(diagnostic),
    resultContract: JSON.stringify(canonical.result.conclusionContract),
    validationContract: JSON.stringify(canonical.validationContract),
    privateDisplay: projectConclusionProtocol(undefined, raw).text,
  };
}

function expectIdempotent(raw: string): void {
  const contract = parseConclusionContractSidecar(raw).contract!;
  for (const claim of contract.claims ?? []) {
    // finalSemanticAssessment, sourceClaimVerifier and sourceLocationProof re-parse canonical semantics.
    if (claim.semantics) {
      expect(JSON.stringify(parseClaimSemanticsDeclaration(claim.semantics).semantics)).toBe(JSON.stringify(claim.semantics));
    }
  }
  const rerendered = parseConclusionContractSidecar(renderConclusionContractSidecar(contract)).contract;
  expect(JSON.stringify(rerendered)).toBe(JSON.stringify(contract));
}

describe('lighter declaration wire forms keep the valid canonical contract byte-identical', () => {
  const verbose = canonicalSurfaces(sidecar(templateStyle(verboseDeclaration(CLAIMS))));

  it('D0: minified, template-style and indented declarations are valid and identical', () => {
    expect(verbose.status).toBe('valid');
    expect(verbose.bindingEligibility).toBe('eligible');
    expect(JSON.parse(verbose.contract).claims).toHaveLength(CLAIMS.length);
    const declaration = verboseDeclaration(CLAIMS);
    for (const payload of [JSON.stringify(declaration), JSON.stringify(declaration, null, 2)]) {
      expect(canonicalSurfaces(sidecar(payload))).toEqual(verbose);
    }
    const typed = (payload: string) => JSON.stringify(parseTypedConclusionContractJson(`\`\`\`json\n${payload}\n\`\`\``).contract);
    expect(typed(JSON.stringify(declaration))).toBe(typed(JSON.stringify(declaration, null, 2)));
    expectIdempotent(sidecar(JSON.stringify(declaration)));
  });

  it('D1: omitted nested schema versions and integer time windows equal the verbose declaration', () => {
    expect(CLAIMS.some(claim => claim.semantics?.scope?.timeRangeNs)).toBe(true);
    const variants = {
      semanticsVersionOmitted: verboseDeclaration(withoutSemanticsSchemaVersion(CLAIMS)),
      relationVersionOmitted: verboseDeclaration(CLAIMS, withoutRelationSchemaVersion(RELATIONS)),
      integerTimeWindows: verboseDeclaration(withIntegerTimeRanges(CLAIMS)),
      allTogether: verboseDeclaration(withIntegerTimeRanges(withoutSemanticsSchemaVersion(CLAIMS)),
        withoutRelationSchemaVersion(RELATIONS)),
    };
    const lightest = JSON.stringify(variants.allTogether);
    expect(lightest).not.toContain('claim_semantics@1');
    expect(lightest).not.toContain('evidence_relation_candidate@1');
    expect(lightest).toMatch(/"timeRangeNs":\{"start":\d+,"end":\d+\}/);
    for (const [name, declaration] of Object.entries(variants)) {
      expect({name, surfaces: canonicalSurfaces(sidecar(JSON.stringify(declaration)))}).toEqual({name, surfaces: verbose});
    }
    const contract = JSON.parse(verbose.contract);
    expect(contract.claims.every((claim: Json) => Object.keys(claim.semantics)[0] === 'schemaVersion')).toBe(true);
    expect(Object.keys(contract.relationProposals[0])[0]).toBe('schemaVersion');
    expectIdempotent(sidecar(lightest));
  });

  it('accepts the same forms through the legacy JSON branch that calls the item parsers directly', () => {
    const legacy = (claims: Json[], relations: Json[]) => {
      const {schemaVersion: _root, ...rootless} = verboseDeclaration(claims, relations);
      return deriveConclusionContract(JSON.stringify(rootless));
    };
    const explicit = legacy(CLAIMS, RELATIONS);
    expect(explicit?.bindingEligibility).toBe('eligible');
    const light = legacy(withIntegerTimeRanges(withoutSemanticsSchemaVersion(CLAIMS)), withoutRelationSchemaVersion(RELATIONS));
    expect(JSON.stringify(light)).toBe(JSON.stringify(explicit));
  });

  it('keeps the model\'s own text on the invalid path, with the same issues and eligibility', () => {
    const [claim] = withIntegerTimeRanges([REAL.interval]);
    const broken = (semantics: Json) => ({...claim, semantics: {...semantics, polarity: 'sometimes'}});
    const brokenRelation = {...RELATION_PROPOSAL, kind: 'caused_by'};
    const explicit = parseConclusionContractSidecar(sidecar(JSON.stringify(verboseDeclaration([broken(claim.semantics)],
      [brokenRelation]))));
    const omittedClaim = withoutSemanticsSchemaVersion([broken(claim.semantics)])[0];
    const [omittedRelation] = withoutRelationSchemaVersion([brokenRelation]);
    const omitted = parseConclusionContractSidecar(sidecar(JSON.stringify(verboseDeclaration([omittedClaim], [omittedRelation]))));
    expect(omitted.status).toBe('invalid');
    expect(omitted.bindingEligibility).toBe(explicit.bindingEligibility);
    expect(JSON.stringify(omitted.issues)).toBe(JSON.stringify(explicit.issues));
    // Invalid semantics and proposals are what the model wrote: no inserted version, no normalized integers.
    expect(omitted.contract!.claims![0].rawSemantics).toEqual(omittedClaim.semantics);
    expect(omitted.contract!.claims![0].rawSemantics).not.toHaveProperty('schemaVersion');
    expect(typeof (omitted.contract!.claims![0].rawSemantics as Json).scope.timeRangeNs.start).toBe('number');
    expect(omitted.contract!.rawRelationProposals).toEqual([omittedRelation]);
  });
});

describe('an invalid declaration that omits a nested schema version stays the model\'s own text', () => {
  const intent: AnalysisTurnIntent = {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry',
    taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'full',
    deliverable: 'answer', evidenceAccess: 'read_new'};
  const [invalidClaim] = withIntegerTimeRanges(withoutSemanticsSchemaVersion([{...REAL.interval,
    semantics: {...REAL.interval.semantics, polarity: 'sometimes'}}]));
  const [relation] = withoutRelationSchemaVersion(RELATIONS);
  const declaration = verboseDeclaration([...withoutSemanticsSchemaVersion([REAL.captured]), invalidClaim], [relation]);
  const modelSidecar = wrapConclusionContractSidecarPayload(JSON.stringify(declaration));
  const raw = `结论正文。\n\n${modelSidecar}`;

  it('quotes, projects and retains exactly what the model wrote on every path', () => {
    expect(modelSidecar).not.toContain('claim_semantics@1');
    expect(modelSidecar).not.toContain('evidence_relation_candidate@1');

    // Repair request: the rejected declaration is the model's original segment, never a canonicalized rendering.
    const request = requestNativeDeclarationCompletion({intent, completion: {status: 'completed'}, candidate: raw,
      remainingDeliveryTurns: 1, repairInvalid: true})!;
    expect(request.rejectedDeclaration).toBe(modelSidecar);
    expect(request.diagnostic.claimDiagnostics).toEqual([{ordinal: 2, code: 'invalid_semantics', field: 'semantics.polarity'}]);
    for (const outputLanguage of ['zh-CN', 'en'] as const) {
      const prompt = buildNativeDeclarationCompletionPrompt({request, intent, outputLanguage});
      expect(prompt).toContain(JSON.stringify({schemaVersion: 1, kind: 'rejected_declaration', text: modelSidecar}));
      expect(prompt).not.toContain('claim_semantics@1');
      expect(prompt).not.toContain('evidence_relation_candidate@1');
    }

    // Private display re-render: an invalid declaration becomes the null marker, not a rendered contract.
    const projected = projectConclusionProtocol(undefined, raw).text;
    expect(projected.startsWith(`${CONCLUSION_CONTRACT_SIDECAR_MARKER}\n\`\`\`json\nnull\n\`\`\`\n-->`)).toBe(true);
    expect(projected).not.toContain('claim_semantics@1');
    expect(projected).not.toContain('sometimes');

    // Canonical/report raw fallback: the invalid claim keeps the model's semantics, integers included.
    const canonical = canonicalizeAnalysisResult({sessionId: 'session-invalid', success: true, findings: [], hypotheses: [],
      conclusion: raw, confidence: 0.5, rounds: 1, totalDurationMs: 1} as unknown as AnalysisResult);
    expect(canonical.bindingEligibility).toBe('ineligible');
    const stored = canonical.validationContract!.claims![1];
    expect(stored.rawSemantics).toEqual(invalidClaim.semantics);
    expect(stored.rawSemantics).not.toHaveProperty('schemaVersion');
    expect(typeof (stored.rawSemantics as Json).scope.timeRangeNs.start).toBe('number');
    expect(stored.semantics).toBeUndefined();
    expect(canonical.protocolDiagnostics!.sidecar.rawPayload).toEqual(JSON.parse(JSON.stringify(declaration)));
    // Re-rendering the stored invalid contract reproduces the model's semantics, still without an inserted version.
    const rerendered = parseConclusionContractSidecar(renderConclusionContractSidecar(canonical.validationContract!));
    expect(rerendered.contract!.claims![1].rawSemantics).toEqual(invalidClaim.semantics);
    expect(canonical.result.conclusionContract?.claims?.[1]).not.toHaveProperty('rawSemantics');
  });
});

describe('lighter declaration forms accept nothing else', () => {
  const claim = REAL.captured;
  const parse = (declaration: Json) => parseConclusionContractSidecar(sidecar(JSON.stringify(declaration)));
  const firstClaimField = (declaration: Json) =>
    parse(declaration).issues.find(issue => issue.claimDiagnostic)?.claimDiagnostic?.field;
  const withRange = (start: unknown, end: unknown) => ({...REAL.interval, semantics: {...REAL.interval.semantics,
    scope: {...REAL.interval.semantics.scope, timeRangeNs: {start, end}}}});

  it('still requires the root schema version; protocol detection never reads a nested version', () => {
    const {schemaVersion: _version, ...rootless} = verboseDeclaration([claim]);
    expect(parse(rootless).status).toBe('invalid');
    expect(parse(rootless).issues[0].details).toEqual(expect.arrayContaining([
      {field: '$.schemaVersion', reason: 'missing_required', expected: 'conclusion_contract_v1', actual: 'missing'}]));
    expect(parseTypedConclusionContractJson(JSON.stringify(rootless)).status).toBe('absent');
    const omitted = verboseDeclaration(withoutSemanticsSchemaVersion([claim]), withoutRelationSchemaVersion(RELATIONS));
    expect(hasConclusionContractDeclarations(omitted)).toBe(hasConclusionContractDeclarations(verboseDeclaration([claim])));
    expect(parseTypedConclusionContractJson(JSON.stringify(omitted)).status).toBe('valid');
  });

  it.each(['conclusions', 'clusters', 'evidenceChain', 'uncertainties', 'nextSteps'])('still requires the root array %s', field => {
    const {[field]: _omitted, ...declaration} = verboseDeclaration([claim]);
    const parsed = parse(declaration);
    expect(parsed.status).toBe('invalid');
    expect(parsed.issues[0].details).toEqual(expect.arrayContaining([expect.objectContaining({
      field: `$.${field}`, reason: 'missing_required'})]));
  });

  it('still requires claim references when schema versions are omitted', () => {
    const {references: _references, ...unreferenced} = withoutSemanticsSchemaVersion([claim])[0];
    const parsed = parse(verboseDeclaration([unreferenced]));
    expect(parsed.status).toBe('invalid');
    expect(parsed.issues).toEqual(expect.arrayContaining([{code: 'invalid_reference', path: 'claims[0].references',
      claimDiagnostic: {ordinal: 1, code: 'invalid_reference', field: 'references'}}]));
  });

  it('rejects a present but different nested schema version', () => {
    for (const schemaVersion of ['claim_semantics@2', null]) {
      expect(firstClaimField(verboseDeclaration([{...claim, semantics: {...claim.semantics, schemaVersion}}])))
        .toBe('semantics.schemaVersion');
    }
    const relation = parse(verboseDeclaration([claim], [{...RELATION_PROPOSAL, schemaVersion: 'evidence_relation_candidate@2'}]));
    expect(relation.issues).toEqual([expect.objectContaining({code: 'invalid_relation_proposal',
      relationProposalDiagnostic: {scope: 'item', ordinal: 1, reason: 'invalid_schema_version'}})]);
  });

  it('keeps unsafe or non-integer time windows invalid', () => {
    for (const [start, end] of [[1.5, 2], [0, Number.MAX_SAFE_INTEGER + 2], [1e21, 1e21], ['10', 5], [6, 5], ['1e3', '2e3']]) {
      expect(firstClaimField(verboseDeclaration([withRange(start, end)]))).toBe('semantics.scope.timeRangeNs');
    }
    // JSON text beyond 2^53 loses digits in JSON.parse; the parser must not accept the rounded number.
    const payload = JSON.stringify(verboseDeclaration([withRange('0', '1')])).replace('"end":"1"', '"end":9007199254740993');
    expect(parseConclusionContractSidecar(sidecar(payload)).issues.find(issue => issue.claimDiagnostic)?.claimDiagnostic?.field)
      .toBe('semantics.scope.timeRangeNs');
    expect(parse(verboseDeclaration([withRange(-5, '5')])).status).toBe('valid');
  });

  it('gives the direct item parsers the same canonical output as the declaration parser', () => {
    const lightClaims = withIntegerTimeRanges(withoutSemanticsSchemaVersion(CLAIMS));
    expect(parseDeclaredConclusionClaims(lightClaims).issues).toEqual([]);
    expect(JSON.stringify(parseDeclaredConclusionClaims(lightClaims).claims))
      .toBe(JSON.stringify(parseDeclaredConclusionClaims(CLAIMS).claims));
    expect(JSON.stringify(parseClaimSemanticsDeclaration(lightClaims[0].semantics).semantics))
      .toBe(JSON.stringify(parseClaimSemanticsDeclaration(CLAIMS[0].semantics).semantics));
    const relations = parseDeclaredRelationProposals(withoutRelationSchemaVersion(RELATIONS));
    expect(relations.issues).toEqual([]);
    expect(JSON.stringify(relations.relationProposals)).toBe(JSON.stringify(parseDeclaredRelationProposals(RELATIONS).relationProposals));
  });
});

describe('numeric claim diagnostics name the failing part', () => {
  const claim = REAL.numeric_toolcall;
  const numeric = claim.semantics.numeric;
  const withNumeric = (value: unknown) => ({...claim, semantics: {...claim.semantics, numeric: value}});
  const intent: AnalysisTurnIntent = {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry',
    taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'full',
    deliverable: 'answer', evidenceAccess: 'read_new'};

  it.each([
    ['shape', 'not-an-object'],
    ['shape', {...numeric, extra: 1}],
    ['operator', {...numeric, operator: 'approx'}],
    ['value', {...numeric, value: '7 ms'}],
    ['unit', {...numeric, unit: ' '}],
  ])('reports %s and reaches the repair prompt', (subreason, value) => {
    const raw = `正文。\n\n${renderConclusionContractSidecar(verboseDeclaration([withNumeric(value)]) as any)}`;
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic.claimDiagnostics).toEqual([{ordinal: 1, code: 'invalid_semantics', field: 'semantics.numeric', subreason}]);
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('approx');
    const request = requestNativeDeclarationCompletion({intent, completion: {status: 'completed'}, candidate: raw,
      remainingDeliveryTurns: 1, repairInvalid: true})!;
    const prompt = buildNativeDeclarationCompletionPrompt({request, intent, outputLanguage: 'zh-CN'});
    expect(prompt).toContain(`"field":"semantics.numeric","subreason":"${subreason}"`);
  });

  it('accepts older diagnostics without a subreason and rejects any other subreason', () => {
    const base = {ordinal: 1, code: 'invalid_semantics', field: 'semantics.numeric'};
    expect(isConclusionClaimDiagnostic(base)).toBe(true);
    expect(isConclusionClaimDiagnostic({...base, subreason: 'unit'})).toBe(true);
    expect(isConclusionClaimDiagnostic({...base, subreason: 'PRIVATE_CANARY'})).toBe(false);
    expect(isConclusionClaimDiagnostic({...base, field: 'semantics.predicate', subreason: 'unit'})).toBe(false);
    expect(isConclusionClaimDiagnostic({ordinal: 1, code: 'invalid_reference', field: 'references', subreason: 'value'})).toBe(false);
  });
});

describe('only the server supplies a new result\'s case recommendations', () => {
  it('leaves declared caseRecommendations, learned provenance included, out of every surface', () => {
    const declaration = {...verboseDeclaration(CLAIMS), caseRecommendations: [{
      caseId: 'learned:0123456789abcdef', title: 'A learned case', matchStrength: 'strong',
      recommendations: {app: [], oem: []},
      learnedProvenance: {candidateId: 'casecand-run-1', supportingEvidence: 3, contradictingEvidence: 0, supported: true},
    }]};
    const typed = parseTypedConclusionContractJson(JSON.stringify(declaration));
    const surfaces = canonicalSurfaces(sidecar(JSON.stringify(declaration)));

    expect([typed.status, surfaces.status]).toEqual(['valid', 'valid']);
    for (const surface of [JSON.stringify(typed.contract), ...Object.values(surfaces).map(String)]) {
      expect(surface).not.toMatch(/caseRecommendations|learnedProvenance/);
    }
  });

  it('drops every recommendation a runtime-supplied contract carries, and a restored result keeps its own', () => {
    const recommendations = [
      {caseId: 'learned:0123456789abcdef', title: 'A learned case', matchStrength: 'strong',
        recommendations: {app: [], oem: []}},
      {caseId: 'curated-case', title: 'A curated case', matchStrength: 'partial',
        recommendations: {app: [], oem: []},
        learnedProvenance: {candidateId: 'casecand-run-1', supportingEvidence: 3, contradictingEvidence: 0, supported: true}},
    ];
    const source = {sessionId: 'session-fallback', success: true, findings: [], hypotheses: [],
      conclusion: '结论正文。', confidence: 0.5, rounds: 1, totalDurationMs: 1,
      conclusionContract: {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
        conclusions: [{rank: 1, statement: 'Shader compile causes jank.'}], clusters: [], evidenceChain: [],
        uncertainties: [], nextSteps: [], caseRecommendations: recommendations},
    } as unknown as AnalysisResult;

    const accepted = canonicalizeAnalysisResult(source);
    // Both what the result delivers and what the finalizer re-projects from.
    expect(accepted.result.conclusionContract).not.toHaveProperty('caseRecommendations');
    expect(accepted.validationContract).not.toHaveProperty('caseRecommendations');
    expect(accepted.validationContract?.conclusions).toEqual(source.conclusionContract?.conclusions);
    expect(canonicalizeAnalysisResult(source, {context: {entry: 'historical_restore'}})
      .result.conclusionContract?.caseRecommendations).toEqual(recommendations);
  });
});
