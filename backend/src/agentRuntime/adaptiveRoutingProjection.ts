// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import type {AnalysisOptions} from '../agent/core/orchestratorTypes';
import type {DataEnvelope} from '../types/dataContract';
import type {AdaptiveRoutingReceiptV1} from '../types/adaptiveRouting';
import type {RunManifestBuilder} from '../services/selfEvolution/runManifestBuilder';
import type {RuntimeQuickModeResolution} from './quickModeResolution';
import {
  routeAdaptiveEvidencePostEvidence,
  routeAdaptiveEvidencePreflight,
} from './adaptiveEvidenceRouter';

export function buildAdaptiveRoutingPreflight(input: {
  requestedMode: AdaptiveRoutingReceiptV1['requestedMode'];
  resolvedMode: AdaptiveRoutingReceiptV1['resolvedMode'];
  classifierSource: AdaptiveRoutingReceiptV1['classifierSource'];
  quickAcknowledgementDirectAnswer: boolean;
  directEvidenceAvailable: boolean;
  hasReferenceTrace: boolean;
  privateContext: boolean;
  outputCap?: number;
}): AdaptiveRoutingReceiptV1 {
  const hardObligations: AdaptiveRoutingReceiptV1['obligations'] = [
    ...(input.requestedMode === 'full' ? ['complete_report' as const] : []),
    ...(input.hasReferenceTrace ? ['reference_comparison' as const] : []),
    ...(input.privateContext ? ['private_context' as const] : []),
  ];
  const classifierIntent = input.quickAcknowledgementDirectAnswer
    ? 'acknowledgement' as const
    : input.directEvidenceAvailable
      ? 'deterministic_direct_evidence' as const
      : input.resolvedMode === 'quick'
        ? 'semantic_quick' as const
        : 'semantic_full' as const;
  return routeAdaptiveEvidencePreflight({
    requestedMode: input.requestedMode,
    resolvedMode: input.resolvedMode,
    classifierSource: input.classifierSource,
    classifierIntent,
    hardObligations,
    ...(input.outputCap === undefined ? {} : {outputCap: input.outputCap}),
  });
}

function privateContext(options: AnalysisOptions): boolean {
  const codeAware = options.codeAwareMode !== undefined
    && options.codeAwareMode !== 'off'
    && (options.codebaseIds?.length ?? 0) > 0;
  return codeAware || (options.knowledgeSourceIds?.length ?? 0) > 0;
}

export function buildAdaptiveRoutingForModeDecision(input: {
  options: AnalysisOptions;
  resolvedMode: 'quick' | 'full';
  classifierSource: AdaptiveRoutingReceiptV1['classifierSource'];
  quickAcknowledgementDirectAnswer: boolean;
  directEvidenceAvailable: boolean;
  outputCap?: number;
}): AdaptiveRoutingReceiptV1 {
  return buildAdaptiveRoutingPreflight({
    requestedMode: input.options.analysisMode ?? 'auto',
    resolvedMode: input.resolvedMode,
    classifierSource: input.classifierSource,
    quickAcknowledgementDirectAnswer:
      input.quickAcknowledgementDirectAnswer,
    directEvidenceAvailable: input.directEvidenceAvailable,
    hasReferenceTrace: Boolean(input.options.referenceTraceId),
    privateContext: privateContext(input.options),
    ...(input.outputCap === undefined ? {} : {outputCap: input.outputCap}),
  });
}

export function buildAdaptiveRoutingForQuickResolution(input: {
  options: AnalysisOptions;
  resolution: RuntimeQuickModeResolution;
  outputCap?: number;
}): AdaptiveRoutingReceiptV1 {
  const source: AdaptiveRoutingReceiptV1['classifierSource'] =
    input.resolution.requestedMode !== 'auto'
      ? 'user_explicit'
      : input.resolution.localReason
        ? 'hard_rule'
        : 'runtime';
  return buildAdaptiveRoutingForModeDecision({
    options: input.options,
    resolvedMode: input.resolution.quickMode ? 'quick' : 'full',
    classifierSource: source,
    quickAcknowledgementDirectAnswer:
      input.resolution.quickAcknowledgementDirectAnswer,
    directEvidenceAvailable: Boolean(
      input.resolution.quickFocusAppPreEvidence
      || input.resolution.quickProcessIdentityPreEvidence
      || input.resolution.quickTraceFactPreEvidence
      || input.resolution.quickScrollingTriagePreEvidence,
    ),
    ...(input.outputCap === undefined ? {} : {outputCap: input.outputCap}),
  });
}

function identityStatus(
  result: AnalysisResult,
): AdaptiveRoutingReceiptV1['evidence']['identityStatus'] {
  const statuses = result.identityResolutions?.map(item => item.status) ?? [];
  if (statuses.length === 0) return 'unknown';
  if (statuses.some(status => status === 'error')) return 'conflict';
  if (statuses.some(status =>
    status === 'ambiguous' || status === 'weak' || status === 'missing')) {
    return 'ambiguous';
  }
  if (statuses.every(status => status === 'not_required')) return 'not_required';
  return 'verified';
}

function conflictCount(result: AnalysisResult): number {
  return result.claimVerificationResult?.issues.filter(issue =>
    /(?:mismatch|conflict|contradict)/i.test(issue.code)).length ?? 0;
}

function schemaStatus(
  dataEnvelopes: readonly DataEnvelope[],
): AdaptiveRoutingReceiptV1['evidence']['schemaStatus'] {
  if (dataEnvelopes.length === 0) return 'unknown';
  return dataEnvelopes.some(envelope =>
    envelope.meta.executionStatus === 'optional_error'
    || Boolean(envelope.meta.executionError))
    ? 'uncertain'
    : 'ready';
}

function causalOpen(result: AnalysisResult): number {
  return result.claimSupport?.filter(claim =>
    claim.kind === 'causal'
    && claim.relationEvaluation !== undefined
    && claim.relationEvaluation !== 'verified'
    && claim.relationEvaluation !== 'not_configured').length ?? 0;
}

export function buildAdaptiveRoutingPostEvidence(input: {
  previous: AdaptiveRoutingReceiptV1;
  result: AnalysisResult;
  dataEnvelopes: readonly DataEnvelope[];
}): AdaptiveRoutingReceiptV1 {
  const verification = input.result.claimVerificationResult;
  const verifiedClaims = verification?.claimResults.filter(claim =>
    claim.status === 'verified').length ?? 0;
  const hardCapTurns = input.result.quickRun?.hardCapTurns ?? 0;
  const dispatchBudgetRatio = hardCapTurns > 0
    ? (input.result.quickRun?.actualTurns ?? 0) / hardCapTurns
    : 0;
  return routeAdaptiveEvidencePostEvidence({
    previous: input.previous,
    evidence: {
      required: verification?.checkedClaimCount ?? 0,
      observed: verifiedClaims,
      unsupportedClaims: verification?.unsupportedClaimCount ?? 0,
      conflicts: conflictCount(input.result),
      identityStatus: identityStatus(input.result),
      schemaStatus: schemaStatus(input.dataEnvelopes),
      causalOpen: causalOpen(input.result),
    },
    dispatchBudgetRatio,
    // No cross-runtime stable repeated-call counter exists yet.
    repeatedToolCalls: 0,
  });
}

export function recordAdaptiveRoutingPostEvidenceBestEffort(input: {
  builder: RunManifestBuilder;
  result: AnalysisResult;
  dataEnvelopes: readonly DataEnvelope[];
  onDiagnostic?: (code: string) => void;
}): boolean {
  try {
    const previous = input.builder.currentAdaptiveRouting;
    if (!previous) return false;
    if (input.builder.isSealed) {
      input.onDiagnostic?.('adaptive_routing_post_evidence_skipped');
      return false;
    }
    input.builder.recordAdaptiveRouting(buildAdaptiveRoutingPostEvidence({
      previous,
      result: input.result,
      dataEnvelopes: input.dataEnvelopes,
    }));
    return true;
  } catch {
    input.onDiagnostic?.('adaptive_routing_post_evidence_skipped');
    return false;
  }
}
