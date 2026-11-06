// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {installCurrentRealmStructuredCloneForTest} from '../../../tests/helpers/openAiRuntimeFixture';
import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject, type AuthoredClaimObjectResult} from '../../agent/core/authoredClaimObject';
import type {AuthoredClaimObjectInput} from '../../agent/core/authoredClaimObjectSchema';
import {compactSemanticEvidenceSnapshot, expandSemanticEvidenceSnapshot} from '../evidence/semanticEvidenceSnapshot';
import {compactSemanticSourceSnapshot, expandSemanticSourceSnapshot} from '../evidence/semanticSourceSnapshot';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {renderConclusionContractSidecar, wrapConclusionContractSidecarPayload, parseConclusionContractDeclaration, CONCLUSION_PROTOCOL_VALUES, type ConclusionContract,
  type ConclusionContractClaimItem, wrapConclusionAuthoringPayload, conclusionDeclarationValidationPayload} from '../../agent/core/conclusionContract';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection, inspectCandidateProtocol,
  buildCandidateProtocolDiagnostic, buildAuthoredCandidateProtocolDiagnostic, sanitizeCandidateProtocolDiagnostic} from '../canonicalAnalysisResult';
import {assessFinalResultQualityAssessment} from '../finalResultQualityGate';
import {runClaimVerification} from '../verifier/claimVerificationRunner';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {runPreparedAnalysisClaimVerification} from '../evidence/analysisRelationPreparation';
import {finalizeSourceAwareAnalysisResultWithProjection} from '../codebase/sourceClaimVerifier';
import {claimConclusionProtocolProjection, readConclusionProtocolProjection, releaseConclusionProtocolProjection,
  projectConclusionSemanticInput, projectConclusionProtocol, readConclusionTransportObservation, readAuthoredQuoteBindings,
  type NativeConclusionDeclaration} from '../security/conclusionProtocolProjection';
import {registerOnDemandSourceLookupForEcho, registerCodeAwareCanary, registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards, clearCodeAwareOutputGuards, withOwnerCodeAwareProjection} from '../security/codeAwareOutputRegistry';
import {prepareClaimEvidence, preparedClaimEvidenceSnapshot} from '../evidence/claimEvidencePreparation';
import {AUTHORED_CLAIM_DOCUMENT_VERSION, compileAuthoredClaimDocument} from '../../agent/core/authoredClaimDocument';
import {AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION, AUTHORED_CLAIM_OBJECT_COMPILER_VERSION, createAuthoredFinalSubmissionIssuer,
  type AuthoredFinalSubmissionV1ReadInput, type AuthoredFinalSubmissionV2ReadInput, type AuthoredFinalSubmissionAssistantV2ReadInput,
  issueAuthoredFinalSubmission, readAuthoredFinalSubmission} from '../../agentRuntime/authoredFinalSubmission';
import {issueAuthoredConclusionProtocolProjection, hasCurrentAuthoredFinalDelivery, hasCurrentAuthoredFinalBody,
  type AuthoredConclusionSubmission} from '../security/conclusionProtocolProjection';
import {sanitizeCodeAwareStructuredTextWithReceipt, issueCodeAwareStructuredProjectionReceipt,
  composeCodeAwareTextProjectionReceipts} from '../security/codeAwareOutputRegistry';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {attachFinalizationContext, takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {finalizeAnalysisResult} from '../finalizeAnalysisResult';
import {verifyConclusion} from '../../agentRuntime/engines/claude/claudeVerifier';
import {buildTraceProcessorQueryProvenance} from '../traceProcessorConnectionModel';
import {assessNumericPresentations} from '../numericPresentationAssessment';
import {copyAnalysisDeliveryFields} from '../security/analysisDeliveryProjection';

function declaration(value = 999): ConclusionContract {
  return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
    evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'measured-duration', kind: 'numeric',
      text: `Measured duration is ${value} ms.`, references: [{evidenceRefId: 'data:duration', rowIndex: 0,
        column: 'dur_ms', value}]}]};
}

function result(conclusion: string): AnalysisResult {
  return {sessionId: 'canonical-session', success: true, findings: [], hypotheses: [], conclusion,
    confidence: 0.8, rounds: 1, totalDurationMs: 10};
}

function contextFor(source: AnalysisResult, status: AnalysisCompletion['status'] = 'completed',
  deliverable: 'answer' | 'report' = 'answer'): Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> {
  const acceptedCandidate = {candidateRef: 'native-a', runId: 'run-a', attemptId: 'attempt-a',
    conclusionFingerprint: analysisDeliveryFingerprint(source.conclusion)};
  return {entry: 'new_finalization', acceptedCandidate, outputOrigin: 'sdk_final',
    completion: {...acceptedCandidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-a',
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
      deliverable, evidenceAccess: 'read_new'}};
}

function authoredNumeric() {
  const ref = {evidenceRefId: 'data:duration', rowIndex: 0, column: 'dur_ms', value: 10};
  return {id: 'duration', text: '10 ms', kind: 'numeric', references: [ref],
    semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
      discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: [ref]},
      numeric: {operator: 'eq', value: 10, unit: 'ms', presentation: {schemaVersion: 'numeric_presentation@1',
        unit: 'ms', decimalPlaces: 0, rounding: 'half_away_from_zero',
        quotes: [{text: '10 ms', occurrence: 0}, {text: '10 ms', occurrence: 1}]}}}};
}

function authoredFixture(options: {payload?: Record<string, unknown>; parts?: unknown[]; raw?: string; project?: boolean} = {}) {
  const payload = options.payload ?? {...declaration(), claims: [authoredNumeric()]};
  const documentJson = options.raw ?? JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
    contract: payload, bodyParts: options.parts ?? ['Observation: ', {claimText: 'duration'}, '\n\n|Metric|\n|---|\n|', {claimText: 'duration'}, '|']});
  const compiled = compileAuthoredClaimDocument(documentJson);
  if (compiled.status !== 'compiled') throw new Error(`Invalid authored fixture: ${compiled.code}`);
  const source = result(compiled.body);
  const live = {active: true, attempt: true};
  const binding = {owner: live, sessionId: source.sessionId, runId: 'run-a', attemptId: 'attempt-a',
    providerPin: 'test-pin', authorizationFingerprint: 'test-scope'};
  const issuer = createAuthoredFinalSubmissionIssuer({binding,
    assertAttemptCurrent: () => {if (!live.attempt) throw new Error('retired attempt');},
    assertCurrent: () => {if (!live.active) throw new Error('revoked owner');}});
  const rawArguments = JSON.stringify({documentJson});
  const submission = issueAuthoredFinalSubmission(issuer, {dispatchOrdinal: 1, responseId: 'r', callId: 'c', rawArguments, documentJson, compiled});
  const handoff: AuthoredConclusionSubmission & {input: AuthoredFinalSubmissionV1ReadInput} = {submission, input: {binding: {...binding, dispatchOrdinal: 1, responseId: 'r', callId: 'c',
    representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, compilerContractVersion: AUTHORED_CLAIM_DOCUMENT_COMPILER_VERSION},
    rawArguments, documentJson, body: compiled.body, rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)}};
  const delivery = contextFor(source);
  delivery.outputOrigin = 'model_tool_arguments';
  delivery.finalSubmission = {mode: 'authored_claim_document_v1', outcome: 'submitted'};
  source.outputOrigin = delivery.outputOrigin;
  source.completion = delivery.completion;
  const projected = options.project === false ? undefined : finalizeSourceAwareAnalysisResultWithProjection(source, undefined,
    {context: delivery, authoredSubmission: handoff});
  const context = projected?.deliveryContext ?? delivery;
  if (context.entry === 'historical_restore') throw new Error('Invalid fixture context');
  const token = projected?.protocolProjection;
  const read = () => {
    if (!token) throw new Error('Projection not issued');
    return readConclusionProtocolProjection(token, {result: source, candidate: context.acceptedCandidate, runId: binding.runId});
  };
  return {source, compiled, live, handoff, delivery, context, token, read,
    cleanup: () => {if (token) releaseConclusionProtocolProjection(token); clearCodeAwareOutputGuards(source.sessionId);}};
}

describe('issued transport identity observation', () => {
  it('reads only issued frozen identities and leaves native authority checks unchanged', () => {
    const f = authoredFixture();
    try {
      const native = f.read();
      const before = structuredClone(f.source);
      const observed = readConclusionTransportObservation(native);
      expect(observed).toEqual({
        nativeCandidateKey: analysisDeliveryFingerprint(f.delivery.acceptedCandidate),
        displayCandidateKey: analysisDeliveryFingerprint(f.context.acceptedCandidate),
      });
      expect(Object.isFrozen(observed)).toBe(true);
      expect(readConclusionTransportObservation({...native})).toBeUndefined();
      expect(readConclusionTransportObservation(JSON.parse(JSON.stringify(native)))).toBeUndefined();
      f.live.active = false;
      // The observer cannot revoke or bless a capability. The original read still rejects it.
      expect(readConclusionTransportObservation(native)).toEqual(observed);
      expect(() => f.read()).toThrow('authored_final_submission_inactive');
      expect(f.source).toEqual(before);
    } finally {f.cleanup();}
  });

  it('returns no identities after the issuing projection is released', () => {
    const f = authoredFixture();
    const native = f.read();
    f.cleanup();
    expect(readConclusionTransportObservation(native)).toBeUndefined();
  });
});

describe('issued authored-document consumers', () => {
  it.each(['needs_user_input', 'recommend_full', 'invalid_contract'] as const)(
    'delivers literal V1 conversation text without activating %s', kind => {
      const body = ` \nLiteral answer\n<!-- smartperfetto:conversation-control ${JSON.stringify({kind,
        question: 'Which trace?', handoff: {question: 'Which trace?', scope: 'Full analysis'}})} -->\n `;
      const payload = {...declaration(), mode: kind === 'invalid_contract' ? 'invalid' : 'need_input', sourceClaimBindings: []};
      const f = authoredFixture({parts: [body], payload});
      try {
        const native = f.read();
        const evidence = [{id: 'evidence-1', label: 'Existing evidence'}];
        const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: native,
          conversation: {fallbackQuestion: 'Original question', evidence}});
        expect(canonical.conversationOutcome).toEqual({kind: 'answered', message: body, evidence});
        expect(canonical.result.conclusion).toBe(body);
        expect(canonical.protocolDiagnostics?.conversation).toMatchObject({status: 'absent', narrative: body,
          machineSegments: [], issues: []});
        expect(canonical.validationContract?.mode).toBe(kind === 'invalid_contract' ? undefined : 'need_input');
        expect(canonical.protocolDiagnostics?.typedJson?.status).toBe(kind === 'invalid_contract' ? 'invalid' : 'valid');
        expect(canonical.bindingEligibility).toBe(kind === 'invalid_contract' ? 'ineligible' : 'eligible');
        expect(canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: native})
          .conversationOutcome).toBeUndefined();
      } finally {f.cleanup();}
    });

  it.each(['valid', 'partially_valid', 'invalid'] as const)('observes the issued original %s declaration without scanning body or dropping invalid entries', status => {
    const payload = {...declaration(), sourceClaimBindings: [], claims: [authoredNumeric(),
      ...(status === 'valid' ? [] : [{id: 'PRIVATE_CLAIM_ID', text: 'PRIVATE_CLAIM_TEXT', kind: 'numeric', semantics: false}])],
      ...(status === 'invalid' ? {mode: 'PRIVATE_MODE', PRIVATE_DYNAMIC_FIELD: '/private/source'} : {})};
    const f = authoredFixture({payload, parts: ['PRIVATE_BODY\n', renderConclusionContractSidecar(declaration())]});
    try {
      const snapshot = readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input);
      expect(snapshot.compiled.rawCanonicalPayload).toEqual(payload);
      if (status === 'partially_valid') {
        expect(snapshot.compiled.canonicalParse.contract?.claims?.[1]).toMatchObject({valid: false, rawSemantics: false});
        expect(snapshot.compiled.canonicalParse.contract?.claims?.[1]).not.toHaveProperty('semantics');
      }
      if (status === 'invalid') expect(snapshot.compiled.canonicalParse.contract).toBeUndefined();
      const before = structuredClone(snapshot);
      const diagnostic = buildAuthoredCandidateProtocolDiagnostic(snapshot);
      expect(diagnostic).toMatchObject({stage: 'native', candidateIndex: 1, status, sidecarStatus: 'absent', typedJsonStatus: status,
        rawChars: snapshot.documentJson.length, canonicalChars: snapshot.compiled.body.trim().length,
        claimCount: status === 'valid' ? 1 : 2, semanticClaimCount: status === 'valid' ? 1 : 2, sourceBindingCount: 0});
      expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
      expect(snapshot).toEqual(before);
      expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_|private\/source|rawPayload|claimText/);
      if (status === 'invalid') expect(diagnostic.details).toContainEqual(expect.objectContaining({field: '$.mode'}));
    } finally {f.cleanup();}
  });

  it.each(['claims_missing', 'claims_invalid', 'bindings_missing', 'bindings_invalid'] as const)(
    'leaves linked declaration counts unknown for %s', reason => {
      const payload: Record<string, unknown> = {...declaration(), sourceClaimBindings: []};
      if (reason === 'claims_missing') delete payload.claims;
      if (reason === 'claims_invalid') payload.claims = 'PRIVATE_BAD_CONTAINER';
      if (reason === 'bindings_missing') delete payload.sourceClaimBindings;
      if (reason === 'bindings_invalid') payload.sourceClaimBindings = {PRIVATE_BAD_CONTAINER: []};
      const f = authoredFixture({payload, parts: ['Literal body']});
      try {
        const diagnostic = buildAuthoredCandidateProtocolDiagnostic(readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input));
        for (const key of ['claimCount', 'semanticClaimCount', 'sourceBindingCount']) expect(diagnostic).not.toHaveProperty(key);
        expect(diagnostic.authoredMaterial).toBeDefined();
        expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
      } finally {f.cleanup();}
    });

  it('keeps exact Unicode/escaping input measurements separate from normalized compiled material', () => {
    const raw = JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION,
      contract: {...declaration(), sourceClaimBindings: []}, bodyParts: [' \n中"\\', '\ud83d', '\ude00', '\t ']}, null, 2);
    const f = authoredFixture({raw});
    try {
      const snapshot = readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input);
      const diagnostic = buildAuthoredCandidateProtocolDiagnostic(snapshot);
      expect(diagnostic.authoredMaterial).toEqual({rawArgumentsUtf8Bytes: Buffer.byteLength(snapshot.rawArguments),
        documentInputUtf8Bytes: Buffer.byteLength(raw), bodyUtf8Bytes: Buffer.byteLength(f.compiled.body),
        bodyUtf16Length: f.compiled.body.length, normalizedDocument: f.compiled.material.raw,
        normalizedExpanded: f.compiled.material.expanded});
      expect(diagnostic.rawChars).toBe(raw.length);
      expect(diagnostic.canonicalChars).toBe(f.compiled.body.trim().length);
      const material = diagnostic.authoredMaterial;
      if (!material || 'representationVersion' in material) throw new Error('Expected legacy material diagnostics');
      expect(material.documentInputUtf8Bytes).toBeGreaterThan(material.normalizedDocument.utf8Bytes);
      for (const invalid of [
        {...material, rawArgumentsUtf8Bytes: -1}, {...material, bodyUtf16Length: NaN},
        {...material, documentInputUtf8Bytes: 1024 * 1024 + 1}, {...material, path: '/private/source'},
        {...material, normalizedDocument: {...material.normalizedDocument, PRIVATE_DYNAMIC: 'secret'}},
        {...material, normalizedExpanded: {...material.normalizedExpanded, depth: 25}},
        {...material, normalizedExpanded: {...material.normalizedExpanded, nodes: 10_001}},
      ]) expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, authoredMaterial: invalid})).toBeUndefined();
      const {authoredMaterial: _material, ...oldShape} = diagnostic;
      expect(sanitizeCandidateProtocolDiagnostic(oldShape)).toEqual(oldShape);
    } finally {f.cleanup();}
  });

  it.each(['sidecar', 'canonical_json', 'whitespace'] as const)('checks actual typed body presence without carrier scanning: %s', async kind => {
    const body = kind === 'sidecar' ? renderConclusionContractSidecar(declaration())
      : kind === 'canonical_json' ? JSON.stringify(declaration()) : ' \n\t';
    const f = authoredFixture({parts: [body]});
    try {
      const verified = await verifyConclusion([], f.source.conclusion, {deliveryContext: f.context});
      expect(hasCurrentAuthoredFinalBody(f.source.conclusion, f.context)).toBe(true);
      expect(verified.heuristicIssues.some(issue => issue.type === 'missing_reasoning')).toBe(kind === 'whitespace');
      expect(verified.heuristicIssues.every(issue => issue.recoveryKind === undefined)).toBe(true);
      if (kind !== 'whitespace') {
        const legacy = await verifyConclusion([], body, {deliveryContext: contextFor(result(body))});
        expect(legacy.heuristicIssues.some(issue => issue.type === 'missing_reasoning')).toBe(kind === 'sidecar');
      }
    } finally {f.cleanup();}
  });

  it('carries exact material through the real source projector and canonicalizer without scanning body examples', () => {
    const body = `Plain JSON: {"mode":"need_input"}\n${renderConclusionContractSidecar(declaration())}\n${control}`;
    const f = authoredFixture({parts: [body]});
    try {
      const native = f.read();
      expect(native.inputKind).toBe('model_tool_arguments');
      expect(native).not.toHaveProperty('raw');
      expect(native).toMatchObject({rawArguments: f.handoff.input.rawArguments, documentJson: f.handoff.input.documentJson,
        body, rawCanonicalPayload: f.compiled.rawCanonicalPayload});
      const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: native});
      expect(canonical.result.conclusion).toBe(body);
      expect(canonical.protocolDiagnostics?.sidecar).toEqual({status: 'absent', raw: '', bindingEligibility: 'legacy_unchecked',
        narrative: body, machineSegments: [], issues: []});
      expect(canonical.protocolDiagnostics?.typedJson?.rawPayload).toEqual(f.compiled.rawCanonicalPayload);
      expect(canonical.conversationOutcome).toBeUndefined();
      expect(canonical.validationContract?.claims?.[0].id).toBe('duration');
      expect(hasCurrentAuthoredFinalDelivery(canonical.result, canonical.deliveryContext!)).toBe(true);
      expect(hasCurrentAuthoredFinalDelivery(canonical.result, {...canonical.deliveryContext!})).toBe(false);
      expect(JSON.stringify(canonical.result)).not.toContain('documentJson');
      expect(JSON.stringify(canonical.result)).not.toContain('rawArgumentsHash');
    } finally {f.cleanup();}
  });

  it.each(['body', 'contract', 'claims', 'source'] as const)('rejects a colliding displayed %s value despite unchanged fingerprints', field => {
    const f = authoredFixture({parts: ['\ud800'], project: false});
    const receipt = sanitizeCodeAwareStructuredTextWithReceipt(f.source.sessionId, f.source.conclusion);
    f.source.conclusionContract = {...declaration(), probe: Infinity} as ConclusionContract;
    if (field === 'claims') (f.source.conclusionContract.claims![0] as any).probe = -0;
    if (field === 'source') f.source.sourceUseDecision = {probe: Infinity} as any;
    const token = issueAuthoredConclusionProtocolProjection({submission: f.handoff, result: f.source,
      nativeCandidate: f.delivery.acceptedCandidate, displayCandidate: f.delivery.acceptedCandidate, bodyProjection: receipt});
    const before = analysisDeliveryFingerprint(field === 'body' ? f.source.conclusion : field === 'source'
      ? f.source.sourceUseDecision : f.source.conclusionContract);
    if (field === 'body') f.source.conclusion = '\ud801';
    if (field === 'contract') (f.source.conclusionContract as any).probe = null;
    if (field === 'claims') (f.source.conclusionContract.claims![0] as any).probe = 0;
    if (field === 'source') (f.source.sourceUseDecision as any).probe = null;
    expect(analysisDeliveryFingerprint(field === 'body' ? f.source.conclusion : field === 'source'
      ? f.source.sourceUseDecision : f.source.conclusionContract)).toBe(before);
    expect(() => readConclusionProtocolProjection(token, {result: f.source,
      candidate: f.delivery.acceptedCandidate, runId: 'run-a'})).toThrow('conclusion_protocol_projection_mismatch');
    releaseConclusionProtocolProjection(token);
  });

  it.each(['collision', 'compose_gap', 'forged'] as const)('rejects %s privacy lineage instead of trusting a matching body hash', kind => {
    const f = authoredFixture({parts: ['\ud800'], project: false});
    const receipt = kind === 'compose_gap'
      ? composeCodeAwareTextProjectionReceipts(issueCodeAwareStructuredProjectionReceipt('\ud800', '\ud800'),
        issueCodeAwareStructuredProjectionReceipt('\ud801', 'display'))
      : issueCodeAwareStructuredProjectionReceipt('\ud801', 'display');
    f.source.conclusion = receipt.text;
    const displayCandidate = {...f.delivery.acceptedCandidate, conclusionFingerprint: analysisDeliveryFingerprint(receipt.text)};
    expect(() => issueAuthoredConclusionProtocolProjection({submission: f.handoff, result: f.source,
      nativeCandidate: f.delivery.acceptedCandidate, displayCandidate, bodyProjection: kind === 'forged' ? {...receipt} : receipt}))
      .toThrow('authored_conclusion_projection_mismatch');
  });

  it('accepts an actual issued privacy redaction and rejects later arbitrary display rewrites', () => {
    const f = authoredFixture({parts: ['Visible PRIVATE_AUTHORED_CANDIDATE.'], project: false});
    registerCodeAwareCanary(f.source.sessionId, 'PRIVATE_AUTHORED_CANDIDATE');
    try {
      const projected = finalizeSourceAwareAnalysisResultWithProjection(f.source, undefined,
        {context: f.delivery, authoredSubmission: f.handoff});
      const token = projected.protocolProjection!;
      expect(f.source.conclusion).not.toContain('PRIVATE_AUTHORED_CANDIDATE');
      expect(hasCurrentAuthoredFinalDelivery(f.source, projected.deliveryContext!)).toBe(true);
      f.source.conclusion += 'unauthorized rewrite';
      expect(hasCurrentAuthoredFinalDelivery(f.source, projected.deliveryContext!)).toBe(false);
      releaseConclusionProtocolProjection(token);
    } finally {f.cleanup();}
  });

  it.each(['normal_cleanup', 'cancel', 'dispose', 'forged_declaration'] as const)('preserves current-run authority at %s', action => {
    const f = authoredFixture();
    try {
      const native = f.read();
      if (action === 'normal_cleanup') f.live.attempt = false;
      if (action === 'cancel') f.live.active = false;
      if (action === 'dispose') releaseConclusionProtocolProjection(f.token!);
      if (action === 'normal_cleanup') {
        expect(f.read()).toBe(native);
        expect(hasCurrentAuthoredFinalBody(f.source.conclusion, f.context)).toBe(true);
      } else if (action === 'forged_declaration') {
        expect(() => canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: {...native}}))
          .toThrow('unissued_native_conclusion_declaration');
      } else {
        expect(() => f.read()).toThrow();
        expect(hasCurrentAuthoredFinalDelivery(f.source, f.context)).toBe(false);
      }
    } finally {f.cleanup();}
  });

  it('retains invalid original entries and never derives a replacement contract from the literal body', () => {
    const payload = {...declaration(), claims: [authoredNumeric(), {id: 'bad', text: 'Keep invalid.', kind: 'numeric', semantics: false}]};
    const f = authoredFixture({payload, parts: [{claimText: 'bad'}]});
    try {
      const native = f.read();
      const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: native});
      expect(canonical.protocolDiagnostics?.typedJson?.rawPayload).toEqual(payload);
      expect(canonical.validationContract?.claims).toHaveLength(2);
      expect(canonical.validationContract?.claims?.[1].valid).toBe(false);
      expect(canonical.result.conclusion).toBe('Keep invalid.');
    } finally {f.cleanup();}
  });

  it('keeps all eight valid kinds, relations, dual-trace references, source bindings and authored stance', () => {
    const claims: any[] = CONCLUSION_PROTOCOL_VALUES.claimKind.map(kind => ({id: kind, kind, text: `${kind}: original.`, references: [],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: `unconfigured.${kind}`, polarity: 'affirmed', discourse: 'asserted',
        quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows', subjectRefs: []}}}));
    claims[claims.findIndex(claim => claim.kind === 'numeric')] = {...authoredNumeric(), id: 'numeric'};
    const comparison = claims.find(claim => claim.kind === 'comparison');
    const subject = authoredNumeric().references[0];
    const object = {...subject, evidenceRefId: 'data:reference', value: 8};
    comparison.references = [subject, object];
    comparison.semantics = {...authoredNumeric().semantics, predicate: 'comparison.delta',
      scope: {population: 'cited_rows', subjectRefs: [subject], objectRefs: [object]}, numeric: {operator: 'eq', value: 2, unit: 'ms'}};
    comparison.relationRefs = ['proposal:delta'];
    const cause = claims.find(claim => claim.kind === 'causal');
    cause.semantics = {...cause.semantics, modality: 'possible', quantifier: 'some',
      conditions: ['Only this stated population; causality not established.']};
    const payload = {...declaration(), claims,
      sourceClaimBindings: [{claimId: 'causal', sourceReferenceIds: ['source:issued'], traceEvidenceRefIds: []}],
      relationProposals: [{schemaVersion: 'evidence_relation_candidate@1', id: 'proposal:delta', kind: 'comparison_delta',
        direction: 'subject_to_object', subject, object, value: 2, unit: 'ms', deltaDirection: 'current_minus_reference'}]};
    const f = authoredFixture({payload, parts: claims.flatMap(claim => [{claimText: claim.id}, '\n'])});
    try {
      expect(f.compiled.canonicalParse.issues).toEqual([]);
      const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: f.read()});
      expect(canonical.protocolDiagnostics?.typedJson?.rawPayload).toEqual(payload);
      expect(canonical.validationContract?.claims?.map(claim => claim.kind)).toEqual(CONCLUSION_PROTOCOL_VALUES.claimKind);
      expect(canonical.validationContract?.relationProposals).toEqual(f.compiled.canonicalParse.contract?.relationProposals);
      expect(canonical.validationContract?.sourceClaimBindings).toEqual(f.compiled.canonicalParse.contract?.sourceClaimBindings);
      expect(canonical.result.conclusion).toBe(claims.map(claim => `${claim.text}\n`).join(''));
    } finally {f.cleanup();}
  });

  it('does not infer a replacement for a root-invalid original, even when body contains a valid sidecar', () => {
    const f = authoredFixture({payload: {...declaration(), mode: 'invented'}, parts: [renderConclusionContractSidecar(declaration())]});
    try {
      const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: f.read()});
      expect(canonical.bindingEligibility).toBe('ineligible');
      expect(canonical.validationContract).toBeUndefined();
      expect(canonical.result.conclusionContract).toBeUndefined();
      expect(canonical.result.conclusion).toBe(f.compiled.body);
    } finally {f.cleanup();}
  });

  it('preserves Infinity, negative zero and invalid originals through both private consumer snapshots', () => {
    const payload = {...declaration(), claims: [authoredNumeric(), {id: 'bad', text: 'Invalid original.', kind: 'numeric', semantics: false}],
      overflow: 0, negativeZero: 0};
    const raw = JSON.stringify({representationVersion: AUTHORED_CLAIM_DOCUMENT_VERSION, contract: payload,
      bodyParts: [{claimText: 'bad'}]}).replace('"overflow":0', '"overflow":1e999').replace('"negativeZero":0', '"negativeZero":-0');
    const f = authoredFixture({raw});
    try {
      const native = f.read();
      if (native.inputKind !== 'model_tool_arguments') throw new Error('Unexpected legacy declaration');
      expect((native.rawCanonicalPayload as any).overflow).toBe(Infinity);
      expect(Object.is((native.rawCanonicalPayload as any).negativeZero, -0)).toBe(true);
      const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: native});
      const selected = canonical.protocolDiagnostics?.typedJson?.rawPayload as any;
      expect(selected.overflow).toBe(Infinity);
      expect(Object.is(selected.negativeZero, -0)).toBe(true);
      expect(selected.claims[1].semantics).toBe(false);
    } finally {f.cleanup();}
  });

  it.each(['asserted_value', 'reference_value', 'unit', 'unauthorized', 'unknown_unit', 'empty', 'partial'] as const)
  ('never turns %s into a proof through the authored consumer path', async failure => {
    const claim = authoredNumeric();
    if (failure === 'asserted_value') claim.semantics.numeric.value = 11;
    if (failure === 'reference_value') claim.references[0].value = 11;
    if (failure === 'unit') claim.semantics.numeric.unit = 'count';
    const f = authoredFixture({payload: {...declaration(), claims: [claim]}});
    try {
      const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: f.read()});
      const store = new ArtifactStore();
      const data = {columns: ['dur_ms'], rows: failure === 'empty' ? [] : [[10]]};
      const origin = {kind: 'skill_literal' as const, skillId: 'fixture', stepId: 'root',
        definitionFingerprint: 'a'.repeat(64), selectedSqlHash: 'b'.repeat(64)};
      const witness = captureEvidenceTable(data, failure === 'unknown_unit' ? {} : {dur_ms: {unit: 'ms', origin}});
      const artifact = store.store({skillId: 'fixture', data, sourceToolCallId: 'invoke:duration',
        traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'current', traceSide: 'current'})});
      expect(store.registerEvidenceCapture(artifact, witness, {evidenceRefId: 'data:duration'})).toBe(true);
      const prepared = await prepareClaimEvidence({conclusionContract: canonical.validationContract,
        bindingEligibility: canonical.bindingEligibility,
        evidenceReadView: failure === 'partial'
          ? {resolveReferences: async requests => requests.map(request => ({key: request.key,
            status: 'incomplete' as const, reason: 'deadline_exceeded' as const}))}
          : store.createEvidenceReadView({ownerKey: 'run-a', allowedTraces: failure === 'unauthorized' ? []
            : [{traceId: 'current', traceSide: 'current'}]})});
      const verified = runClaimVerification({conclusionContract: canonical.validationContract, preparedEvidence: prepared});
      expect(verified.claimVerificationResult.claimResults[0].deterministicProof?.status).not.toBe('proved');
      expect(canonical.protocolDiagnostics?.typedJson?.rawPayload).toEqual(f.compiled.rawCanonicalPayload);
      expect(canonical.result.conclusion).toBe(f.compiled.body);
    } finally {f.cleanup();}
  });

  it('retains historical origin as provenance without restoring private authority', () => {
    const f = authoredFixture();
    try {
      const copy = JSON.parse(JSON.stringify(f.source));
      expect(copyAnalysisDeliveryFields(copy).outputOrigin).toBe('model_tool_arguments');
      const historical = canonicalizeAnalysisResult(copy, {context: {entry: 'historical_restore'}});
      expect(historical.result.outputOrigin).toBe('model_tool_arguments');
      expect(hasCurrentAuthoredFinalDelivery(copy, historical.deliveryContext!)).toBe(false);
    } finally {f.cleanup();}
  });

  it.each(['missing_submission', 'transport_failure'] as const)('keeps native completion and refuses old continuation for %s', outcome => {
    const source = result('Ordinary naturally completed assistant text.');
    const context = contextFor(source);
    context.finalSubmission = {mode: 'authored_claim_document_v1', outcome};
    const originalCompletion = {...context.completion!};
    const assessed = assessFinalResultQualityAssessment({result: source, query: 'q', context});
    expect(assessed.assurance.completion).toBe('failed');
    expect(assessed.issues.some(issue => issue.code === outcome)).toBe(true);
    expect(context.completion).toEqual(originalCompletion);
    expect(context.outputOrigin).toBe('sdk_final');
    return verifyConclusion([], '', {deliveryContext: {...context, acceptedCandidate: {...context.acceptedCandidate,
      conclusionFingerprint: analysisDeliveryFingerprint('')}, completion: {...context.completion!,
      conclusionFingerprint: analysisDeliveryFingerprint('')}}}).then(verified => {
      expect(verified.heuristicIssues.every(issue => issue.recoveryKind !== 'continue_output')).toBe(true);
    });
  });

  it('does not promote a submitted metadata flag without its live private binding', () => {
    const source = result('Forged metadata only.');
    const context = contextFor(source);
    context.finalSubmission = {mode: 'authored_claim_document_v1', outcome: 'submitted'};
    expect(assessFinalResultQualityAssessment({result: source, query: 'q', context}).assurance.completion).toBe('failed');
  });

  it.each(['completed', 'replaced_before_finalization', 'replaced_during_review'] as const)
  ('keeps typed proof and the outer finalization owner boundary: %s', async lifetime => {
    const f = authoredFixture();
    let ownerCurrent = true;
    let reviewCalls = 0;
    const store = new ArtifactStore();
    const data = {columns: ['dur_ms'], rows: [[10]]};
    const witness = captureEvidenceTable(data, {dur_ms: {unit: 'ms', origin: {kind: 'skill_literal',
      skillId: 'fixture', stepId: 'root', definitionFingerprint: 'a'.repeat(64), selectedSqlHash: 'b'.repeat(64)}}});
    const artifact = store.store({skillId: 'fixture', data, sourceToolCallId: 'invoke:duration',
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'current', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(artifact, witness, {evidenceRefId: 'data:duration'})).toBe(true);
    const readView = store.createEvidenceReadView({ownerKey: 'run-a', allowedTraces: [{traceId: 'current', traceSide: 'current'}]});
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'authored-finalization'});
    const intent = {...f.context.turnIntent!, registryFingerprint: registry.registryFingerprint};
    f.context.turnIntent = intent;
    attachFinalizationContext(f.source, {sessionId: f.source.sessionId, runId: 'run-a', deadlineMs: Date.now() + 600_000,
      turnIntent: intent, strategyRegistry: registry, traceIdentity: {currentTraceId: 'current'}, deliveryContext: f.context,
      protocolProjection: f.token, evidenceReadView: readView,
      dispatchText: async () => {
        reviewCalls++;
        await Promise.resolve();
        if (lifetime === 'replaced_during_review') ownerCurrent = false;
        return {status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@4',
        bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: f.source.conclusion.length}]},
        claims: [{claimId: 'duration', consistency: 'consistent', contentLocations: [{text: '10 ms', occurrence: 1},
          {text: '10 ms', occurrence: 2}], issues: []}], omissions: [], requirements: [], investigation: []})};
      }});
    const context = takeFinalizationContext(f.source)!;
    f.live.attempt = false;
    const native = context.getNativeDeclaration(f.source, new AbortController().signal)!;
    const canonical = canonicalizeAnalysisResult(f.source, {context: context.deliveryContext, nativeDeclaration: native});
    const prepared = await prepareClaimEvidence({conclusionContract: canonical.validationContract,
      bindingEligibility: canonical.bindingEligibility, evidenceReadView: readView});
    const verified = runClaimVerification({conclusionContract: canonical.validationContract, preparedEvidence: prepared});
    expect(verified.claimVerificationResult.claimResults[0].deterministicProof?.status).toBe('proved');
    const presentation = assessNumericPresentations({contract: canonical.validationContract,
      claims: verified.claimVerificationResult.claimResults, support: verified.claimSupport,
      body: canonical.result.conclusion, candidate: canonical.projection.candidate!}).get('duration');
    expect(presentation).toMatchObject({status: 'matched', locations: [
      {start: f.compiled.occurrences[0].startUtf16, end: f.compiled.occurrences[0].endUtf16},
      {start: f.compiled.occurrences[1].startUtf16, end: f.compiled.occurrences[1].endUtf16}]});
    if (lifetime === 'replaced_before_finalization') ownerCurrent = false;
    // A settled runtime lease does not detect successors; the actual product owner does.
    expect(readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input).compiled.body).toBe(f.compiled.body);
    const finalizing = finalizeAnalysisResult({result: f.source, context, query: 'Measured duration',
      owner: {runId: 'run-a', signal: new AbortController().signal, isCurrent: () => ownerCurrent, assertAuthorized: () => {}}});
    if (lifetime !== 'completed') {
      await expect(finalizing).rejects.toThrow('Analysis run is no longer current');
      expect(reviewCalls).toBe(lifetime === 'replaced_before_finalization' ? 0 : 1);
      expect(() => readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input)).toThrow('authored_final_submission_invalid');
      expect(() => context.getNativeDeclaration(f.source, new AbortController().signal)).toThrow();
      f.cleanup();
      return;
    }
    const final = await finalizing;
    expect(reviewCalls).toBe(1);
    expect(final.result.conclusion).toBe(f.compiled.body);
    expect(final.result.outputOrigin).toBe('model_tool_arguments');
    expect(final.result.deliveryAssurance?.completion).toBe('passed');
    expect(final.result.claimVerificationResult?.claimResults[0].deterministicProof?.status).toBe('proved');
    expect({status: final.result.claimVerificationResult?.claimResults[0].status,
      reason: final.semanticAssessment?.reason, detail: final.semanticAssessment?.notCheckedDetail})
      .toEqual({status: 'verified', reason: undefined, detail: undefined});
    expect(() => readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input)).toThrow('authored_final_submission_invalid');
    f.cleanup();
  });
});

describe('authoring wire and canonical privacy boundaries', () => {
  const authoring = (invalidReference = false) => {
    const full = declaration(33);
    const reference = {...full.claims![0].references[0], ...(invalidReference ? {unrecognized: 'PRIVATE_AUTHORING_RAW'} : {})};
    return {authoringVersion: 'conclusion_authoring@1', referenceDictionary: [reference],
      contract: {...full, claims: [{...full.claims![0], references: [{$ref: 0}]}]}};
  };

  it('retains v2 raw syntax privately while projecting compiled canonical material with unchanged proof state', () => {
    const raw = {authoringVersion: 'conclusion_authoring@2', referenceDictionary: [], contract: {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', claims: declaration(33).claims,
      uncertainties: [{text: '未证明因果。'}], nextSteps: [{text: '检查覆盖范围。'}]}};
    const native = `Body remains.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw), 'authoring_v2')}`;
    const source = result(native);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.protocolDiagnostics?.sidecar.rawPayload).toEqual(raw);
    expect(conclusionDeclarationValidationPayload(canonical.protocolDiagnostics?.sidecar)).toEqual({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', claims: declaration(33).claims,
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: ['未证明因果。'], nextSteps: ['检查覆盖范围。']});
    expect(canonical.result.conclusionContract?.claims?.[0]).not.toHaveProperty('verified');
    const projected = projectConclusionProtocol(undefined, native).text;
    expect(projected).not.toContain('referenceDictionary');
    expect(projected).not.toContain('conclusion_authoring@2');
    expect(projected).toContain('Body remains.');
  });

  it.each([false, true])('retains original wire and expanded invalid data privately (invalid=%s)', invalid => {
    const raw = authoring(invalid);
    const native = `Body remains.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw))}`;
    const source = result(native);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.protocolDiagnostics?.sidecar.rawPayload).toEqual(raw);
    expect(conclusionDeclarationValidationPayload(canonical.protocolDiagnostics?.sidecar)).toMatchObject({
      claims: [{references: [raw.referenceDictionary[0]]}],
    });
    expect(canonical.result.conclusion).toContain('Body remains.');
    expect(JSON.stringify(canonical.result)).not.toContain('referenceDictionary');
    expect(JSON.stringify(canonical.result)).not.toContain('PRIVATE_AUTHORING_RAW');
    if (invalid) {
      expect(canonical.validationContract?.claims?.[0].rawReferences).toEqual(raw.referenceDictionary);
      expect(canonical.validationContract?.claims?.[0].valid).toBe(false);
    } else {
      expect(canonical.result.conclusionContract?.claims?.[0].references).toEqual(raw.referenceDictionary);
    }
    const projected = projectConclusionProtocol(undefined, native).text;
    expect(projected).not.toContain('referenceDictionary');
    expect(projected).not.toContain('PRIVATE_AUTHORING_RAW');
    expect(projected).not.toContain('smartperfetto-conclusion-authoring');
  });

  it('keeps decode failure ineligible instead of deriving replacement claims from prose', () => {
    const raw = {...authoring(), referenceDictionary: {bad: 'PRIVATE_AUTHORING_BAD_DICTIONARY'}};
    const source = result(`Body remains.\n${wrapConclusionAuthoringPayload(JSON.stringify(raw))}`);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.bindingEligibility).toBe('ineligible');
    expect(canonical.validationContract).toBeUndefined();
    expect(canonical.result.conclusionContract).toBeUndefined();
    expect(canonical.protocolDiagnostics?.sidecar.rawPayload).toEqual(raw);
    expect(conclusionDeclarationValidationPayload(canonical.protocolDiagnostics?.sidecar)).toBeUndefined();
    expect(JSON.stringify(canonical.result)).not.toContain('PRIVATE_AUTHORING_BAD_DICTIONARY');
  });
});

const control = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Which trace?"} -->';

async function proseFixture(attach = true) {
  const marker = 'source_native_prose_marker_unique';
  const prose = (field: string) => `${field}: ${marker}`;
  const contract: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [{rank: 1, statement: prose('statement'), trigger: prose('trigger'), supply: prose('supply'), amplification: prose('amplification')}],
    clusters: [{cluster: prose('cluster'), description: prose('description')}],
    evidenceChain: [{conclusionId: 'C1', text: prose('evidence')}], uncertainties: [prose('uncertainty')], nextSteps: [prose('next')],
    claims: [{id: 'c1', conclusionId: 'C1', kind: 'inference', text: prose('claim'), references: [],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'source.prose', polarity: 'affirmed', discourse: 'asserted',
        quantifier: 'one', modality: 'possible', conditions: [prose('condition')], scope: {population: 'codebase'}}}]};
  const source = result(`Visible ${marker}.\n${renderConclusionContractSidecar(contract)}`);
  registerOnDemandSourceLookupForEcho(source.sessionId, [{id: 'prose-read', codebaseId: 'cb-prose',
    filePath: 'src/Prose.kt', lineRange: {start: 1, end: 1}, text: `val marker = "${marker}"`}]);
  const projected = finalizeSourceAwareAnalysisResultWithProjection(source, undefined, {context: contextFor(source)});
  const token = projected.protocolProjection!;
  if (attach) claimConclusionProtocolProjection(token);
  if (!projected.deliveryContext || projected.deliveryContext.entry === 'historical_restore') throw new Error('Unexpected fixture entry');
  const native = readConclusionProtocolProjection(token, {result: source,
    candidate: projected.deliveryContext.acceptedCandidate, runId: 'run-a'});
  const canonical = canonicalizeAnalysisResult(source, {context: projected.deliveryContext, nativeDeclaration: native});
  const prepared = await prepareClaimEvidence({conclusionContract: canonical.validationContract, bindingEligibility: canonical.bindingEligibility});
  const input = {sessionId: source.sessionId, nativeDeclaration: native, canonicalProjection: canonical.projection,
    canonicalCandidate: canonical.projection.candidate!, runId: 'run-a', prepared,
    snapshot: {inputCoverage: 'complete' as const, declarationBindingEligibility: canonical.bindingEligibility,
      query: 'Review these declarations', body: canonical.result.conclusion,
      conclusionContract: structuredClone(canonical.validationContract), evidenceSnapshot: preparedClaimEvidenceSnapshot(prepared)}};
  return {input, marker, source, canonical, token,
    cleanup: () => {releaseConclusionProtocolProjection(token); clearCodeAwareOutputGuards(source.sessionId);}};
}

describe('exact native prose semantic input receipt', () => {
  it('restores only the exact issued selection and fails closed on protected metadata', async () => {
    const target = await proseFixture();
    const selection = {present: true as const, kind: 'track_event' as const,
      context: {kind: 'track_event' as const, eventId: 7, ts: 42, trackUri: 'track://ordinary'},
      sideResolution: {status: 'unknown' as const}};
    try {
      const input: Parameters<typeof projectConclusionSemanticInput>[0] = {...target.input,
        snapshot: {...target.input.snapshot, selectionScope: selection}};
      const exact = withOwnerCodeAwareProjection(() => projectConclusionSemanticInput({...input,
        providerSelection: selection}));
      expect(exact.changed).toBe(false);
      expect(exact.value.selectionScope).toEqual(selection);

      const mismatch = withOwnerCodeAwareProjection(() => projectConclusionSemanticInput({...input,
        providerSelection: {...selection, context: {...selection.context, eventId: 8}}}));
      expect(mismatch.changed).toBe(true);
      expect(mismatch.value.selectionScope).toBeUndefined();

      registerCodeAwareCanary(target.input.sessionId, 'SELECTION_CANARY');
      input.snapshot.selectionScope = {...selection,
        context: {...selection.context, trackUri: 'track://SELECTION_CANARY'}};
      const protectedInput = withOwnerCodeAwareProjection(() => projectConclusionSemanticInput({...input,
        providerSelection: input.snapshot.selectionScope}));
      expect(protectedInput.changed).toBe(true);
      expect(JSON.stringify(protectedInput.value)).not.toContain('SELECTION_CANARY');
    } finally {target.cleanup();}
  });

  it('restores only original declaration fields while keeping the actual display body and receipt private', async () => {
    const target = await proseFixture();
    try {
      const projected = projectConclusionSemanticInput(target.input);
      expect(projected.changed).toBe(false);
      const {parseIssues: _issues, ...expected} = target.input.snapshot.conclusionContract!;
      expect(projected.value.conclusionContract).toEqual(expected);
      expect(projected.value.body).toBe(target.canonical.result.conclusion);
      expect(projected.value.body).not.toContain(target.marker);
      expect(JSON.stringify(target.canonical.projection)).not.toContain(target.marker);
      expect(JSON.stringify(target.canonical.result)).not.toContain(target.marker);
    } finally {target.cleanup();}
  });

  it.each(['copy', 'absent', 'session', 'run', 'attempt', 'candidate', 'body', 'native', 'released', 'unattached', 'historical'] as const)(
    'grants no prose role after a changed %s identity', async kind => {
      const target = await proseFixture(kind !== 'unattached');
      try {
        const input = {...target.input, snapshot: structuredClone(target.input.snapshot)};
        if (kind === 'copy') input.canonicalProjection = {...input.canonicalProjection};
        if (kind === 'absent') delete (input as Partial<typeof input>).canonicalProjection;
        if (kind === 'session') input.sessionId = 'other-session';
        if (kind === 'run') input.runId = 'other-run';
        if (kind === 'attempt') input.canonicalCandidate = {...input.canonicalCandidate, attemptId: 'other-attempt'};
        if (kind === 'candidate') input.canonicalCandidate = {...input.canonicalCandidate, candidateRef: 'other-candidate'};
        if (kind === 'body') {input.snapshot.body += ' changed'; input.canonicalCandidate = {...input.canonicalCandidate,
          conclusionFingerprint: analysisDeliveryFingerprint(input.snapshot.body)};}
        if (kind === 'native') input.nativeDeclaration = {...input.nativeDeclaration};
        if (kind === 'released') releaseConclusionProtocolProjection(target.token);
        if (kind === 'historical') input.canonicalProjection = canonicalizeAnalysisResult(target.source,
          {context: {entry: 'historical_restore'}}).projection;
        if (kind === 'session') registerOnDemandSourceLookupForEcho(input.sessionId, [{id: 'other-read',
          codebaseId: 'other', filePath: 'Other.kt', text: target.marker}]);
        const projected = projectConclusionSemanticInput(input);
        expect(projected.changed).toBe(true);
        expect(JSON.stringify(projected.value.conclusionContract)).not.toContain(target.marker);
      } finally {clearCodeAwareOutputGuards('other-session'); target.cleanup();}
    });

  it.each(['text', 'claim_id', 'kind', 'presence', 'rank', 'cluster', 'conclusion_id', 'moved', 'substring'] as const)(
    'does not restore original prose under changed %s fields', async kind => {
      const target = await proseFixture();
      try {
        const contract = target.input.snapshot.conclusionContract!;
        const claim = contract.claims![0];
        if (kind === 'text') claim.text += ' added';
        if (kind === 'claim_id') claim.id = 'other-claim';
        if (kind === 'kind') claim.kind = 'identity';
        if (kind === 'presence') delete claim.conclusionId;
        if (kind === 'rank') contract.conclusions[0].rank = 2;
        if (kind === 'cluster') contract.clusters[0].cluster += ' changed';
        if (kind === 'conclusion_id') contract.evidenceChain[0].conclusionId = 'C2';
        if (kind === 'moved') [contract.uncertainties[0], contract.nextSteps[0]] = [contract.nextSteps[0], contract.uncertainties[0]];
        if (kind === 'substring') claim.text = target.marker;
        expect(projectConclusionSemanticInput(target.input).changed).toBe(true);
      } finally {target.cleanup();}
    });

  it.each(['canary', 'private_query', 'revoked', 'claim_key', 'parent_key', 'statement_key'] as const)(
    'keeps %s stronger than exact native prose permissions', async kind => {
      const target = await proseFixture();
      try {
        if (kind === 'canary') registerCodeAwareCanary(target.input.sessionId, target.marker);
        if (kind === 'private_query') registerPrivateAnalysisQueryForEcho(target.input.sessionId, target.marker);
        if (kind === 'revoked') revokeCodeAwareOutputGuards(target.input.sessionId);
        if (kind === 'claim_key') registerCodeAwareCanary(target.input.sessionId, 'text');
        if (kind === 'parent_key') registerCodeAwareCanary(target.input.sessionId, 'claims');
        if (kind === 'statement_key') registerCodeAwareCanary(target.input.sessionId, 'statement');
        const projected = projectConclusionSemanticInput(target.input);
        expect(projected.changed).toBe(true);
        if (kind === 'claim_key') expect(projected.value.conclusionContract?.claims?.[0]).not.toHaveProperty('text');
        else if (kind === 'parent_key') expect(projected.value.conclusionContract).not.toHaveProperty('claims');
        else if (kind === 'statement_key') expect(projected.value.conclusionContract?.conclusions?.[0]).not.toHaveProperty('statement');
        else expect(JSON.stringify(projected.value)).not.toContain(target.marker);
      } finally {target.cleanup();}
    });
});

describe('canonical analysis result projection', () => {
  it('quarantines a malformed reserved declaration without supplying claims or authorizing its raw payload', () => {
    const payload = declaration();
    const raw = `Visible body.\n<!-- smartperfetto:conclusion_contract@1\n${JSON.stringify(payload)}\n-->`;
    const source = result(raw);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe('Visible body.\n');
    expect(canonical.bindingEligibility).toBe('ineligible');
    expect(canonical.validationContract).toBeUndefined();
    expect(canonical.result.conclusionContract).toBeUndefined();
    expect(canonical.result.claimVerificationResult).toBeUndefined();
    expect(inspectCandidateProtocol(source.conclusion).sidecar.rawPayload).toEqual(payload);
    expect(source.conclusion).toBe(raw);
  });

  it('preserves a long final answer and every declared measurement beyond display preview limits', () => {
    const contract = declaration();
    contract.claims = Array.from({length: 240}, (_, index) => ({
      id: `phase-${index}`, kind: 'numeric', text: `Phase ${index} took ${index + 0.125} ms.`,
      references: [{evidenceRefId: 'data:all-phases', rowIndex: index + 1000,
        column: 'duration_ms', value: index + 0.125}],
    }));
    const body = contract.claims.map(claim => `${claim.text} This measurement describes only the cited phase. ` +
      'Overlapping work must not be added to the launch total, and the measurement alone does not establish a cause.\n')
      .join('\n') + '\n| Final phase | Duration (ms) | Source |\n| --- | ---: | --- |\n' +
      '| Tail-only finding | 239.125 | data:all-phases, row 1239 |\n\n' +
      'TAIL_FINDING: The last phase remains independently relevant; its cause is still unknown.';
    expect(body.length).toBeGreaterThan(40_000);
    const source = result(`${body}\n\n${renderConclusionContractSidecar(contract)}`);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});

    expect(canonical.result.conclusion).toBe(`${body}\n\n`);
    expect(canonical.result.conclusionContract?.claims).toEqual(contract.claims);
    expect(canonical.validationContract?.claims).toEqual(contract.claims);
    expect(canonical.result.claimVerificationResult).toBeUndefined();
    expect(source.conclusion).toContain(renderConclusionContractSidecar(contract));
  });

  it('preserves a final comparison table and its original references while removing only the sidecar', () => {
    const body = [
      '阶段耗时对比如下，机制仍需结合调度证据解释。', '',
      '| 阶段 | 基线（ms） | 对比（ms） | 来源 |',
      '| --- | ---: | ---: | --- |',
      '| `bind\\|Application` | 120 | 200 | 两侧启动阶段原始记录 |', '',
      '比例分母和因果关系尚未核验，不从这张表推断根因。',
    ].join('\n');
    const contract = declaration(120);
    contract.claims![0].references[0] = {evidenceRefId: 'data:baseline', rowIndex: 900, column: 'duration_ms', value: 120};
    contract.claims!.push({...contract.claims![0], id: 'comparison-duration', text: 'Comparison duration is 200 ms.',
      references: [{evidenceRefId: 'data:comparison', rowIndex: 901, column: 'duration_ms', value: 200}]});
    const source = result(`${body}\n\n${renderConclusionContractSidecar(contract)}`);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(`${body}\n\n`);
    expect(canonical.validationContract?.claims?.map(claim => claim.references))
      .toEqual(contract.claims!.map(claim => claim.references));
    expect(canonical.result.conclusion).not.toContain('conclusion_contract_v1');
  });

  it('uses the same protocol inspection for native diagnostics and canonical narrative', () => {
    const raw = `Visible body\n${renderConclusionContractSidecar(declaration())}`;
    const inspected = inspectCandidateProtocol(raw);
    expect(inspected.canonicalBody).toBe(canonicalizeAnalysisResult(result(raw)).result.conclusion);
    expect(buildCandidateProtocolDiagnostic(inspected, 'native', 1)).toMatchObject({
      status: 'valid', sidecarStatus: 'valid', typedJsonStatus: 'not_checked', canonicalChars: 12,
      projectionKind: 'protocol_projection', issueCodes: [], issueCount: 0,
    });
    const onlySidecar = inspectCandidateProtocol(renderConclusionContractSidecar(declaration()));
    expect(buildCandidateProtocolDiagnostic(onlySidecar, 'native', 1)).toMatchObject({status: 'valid', canonicalChars: 0});
  });

  it.each([
    ['marker', 'not_exact', 2, (text: string) => text.replace('contract@1', 'contract@2 PRIVATE_FRAMING_CANARY')],
    ['opening_fence', 'not_exact', 3, (text: string) => text.replace('```json', '```JSON PRIVATE_FRAMING_CANARY')],
    ['closing_fence', 'not_exact', 5, (text: string) => text.replace('\n```\n-->', '\n``` \n-->')],
    ['terminator', 'missing', 2, (text: string) => text.replace('\n-->', '')],
    ['comment', 'noncanonical', 2, (text: string) => text.replace('contract@1', 'declaration').replace('```json\n', '').replace('\n```', '')],
    ['payload', 'embedded_terminator', 4, (text: string) => text.replace('Measured duration is', '--> PRIVATE_FRAMING_CANARY Measured duration is')],
  ])('locates %s without publishing native framing text', (field, reason, line, mutate) => {
    const raw = `Body PRIVATE_FRAMING_CANARY\n${(mutate as (text: string) => string)(wrapConclusionContractSidecarPayload(JSON.stringify(declaration())))}`;
    const inspected = inspectCandidateProtocol(raw);
    const diagnostic = buildCandidateProtocolDiagnostic(inspected, 'native', 1);
    expect(diagnostic).toMatchObject({status: 'invalid', issueCodes: ['invalid_framing'],
      framingDiagnostic: {field, reason, line}});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_FRAMING_CANARY');
    expect(inspected.sidecar.bindingEligibility).toBe('ineligible');
    expect(inspectCandidateProtocol(raw)).toEqual(inspected);
    const old = {...diagnostic};
    delete old.framingDiagnostic;
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('rejects forged framing facts, private fields and impossible positions', () => {
    const raw = `Body\n${renderConclusionContractSidecar(declaration()).replace('```json', '```JSON')}`;
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    const detail = diagnostic.framingDiagnostic!;
    for (const framingDiagnostic of [null, {}, {...detail, field: 'PRIVATE_PATH'}, {...detail, reason: 'missing'},
      {...detail, line: 0}, {...detail, line: 1.5}, {...detail, line: raw.length + 2},
      {...detail, source: 'PRIVATE_SOURCE'}, {...detail, text: 'PRIVATE_VALUE'}]) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, framingDiagnostic})).toBeUndefined();
    }
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, status: 'valid'})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, sidecarStatus: 'absent'})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_json']})).toBeUndefined();
    const valid = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(renderConclusionContractSidecar(declaration())), 'native', 1);
    expect(valid).not.toHaveProperty('framingDiagnostic');
  });

  it('distinguishes valid native declarations from a later malformed projected declaration without disclosing text', () => {
    const raw = `Body PRIVATE_DIAGNOSTIC_CANARY\n${renderConclusionContractSidecar(declaration())}`;
    const changed = raw.replace('"focused_answer"', '"PRIVATE_DIAGNOSTIC_CANARY"');
    const native = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    const projected = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(changed), 'runtime_projected', 1, 'redacted');
    expect(native.status).toBe('valid');
    expect(projected).toMatchObject({status: 'invalid', projectionKind: 'redacted', issueCodes: ['invalid_contract']});
    expect(sanitizeCandidateProtocolDiagnostic(projected)).toEqual(projected);
    expect(JSON.stringify([native, projected])).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    expect(projected).toMatchObject({claimCount: 1, semanticClaimCount: 0, sourceBindingCount: 0, status: 'invalid'});
  });

  it('records declared claim/semantic/binding counts without treating them as valid evidence', () => {
    const original = {...declaration(), claims: [
      {id: 'one', text: 'A hypothetical statement.', kind: 'inference', references: [], semantics: {
        schemaVersion: 'claim_semantics@1', predicate: 'example.hypothesis', polarity: 'affirmed',
        discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'codebase'},
      }},
      {id: 'two', text: 'An unchecked statement.', kind: 'inference', references: []},
    ], sourceClaimBindings: [{invalid: 'PRIVATE_DIAGNOSTIC_CANARY'}, {alsoInvalid: true}]};
    const inspect = (payload: unknown) => inspectCandidateProtocol(
      `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n-->`);
    const native = buildCandidateProtocolDiagnostic(inspect(original), 'native', 1);
    expect(native).toMatchObject({claimCount: 2, semanticClaimCount: 1, sourceBindingCount: 2});
    expect(sanitizeCandidateProtocolDiagnostic(native)).toEqual(native);
    const projected = buildCandidateProtocolDiagnostic(inspect({...original, sourceClaimBindings: []}), 'runtime_projected', 1);
    expect(projected).toMatchObject({claimCount: 2, semanticClaimCount: 1, sourceBindingCount: 0});
    expect(JSON.stringify([native, projected])).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    const old = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('Body'), 'native', 1);
    expect(old).not.toHaveProperty('claimCount');
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('projects only fixed root structure facts and raw declaration entry counts for an invalid shell', () => {
    const raw = renderConclusionContractSidecar({...declaration(), mode: 'PRIVATE_STRUCTURE_CANARY'} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic).toMatchObject({status: 'invalid', issueCount: 1, claimCount: 1, semanticClaimCount: 0,
      sourceBindingCount: 0, details: [{field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'}]});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it('rejects duplicate, excessive, unknown or impossible structure detail combinations while accepting old diagnostics', () => {
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(
      renderConclusionContractSidecar({...declaration(), mode: 'bad'} as any)), 'native', 1);
    const detail = {field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'};
    for (const details of [[detail, detail], Array(25).fill(detail), [null],
      [{...detail, field: '/private/source'}], [{...detail, actual: 'PRIVATE_STRUCTURE_CANARY'}],
      [{...detail, expected: 'string'}], [{...detail, reason: 'wrong_type'}],
      [{...detail, field: '$.conclusions[].rank', expected: 'finite_number'}],
      [{...detail, field: '$', expected: 'object', actual: 'missing', reason: 'missing_required'}],
      [{...detail, raw: 'PRIVATE_STRUCTURE_CANARY'}]]) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details})).toBeUndefined();
    }
    const uniqueDetails = ['$', '$.conclusions[]', '$.clusters[]', '$.evidenceChain[]'].flatMap(field =>
      ['null', 'array', 'string', 'number', 'boolean', 'undefined', 'other', 'nonfinite_number'].map(actual =>
        ({field, expected: 'object', actual, reason: 'wrong_type'})));
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details: uniqueDetails.slice(0, 24)})).toBeDefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details: uniqueDetails.slice(0, 25)})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_reference'], details: [detail]})).toBeUndefined();
    const {details: _details, ...old} = diagnostic;
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('projects bounded relation failures without retaining raw keys, values, IDs or source text', () => {
    const raw = renderConclusionContractSidecar({...declaration(), relationProposals: [{
      schemaVersion: 'evidence_relation_candidate@1', id: 'PRIVATE_RELATION_ID_CANARY', kind: 'overlap',
      direction: 'symmetric', subject: {sourceRef: 'PRIVATE_RELATION_SOURCE_CANARY'},
      PRIVATE_RELATION_KEY_CANARY: 'PRIVATE_RELATION_VALUE_CANARY',
    }]} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    // A single invalid proposal item is item-scoped (plan A.1): partially valid.
    expect(diagnostic).toMatchObject({status: 'partially_valid', issueCodes: ['invalid_relation_proposal'], issueCount: 1,
      relationProposalDiagnostics: [{scope: 'item', ordinal: 1, reason: 'unknown_field'}]});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_RELATION_');
  });

  it('locates failing claims by position and schema field so one repair can find them, even past claim 24', () => {
    const semantics = {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
      discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows'}};
    const claim = (index: number) => ({id: `claim-${index}`, kind: 'numeric', text: `Claim ${index}.`, references: [], semantics});
    const claims: any[] = Array.from({length: 31}, (_, index) => claim(index + 1));
    claims[1] = {...claim(2), semantics: {...semantics, scope: {population: 'PRIVATE_POPULATION_CANARY'}}};
    claims[2] = {...claim(3), id: 'claim-1'};
    claims[3] = {...claim(4), artifactRefs: 'PRIVATE_REF_CANARY'};
    claims[29] = {...claim(30), semantics: {...semantics, predicate: 'has whitespace', PRIVATE_KEY_CANARY: 1}};
    const raw = renderConclusionContractSidecar({...declaration(), claims} as any);
    const inspected = inspectCandidateProtocol(raw);
    const diagnostic = buildCandidateProtocolDiagnostic(inspected, 'native', 1);
    expect(diagnostic.claimDiagnostics).toEqual([
      {ordinal: 2, code: 'invalid_semantics', field: 'semantics.scope.population'},
      {ordinal: 3, code: 'duplicate_claim_id', field: 'id'},
      {ordinal: 4, code: 'invalid_reference', field: 'artifactRefs'},
      {ordinal: 30, code: 'invalid_semantics', field: 'semantics.unknown_field'},
    ]);
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    // Diagnostics ride on the returned issues only; stored claim items keep their own issue shape.
    const stored = inspected.sidecar.contract!.claims!.find(item => item.id === 'claim-2') as any;
    expect(stored.semanticsParseIssues).toEqual([{code: 'invalid_semantics', path: 'claims[1].semantics'}]);
    expect(JSON.stringify(inspected.sidecar.contract!.claims)).not.toContain('claimDiagnostic');
  });

  it('sanitizes claim diagnostics as a bounded collection of pairs a parser can produce', () => {
    const raw = renderConclusionContractSidecar({...declaration(), claims: [
      {...declaration().claims![0], semantics: {schemaVersion: 'other'}}]} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic.claimDiagnostics).toEqual([{ordinal: 1, code: 'invalid_semantics', field: 'semantics.schemaVersion'}]);
    const item = {ordinal: 1, code: 'invalid_semantics', field: 'semantics.predicate'};
    const invalidCollections: unknown[] = [
      [], null, item, [item, item], Array.from({length: 25}, (_, index) => ({...item, ordinal: index + 1})),
      [{...item, field: 'id'}], [{...item, code: 'duplicate_claim_id'}], [{...item, field: 'PRIVATE_FIELD_CANARY'}],
      [{...item, ordinal: 0}], [{...item, ordinal: 1.5}], [{...item, raw: 'PRIVATE_VALUE_CANARY'}],
      [{...item, code: 'invalid_reference', field: 'references'}],
    ];
    for (const claimDiagnostics of invalidCollections) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, claimDiagnostics})).toBeUndefined();
    }
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, claimDiagnostics: [{...item, ordinal: 40}]}))
      .toMatchObject({claimDiagnostics: [{ordinal: 40}]});
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, status: 'valid'})).toBeUndefined();
  });

  it('sanitizes relation diagnostics as a closed bounded discriminated collection', () => {
    const raw = renderConclusionContractSidecar({...declaration(), relationProposals: null} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic.relationProposalDiagnostics).toEqual([
      {scope: 'collection', reason: 'collection_not_array'},
    ]);
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    const item = {scope: 'item', ordinal: 1, reason: 'invalid_id'};
    const invalidCollections: unknown[] = [
      [], null, item, [item, item], Array.from({length: 25}, (_, index) => ({...item,
        ordinal: index % 24 + 1, reason: index === 24 ? 'invalid_kind' : 'invalid_id'})),
      [{...item, scope: 'other'}], [{...item, reason: 'PRIVATE_RELATION_REASON_CANARY'}],
      [{scope: 'item', reason: 'invalid_id'}], [{...item, ordinal: 0}], [{...item, ordinal: 25}],
      [{...item, ordinal: 1.5}], [{...item, raw: 'PRIVATE_RELATION_VALUE_CANARY'}],
      [{scope: 'collection', reason: 'collection_not_array', ordinal: 1}],
      [{scope: 'collection', reason: 'invalid_id'}],
      [{scope: 'collection', reason: 'collection_not_array'}, item],
    ];
    for (const relationProposalDiagnostics of invalidCollections) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, relationProposalDiagnostics})).toBeUndefined();
    }
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, status: 'valid', relationProposalDiagnostics: [item]})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_reference'],
      relationProposalDiagnostics: [item]})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCount: 0,
      relationProposalDiagnostics: [item]})).toBeUndefined();
  });

  it.each(['Ordinary answer', JSON.stringify(declaration())])('keeps ordinary or legacy declarations absent rather than invalid: %s', raw => {
    expect(inspectCandidateProtocol(raw).status).toBe('absent');
  });

  it.each([
    {raw: 'PRIVATE_DIAGNOSTIC_CANARY'}, {path: '/private/source'}, {claimId: 'private-claim'},
    {issueCodes: ['private_failure'], issueCount: 1}, {rawChars: -1}, {canonicalChars: Infinity},
    {issueCount: Number.MAX_SAFE_INTEGER + 1}, {candidateIndex: 3}, {stage: 'model_claim'},
    {claimCount: 1}, {claimCount: 1, semanticClaimCount: 2, sourceBindingCount: 0},
    {claimCount: 1, semanticClaimCount: 1, sourceBindingCount: -1},
  ])('rejects unsafe or malformed diagnostic metadata %j', extra => {
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('Body'), 'native', 1);
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, ...extra})).toBeUndefined();
  });

  it.each(['sidecar_first', 'control_first'] as const)('preserves exact narrative for %s', order => {
    const sidecar = renderConclusionContractSidecar(declaration());
    const blocks = order === 'sidecar_first' ? `${sidecar}\r\n${control}` : `${control}\r\n${sidecar}`;
    const source = result(` \r\nConnection error is trace content.  \r\n${blocks}\r\n \t`);
    const context = contextFor(source);
    const canonical = canonicalizeAnalysisResult(source, {context, conversation: {fallbackQuestion: 'Never the body'}});
    expect(canonical.result.conclusion).toBe(' \r\nConnection error is trace content.  \r\n\r\n\r\n \t');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which trace?',
      message: canonical.result.conclusion});
    expect(canonical.result.conclusionContract?.claims).toEqual(declaration().claims);
    expect(canonical.projection.disposition).toBe('protocol_projection');
    expect(canonical.result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(canonical.result.conclusion));
    expect(canonical.result.completion?.status).toBe('completed');
    expect(source.conclusion).toContain(sidecar);
    expect(JSON.stringify(canonical.result)).not.toContain(canonical.projection.inputFingerprint);
    expect(canonical.result).not.toHaveProperty('projection');
    expect(canonical.result).not.toHaveProperty('protocolDiagnostics');
  });

  it('leaves pure control questions outside the body so the empty gate can reject delivery', () => {
    const source = result(control);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source),
      conversation: {fallbackQuestion: 'Fallback question'}});
    expect(canonical.result.conclusion).toBe('');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which trace?', message: ''});
    expect(assessFinalResultQualityAssessment({result: canonical.result, context: canonical.deliveryContext}).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({code: 'empty_conclusion'})]));
  });

  it('removes all duplicate terminal control segments without applying the final one', () => {
    const answered = '<!-- smartperfetto:conversation-control {"kind":"answered"} -->';
    const canonical = canonicalizeAnalysisResult(result(`Body\n${answered}\n${control}`),
      {conversation: {fallbackQuestion: 'Fallback'}});
    expect(canonical.result.conclusion).toBe('Body\n\n');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'answered', message: 'Body\n\n'});
    expect(canonical.protocolDiagnostics?.conversation?.issues).toEqual([{code: 'duplicate_marker'}]);
    expect(canonical.bindingEligibility).toBe('ineligible');
  });

  it('uses original sidecar claims instead of an existing normalized replacement', () => {
    const source = result(`Measured result.\n${renderConclusionContractSidecar(declaration(999))}`);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusionContract?.claims).toEqual(declaration(999).claims);
    expect(canonical.validationContract?.claims).toEqual(declaration(999).claims);
    const envelope = createDataEnvelope({columns: ['dur_ms'], rows: [[12.5]]}, {
      type: 'sql_result', source: 'execute_sql', title: 'Duration', evidenceRefId: 'data:duration',
    });
    // Display data alone cannot certify or refute the original proposition.
    expect(runClaimVerification({conclusionContract: canonical.result.conclusionContract, dataEnvelopes: [envelope]})
      .claimVerificationResult.status).toBe('not_checked');
  });

  it('does not fall back to an old contract for an invalid sidecar', () => {
    const marker = '<!-- smartperfetto:conclusion-contract@1\n```json\n{"broken":"RAW_DIAGNOSTIC_CANARY"}\n```\n-->';
    const source = result(`Actual answer\n${marker}`);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusionContract).toBeUndefined();
    expect(canonical.bindingEligibility).toBe('ineligible');
    expect(canonical.protocolDiagnostics?.sidecar.status).toBe('invalid');
    expect(canonical.protocolDiagnostics?.sidecar.rawPayload).toEqual({broken: 'RAW_DIAGNOSTIC_CANARY'});
    expect(JSON.stringify(canonical.result)).not.toContain('RAW_DIAGNOSTIC_CANARY');
  });

  it('keeps malformed original declarations private while retaining the marked-invalid typed claim', () => {
    const malformed = {...declaration(), claims: [{...declaration().claims![0], semantics: 'RAW_SEMANTICS_CANARY'}]};
    const marker = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n-->`;
    const canonical = canonicalizeAnalysisResult(result(`Actual answer\n${marker}`));
    // Item-scoped invalid semantics: the declaration root stays eligible (plan A.1).
    expect(canonical.result.conclusionContract?.bindingEligibility).toBe('eligible');
    expect(canonical.result.conclusionContract?.claims?.[0].text).toBe('Measured duration is 999 ms.');
    expect(canonical.result.conclusionContract?.claims?.[0]).toHaveProperty('valid', false);
    expect(canonical.protocolDiagnostics?.sidecar.contract?.claims?.[0].rawSemantics).toBe('RAW_SEMANTICS_CANARY');
    expect(JSON.stringify(canonical.result)).not.toContain('RAW_SEMANTICS_CANARY');
    expect(canonical.result.completion).toBeUndefined();
  });

  it.each(['sidecar', 'legacy'] as const)('projects nested source and claim fields without leaking raw diagnostics on %s', path => {
    const untrusted = {...declaration(), bindingEligibility: 'ineligible',
      conclusions: [{rank: 1, statement: 'A statement', trigger: {rawDeclaration: 'TRIGGER_RAW_CANARY'}}],
      sourceUseDecision: {rawDeclaration: 'SOURCE_RAW_CANARY'},
      sourceReferences: [{referenceId: 'lookup-current', codebaseId: 'source-current', filePath: 'src/Foo.ts',
        lookupKind: 'body', snippet: 'REFERENCE_RAW_CANARY', rawDeclaration: 'REFERENCE_RAW_CANARY'}],
      sourceClaimBindings: [{claimId: 'measured-duration', mechanismStatus: 'compatible',
        sourceReferenceIds: [], traceEvidenceRefIds: [], rawDeclaration: 'BINDING_RAW_CANARY'}],
      claims: [{...declaration().claims![0], artifactRefs: [{artifactId: 'artifact-a',
        rowSelector: {row: 1, unsupported: {rawDeclaration: 'SELECTOR_RAW_CANARY'}}}],
        semantics: {rawDeclaration: 'SEMANTICS_RAW_CANARY'}}],
    };
    const source = result(path === 'sidecar'
      ? `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(untrusted)}\n\`\`\`\n-->` : 'Body');
    if (path === 'legacy') source.conclusionContract = untrusted as unknown as ConclusionContract;
    const canonical = canonicalizeAnalysisResult(source);
    expect(JSON.stringify(canonical.result.conclusionContract)).not.toContain('RAW_CANARY');
    expect(JSON.stringify(canonical.validationContract)).toContain('RAW_CANARY');
    expect(canonical.result.conclusionContract?.sourceUseDecision).toBeUndefined();
    expect(canonical.result.conclusionContract?.conclusions[0].trigger).toBeUndefined();
    expect(canonical.result.conclusionContract?.claims?.[0].artifactRefs?.[0].rowSelector).toEqual({row: 1});
    expect(canonical.bindingEligibility).toBe('ineligible');
  });

  it.each(['valid', 'invalid'] as const)('prioritizes the original complete typed JSON %s declaration without rendering its body', state => {
    const original = {...declaration(999), relationProposals: [],
      ...(state === 'invalid' ? {verified: true} : {})};
    const body = `  ${JSON.stringify(original)}  `;
    const source = result(body);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(body);
    expect(canonical.validationContract?.claims?.[0].references[0].value).toBe(999);
    expect(canonical.protocolDiagnostics?.typedJson?.status).toBe(state);
    expect(canonical.bindingEligibility).toBe(state === 'valid' ? 'eligible' : 'ineligible');
  });

  it('keeps invalid protocol shells ineligible even when there is no typed contract to carry the verdict', () => {
    for (const body of [
      '<!-- smartperfetto:conclusion-contract@1\n```json\n{"broken":true}\n```\n-->',
      JSON.stringify({schemaVersion: 'conclusion_contract_v1', relationProposals: [], mode: 'focused_answer'}),
    ]) {
      const source = result(body);
      source.conclusionContract = declaration(12.5);
      const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
      expect(canonical.validationContract).toBeUndefined();
      expect(canonical.result.conclusionContract).toBeUndefined();
      expect(canonical.bindingEligibility).toBe('ineligible');
    }
  });

  it('keeps full raw declarations private on both sidecar and existing-contract paths', () => {
    const malformed = {...declaration(), bindingEligibility: 'eligible', metadata: {
      sceneId: 'general', unknownField: {rawDeclaration: 'NESTED_RAW_CANARY'},
      clusterPolicy: {outputMode: 'optional', frameListMode: 'none', unexpected: 'POLICY_RAW_CANARY'},
    }};
    const marker = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n-->`;
    const parsed = canonicalizeAnalysisResult(result(`Body\n${marker}`));
    expect(parsed.validationContract?.bindingEligibility).toBe('ineligible');
    expect(parsed.validationContract?.rawDeclaration).toEqual(malformed);
    const legacy = result('Exact existing body');
    legacy.conclusionContract = parsed.validationContract;
    const existing = canonicalizeAnalysisResult(legacy);
    expect(existing.validationContract).toBe(parsed.validationContract);
    for (const canonical of [parsed, existing]) {
      expect(canonical.result.conclusionContract?.bindingEligibility).toBe('ineligible');
      expect(canonical.result.conclusionContract?.metadata).toEqual({sceneId: 'general',
        clusterPolicy: {outputMode: 'optional', frameListMode: 'none'}});
      expect(JSON.stringify(canonical.result)).not.toContain('RAW_CANARY');
      expect(canonical.result.conclusionContract).not.toHaveProperty('rawDeclaration');
    }
  });

  it('does not activate a nested second protocol or a nonterminal control', () => {
    const quotedSidecar = renderConclusionContractSidecar(declaration());
    const payload = JSON.stringify({kind: 'needs_user_input', question: quotedSidecar}).replace(/-->/g, '\\u002d\\u002d>');
    const nestedControl = `<!-- smartperfetto:conversation-control ${payload} -->`;
    const nested = canonicalizeAnalysisResult(result(nestedControl), {conversation: {fallbackQuestion: 'Fallback'}});
    expect(nested.result.conclusion).toBe('');
    expect(nested.protocolDiagnostics?.sidecar.status).toBe('absent');
    const ordinary = `${control}\nThis is subsequent narrative, so the earlier marker is ordinary content.`;
    expect(canonicalizeAnalysisResult(result(ordinary), {conversation: {fallbackQuestion: 'Fallback'}}).result.conclusion).toBe(ordinary);
  });

  it('preserves legacy declarations and exact prose only when sidecar is absent', () => {
    const source = result('  ## Complete report\n\n快速回答：Connection error and full analysis are trace content.  ');
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(source.conclusion);
    expect(canonical.result.conclusionContract).toEqual(source.conclusionContract);
    expect(canonical.validationContract).toBe(source.conclusionContract);
    expect(canonical.projection.disposition).toBe('preserved');
    expect(canonical.protocolDiagnostics).toBeUndefined();
  });

  it.each(['completed', 'incomplete', 'unknown'] as const)('transfers only native %s completion through issued projection', status => {
    const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
    const context = contextFor(source, status);
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(isIssuedCanonicalAnalysisProjection(canonical.projection)).toBe(true);
    expect(isIssuedCanonicalAnalysisProjection({...canonical.projection})).toBe(false);
    expect(Object.isFrozen(canonical.projection)).toBe(true);
    expect(Object.isFrozen(canonical.projection.sourceCandidate)).toBe(true);
    expect(Object.isFrozen(canonical.projection.candidate)).toBe(true);
    expect(canonical.result.completion?.status).toBe(status);
    expect(canonical.result.completion?.candidateRef).not.toBe(context.acceptedCandidate.candidateRef);
    expect(assessFinalResultQualityAssessment({result: canonical.result, context}).assurance.completion).toBe('not_checked');
  });

  it.each(['candidateRef', 'runId', 'attemptId', 'conclusionFingerprint'] as const)(
    'does not transfer a native receipt for another %s', field => {
      const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
      const context = contextFor(source);
      context.completion = {...context.completion!, [field]: 'stale'};
      expect(canonicalizeAnalysisResult(source, {context}).result.completion).toBeUndefined();
    },
  );

  it('does not re-sign a stale source body or trust result metadata without explicit context', () => {
    const source = result('Original body');
    const context = contextFor(source);
    source.conclusion = `Different body\n${renderConclusionContractSidecar(declaration())}`;
    source.completion = context.completion;
    source.outputOrigin = 'sdk_final';
    for (const options of [{context}, {}]) {
      const canonical = canonicalizeAnalysisResult(source, options);
      expect(canonical.result.completion).toBeUndefined();
      expect(canonical.projection.candidate).toBeUndefined();
      expect(canonical.projection.sourceCandidate).toBeUndefined();
    }
  });

  it('invalidates old evidence and report bindings when selecting a new declared contract', () => {
    const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
    const context = contextFor(source);
    source.conclusionContract = declaration(12.5);
    source.claimSupport = [];
    source.deliveryAssurance = {schemaVersion: 1, entry: 'new_finalization', completion: 'passed',
      claims: 'passed', source: 'passed', identity: 'passed', report: 'passed'};
    context.claimVerificationBinding = {candidate: context.acceptedCandidate, evidenceFingerprint: 'evidence-a',
      claimsFingerprint: 'old-claims', verificationFingerprint: 'old-verification'};
    context.sourceVerificationBinding = {...context.claimVerificationBinding,
      conclusionContractFingerprint: 'old-contract', sourceUseFingerprint: 'old-source'};
    context.evidenceRenderedProof = {kind: 'verified_facts', ...context.claimVerificationBinding, claimIds: ['old']};
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(canonical.result.claimSupport).toBeUndefined();
    expect(canonical.result.deliveryAssurance).toBeUndefined();
    if (canonical.deliveryContext?.entry !== 'new_finalization') throw new Error('Missing canonical context');
    expect(canonical.deliveryContext.claimVerificationBinding).toBeUndefined();
    expect(canonical.deliveryContext.sourceVerificationBinding).toBeUndefined();
    expect(canonical.deliveryContext.evidenceRenderedProof).toBeUndefined();
  });

  it('preserves a typed whole privacy fallback without granting completion', () => {
    const source = result('[PRIVATE_OUTPUT_SUPPRESSED]');
    source.success = false;
    source.partial = true;
    source.outputOrigin = 'runtime_fallback';
    const context = contextFor(source, 'unknown');
    context.outputOrigin = 'runtime_fallback';
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(canonical.result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback'});
    expect(canonical.result.completion?.status).toBe('unknown');
    expect(assessFinalResultQualityAssessment({result: canonical.result, context: canonical.deliveryContext})
      .assurance.completion).toBe('failed');
  });
});


describe('source binding declaration ownership', () => {
  function sourceDeclaration(): any {
    return {...declaration(), claims: [{id: 'source-body', text: 'Implementation may explain the wait', kind: 'inference', references: [],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'source.mechanism', polarity: 'affirmed',
        discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'codebase'}}}],
      sourceClaimBindings: [{claimId: 'source-body', sourceReferenceIds: ['source-returned'], traceEvidenceRefIds: [] as string[]}]};
  }
  it('admits source-only empty Trace links without declaring source proof', () => {
    const parsed = parseConclusionContractDeclaration(sourceDeclaration());
    expect(parsed.issues).toEqual([]);
    expect(parsed.contract?.sourceClaimBindings).toEqual([{claimId: 'source-body',
      sourceReferenceIds: ['source-returned'], traceEvidenceRefIds: []}]);
  });
  it.each(['missing', 'duplicate', 'foreign_trace'] as const)('rejects %s links while retaining the original declaration', kind => {
    const raw = sourceDeclaration();
    raw.privateNote = 'PRIVATE_DECLARATION_NOTE';
    if (kind === 'missing') raw.sourceClaimBindings[0].claimId = 'not-declared';
    if (kind === 'duplicate') raw.claims.push(structuredClone(raw.claims[0]));
    if (kind === 'foreign_trace') {
      raw.sourceClaimBindings[0].traceEvidenceRefIds = ['data:duration'];
      raw.claims.push(declaration().claims![0]);
    }
    const before = structuredClone(raw);
    const parsed = parseConclusionContractDeclaration(raw);
    expect(parsed.issues).toContainEqual({code: 'invalid_reference', path: `sourceClaimBindings[0].${kind === 'foreign_trace' ? 'traceEvidenceRefIds' : 'claimId'}`});
    expect(parsed.contract?.bindingEligibility).toBe('ineligible');
    expect(parsed.contract?.sourceClaimBindings).toEqual(raw.sourceClaimBindings);
    expect(parsed.contract?.rawDeclaration).toEqual(raw);
    expect(raw).toEqual(before);
    const native = `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`\n-->`;
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(native), 'native', 1);
    expect(diagnostic.issueCodes).toContain('invalid_reference');
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_DECLARATION_NOTE');
    expect(JSON.stringify(canonicalizeAnalysisResult(result(native)).result)).not.toContain('PRIVATE_DECLARATION_NOTE');
  });
  it('reports cluster shape and unowned Trace bindings together for one correction opportunity', () => {
    const raw = sourceDeclaration();
    raw.clusters = ['wrong shape'];
    raw.sourceClaimBindings[0].traceEvidenceRefIds = ['foreign'];
    const parsed = parseConclusionContractDeclaration(raw);
    expect(parsed.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['invalid_contract', 'invalid_reference']));
    expect(parsed.contract).toBeUndefined();
  });
  it.each(['references', 'artifactRefs', 'relationRefs', 'subjectRefs', 'objectRefs'] as const)(
    'leaves %s aliases and evidence truth to the verifier', field => {
      const raw = sourceDeclaration();
      const claim = raw.claims[0];
      raw.sourceClaimBindings[0].traceEvidenceRefIds = ['data:duration'];
      if (field === 'references') claim.references = [{artifactId: 'artifact-alias', rowIndex: 0, column: 'dur_ms'}];
      else if (field === 'artifactRefs') claim.artifactRefs = [{artifactId: 'artifact-alias'}];
      else if (field === 'relationRefs') claim.relationRefs = ['relation:observed'];
      else claim.semantics.scope[field] = [{evidenceRefId: 'data:duration', rowIndex: 0, column: 'dur_ms'}];
      expect(parseConclusionContractDeclaration(raw).issues).toEqual([]);
    });
});


describe('lossless semantic evidence transport', () => {
  it('interns only identical whole records and roundtrips every row, status and source', () => {
    const record = {captureId: 'capture-a', traceId: 'trace-a', unit: 'ms', generation: 1,
      columns: Array.from({length: 40}, (_, i) => `column_${i}`)};
    const variants = [record, {...record, traceId: 'trace-b'}, {...record, unit: 'ns'}, {...record, generation: 2}];
    const snapshot = {schemaVersion: 'prepared_claim_evidence@1', fingerprint: 'unchanged', bindingEligibility: 'eligible',
      reads: [...Array.from({length: 20}, (_, i) => ({key: `read-${i}`, status: 'resolved', record: variants[i % 4],
        originalRowIndex: i, row: {value: i, missing: null, flag: false}})), {key: 'missing', status: 'missing', reason: 'not_found'}]};
    const original = structuredClone(snapshot);
    const compacted = compactSemanticEvidenceSnapshot(snapshot) as any;
    expect(compacted.schemaVersion).toBe('semantic_evidence_snapshot@1');
    expect(compacted.records).toHaveLength(4);
    expect(compacted.fingerprint).toBe(snapshot.fingerprint);
    expect(expandSemanticEvidenceSnapshot(compacted)).toEqual(original);
    expect(snapshot).toEqual(original);
    expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)));
  });
  it('interns complete field origins without merging different producers or losing field properties', () => {
    const origin = {kind: 'skill_sql', skillId: 'startup', stepId: 'states',
      definitionFingerprint: 'a'.repeat(64), selectedSqlHash: 'b'.repeat(64)};
    const variants = [origin, {...origin, definitionFingerprint: 'c'.repeat(64)},
      {...origin, kind: 'sql'}, {...origin, selectedSqlHash: 'd'.repeat(64)}];
    const snapshot = {schemaVersion: 'prepared_claim_evidence@1', fingerprint: 'original', reads:
      variants.map((source, i) => ({key: `read-${i}`, status: 'resolved', record: {captureId: `capture-${i}`,
        fields: Object.fromEntries(Array.from({length: 8}, (_, field) => [`field-${field}`,
          {origin: source, unit: field % 2 ? 'ms' : 'ns', role: 'timestamp', clock: 'trace', nullable: false}]))},
        row: {value: i, absent: null}}))};
    const original = structuredClone(snapshot);
    const compacted = compactSemanticEvidenceSnapshot(snapshot) as any;
    expect(compacted.schemaVersion).toBe('semantic_evidence_snapshot@2');
    expect(compacted.records).toHaveLength(4);
    expect(compacted.origins).toEqual(variants);
    expect(expandSemanticEvidenceSnapshot(compacted)).toEqual(original);
    expect(snapshot).toEqual(original);
    expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)));
  });
  it('pools repeated complete field and display-column descriptors without merging differences', () => {
    const origin = {kind: 'skill_sql', skillId: 'startup', definitionFingerprint: 'a'.repeat(64)};
    const columns = [{name: 'dur', type: 'duration', unit: 'ms', label: '耗时'},
      {name: 'name', type: 'string', label: '名称'}];
    const snapshot = {schemaVersion: 'prepared_claim_evidence@1', fingerprint: 'unicode', bindingEligibility: 'eligible',
      reads: Array.from({length: 12}, (_, index) => ({key: `read-${index}`, status: 'resolved', record: {
        captureId: `capture-${index}`, display: {title: `表 ${index}`, columns: index === 11
          ? [columns[0], {...columns[1], label: 'Different'}] : columns},
        fields: Object.fromEntries([['dur', {origin, unit: index === 10 ? 'ns' : 'ms', nullable: false}],
          ['name', {origin, nullable: true}], ['__proto__', {origin, nullable: true}]])},
      originalRowIndex: index, row: {dur: index, name: `行 ${index}`}}))};
    const compacted = compactSemanticEvidenceSnapshot(snapshot) as any;
    expect(compacted.schemaVersion).toBe('semantic_evidence_snapshot@2');
    expect(compacted.fieldDescriptors.length).toBe(3);
    expect(compacted.displayColumns.length).toBe(3);
    const expanded = expandSemanticEvidenceSnapshot(compacted) as typeof snapshot;
    expect(Object.prototype.hasOwnProperty.call(expanded.reads[0].record.fields, '__proto__')).toBe(true);
    expect(expanded).toEqual(snapshot);
  });
  it('rejects invalid transport indexes instead of partially decoding them', () => {
    const base = {schemaVersion: 'semantic_evidence_snapshot@2', sourceSchemaVersion: 'prepared_claim_evidence@1',
      origins: [], fieldDescriptors: [{}], displayColumns: [{}], records: [{fields: {dur: 0},
        display: {columnIndexes: [0]}}], reads: [{recordIndex: 0}]};
    for (const changed of [
      {...base, reads: [{recordIndex: 1}]},
      {...base, records: [{fields: {dur: 2}, display: {columnIndexes: [0]}}]},
      {...base, records: [{fields: {dur: 0}, display: {columnIndexes: [-1]}}]},
    ]) expect(expandSemanticEvidenceSnapshot(changed)).toBeUndefined();
  });
  it('retains unfamiliar, colliding and non-beneficial shapes unchanged', () => {
    for (const value of [undefined, {reads: []}, {schemaVersion: 'prepared_claim_evidence@1', reads: []},
      ...['records', 'origins', 'sourceSchemaVersion', 'fieldDescriptors', 'displayColumns'].map(key => ({schemaVersion: 'prepared_claim_evidence@1',
        [key]: 'existing', reads: [{record: {id: 2}}]})),
      {schemaVersion: 'prepared_claim_evidence@1', reads: [{record: {fields: {dur: {originIndex: 0, origin: {kind: 'sql'}}}}}]},
      {schemaVersion: 'prepared_claim_evidence@1', reads: [{record: {display: {columnIndexes: [0]}}}]},
      {schemaVersion: 'prepared_claim_evidence@1', reads: [{record: {fields: {dur: 0}}}]},
      {schemaVersion: 'prepared_claim_evidence@1', reads: [{recordIndex: 1, record: {id: 2}}]}]) {
      expect(compactSemanticEvidenceSnapshot(value)).toBe(value);
    }
  });
});

describe('lossless final semantic source transport', () => {
  const sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send', selectedCodebaseIds: ['codebase'],
    status: 'corroborated', attemptedTools: ['read_codebase_file'], queriedCodebaseIds: ['codebase'],
    usedCodebaseIds: ['codebase'], coverageComplete: true, references: [
      {id: 'source-ref-1', referenceId: 'source-1', codebaseId: 'codebase', filePath: 'src/App.kt',
        lineRange: {start: 1, end: 200}, lookupKind: 'body'},
      {id: 'source-ref-2', referenceId: 'source-2', codebaseId: 'codebase', filePath: 'src/App.kt',
        lineRange: {start: 201, end: 400}, lookupKind: 'body'},
    ]};
  const snapshot = () => ({inputCoverage: 'complete', query: 'explain', body: 'body', sourceUse,
    selectionScope: {present: true, kind: 'track_event', context: {kind: 'track_event', eventId: 7, ts: 42},
      sideResolution: {status: 'unknown'}},
    conclusionContract: {schemaVersion: 'conclusion_contract_v1', sourceUseDecision: sourceUse,
      sourceReferences: sourceUse.references, sourceClaimBindings: [{claimId: 'source-claim',
        mechanismStatus: 'compatible', sourceReferenceIds: ['source-ref-1'], traceEvidenceRefIds: []}]}});

  it('aliases only exact duplicate source ledgers and preserves bindings through roundtrip', () => {
    const original = snapshot();
    const compacted = compactSemanticSourceSnapshot(original) as any;
    expect(compacted.semanticSourceAlias).toEqual({schemaVersion: 'final_semantic_source_alias@1'});
    expect(compacted.conclusionContract).not.toHaveProperty('sourceUseDecision');
    expect(compacted.conclusionContract).not.toHaveProperty('sourceReferences');
    expect(compacted.conclusionContract.sourceClaimBindings).toEqual(original.conclusionContract.sourceClaimBindings);
    expect(expandSemanticSourceSnapshot(compacted)).toEqual(original);
    expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)));
  });

  it('keeps mismatched, reordered and colliding source snapshots unchanged', () => {
    const mismatch = snapshot(); mismatch.conclusionContract.sourceUseDecision = {...sourceUse, status: 'located'} as any;
    const reordered = snapshot(); reordered.conclusionContract.sourceReferences = [...sourceUse.references].reverse();
    const collision = {...snapshot(), semanticSourceAlias: {schemaVersion: 'other'}};
    for (const value of [mismatch, reordered, collision]) expect(compactSemanticSourceSnapshot(value)).toBe(value);
  });

  it('rejects unknown markers, extra marker keys, double definitions and invalid source ledgers', () => {
    const compacted = compactSemanticSourceSnapshot(snapshot()) as any;
    for (const value of [
      {...compacted, semanticSourceAlias: {schemaVersion: 'unknown'}},
      {...compacted, semanticSourceAlias: {...compacted.semanticSourceAlias, extra: true}},
      {...compacted, conclusionContract: {...compacted.conclusionContract, sourceReferences: []}},
      {...compacted, sourceUse: {...compacted.sourceUse, references: 'invalid'}},
    ]) expect(expandSemanticSourceSnapshot(value)).toBeUndefined();
  });
});

describe('legacy narrative derivation at the canonical boundary', () => {
  // Legacy bodies carry no sidecar or native declaration, so canonicalization
  // derives the contract from the prose or keeps the producer's contract.
  const legacyContract = (conclusion: string, conclusionContract?: ConclusionContract) =>
    canonicalizeAnalysisResult({...result(conclusion), ...(conclusionContract ? {conclusionContract} : {})}).validationContract;
  const skillTable = (evidenceRefId: string, title: string, columns: string[], rows: unknown[][],
    meta: Partial<DataEnvelope['meta']> = {}): DataEnvelope => {
    const envelope = createDataEnvelope({columns, rows}, {type: 'skill_result', source: title, title, evidenceRefId,
      traceId: 'trace-1', traceSide: 'current'});
    return {...envelope, meta: {...envelope.meta, ...meta}};
  };
  const narrativeWithEvClaim = [
    '快速回答：帧耗时 45.6ms（ev_deadbeef1234）。',
    '',
    '## 逐句数据引用（结构化来源）',
    '- Q1 / C1: 帧耗时 45.6ms',
    '  - evidence_ref_id=ev_deadbeef1234; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
  ].join('\n');

  it('derives claim provenance from the original body, leaving evidence-id stripping to display', () => {
    const canonical = canonicalizeAnalysisResult(result(narrativeWithEvClaim));
    expect(canonical.validationContract?.claims?.[0]?.references?.[0]).toMatchObject({
      evidenceRefId: 'ev_deadbeef1234', sourceRef: '表 1'});
    expect(canonical.result.conclusion).toContain('ev_deadbeef1234');
  });

  it('takes a derived contract mode from the current typed deliverable, never from result metadata', () => {
    const source = result(narrativeWithEvClaim);
    expect(canonicalizeAnalysisResult(source, {context: contextFor(source, 'completed', 'answer')}).validationContract?.mode)
      .toBe('focused_answer');
    expect(canonicalizeAnalysisResult(source, {context: contextFor(source, 'completed', 'report')}).validationContract?.mode)
      .toBe('initial_report');
    const metadataOnly = {...source, turnIntent: contextFor(source).turnIntent};
    expect(canonicalizeAnalysisResult(metadataOnly).validationContract?.mode).toBe('initial_report');
  });

  describe('original claim fidelity', () => {
    const envelope = createDataEnvelope(
      {columns: ['ttid_ms'], rows: [[1912]]},
      {type: 'skill_result', source: 'startup_analysis', title: '启动概览',
        skillId: 'startup_analysis', stepId: 'get_startups', executionStatus: 'observed',
        evidenceRefId: 'data:startup-original', traceId: 'trace-original', traceSide: 'current'},
    );
    const originalContract = (claims: NonNullable<ConclusionContract['claims']>): ConclusionContract & {claims: NonNullable<ConclusionContract['claims']>} => ({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [{rank: 1, statement: '启动耗时待核验'}],
      clusters: [], evidenceChain: [], claims, uncertainties: [], nextSteps: [],
    });
    const numericClaim = (id: string, value: number, text = `TTID=${value}ms`): ConclusionContractClaimItem => {
      const reference = {evidenceRefId: 'data:startup-original', rowIndex: 0, column: 'ttid_ms', value};
      return {id, text, kind: 'numeric', references: [reference],
        semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
          discourse: 'asserted', quantifier: 'one', modality: 'certain',
          scope: {population: 'cited_rows', subjectRefs: [reference]}, numeric: {operator: 'eq', value, unit: 'ms'}}};
    };
    const parsedOriginal = (claims: NonNullable<ConclusionContract['claims']>): ConclusionContract => {
      const parsed = parseConclusionContractDeclaration(originalContract(claims));
      expect(parsed.issues).toEqual([]);
      if (!parsed.contract) throw new Error('Expected a valid fixture declaration');
      return parsed.contract;
    };
    const verifyCaptured = async (conclusionContract: ConclusionContract | null | undefined) => {
      const store = new ArtifactStore();
      store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
        ttid_ms: {unit: 'ms', origin: {kind: 'skill_literal', skillId: 'startup_analysis',
          stepId: 'get_startups', definitionFingerprint: 'startup-original-fixture'}},
      }), {meta: envelope.meta, display: envelope.display});
      const preparedEvidence = await prepareClaimEvidence({conclusionContract,
        evidenceReadView: store.createEvidenceReadView({ownerKey: 'original-claims',
          allowedTraces: [{traceId: 'trace-original', traceSide: 'current'}]})});
      return runPreparedAnalysisClaimVerification({conclusionContract, dataEnvelopes: [envelope], preparedEvidence});
    };

    it('keeps a contradicted claim failed when unrelated prose contains the true evidence value', async () => {
      const original = parsedOriginal([numericClaim('wrong-ttid', 9999)]);
      const canonical = legacyContract('启动概览：TTID=9999ms，事件计数1912次。', original);
      const verified = await verifyCaptured(canonical);

      expect(canonical).toBe(original);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults[0]).toMatchObject({claimId: 'wrong-ttid', status: 'unsupported',
        referenceCells: [{status: 'value_mismatch'}],
        deterministicProof: {status: 'rejected', reason: 'numeric_operator_rejected'}});
    });

    it('preserves mixed supported, contradicted and unreferenced claims', async () => {
      const original = parsedOriginal([
        numericClaim('supported', 1912),
        numericClaim('contradicted', 9999),
        {id: 'no-reference', text: 'The delay may come from initialization.', kind: 'inference', references: []},
      ]);
      const canonical = legacyContract('启动概览：TTID=9999ms，事件计数1912次。', original);
      const verified = await verifyCaptured(canonical);

      expect(canonical?.claims).toEqual(original.claims);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults).toMatchObject([
        {claimId: 'supported', status: 'partial', deterministicProof: {status: 'proved'}, propositionCoverage: {status: 'complete'}},
        {claimId: 'contradicted', status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]},
        {claimId: 'no-reference', status: 'inference', referenceCells: []},
      ]);
    });

    it('reads typed JSON before display conversion can discard causal kind or relation references', () => {
      const original = originalContract([{
        id: 'cause', text: 'No evidence yet proves that initialization caused the delay.', kind: 'causal',
        relationRefs: ['relation-candidate'],
        references: [{evidenceRefId: 'data:startup-original', rowIndex: 0, column: 'ttid_ms', value: 1912}],
      }]);
      expect(legacyContract(JSON.stringify(original))?.claims)
        .toEqual(original.claims.map(claim => ({...claim, conclusionId: 'C1'})));
    });

    it('retains explicit JSON claims whose references are absent, malformed or relation-only', () => {
      const raw = originalContract([
        {id: 'missing', text: 'Initialization may be slow.', kind: 'inference', references: []},
        {id: 'relation-only', text: 'The dependency blocks initialization.', kind: 'causal', references: [], relationRefs: ['relation-1']},
        {id: 'malformed', text: 'TTID=9999ms', kind: 'numeric', references: [{}]},
      ]);
      const parsed = legacyContract(JSON.stringify(raw));
      expect(parsed?.claims?.map(claim => ({id: claim.id, text: claim.text, kind: claim.kind})))
        .toEqual(raw.claims.map(claim => ({id: claim.id, text: claim.text, kind: claim.kind})));
      expect(parsed?.claims?.[1].relationRefs).toEqual(['relation-1']);
      expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult.passed).toBe(false);
    });

    it('retains explicit Markdown claims without references as unverified statements', () => {
      const parsed = legacyContract([
        '## 逐句数据引用（结构化来源）',
        '- Q-missing / C1: 初始化耗时尚未得到证据支持。',
      ].join('\n'));
      expect(parsed?.claims).toEqual([{id: 'Q-missing', conclusionId: 'C1', text: '初始化耗时尚未得到证据支持。', references: []}]);
      expect(runClaimVerification({conclusionContract: parsed}).claimVerificationResult.passed).toBe(false);
    });

    it('does not create claims merely because narrative and evidence contain the same number', () => {
      const parsed = legacyContract('事件计数1912次。');
      expect(parsed?.claims ?? []).toEqual([]);
      expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult)
        .toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0});
    });

    it('does not silently truncate explicitly supplied claims before verification', async () => {
      const claims = Array.from({length: 51}, (_, index) => numericClaim(
        `Q${index + 1}`, index === 50 ? 9999 : 1912, `TTID observation ${index + 1}`,
      ));
      const parsed = legacyContract(JSON.stringify(originalContract(claims)));
      expect(parsed?.claims?.map(({id, references, semantics}) => ({id, references, semantics})))
        .toEqual(claims.map(({id, references, semantics}) => ({id, references, semantics})));
      const verified = await verifyCaptured(parsed);
      expect(verified.claimVerificationResult.status).toBe('failed');
      expect(verified.claimVerificationResult.claimResults).toHaveLength(51);
      expect(verified.claimVerificationResult.claimResults.slice(0, 50).every(claim =>
        claim.status === 'partial' && claim.deterministicProof?.status === 'proved')).toBe(true);
      expect(verified.claimVerificationResult.claimResults[50]).toMatchObject({claimId: 'Q51',
        status: 'unsupported', referenceCells: [{status: 'value_mismatch'}]});
    });

    it.each([{}, {id: 'empty', references: []}, {text: '   ', references: []}])(
      'does not fabricate a statement for an empty claim entry: %j',
      entry => {
        const parsed = legacyContract(JSON.stringify({...originalContract([]), claims: [entry]}));
        expect(parsed?.claims ?? []).toEqual([]);
        expect(runClaimVerification({conclusionContract: parsed, dataEnvelopes: [envelope]}).claimVerificationResult)
          .toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0});
      },
    );
  });

  it('keeps rich reports without explicit claims unverified despite matching evidence', () => {
    const envelopes = [
      skillTable('data:skill:startup_analysis:get_startups:current:abc', '检测到的启动事件',
        ['package', 'startup_type', 'dur_ms', 'ttid_ms'], [['com.example.launch.aosp.heavy', 'cold', 1339, 1912]],
        {artifactId: 'art-2'}),
      skillTable('data:skill:startup_detail:actionable_hotspots:current:def', '可操作热点',
        ['slice_name', 'self_ms', 'self_percent'], [['ChaosTask', 456, 34.1], ['LoadSimulator_ActivityInit', 249.8, 18.7]],
        {artifactId: 'art-30'}),
    ];
    const contract = legacyContract([
      '# 启动性能分析报告',
      '',
      '## 综合结论',
      '',
      '冷启动 TTID=1912ms，dur=1339ms，主因是 ChaosTask self=456ms 和 LoadSimulator_ActivityInit self=249.8ms。',
      '',
      '## 关键证据链',
      '',
      '- 启动事件与热点表均已采集。',
    ].join('\n'));
    expect(contract?.claims ?? []).toEqual([]);
    expect(contract?.metadata?.derivedFromNarrativeEvidenceMatch).not.toBe(true);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult).toMatchObject({status: 'not_checked', checkedClaimCount: 0});
  });

  it('preserves unresolvable references rather than replacing claims with matching data', () => {
    const envelopes = [skillTable('data:skill:scrolling_analysis:jank_type_stats:current:abc', '掉帧类型分布',
      ['jank_type', 'count', 'real_jank_count', 'false_positive'], [['App Deadline Missed', 6, 6, 0]], {artifactId: 'art-6'})];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1', mode: 'initial_report', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'Q1', text: 'App Deadline Missed 有 6 帧', kind: 'numeric', references: [{
        evidenceRefId: 'missing-artifact', sourceRef: 'jank_type_stats', rowIndex: 0, column: 'count', value: 6}]}],
      uncertainties: [], nextSteps: [],
    } as ConclusionContract;
    const contract = legacyContract(
      '# 滑动性能分析报告\n\n## 概览\n\nApp Deadline Missed 有 6 帧，real_jank_count=6，false_positive=0。', parsed);
    expect(contract).toBe(parsed);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult.passed).toBe(false);
  });

  it('never verifies a claim that cites a knowledge reference as trace evidence', () => {
    const envelopes = [skillTable('data:skill:scrolling_analysis:jank_type_stats:current:abc', '掉帧类型分布',
      ['jank_type', 'count'], [['App Deadline Missed', 6]], {artifactId: 'art-6'})];
    const knowledgeReference = 'kref-00000000-0000-0000-0000-000000000000';
    const contract = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'Q1', text: 'App Deadline Missed 有 6 帧', kind: 'numeric', references: [{
        evidenceRefId: knowledgeReference, sourceRef: '掉帧类型分布', rowIndex: 0, column: 'count', value: 6}]}],
      uncertainties: [], nextSteps: [],
    } as ConclusionContract;
    const verification = runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes,
      policy: 'record_only'}).claimVerificationResult;
    expect(verification.passed).toBe(false);
    expect(verification.status).not.toBe('passed');
  });

  it('preserves conflicting artifact references for the verifier to reject', () => {
    const envelopes = [
      skillTable('data:skill:scrolling_analysis:performance_summary:current:abc', '滑动性能概览',
        ['total_frames', 'perceived_jank_frames', 'jank_rate'], [[347, 7, 2.02]], {artifactId: 'art-4'}),
      skillTable('data:skill:scrolling_analysis:batch_frame_root_cause:current:def', '掉帧列表',
        ['dur_ms', 'vsync_missed'], [[18.66, 2], [62.73, 7]], {artifactId: 'art-9'}),
    ];
    const parsed = {
      schemaVersion: 'conclusion_contract_v1', mode: 'initial_report', conclusions: [], clusters: [], evidenceChain: [],
      claims: [
        {id: 'Q1', text: '总帧数 347，真实掉帧 7 帧，掉帧率 2.02%', kind: 'numeric', references: [
          {evidenceRefId: 'data:art-4', sourceRef: '滑动性能概览', rowIndex: 0, column: 'total_frames', value: 347}]},
        {id: 'Q2', text: '最长帧 62.73ms，最长连续丢帧 7 VSync', kind: 'numeric', references: [
          {evidenceRefId: 'data:art-14', sourceRef: '掉帧列表', rowIndex: 1, column: 'dur_ms', value: 62.73}]},
      ],
      uncertainties: [], nextSteps: [],
    } as ConclusionContract;
    const contract = legacyContract(
      '# 滑动性能分析报告\n\n## 概览\n\n总帧数 347，真实掉帧 7 帧，掉帧率 2.02%。最长帧 62.73ms，最长连续丢帧 7 VSync。', parsed);
    expect(contract).toBe(parsed);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult.passed).toBe(false);
  });

  it('does not invent cell expectations for row-only identity claims', () => {
    const envelopes = [skillTable('data:skill:process_identity_resolver:current:identity', '进程身份候选',
      ['process_name', 'package_name', 'pid', 'upid', 'confidence_score'],
      [['com.example.wechatfriendforcustomscroller', 'com.example.wechatfriendforcustomscroller', 13534, 885, 100]],
      {identityStatus: 'verified', identityRefId: 'identity:trace-1:current:process:885'})];
    const parsed: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'C2', text: '主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885',
        kind: 'identity', references: [{evidenceRefId: 'data:skill:process_identity_resolver:current:identity',
          sourceRef: '进程身份候选', rowIndex: 0}]}],
      uncertainties: [], nextSteps: [],
    };
    const contract = legacyContract(
      '这个 trace 的主要进程名为 com.example.wechatfriendforcustomscroller，PID 为 13534，UPID 为 885。', parsed);
    expect(contract).toBe(parsed);
    expect(runClaimVerification({conclusionContract: contract, dataEnvelopes: envelopes, policy: 'record_only'})
      .claimVerificationResult.status).toBe('not_checked');
  });
});

function nativeAuthoredDocument(): AuthoredClaimObjectInput {
  return {representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    referenceDictionary: [{evidenceRefId: 'data:duration', sourceRef: null, sourceToolCallId: null,
      artifactId: null, sourceArtifactId: null, column: 'dur_ms', rowIndex: 0, rowSelector: null,
      value: {kind: 'present', value: 10}}],
    semanticFrames: [{predicate: 'numeric.cell', polarity: 'affirmed', discourse: 'asserted', quantifier: 'one',
      modality: 'certain', conditions: null, population: 'cited_rows'}],
    contract: {mode: 'focused_answer', conclusions: null, clusters: null, evidenceChain: null,
      uncertainties: null, nextSteps: null, relationProposals: null, sourceClaimBindings: [], metadata: null,
      claims: [{id: 'duration', conclusionId: null, text: '10 ms', kind: 'numeric', references: [0],
        artifactRefs: null, relationRefs: null, supportLevel: null,
        semantics: {frameIndex: 0, subjectRefs: [0], objectRefs: null, timeRangeNs: null,
          numeric: {operator: 'eq', value: 10, unit: 'ms', presentation: {unit: 'ms', decimalPlaces: 0,
            rounding: 'half_away_from_zero', quotes: [
              {kind: 'body_part', text: '10 ms', partIndex: 1, localOccurrence: null},
              {kind: 'body_part', text: '10 ms', partIndex: 3, localOccurrence: null},
            ]}}}}]},
    bodyParts: ['First ', {claimText: 'duration'}, '\nSecond ', {claimText: 'duration'}]};
}

function nativeAuthoredFixture(document: unknown = nativeAuthoredDocument(), options: {
  redact?: string;
  alterCompiled?: (compiled: Extract<AuthoredClaimObjectResult, {status: 'compiled'}>) => void;
} = {}) {
  const rawArguments = ' \n' + JSON.stringify({document}, null, 2) + '\n';
  const nativeDocument = JSON.parse(rawArguments).document;
  const compiled = compileAuthoredClaimObject(nativeDocument);
  if (compiled.status !== 'compiled') throw new Error(`Native fixture projection failed: ${compiled.code}`);
  options.alterCompiled?.(compiled);
  const source = result(compiled.body), live = {active: true, attempt: true};
  const binding = {owner: live, sessionId: source.sessionId, runId: 'run-a', attemptId: 'attempt-a',
    providerPin: 'test-pin', authorizationFingerprint: 'test-scope'};
  const issuer = createAuthoredFinalSubmissionIssuer({binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    assertAttemptCurrent: () => {if (!live.attempt) throw new Error('retired');},
    assertCurrent: () => {if (!live.active) throw new Error('revoked');}});
  const dispatch = {dispatchOrdinal: 1, responseId: 'native-response', callId: 'native-call'};
  const submission = issueAuthoredFinalSubmission(issuer, {...dispatch, rawArguments, nativeDocument, compiled});
  const handoff: AuthoredConclusionSubmission & {input: AuthoredFinalSubmissionV2ReadInput} = {submission, input: {
    binding: {...binding, ...dispatch, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION}, rawArguments,
    nativeDocument: structuredClone(nativeDocument), body: compiled.body, rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)}};
  const delivery = contextFor(source);
  delivery.outputOrigin = 'model_tool_arguments'; delivery.finalSubmission = {mode: 'authored_claim_document_v2', outcome: 'submitted'};
  source.outputOrigin = delivery.outputOrigin; source.completion = delivery.completion;
  if (options.redact) registerCodeAwareCanary(source.sessionId, options.redact);
  const projected = finalizeSourceAwareAnalysisResultWithProjection(source, undefined, {context: delivery, authoredSubmission: handoff});
  const context = projected.deliveryContext;
  if (!context || context.entry === 'historical_restore' || !projected.protocolProjection) throw new Error('Expected issued native projection');
  const token = projected.protocolProjection;
  const native = readConclusionProtocolProjection(token, {result: source, candidate: context.acceptedCandidate, runId: binding.runId});
  const canonical = canonicalizeAnalysisResult(source, {context, nativeDeclaration: native});
  return {source, live, compiled, handoff, context, native, canonical,
    cleanup: () => {releaseConclusionProtocolProjection(token); clearCodeAwareOutputGuards(source.sessionId);}};
}

async function provedNativePresentation(document = nativeAuthoredDocument(), options: {value?: number; redact?: string} = {}) {
  const f = nativeAuthoredFixture(document, options);
  const store = new ArtifactStore();
  const data = {columns: ['dur_ms'], rows: [[options.value ?? 10]]};
  const witness = captureEvidenceTable(data, {dur_ms: {unit: 'ms', origin: {kind: 'skill_literal', skillId: 'fixture', stepId: 'root',
    definitionFingerprint: 'a'.repeat(64), selectedSqlHash: 'b'.repeat(64)}}});
  const artifact = store.store({skillId: 'fixture', data, sourceToolCallId: 'invoke:duration',
    traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'current', traceSide: 'current'})});
  expect(store.registerEvidenceCapture(artifact, witness, {evidenceRefId: 'data:duration'})).toBe(true);
  const prepared = await prepareClaimEvidence({conclusionContract: f.canonical.validationContract,
    bindingEligibility: f.canonical.bindingEligibility,
    evidenceReadView: store.createEvidenceReadView({ownerKey: 'run-a', allowedTraces: [{traceId: 'current', traceSide: 'current'}]})});
  const verified = runClaimVerification({conclusionContract: f.canonical.validationContract, preparedEvidence: prepared});
  const assess = (overrides: Partial<Parameters<typeof assessNumericPresentations>[0]> = {}) => assessNumericPresentations({
    contract: f.canonical.validationContract, claims: verified.claimVerificationResult.claimResults, support: verified.claimSupport,
    body: f.canonical.result.conclusion, candidate: f.canonical.projection.candidate!,
    authoredQuoteContext: {expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION, nativeDeclaration: f.native}, ...overrides});
  return {...f, verified, assess};
}

describe('issued native-object quote bindings and material diagnostics', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  it.each(['needs_user_input', 'recommend_full', 'invalid_contract'] as const)(
    'delivers literal V2 conversation text without activating %s', kind => {
      const document = nativeAuthoredDocument();
      document.contract.mode = 'need_input';
      document.bodyParts.push(`\n<!-- smartperfetto:conversation-control ${JSON.stringify({kind,
        question: 'Which trace?', handoff: {question: 'Which trace?', scope: 'Full analysis'}})} -->\n `);
      const input = kind === 'invalid_contract' ? {...document, contract: {...document.contract, mode: 'invalid'}} : document;
      const f = nativeAuthoredFixture(input);
      try {
        const canonical = canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: f.native,
          conversation: {fallbackQuestion: 'Original question'}});
        expect(canonical.conversationOutcome).toEqual({kind: 'answered', message: f.compiled.body, evidence: []});
        expect(canonical.result.conclusion).toBe(f.compiled.body);
        expect(canonical.protocolDiagnostics?.conversation).toMatchObject({status: 'absent', narrative: f.compiled.body,
          machineSegments: [], issues: []});
        expect(canonical.validationContract?.mode).toBe(kind === 'invalid_contract' ? undefined : 'need_input');
        expect(canonical.protocolDiagnostics?.typedJson?.status).toBe(kind === 'invalid_contract' ? 'invalid' : 'valid');
        expect(canonical.bindingEligibility).toBe(kind === 'invalid_contract' ? 'ineligible' : 'eligible');
        expect(f.canonical.conversationOutcome).toBeUndefined();
      } finally {f.cleanup();}
    });

  it('binds repeated text to two original body parts through actual issuer, private projection and canonical proof', async () => {
    const f = await provedNativePresentation();
    try {
      expect(f.verified.claimVerificationResult.claimResults[0].deterministicProof?.status).toBe('proved');
      expect(f.compiled.quoteBindings).toMatchObject([{claimOrdinal: 1, quoteOrdinal: 1}, {claimOrdinal: 1, quoteOrdinal: 2}]);
      const claim = f.canonical.validationContract!.claims![0], presentation = claim.semantics!.numeric!.presentation!;
      expect(readAuthoredQuoteBindings({nativeDeclaration: f.native, expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        body: f.canonical.result.conclusion, claim, presentation})).toMatchObject({status: 'bound', bindings: f.compiled.quoteBindings});
      const assessment = f.assess().get('duration');
      expect(assessment).toMatchObject({status: 'matched', reason: 'display_matches', locations: [
        {start: 6, end: 11}, {start: 19, end: 24}]});
      expect(f.canonical.result.conclusion).toBe('First 10 ms\nSecond 10 ms');
      expect(f.canonical.result.completion?.status).toBe('completed');
      expect(JSON.stringify(f.canonical.result)).not.toMatch(/quoteBindings|partSpans|privateNativeDocument|referenceDictionary/);
    } finally {f.cleanup();}
  });

  it.each(['missing', 'spread', 'json', 'compiler_only', 'stale', 'released'] as const)
    ('does not fall back to global locations for an unavailable %s handle', async failure => {
      const f = await provedNativePresentation();
      try {
        let nativeDeclaration: NativeConclusionDeclaration | undefined = f.native;
        if (failure === 'missing') nativeDeclaration = undefined;
        if (failure === 'spread') nativeDeclaration = {...f.native};
        if (failure === 'json') nativeDeclaration = JSON.parse(JSON.stringify(f.native));
        if (failure === 'compiler_only') nativeDeclaration = {...f.compiled} as unknown as NativeConclusionDeclaration;
        if (failure === 'stale') f.live.active = false;
        if (failure === 'released') f.cleanup();
        expect(f.assess({authoredQuoteContext: {expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION, nativeDeclaration}}).get('duration'))
          .toMatchObject({status: 'not_checked', reason: 'quote_binding_unavailable', locations: []});
      } finally {f.cleanup();}
    });

  it.each(['claim_text', 'assertion', 'reference', 'presentation', 'quote_order'] as const)
    ('rejects changed canonical %s rather than trusting only the claim ID', async mutation => {
      const f = await provedNativePresentation();
      try {
        const contract = structuredClone(f.canonical.validationContract!);
        const claim = contract.claims![0], numeric = claim.semantics!.numeric!;
        if (mutation === 'claim_text') claim.text = 'Changed proposition';
        if (mutation === 'assertion') numeric.value = 11;
        if (mutation === 'reference') claim.references[0].value = 11;
        if (mutation === 'presentation') numeric.presentation!.unit = 's';
        if (mutation === 'quote_order') numeric.presentation!.quotes.reverse();
        expect(f.assess({contract}).get('duration')).toMatchObject({status: 'not_checked', reason: 'quote_binding_unavailable', locations: []});
      } finally {f.cleanup();}
    });

  it.each(['claim_ordinal', 'quote_ordinal', 'span', 'canonical_quote'] as const)
    ('refuses a forged private binding %s at the actual issuer', mutation => {
      expect(() => nativeAuthoredFixture(nativeAuthoredDocument(), {alterCompiled: compiled => {
        const binding = compiled.quoteBindings[0];
        if (mutation === 'claim_ordinal') binding.claimOrdinal = 0;
        if (mutation === 'quote_ordinal') binding.quoteOrdinal = 0;
        if (mutation === 'span') binding.originalSpan.startUtf16++;
        if (mutation === 'canonical_quote') binding.canonicalQuote.text = '11 ms';
      }})).toThrow('authored_final_submission_invalid_input');
    });

  it.each(['prefix', 'append', 'reorder', 'trim'] as const)('does not search or rebase body_part positions after %s', async change => {
    const document = nativeAuthoredDocument();
    if (change === 'trim') {document.bodyParts[0] = '  First '; document.bodyParts.push('  ');}
    const f = await provedNativePresentation(document);
    try {
      let body = f.compiled.body;
      if (change === 'prefix') body = 'Prefix ' + body;
      if (change === 'append') body += ' suffix';
      if (change === 'reorder') body = body.split('\n').reverse().join('\n');
      if (change === 'trim') body = body.trim();
      expect(body).not.toBe(f.compiled.body);
      expect(f.assess({body}).get('duration')).toMatchObject({status: 'not_checked', reason: 'quote_body_changed', locations: []});
    } finally {f.cleanup();}
  });

  it('withdraws part locations after actual privacy projection changes the display body', async () => {
    const document = nativeAuthoredDocument(); document.bodyParts[0] = 'PRIVATE_BODY_CANARY First ';
    const f = await provedNativePresentation(document, {redact: 'PRIVATE_BODY_CANARY'});
    try {
      expect(f.canonical.result.conclusion).not.toContain('PRIVATE_BODY_CANARY');
      expect(f.canonical.result.conclusion).not.toBe(f.compiled.body);
      expect(f.assess().get('duration')).toMatchObject({status: 'not_checked', reason: 'quote_body_changed', locations: []});
    } finally {f.cleanup();}
  });

  it('keeps an issued all-global claim usable after a body change, while the part-bound claim remains unchecked', async () => {
    const document = nativeAuthoredDocument();
    const part = document.contract.claims[0];
    part.semantics!.numeric!.presentation!.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 1, localOccurrence: null}];
    const global = structuredClone(part); global.id = 'global-duration';
    global.semantics!.numeric!.presentation!.quotes = [{kind: 'global', text: '10 ms', occurrence: 1}];
    document.contract.claims.push(global);
    const f = await provedNativePresentation(document);
    try {
      const results = f.assess({body: 'Prefix ' + f.compiled.body});
      expect(results.get('duration')).toMatchObject({status: 'not_checked', reason: 'quote_body_changed', locations: []});
      expect(results.get('global-duration')).toMatchObject({status: 'matched', locations: [{start: 26, end: 31}]});
    } finally {f.cleanup();}
  });

  it('requires the whole mixed presentation binding before evaluating any global quote', async () => {
    const document = nativeAuthoredDocument();
    document.contract.claims[0].semantics!.numeric!.presentation!.quotes[1] = {kind: 'global', text: '10 ms', occurrence: 1};
    const f = await provedNativePresentation(document);
    try {
      expect(f.assess().get('duration')?.status).toBe('matched');
      expect(f.assess({body: 'Prefix ' + f.compiled.body}).get('duration'))
        .toMatchObject({status: 'not_checked', reason: 'quote_body_changed', locations: []});
      expect(f.assess({authoredQuoteContext: {expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION}}).get('duration'))
        .toMatchObject({status: 'not_checked', reason: 'quote_binding_unavailable', locations: []});
    } finally {f.cleanup();}
  });

  it.each(['145 ms', '-45 ms', '45 msec', 'x45 ms', '45 ms/s'])('retains numeric token boundaries for the issued substring in %s', async body => {
    const document = nativeAuthoredDocument();
    document.referenceDictionary[0].value = {kind: 'present', value: 45};
    const claim = document.contract.claims[0]; claim.text = '45 ms';
    claim.semantics!.numeric!.value = 45;
    claim.semantics!.numeric!.presentation!.quotes = [{kind: 'body_part', text: '45 ms', partIndex: 0, localOccurrence: null}];
    document.bodyParts = [body];
    const f = await provedNativePresentation(document, {value: 45});
    try {
      expect(f.verified.claimVerificationResult.claimResults[0].deterministicProof?.status).toBe('proved');
      expect(f.assess().get('duration')).toMatchObject({status: 'not_checked', reason: 'quote_unresolved', locations: []});
    } finally {f.cleanup();}
  });

  it('preserves cross-claim overlap detection on issued original spans', async () => {
    const document = nativeAuthoredDocument();
    document.contract.claims[0].semantics!.numeric!.presentation!.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 1, localOccurrence: null}];
    const second = structuredClone(document.contract.claims[0]); second.id = 'second';
    document.contract.claims.push(second);
    const f = await provedNativePresentation(document);
    try {
      expect(f.assess().get('duration')).toMatchObject({status: 'not_checked', reason: 'binding_conflict'});
      expect(f.assess().get('second')).toMatchObject({status: 'not_checked', reason: 'binding_conflict'});
    } finally {f.cleanup();}
  });

  it('does not turn duplicate claim IDs into an unambiguous presentation binding', async () => {
    const document = nativeAuthoredDocument();
    document.bodyParts = ['10 ms / 10 ms'];
    document.contract.claims[0].semantics!.numeric!.presentation!.quotes = [{kind: 'body_part', text: '10 ms', partIndex: 0, localOccurrence: 0}];
    document.contract.claims.push(structuredClone(document.contract.claims[0]));
    const f = await provedNativePresentation(document);
    try {
      const claim = f.canonical.validationContract!.claims![0];
      expect(readAuthoredQuoteBindings({nativeDeclaration: f.native, expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        body: f.compiled.body, claim, presentation: claim.semantics!.numeric!.presentation!}))
        .toEqual({status: 'unavailable', reason: 'quote_binding_unavailable'});
      expect(f.assess().size).toBe(0);
    } finally {f.cleanup();}
  });

  it('keeps original evidence and proposition gates independently required', async () => {
    const document = nativeAuthoredDocument(); document.contract.claims[0].semantics!.numeric!.value = 11;
    const f = await provedNativePresentation(document);
    try {
      expect(f.verified.claimVerificationResult.claimResults[0].deterministicProof?.status).not.toBe('proved');
      expect(f.assess().get('duration')).toMatchObject({status: 'not_checked', reason: 'proposition_not_proved', locations: []});
      expect(f.canonical.validationContract!.claims![0].semantics!.numeric!.value).toBe(11);
    } finally {f.cleanup();}
  });

  it('reports only bounded numeric v2 material, not native input text or a fabricated documentJson size', () => {
    const document = nativeAuthoredDocument();
    document.bodyParts = ['PRIVATE_BODY 中文 😀 ', {claimText: 'duration'}, ' / ', {claimText: 'duration'}];
    document.referenceDictionary[0].evidenceRefId = 'PRIVATE_REFERENCE';
    const f = nativeAuthoredFixture(document);
    try {
      const snapshot = readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input);
      const diagnostic = buildAuthoredCandidateProtocolDiagnostic(snapshot), material = diagnostic.authoredMaterial;
      expect(diagnostic).toMatchObject({status: 'valid', rawChars: snapshot.rawArguments.length,
        claimCount: 1, semanticClaimCount: 1, sourceBindingCount: 0});
      expect(material).toEqual({representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        rawArgumentsUtf8Bytes: Buffer.byteLength(snapshot.rawArguments), bodyUtf8Bytes: Buffer.byteLength(f.compiled.body),
        bodyUtf16Length: f.compiled.body.length, normalizedNativeDocument: f.compiled.material.nativeDocument,
        normalizedExpanded: f.compiled.material.expanded});
      expect(material).not.toHaveProperty('documentInputUtf8Bytes'); expect(material).not.toHaveProperty('normalizedDocument');
      expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
      expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_|referenceDictionary|privateNativeDocument|quoteBindings|documentJson/);
      for (const invalid of [
        {...material, representationVersion: 'unknown@2'}, {...material, documentInputUtf8Bytes: 1},
        {...material, rawArgumentsUtf8Bytes: Infinity}, {...material, bodyUtf16Length: -1},
        {...material, normalizedNativeDocument: {...f.compiled.material.nativeDocument, secret: 'PRIVATE_FIELD'}},
        {...material, normalizedNativeDocument: {...f.compiled.material.nativeDocument, nodes: 10_001}},
        {...material, normalizedExpanded: {...f.compiled.material.expanded, depth: 25}},
      ]) expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, authoredMaterial: invalid})).toBeUndefined();
    } finally {f.cleanup();}
  });
});


function assistantAuthoredFixture(document = nativeAuthoredDocument(), options: {redact?: string} = {}) {
  const rawAssistantText = ' \n' + JSON.stringify({document}, null, 2) + '\n';
  const nativeDocument = JSON.parse(rawAssistantText).document;
  const compiled = compileAuthoredClaimObject(nativeDocument);
  if (compiled.status !== 'compiled') throw new Error('Assistant source fixture must compile');
  const source = result(compiled.body), live = {active: true, attempt: true};
  const binding = {owner: live, sessionId: source.sessionId, runId: 'run-a', attemptId: 'attempt-a',
    providerPin: 'test-pin', authorizationFingerprint: 'test-scope'};
  const issuer = createAuthoredFinalSubmissionIssuer({binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    sourcePolicy: 'function_or_assistant_json', assertAttemptCurrent: () => {if (!live.attempt) throw new Error('retired');},
    assertCurrent: () => {if (!live.active) throw new Error('revoked');}});
  const dispatch = {dispatchOrdinal: 1, responseId: 'assistant-response', messageId: 'assistant-response'};
  const submission = issueAuthoredFinalSubmission(issuer, {sourceKind: 'assistant_json', ...dispatch, rawAssistantText, nativeDocument, compiled});
  const handoff: AuthoredConclusionSubmission & {input: AuthoredFinalSubmissionAssistantV2ReadInput} = {submission, input: {
    sourceKind: 'assistant_json', binding: {...binding, ...dispatch, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION}, rawAssistantText,
    nativeDocument: structuredClone(nativeDocument), body: compiled.body, rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)}};
  const delivery = contextFor(source);
  delivery.outputOrigin = 'sdk_final'; delivery.finalSubmission = {mode: 'authored_claim_document_v2_dual', outcome: 'submitted'};
  source.outputOrigin = delivery.outputOrigin; source.completion = delivery.completion;
  if (options.redact) registerCodeAwareCanary(source.sessionId, options.redact);
  const projected = finalizeSourceAwareAnalysisResultWithProjection(source, undefined, {context: delivery, authoredSubmission: handoff});
  const context = projected.deliveryContext;
  if (!context || context.entry === 'historical_restore' || !projected.protocolProjection) throw new Error('Expected assistant source projection');
  const token = projected.protocolProjection;
  const native = readConclusionProtocolProjection(token, {result: source, candidate: context.acceptedCandidate, runId: binding.runId});
  const canonical = canonicalizeAnalysisResult(source, {context, nativeDeclaration: native});
  return {source, live, compiled, handoff, context, native, canonical, token, rawAssistantText,
    cleanup: () => {releaseConclusionProtocolProjection(token); clearCodeAwareOutputGuards(source.sessionId);}};
}

describe('issued assistant JSON source projection', () => {
  let restoreClone: (() => void) | undefined;
  beforeEach(() => {restoreClone = installCurrentRealmStructuredCloneForTest();});
  afterEach(() => {restoreClone?.(); restoreClone = undefined;});

  it('uses the original compiled declaration and literal body with an honest SDK origin', () => {
    const document = nativeAuthoredDocument();
    document.bodyParts.push('\n{"literal":"not another declaration"}\n', renderConclusionContractSidecar(declaration()));
    const f = assistantAuthoredFixture(document);
    try {
      expect(f.native.inputKind).toBe('assistant_json');
      if (f.native.inputKind !== 'assistant_json') throw new Error('Expected assistant source');
      expect(f.native.rawAssistantText).toBe(f.rawAssistantText); expect(f.native.body).toBe(f.compiled.body);
      expect(f.native.rawCanonicalPayload).toEqual(f.compiled.rawCanonicalPayload);
      expect(f.native).not.toHaveProperty('rawArguments'); expect(f.native).not.toHaveProperty('raw');
      expect(f.canonical.result.conclusion).toBe(f.compiled.body);
      expect(f.canonical.validationContract?.claims?.map(claim => claim.id)).toEqual(['duration']);
      expect(f.canonical.result.outputOrigin).toBe('sdk_final'); expect(f.canonical.result.completion?.status).toBe('completed');
      expect(hasCurrentAuthoredFinalDelivery(f.canonical.result, f.canonical.deliveryContext!)).toBe(true);
      expect(hasCurrentAuthoredFinalBody(f.canonical.result.conclusion, f.canonical.deliveryContext!)).toBe(true);
      expect(JSON.stringify(f.canonical.result)).not.toMatch(/rawAssistantText|rawArguments|privateNativeDocument|quoteBindings|semanticFrames|partSpans/);
    } finally {f.cleanup();}
  });

  it('reports actual assistant raw character length and compiled triage without function-only material metrics', () => {
    const document = nativeAuthoredDocument(); document.contract.sourceClaimBindings = [];
    const f = assistantAuthoredFixture(document);
    try {
      const snapshot = readAuthoredFinalSubmission(f.handoff.submission, f.handoff.input);
      const diagnostic = buildAuthoredCandidateProtocolDiagnostic(snapshot);
      expect(diagnostic).toMatchObject({rawChars: f.rawAssistantText.length, canonicalChars: f.compiled.body.trim().length,
        claimCount: 1, semanticClaimCount: 1, sourceBindingCount: 0});
      expect(diagnostic).not.toHaveProperty('authoredMaterial'); expect(JSON.stringify(diagnostic)).not.toMatch(/rawArgumentsUtf8Bytes|rawAssistantTextHash|nativeDocument|bodyParts/);
      expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    } finally {f.cleanup();}
  });

  it('retains invalid semantic entries from the issued original instead of parsing protocol-looking body text', () => {
    const document = nativeAuthoredDocument();
    (document.contract.claims[0].semantics!.numeric as any).value = 'not-a-number';
    document.bodyParts.push('\n', renderConclusionContractSidecar(declaration(999)));
    const f = assistantAuthoredFixture(document);
    try {
      expect(f.compiled.canonicalParse.status).toBe('partially_valid');
      expect(f.canonical.protocolDiagnostics?.typedJson?.rawPayload).toEqual(f.compiled.rawCanonicalPayload);
      expect(f.canonical.validationContract?.claims?.[0].valid).toBe(false);
      expect(f.canonical.result.conclusion).toBe(f.compiled.body);
      expect(f.canonical.validationContract?.claims?.[0].semantics?.numeric?.value).not.toBe(999);
    } finally {f.cleanup();}
  });

  it.each(['origin', 'old_v2_mode', 'old_v1_mode', 'missing_submission', 'revoked'] as const)
    ('requires the exact live source/mode/origin pairing: %s', mismatch => {
      const f = assistantAuthoredFixture();
      try {
        const context = f.canonical.deliveryContext;
        if (!context || context.entry === 'historical_restore') throw new Error('Expected live context');
        if (mismatch === 'origin') context.outputOrigin = 'model_tool_arguments';
        if (mismatch === 'old_v2_mode') context.finalSubmission = {mode: 'authored_claim_document_v2', outcome: 'submitted'};
        if (mismatch === 'old_v1_mode') context.finalSubmission = {mode: 'authored_claim_document_v1', outcome: 'submitted'};
        if (mismatch === 'missing_submission') context.finalSubmission = {mode: 'authored_claim_document_v2_dual', outcome: 'missing_submission'};
        if (mismatch === 'revoked') f.live.active = false;
        expect(hasCurrentAuthoredFinalDelivery(f.canonical.result, context)).toBe(false);
        expect(hasCurrentAuthoredFinalBody(f.canonical.result.conclusion, context)).toBe(false);
      } finally {f.cleanup();}
    });

  it('retains the legitimate function lane in dual mode without changing its source kind', () => {
    const f = nativeAuthoredFixture();
    try {
      const context = f.canonical.deliveryContext;
      if (!context || context.entry === 'historical_restore') throw new Error('Expected live context');
      context.finalSubmission = {mode: 'authored_claim_document_v2_dual', outcome: 'submitted'};
      expect(f.native.inputKind).toBe('model_tool_arguments');
      expect(hasCurrentAuthoredFinalDelivery(f.canonical.result, context)).toBe(true);
      context.outputOrigin = 'sdk_final'; expect(hasCurrentAuthoredFinalDelivery(f.canonical.result, context)).toBe(false);
    } finally {f.cleanup();}
  });

  it.each([false, true])('keeps genuine quote bindings and privacy projection independent: redact=%s', redact => {
    const document = nativeAuthoredDocument(); document.bodyParts[0] = 'PRIVATE_ASSISTANT_CANARY First ';
    const f = assistantAuthoredFixture(document, redact ? {redact: 'PRIVATE_ASSISTANT_CANARY'} : {});
    try {
      const claim = f.canonical.validationContract!.claims![0], presentation = claim.semantics!.numeric!.presentation!;
      const quotes = readAuthoredQuoteBindings({nativeDeclaration: f.native, expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        body: f.canonical.result.conclusion, claim, presentation});
      if (redact) {
        expect(f.canonical.result.conclusion).not.toContain('PRIVATE_ASSISTANT_CANARY');
        expect(quotes).toEqual({status: 'unavailable', reason: 'quote_body_changed'});
        expect(f.native.inputKind === 'assistant_json' && f.native.rawAssistantText).toContain('PRIVATE_ASSISTANT_CANARY');
      } else {
        expect(quotes.status).toBe('bound');
        if (quotes.status !== 'bound') throw new Error('Expected original spans');
        expect(quotes.bindings.map(binding => [binding.claimOrdinal, binding.quoteOrdinal])).toEqual([[1, 1], [1, 2]]);
        for (const binding of quotes.bindings) expect(f.canonical.result.conclusion.slice(binding.originalSpan.startUtf16,
          binding.originalSpan.endUtf16)).toBe('10 ms');
      }
      expect(hasCurrentAuthoredFinalDelivery(f.canonical.result, f.canonical.deliveryContext!)).toBe(true);
      expect(f.canonical.validationContract?.claims).toEqual(f.compiled.canonicalParse.contract?.claims);
    } finally {f.cleanup();}
  });

  it('does not restore private source or quote authority from a serialized declaration or disposed token', () => {
    const f = assistantAuthoredFixture();
    const claim = f.canonical.validationContract!.claims![0], presentation = claim.semantics!.numeric!.presentation!;
    try {
      const fake = JSON.parse(JSON.stringify(f.native));
      expect(() => canonicalizeAnalysisResult(f.source, {context: f.context, nativeDeclaration: fake})).toThrow('unissued');
      expect(readAuthoredQuoteBindings({nativeDeclaration: fake, expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        body: f.compiled.body, claim, presentation})).toEqual({status: 'unavailable', reason: 'quote_binding_unavailable'});
      releaseConclusionProtocolProjection(f.token);
      expect(hasCurrentAuthoredFinalDelivery(f.canonical.result, f.canonical.deliveryContext!)).toBe(false);
      expect(readAuthoredQuoteBindings({nativeDeclaration: f.native, expectedVersion: AUTHORED_CLAIM_OBJECT_VERSION,
        body: f.compiled.body, claim, presentation})).toEqual({status: 'unavailable', reason: 'quote_binding_unavailable'});
    } finally {f.cleanup();}
  });
});
