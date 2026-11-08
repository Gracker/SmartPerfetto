// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {attachFinalizationContext, takeFinalizationContext, isIssuedFinalizationContext,
  type RuntimeFinalizationContextInput} from '../analysisFinalizationContext';

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

afterEach(() => {jest.useRealTimers();});



describe('private runtime finalization context', () => {
  it('is taken once from the exact result and never copied into serializable results', () => {
    const {result, input} = fixture();
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
    expect(() => context.runId).toThrow();
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

  it('carries no native declaration, selection or capability view for the finalizer', () => {
    const {result, input} = fixture();
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    expect(context).not.toHaveProperty('getNativeDeclaration');
    expect(context).not.toHaveProperty('getSelection');
    expect(context).not.toHaveProperty('capabilityEvidence');
    context.dispose();
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

  it('bounds an unresponsive reader by the original deadline', async () => {
    jest.useFakeTimers({now: 1000});
    let receivedSignal: AbortSignal | undefined;
    const {result, input} = fixture({deadlineMs: 1100,
      evidenceReadView: {resolveReferences: (_requests, signal) => {
        receivedSignal = signal; return new Promise(() => {});
      }},
    });
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const pending = context.resolveReferences([{key: 'ref', reference: {artifactId: 'artifact'}, requiredColumns: []}],
      new AbortController().signal);
    await jest.advanceTimersByTimeAsync(100);
    expect(receivedSignal?.aborted).toBe(true);
    expect(await pending).toEqual([{key: 'ref', status: 'incomplete', reason: 'deadline_exceeded'}]);
    context.dispose();
  });

  it.each(['caller', 'dispose'] as const)('cancels in-flight callbacks via %s even when they ignore abort', async source => {
    let receivedSignal: AbortSignal | undefined;
    const {result, input} = fixture({evidenceReadView: {resolveReferences: (_requests, signal) => {
      receivedSignal = signal; return new Promise(() => {});
    }}});
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const controller = new AbortController();
    const pending = context.resolveReferences([{key: 'ref', reference: {artifactId: 'artifact'}, requiredColumns: []}],
      controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await Promise.resolve();
    if (source === 'caller') controller.abort();
    else context.dispose();
    await assertion;
    expect(receivedSignal?.aborted).toBe(true);
    context.dispose();
  });

});
