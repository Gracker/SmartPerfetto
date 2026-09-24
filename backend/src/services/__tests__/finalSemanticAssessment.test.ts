// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {runInNewContext} from 'node:vm';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {ConclusionContract} from '../../agent/core/conclusionContract';
import {attachFinalizationContext, takeFinalizationContext, type RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import type {IntentTransportInput, IntentTransportResult} from '../../agentRuntime/intentTransport';
import {buildStrategyRegistrySnapshotFromDefinitions, loadPromptTemplate, type StrategyDefinition} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint, type AnalysisReportRequirement, type AnalysisCaseRetrievalState} from '../../types/analysisDelivery';
import {assessFinalSemantics, buildFinalSemanticPrompt, FINAL_SEMANTIC_INPUT_BYTE_LIMIT,
  type FinalSemanticAssessmentInput} from '../finalSemanticAssessment';
import type {AnalysisInvestigationRequirement} from '../../types/analysisInvestigation';
import {resolveAnalysisInvestigationRequirements} from '../../agentRuntime/analysisInvestigationRequirements';
import {compactSemanticSourceSnapshot} from '../evidence/semanticSourceSnapshot';
import type {AnalysisRunSelection} from '../../agentRuntime/analysisRunSpec';

jest.mock('../../agentv3/strategyLoader', () => {
  const actual = jest.requireActual<typeof import('../../agentv3/strategyLoader')>('../../agentv3/strategyLoader');
  return {...actual, loadPromptTemplate: jest.fn(actual.loadPromptTemplate)};
});

const contexts: RuntimeFinalizationContext[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  jest.useRealTimers();
});
const span = (body: string, start = 0, end = body.length) => ({start, end, text: body.slice(start, end)});

function fixture(options: {
  body?: string;
  requirements?: AnalysisReportRequirement[];
  scope?: 'bounded_question' | 'scene_wide';
  deliverable?: 'answer' | 'report';
  caseRetrieval?: AnalysisCaseRetrievalState;
  deadlineMs?: number;
  dispatch?: (input: IntentTransportInput) => Promise<IntentTransportResult>;
  investigationRequirements?: AnalysisInvestigationRequirement[];
  selection?: AnalysisRunSelection;
} = {}) {
  const body = options.body ?? 'Frame A took 9 ms.';
  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', bindingEligibility: 'eligible',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{
      id: 'claim-a', text: body, kind: 'numeric', references: [{evidenceRefId: 'ev-1', rowIndex: 0, column: 'dur_ms', value: 9}],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.literal', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows'},
        numeric: {operator: 'eq', value: 9, unit: 'ms'}},
    }],
  };
  const requirements = options.requirements ?? [];
  const strategy: StrategyDefinition = {
    scene: 'general', classificationDescription: 'General performance interpretation.', strategyKind: 'normal',
    priority: 1, effort: 'low', keywords: [], requiredCapabilities: [], optionalCapabilities: [],
    phaseHints: [], planTemplate: null, verifierMisdiagnosisPatterns: [], content: 'Scene context.', detailSections: [],
    sourcePath: '/fixtures/general.strategy.md', finalReportContract: {requiredSections: requirements.map(requirement => ({
      ...requirement, triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []},
    }))},
    ...(options.investigationRequirements ? {investigationContract: {schemaVersion: 1 as const,
      profileRefs: [], requirements: options.investigationRequirements}} : {}),
  };
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [strategy], overlayGeneration: 'semantic-test'});
  const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(body)};
  const result: AnalysisResult = {sessionId: 'session', conclusion: body, success: true,
    confidence: 0, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
  const reply = {
    schemaVersion: 'final_semantic_response@1',
    bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
    claims: [{claimId: 'claim-a', consistency: 'consistent', contentLocations: [span(body)], issues: [] as unknown[]}],
    omissions: [] as unknown[],
    requirements: requirements.map(requirement => ({requirementId: requirement.id, applicability: 'applicable', coverage: 'covered',
      contentLocations: [span(body)], claimIds: ['claim-a']})),
  };
  const dispatch = jest.fn(options.dispatch ?? (async (_input: IntentTransportInput): Promise<IntentTransportResult> =>
    ({status: 'ok', text: JSON.stringify(reply)})));
  const reads = jest.fn(async () => []);
  attachFinalizationContext(result, {
    runId: 'run', sessionId: result.sessionId, deadlineMs: options.deadlineMs ?? Date.now() + 10_000,
    strategyRegistry: registry,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: options.investigationRequirements ? 'investigation' : 'fact', sceneId: 'general', scope: options.scope ?? 'bounded_question', recommendedComplexity: 'full',
      deliverable: options.deliverable ?? (requirements.length ? 'report' : 'answer'), evidenceAccess: 'existing_only'},
    traceIdentity: {currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'},
    selection: options.selection,
    deliveryContext: {entry: 'new_finalization', acceptedCandidate: candidate},
    evidenceReadView: {resolveReferences: reads}, dispatchText: dispatch,
  });
  const context = takeFinalizationContext(result)!;
  contexts.push(context);
  const controller = new AbortController();
  const input: FinalSemanticAssessmentInput = {context, canonicalCandidate: candidate, signal: controller.signal,
    snapshot: {inputCoverage: 'complete', declarationBindingEligibility: 'eligible', query: 'Explain this frame.', body, conclusionContract: contract,
      evidenceSnapshot: {schemaVersion: 'prepared_claim_evidence@1', reads: [{ref: 'ev-1', rows: [[9]], unit: 'ms'}]},
      ...(options.selection ? {selectionScope: options.selection} : {}),
      ...(requirements.length || options.deliverable === 'report' ? {reportRequirements: {
        sceneId: 'general', registryFingerprint: registry.registryFingerprint, requirements,
      }} : {}), ...(options.caseRetrieval ? {caseRetrieval: options.caseRetrieval} : {})}};
  if (options.investigationRequirements) input.snapshot.investigationRequirements = resolveAnalysisInvestigationRequirements({
    intent: context.turnIntent, strategyRegistry: registry});
  return {input, reply, dispatch, reads, controller, contract, candidate};
}

function assembledPayload(run: ReturnType<typeof fixture>): any {
  const assembled = buildFinalSemanticPrompt({snapshot: run.input.snapshot, intent: run.input.context.turnIntent,
    traceIdentity: run.input.context.traceIdentity,
    registryFingerprint: run.input.context.strategyRegistry.registryFingerprint});
  expect(assembled).toBeDefined();
  return JSON.parse(assembled!.prompt.slice(assembled!.prompt.lastIndexOf('\n\n{') + 2));
}

function useV4(run: ReturnType<typeof fixture>): any[] {
  run.reply.schemaVersion = 'final_semantic_response@4';
  Object.assign(run.reply, {investigation: []});
  const entries = assembledPayload(run).contentLocationCatalog?.entries;
  expect(entries).toBeDefined();
  return entries;
}

describe('versioned investigation semantic coverage', () => {
  function investigationFixture() {
    const run = fixture({scope: 'scene_wide', investigationRequirements: [{id: 'system-frequency', domain: 'cpu_frequency',
      description: 'Explain observed frequency or the precise missing evidence.', required: true,
      evidenceMetrics: ['system.cpu.frequency.time_weighted']}]});
    run.reply.schemaVersion = 'final_semantic_response@3';
    run.reply.claims[0].contentLocations = [{text: run.input.snapshot.body}] as any;
    const row = {requirementId: 'system-frequency', applicability: 'applicable', coverage: 'covered',
      contentLocations: [{text: run.input.snapshot.body}], evidenceRecordIds: [] as string[], scopeMatch: 'unknown', evidenceStatus: 'not_checked'};
    Object.assign(run.reply, {investigation: [row]});
    return {...run, row};
  }

  it('reviews answer obligations in the existing one-call request without new evidence reads', async () => {
    const run = investigationFixture();
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'checked', coverage: {report: 'not_applicable'},
      investigation: {status: 'checked', requirements: [{requirementId: 'system-frequency', evidenceStatus: 'not_checked'}]}});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.reads).not.toHaveBeenCalled();
  });

  it('keeps old response protocols readable without certifying investigation coverage', async () => {
    const run = fixture({investigationRequirements: [{id: 'system-frequency', domain: 'cpu_frequency', description: 'Frequency', required: true}]});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', investigation: {status: 'not_checked', requirements: []}});
  });

  it.each(['omitted', 'duplicate', 'unknown_id', 'unknown_record', 'empty_location', 'waiver', 'observed_without_record', 'report_claim_ids'])(
    'rejects %s investigation assertions', async kind => {
      const run = investigationFixture();
      if (kind === 'omitted') Object.assign(run.reply, {investigation: []});
      if (kind === 'duplicate') Object.assign(run.reply, {investigation: [run.row, run.row]});
      if (kind === 'unknown_id') run.row.requirementId = 'invented';
      if (kind === 'unknown_record') run.row.evidenceRecordIds = ['invented'];
      if (kind === 'empty_location') run.row.contentLocations = [];
      if (kind === 'waiver') {run.row.applicability = 'not_applicable'; run.row.coverage = 'unknown';}
      if (kind === 'observed_without_record') {run.row.evidenceStatus = 'observed'; run.row.scopeMatch = 'matched';}
      if (kind === 'report_claim_ids') Object.assign(run.row, {claimIds: [run.reply.claims[0].claimId]});
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'unavailable', reason: 'invalid_response'});
    });

  it('does not accept requirements replaced after the pinned registry was captured', async () => {
    const run = investigationFixture();
    run.input.snapshot.investigationRequirements = {...run.input.snapshot.investigationRequirements!, contractFingerprint: 'changed'};
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'not_checked', reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('reports a closed private diagnostic for an unknown investigation record without retaining provider text', async () => {
    const run = investigationFixture();
    run.row.evidenceRecordIds = ['SECRET_PROVIDER_RESPONSE_CANARY'];
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'unavailable', reason: 'invalid_response',
      responseDiagnostic: {stage: 'investigation', code: 'invalid_reference', ordinal: 1}});
    expect(JSON.stringify(assessment)).not.toContain('SECRET_PROVIDER_RESPONSE_CANARY');
    expect(Object.keys(assessment.responseDiagnostic ?? {}).sort()).toEqual(['code', 'ordinal', 'stage']);
  });
});

describe('final semantic assessment snapshot and transport', () => {
  const selectedEvent: AnalysisRunSelection = {present: true, kind: 'track_event',
    context: {kind: 'track_event', eventId: 11140, ts: 40919952686988, dur: 42000000},
    sideResolution: {status: 'unknown'}};

  it('forwards the exact side-unknown selection as lookup context and binds every field', async () => {
    const run = fixture({selection: selectedEvent});
    expect((await assessFinalSemantics(run.input)).status).toBe('checked');
    const payload = JSON.parse(run.dispatch.mock.calls[0][0].prompt.slice(
      run.dispatch.mock.calls[0][0].prompt.lastIndexOf('\n\n{') + 2));
    expect(payload.selectionScope).toEqual(selectedEvent);
    expect(payload.selectionScope.sideResolution).toEqual({status: 'unknown'});
    expect(payload.selectionScope.sideResolution).not.toHaveProperty('traceSide');

    const changed = fixture({selection: selectedEvent});
    changed.input.snapshot.selectionScope = structuredClone(selectedEvent);
    if (changed.input.snapshot.selectionScope?.present && changed.input.snapshot.selectionScope.context.kind === 'track_event') {
      changed.input.snapshot.selectionScope.context.eventId = 11141;
    }
    expect(await assessFinalSemantics(changed.input)).toMatchObject({status: 'not_checked', reason: 'invalid_snapshot'});
    expect(changed.dispatch).not.toHaveBeenCalled();
  });

  it('keeps missing and explicit no-selection snapshots distinct', async () => {
    const missing = fixture();
    expect((await assessFinalSemantics(missing.input)).status).toBe('checked');
    const missingPrompt = missing.dispatch.mock.calls[0][0].prompt;
    expect(JSON.parse(missingPrompt.slice(missingPrompt.lastIndexOf('\n\n{') + 2))).not.toHaveProperty('selectionScope');
    const none = fixture({selection: {present: false}});
    expect((await assessFinalSemantics(none.input)).status).toBe('checked');
    expect(none.dispatch.mock.calls[0][0].prompt).toContain('"selectionScope":{"present":false}');
  });

  it('distinguishes invalid JSON from a structurally invalid response without storing either response', async () => {
    for (const [text, diagnostic] of [
      ['SECRET_INVALID_JSON_CANARY', {stage: 'json', code: 'invalid_json'}],
      [JSON.stringify({schemaVersion: 'final_semantic_response@3', secret: 'SECRET_SHAPE_CANARY'}),
        {stage: 'envelope', code: 'invalid_shape'}],
    ] as const) {
      const run = fixture({dispatch: async () => ({status: 'ok', text})});
      const assessment = await assessFinalSemantics(run.input);
      expect(assessment).toMatchObject({status: 'unavailable', reason: 'invalid_response', responseDiagnostic: diagnostic});
      expect(JSON.stringify(assessment)).not.toContain('SECRET_');
    }
  });

  it('sends one complete provider-safe snapshot and returns only semantic coverage', async () => {
    const run = fixture();
    const expectedPrompt = buildFinalSemanticPrompt({snapshot: run.input.snapshot,
      intent: run.input.context.turnIntent, traceIdentity: run.input.context.traceIdentity,
      registryFingerprint: run.input.context.strategyRegistry.registryFingerprint});
    const pending = assessFinalSemantics(run.input);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    const assessment = await pending;
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.reads).not.toHaveBeenCalled();
    expect(run.dispatch.mock.calls[0][0]).toMatchObject({deadlineMs: run.input.context.deadlineMs, systemPrompt: ''});
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toBe(expectedPrompt?.prompt);
    expect(prompt).toContain(JSON.stringify(run.input.snapshot.body));
    expect(prompt).toContain('prepared_claim_evidence@1');
    expect(prompt).toContain('trace-reference');
    expect(assessment).toMatchObject({status: 'checked', consistency: 'consistent',
      coverage: {body: 'complete', claims: 'complete', report: 'not_applicable'},
      binding: {canonicalCandidate: run.candidate}, claims: [{claimId: 'claim-a', contentLocations: [{start: 0, end: run.input.snapshot.body.length}]}]});
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.claims)).toBe(true);
    expect(Object.keys(assessment)).not.toContain('verified');
    expect(Object.keys(assessment)).not.toContain('evidenceStatus');
  });

  it('decodes exact source aliases for binding while dispatching the compact snapshot once', async () => {
    const run = fixture();
    const sourceUse = {schemaVersion: 'source_use_decision@1' as const, codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['codebase'], status: 'corroborated' as const, attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['codebase'], usedCodebaseIds: ['codebase'], coverageComplete: true, references: [{
        id: 'source-ref-1', referenceId: 'source-1', codebaseId: 'codebase', filePath: 'src/App.kt',
        lineRange: {start: 1, end: 200}, lookupKind: 'body' as const,
      }]};
    Object.assign(run.input.snapshot.conclusionContract!, {sourceUseDecision: sourceUse, sourceReferences: sourceUse.references});
    run.input.snapshot.sourceUse = sourceUse;
    run.input.snapshot = compactSemanticSourceSnapshot(run.input.snapshot);
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment.status).toBe('checked');
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain('final_semantic_source_alias@1');
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
    expect(payload.contentLocationCatalog).toEqual({schemaVersion: 'final_semantic_location_catalog@1', entries: [
      expect.objectContaining({text: run.input.snapshot.body}),
    ]});
    expect(JSON.stringify(payload.contentLocationCatalog)).not.toContain('src/App.kt');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
  });

  it('captures data and transport identity before the first await', async () => {
    const run = fixture();
    const other = fixture();
    const body = run.input.snapshot.body;
    const pending = assessFinalSemantics(run.input);
    run.input.snapshot.body = 'mutated after dispatch reservation';
    run.contract.claims![0].text = 'mutated declaration';
    run.input.context = other.input.context;
    const result = await pending;
    expect(result.status).toBe('checked');
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(other.dispatch).not.toHaveBeenCalled();
    expect(run.dispatch.mock.calls[0][0].prompt).toContain(JSON.stringify(body));
    expect(run.dispatch.mock.calls[0][0].prompt).not.toContain('mutated declaration');
  });

  it.each(['body', 'claim', 'evidence', 'source', 'capability', 'case', 'diagnostics', 'query', 'candidate'] as const)(
    'does not reuse or redispatch after a %s snapshot change', async field => {
      const run = fixture();
      await assessFinalSemantics(run.input);
      const changed = {...run.input, canonicalCandidate: {...run.candidate}, snapshot: structuredClone(run.input.snapshot)};
      if (field === 'body') changed.snapshot.body += ' Additional assertion.';
      if (field === 'claim') changed.snapshot.conclusionContract!.claims![0].text += ' changed';
      if (field === 'evidence') changed.snapshot.evidenceSnapshot = {reads: [[10]]};
      if (field === 'source') changed.snapshot.sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'metadata_only',
        selectedCodebaseIds: [], status: 'pending', attemptedTools: [], queriedCodebaseIds: [], usedCodebaseIds: [], references: []};
      if (field === 'capability') changed.snapshot.capabilitySnapshot = {available: true};
      if (field === 'case') changed.snapshot.caseRetrieval = {status: 'checked', recommendations: []};
      if (field === 'diagnostics') changed.snapshot.protocolDiagnostics = {rawPayload: 'changed original'};
      if (field === 'query') changed.snapshot.query += ' Broader request.';
      if (field === 'candidate') changed.canonicalCandidate.attemptId = 'different-attempt';
      expect(await assessFinalSemantics(changed)).toMatchObject({status: 'not_checked', reason: 'snapshot_changed', consistency: 'unknown'});
      expect(run.dispatch).toHaveBeenCalledTimes(1);
    });

  it('binds current requirements, intent and trace identity into the snapshot', async () => {
    const run = fixture({requirements: [{id: 'observation', label: 'Observation', required: true}]});
    await assessFinalSemantics(run.input);
    const changed = {...run.input, snapshot: structuredClone(run.input.snapshot)};
    changed.snapshot.reportRequirements = {...changed.snapshot.reportRequirements!,
      requirements: [{id: 'observation', label: 'Changed meaning', required: true}]};
    expect(await assessFinalSemantics(changed)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('never dispatches a redacted or truncated semantic target and consumes its slot', async () => {
    const run = fixture();
    run.input.snapshot.inputCoverage = 'incomplete';
    const first = assessFinalSemantics(run.input);
    expect(await first).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_incomplete', consistency: 'unknown'});
    expect(assessFinalSemantics(run.input)).toBe(first);
    run.input.snapshot.inputCoverage = 'complete';
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it.each(['invalid_mode', 'missing_fields', 'duplicate_marker', 'valid_contract_invalid_protocol'] as const)(
    'rejects issued ineligible %s declarations even when no bindable contract remains', async issue => {
      const run = fixture();
      run.input.snapshot.declarationBindingEligibility = 'ineligible';
      if (issue !== 'valid_contract_invalid_protocol') {
        run.input.snapshot.conclusionContract = undefined;
        run.reply.claims = [];
      }
      run.input.snapshot.protocolDiagnostics = {sidecar: {status: 'invalid', bindingEligibility: 'ineligible',
        issues: [{code: issue === 'duplicate_marker' ? 'duplicate_marker' : 'invalid_contract', path: '$'}],
        ...(issue === 'duplicate_marker' ? {} : {rawPayload: {mode: 'invalid', claims: [{id: 'original-claim', text: 'Original declaration'}]}})}};
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'not_checked', reason: 'invalid_declarations', consistency: 'unknown'});
      expect(run.dispatch).not.toHaveBeenCalled();
    });

  it('reports closed-vocabulary declaration issue codes for triage', async () => {
    const detailFor = async (protocolDiagnostics: unknown, parseIssues?: unknown[]) => {
      const run = fixture();
      run.input.snapshot.declarationBindingEligibility = 'ineligible';
      run.reply.claims = [];
      run.input.snapshot.protocolDiagnostics = protocolDiagnostics as any;
      if (parseIssues) {
        run.input.snapshot.conclusionContract = {...run.input.snapshot.conclusionContract!,
          bindingEligibility: 'ineligible', parseIssues: parseIssues as any};
      }
      const assessment = await assessFinalSemantics(run.input);
      expect(assessment).toMatchObject({status: 'not_checked', reason: 'invalid_declarations'});
      return assessment.notCheckedDetail;
    };

    expect(await detailFor({sidecar: {status: 'invalid', bindingEligibility: 'ineligible',
      issues: [{code: 'duplicate_marker', path: '$'}]}})).toBe('duplicate_marker');

    // All raw-body channels absent: eligibility was inherited from a contract
    // the runtime pre-parsed, so its parseIssues are the only triage source.
    expect(await detailFor(undefined, [{code: 'invalid_semantics', path: 'claims[2].semantics'},
      {code: 'invalid_claim', path: 'claims[3]'}])).toBe('invalid_semantics,invalid_claim');

    // Relation proposal reasons survive both the full parse issue and the
    // provider-input projection that keeps only closed `triageCodes`.
    expect(await detailFor({
      sidecar: {status: 'invalid', bindingEligibility: 'ineligible', issues: [{code: 'invalid_relation_proposal',
        path: 'relationProposals[0]', relationProposalDiagnostic: {scope: 'item', ordinal: 1, reason: 'unknown_field'}}]},
      typedJson: {status: 'invalid', triageCodes: ['invalid_relation_proposal:invalid_kind', 'invalid_semantics']},
    })).toBe('invalid_relation_proposal:unknown_field+invalid_kind,invalid_semantics');

    // Recorded issues outside the vocabulary are named as such, never echoed.
    expect(await detailFor({sidecar: {status: 'invalid', bindingEligibility: 'ineligible',
      issues: [{code: 'PRIVATE_CODE_CANARY', path: '$'}]}})).toBe('unrecognized_issue_codes');
  });

  it('binds explicit parser eligibility and never upgrades existing legacy claims', async () => {
    const run = fixture();
    run.input.snapshot.declarationBindingEligibility = 'legacy_unchecked';
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', consistency: 'unknown',
      claims: [{consistency: 'unknown'}], coverage: {claims: 'incomplete'}});
    run.input.snapshot.declarationBindingEligibility = 'eligible';
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects accessors without invoking them and prevents a later valid retry', async () => {
    const run = fixture();
    const getter = jest.fn(() => 'private accessor text');
    run.input.snapshot.evidenceSnapshot = Object.defineProperty({}, 'rows', {enumerable: true, get: getter});
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(getter).not.toHaveBeenCalled();
    run.input.snapshot.evidenceSnapshot = {rows: []};
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it.each([NaN, new Date(), [undefined], Array(1), {callback: () => undefined}])('rejects non-JSON evidence input %#', async value => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = value;
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('treats optional undefined properties as absent without losing literal JSON keys', async () => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = {optional: undefined, raw: JSON.parse('{"__proto__":"literal-cell"}')};
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked'});
    expect(run.dispatch.mock.calls[0][0].prompt).toContain('"__proto__":"literal-cell"');
  });

  it('accepts native plain objects and nested arrays from another realm', async () => {
    const run = fixture();
    const foreign: unknown = runInNewContext('({rows: [[9]], meta: {unit: "ms"}})');
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    run.input.snapshot.evidenceSnapshot = foreign;
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked'});
    expect(run.dispatch.mock.calls[0][0].prompt).toContain('"meta":{"unit":"ms"}');
  });

  it.each([
    'new (class Snapshot { constructor() { this.rows = [[9]]; } })()',
    'Object.create(Object.create(null))',
    'Object.create(Object.create(null, {constructor: {value: Object}}))',
    '(() => { function Object() {} globalThis.Object.setPrototypeOf(Object.prototype, null); return new Object(); })()',
  ])('rejects foreign classes and forged ordinary-object prototypes: %s', async expression => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = runInNewContext(expression);
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('does not invoke foreign own or prototype constructor accessors', async () => {
    for (const expression of [
      '({get rows() { reads += 1; return [[9]]; }})',
      'Object.create(Object.create(null, {constructor: {get() { reads += 1; return Object; }}}))',
    ]) {
      const run = fixture();
      const realm = {reads: 0};
      run.input.snapshot.evidenceSnapshot = runInNewContext(expression, realm);
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
      expect(realm.reads).toBe(0);
      expect(run.dispatch).not.toHaveBeenCalled();
    }
  });

  it('rejects unknown source-ledger fields rather than silently dropping them', async () => {
    const run = fixture();
    const ledger = {schemaVersion: 'source_use_decision@1' as const, codeAwareMode: 'metadata_only' as const,
      selectedCodebaseIds: [], status: 'pending' as const, attemptedTools: [], queriedCodebaseIds: [], usedCodebaseIds: [], references: []};
    run.input.snapshot.sourceUse = Object.assign(ledger, {body: 'unprojected private source'});
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('reviews declarations beyond earlier preview limits and rejects an omitted last ID', async () => {
    const run = fixture();
    const declaration = run.contract.claims![0];
    const reply = run.reply.claims[0];
    run.contract.claims = Array.from({length: 60}, (_, index) => ({...structuredClone(declaration), id: `claim-${index}`}));
    run.reply.claims = Array.from({length: 60}, (_, index) => ({...structuredClone(reply), claimId: `claim-${index}`}));
    const result = await assessFinalSemantics(run.input);
    expect(result.claims).toHaveLength(60);
    expect(result.status).toBe('checked');
    const missing = fixture();
    missing.contract.claims = structuredClone(run.contract.claims);
    missing.reply.claims = structuredClone(run.reply.claims.slice(0, -1));
    expect(await assessFinalSemantics(missing.input)).toMatchObject({reason: 'invalid_response'});
  });

  it('marks complete-input overflow without reviewing only the first claims or rows', async () => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = {rows: ['x'.repeat(FINAL_SEMANTIC_INPUT_BYTE_LIMIT)]};
    const first = assessFinalSemantics(run.input);
    const overflow = await first;
    expect(overflow).toMatchObject({status: 'coverage_incomplete', reason: 'input_limit',
      inputDiagnostic: {stage: 'prompt_assembly', code: 'byte_limit_exceeded', limitBytes: FINAL_SEMANTIC_INPUT_BYTE_LIMIT}});
    expect(overflow.inputDiagnostic?.actualBytes).toBeGreaterThan(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(assessFinalSemantics(run.input)).toBe(first);
    run.input.snapshot.evidenceSnapshot = {rows: []};
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('uses the 512 KiB default while allowing callers to request a smaller bound', async () => {
    expect(FINAL_SEMANTIC_INPUT_BYTE_LIMIT).toBe(512 * 1024);
    const medium = fixture();
    medium.input.snapshot.evidenceSnapshot = {rows: ['x'.repeat(140 * 1024)]};
    expect(await assessFinalSemantics(medium.input)).toMatchObject({status: 'checked'});
    const promptBytes = Buffer.byteLength(medium.dispatch.mock.calls[0][0].prompt, 'utf8');
    expect(promptBytes).toBeGreaterThan(128 * 1024);
    expect(promptBytes).toBeLessThanOrEqual(FINAL_SEMANTIC_INPUT_BYTE_LIMIT);
    expect(medium.dispatch).toHaveBeenCalledTimes(1);

    const smaller = fixture();
    smaller.input.snapshot.evidenceSnapshot = {rows: ['x'.repeat(140 * 1024)]};
    smaller.input.limits = {inputBytes: 128 * 1024};
    expect(await assessFinalSemantics(smaller.input)).toMatchObject({status: 'coverage_incomplete', reason: 'input_limit'});
    expect(smaller.dispatch).not.toHaveBeenCalled();
  });

  it('rejects an explicit input bound above the shared safety ceiling', async () => {
    const run = fixture();
    run.input.limits = {inputBytes: FINAL_SEMANTIC_INPUT_BYTE_LIMIT + 1};
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'not_checked', reason: 'invalid_configuration'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed for missing assets and remembers the failed first attempt', async () => {
    const run = fixture();
    jest.mocked(loadPromptTemplate).mockReturnValueOnce(undefined);
    const first = assessFinalSemantics(run.input);
    expect(await first).toMatchObject({status: 'unavailable', reason: 'missing_template'});
    expect(assessFinalSemantics(run.input)).toBe(first);
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a body/candidate mismatch without dispatch', async () => {
    const run = fixture();
    run.candidate.conclusionFingerprint = 'another-body';
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });
});

describe('final semantic response protocol', () => {
  it('accepts LF/CRLF plain, paired and unique orphan-closing framing equivalently', async () => {
    const assessments = [];
    for (const mode of ['plain_lf', 'plain_crlf', 'paired_lf', 'paired_crlf', 'orphan_lf', 'orphan_crlf'] as const) {
      const run = fixture();
      const lf = JSON.stringify(run.reply, null, 2);
      const payload = mode.endsWith('crlf') ? lf.replace(/\n/g, '\r\n') : lf;
      const text = mode.startsWith('paired') ? `\`\`\`json${mode.endsWith('crlf') ? '\r\n' : '\n'}${payload}${
        mode.endsWith('crlf') ? '\r\n' : '\n'}\`\`\`` : mode.startsWith('orphan')
        ? `${payload}${mode.endsWith('crlf') ? '\r\n' : '\n'}\`\`\`` : payload;
      run.dispatch.mockImplementation(async () => ({status: 'ok', text}));
      assessments.push(await assessFinalSemantics(run.input));
    }
    expect(assessments[0]).toMatchObject({status: 'checked'});
    for (const assessment of assessments.slice(1)) expect(assessment).toEqual(assessments[0]);
  });

  it.each(['extra_root', 'partial_full_span'] as const)('rejects the entire malformed response framing: %s', async issue => {
    const run = fixture();
    if (issue === 'extra_root') Object.assign(run.reply, {verified: true});
    if (issue === 'partial_full_span') run.reply.bodyCoverage.reviewedSpans[0].end -= 1;
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'unavailable', reason: 'invalid_response', consistency: 'unknown'});
  });

  it.each([
    ['missing_claim', 'claim_set'], ['extra_claim', 'claim'], ['duplicate_claim', 'claim'], ['wrong_quote', 'claim'],
    ['bad_span', 'claim'], ['extra_span_field', 'claim'],
  ] as const)('degrades only the affected claim for a malformed item: %s', async (issue, stage) => {
    const run = fixture();
    if (issue === 'missing_claim') run.reply.claims = [];
    if (issue === 'extra_claim') run.reply.claims[0].claimId = 'unbound';
    if (issue === 'duplicate_claim') run.reply.claims.push(structuredClone(run.reply.claims[0]));
    if (issue === 'wrong_quote') run.reply.claims[0].contentLocations[0].text = 'different statement';
    if (issue === 'bad_span') run.reply.claims[0].contentLocations.push({start: 0, end: 999, text: 'outside'});
    if (issue === 'extra_span_field') Object.assign(run.reply.claims[0].contentLocations[0], {evidenceStatus: 'verified'});
    const assessment = await assessFinalSemantics(run.input);
    // Never promoted: the only declared claim is unknown, so nothing can verify.
    expect(assessment).toMatchObject({status: 'coverage_incomplete', reason: 'invalid_response', consistency: 'unknown',
      coverage: {body: 'complete', claims: 'incomplete'}, claims: [{claimId: 'claim-a', consistency: 'unknown'}],
      responseDiagnostic: {stage}});
    expect(assessment.notCheckedDetail).toMatch(/^resp_claim/);
  });

  it.each(['explanation_first', 'tail', 'opening_only', 'double_fence', 'closing_without_newline', 'four_backticks',
    'closing_then_text', 'multiple_json', 'body_internal_fence'] as const)('rejects non-whole JSON framing %s', async framing => {
    const run = fixture(framing === 'body_internal_fence' ? {body: '```'} : {});
    const payload = JSON.stringify(run.reply);
    const text = framing === 'explanation_first' ? `Explanation\n${payload}`
      : framing === 'tail' ? `${payload}\nExplanation`
        : framing === 'opening_only' ? `\`\`\`json\n${payload}`
          : framing === 'double_fence' ? `${payload}\n\`\`\`\n\`\`\``
            : framing === 'closing_without_newline' ? `${payload}\`\`\``
              : framing === 'four_backticks' ? `${payload}\n\`\`\`\``
                : framing === 'closing_then_text' ? `${payload}\n\`\`\`\nExplanation`
                  : framing === 'multiple_json' ? `${payload}\n${payload}\n\`\`\``
                    : `${payload}\n\`\`\``;
    run.dispatch.mockImplementation(async () => ({status: 'ok', text}));
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response',
      responseDiagnostic: {stage: 'json', code: 'invalid_json'}});
  });

  it('keeps schema and claim-set failures strict after removing one orphan closing fence', async () => {
    const invalidSchema = fixture();
    invalidSchema.reply.schemaVersion = 'unknown_semantic_response';
    invalidSchema.dispatch.mockImplementation(async () => ({status: 'ok',
      text: `${JSON.stringify(invalidSchema.reply)}\n\`\`\``}));
    expect(await assessFinalSemantics(invalidSchema.input)).toMatchObject({reason: 'invalid_response',
      responseDiagnostic: {stage: 'envelope', code: 'invalid_shape'}});

    // An omitted declared claim stays unknown; the judged claim is retained.
    const missingA2Claim = fixture();
    missingA2Claim.contract.claims!.push({...structuredClone(missingA2Claim.contract.claims![0]), id: 'rec.no_rt'});
    missingA2Claim.dispatch.mockImplementation(async () => ({status: 'ok',
      text: `${JSON.stringify(missingA2Claim.reply)}\r\n\`\`\``}));
    expect(await assessFinalSemantics(missingA2Claim.input)).toMatchObject({status: 'coverage_incomplete',
      reason: 'invalid_response', notCheckedDetail: 'resp_claim_set_set_mismatch',
      claims: [{claimId: 'claim-a', consistency: 'consistent'}, {claimId: 'rec.no_rt', consistency: 'unknown'}],
      responseDiagnostic: {stage: 'claim_set', code: 'set_mismatch', expectedCount: 2, actualCount: 1}});
  });

  it('keeps a contradiction whose location cannot be resolved and degrades only the unlocatable consistent claim', async () => {
    const run = fixture({body: 'Frame A took 9 ms. Frame B took 4 ms.'});
    const second = {...structuredClone(run.contract.claims![0]), id: 'claim-b', text: 'Frame B took 4 ms.'};
    const third = {...structuredClone(run.contract.claims![0]), id: 'claim-c', text: 'Frame A took 9 ms.'};
    run.contract.claims!.push(second, third);
    const body = run.input.snapshot.body;
    run.reply.schemaVersion = 'final_semantic_response@2';
    run.reply.claims = [
      {claimId: 'claim-a', consistency: 'inconsistent', contentLocations: [{text: 'not in the body'}],
        issues: [{code: 'numeric_mismatch', contentLocations: [{text: 'also not in the body'}]}]},
      {claimId: 'claim-b', consistency: 'consistent', contentLocations: [{text: 'Frame B took 4 ms.'}], issues: []},
      {claimId: 'claim-c', consistency: 'consistent', contentLocations: [{spanId: 'L9.0000000000'}], issues: []},
      {claimId: 'invented', consistency: 'consistent', contentLocations: [{text: 'Frame B took 4 ms.'}], issues: []},
    ] as any;
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'coverage_incomplete', consistency: 'inconsistent', reason: 'invalid_response',
      claims: [
        {claimId: 'claim-a', consistency: 'inconsistent', contentLocations: [], issues: [{code: 'numeric_mismatch', contentLocations: []}]},
        {claimId: 'claim-b', consistency: 'consistent', contentLocations: [{start: body.indexOf('Frame B'), end: body.length}]},
        {claimId: 'claim-c', consistency: 'unknown'},
      ],
      responseDiagnostic: {stage: 'claim', code: 'invalid_location', ordinal: 1}});
    expect(assessment.notCheckedDetail).toBe('resp_claim_invalid_location,resp_claim_invalid_reference');
    expect(JSON.stringify(assessment)).not.toContain('invented');
  });

  it('records a dropped invented claim without reducing an otherwise complete review', async () => {
    const run = fixture();
    run.reply.claims.push({claimId: 'invented', consistency: 'consistent', contentLocations: [span(run.input.snapshot.body)], issues: []});
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'checked', consistency: 'consistent',
      responseDiagnostic: {stage: 'claim', code: 'invalid_reference', ordinal: 2}});
    expect(assessment).not.toHaveProperty('reason');
  });

  it.each(['bad_location', 'bad_shape'] as const)('never passes with an unlocatable omission: %s', async kind => {
    const run = fixture();
    run.reply.omissions = kind === 'bad_location'
      ? [{code: 'undeclared_claim', contentLocations: [{start: 0, end: 999, text: 'outside'}]}]
      : [{code: 'undeclared_claim'}];
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'coverage_incomplete', reason: 'invalid_response', consistency: 'unknown',
      coverage: {body: 'incomplete'}, omissions: [], claims: [{claimId: 'claim-a', consistency: 'consistent'}],
      responseDiagnostic: {stage: 'omission', ordinal: 1}});
  });

  it('preserves an explicitly incomplete review instead of inferring success from full-looking spans', async () => {
    const run = fixture();
    run.reply.bodyCoverage.status = 'incomplete';
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', consistency: 'unknown', coverage: {body: 'incomplete'}});
  });

  it.each(['kind_mismatch', 'polarity_mismatch', 'discourse_mismatch', 'numeric_mismatch'] as const)(
    'preserves the semantic %s finding without rewriting a claim', async code => {
      const run = fixture({body: '并非锁导致了掉帧；9 ms 只是区间长度。'});
      const original = structuredClone(run.contract);
      run.reply.claims[0].consistency = 'inconsistent';
      run.reply.claims[0].issues = [{code, contentLocations: [span(run.input.snapshot.body)]}];
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', consistency: 'inconsistent',
        claims: [{claimId: 'claim-a', issues: [{code}]}]});
      expect(run.contract).toEqual(original);
    });

  it.each([
    {body: 'TTID 约 1912.20 ms。', consistency: 'consistent', issues: []},
    {body: 'TTID is approximately 1912.21 ms.', consistency: 'inconsistent',
      issues: [{code: 'numeric_mismatch', contentLocations: []}]},
    {body: 'TTID is approximately 1.91 s.', consistency: 'consistent', issues: []},
    {body: 'TTID is approximately 1.90 s.', consistency: 'inconsistent',
      issues: [{code: 'numeric_mismatch', contentLocations: []}]},
    {body: 'TTID is 1.91 s.', consistency: 'inconsistent',
      issues: [{code: 'numeric_mismatch', contentLocations: []}]},
    ...['about 1.91 MiB', 'about 1.91 msec', 'about 1.91 ticks', '1.912e3 ms', '1.9–2.0 s', '1.91 ± 0.01 s']
      .map(value => ({body: `TTID is ${value}.`, consistency: 'inconsistent' as const,
        issues: [{code: 'numeric_mismatch' as const, contentLocations: []}]})),
    {body: 'TTID is 1912.20 ms.', consistency: 'inconsistent',
      issues: [{code: 'numeric_mismatch', contentLocations: []}]},
  ] as const)('preserves the reviewer verdict for numeric presentation: $body', async ({body, consistency, issues}) => {
    const run = fixture({body});
    const claim = run.contract.claims![0];
    claim.text = body;
    claim.references[0] = {...claim.references[0], value: 1912.202655};
    claim.semantics = {...claim.semantics!, numeric: {operator: 'eq', value: 1912.202655, unit: 'ms'}};
    const original = structuredClone(run.contract);
    run.reply.claims[0].consistency = consistency;
    run.reply.claims[0].contentLocations = [span(body)];
    run.reply.claims[0].issues = issues.map(issue => ({...issue, contentLocations: [span(body)]}));
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', consistency,
      claims: [{claimId: 'claim-a', consistency}]});
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain('exact `7.123456 ms`');
    expect(prompt).toContain('`约 7.12 ms`');
    expect(prompt).toContain('`约 7.13 ms` is inconsistent');
    expect(prompt).toContain('A bare `7.12 ms` remains a mismatch');
    expect(prompt).toContain('closed unit mappings');
    expect(prompt).toContain('cross-family or unknown-unit conversion');
    expect(prompt).toContain('presentation equivalence cannot supply unit authority or proof');
    expect(run.contract).toEqual(original);
  });

  it.each([
    {body: 'Startup duration is 301.839437 ms.', consistency: 'consistent'},
    {body: '启动耗时约 301.8 ms。', consistency: 'consistent'},
    {body: 'Startup duration is 301.8 ms.', consistency: 'inconsistent'},
    {body: '启动耗时约 301.9 ms。', consistency: 'inconsistent'},
  ] as const)('keeps original nanosecond evidence when receiving the reviewer verdict: $body', async ({body, consistency}) => {
    const run = fixture({body});
    const claim = run.contract.claims![0];
    claim.text = body;
    claim.references[0] = {...claim.references[0], value: 301839437};
    claim.semantics = {...claim.semantics!, numeric: {operator: 'eq', value: 301839437, unit: 'ns'}};
    const original = structuredClone(run.contract);
    run.reply.claims[0].consistency = consistency;
    run.reply.claims[0].contentLocations = [span(body)];
    run.reply.claims[0].issues = consistency === 'consistent' ? []
      : [{code: 'numeric_mismatch', contentLocations: [span(body)]}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', consistency});
    expect(run.contract).toEqual(original);
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain('`301.839437 ms` or `约 301.8 ms`');
    expect(prompt).toContain('bare `301.8 ms` and `约 301.9 ms` are inconsistent');
  });

  it('retains omitted assertions from a table while allowing no-declaration acknowledgements', async () => {
    const run = fixture({body: '| observation | 9 ms |'});
    run.contract.claims = [];
    run.reply.claims = [];
    run.reply.omissions = [{code: 'undeclared_claim', contentLocations: [span(run.input.snapshot.body)]}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', consistency: 'inconsistent', omissions: [{code: 'undeclared_claim'}]});
    const acknowledgement = fixture({body: 'Understood.'});
    acknowledgement.input.snapshot.conclusionContract = undefined;
    acknowledgement.input.snapshot.declarationBindingEligibility = 'legacy_unchecked';
    acknowledgement.reply.claims = [];
    expect(await assessFinalSemantics(acknowledgement.input)).toMatchObject({status: 'checked', consistency: 'consistent', claims: []});
  });

  it('does not upgrade missing or invalid semantics because the model returned consistent', async () => {
    const run = fixture();
    delete run.contract.claims![0].semantics;
    run.contract.claims![0].rawSemantics = {predicate: 'unparsed original'};
    run.input.snapshot.protocolDiagnostics = {rawPayload: {claims: [{semantics: {predicate: 'unparsed original'}}]}};
    const result = await assessFinalSemantics(run.input);
    expect(result).toMatchObject({status: 'coverage_incomplete', consistency: 'unknown', claims: [{consistency: 'unknown'}]});
    expect(run.dispatch.mock.calls[0][0].prompt).toContain('unparsed original');
  });

  it.each(['missing', 'duplicate'] as const)('rejects %s declaration IDs without inventing replacements', async kind => {
    const run = fixture();
    if (kind === 'missing') delete run.contract.claims![0].id;
    else run.contract.claims!.push(structuredClone(run.contract.claims![0]));
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_declarations'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('validates UTF-16 boundaries and exact repeated-text locations', async () => {
    const body = '😀 值为 9 ms；值为 9 ms。';
    const valid = fixture({body});
    valid.reply.claims[0].contentLocations = [span(body, body.lastIndexOf('值为'), body.length)];
    expect(await assessFinalSemantics(valid.input)).toMatchObject({status: 'checked'});
    const invalid = fixture({body});
    invalid.reply.claims[0].contentLocations = [span(body, 1, 2)];
    expect(await assessFinalSemantics(invalid.input)).toMatchObject({reason: 'invalid_response'});
  });
});

describe('final semantic v2 exact quotation locations', () => {
  function quoteFixture(options: Parameters<typeof fixture>[0] = {}) {
    const run = fixture(options);
    const quote = {text: run.input.snapshot.body};
    const reply: any = {...run.reply, schemaVersion: 'final_semantic_response@2',
      claims: run.reply.claims.map(claim => ({...claim, contentLocations: [quote]})),
      requirements: run.reply.requirements.map(requirement => ({...requirement, contentLocations: [quote]}))};
    run.dispatch.mockImplementation(async () => ({status: 'ok', text: JSON.stringify(reply)}));
    return {...run, reply};
  }

  it('requests v2 in the real template and retains only offsets with the existing one-review cache', async () => {
    const run = quoteFixture({body: '😀 本次区间持续 9 ms。'});
    run.reply.claims[0].contentLocations = [{text: '本次区间持续 9 ms'}];
    const pending = assessFinalSemantics(run.input);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    const assessment = await pending;
    expect(assessment).toMatchObject({schemaVersion: 'final_semantic_assessment@1', status: 'checked',
      consistency: 'consistent', claims: [{contentLocations: [{start: 3, end: 14}]}]});
    expect(assessment.claims[0].contentLocations[0]).toEqual({start: 3, end: 14});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.reads).not.toHaveBeenCalled();
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain('"schemaVersion": "final_semantic_response@4"');
    expect(prompt).toContain('including overlapping matches');
    expect(prompt).toContain('does not establish factual');
    expect(prompt).toContain(`"bodyUtf16Length":${run.input.snapshot.body.length}`);
  });

  it.each([1, 2])('selects exact repeated text occurrence %s in the whole original body', async occurrence => {
    const run = quoteFixture({body: '值为 9 ms；值为 9 ms。'});
    run.reply.claims[0].contentLocations = [{text: '值为 9 ms', occurrence}];
    const start = occurrence === 1 ? 0 : 8;
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
      claims: [{contentLocations: [{start, end: start + 7}]}]});
  });

  it('counts overlapping occurrences rather than advancing by the quotation length', async () => {
    const run = quoteFixture({body: 'banana'});
    run.reply.claims[0].contentLocations = [{text: 'ana', occurrence: 2}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
      claims: [{contentLocations: [{start: 3, end: 6}]}]});
  });

  it.each([undefined, 0, -1, 1.5, 3, Number.MAX_SAFE_INTEGER + 1, '2', null, true])(
    'rejects ambiguous or invalid repeated-text occurrence %s', async occurrence => {
      const run = quoteFixture({body: 'banana'});
      run.reply.claims[0].contentLocations = [{text: 'ana', ...(occurrence === undefined ? {} : {occurrence})}];
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', reason: 'invalid_response',
        claims: [{claimId: 'claim-a', consistency: 'unknown', contentLocations: []}]});
    });

  it.each([
    {body: '  开始\r\n😀  e\u0301结束  ', text: '\r\n😀  e\u0301', start: 4, end: 12},
    {body: 'café e\u0301', text: 'e\u0301', start: 5, end: 7},
    {body: ' 9 ms ', text: ' 9 ms ', start: 0, end: 6},
  ])('preserves exact CRLF, spaces and combining characters in $text', async ({body, text, start, end}) => {
    const run = quoteFixture({body});
    run.reply.claims[0].contentLocations = [{text}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
      claims: [{contentLocations: [{start, end}]}]});
  });

  it.each([
    {body: 'x\r\n y', text: 'x\n y'},
    {body: 'x  y', text: 'x y'},
    {body: 'e\u0301', text: 'é'},
    {body: '😀', text: '\ud83d'},
    {body: '😀', text: '\ude00'},
    {body: 'seen', text: 'missing'},
    {body: 'x \r\n y', text: ' \r\n '},
    {body: 'seen', text: ''},
  ])('rejects nonexact, empty or split-surrogate quotation $text', async ({body, text}) => {
    const run = quoteFixture({body});
    run.reply.claims[0].contentLocations = [{text}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
  });

  it.each(['start', 'end', 'both', 'extra', 'duplicate', 'mixed', 'one_bad'] as const)(
    'never accepts a claim judged at invalid %s location fields', async invalid => {
      const run = quoteFixture();
      const quote = {text: run.input.snapshot.body};
      if (invalid === 'start') run.reply.claims[0].contentLocations = [{...quote, start: 0}];
      if (invalid === 'end') run.reply.claims[0].contentLocations = [{...quote, end: quote.text.length}];
      if (invalid === 'both') run.reply.claims[0].contentLocations = [span(quote.text)];
      if (invalid === 'extra') run.reply.claims[0].contentLocations = [{...quote, verified: true}];
      if (invalid === 'duplicate') run.reply.claims[0].contentLocations = [quote, {...quote, occurrence: 1}];
      if (invalid === 'mixed') run.reply.claims[0].contentLocations = [quote, span(quote.text)];
      if (invalid === 'one_bad') run.reply.claims[0].contentLocations = [quote, {text: 'not in body'}];
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', reason: 'invalid_response',
        claims: [{claimId: 'claim-a', consistency: 'unknown', contentLocations: []}]});
    });

  it.each(['missing_offsets', 'mixed_quote', 'occurrence'] as const)(
    'never repairs v1 %s using the v2 quotation protocol', async invalid => {
      const run = fixture();
      const quote = {text: run.input.snapshot.body};
      if (invalid === 'missing_offsets') run.reply.claims[0].contentLocations = [quote as any];
      if (invalid === 'mixed_quote') run.reply.claims[0].contentLocations.push(quote as any);
      if (invalid === 'occurrence') Object.assign(run.reply.claims[0].contentLocations[0], {occurrence: 1});
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
    });

  it.each(['claim', 'issue', 'omission', 'requirement'] as const)(
    'resolves and validates every location in the %s collection', async collection => {
      const requirements = [{id: 'observation', label: 'Observation', required: true}];
      for (const invalid of [false, true]) {
        const run = quoteFixture({requirements, scope: 'scene_wide'});
        const locations = [{text: run.input.snapshot.body}, ...(invalid ? [{text: 'not in body'}] : [])];
        if (collection === 'claim') run.reply.claims[0].contentLocations = locations;
        if (collection === 'issue') {
          run.reply.claims[0].consistency = 'inconsistent';
          run.reply.claims[0].issues = [{code: 'numeric_mismatch', contentLocations: locations}];
        }
        if (collection === 'omission') run.reply.omissions = [{code: 'undeclared_claim', contentLocations: locations}];
        if (collection === 'requirement') run.reply.requirements[0].contentLocations = locations;
        const assessment = await assessFinalSemantics(run.input);
        // Framing rows (report requirements) still reject the response; claim-side rows degrade
        // without promotion: an unlocatable contradiction survives, anything else is unknown.
        const expected = !invalid
          ? {status: 'checked', consistency: collection === 'issue' || collection === 'omission' ? 'inconsistent' : 'consistent'}
          : collection === 'requirement' ? {reason: 'invalid_response', claims: [], omissions: [], requirements: []}
            : collection === 'issue' ? {status: 'checked', consistency: 'inconsistent',
              responseDiagnostic: {stage: 'claim', code: 'invalid_location', ordinal: 1},
              claims: [{claimId: 'claim-a', consistency: 'inconsistent', issues: [{code: 'numeric_mismatch', contentLocations: []}]}]}
              : collection === 'omission' ? {status: 'coverage_incomplete', reason: 'invalid_response', omissions: [],
                coverage: {body: 'incomplete'}}
                : {status: 'coverage_incomplete', reason: 'invalid_response', claims: [{claimId: 'claim-a', consistency: 'unknown', contentLocations: []}]};
        expect(assessment).toMatchObject(expected);
        if (!invalid) expect(JSON.stringify(assessment)).not.toContain('"text":');
      }
    });

  it.each(['missing_claim', 'duplicate_claim', 'missing_omissions', 'empty_omission', 'missing_requirement',
    'duplicate_requirement', 'wrong_claim_ref', 'coverage_gap', 'coverage_quote', 'extra_coverage'] as const)(
    'reports an invalid response for %s', async invalid => {
      const run = quoteFixture({requirements: [{id: 'observation', label: 'Observation', required: true}], scope: 'scene_wide'});
      if (invalid === 'missing_claim') run.reply.claims = [];
      if (invalid === 'duplicate_claim') run.reply.claims.push(structuredClone(run.reply.claims[0]));
      if (invalid === 'missing_omissions') delete run.reply.omissions;
      if (invalid === 'empty_omission') run.reply.omissions = [{code: 'undeclared_claim', contentLocations: []}];
      if (invalid === 'missing_requirement') run.reply.requirements = [];
      if (invalid === 'duplicate_requirement') run.reply.requirements.push(structuredClone(run.reply.requirements[0]));
      if (invalid === 'wrong_claim_ref') run.reply.requirements[0].claimIds = ['unknown'];
      if (invalid === 'coverage_gap') run.reply.bodyCoverage.reviewedSpans[0].end -= 1;
      if (invalid === 'coverage_quote') run.reply.bodyCoverage.reviewedSpans = [{text: run.input.snapshot.body}];
      if (invalid === 'extra_coverage') run.reply.bodyCoverage.reviewedSpans[0].text = run.input.snapshot.body;
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
    });
});

describe('final semantic v4 body span locations', () => {
  it('binds the exact issued Markdown line without asking the reviewer to copy its markers', async () => {
    const target = 'Runnable 合计（R+R+）= 1 570 314 ns（3.74%）。**主线程的 S 时间 5 931 641 ns 100% 落在主线程自身 `binder transaction` 跨期内**；R 时间中有 586 916 ns 落在 Binder 跨期内。';
    const body = `## 系统侧证据\n\n${target}\n\n**CPU 占位与频率**`;
    const run = fixture({body});
    const entry = useV4(run).find(item => item.text === target)!;
    run.reply.claims[0].contentLocations = [{spanId: entry.spanId}] as any;
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'checked', claims: [{contentLocations: [{
      start: body.indexOf(target), end: body.indexOf(target) + target.length,
    }]}]});
    expect(JSON.stringify(assessment)).not.toMatch(/spanId|contentLocationCatalog|"text":/);
  });

  it('preserves CRLF and UTF-16 offsets for emoji and combining characters', async () => {
    const target = '**😀 e\u0301 延迟。**';
    const body = `前言\r\n${target}\r\n结尾`;
    const run = fixture({body});
    const entries = useV4(run);
    const entry = entries.find(item => item.text === target)!;
    expect(entry.spanId).toMatch(/^L2\.[0-9a-f]{10}$/);
    run.reply.claims[0].contentLocations = [{spanId: entry.spanId}] as any;
    expect(await assessFinalSemantics(run.input)).toMatchObject({claims: [{contentLocations: [{
      start: body.indexOf(target), end: body.indexOf(target) + target.length,
    }]}]});
  });

  it('issues distinct ordinal-bound IDs for identical lines', async () => {
    const line = '**same line**';
    const body = `${line}\n${line}`;
    const run = fixture({body});
    const entries = useV4(run).filter(item => item.text === line);
    expect(entries).toHaveLength(2);
    expect(entries[0].spanId).not.toBe(entries[1].spanId);
    run.reply.claims[0].contentLocations = [{spanId: entries[1].spanId}] as any;
    expect(await assessFinalSemantics(run.input)).toMatchObject({claims: [{contentLocations: [{
      start: line.length + 1, end: body.length,
    }]}]});
  });

  it.each(['unknown', 'stale', 'digest', 'mixed', 'extra', 'duplicate_id_quote', 'split_surrogate'] as const)(
    'rejects %s catalog locations without repairing them', async invalid => {
      const body = '**😀 exact line**';
      const run = fixture({body});
      const entry = useV4(run)[0];
      const stale = fixture({body: '**different body**'});
      const staleId = assembledPayload(stale).contentLocationCatalog.entries[0].spanId;
      const bad: any[] = invalid === 'unknown' ? [{spanId: 'L1.0000000000'}]
        : invalid === 'stale' ? [{spanId: staleId}]
          : invalid === 'digest' ? [{spanId: `${entry.spanId.slice(0, -1)}${entry.spanId.endsWith('0') ? '1' : '0'}`}]
            : invalid === 'mixed' ? [{spanId: entry.spanId, text: body}]
              : invalid === 'extra' ? [{spanId: entry.spanId, verified: true}]
                : invalid === 'duplicate_id_quote' ? [{spanId: entry.spanId}, {text: body}]
                  : [{text: '\ud83d'}];
      run.reply.claims[0].contentLocations = bad;
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', reason: 'invalid_response',
        claims: [{claimId: 'claim-a', consistency: 'unknown', contentLocations: []}],
        responseDiagnostic: {stage: 'claim', code: 'invalid_location', ordinal: 1}});
    });

  it('issues short span IDs that are exact per request and never resolve for another body', async () => {
    const body = '**first line**\n**second line**';
    const run = fixture({body});
    const entries = useV4(run);
    expect(entries.map(entry => entry.spanId)).toEqual([expect.stringMatching(/^L1\.[0-9a-f]{10}$/),
      expect.stringMatching(/^L2\.[0-9a-f]{10}$/)]);
    expect(entries.every(entry => entry.spanId.length <= 16)).toBe(true);
    const other = fixture({body: '**first line**\n**other line**'});
    const otherIds = assembledPayload(other).contentLocationCatalog.entries.map((entry: any) => entry.spanId);
    // Same line ordinal and text, different body: the body digest keeps the IDs apart.
    expect(otherIds[0]).not.toBe(entries[0].spanId);
  });

  it.each(['claim', 'issue', 'omission', 'report', 'investigation'] as const)(
    'uses the common span resolver for %s locations', async collection => {
      const body = '**one issued line**';
      const run = fixture({body, scope: 'scene_wide', requirements: [{id: 'report', label: 'Report', required: true}],
        investigationRequirements: [{id: 'investigation', domain: 'methodology', description: 'Explain method.', required: true}]});
      const spanId = useV4(run)[0].spanId;
      const location = [{spanId}];
      run.reply.claims[0].contentLocations = collection === 'claim' ? location as any : [{text: body}] as any;
      if (collection === 'issue') {
        run.reply.claims[0].consistency = 'inconsistent';
        run.reply.claims[0].issues = [{code: 'numeric_mismatch', contentLocations: location}] as any;
      }
      if (collection === 'omission') run.reply.omissions = [{code: 'undeclared_claim', contentLocations: location}] as any;
      run.reply.requirements[0].contentLocations = collection === 'report' ? location as any : [{text: body}] as any;
      Object.assign(run.reply, {investigation: [{requirementId: 'investigation', applicability: 'applicable',
        coverage: 'covered', contentLocations: collection === 'investigation' ? location : [{text: body}],
        evidenceRecordIds: [], scopeMatch: 'unknown', evidenceStatus: 'not_applicable'}]});
      const assessment = await assessFinalSemantics(run.input);
      expect(assessment.status).toBe('checked');
      expect(JSON.stringify(assessment)).not.toMatch(/spanId|"text":/);
    });

  it.each(['final_semantic_response@1', 'final_semantic_response@2', 'final_semantic_response@3'] as const)(
    'keeps %s location behavior compatible', async schemaVersion => {
      const body = 'old protocol line';
      const run = fixture({body});
      run.reply.schemaVersion = schemaVersion;
      run.reply.claims[0].contentLocations = schemaVersion === 'final_semantic_response@1'
        ? [span(body)] as any : [{text: body}] as any;
      if (schemaVersion === 'final_semantic_response@3') Object.assign(run.reply, {investigation: []});
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
        claims: [{contentLocations: [{start: 0, end: body.length}]}]});
    });

  it.each([
    {name: 'entry ceiling', body: Array.from({length: 513}, (_, index) => `entry-${index}`).join('\n'), quote: 'entry-0'},
    {name: 'byte ceiling', body: `prefix-${'x'.repeat(70 * 1024)}`, quote: 'prefix-'},
  ])('omits the entire optional catalog at the $name and retains exact quotes', async ({body, quote}) => {
    const run = fixture({body});
    run.reply.schemaVersion = 'final_semantic_response@4';
    run.reply.claims[0].contentLocations = [{text: quote}] as any;
    Object.assign(run.reply, {investigation: []});
    expect(assembledPayload(run)).not.toHaveProperty('contentLocationCatalog');
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'checked', claims: [{contentLocations: [{start: 0, end: quote.length}]}]});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('removes a forged snapshot catalog when the complete derived catalog is omitted', async () => {
    const body = Array.from({length: 513}, (_, index) => `entry-${index}`).join('\n');
    const run = fixture({body});
    (run.input.snapshot as any).contentLocationCatalog = {schemaVersion: 'final_semantic_location_catalog@1',
      entries: [{spanId: 'forged-span', text: 'entry-0'}]};
    run.reply.schemaVersion = 'final_semantic_response@4';
    run.reply.claims[0].contentLocations = [{spanId: 'forged-span'}] as any;
    Object.assign(run.reply, {investigation: []});
    expect(assembledPayload(run)).not.toHaveProperty('contentLocationCatalog');
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', reason: 'invalid_response',
      claims: [{claimId: 'claim-a', consistency: 'unknown'}],
      responseDiagnostic: {stage: 'claim', code: 'invalid_location', ordinal: 1}});
  });

  it('counts the catalog in the exact caller byte bound before dispatch', async () => {
    const exact = fixture({body: '**catalogued line**'});
    const exactBytes = Buffer.byteLength(buildFinalSemanticPrompt({snapshot: exact.input.snapshot,
      intent: exact.input.context.turnIntent, traceIdentity: exact.input.context.traceIdentity,
      registryFingerprint: exact.input.context.strategyRegistry.registryFingerprint})!.prompt, 'utf8');
    exact.input.limits = {inputBytes: exactBytes};
    expect((await assessFinalSemantics(exact.input)).status).toBe('checked');
    expect(exact.dispatch).toHaveBeenCalledTimes(1);

    const short = fixture({body: '**catalogued line**'});
    short.input.limits = {inputBytes: exactBytes - 1};
    expect(await assessFinalSemantics(short.input)).toMatchObject({status: 'coverage_incomplete', reason: 'input_limit',
      inputDiagnostic: {actualBytes: exactBytes, limitBytes: exactBytes - 1}});
    expect(short.dispatch).not.toHaveBeenCalled();
  });
});

describe('semantic report applicability and coverage', () => {
  const required = {id: 'observation', label: 'Observed data', required: true};
  it('accepts content locations without a prescribed heading', async () => {
    const run = fixture({requirements: [required], scope: 'scene_wide'});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', coverage: {report: 'complete'},
      requirements: [{requirementId: 'observation', applicability: 'applicable', coverage: 'covered'}]});
  });

  it.each(['extra_id', 'duplicate_id', 'missing_id', 'bad_claim_ref', 'bad_one_of_many_spans', 'unconditional_waiver'] as const)(
    'rejects every invalid coverage row: %s', async issue => {
      const run = fixture({requirements: [required], scope: 'scene_wide'});
      if (issue === 'extra_id') run.reply.requirements[0].requirementId = 'unknown';
      if (issue === 'duplicate_id') run.reply.requirements.push(structuredClone(run.reply.requirements[0]));
      if (issue === 'missing_id') run.reply.requirements = [];
      if (issue === 'bad_claim_ref') run.reply.requirements[0].claimIds.push('unknown-claim');
      if (issue === 'bad_one_of_many_spans') run.reply.requirements[0].contentLocations.push({start: -1, end: 1, text: 'bad'});
      if (issue === 'unconditional_waiver') Object.assign(run.reply.requirements[0], {applicability: 'not_applicable', coverage: 'unknown'});
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
    });

  it('permits bounded semantic applicability and retains unresolved conditions as unknown', async () => {
    const bounded = fixture({requirements: [required], scope: 'bounded_question'});
    Object.assign(bounded.reply.requirements[0], {applicability: 'not_applicable', coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(bounded.input)).toMatchObject({status: 'checked', requirements: [{applicability: 'not_applicable'}]});
    const unresolved = fixture({requirements: [{...required, condition: {kind: 'unresolved', reason: 'legacy_trigger_patterns'}}]});
    Object.assign(unresolved.reply.requirements[0], {applicability: 'unknown', coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(unresolved.input)).toMatchObject({status: 'coverage_incomplete', coverage: {report: 'incomplete'}});
  });

  it.each([true, false])('keeps optional unknown coverage non-blocking with required rows=%s', async includeRequired => {
    const optional = {id: 'optional', label: 'Optional context', required: false,
      condition: {kind: 'semantic' as const, description: 'When useful to the question.'}};
    const run = fixture({requirements: [...(includeRequired ? [required] : []), optional], scope: 'scene_wide'});
    const optionalRow = run.reply.requirements.find(item => item.requirementId === 'optional')!;
    Object.assign(optionalRow, {applicability: 'unknown', coverage: 'unknown', contentLocations: [], claimIds: []});
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'checked', coverage: {report: 'complete'}});
    expect(assessment.requirements).toContainEqual({requirementId: 'optional', applicability: 'unknown', coverage: 'unknown',
      contentLocations: [], claimIds: []});
  });

  it.each(['not_checked', 'unavailable', 'checked'] as const)('uses actual case retrieval state %s without inventing complete search', async status => {
    const run = fixture({requirements: [{...required, condition: {kind: 'strong_case_retrieval'}}],
      caseRetrieval: {status, recommendations: []}});
    Object.assign(run.reply.requirements[0], {applicability: status === 'checked' ? 'not_applicable' : 'unknown',
      coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: status === 'checked' ? 'checked' : 'coverage_incomplete'});
  });

  it('cannot waive an actual strong case retrieval requirement', async () => {
    const run = fixture({requirements: [{...required, condition: {kind: 'strong_case_retrieval'}}],
      caseRetrieval: {status: 'checked', recommendations: [{caseId: 'case-1', title: 'Relevant case', matchStrength: 'strong', recommendations: {app: [], oem: []}}]}});
    Object.assign(run.reply.requirements[0], {applicability: 'not_applicable', coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
  });

  it('rejects absent or mutated requirement pins before dispatch', async () => {
    const run = fixture({requirements: [required]});
    run.input.snapshot.reportRequirements = undefined;
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
    const mutated = fixture({requirements: [required]});
    mutated.input.snapshot.reportRequirements = {...mutated.input.snapshot.reportRequirements!,
      requirements: [{...required, label: 'unrelated requirement'}]};
    expect(await assessFinalSemantics(mutated.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(mutated.dispatch).not.toHaveBeenCalled();
  });
});

describe('semantic dispatch failure and cancellation', () => {
  it.each(['provider_error', 'timeout', 'tool_use', 'incomplete_output', 'output_limit'] as const)(
    'does not turn native %s into a semantic pass', async reason => {
      const run = fixture({dispatch: async () => ({status: 'unavailable', reason})});
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason, consistency: 'unknown'});
      expect(run.dispatch).toHaveBeenCalledTimes(1);
    });

  it('rejects an oversized response without accepting its prefix', async () => {
    const run = fixture({dispatch: async () => ({status: 'ok', text: 'x'.repeat(65_537)})});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', reason: 'output_limit'});
  });

  it('does not disclose provider exception details', async () => {
    const run = fixture({dispatch: async () => {throw new Error('credential=do-not-echo');}});
    const result = await assessFinalSemantics(run.input);
    expect(result).toMatchObject({status: 'unavailable', reason: 'provider_error'});
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  });

  it('honors pre-dispatch cancellation and an already-expired original deadline', async () => {
    const cancelled = fixture();
    cancelled.controller.abort();
    expect(() => assessFinalSemantics(cancelled.input)).toThrow();
    expect(cancelled.dispatch).not.toHaveBeenCalled();
    const expired = fixture({deadlineMs: Date.now() - 1});
    expect(await assessFinalSemantics(expired.input)).toMatchObject({reason: 'timeout'});
    expect(expired.dispatch).not.toHaveBeenCalled();
  });

  it('uses the context deadline to stop an unresponsive native callback', async () => {
    jest.useFakeTimers({now: 1_000});
    const run = fixture({deadlineMs: 1_100, dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const pending = assessFinalSemantics(run.input);
    await jest.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({reason: 'timeout', consistency: 'unknown'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(1_100);
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it('accepts a same-request response after 60 seconds when the original run deadline has time remaining', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    let settled = false;
    void pending.then(() => {settled = true;});
    await jest.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(91_000);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    expect(await pending).toMatchObject({status: 'checked', consistency: 'consistent'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.input.context.deadlineMs).toBe(91_000);
  });

  it('stops an unresponsive issued transport at the original deadline without renewing it on repeated calls', async () => {
    jest.useFakeTimers({now: 1_000});
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const pending = assessFinalSemantics(run.input);
    let settled = false;
    void pending.then(() => {settled = true;});
    await jest.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({status: 'unavailable', reason: 'timeout', consistency: 'unknown'});
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(91_000);
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves the original absolute deadline across dispatch delay and ignores success after the cached timeout', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    // Synchronous work before the dispatch microtask consumes the original run budget.
    jest.setSystemTime(31_000);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    await jest.advanceTimersByTimeAsync(60_000);
    const timeout = await pending;
    expect(timeout).toMatchObject({status: 'unavailable', reason: 'timeout'});
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(91_000);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    await jest.advanceTimersByTimeAsync(0);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(await assessFinalSemantics(run.input)).toBe(timeout);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful response after a clock jump past the original deadline before its timer runs', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    await jest.advanceTimersByTimeAsync(0);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    jest.setSystemTime(91_001);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    expect(await pending).toMatchObject({status: 'unavailable', reason: 'timeout', consistency: 'unknown'});
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('stops a disposed context and never accepts its late response', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    await jest.advanceTimersByTimeAsync(0);
    run.input.context.dispose();
    const disposed = await pending;
    expect(disposed).toMatchObject({status: 'unavailable', consistency: 'unknown'});
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toBe(disposed);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('lets owner cancellation win before the original deadline even if the callback never settles', async () => {
    jest.useFakeTimers({now: 1_000});
    const run = fixture({deadlineMs: 901_000, dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const pending = assessFinalSemantics(run.input);
    const cancelled = new Error('review owner cancelled');
    const rejected = expect(pending).rejects.toBe(cancelled);
    await jest.advanceTimersByTimeAsync(100);
    run.controller.abort(cancelled);
    await rejected;
    expect(Date.now()).toBe(1_100);
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not turn an invalid original deadline %s into a valid service budget', async deadlineMs => {
      const run = fixture();
      run.input.context = {...run.input.context, deadlineMs};
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'not_checked', reason: 'invalid_configuration'});
      expect(run.dispatch).not.toHaveBeenCalled();
    });

  it('propagates cancellation and discards a late successful response', async () => {
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    const rejection = expect(pending).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    run.controller.abort();
    await rejection;
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });
});
