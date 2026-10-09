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
import {MAX_CLAIM_DIAGNOSTICS, isConclusionRootParseIssue, parseConclusionContractDeclaration,
  parseDeclaredConclusionClaims, parseDeclaredRelationProposals, relationProposalFailure,
  type ConclusionContractClaimItem} from '../agent/core/conclusionContract';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';
import type {AnalysisCompletion} from '../types/analysisDelivery';
import type {AnalysisTurnIntent} from './analysisTurnIntent';
import type {VerificationIssue} from '../agentv3/types';

export const MISSING_NATIVE_DECLARATION = 'missing_declaration' as const;
export const INVALID_NATIVE_DECLARATION = 'invalid_declaration' as const;

/** A claim id the protocol treats as usable: a non-blank string. */
const usableClaimId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** A proposal id that itself satisfies the proposal schema's id rule. */
const usableProposalId = (value: unknown): value is string =>
  typeof value === 'string' && /^proposal:[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);

const rawClaimId = (item: unknown): unknown =>
  item && typeof item === 'object' && !Array.isArray(item) ? (item as {id?: unknown}).id : undefined;

/**
 * Per-item facts for one raw claims-array entry: whether it passes its own item
 * validation and the normalized subset fingerprint the repair matrix compares.
 * A single-item parse can only produce claim-scoped issues, so `issues.length`
 * is that item's validity.
 */
function claimItemFacts(item: unknown): {valid: boolean; fingerprint?: string; duplicateKey?: string;
  claim?: ConclusionContractClaimItem} {
  const parsed = parseDeclaredConclusionClaims([item]);
  if (parsed.issues.length || !parsed.claims[0]) return {valid: false};
  const claim = parsed.claims[0];
  return {valid: true, fingerprint: analysisDeliveryFingerprint(declaredClaimSubset(claim)),
    // Duplicate detection compares content without the id: two ids must not
    // launder one repeated declaration entry (plan A.3 condition 6).
    duplicateKey: analysisDeliveryFingerprint(declaredClaimSubset(claim, true)), claim};
}

/** The normalized repair-identity subset of one typed claim (plan A.3 condition 3). */
function declaredClaimSubset(claim: ConclusionContractClaimItem, withoutId = false) {
  return {
    ...(!withoutId && claim.id !== undefined ? {id: claim.id} : {}),
    text: claim.text,
    ...(claim.kind !== undefined ? {kind: claim.kind} : {}),
    references: claim.references,
    ...(claim.artifactRefs !== undefined ? {artifactRefs: claim.artifactRefs} : {}),
    ...(claim.relationRefs !== undefined ? {relationRefs: claim.relationRefs} : {}),
    ...(claim.semantics !== undefined ? {semantics: claim.semantics} : {}),
  };
}

/** Per-item facts for one raw relation-proposal entry, by the same single-item rule. */
function relationItemFacts(item: unknown): {valid: boolean; fingerprint?: string; duplicateKey?: string} {
  const parsed = parseDeclaredRelationProposals([item]);
  if (parsed.issues.length || !parsed.relationProposals[0]) return {valid: false};
  const proposal = parsed.relationProposals[0] as unknown as Record<string, unknown>;
  const {id: _id, ...withoutId} = proposal;
  return {valid: true, fingerprint: analysisDeliveryFingerprint(proposal),
    duplicateKey: analysisDeliveryFingerprint(withoutId)};
}

/**
 * The stable semantic subset an invalid proposal's repair must keep: every
 * schema field that individually resolves, fail-closed when kind and subject
 * (and a present object) do not, because such a proposal has no identity to
 * preserve and cannot be a repair target (plan A.3 condition 5).
 */
const RELATION_IDENTITY_FIELDS = ['kind', 'direction', 'subject', 'object', 'proof', 'proofBindings',
  'metricColumn', 'value', 'unit', 'deltaDirection'] as const;

function relationProposalIdentitySubset(item: unknown):
  {repairable: boolean; subset?: Record<string, unknown>} {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return {repairable: false};
  const record = item as Record<string, unknown>;
  const subset: Record<string, unknown> = {};
  let resolvable = 0;
  for (const field of RELATION_IDENTITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const value = record[field];
    if (fieldValidatesIndividually(field, value)) {subset[field] = value; resolvable += 1;}
  }
  const kindOk = typeof record.kind === 'string' && Boolean(record.kind.trim()) &&
    ['overlap', 'wakeup', 'blocking_state', 'binder_peer', 'lock_owner', 'comparison_delta', 'derived'].includes(record.kind);
  const subjectOk = relationProposalFailure({kind: 'overlap', direction: 'subject_to_object',
    id: 'proposal:identity-probe', subject: record.subject}) === undefined;
  const objectOk = record.object === undefined ||
    relationProposalFailure({kind: 'overlap', direction: 'subject_to_object',
      id: 'proposal:identity-probe', subject: {sourceToolCallId: 'probe'}, object: record.object}) === undefined;
  return {repairable: kindOk && subjectOk && objectOk, ...(resolvable ? {subset} : {})};
}

/**
 * Whether one proposal field's value alone satisfies its own schema rule. The
 * probe's scaffolding fields are valid by construction, so the all-or-nothing
 * validator's verdict attributes any failure to the probed value.
 */
function fieldValidatesIndividually(field: string, value: unknown): boolean {
  const probe = {kind: 'overlap', direction: 'subject_to_object', id: 'proposal:identity-probe',
    subject: {sourceToolCallId: 'probe'}} as Record<string, unknown>;
  probe[field] = value;
  return relationProposalFailure(probe) === undefined;
}

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
  /** The complete isolated declaration segment the parser rejected; invalid_declaration only. */
  readonly rejectedDeclaration?: string;
  /** String claim ids the rejected declaration declared; a repair must keep every one. */
  readonly declaredClaimIds?: readonly string[];
  /** Complete recovered proposals cannot disappear to bypass a schema failure. */
  readonly declaredRelationCount?: number;
  readonly declaredRelationIds?: readonly string[];
  /** The original declaration failed at its root (framing/JSON/root schema), not per item. */
  readonly originalRootInvalid?: boolean;
  readonly diagnostic: CandidateProtocolDiagnostic;
}

/** Recover data only from a unique, closed machine segment already located by the strict scanner.
 * This does not admit its declaration: the replacement must pass the unchanged parser.
 */
function recoverClosedDeclarationPayload(segment: string): unknown {
  const reject = (reason: string) => {
    console.log(`[DeclarationRepair] framing not recoverable: reason=${reason}`);
    return undefined;
  };
  const lines = segment.trimEnd().split(/\r?\n/);
  if (lines.length < 3 || lines[lines.length - 1].trim() !== '-->') return reject('comment_not_closed');
  const interior = lines.slice(1, -1).join('\n').trim().split('\n');
  const first = interior[0].trim();
  const last = interior[interior.length - 1].trim();
  let payload = interior.join('\n');
  if (first.startsWith('`') || last.startsWith('`')) {
    const opening = /^(`{3,})([A-Za-z]*)[ \t]*$/.exec(first);
    const closing = /^(`{3,})[ \t]*$/.exec(last);
    if (!opening || !closing || opening[1] !== closing[1]) return reject('fence_pair_invalid');
    if (opening[2] && opening[2].toLowerCase() !== 'json') return reject('fence_label_invalid');
    payload = interior.slice(1, -1).join('\n');
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : reject('payload_not_object');
  } catch { return reject('payload_not_json'); }
}

/** Read original declaration data solely to preserve it during a repair, never to admit evidence. */
export function recoverNativeDeclarationPayload(candidate: string): unknown {
  const inspected = inspectCandidateProtocol(candidate);
  if (inspected.sidecar.rawPayload !== undefined) return inspected.sidecar.rawPayload;
  const [segment, ...others] = inspected.sidecar.machineSegments;
  if (!segment || others.length || inspected.sidecar.issues.some(issue => issue.code === 'duplicate_marker') ||
      !inspected.sidecar.issues.some(issue => issue.code === 'invalid_framing')) return undefined;
  return recoverClosedDeclarationPayload(candidate.slice(segment.start, segment.end));
}

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

/** Shared structured delivery issue projection; model prose never changes controller decisions. */
export function projectRuntimeCorrectionContext(issues: readonly VerificationIssue[]) {
  const errors = issues.filter(issue => issue.severity === 'error');
  const missingSections = new Map(errors.filter(issue => issue.recoveryKind === 'complete_report_content')
    .flatMap(issue => issue.missingSections ?? []).map(section => [section.id, section]));
  return {
    recoveryKinds: [...new Set(errors.flatMap(issue => issue.recoveryKind ? [issue.recoveryKind] : []))],
    missingSections: [...missingSections.values()],
    issues: issues.map(({type, severity, message, recoveryKind}) => ({type, severity, message, recoveryKind})),
  };
}

/** Full-answer delivery, distinct from immutable-body declaration-only completion. */
export function buildNativeOutputCompletionPrompt(input: {
  candidate: string;
  diagnostic: CandidateProtocolDiagnostic;
  intent: AnalysisTurnIntent;
  issues: readonly VerificationIssue[];
  outputLanguage: OutputLanguage;
}): string {
  const data = JSON.stringify({schemaVersion: 1, kind: 'original_native_candidate', body: input.candidate})
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const prompt = renderRequiredLocalizedStrategyTemplate('prompt-native-output-completion', input.outputLanguage, {
    original_candidate_json: data,
    candidate_protocol_diagnostic: JSON.stringify({candidateProtocolDiagnostic: sanitizeCandidateProtocolDiagnostic(input.diagnostic)}),
    correction_context: JSON.stringify(projectRuntimeCorrectionContext(input.issues)),
    turn_intent: JSON.stringify(projectTurnIntentForDeclarationCompletion(input.intent)),
  });
  // Partial declarations hide relation diagnostics; the full delivery uses the existing exact schema.
  return `${prompt}\n\n${renderRequiredLocalizedStrategyTemplate('prompt-relation-proposal-recovery', input.outputLanguage, {})}`;
}

/**
 * Typed intent decides whether a declaration is required. Prose shape and
 * wording never make that decision; a non-acknowledgement clarification uses
 * a `need_input` declaration with empty claims. With `repairInvalid`, a
 * declaration the parser rejected at its root, or a `partially_valid` one with
 * at least one repairable invalid claim, gets the same one delivery call to be
 * corrected: one invalid claim otherwise leaves every claim unverified.
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
  let diagnostic = Object.freeze(buildCandidateProtocolDiagnostic(inspected, 'native', 1));
  if (inspected.status === 'absent') {
    return Object.freeze({reason: MISSING_NATIVE_DECLARATION, originalBody: input.candidate, diagnostic});
  }
  const [segment, ...others] = inspected.sidecar.machineSegments;
  const originalRawClaims = payloadClaims(inspected.sidecar.rawPayload);
  // A partially_valid declaration is eligible as delivered; repairing it must be
  // able to fix at least one claim a repair can name, so the call can pay for itself.
  const repairableClaims = inspected.sidecar.status === 'partially_valid'
    ? diagnostic.claimDiagnostics?.filter(detail =>
        usableClaimId(rawClaimId(originalRawClaims?.[detail.ordinal - 1]))).length ?? 0 : 0;
  const eligibleForRepair = inspected.sidecar.status === 'invalid' ||
    (inspected.sidecar.status === 'partially_valid' && repairableClaims > 0);
  if (!input.repairInvalid || !eligibleForRepair || !segment || others.length ||
      inspected.sidecar.issues.some(issue => issue.code === 'duplicate_marker')) {
    // The rejected declaration is private and reaches no log, report or snapshot,
    // so a skipped repair is otherwise invisible: name the deciding facts in the
    // protocol's own closed vocabulary, never the model's values.
    if (inspected.status === 'invalid' || inspected.status === 'partially_valid') {
      console.log(`[DeclarationRepair] not requested: repairInvalid=${input.repairInvalid === true} ` +
        `sidecar=${inspected.sidecar.status} status=${inspected.status} repairableClaims=${repairableClaims} ` +
        `segments=${inspected.sidecar.machineSegments.length} ` +
        `issues=${formatIssueCodes(inspected.sidecar.issues)} ` +
        `claimDiagnostics=${formatClaimDiagnostics(diagnostic)}`);
    }
    return undefined;
  }
  const rejectedDeclaration = input.candidate.slice(segment.start, segment.end);
  const framingRejected = inspected.sidecar.issues.some(issue => issue.code === 'invalid_framing');
  const recoveredPayload = recoverNativeDeclarationPayload(input.candidate);
  if (framingRejected && (!recoveredPayload || typeof recoveredPayload !== 'object' || Array.isArray(recoveredPayload))) {
    return undefined; // Interrupted or ambiguous framing keeps the existing full-answer path.
  }
  const payload = recoveredPayload as {claims?: unknown; relationProposals?: unknown} | undefined;
  const rawClaims = payloadClaims(payload);
  if (framingRejected && rawClaims) {
    diagnostic = Object.freeze({...diagnostic, claimCount: rawClaims.length});
  }
  // Only ids the parser accepts: a blank id is itself a failure the repair has to fix.
  const declaredClaimIds = Array.isArray(rawClaims) ? [...new Set(rawClaims.flatMap(item => {
    const id = rawClaimId(item);
    return usableClaimId(id) ? [id] : [];
  }))] : [];
  const relations = payloadRelations(payload);
  const declaredRelationIds = [...new Set(relations.flatMap(item => {
    const id = item && typeof item === 'object' ? (item as {id?: unknown}).id : undefined;
    return usableProposalId(id) ? [id] : [];
  }))];
  // The repair prompt may only target invalid entries it can name: per plan A.3,
  // claimDiagnostics list solely invalid claims with a usable id.
  const targetableOrdinals = new Set((diagnostic.claimDiagnostics ?? [])
    .filter(detail => usableClaimId(rawClaimId(rawClaims?.[detail.ordinal - 1])))
    .map(detail => detail.ordinal));
  const promptDiagnostic = diagnostic.claimDiagnostics && targetableOrdinals.size !== diagnostic.claimDiagnostics.length
    ? Object.freeze({...diagnostic, claimDiagnostics: diagnostic.claimDiagnostics
        .filter(detail => targetableOrdinals.has(detail.ordinal))})
    : diagnostic;
  console.log(`[DeclarationRepair] requested: reason=${INVALID_NATIVE_DECLARATION} ` +
    `issues=${formatIssueCodes(inspected.sidecar.issues)} ` +
    `claims=${promptDiagnostic.claimCount ?? 0} claimDiagnostics=${formatClaimDiagnostics(promptDiagnostic)}`);
  // Edge whitespace left at the removed segment's seam is not part of the answer.
  return Object.freeze({reason: INVALID_NATIVE_DECLARATION, originalBody: inspected.canonicalBody.trim(),
    rejectedDeclaration, declaredClaimIds: Object.freeze(declaredClaimIds),
    declaredRelationCount: relations.length, declaredRelationIds: Object.freeze(declaredRelationIds),
    originalRootInvalid: inspected.sidecar.status === 'invalid', diagnostic: promptDiagnostic});
}

function recordPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function payloadClaims(payload: unknown): unknown[] | undefined {
  return recordPayload(payload) && Array.isArray((payload as {claims?: unknown}).claims)
    ? (payload as {claims: unknown[]}).claims : undefined;
}

function payloadRelations(payload: unknown): unknown[] {
  return recordPayload(payload) && Array.isArray((payload as {relationProposals?: unknown}).relationProposals)
    ? (payload as {relationProposals: unknown[]}).relationProposals : [];
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
 *
 * A completion for a rejected declaration is accepted through the per-item
 * matrix (plan A.3), all conditions required: the repaired root is valid; the
 * raw claim id set is exactly the original's; every originally-valid claim
 * keeps its normalized fingerprint at its position; the invalid claim count
 * strictly decreases (or the original failed at its root, which the repair
 * itself fixed); relation proposals match the original raw array position by
 * position under their id or resolvable semantic identity; and no normalized
 * entry appears twice. The accepted replacement may itself stay
 * `partially_valid`: its still-invalid entries remain unverified, never hidden.
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
  if (!segment || others.length || repaired.sidecar.status === 'absent' || repaired.sidecar.status === 'invalid') {
    const diagnostic = buildCandidateProtocolDiagnostic(repaired, 'native', 2);
    return reject('declaration_not_valid', {repaired: repaired.status, sidecar: repaired.sidecar.status,
      issues: formatIssueCodes(repaired.sidecar.issues),
      claimDiagnostics: formatClaimDiagnostics(diagnostic)});
  }
  if (input.request.reason === INVALID_NATIVE_DECLARATION) {
    const verdict = evaluateDeclarationRepair(input.request, repaired, reject);
    if (!verdict) return undefined;
  }
  const originalBody = original.canonicalBody.trim();
  const completionProse = repaired.canonicalBody.trim();
  // A completion that echoed the body unchanged is already the candidate.
  if (completionProse === originalBody) return input.candidate;
  if (completionProse) {
    console.log(`[DeclarationRepair] completion prose discarded: request=${input.request.reason} ` +
      `proseChars=${completionProse.length} originalChars=${originalBody.length}`);
  }
  const joined = `${originalBody}\n\n${input.candidate.slice(segment.start, segment.end)}`;
  return nativeDeclarationCandidateFitsOutput(joined, input.outputByteLimit) ? joined : reject('output_limit');
}

/** The per-item acceptance matrix for a repair of an already-declared sidecar. */
function evaluateDeclarationRepair(request: NativeDeclarationCompletionRequest,
  repaired: ReturnType<typeof inspectCandidateProtocol>,
  reject: (reason: string, facts?: Record<string, string | number | boolean>) => undefined): true | undefined {
  const originalPayload = recoverClosedDeclarationPayload(request.rejectedDeclaration ?? '');
  if (!recordPayload(originalPayload)) {
    // A root framing/JSON failure can leave no recoverable payload, so no
    // baseline exists for the matrix: keep the pre-matrix guarantee that no
    // declared claim or proposal disappears into the correction.
    const claims = repaired.sidecar.contract?.claims ?? [];
    const claimIds = new Set(claims.map(claim => claim.id));
    const droppedIds = request.declaredClaimIds?.filter(id => !claimIds.has(id)).length ?? 0;
    if (claims.length < (request.diagnostic.claimCount ?? 0) || droppedIds) {
      return reject('claims_dropped', {expectedClaims: request.diagnostic.claimCount ?? 0,
        repairedClaims: claims.length, droppedIds});
    }
    const relations = repaired.sidecar.contract?.relationProposals ?? [];
    const relationIds = new Set(relations.map(proposal => proposal.id));
    const droppedRelations = request.declaredRelationIds?.filter(id => !relationIds.has(id)).length ?? 0;
    if (relations.length < (request.declaredRelationCount ?? 0) || droppedRelations) {
      return reject('relation_proposals_dropped', {expectedRelations: request.declaredRelationCount ?? 0,
        repairedRelations: relations.length, droppedRelations});
    }
    return true;
  }
  const repairedPayload = recordPayload(repaired.sidecar.rawPayload) ? repaired.sidecar.rawPayload : undefined;
  if (!repairedPayload) return reject('repaired_payload_unrecoverable');
  const repairedRootInvalid = repaired.sidecar.issues.some(isConclusionRootParseIssue) ||
    parseConclusionContractDeclaration(repairedPayload).issues.some(isConclusionRootParseIssue);
  // 1. The repaired declaration's root must be valid; per-item failures may remain.
  if (repairedRootInvalid) {
    return reject('repaired_root_invalid', {issues: formatIssueCodes(repaired.sidecar.issues)});
  }
  const originalClaims = payloadClaims(originalPayload) ?? [];
  const repairedClaims = payloadClaims(repairedPayload);
  // 2. The raw claim id set is exactly the original's: no additions, no removals.
  const idSet = (items: unknown[]): Set<string> => new Set(items.flatMap(item => {
    const id = rawClaimId(item);
    return usableClaimId(id) ? [id] : [];
  }));
  const originalIds = idSet(originalClaims);
  const repairedIds = idSet(repairedClaims ?? []);
  const added = [...repairedIds].filter(id => !originalIds.has(id)).length;
  const dropped = [...originalIds].filter(id => !repairedIds.has(id)).length;
  if (added || dropped) return reject('claim_ids_changed', {added, dropped});
  // 3. Every originally-valid claim keeps its normalized fingerprint at its position.
  let originalInvalid = 0;
  let repairedInvalid = 0;
  const repairedFingerprints = new Map<string, number>();
  for (const item of originalClaims) {
    if (!claimItemFacts(item).valid) originalInvalid += 1;
  }
  if (repairedClaims) {
    for (const [index, item] of repairedClaims.entries()) {
      const facts = claimItemFacts(item);
      if (!facts.valid) {repairedInvalid += 1; continue;}
      if (facts.duplicateKey !== undefined) {
        repairedFingerprints.set(facts.duplicateKey, (repairedFingerprints.get(facts.duplicateKey) ?? 0) + 1);
      }
      const originalFacts = claimItemFacts(originalClaims[index]);
      if (originalFacts.valid && originalFacts.fingerprint !== facts.fingerprint) {
        return reject('valid_claim_changed', {ordinal: index + 1});
      }
    }
  }
  // 6 (claims half). Duplicate normalized content in the repair fails closed.
  if ([...repairedFingerprints.values()].some(count => count > 1)) {
    return reject('duplicate_claim_content');
  }
  // 4. At least one invalid claim is fixed, unless the repair fixed the root itself.
  if (!(repairedInvalid < originalInvalid) && request.originalRootInvalid !== true) {
    return reject('invalid_claims_not_reduced', {original: originalInvalid, repaired: repairedInvalid});
  }
  // 5. Relation proposals match the original raw array position by position.
  const originalRelations = payloadRelations(originalPayload);
  const repairedRelations = payloadRelations(repairedPayload);
  if (Array.isArray(originalRelations) !== Array.isArray(repairedRelations) ||
      originalRelations.length !== repairedRelations.length) {
    return reject('relation_positions_changed', {original: originalRelations.length,
      repaired: repairedRelations.length});
  }
  const proposalFingerprints = new Map<string, number>();
  for (const [index, item] of originalRelations.entries()) {
    const originalFacts = relationItemFacts(item);
    const repairedItem = repairedRelations[index];
    const repairedFacts = relationItemFacts(repairedItem);
    if (originalFacts.valid) {
      if (!repairedFacts.valid || repairedFacts.fingerprint !== originalFacts.fingerprint) {
        return reject('valid_proposal_changed', {ordinal: index + 1});
      }
    } else if (repairedFacts.valid) {
      // An originally-invalid position may only be fixed under preserved identity.
      const identity = relationProposalIdentitySubset(item);
      const repairedRecord = recordPayload(repairedItem) ? repairedItem : undefined;
      if (!identity.repairable || !repairedRecord) {
        return reject('unrepairable_proposal_changed', {ordinal: index + 1});
      }
      const id = recordPayload(item) ? (item as {id?: unknown}).id : undefined;
      if (usableProposalId(id)) {
        if (repairedRecord.id !== id) return reject('proposal_id_changed', {ordinal: index + 1});
      } else if (identity.subset) {
        for (const [field, value] of Object.entries(identity.subset)) {
          if (analysisDeliveryFingerprint(repairedRecord[field]) !== analysisDeliveryFingerprint(value)) {
            return reject('proposal_identity_changed', {ordinal: index + 1, field});
          }
        }
      }
    }
    if (repairedFacts.valid && repairedFacts.duplicateKey !== undefined) {
      proposalFingerprints.set(repairedFacts.duplicateKey, (proposalFingerprints.get(repairedFacts.duplicateKey) ?? 0) + 1);
    }
  }
  if ([...proposalFingerprints.values()].some(count => count > 1)) {
    return reject('duplicate_proposal_content');
  }
  return true;
}
