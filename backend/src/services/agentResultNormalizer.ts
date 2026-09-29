// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared "normalize an AnalysisResult before it reaches the user" helpers.
 *
 * Both delivery paths (HTTP SSE and CLI HTML report) need to:
 *   1. Run the conclusion text through `normalizeConclusionOutput` when the
 *      heuristic says to (see `shouldNormalizeConclusionOutput`).
 *   2. If the orchestrator didn't populate `conclusionContract`, derive one
 *      from the normalized-but-unsanitized conclusion so machine-readable
 *      evidence refs survive display cleanup.
 *   3. Sanitize user-facing narrative text (strip internal evidence IDs,
 *      replace legacy phrases).
 *
 * HTTP route used to inline all of this in `sendAgentDrivenResult`. CLI's
 * `buildReportHtml` skipped the step entirely, so the CLI-produced HTML
 * diverged from the web UI for the same session. Centralize the logic
 * here so `buildAgentDrivenReportData` receives an already-normalized
 * result regardless of the delivery path.
 */

import {
  deriveConclusionContract,
  normalizeConclusionOutput,
  shouldNormalizeConclusionOutput,
} from '../agent/core/conclusionGenerator';
import { hasDeliverableFinalReportHeading } from './finalResultQualityGate';
import { sanitizeNarrativeForClient } from '../routes/narrativeSanitizer';
import type { AnalysisResult } from '../agent/core/orchestratorTypes';
import type {
  ConclusionContract,
  ConclusionOutputMode,
} from '../agent/core/conclusionContract';
import type { DataEnvelope } from '../types/dataContract';
import {
  sanitizeConclusionSourceContract,
  verifySourceClaimBindingsForResult,
} from './codebase/sourceClaimVerifier';
import type {AnalysisTurnIntent} from '../agentRuntime/analysisTurnIntent';
import {analysisDeliveryFingerprint, type AnalysisDeliveryEntry} from '../types/analysisDelivery';

interface ConclusionContractDeriveOptions {
  mode?: ConclusionOutputMode;
  sceneId?: string;
}

interface EvidenceBackedConclusionContractDeriveOptions extends ConclusionContractDeriveOptions {
  entry?: AnalysisDeliveryEntry;
  turnIntent?: AnalysisTurnIntent;
  existingContract?: ConclusionContract | null;
  dataEnvelopes?: DataEnvelope[];
  runSequence?: number;
  requestedAnalysisMode?: 'fast' | 'full' | 'auto';
}

export function resolveConclusionOutputModeForTurn(input: {
  existingMode?: ConclusionOutputMode | null;
  turnIntent?: AnalysisTurnIntent;
  runSequence?: number;
  requestedAnalysisMode?: 'fast' | 'full' | 'auto';
}): ConclusionOutputMode {
  if (input.existingMode === 'need_input') return 'need_input';
  if (input.turnIntent?.status === 'resolved') {
    return input.turnIntent.deliverable === 'report' ? 'initial_report' : 'focused_answer';
  }
  return input.existingMode ?? 'initial_report';
}

/**
 * Normalize a conclusion string for contract parsing without user-facing
 * sanitization. This keeps evidence/source ids available for
 * `deriveConclusionContract`; display sanitization may intentionally remove
 * those ids later.
 */
export function normalizeNarrativeForContract(narrative: string): string {
  const raw = String(narrative || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (
    !hasDeliverableFinalReportHeading(trimmed) &&
    shouldNormalizeConclusionOutput(trimmed)
  ) {
    try {
      return normalizeConclusionOutput(trimmed).trim() || raw;
    } catch {
      return raw;
    }
  }

  return raw;
}

/**
 * Derive a conclusion contract before display sanitization can remove internal
 * evidence ids from machine-readable references.
 */
export function deriveConclusionContractForNarrative(
  narrative: string,
  options: ConclusionContractDeriveOptions = {},
): ConclusionContract | undefined {
  // Parse typed output before presentation normalization can turn it into
  // Markdown and discard claim kinds, relation references or missing refs.
  const rawContract = deriveConclusionContract(narrative, options);
  if (rawContract) return rawContract;
  return deriveConclusionContract(normalizeNarrativeForContract(narrative), options) || undefined;
}

/**
 * Preserve the claims actually supplied by the producer before verification.
 *
 * DataEnvelope cells are verification inputs, never replacement statements.
 * Matching a number in prose cannot establish its unit, subject or causal
 * meaning. Missing references remain missing; narrative without explicit
 * claims remains not_checked. The optional evidence argument is retained for
 * callers that use this shared HTTP/CLI normalization boundary.
 */
export function deriveEvidenceBackedConclusionContractForNarrative(
  narrative: string,
  _dataEnvelopes: DataEnvelope[] | undefined,
  options: EvidenceBackedConclusionContractDeriveOptions = {},
): ConclusionContract | undefined {
  return options.existingContract || deriveConclusionContractForNarrative(narrative, options);
}

/**
 * Normalize a conclusion string for end-user display. Safe to call on any
 * input; falls back to the original text when normalization would empty it.
 */
export function normalizeNarrativeForClient(narrative: string): string {
  const normalized = normalizeNarrativeForContract(narrative);
  return sanitizeNarrativeForClient(normalized) || normalized;
}

/**
 * Normalize an AnalysisResult's conclusion + re-derive its conclusionContract
 * (if missing) using the conversation turn rather than provider-internal rounds.
 * Returns the input unchanged when no fields would actually change, so the
 * identity check in callers (`result === normalized`) stays cheap.
 */
export function normalizeResultForReport(
  result: AnalysisResult,
  options: EvidenceBackedConclusionContractDeriveOptions = {},
): AnalysisResult {
  if (options.entry === 'historical_restore') return result;
  const normalizedConclusion = normalizeNarrativeForClient(result.conclusion);
  const turnIntent = options.turnIntent;
  const mode = resolveConclusionOutputModeForTurn({
    existingMode: result.conclusionContract?.mode,
    turnIntent,
    runSequence: options.runSequence,
    requestedAnalysisMode: options.requestedAnalysisMode,
  });
  const existingContract = result.conclusionContract?.mode === mode
    ? result.conclusionContract
    : result.conclusionContract
      ? {...result.conclusionContract, mode}
      : undefined;
  const derivedContract =
    deriveEvidenceBackedConclusionContractForNarrative(result.conclusion, options.dataEnvelopes, {
      ...options,
      existingContract,
      mode,
    }) || undefined;
  const scopedContract = derivedContract && turnIntent?.status === 'resolved' && derivedContract.mode !== mode
    ? {...derivedContract, mode} : derivedContract;
  let normalizedContract = scopedContract
    ? sanitizeConclusionSourceContract(scopedContract, {
        actualSourceUseDecision: result.sourceUseDecision ?? null,
      })
    : undefined;
  let sourceClaimVerificationResult = result.sourceClaimVerificationResult;
  if (normalizedContract) {
    const resultWithNormalizedContract = {
      ...result,
      conclusionContract: normalizedContract,
    };
    const verification = verifySourceClaimBindingsForResult(resultWithNormalizedContract);
    if (verification) {
      sourceClaimVerificationResult = verification;
      normalizedContract = {
        ...normalizedContract,
        sourceClaimBindings: verification.bindings,
      };
    }
  }

  if (
    normalizedConclusion === result.conclusion &&
    normalizedContract === result.conclusionContract &&
    sourceClaimVerificationResult === result.sourceClaimVerificationResult
  ) {
    return result;
  }
  const bodyChanged = normalizedConclusion !== result.conclusion;
  const contractChanged = analysisDeliveryFingerprint(normalizedContract) !==
    analysisDeliveryFingerprint(result.conclusionContract);
  const verificationChanged = analysisDeliveryFingerprint(sourceClaimVerificationResult) !==
    analysisDeliveryFingerprint(result.sourceClaimVerificationResult);
  return {
    ...result,
    conclusion: normalizedConclusion,
    conclusionContract: normalizedContract,
    ...(sourceClaimVerificationResult ? {sourceClaimVerificationResult} : {}),
    // Presentation normalization cannot re-sign an accepted candidate or its verdict.
    ...(bodyChanged ? {completion: undefined} : {}),
    ...(bodyChanged || contractChanged ? {reportAssessment: undefined} : {}),
    ...(bodyChanged || contractChanged || verificationChanged ? {investigationAssessment: undefined} : {}),
    ...(bodyChanged || contractChanged || verificationChanged ? {deliveryAssurance: undefined} : {}),
  };
}
