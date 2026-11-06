// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisResult} from '../../src/agent/core/orchestratorTypes';
import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject} from '../../src/agent/core/authoredClaimObject';
import {AUTHORED_CLAIM_OBJECT_COMPILER_VERSION, createAuthoredFinalSubmissionIssuer, issueAuthoredFinalSubmission,
  readAuthoredFinalSubmission, revokeAuthoredFinalSubmission, type AuthoredFinalSubmissionV2ReadInput} from '../../src/agentRuntime/authoredFinalSubmission';
import {attachFinalizationContext, takeFinalizationContext, type RuntimeFinalizationContextInput} from '../../src/agentRuntime/analysisFinalizationContext';
import {analysisDeliveryFingerprint, type AnalysisDeliveryContext} from '../../src/types/analysisDelivery';
import {finalizeOwnerSourceAwareAnalysisResultWithProjection} from '../../src/services/codebase/sourceClaimVerifier';

/** Product-entry fixture only: the actual SDK admission/drain contract has separate owning tests.
 * This independently authored clarification has no trace facts or hydrated assertions. */
export function attachIssuedNativeObjectEntryFixture(input: {
  result: AnalysisResult; runId: string; registry: RuntimeFinalizationContextInput['strategyRegistry'];
  traceId?: string; authorizationFingerprint?: string;
}) {
  const {result, runId, registry} = input;
  const nativeDocument = {representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, referenceDictionary: [], semanticFrames: [],
    contract: {mode: 'need_input', conclusions: null, clusters: null, evidenceChain: null, claims: [],
      uncertainties: null, nextSteps: null, relationProposals: null, sourceClaimBindings: [], metadata: null},
    bodyParts: [result.conclusion]};
  const rawArguments = JSON.stringify({document: nativeDocument});
  const compiled = compileAuthoredClaimObject(nativeDocument);
  if (compiled.status !== 'compiled') throw new Error('Entry fixture must compile');
  const binding = {owner: {}, sessionId: result.sessionId, runId, attemptId: 'entry-attempt',
    providerPin: 'fixture-pinned-provider', authorizationFingerprint: input.authorizationFingerprint ?? 'entry-auth'};
  const issuer = createAuthoredFinalSubmissionIssuer({binding, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
    assertCurrent: () => undefined, assertAttemptCurrent: () => undefined});
  const dispatch = {dispatchOrdinal: 1, responseId: 'entry-response', callId: 'entry-call'};
  const submission = issueAuthoredFinalSubmission(issuer, {...dispatch, rawArguments, nativeDocument, compiled});
  const readInput: AuthoredFinalSubmissionV2ReadInput = {binding: {...binding, ...dispatch,
    representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, compilerContractVersion: AUTHORED_CLAIM_OBJECT_COMPILER_VERSION},
    rawArguments, nativeDocument: structuredClone(nativeDocument), body: compiled.body,
    rawCanonicalPayload: structuredClone(compiled.rawCanonicalPayload)};
  const candidate = {runId, attemptId: binding.attemptId, candidateRef: 'entry-candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const delivery: AnalysisDeliveryContext = {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'model_tool_arguments',
    finalSubmission: {mode: 'authored_claim_document_v2', outcome: 'submitted'},
    completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}};
  result.outputOrigin = delivery.outputOrigin; result.completion = delivery.completion;
  const projection = finalizeOwnerSourceAwareAnalysisResultWithProjection(result, undefined,
    {context: delivery, authoredSubmission: {submission, input: readInput}});
  if (!projection.deliveryContext || !projection.protocolProjection) throw new Error('Entry fixture must issue a projection');
  attachFinalizationContext(result, {sessionId: result.sessionId, runId, deadlineMs: Date.now() + 600_000,
    strategyRegistry: registry, traceIdentity: input.traceId ? {currentTraceId: input.traceId} : {},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
      deliverable: 'answer', evidenceAccess: 'existing_only'},
    deliveryContext: projection.deliveryContext, protocolProjection: projection.protocolProjection});
  return {result, read: () => readAuthoredFinalSubmission(submission, readInput),
    cleanup: () => {takeFinalizationContext(result)?.dispose(); revokeAuthoredFinalSubmission(submission);}};
}
