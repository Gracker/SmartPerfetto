// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * What a runtime may ask about its own draft before it hands the candidate
 * to the product: does a same-run continuation or declaration repair apply?
 *
 * The answer steers only that repair. A draft diagnostic never writes the
 * terminal state: it does not set `partial`, `terminationReason` or
 * `confidence`, emits no `degraded` (or any other) update, and changes nothing
 * a runtime records before `addTurn`. A runtime records only native facts
 * there (completion status, turn limit, timeout, provider failure,
 * cancellation, an empty native body). The quality verdict belongs to the
 * product-owned `finalizeAnalysisResult`, which assesses the exact candidate
 * once and then annotates the recorded turn.
 */

import type {AnalysisPlanV3, Hypothesis, VerificationIssue} from '../agentv3/types';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {AnalysisDeliveryContext} from '../types/analysisDelivery';
import {verifyConclusion} from './engines/claude/claudeVerifier';
import {INVALID_NATIVE_DECLARATION, type NativeDeclarationCompletionRequest} from './runtimeConclusionProtocol';

export interface RuntimeDraftDiagnostics {
  /** Errors about the delivered candidate itself, not about plan or hypothesis bookkeeping. */
  readonly deliveryErrors: readonly VerificationIssue[];
  /** Delivery errors a same-run correction can address. */
  readonly recoverableIssues: readonly VerificationIssue[];
}

const OBLIGATION_ISSUE_TYPES = new Set<VerificationIssue['type']>(['plan_deviation', 'unresolved_hypothesis']);

export async function assessRuntimeDraft(input: {
  conclusion: string;
  deliveryContext: AnalysisDeliveryContext;
  plan?: AnalysisPlanV3 | null;
  hypotheses?: Hypothesis[];
  outputLanguage: OutputLanguage;
}): Promise<RuntimeDraftDiagnostics> {
  const {heuristicIssues} = await verifyConclusion([], input.conclusion, {
    plan: input.plan ?? null,
    hypotheses: input.hypotheses,
    outputLanguage: input.outputLanguage,
    deliveryContext: input.deliveryContext,
  });
  const deliveryErrors = heuristicIssues.filter(issue => issue.severity === 'error' && !OBLIGATION_ISSUE_TYPES.has(issue.type));
  return {deliveryErrors, recoverableIssues: deliveryErrors.filter(issue => issue.recoveryKind !== undefined)};
}

export type RuntimeDraftRecovery =
  | {readonly kind: 'declaration'; readonly request: NativeDeclarationCompletionRequest}
  | {readonly kind: 'correction'; readonly issues: readonly VerificationIssue[]};

/**
 * One delivery turn, one repair. A declaration repair that can run wins; one
 * that was needed but cannot run (it does not fit, or the budget is gone)
 * leaves the issue-based correction available, as before repairs existed,
 * except when the declaration is merely missing: a correction cannot supply it.
 */
export function chooseRuntimeDraftRecovery(input: {
  /** What `requestNativeDeclarationCompletion` asked for. */
  declarationNeed?: NativeDeclarationCompletionRequest;
  /** The same request once the runtime's output and budget checks admitted it. */
  declarationRequest?: NativeDeclarationCompletionRequest;
  recoverableIssues: readonly VerificationIssue[];
}): RuntimeDraftRecovery | undefined {
  if (input.declarationRequest) return {kind: 'declaration', request: input.declarationRequest};
  const correctionAllowed = input.declarationNeed === undefined ||
    input.declarationNeed.reason === INVALID_NATIVE_DECLARATION;
  return correctionAllowed && input.recoverableIssues.length > 0
    ? {kind: 'correction', issues: input.recoverableIssues}
    : undefined;
}
