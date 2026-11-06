// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {attachFinalizationContext, takeFinalizationContext, isIssuedFinalizationContext,
  reportReviewUsesRemainingBudget, type RuntimeFinalizationContextInput} from '../analysisFinalizationContext';
import {finalizeSourceAwareAnalysisResultWithProjection} from '../../services/codebase/sourceClaimVerifier';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'finalization-test'});

function fixture(overrides: Partial<RuntimeFinalizationContextInput> = {}) {
  const result: AnalysisResult = {sessionId: 'session', conclusion: 'Measured output', success: true,
    confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
  const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const input: RuntimeFinalizationContextInput = {
    runId: 'run', sessionId: result.sessionId, deadlineMs: Date.now() + 1000,
    strategyRegistry: registry,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic',
      registryFingerprint: registry.registryFingerprint, taskKind: 'fact', sceneId: 'general',
      scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'existing_only'},
    traceIdentity: {currentTraceId: 'trace'},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate,
      completion: {...candidate, schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk'},
      outputOrigin: 'sdk_final'},
    ...overrides,
  };
  return {result, input};
}

const textInput = (signal: AbortSignal, deadlineMs = Date.now() + 1000) => ({
  signal, deadlineMs, prompt: 'review', systemPrompt: 'review', outputByteLimit: 1000,
});

afterEach(() => {jest.useRealTimers();});

describe('report review budget', () => {
  const intent = {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'r',
    taskKind: 'investigation', sceneId: 'general', scope: 'scene_wide', recommendedComplexity: 'full',
    deliverable: 'report', evidenceAccess: 'read_new'} as const;
  const eligible = {conclusionContract: {bindingEligibility: 'eligible'}} as unknown as AnalysisResult;

  it('extends a report that will make its review, and nothing else', () => {
    expect(reportReviewUsesRemainingBudget({semanticCall: true, turnIntent: intent, result: eligible})).toBe(true);
    // No declaration at all still gets reviewed; an ineligible one is skipped, so it keeps the reserve.
    expect(reportReviewUsesRemainingBudget({semanticCall: true, turnIntent: intent, result: {} as AnalysisResult})).toBe(true);
    expect(reportReviewUsesRemainingBudget({semanticCall: true, turnIntent: intent,
      result: {conclusionContract: {bindingEligibility: 'ineligible'}} as unknown as AnalysisResult})).toBe(false);
    expect(reportReviewUsesRemainingBudget({semanticCall: false, turnIntent: intent, result: eligible})).toBe(false);
    expect(reportReviewUsesRemainingBudget({semanticCall: true, turnIntent: {...intent, deliverable: 'answer'}, result: eligible})).toBe(false);
    expect(reportReviewUsesRemainingBudget({semanticCall: true, turnIntent: {...intent, status: 'unavailable'}, result: eligible})).toBe(false);
    expect(reportReviewUsesRemainingBudget({semanticCall: true, result: eligible})).toBe(false);
  });
});

describe('native v2 finalization transport admission', () => {
  it.each((['authored_claim_document_v2', 'authored_claim_document_v2_dual'] as const).flatMap(mode =>
    (['submitted', 'missing_submission', 'transport_failure'] as const).map(outcome => ({mode, outcome}))))(
    'keeps $mode/$outcome without an issued v2 binding from dispatching review', async ({mode, outcome}) => {
      const dispatch = jest.fn<NonNullable<RuntimeFinalizationContextInput['dispatchText']>>()
        .mockResolvedValue({status: 'ok', text: '{}'});
      const {result, input} = fixture({dispatchText: dispatch});
      if (input.deliveryContext.entry === 'historical_restore') throw new Error('Unexpected fixture entry');
      input.deliveryContext.finalSubmission = {mode, outcome};
      attachFinalizationContext(result, input);
      const context = takeFinalizationContext(result)!;
      try {
        expect(context.hasSemanticTransport).toBe(false);
        expect(await context.dispatchText(textInput(new AbortController().signal)))
          .toEqual({status: 'unavailable', reason: 'invalid_configuration'});
        expect(dispatch).not.toHaveBeenCalled();
      } finally {context.dispose();}
    });
});

describe('private runtime finalization context', () => {
  function projectedFixture() {
    const {result, input} = fixture();
    const contract = {schemaVersion: 'conclusion_contract_v1' as const, mode: 'focused_answer' as const,
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'original', text: 'An original declaration.', references: [{evidenceRefId: 'data:original',
        rowSelector: {name: 'ORIGINAL_MACHINE_VALUE'}, column: 'name', value: 'ORIGINAL_MACHINE_VALUE'}]}]};
    result.conclusion = `A useful answer.\n${renderConclusionContractSidecar(contract)}`;
    if (input.deliveryContext.entry === 'historical_restore') throw new Error('Unexpected fixture entry');
    input.deliveryContext.acceptedCandidate!.conclusionFingerprint = analysisDeliveryFingerprint(result.conclusion);
    input.deliveryContext.completion = {...input.deliveryContext.completion!, ...input.deliveryContext.acceptedCandidate!};
    const projected = finalizeSourceAwareAnalysisResultWithProjection(result, undefined, {context: input.deliveryContext});
    input.deliveryContext = projected.deliveryContext!;
    input.protocolProjection = projected.protocolProjection;
    return {result, input};
  }

  it('keeps native declarations private, frozen, single-owner and disposed with the context', () => {
    const {result, input} = projectedFixture();
    expect(JSON.stringify(input.protocolProjection)).not.toContain('ORIGINAL_MACHINE_VALUE');
    attachFinalizationContext(result, input);
    expect(() => attachFinalizationContext({...result}, input)).toThrow('already_claimed');
    const context = takeFinalizationContext(result)!;
    const native = context.getNativeDeclaration(result, new AbortController().signal)!;
    if (native.inputKind === 'model_tool_arguments' || native.inputKind === 'assistant_json') {
      throw new Error('Expected assistant-text declaration');
    }
    expect(native.raw).toContain('ORIGINAL_MACHINE_VALUE');
    expect(Object.isFrozen(native)).toBe(true);
    expect(JSON.stringify(context)).not.toContain('ORIGINAL_MACHINE_VALUE');
    context.dispose();
    expect(() => context.getNativeDeclaration(result, new AbortController().signal)).toThrow('disposed');
    expect(() => attachFinalizationContext({...result}, input)).toThrow('projection_mismatch');
  });

  it.each(['run', 'attempt', 'body', 'claims', 'token'] as const)('rejects a changed %s before accepting a native projection', field => {
    const {result, input} = projectedFixture();
    if (input.deliveryContext.entry === 'historical_restore') throw new Error('Unexpected fixture entry');
    if (field === 'run') {input.runId = 'other-run'; input.deliveryContext.acceptedCandidate!.runId = 'other-run';}
    if (field === 'attempt') input.deliveryContext.acceptedCandidate!.attemptId = 'other-attempt';
    if (field === 'body') result.conclusion += ' Changed.';
    if (field === 'claims') result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: []};
    if (field === 'token') input.protocolProjection = {...input.protocolProjection!};
    expect(() => attachFinalizationContext(result, input)).toThrow('projection_mismatch');
  });

  it('checks the displayed result again when the finalizer takes the private declaration', () => {
    const {result, input} = projectedFixture();
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    result.conclusion += ' Changed after context attachment.';
    expect(() => context.getNativeDeclaration(result, new AbortController().signal)).toThrow('projection_mismatch');
    context.dispose();
  });

  it('is taken once from the exact result and never copied into serializable results', () => {
    const {result, input} = fixture({dispatchText: async () => ({status: 'ok', text: 'private provider output'})});
    const before = JSON.stringify(result);
    attachFinalizationContext(result, input);
    expect(JSON.stringify(result)).toBe(before);
    expect(takeFinalizationContext({...result})).toBeUndefined();
    expect(takeFinalizationContext(JSON.parse(before))).toBeUndefined();
    const context = takeFinalizationContext(result)!;
    expect(context.runId).toBe('run');
    expect(isIssuedFinalizationContext(context)).toBe(true);
    expect(isIssuedFinalizationContext({...context})).toBe(false);
    expect(takeFinalizationContext(result)).toBeUndefined();
    context.dispose();
    expect(isIssuedFinalizationContext(context)).toBe(false);
    expect(() => context.hasSemanticTransport).toThrow();
  });

  it('detaches captured input facts before callers can mutate them', () => {
    const {result, input} = fixture({sourceScope: {codeAwareMode: 'metadata_only', selectedCodebaseIds: ['source-a'],
      hasCodebaseAccess: true, analysisContextFingerprint: 'scope-a'}});
    attachFinalizationContext(result, input);
    input.traceIdentity.currentTraceId = 'another-trace';
    input.sourceScope!.selectedCodebaseIds.push('source-b');
    input.sourceScope!.analysisContextFingerprint = 'scope-b';
    if (input.deliveryContext.entry !== 'historical_restore') input.deliveryContext.acceptedCandidate!.runId = 'another-run';
    const context = takeFinalizationContext(result)!;
    expect(context.traceIdentity.currentTraceId).toBe('trace');
    expect(context.deliveryContext).toMatchObject({acceptedCandidate: {runId: 'run'}});
    expect(Object.isFrozen(context.traceIdentity)).toBe(true);
    expect(context.sourceScope).toEqual({codeAwareMode: 'metadata_only', selectedCodebaseIds: ['source-a'],
      hasCodebaseAccess: true, analysisContextFingerprint: 'scope-a'});
    expect(Object.isFrozen(context.sourceScope!.selectedCodebaseIds)).toBe(true);
    context.dispose();
  });

  it('keeps canonical selection private, frozen and bound to the current run trace', () => {
    const selection = {present: true as const, kind: 'track_event' as const,
      context: {kind: 'track_event' as const, eventId: 7, ts: 42, dur: 9},
      sideResolution: {status: 'resolved' as const, traceSide: 'current' as const, traceId: 'trace'}};
    const {result, input} = fixture({selection});
    attachFinalizationContext(result, input);
    selection.context.eventId = 99;
    const context = takeFinalizationContext(result)!;
    const signal = new AbortController().signal;
    expect(context.getSelection(signal)).toEqual({present: true, kind: 'track_event',
      context: {kind: 'track_event', eventId: 7, ts: 42, dur: 9},
      sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'trace'}});
    expect(Object.isFrozen(context.getSelection(signal))).toBe(true);
    expect(JSON.stringify(context)).not.toContain('eventId');
    context.dispose();
    expect(() => context.getSelection(signal)).toThrow('disposed');
  });

  it('preserves missing, no-selection and side-unknown states without rebinding them', () => {
    for (const selection of [undefined, {present: false as const}, {present: true as const, kind: 'track_event' as const,
      context: {kind: 'track_event' as const, eventId: 7, ts: 42}, sideResolution: {status: 'unknown' as const}}]) {
      const {result, input} = fixture({selection});
      attachFinalizationContext(result, input);
      const context = takeFinalizationContext(result)!;
      expect(context.getSelection(new AbortController().signal)).toEqual(selection);
      context.dispose();
    }
  });

  it('rejects a foreign trace or noncanonical selection before issuing a context', () => {
    const foreign = fixture({selection: {present: true, kind: 'track_event',
      context: {kind: 'track_event', eventId: 7, ts: 42},
      sideResolution: {status: 'resolved', traceSide: 'current', traceId: 'other-trace'}}});
    expect(() => attachFinalizationContext(foreign.result, foreign.input)).toThrow('selection_mismatch');
    const transformed = fixture({selection: {present: true, kind: 'track_event',
      context: {kind: 'track_event', eventId: 7, ts: 42, trackUri: ' track '},
      sideResolution: {status: 'unknown'}}});
    expect(() => attachFinalizationContext(transformed.result, transformed.input)).toThrow('analysis_run_selection_invalid');
  });

  it('keeps provider query in a frozen private method view that expires with its context', () => {
    const query = {text: 'PRIVATE_PROVIDER_QUERY', analysisContextFingerprint: 'selection-v1'};
    const {result, input} = fixture({providerQuery: query});
    attachFinalizationContext(result, input);
    query.text = 'A changed query';
    const context = takeFinalizationContext(result)!;
    const signal = new AbortController().signal;
    expect(context.getProviderQuery(signal)).toEqual({text: 'PRIVATE_PROVIDER_QUERY', analysisContextFingerprint: 'selection-v1'});
    expect(Object.isFrozen(context.getProviderQuery(signal))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_QUERY');
    expect(JSON.stringify(context)).not.toContain('PRIVATE_PROVIDER_QUERY');
    const cancelled = new AbortController();
    cancelled.abort();
    expect(() => context.getProviderQuery(cancelled.signal)).toThrow();
    context.dispose();
    expect(() => context.getProviderQuery(signal)).toThrow();
  });

  it('rejects historical, wrong-run, wrong-session and mismatched registry contexts', () => {
    for (const overrides of [
      {deliveryContext: {entry: 'historical_restore' as const}},
      {runId: 'another'}, {sessionId: 'another'},
      {turnIntent: {...fixture().input.turnIntent, registryFingerprint: 'another'}},
    ]) {
      const {result, input} = fixture(overrides);
      expect(() => attachFinalizationContext(result, input)).toThrow();
      expect(takeFinalizationContext(result)).toBeUndefined();
    }
  });

  it('does not replace a context already attached to the same result', () => {
    const {result, input} = fixture();
    attachFinalizationContext(result, input);
    expect(() => attachFinalizationContext(result, input)).toThrow();
    takeFinalizationContext(result)!.dispose();
  });

  it.each(['reader', 'provider'] as const)('bounds an unresponsive %s by the original deadline', async kind => {
    jest.useFakeTimers({now: 1000});
    let receivedSignal: AbortSignal | undefined;
    const {result, input} = fixture({deadlineMs: 1100,
      evidenceReadView: {resolveReferences: (_requests, signal) => {
        receivedSignal = signal; return new Promise(() => {});
      }},
      dispatchText: request => {receivedSignal = request.signal; return new Promise(() => {});},
    });
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const signal = new AbortController().signal;
    const pending = kind === 'reader'
      ? context.resolveReferences([{key: 'ref', reference: {artifactId: 'artifact'}, requiredColumns: []}], signal)
      : context.dispatchText(textInput(signal, 9000));
    await jest.advanceTimersByTimeAsync(100);
    expect(receivedSignal?.aborted).toBe(true);
    expect(await pending).toEqual(kind === 'reader'
      ? [{key: 'ref', status: 'incomplete', reason: 'deadline_exceeded'}]
      : {status: 'unavailable', reason: 'timeout'});
    context.dispose();
  });

  it.each(['caller', 'dispose'] as const)('cancels in-flight callbacks via %s even when they ignore abort', async source => {
    let receivedSignal: AbortSignal | undefined;
    const {result, input} = fixture({dispatchText: request => {
      receivedSignal = request.signal; return new Promise(() => {});
    }});
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const controller = new AbortController();
    const pending = context.dispatchText(textInput(controller.signal));
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await Promise.resolve();
    if (source === 'caller') controller.abort();
    else context.dispose();
    await assertion;
    expect(receivedSignal?.aborted).toBe(true);
    context.dispose();
  });

  it('never dispatches an expired or cancelled operation and clamps a longer requested deadline', async () => {
    const dispatchText = jest.fn<NonNullable<RuntimeFinalizationContextInput['dispatchText']>>()
      .mockResolvedValue({status: 'ok', text: '{}'});
    const {result, input} = fixture({dispatchText});
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const controller = new AbortController();
    await context.dispatchText(textInput(controller.signal, input.deadlineMs + 1000));
    expect(dispatchText.mock.calls[0][0].deadlineMs).toBe(input.deadlineMs);
    expect(await context.dispatchText(textInput(controller.signal, 1))).toEqual({status: 'unavailable', reason: 'timeout'});
    controller.abort();
    await expect(context.dispatchText(textInput(controller.signal))).rejects.toMatchObject({name: 'AbortError'});
    expect(dispatchText).toHaveBeenCalledTimes(1);
    context.dispose();
  });
});
