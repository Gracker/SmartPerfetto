// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'node:crypto';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import {deriveConclusionContract} from '../agent/core/conclusionGenerator';
import {parseConclusionContractSidecar, parseTypedConclusionContractJson,
  declaredFields, declaredContractForResult, type ConclusionContract, type ConclusionBindingEligibility,
  type ConclusionContractDeclarationParseResult, type ConclusionContractSidecarParseResult,
  MAX_CONCLUSION_STRUCTURE_DETAILS, isConclusionContractStructureDetail,
  MAX_RELATION_PROPOSAL_DIAGNOSTICS, isConclusionRelationProposalDiagnostic, CONCLUSION_PARSE_ISSUE_CODES,
  MAX_CLAIM_DIAGNOSTICS, isConclusionClaimDiagnostic, copyConclusionClaimDiagnostic,
  type ConclusionContractStructureDetail, type ConclusionContractParseIssue,
  type ConclusionRelationProposalDiagnostic, type ConclusionClaimDiagnostic} from '../agent/core/conclusionContract';
import {parseConversationResponseWithProjection, type ConversationEvidenceRef,
  type ConversationResponseProjection, type ConversationRuntimeOutcome} from '../assistant/contracts/conversationContract';
import {analysisDeliveryFingerprint, sameAnalysisCandidate,
  type AnalysisDeliveryContext} from '../types/analysisDelivery';
import {isIssuedNativeConclusionDeclaration, projectConclusionContractForDisplay,
  type NativeConclusionDeclaration} from './security/conclusionProtocolProjection';
import {issueCanonicalAnalysisProjection, type CanonicalAnalysisProjection} from './canonicalAnalysisProjection';
export {isIssuedCanonicalAnalysisProjection, type CanonicalAnalysisProjection} from './canonicalAnalysisProjection';

export interface CanonicalAnalysisResult {
  result: AnalysisResult;
  /** Exact selected declaration, including invalid originals; never serialize this sidecar. */
  validationContract?: ConclusionContract;
  /** Server parser qualification survives invalid declarations that have no typed shell. */
  bindingEligibility: ConclusionBindingEligibility;
  deliveryContext?: AnalysisDeliveryContext;
  projection: CanonicalAnalysisProjection;
  conversationOutcome?: ConversationRuntimeOutcome;
  /** Private parser records preserve original declarations for finalization diagnostics. */
  protocolDiagnostics?: {
    sidecar: ConclusionContractSidecarParseResult;
    typedJson?: ConclusionContractDeclarationParseResult;
    conversation?: ConversationResponseProjection;
  };
}

function removeMachineSegments(raw: string, segments: Array<{start: number; end: number}>): string {
  const merged: Array<{start: number; end: number}> = [];
  for (const segment of [...segments].sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous?.start === segment.start && previous.end === segment.end) continue;
    if (previous && segment.start < previous.end) throw new Error('overlapping_canonical_protocol_segments');
    merged.push({...segment});
  }
  let narrative = raw;
  for (const {start, end} of merged.reverse()) narrative = narrative.slice(0, start) + narrative.slice(end);
  return narrative;
}

/** Private inspection: callers must publish only the bounded diagnostic projection below. */
export function inspectCandidateProtocol(raw: string, conversationInput?: {
  fallbackQuestion: string; evidence?: ConversationEvidenceRef[];
}) {
  const sidecar = parseConclusionContractSidecar(raw);
  const conversation = conversationInput ? parseConversationResponseWithProjection(
    raw, conversationInput.fallbackQuestion, conversationInput.evidence,
  ) : undefined;
  const canonicalBody = removeMachineSegments(raw, [...sidecar.machineSegments, ...(conversation?.machineSegments ?? [])]);
  const typedJson = sidecar.status === 'absent' ? parseTypedConclusionContractJson(canonicalBody) : undefined;
  const status = sidecar.status === 'invalid' || typedJson?.status === 'invalid' ? 'invalid'
    : sidecar.status === 'valid' || typedJson?.status === 'valid' ? 'valid' : 'absent';
  return {rawChars: raw.length, canonicalBody, sidecar, typedJson, conversation, status} as const;
}

export interface CandidateProtocolDiagnostic {
  schemaVersion: 'candidate_protocol_diagnostic@1';
  stage: 'native' | 'runtime_projected';
  candidateIndex: 1 | 2;
  status: 'absent' | 'valid' | 'invalid';
  sidecarStatus: 'absent' | 'valid' | 'invalid';
  typedJsonStatus: 'not_checked' | 'absent' | 'valid' | 'invalid';
  issueCodes: ConclusionContractParseIssue['code'][];
  /** Schema-owned fields/types only, never arbitrary parser paths or model values. */
  details?: ConclusionContractStructureDetail[];
  /** Closed relation shape only; never arbitrary keys, values, IDs or paths. */
  relationProposalDiagnostics?: ConclusionRelationProposalDiagnostic[];
  /** Failing claims by 1-based position and closed schema field, so one repair can find them. */
  claimDiagnostics?: ConclusionClaimDiagnostic[];
  issueCount: number;
  rawChars: number;
  /** UTF-16 characters after trimming canonical narrative whitespace. */
  canonicalChars: number;
  projectionKind: 'preserved' | 'protocol_projection' | 'redacted' | 'replaced';
  /** Declaration entries, never evidence of validity or verification. Absent in older artifacts. */
  claimCount?: number;
  semanticClaimCount?: number;
  sourceBindingCount?: number;
}

const CANDIDATE_PROTOCOL_DIAGNOSTIC_KEYS = [
  'schemaVersion', 'stage', 'candidateIndex', 'status', 'sidecarStatus', 'typedJsonStatus',
  'issueCodes', 'issueCount', 'rawChars', 'canonicalChars', 'projectionKind',
  'claimCount', 'semanticClaimCount', 'sourceBindingCount', 'details', 'relationProposalDiagnostics', 'claimDiagnostics',
] as const;

const claimDiagnosticKey = (detail: ConclusionClaimDiagnostic) => `${detail.ordinal}:${detail.code}:${detail.field}`;

/** Diagnostics carry only fixed schema locations, never source paths, model text or admission authority. */
export function sanitizeCandidateProtocolDiagnostic(value: unknown): CandidateProtocolDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !(CANDIDATE_PROTOCOL_DIAGNOSTIC_KEYS as readonly string[]).includes(key))) return undefined;
  const data = declaredFields(value as CandidateProtocolDiagnostic, CANDIDATE_PROTOCOL_DIAGNOSTIC_KEYS);
  const statuses = ['absent', 'valid', 'invalid'];
  if (data.schemaVersion !== 'candidate_protocol_diagnostic@1' ||
      !['native', 'runtime_projected'].includes(data.stage) || ![1, 2].includes(data.candidateIndex) ||
      !statuses.includes(data.status) || !statuses.includes(data.sidecarStatus) ||
      !['not_checked', ...statuses].includes(data.typedJsonStatus) ||
      !['preserved', 'protocol_projection', 'redacted', 'replaced'].includes(data.projectionKind) ||
      ![data.issueCount, data.rawChars, data.canonicalChars].every(count => Number.isSafeInteger(count) && count >= 0) ||
      !Array.isArray(data.issueCodes) || data.issueCodes.length > CONCLUSION_PARSE_ISSUE_CODES.length ||
      data.issueCodes.some(code => !CONCLUSION_PARSE_ISSUE_CODES.includes(code)) ||
      new Set(data.issueCodes).size !== data.issueCodes.length || data.issueCount < data.issueCodes.length) return undefined;
  const counts = [data.claimCount, data.semanticClaimCount, data.sourceBindingCount];
  if (counts.some(count => count !== undefined) &&
      (!counts.every(count => Number.isSafeInteger(count) && count! >= 0) || data.semanticClaimCount! > data.claimCount!)) return undefined;
  const bounded = <T>(value: unknown, max: number, guard: (detail: unknown) => detail is T,
    key: (detail: T) => string, admits: (details: T[]) => boolean): value is T[] | undefined =>
    value === undefined || Array.isArray(value) && value.length > 0 && value.length <= max &&
      data.status === 'invalid' && value.every(guard) && new Set(value.map(key)).size === value.length && admits(value);
  // `details` predates the issueCount bound the two diagnostic collections carry.
  if (!bounded(data.details, MAX_CONCLUSION_STRUCTURE_DETAILS, isConclusionContractStructureDetail,
    detail => `${detail.field}:${detail.actual}`, () => data.issueCodes.includes('invalid_contract'))) return undefined;
  if (!bounded(data.relationProposalDiagnostics, MAX_RELATION_PROPOSAL_DIAGNOSTICS, isConclusionRelationProposalDiagnostic,
    detail => detail.scope === 'collection' ? `${detail.scope}:${detail.reason}` : `${detail.scope}:${detail.ordinal}:${detail.reason}`,
    details => data.issueCodes.includes('invalid_relation_proposal') && data.issueCount >= details.length &&
      // A rejected collection is the only failure, never one item among several.
      (!details.some(detail => detail.scope === 'collection') || details.length === 1))) return undefined;
  if (!bounded(data.claimDiagnostics, MAX_CLAIM_DIAGNOSTICS, isConclusionClaimDiagnostic, claimDiagnosticKey,
    details => data.issueCount >= details.length &&
      details.every(detail => data.issueCodes.includes(detail.code)))) return undefined;
  return {...data, issueCodes: [...data.issueCodes],
    ...(data.details ? {details: data.details.map(detail => ({...detail}))} : {}),
    ...(data.relationProposalDiagnostics ? {relationProposalDiagnostics:
      data.relationProposalDiagnostics.map(detail => ({...detail}))} : {}),
    ...(data.claimDiagnostics ? {claimDiagnostics: data.claimDiagnostics.map(copyConclusionClaimDiagnostic)} : {})};
}

export function buildCandidateProtocolDiagnostic(
  inspected: ReturnType<typeof inspectCandidateProtocol>,
  stage: CandidateProtocolDiagnostic['stage'],
  candidateIndex: CandidateProtocolDiagnostic['candidateIndex'],
  privacyProjection?: 'preserved' | 'redacted' | 'replaced',
): CandidateProtocolDiagnostic {
  const issues = [...inspected.sidecar.issues, ...(inspected.typedJson?.issues ?? [])];
  const parsed = inspected.sidecar.status !== 'absent' ? inspected.sidecar : inspected.typedJson;
  const payload = parsed?.rawPayload as {claims?: unknown; sourceClaimBindings?: unknown} | undefined;
  const claims = Array.isArray(payload?.claims) ? payload.claims : parsed?.contract?.claims ?? [];
  const sourceBindings = Array.isArray(payload?.sourceClaimBindings) ? payload.sourceClaimBindings
    : parsed?.contract?.sourceClaimBindings ?? [];
  const details: ConclusionContractStructureDetail[] = [];
  const seenDetails = new Set<string>();
  const relationProposalDiagnostics: ConclusionRelationProposalDiagnostic[] = [];
  const seenRelationProposalDiagnostics = new Set<string>();
  const claimDiagnostics: ConclusionClaimDiagnostic[] = [];
  const seenClaimDiagnostics = new Set<string>();
  for (const issue of issues) {
    if (issue.code === 'invalid_contract') {
      for (const detail of issue.details ?? []) {
        if (!isConclusionContractStructureDetail(detail)) continue;
        const key = `${detail.field}:${detail.actual}`;
        if (seenDetails.has(key) || details.length >= MAX_CONCLUSION_STRUCTURE_DETAILS) continue;
        seenDetails.add(key);
        details.push({...detail});
      }
    }
    const relationDetail = issue.relationProposalDiagnostic;
    if (issue.code === 'invalid_relation_proposal' && isConclusionRelationProposalDiagnostic(relationDetail)) {
      const key = relationDetail.scope === 'collection' ? `${relationDetail.scope}:${relationDetail.reason}`
        : `${relationDetail.scope}:${relationDetail.ordinal}:${relationDetail.reason}`;
      if (!seenRelationProposalDiagnostics.has(key) &&
          relationProposalDiagnostics.length < MAX_RELATION_PROPOSAL_DIAGNOSTICS) {
        seenRelationProposalDiagnostics.add(key);
        relationProposalDiagnostics.push({...relationDetail});
      }
    }
    const claimDetail = issue.claimDiagnostic;
    if (isConclusionClaimDiagnostic(claimDetail) && claimDetail.code === issue.code &&
        !seenClaimDiagnostics.has(claimDiagnosticKey(claimDetail)) && claimDiagnostics.length < MAX_CLAIM_DIAGNOSTICS) {
      seenClaimDiagnostics.add(claimDiagnosticKey(claimDetail));
      claimDiagnostics.push(copyConclusionClaimDiagnostic(claimDetail));
    }
  }
  return {
    schemaVersion: 'candidate_protocol_diagnostic@1', stage, candidateIndex, status: inspected.status,
    sidecarStatus: inspected.sidecar.status, typedJsonStatus: inspected.typedJson?.status ?? 'not_checked',
    issueCodes: [...new Set(issues.map(issue => issue.code))], issueCount: issues.length,
    ...(details.length ? {details} : {}),
    ...(relationProposalDiagnostics.length ? {relationProposalDiagnostics} : {}),
    ...(claimDiagnostics.length ? {claimDiagnostics} : {}),
    rawChars: inspected.rawChars, canonicalChars: inspected.canonicalBody.trim().length,
    ...(parsed?.contract || payload && typeof payload === 'object' && !Array.isArray(payload) ? {claimCount: claims.length,
      semanticClaimCount: claims.filter(claim => claim && typeof claim === 'object' &&
        Object.prototype.hasOwnProperty.call(claim, 'semantics')).length,
      sourceBindingCount: sourceBindings.length} : {}),
    projectionKind: privacyProjection && privacyProjection !== 'preserved' ? privacyProjection
      : inspected.rawChars !== inspected.canonicalBody.length ? 'protocol_projection' : 'preserved',
  };
}

/**
 * Select canonical declarations and remove only protocol spans identified by the
 * actual parsers. No caller-supplied renderer or text replacement can mint proof.
 */
export function canonicalizeAnalysisResult(
  source: AnalysisResult,
  options: {context?: AnalysisDeliveryContext; nativeDeclaration?: NativeConclusionDeclaration; conversation?: {
    fallbackQuestion: string; evidence?: ConversationEvidenceRef[];
  }} = {},
): CanonicalAnalysisResult {
  const raw = source.conclusion;
  if (options.context?.entry === 'historical_restore') {
    return {result: source, validationContract: source.conclusionContract,
      bindingEligibility: source.conclusionContract?.bindingEligibility ?? 'legacy_unchecked',
      deliveryContext: options.context, projection: issueCanonicalAnalysisProjection({
      disposition: 'preserved', inputFingerprint: analysisDeliveryFingerprint(raw), outputFingerprint: analysisDeliveryFingerprint(raw),
    })};
  }
  // Sidecar presence is decided from the original body, before any display projection.
  if (options.nativeDeclaration && !isIssuedNativeConclusionDeclaration(options.nativeDeclaration)) {
    throw new Error('unissued_native_conclusion_declaration');
  }
  const display = inspectCandidateProtocol(raw, options.conversation);
  const {sidecar, conversation, typedJson} = options.nativeDeclaration
    ? inspectCandidateProtocol(options.nativeDeclaration.raw, options.conversation) : display;
  const narrative = display.canonicalBody;
  const intent = options.context?.turnIntent;
  const validationContract = sidecar.status !== 'absent'
    ? sidecar.contract
    : typedJson && typedJson.status !== 'absent' ? typedJson.contract : options.nativeDeclaration?.contract ?? source.conclusionContract ?? deriveConclusionContract(narrative, {
      mode: intent?.status === 'resolved' && intent.deliverable === 'answer' ? 'focused_answer' : 'initial_report',
      ...(intent?.status === 'resolved' ? {sceneId: intent.sceneId} : {}),
    }) ?? undefined;
  const bindingEligibility: ConclusionBindingEligibility = sidecar.status === 'invalid' || typedJson?.status === 'invalid' ||
    conversation?.status === 'invalid' ? 'ineligible' : validationContract?.bindingEligibility ?? 'legacy_unchecked';
  const conclusionContract = options.nativeDeclaration
    ? projectConclusionContractForDisplay(source.sessionId, validationContract) : declaredContractForResult(validationContract);
  if (conclusionContract && bindingEligibility === 'ineligible') conclusionContract.bindingEligibility = 'ineligible';
  const bodyChanged = narrative !== raw;
  const contractChanged = sidecar.status !== 'absent' || (typedJson !== undefined && typedJson.status !== 'absent') ||
    validationContract !== source.conclusionContract ||
    analysisDeliveryFingerprint(conclusionContract) !== analysisDeliveryFingerprint(source.conclusionContract);
  const result: AnalysisResult = {...source, conclusion: narrative, conclusionContract};
  let deliveryContext = options.context;
  const sourceCandidate = deliveryContext?.acceptedCandidate;
  const sourceMatches = sameAnalysisCandidate(sourceCandidate, sourceCandidate, raw);
  const candidate = sourceMatches && sourceCandidate
    ? bodyChanged ? {...sourceCandidate, candidateRef: `canonical-${randomUUID()}`,
      conclusionFingerprint: analysisDeliveryFingerprint(narrative)} : sourceCandidate
    : undefined;
  const projection = issueCanonicalAnalysisProjection({
    disposition: bodyChanged ? 'protocol_projection' : 'preserved',
    inputFingerprint: analysisDeliveryFingerprint(raw), outputFingerprint: analysisDeliveryFingerprint(narrative),
    ...(sourceMatches ? {sourceCandidate} : {}), ...(candidate ? {candidate} : {}),
  }, options.nativeDeclaration && bindingEligibility === 'eligible' && sourceMatches && candidate && validationContract
    ? {sessionId: source.sessionId, nativeDeclaration: options.nativeDeclaration, canonicalBody: narrative,
      contract: validationContract} : undefined);
  if (deliveryContext) {
    const nativeCompletion = deliveryContext.completion;
    const completionCurrent = nativeCompletion?.schemaVersion === 1 &&
      sameAnalysisCandidate(nativeCompletion, sourceCandidate, raw);
    deliveryContext = {...deliveryContext,
      ...(candidate ? {acceptedCandidate: candidate} : {}),
      completion: candidate && completionCurrent ? {...nativeCompletion, ...candidate} : undefined,
    };
  }
  // Result metadata alone never supplies authority for the current canonical body.
  result.completion = deliveryContext?.completion;
  if (sourceMatches) result.outputOrigin = deliveryContext?.outputOrigin;
  else if (result.outputOrigin !== 'runtime_fallback') delete result.outputOrigin;
  if (bodyChanged || contractChanged) {
    delete result.claimSupport;
    delete result.claimVerificationResult;
    delete result.sourceClaimVerificationResult;
    delete result.reportAssessment;
    delete result.investigationAssessment;
    delete result.deliveryAssurance;
    if (deliveryContext) deliveryContext = {...deliveryContext,
      claimVerificationBinding: undefined, sourceVerificationBinding: undefined,
      reportAssessment: undefined, investigationAssessment: undefined, evidenceRenderedProof: undefined,
    };
  }
  return {result, projection, bindingEligibility, ...(validationContract ? {validationContract} : {}), ...(deliveryContext ? {deliveryContext} : {}),
    ...(conversation ? {conversationOutcome: {...conversation.outcome, message: narrative}} : {}),
    ...(sidecar.status !== 'absent' || (typedJson && typedJson.status !== 'absent') || (conversation && conversation.status !== 'absent')
      ? {protocolDiagnostics: {sidecar, ...(typedJson ? {typedJson} : {}), ...(conversation ? {conversation} : {})}} : {}),
  };
}
