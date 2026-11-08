// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisResult} from '../../src/agent/core/orchestratorTypes';
import {attachFinalizationContext, takeFinalizationContext, type RuntimeFinalizationContextInput} from '../../src/agentRuntime/analysisFinalizationContext';
import {analysisDeliveryFingerprint, type AnalysisDeliveryContext} from '../../src/types/analysisDelivery';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../src/services/codebase/sourceClaimVerifier';

/**
 * Product-entry fixture only: a completed assistant-text candidate with its
 * projected delivery context and finalization context, as a runtime hands it over.
 */
export function attachIssuedAssistantEntryFixture(input: {
  result: AnalysisResult; runId: string; registry: RuntimeFinalizationContextInput['strategyRegistry'];
  traceId?: string; authorizationFingerprint?: string;
}) {
  const {result, runId, registry} = input;
  const candidate = {runId, attemptId: 'entry-attempt', candidateRef: 'entry-candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const delivery: AnalysisDeliveryContext = {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
    completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}};
  result.outputOrigin = 'sdk_final';
  result.completion = delivery.completion;
  const projection = finalizeOwnerSourceAwareAnalysisResultWithProjection(result, undefined, {context: delivery});
  const context = projection.deliveryContext;
  if (!context || context.entry === 'historical_restore') throw new Error('Entry fixture must project a delivery context');
  attachFinalizationContext(result, {sessionId: result.sessionId, runId, deadlineMs: Date.now() + 600_000,
    strategyRegistry: registry, traceIdentity: input.traceId ? {currentTraceId: input.traceId} : {},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
      deliverable: 'answer', evidenceAccess: 'existing_only'},
    deliveryContext: context});
  return {result, cleanup: () => {takeFinalizationContext(result)?.dispose();}};
}
