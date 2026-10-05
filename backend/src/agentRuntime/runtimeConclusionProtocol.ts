// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {
  buildCandidateProtocolDiagnostic,
  inspectCandidateProtocol,
  sanitizeCandidateProtocolDiagnostic,
  type CandidateProtocolDiagnostic,
} from '../services/canonicalAnalysisResult';
import {MAX_CLAIM_DIAGNOSTICS} from '../agent/core/conclusionContract';
import type {AnalysisCompletion} from '../types/analysisDelivery';
import type {AnalysisTurnIntent} from './analysisTurnIntent';

export const MISSING_NATIVE_DECLARATION = 'missing_declaration' as const;
export const INVALID_NATIVE_DECLARATION = 'invalid_declaration' as const;

/** Exact schema guidance is loaded only for an existing invalid-relation correction. */
export function buildRelationProposalRecoveryPromptFragment(
  diagnostic: CandidateProtocolDiagnostic,
  outputLanguage: OutputLanguage,
): string {
  const safe = sanitizeCandidateProtocolDiagnostic(diagnostic);
  if (!safe?.issueCodes.includes('invalid_relation_proposal')) return '';
  return renderRequiredLocalizedStrategyTemplate('prompt-relation-proposal-recovery', outputLanguage, {});
}

/** Append the exact relation schema to a prompt when the diagnostic reports a rejected proposal. */
export function appendRelationProposalRecoveryFragment(
  prompt: string,
  diagnostic: CandidateProtocolDiagnostic,
  outputLanguage: OutputLanguage,
): string {
  const fragment = buildRelationProposalRecoveryPromptFragment(diagnostic, outputLanguage);
  return fragment ? `${prompt}\n\n${fragment}` : prompt;
}

export interface NativeDeclarationCompletionRequest {
  readonly reason: typeof MISSING_NATIVE_DECLARATION | typeof INVALID_NATIVE_DECLARATION;
  /** The visible answer, free of machine protocol segments; the accepted candidate is this body plus the new declaration. */
  readonly originalBody: string;
  /** The well-framed declaration segment the parser rejected; invalid_declaration only. */
  readonly rejectedDeclaration?: string;
  /** String claim ids the rejected declaration declared; a repair must keep every one. */
  readonly declaredClaimIds?: readonly string[];
  readonly diagnostic: CandidateProtocolDiagnostic;
}

/** Framing failures can truncate or blur the body, so only a well-framed rejected declaration is repaired. */
const UNREPAIRABLE_DECLARATION_ISSUES = new Set(['invalid_framing', 'duplicate_marker']);

/** Parse issue codes, a closed vocabulary. */
function formatIssueCodes(issues: readonly {code: string}[]): string {
  return issues.map(issue => issue.code).join('|') || 'none';
}

/** Closed vocabulary only (claim position, issue code, schema field), never model values. */
function formatClaimDiagnostics(diagnostic: CandidateProtocolDiagnostic): string {
  return diagnostic.claimDiagnostics?.map(detail =>
    `${detail.ordinal}:${detail.code}:${detail.field}${detail.subreason ? `:${detail.subreason}` : ''}`).join(',') || 'none';
}

function projectTurnIntentForDeclarationCompletion(intent: AnalysisTurnIntent) {
  return {
    schemaVersion: 1 as const,
    status: intent.status,
    taskKind: intent.taskKind,
    sceneId: intent.sceneId,
    scope: intent.scope,
    deliverable: intent.deliverable,
    evidenceAccess: intent.evidenceAccess,
  };
}

/**
 * Typed intent decides whether a declaration is required. Prose shape and
 * wording never make that decision; a non-acknowledgement clarification uses
 * a `need_input` declaration with empty claims. With `repairInvalid`, a
 * well-framed declaration the parser rejected gets the same one delivery call
 * to be corrected: one invalid claim otherwise leaves every claim unverified.
 */
export function requestNativeDeclarationCompletion(input: {
  intent: AnalysisTurnIntent;
  completion: Pick<AnalysisCompletion, 'status'>;
  candidate: string;
  remainingDeliveryTurns: number;
  repairInvalid?: boolean;
}): NativeDeclarationCompletionRequest | undefined {
  if (input.intent.taskKind === 'acknowledgement' || input.completion.status !== 'completed' ||
      !Number.isSafeInteger(input.remainingDeliveryTurns) || input.remainingDeliveryTurns <= 0) return undefined;
  const inspected = inspectCandidateProtocol(input.candidate);
  if (!inspected.canonicalBody.trim()) return undefined;
  const diagnostic = Object.freeze(buildCandidateProtocolDiagnostic(inspected, 'native', 1));
  if (inspected.status === 'absent') {
    return Object.freeze({reason: MISSING_NATIVE_DECLARATION, originalBody: input.candidate, diagnostic});
  }
  const [segment, ...others] = inspected.sidecar.machineSegments;
  if (!input.repairInvalid || inspected.status !== 'invalid' || inspected.sidecar.status !== 'invalid' || !segment ||
      others.length || inspected.sidecar.issues.some(issue => UNREPAIRABLE_DECLARATION_ISSUES.has(issue.code))) {
    // The rejected declaration is private and reaches no log, report or snapshot,
    // so a skipped repair is otherwise invisible: name the deciding facts in the
    // protocol's own closed vocabulary, never the model's values.
    if (inspected.status === 'invalid') {
      console.log(`[DeclarationRepair] not requested: repairInvalid=${input.repairInvalid === true} ` +
        `sidecar=${inspected.sidecar.status} segments=${inspected.sidecar.machineSegments.length} ` +
        `issues=${formatIssueCodes(inspected.sidecar.issues)} ` +
        `claimDiagnostics=${formatClaimDiagnostics(diagnostic)}`);
    }
    return undefined;
  }
  const payload = inspected.sidecar.rawPayload as {claims?: unknown} | undefined;
  // Only ids the parser accepts: a blank id is itself a failure the repair has to fix.
  const declaredClaimIds = Array.isArray(payload?.claims) ? [...new Set(payload.claims.flatMap(item => {
    const id = item && typeof item === 'object' ? (item as {id?: unknown}).id : undefined;
    return typeof id === 'string' && id.trim() ? [id] : [];
  }))] : [];
  console.log(`[DeclarationRepair] requested: reason=${INVALID_NATIVE_DECLARATION} ` +
    `issues=${formatIssueCodes(inspected.sidecar.issues)} ` +
    `claims=${diagnostic.claimCount ?? 0} claimDiagnostics=${formatClaimDiagnostics(diagnostic)}`);
  // Edge whitespace left at the removed segment's seam is not part of the answer.
  return Object.freeze({reason: INVALID_NATIVE_DECLARATION, originalBody: inspected.canonicalBody.trim(),
    rejectedDeclaration: input.candidate.slice(segment.start, segment.end), declaredClaimIds: Object.freeze(declaredClaimIds),
    diagnostic});
}

/** Whether a candidate carries an answer body; a declaration alone is not one. */
export function candidateHasAnswerBody(candidate: string): boolean {
  return inspectCandidateProtocol(candidate).canonicalBody.trim().length > 0;
}

/**
 * A completed, non-acknowledgement run whose final reply has no answer body
 * (only a declaration, or nothing) may spend its one delivery call writing the
 * body. Runtimes without an issue-based correction (OpenCode, Qoder) ask here;
 * the call is spent once attempted.
 */
export function nativeBodyCompletionNeeded(input: {
  intent: AnalysisTurnIntent;
  completion: Pick<AnalysisCompletion, 'status'>;
  candidate: string;
  remainingDeliveryTurns: number;
}): boolean {
  return input.intent.taskKind !== 'acknowledgement' && input.completion.status === 'completed' &&
    Number.isSafeInteger(input.remainingDeliveryTurns) && input.remainingDeliveryTurns > 0 &&
    !candidateHasAnswerBody(input.candidate);
}

/** The body alone must fit; no caller may shorten it to make room for a declaration. */
export function nativeDeclarationBodyCanFitOutput(
  body: string,
  outputByteLimit: number | undefined,
): boolean {
  return outputByteLimit === undefined || Number.isSafeInteger(outputByteLimit) && outputByteLimit > 0 &&
    Buffer.byteLength(body, 'utf8') < outputByteLimit;
}

function nativeDeclarationCandidateFitsOutput(candidate: string, outputByteLimit: number | undefined): boolean {
  return outputByteLimit === undefined || Number.isSafeInteger(outputByteLimit) && outputByteLimit > 0 &&
    Buffer.byteLength(candidate, 'utf8') <= outputByteLimit;
}

/** Build the one no-tool completion request with the full native body as data. */
export function buildNativeDeclarationCompletionPrompt(input: {
  request: NativeDeclarationCompletionRequest;
  intent: AnalysisTurnIntent;
  outputLanguage: OutputLanguage;
}): string {
  const prompt = renderRequiredLocalizedStrategyTemplate(
    'prompt-native-declaration-completion',
    input.outputLanguage,
    {
      completion_reason: input.request.reason,
      turn_intent: JSON.stringify(projectTurnIntentForDeclarationCompletion(input.intent)),
      original_candidate_json: JSON.stringify({
        schemaVersion: 1,
        kind: 'original_native_candidate',
        body: input.request.originalBody,
      }),
      rejected_declaration_json: JSON.stringify(input.request.rejectedDeclaration === undefined ? null
        : {schemaVersion: 1, kind: 'rejected_declaration', text: input.request.rejectedDeclaration}),
      max_claim_diagnostics: String(MAX_CLAIM_DIAGNOSTICS),
      candidate_protocol_diagnostic: JSON.stringify(
        sanitizeCandidateProtocolDiagnostic(input.request.diagnostic) ?? null,
      ),
    },
  );
  return input.request.reason === INVALID_NATIVE_DECLARATION
    ? appendRelationProposalRecoveryFragment(prompt, input.request.diagnostic, input.outputLanguage) : prompt;
}

/**
 * The completion supplies only the declaration; the delivered candidate is the
 * original body plus that declaration, so the answer the user reads can never
 * change here. Asking a model to re-copy a long answer verbatim fails often
 * (one changed character rejected most glm-5.3 repairs) and costs as many
 * output tokens as the answer; prose the completion adds around its
 * declaration is discarded, never delivered.
 */
export function acceptNativeDeclarationCompletion(input: {
  request: NativeDeclarationCompletionRequest;
  completion: Pick<AnalysisCompletion, 'status'>;
  candidate: string;
  outputByteLimit?: number;
}): string | undefined {
  // The rejected candidate reaches no report or snapshot, so a dropped repair is
  // otherwise invisible: log the deciding facts in closed vocabulary and counts
  // only, never model text (rooted_lock_monitor delivered its undeclared first
  // candidate after a valid 14-claim completion with no trace of why).
  const reject = (reason: string, facts: Record<string, string | number | boolean> = {}): undefined => {
    console.log(`[DeclarationRepair] completion rejected: request=${input.request.reason} reason=${reason}` +
      Object.entries(facts).map(([key, value]) => ` ${key}=${value}`).join(''));
    return undefined;
  };
  if (input.completion.status !== 'completed') return reject('completion_not_completed', {completion: input.completion.status});
  if (!nativeDeclarationCandidateFitsOutput(input.candidate, input.outputByteLimit)) return reject('output_limit');
  const original = inspectCandidateProtocol(input.request.originalBody);
  if (original.status !== 'absent') return reject('original_not_absent', {original: original.status});
  const repaired = inspectCandidateProtocol(input.candidate);
  const [segment, ...others] = repaired.sidecar.machineSegments;
  if (repaired.status !== 'valid' || repaired.sidecar.status !== 'valid' || !segment || others.length) {
    const diagnostic = buildCandidateProtocolDiagnostic(repaired, 'native', 2);
    return reject('declaration_not_valid', {repaired: repaired.status, sidecar: repaired.sidecar.status,
      issues: formatIssueCodes(repaired.sidecar.issues),
      claimDiagnostics: formatClaimDiagnostics(diagnostic)});
  }
  // A repair that drops declared claims turns an unverified answer into one with undeclared assertions.
  if (input.request.reason === INVALID_NATIVE_DECLARATION) {
    const claims = repaired.sidecar.contract?.claims ?? [];
    const ids = new Set(claims.map(claim => claim.id));
    const droppedIds = input.request.declaredClaimIds?.filter(id => !ids.has(id)).length ?? 0;
    if (claims.length < (input.request.diagnostic.claimCount ?? 0) || droppedIds) {
      return reject('claims_dropped', {expectedClaims: input.request.diagnostic.claimCount ?? 0,
        repairedClaims: claims.length, droppedIds});
    }
  }
  const originalBody = original.canonicalBody.trim();
  const completionProse = repaired.canonicalBody.trim();
  // A completion that echoed the body unchanged is already the candidate.
  if (completionProse === originalBody) return input.candidate;
  if (completionProse) {
    console.log(`[DeclarationRepair] completion prose discarded: request=${input.request.reason} ` +
      `proseChars=${completionProse.length} originalChars=${originalBody.length}`);
  }
  return `${originalBody}\n\n${input.candidate.slice(segment.start, segment.end)}`;
}
