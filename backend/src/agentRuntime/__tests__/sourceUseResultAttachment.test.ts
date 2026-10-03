// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {parseConclusionContractSidecar, renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {
  finalizeSourceAwareAnalysisResult,
  finalizeSourceAwareAnalysisResultWithProjection,
  verifySourceClaimBindings,
  type SourceUseDecisionReader,
} from '../../services/codebase/sourceClaimVerifier';
import type {SourceUseDecisionV1} from '../../services/codebase/sourceUseDecision';
import {sanitizeSourceReference} from '../../services/codebase/sourceUseDecision';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {
  clearAllCodeAwareOutputGuards,
  clearCodeAwareOutputGuards,
  createCodeAwareStreamingTextProjection,
  registerCodeAwareCanary,
  registerOnDemandSourceLookupForEcho,
  revokeCodeAwareOutputGuards,
  sanitizeCodeAwareTextWithReceipt,
} from '../../services/security/codeAwareOutputRegistry';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {assessFinalResultQualityAssessment} from '../../services/finalResultQualityGate';
import {runClaimVerification} from '../../services/verifier/claimVerificationRunner';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {prepareClaimEvidence} from '../../services/evidence/claimEvidencePreparation';
import {createDataEnvelope} from '../../types/dataContract';
import {attachFinalizationContext, takeFinalizationContext} from '../analysisFinalizationContext';
import type {IntentTransportInput, IntentTransportResult} from '../intentTransport';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {finalizeAnalysisResult, type AnalysisFinalizationOwner} from '../../services/finalizeAnalysisResult';
import {
  createRuntimeSourceFinalizationFixture,
  createSourceAuthoredAnalysisResult,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from './sourceFinalizationFixture';

function finalizeSourceResult(
  result: AnalysisResult,
  sourceUse: SourceUseDecisionReader | undefined,
): AnalysisResult {
  return finalizeSourceAwareAnalysisResult(result, sourceUse);
}

function plainResult(sessionId: string): AnalysisResult {
  return {
    sessionId,
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: 'ordinary trace-only conclusion',
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 10,
  };
}

describe('written source locations at shared finalization', () => {
  afterEach(() => clearAllCodeAwareOutputGuards());

  async function locationFixture(mode: 'absent' | 'empty' | 'tuple_mismatch' | 'semantic_unavailable' | 'privacy' | 'changed_ledger') {
    const fixture = createRuntimeSourceFinalizationFixture({createMcpServer: createClaudeMcpServer,
      sessionId: `source-location-optional-${mode}`});
    try {
      const {decision, reference} = await fixture.executeProviderSourceLookup();
      const source = {sourceReferenceId: reference.id, filePath: reference.filePath,
        lineRange: {...reference.lineRange!}};
      if (mode === 'tuple_mismatch') source.lineRange.end++;
      const body = `This lookup returned ${source.filePath}:L${source.lineRange.start}-L${source.lineRange.end}.`;
      const declaration: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
        conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
        claims: [{id: 'location', kind: 'identity', text: body, references: [], semantics: {
          schemaVersion: 'claim_semantics@1', predicate: 'source.location', polarity: 'affirmed', discourse: 'asserted',
          quantifier: 'one', modality: 'certain', scope: {population: 'codebase'},
        }}], ...(mode === 'empty' ? {sourceClaimBindings: []} : {})};
      const result = plainResult(fixture.sessionId);
      result.conclusion = `${body}\n${renderConclusionContractSidecar(declaration)}`;
      const candidate = {runId: 'location-run', attemptId: 'location-attempt', candidateRef: 'location-candidate',
        conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
      const projection = finalizeSourceAwareAnalysisResultWithProjection(result, fixture.sourceUse, {
        context: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final', completion: {
          ...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed',
        }},
      });
      const dispatch = jest.fn(async (input: IntentTransportInput): Promise<IntentTransportResult> => {
        if (mode === 'semantic_unavailable') return {status: 'unavailable', reason: 'provider_error'};
        // The finalizer owns canonical formatting; answer against its actual request body.
        const request = JSON.parse(input.prompt.split('\n').pop()!) as {request: string; body: string};
        expect(request.request).toBe('final_semantic_request@1');
        const start = request.body.indexOf(body);
        expect(start).toBeGreaterThanOrEqual(0);
        return {status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
          bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: request.body.length}]},
          claims: [{claimId: 'location', consistency: 'consistent', issues: [],
            contentLocations: [{start, end: start + body.length, text: body}]}], omissions: [], requirements: [],
        })};
      });
      const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'source-location-optional'});
      const sourceScope = fixture.sourceUse.getSourceExecutionScope?.();
      const traceId = `trace-${fixture.sessionId}`;
      attachFinalizationContext(result, {runId: candidate.runId, sessionId: result.sessionId, deadlineMs: Date.now() + 10_000,
        strategyRegistry: registry, traceIdentity: {currentTraceId: traceId}, sourceUse: decision, sourceScope,
        protocolProjection: projection.protocolProjection, deliveryContext: projection.deliveryContext!,
        turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
          taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
          deliverable: 'answer', evidenceAccess: 'existing_only'},
        evidenceReadView: new ArtifactStore().createEvidenceReadView({allowedTraces: [{traceId, traceSide: 'current'}], ownerKey: candidate.runId}),
        dispatchText: dispatch});
      const context = takeFinalizationContext(result)!;
      const owner: AnalysisFinalizationOwner = {runId: candidate.runId, signal: new AbortController().signal,
        isCurrent: () => true, assertAuthorized: () => {}, analysisContextFingerprint: sourceScope?.analysisContextFingerprint};
      const query = 'Where is the returned source location?';
      if (mode === 'privacy') registerCodeAwareCanary(result.sessionId, query);
      if (mode === 'changed_ledger') result.sourceUseDecision!.references = [];
      return {result, declaration, decision, reference, dispatch, context, cleanup: fixture.cleanup,
        run: () => finalizeAnalysisResult({result, context, owner, query})};
    } catch (error) {
      fixture.cleanup();
      throw error;
    }
  }

  test.each(['absent', 'empty'] as const)('matches a written location against the run with %s bindings, proving nothing about the code', async mode => {
    const fixture = await locationFixture(mode);
    try {
      const finalized = await fixture.run();
      expect(finalized.semanticAssessment?.reason).toBeUndefined();
      expect(finalized.semanticAssessment).toMatchObject({status: 'checked', consistency: 'consistent'});
      // No finite rule proves a source location any longer.
      expect(finalized.result.claimVerificationResult?.claimResults.some(claim => claim.status === 'verified')).toBe(false);
      // The location was returned by this run's read; the unbound claim stays unverified.
      expect(finalized.result.sourceClaimVerificationResult).toMatchObject({schemaVersion: 'source_claim_verifier@2',
        status: 'partial', claims: [{claimId: 'location', status: 'unbound'}],
        citations: [{status: 'verified_body', sourceReferenceId: fixture.reference.id}]});
      expect(finalized.result.sourceUseDecision).toEqual(fixture.decision);
      expect(finalized.result.conclusionContract?.sourceClaimBindings ?? []).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(fixture.declaration, 'sourceClaimBindings')).toBe(mode === 'empty');
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(finalized.result)).not.toContain(SOURCE_FINALIZATION_RAW_SOURCE);
    } finally {fixture.cleanup();}
  });

  test.each(['tuple_mismatch', 'semantic_unavailable', 'privacy'] as const)('verifies no location claim through %s', async mode => {
    const fixture = await locationFixture(mode);
    try {
      const finalized = await fixture.run();
      expect(finalized.result.claimVerificationResult?.passed).toBe(false);
      expect(finalized.result.claimVerificationResult?.claimResults.some(claim => claim.status === 'verified')).toBe(false);
      expect(finalized.result.sourceClaimVerificationResult?.status).not.toBe('passed');
      if (mode === 'privacy') expect(fixture.dispatch).not.toHaveBeenCalled();
    } finally {fixture.cleanup();}
  });

  test('rejects a changed current source ledger before invoking semantic review', async () => {
    const fixture = await locationFixture('changed_ledger');
    try {
      await expect(fixture.run()).rejects.toThrow('projection_mismatch');
      expect(fixture.dispatch).not.toHaveBeenCalled();
    } finally {fixture.cleanup();}
  });
});

describe('runtime source finalization behavior', () => {
  test.each(['knowledge_only_failure', 'empty_revoked'] as const)('keeps privacy projection complete for %s', scenario => {
    const result = plainResult('protocol-private-terminal');
    result.conclusion = scenario === 'empty_revoked' ? '' : 'PRIVATE_TERMINAL_CANARY';
    result.terminationMessage = 'PRIVATE_TERMINAL_CANARY';
    const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
    registerCodeAwareCanary(result.sessionId, 'PRIVATE_TERMINAL_CANARY');
    if (scenario === 'empty_revoked') revokeCodeAwareOutputGuards(result.sessionId);
    const projection = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {
      context: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
        completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'failed'}},
    });
    expect(JSON.stringify(projection.result)).not.toContain('PRIVATE_TERMINAL_CANARY');
    if (scenario === 'empty_revoked') expect(projection.conclusionProjection.disposition).toBe('replaced');
  });

  test.each([
    {filePath: 'src/Probe.kt', snippet: 'const schema = "conclusion_contract_v1";', text: 'The measured value is 49.'},
    {filePath: 'src/Probe"Data.kt', snippet: 'const marker = "synthetic_source_marker_long_name";',
      text: 'The synthetic_source_marker_long_name value is 49.'},
  ])('projects source echoes without corrupting the machine declaration in $filePath', input => {
    const result = plainResult('protocol-projection-regression');
    const reference = sanitizeSourceReference({referenceId: 'read-probe', codebaseId: 'app-source',
      filePath: input.filePath, lineRange: {start: 1, end: 1}, lookupKind: 'body'})!;
    registerOnDemandSourceLookupForEcho(result.sessionId, [{...reference, id: 'read-probe', text: input.snippet}]);
    result.conclusion = `The measured value is 49.\n${renderConclusionContractSidecar({
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'measured', kind: 'numeric',
        text: input.text, references: [{evidenceRefId: 'data:probe', column: 'value', rowIndex: 0, value: 49}]}],
      sourceClaimBindings: [{claimId: 'measured',
        sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['data:probe']}],
    })}`;
    const projected = finalizeSourceAwareAnalysisResultWithProjection(result, {getSourceUseDecision: () => ({
      schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send', selectedCodebaseIds: ['app-source'],
      status: 'corroborated', attemptedTools: ['read_codebase_file'], queriedCodebaseIds: ['app-source'],
      usedCodebaseIds: ['app-source'], coverageComplete: true, references: [reference],
    })});
    expect(parseConclusionContractSidecar(projected.result.conclusion).status).toBe('valid');
    expect(projected.result.conclusion).not.toContain('synthetic_source_marker_long_name');
  });

  test('leaves source-free results byte-for-behavior unchanged', () => {
    const result = plainResult('session-source-free');
    const before = structuredClone(result);

    expect(finalizeSourceResult(result, undefined)).toBe(result);
    expect(result).toEqual(before);
  });

  test('fails closed over fabricated source provenance when no current-run accessor exists', () => {
    const sourceReference = sanitizeSourceReference({
      referenceId: 'fabricated-lookup',
      codebaseId: 'fabricated-app',
      filePath: 'src/Fabricated.kt',
      lookupKind: 'body',
    })!;
    const fabricatedDecision = {
      schemaVersion: 'source_use_decision@1' as const,
      codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['fabricated-app'],
      status: 'corroborated' as const,
      attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['fabricated-app'],
      usedCodebaseIds: ['fabricated-app'],
      references: [{
        ...sourceReference,
        rootPath: '/Users/chris/SECRET_ROOT_CANARY',
        snippet: 'SECRET_SNIPPET_CANARY',
        query: 'SECRET_QUERY_CANARY',
      } as any],
    };
    const result = plainResult('session-fabricated-no-accessor');
    result.sourceUseDecision = fabricatedDecision;
    result.sourceReferences = fabricatedDecision.references;
    result.sourceClaimVerificationResult = {
      schemaVersion: 'source_claim_verifier@1',
      status: 'passed',
      bindings: [],
      issues: [],
    };
    result.conclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{id: 'claim-fabricated', text: 'trace fact', references: []}],
      sourceUseDecision: fabricatedDecision,
      sourceReferences: fabricatedDecision.references,
      sourceClaimBindings: [{
        claimId: 'claim-fabricated',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['trace-evidence-fabricated'],
        reason: 'SECRET_BINDING_REASON_CANARY',
      } as any],
      uncertainties: [],
      nextSteps: [],
    };

    expect(finalizeSourceResult(result, undefined)).toBe(result);

    expect(result.sourceUseDecision).toBeUndefined();
    expect(result.sourceReferences).toBeUndefined();
    expect(result.sourceClaimVerificationResult).toBeUndefined();
    expect(result.conclusionContract).not.toHaveProperty('sourceUseDecision');
    expect(result.conclusionContract).not.toHaveProperty('sourceReferences');
    expect(result.conclusionContract).not.toHaveProperty('sourceClaimBindings');
    expect(JSON.stringify(result)).not.toContain('SECRET_');
    expect(JSON.stringify(result)).not.toContain('/Users/chris');
  });

  test.each(['pending', 'attempted'] as const)(
    'keeps %s source usage as audit state without overriding native completion',
    status => {
      const result = plainResult(`session-${status}`);
      const decision: SourceUseDecisionV1 = {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['codebase-task7'],
        status,
        attemptedTools: status === 'attempted' ? ['search_codebase'] : [],
        queriedCodebaseIds: status === 'attempted' ? ['codebase-task7'] : [],
        usedCodebaseIds: [],
        references: [],
      };

      finalizeSourceResult(result, {getSourceUseDecision: () => decision});

      expect(result).toMatchObject({
        success: true,
        sourceUseDecision: expect.objectContaining({status}),
      });
      expect(result.partial).toBeUndefined();
      expect(result.terminationReason).toBeUndefined();
      expect(result.terminationMessage).toBeUndefined();
      expect(result.sourceClaimVerificationResult?.status).not.toBe('passed');
    },
  );

  test('uses a real zero-index MCP search/read transition and sanitizes every returned model surface', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId: 'session-real-handler-finalization',
    });
    try {
      expect(fixture.sourceUse.getSourceUseDecision()?.status).toBe('pending');
      const {decision, reference} = await fixture.executeProviderSourceLookup();
      expect(['corroborated', 'search_incomplete']).toContain(decision.status);
      expect(decision).toEqual(expect.objectContaining({
        attemptedTools: expect.arrayContaining(['search_codebase', 'read_codebase_file']),
        queriedCodebaseIds: [fixture.codebaseId],
        usedCodebaseIds: [fixture.codebaseId],
      }));
      expect(reference).toEqual(expect.objectContaining({
        codebaseId: fixture.codebaseId,
        filePath: 'src/Task7Source.kt',
        lookupKind: 'body',
      }));

      const result = createSourceAuthoredAnalysisResult(fixture.sessionId);
      const finalized = finalizeSourceResult(result, fixture.sourceUse);
      const serialized = JSON.stringify(finalized);

      expect(finalized.success).toBe(true);
      expect(finalized.sourceUseDecision).toEqual(decision);
      expect(finalized.sourceReferences).toEqual(decision.references);
      expect(serialized).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(serialized).not.toContain(SOURCE_FINALIZATION_RAW_SOURCE);
      expect(finalized.findings[0]?.id).toBe('finding-task7');
      expect(finalized.hypotheses[0]?.id).toBe('hypothesis-task7');
      expect((finalized.findings[0]?.details as {traceId?: string}).traceId).toBe('trace-task7');

      const answer = projectCodeAwareStreamingUpdate(
        fixture.sessionId,
        {type: 'answer_token', content: SOURCE_FINALIZATION_RAW_SOURCE, timestamp: 1},
        true,
        'en',
      );
      const conclusion = projectCodeAwareStreamingUpdate(
        fixture.sessionId,
        {
          type: 'conclusion',
          content: {conclusion: SOURCE_FINALIZATION_RAW_SOURCE, success: true},
          timestamp: 2,
        },
        true,
        'en',
      );
      expect(JSON.stringify({answer, conclusion})).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(answer?.content).toEqual({suppressed: true});
    } finally {
      fixture.cleanup();
    }
  });

  test('does not reuse a terminal accessor when the next run has no source selection', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId: 'session-terminal-run',
    });
    try {
      const {decision} = await fixture.executeProviderSourceLookup();
      const terminal = finalizeSourceResult(plainResult(fixture.sessionId), fixture.sourceUse);
      const next = plainResult('session-source-off-run');
      const before = structuredClone(next);

      finalizeSourceResult(next, {getSourceUseDecision: () => undefined});

      expect(terminal.sourceUseDecision).toEqual(decision);
      expect(next).toEqual(before);
      expect(next.sourceUseDecision).toBeUndefined();
      expect(next.sourceReferences).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });
});

describe('source finalization projection authority', () => {
  afterEach(() => clearAllCodeAwareOutputGuards());

  function sourceUse(): SourceUseDecisionReader {
    return {getSourceUseDecision: () => ({schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['source-current'], status: 'not_needed', attemptedTools: [], queriedCodebaseIds: [],
      usedCodebaseIds: [], references: []})};
  }

  function contextFor(result: AnalysisResult, status: AnalysisCompletion['status'] = 'completed'):
    Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> {
    const candidate = {candidateRef: 'native-a', runId: 'run-a', attemptId: 'attempt-a',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
    return {entry: 'new_finalization', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status},
      turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-a',
        taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
        deliverable: 'answer', evidenceAccess: 'read_new'}};
  }

  test.each(['completed', 'incomplete', 'unknown'] as const)('redaction preserves native %s without upgrading it', status => {
    const result = plainResult('receipt-redaction');
    result.conclusion = 'Before PRIVATE_CANARY after';
    registerCodeAwareCanary(result.sessionId, 'PRIVATE_CANARY');
    const original = contextFor(result, status);
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, sourceUse(), {context: original});
    expect(finalized.result).toBe(result);
    expect(finalized.conclusionProjection.disposition).toBe('redacted');
    expect(finalized.deliveryContext?.entry).toBe('new_finalization');
    if (finalized.deliveryContext?.entry !== 'new_finalization') throw new Error('Missing projected context');
    expect(finalized.deliveryContext.completion?.status).toBe(status);
    expect(finalized.deliveryContext.acceptedCandidate.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    expect(finalized.deliveryContext.acceptedCandidate.candidateRef).not.toBe(original.acceptedCandidate.candidateRef);
    expect(assessFinalResultQualityAssessment({result, context: original}).assurance.completion).toBe('not_checked');
    expect(assessFinalResultQualityAssessment({result, context: finalized.deliveryContext}).assurance.completion)
      .toBe(status === 'completed' ? 'passed' : status === 'incomplete' ? 'failed' : 'not_checked');
    expect(JSON.stringify(result)).not.toContain(finalized.conclusionProjection.inputFingerprint);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });

  test.each(['', 'nonempty native answer'])('keeps actual streaming replacement incomplete for native body %j', nativeBody => {
    const result = plainResult('receipt-native-replaced');
    result.conclusion = nativeBody;
    const context = contextFor(result, nativeBody ? 'completed' : 'unknown');
    revokeCodeAwareOutputGuards(result.sessionId);
    const priorProjection = createCodeAwareStreamingTextProjection(result.sessionId, 'answer').projectCompleteWithReceipt(nativeBody);
    result.conclusion = priorProjection.text;
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, sourceUse(), {priorProjection, context});
    expect(finalized.conclusionProjection.disposition).toBe('replaced');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback'});
    if (finalized.deliveryContext?.entry !== 'new_finalization') throw new Error('Missing projected context');
    expect(finalized.deliveryContext.completion?.status).toBe('unknown');
    expect(assessFinalResultQualityAssessment({result, context: finalized.deliveryContext}).assurance.completion).toBe('failed');
  });

  test('retains replacement across a preserved second stage without a source accessor', () => {
    const result = plainResult('receipt-two-stage');
    const context = contextFor(result);
    revokeCodeAwareOutputGuards(result.sessionId);
    const priorProjection = createCodeAwareStreamingTextProjection(result.sessionId, 'answer').projectCompleteWithReceipt(result.conclusion);
    result.conclusion = priorProjection.text;
    clearCodeAwareOutputGuards(result.sessionId);
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {priorProjection, context});
    expect(finalized.conclusionProjection.disposition).toBe('replaced');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback'});
    expect(result.completion?.status).toBe('unknown');
    const again = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {
      priorProjection: finalized.conclusionProjection, context: finalized.deliveryContext,
    });
    expect(again.conclusionProjection.disposition).toBe('replaced');
    expect(result.completion?.status).toBe('unknown');
  });

  test('does not renew native proof from a copied or unrelated projection receipt', () => {
    const result = plainResult('receipt-untrusted');
    const context = contextFor(result);
    const issued = sanitizeCodeAwareTextWithReceipt(undefined, 'different safe body');
    result.conclusion = issued.text;
    const priorProjection = {...issued, disposition: 'redacted' as const,
      inputFingerprint: context.acceptedCandidate.conclusionFingerprint};
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {priorProjection, context});
    expect(finalized.conclusionProjection.disposition).toBe('preserved');
    expect(assessFinalResultQualityAssessment({result, context: finalized.deliveryContext}).assurance.completion).toBe('not_checked');
  });

  test('invalidates evidence proof when only structured claims are projected', () => {
    const result = plainResult('receipt-claim-only');
    result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
      clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'claim-a', text: 'PRIVATE_CLAIM_CANARY', references: []}]};
    const context = contextFor(result);
    context.evidenceFingerprint = 'evidence-a';
    context.claimVerificationBinding = {candidate: context.acceptedCandidate, evidenceFingerprint: 'evidence-a',
      claimsFingerprint: analysisDeliveryFingerprint(result.conclusionContract.claims), verificationFingerprint: 'verification-a'};
    context.sourceVerificationBinding = {...context.claimVerificationBinding, sourceUseFingerprint: 'source-a',
      conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract)};
    context.evidenceRenderedProof = {kind: 'verified_facts', candidate: context.acceptedCandidate, claimIds: ['claim-a'],
      claimsFingerprint: context.claimVerificationBinding.claimsFingerprint, verificationFingerprint: 'verification-a', evidenceFingerprint: 'evidence-a'};
    context.reportAssessment = {schemaVersion: 1, status: 'checked', requirements: [], binding: {
      ...context.acceptedCandidate, conclusionContractFingerprint: analysisDeliveryFingerprint(result.conclusionContract),
      evidenceFingerprint: 'evidence-a', registryFingerprint: 'registry-a', requirementsFingerprint: 'requirements-a',
      intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
    }};
    result.reportAssessment = context.reportAssessment;
    result.deliveryAssurance = {schemaVersion: 1, entry: 'new_finalization', completion: 'passed',
      claims: 'passed', source: 'passed', identity: 'passed', report: 'passed'};
    registerCodeAwareCanary(result.sessionId, 'PRIVATE_CLAIM_CANARY');
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, sourceUse(), {context});
    expect(finalized.conclusionProjection.disposition).toBe('preserved');
    expect(finalized.deliveryContext).toMatchObject({completion: context.completion});
    if (finalized.deliveryContext?.entry !== 'new_finalization') throw new Error('Missing projected context');
    expect(finalized.deliveryContext.claimVerificationBinding).toBeUndefined();
    expect(finalized.deliveryContext.sourceVerificationBinding).toBeUndefined();
    expect(finalized.deliveryContext.evidenceRenderedProof).toBeUndefined();
    expect(finalized.deliveryContext.reportAssessment).toBeUndefined();
    expect(result.reportAssessment).toBeUndefined();
    expect(result.deliveryAssurance).toBeUndefined();
    expect(JSON.stringify(result.conclusionContract)).not.toContain('PRIVATE_CLAIM_CANARY');
  });

  test('keeps real failed verification observable after revoked output replaces its private message', async () => {
    const result = plainResult('receipt-failed-verification');
    result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
      clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'claim-a', kind: 'numeric',
        text: 'Measured duration is 999 ms.', references: [{evidenceRefId: 'data:a', rowIndex: 0, column: 'dur_ms', value: 999}]}]};
    const envelope = createDataEnvelope({columns: ['dur_ms'], rows: [[12.5]]},
      {type: 'sql_result', source: 'execute_sql', title: 'Duration', evidenceRefId: 'data:a',
        traceId: 'trace-a', traceSide: 'current'});
    const store = new ArtifactStore();
    store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
      dur_ms: {unit: 'ms', origin: {kind: 'native_producer', definitionFingerprint: 'test-duration-v1'}},
    }), {meta: envelope.meta, display: envelope.display});
    const preparedEvidence = await prepareClaimEvidence({conclusionContract: result.conclusionContract,
      bindingEligibility: 'eligible', evidenceReadView: store.createEvidenceReadView({
        allowedTraces: [{traceId: 'trace-a', traceSide: 'current'}], ownerKey: result.sessionId,
      })});
    const verified = runClaimVerification({conclusionContract: result.conclusionContract,
      dataEnvelopes: [envelope], preparedEvidence, bindingEligibility: 'eligible'});
    result.claimVerificationResult = verified.claimVerificationResult;
    result.claimSupport = verified.claimSupport;
    expect(result.claimVerificationResult.status).toBe('failed');
    result.claimVerificationResult.issues[0].message += ' PRIVATE_ISSUE_CANARY';
    result.conclusionContract.sourceClaimBindings = [{claimId: 'claim-a', mechanismStatus: 'compatible',
      sourceReferenceIds: ['fabricated-reference'], traceEvidenceRefIds: []}];
    result.sourceClaimVerificationResult = verifySourceClaimBindings({conclusionContract: result.conclusionContract,
      actualSourceUseDecision: sourceUse().getSourceUseDecision()});
    expect(result.sourceClaimVerificationResult.status).toBe('failed');
    result.sourceClaimVerificationResult.issues[0].message += ' PRIVATE_SOURCE_ISSUE_CANARY';
    const context = contextFor(result);
    revokeCodeAwareOutputGuards(result.sessionId);
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, sourceUse(), {context});
    expect(result.claimVerificationResult?.status).toBe('failed');
    expect(result.claimVerificationResult?.claimResults[0].status).toBe('unsupported');
    expect(result.claimVerificationResult?.issues[0].severity).toBe('error');
    expect(result.sourceClaimVerificationResult?.status).toBe('failed');
    expect(result.sourceClaimVerificationResult?.issues.some(issue => issue.severity === 'error')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ISSUE_CANARY');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_ISSUE_CANARY');
    expect(assessFinalResultQualityAssessment({result, context: finalized.deliveryContext}).assurance.claims).toBe('failed');
  });

  test('leaves a literal placeholder and source-free object unchanged without a guard replacement', () => {
    const result = plainResult('receipt-literal');
    result.conclusion = '[PRIVATE_OUTPUT_SUPPRESSED]';
    const before = structuredClone(result);
    const finalized = finalizeSourceAwareAnalysisResultWithProjection(result, undefined);
    expect(finalized.result).toBe(result);
    expect(result).toEqual(before);
    expect(finalized.conclusionProjection.disposition).toBe('preserved');
  });

  test.each(['no_accessor', 'changed_source_and_claims'] as const)('drops a failed source sidecar after %s', nextRun => {
    const oldContract: NonNullable<AnalysisResult['conclusionContract']> = {
      schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
      evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'old-claim', text: 'Old fact', references: []}],
      sourceClaimBindings: [{claimId: 'old-claim', mechanismStatus: 'compatible',
        sourceReferenceIds: ['unreturned-old-reference'], traceEvidenceRefIds: []}],
    };
    const failed = verifySourceClaimBindings({conclusionContract: oldContract,
      actualSourceUseDecision: sourceUse().getSourceUseDecision()});
    expect(failed.status).toBe('failed');
    const result = plainResult(`receipt-stale-source-${nextRun}`);
    result.sourceClaimVerificationResult = failed;
    result.conclusionContract = {...oldContract, claims: [{id: 'new-claim', text: 'Current fact', references: []}],
      sourceClaimBindings: []};
    const newSource: SourceUseDecisionReader = {getSourceUseDecision: () => ({
      ...sourceUse().getSourceUseDecision()!, selectedCodebaseIds: ['different-source'],
    })};
    finalizeSourceAwareAnalysisResultWithProjection(result, nextRun === 'no_accessor' ? undefined : newSource);
    expect(result.sourceClaimVerificationResult).toBeUndefined();
    expect(result.conclusionContract?.claims?.[0].id).toBe('new-claim');
  });
});
