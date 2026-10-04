// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {refreshQuickRunStopReason} from '../../agentRuntime/quickBudget';
import {parseClaimSemanticsDeclaration, type ConclusionContract} from '../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {
  isLocateOnlyLookupKind,
  lineRangesCover,
  lineRangesIntersect,
  readBodyRanges,
  referenceHasReadBody,
  sourceReferenceIdentity,
  sanitizeSourceClaimBindings,
  sanitizeSourceReferences,
  sanitizeSourceUseDecision,
  MAX_SOURCE_REFERENCE_COUNT,
  type SourceClaimBindingV1,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from './sourceUseDecision';
import {collectMatchedTraceEvidenceRefIdsByClaimId} from '../verifier/claimVerificationRunner';
import {
  extractSourceCitations,
  hasSourceCitation,
  matchSourceCitation,
  splitAnswerBlocks,
  type SourceCitationV1,
} from './sourceCitations';
import {randomUUID} from 'node:crypto';
import {
  composeCodeAwareTextProjectionReceipts,
  createCodeAwareStreamingTextProjection,
  withOwnerCodeAwareProjection,
  isIssuedCodeAwareTextProjectionReceipt,
  projectCodeAwareStructuredText,
  sanitizeCodeAwareStructuredText,
  sanitizeCodeAwareTextWithReceipt,
  type CodeAwareTextProjectionReceipt,
} from '../security/codeAwareOutputRegistry';
import {analysisDeliveryFingerprint, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {projectConclusionProtocol, projectConclusionContractForDisplay, issueConclusionProtocolProjection,
  type IssuedConclusionProtocolProjection} from '../security/conclusionProtocolProjection';

/**
 * `failed`: a claim binds a reference this run never issued (or outside the
 * selection), the one error; `partial`: some source-dependent claim or cited
 * location is weaker than source plus Trace (delivered, never fully verified);
 * `passed`: every one is `trace_linked` and every citation matched.
 */
export type SourceClaimVerificationStatus = 'passed' | 'failed' | 'partial' | 'not_checked';

/**
 * A source-dependent claim's standing, computed from the run's issued
 * references. None states that a mechanism is proven: `trace_linked` means
 * source explanation plus same-claim Trace evidence, not causality.
 */
export const SOURCE_CLAIM_STATUS_VALUES = ['invalid', 'unbound', 'location_only', 'source_only', 'trace_linked'] as const;
export type SourceClaimStatus = typeof SOURCE_CLAIM_STATUS_VALUES[number];

export interface SourceClaimStatusV1 {
  claimId: string;
  status: SourceClaimStatus;
  sourceReferenceIds: string[];
  traceEvidenceRefIds: string[];
}

export interface SourceClaimVerificationIssue {
  claimId?: string;
  severity: 'error' | 'warning';
  code:
    | 'source_reference_not_returned'
    | 'source_reference_outside_selection'
    | 'source_binding_trace_support_missing'
    | 'source_binding_trace_cross_claim'
    | 'source_claim_unbound'
    | 'source_claim_location_only'
    | 'source_claim_trace_unlinked'
    | 'source_claim_not_visible'
    | 'source_absence_requires_complete_search'
    | 'source_claim_semantics_unchecked'
    | 'source_citation_unmatched'
    | 'source_citation_ambiguous'
    | 'source_citation_extraction_truncated';
  message: string;
  sourceReferenceId?: string;
  traceEvidenceRefId?: string;
  citation?: string;
}

export interface SourceClaimVerificationResult {
  schemaVersion: 'source_claim_verifier@2';
  status: SourceClaimVerificationStatus;
  /** The declared bindings, canonical. */
  bindings: SourceClaimBindingV1[];
  /** One entry per source-dependent claim. */
  claims: SourceClaimStatusV1[];
  /** Source locations written in the answer body, matched against the run's references. */
  citations: SourceCitationV1[];
  issues: SourceClaimVerificationIssue[];
}

/** A result stored before source claims were judged per claim; read and rendered as stored. */
export interface LegacySourceClaimVerificationResultV1 {
  schemaVersion: 'source_claim_verifier@1';
  status: SourceClaimVerificationStatus;
  bindings: SourceClaimBindingV1[];
  issues: Array<Omit<SourceClaimVerificationIssue, 'code'> & {code: string}>;
}

/** What a stored analysis result may carry: the current verifier's result or a historical one. */
export type StoredSourceClaimVerificationResult = SourceClaimVerificationResult | LegacySourceClaimVerificationResultV1;

export interface SourceUseDecisionReader {
  getSourceUseDecision(): SourceUseDecisionV1 | undefined;
}

export interface SafeSourceProvenanceProjection {
  sourceUseDecision: SourceUseDecisionV1;
  sourceClaimBindings: SourceClaimBindingV1[];
  /** The current verifier's per-claim standing; absent for historical results. */
  sourceClaimStatuses?: SourceClaimStatusV1[];
  /** Source locations the answer cites, matched against this run's references. */
  sourceCitations?: SourceCitationV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sourceReferenceAliases(value: unknown): Map<string, string> {
  const aliases = new Map<string, string>();
  const references = sanitizeSourceReferences(value);
  const canonicalIds = new Set(references.map(reference => reference.id));
  const ambiguous = new Set<string>();
  for (const reference of references) aliases.set(reference.id, reference.id);
  for (const reference of references) {
    for (const alias of [reference.referenceId, reference.chunkId]) {
      if (!alias || canonicalIds.has(alias) || ambiguous.has(alias)) continue;
      if (aliases.has(alias) && aliases.get(alias) !== reference.id) {
        aliases.delete(alias);
        ambiguous.add(alias);
      } else {
        aliases.set(alias, reference.id);
      }
    }
  }
  return aliases;
}

function boundedSourceReferenceCandidates(
  decisionReferences: unknown,
  contractReferences: unknown,
): unknown[] {
  return [
    ...(Array.isArray(decisionReferences)
      ? decisionReferences.slice(0, MAX_SOURCE_REFERENCE_COUNT)
      : []),
    ...(Array.isArray(contractReferences)
      ? contractReferences.slice(0, MAX_SOURCE_REFERENCE_COUNT)
      : []),
  ].slice(0, MAX_SOURCE_REFERENCE_COUNT);
}

function authoritativeSourceContext(
  contract: ConclusionContract,
  decision: SourceUseDecisionV1,
): {
  decision: SourceUseDecisionV1;
  references: SourceReferenceV1[];
  aliases: Map<string, string>;
  declaredReferences: SourceReferenceV1[];
} {
  const rawDecision = contract.sourceUseDecision;
  const rawDecisionReferences = isRecord(rawDecision) ? rawDecision.references : undefined;
  const declaredCandidates = boundedSourceReferenceCandidates(
    rawDecisionReferences,
    contract.sourceReferences,
  );
  // Only the execution ledger may issue identities or legacy aliases. Model
  // declarations can describe an invalid reference, but cannot authorize it.
  const aliases = sourceReferenceAliases(decision.references);
  const declaredById = new Map(
    sanitizeSourceReferences(declaredCandidates).map(reference => [reference.id, reference]),
  );
  for (const reference of decision.references) {
    aliases.set(reference.id, reference.id);
    declaredById.set(reference.id, reference);
  }
  return {
    decision,
    references: decision.references,
    aliases,
    declaredReferences: [...declaredById.values()],
  };
}

export function sanitizeConclusionSourceContract(
  contract: ConclusionContract,
  options: {
    actualSourceUseDecision?: SourceUseDecisionV1 | null;
  } = {},
): ConclusionContract {
  const hasActualDecisionOverride = Object.prototype.hasOwnProperty.call(
    options,
    'actualSourceUseDecision',
  );
  const rawDecision = hasActualDecisionOverride
    ? options.actualSourceUseDecision
    : contract.sourceUseDecision;
  const rawDecisionReferences = isRecord(rawDecision) ? rawDecision.references : undefined;
  const aliases = sourceReferenceAliases(rawDecisionReferences);
  const decision = sanitizeSourceUseDecision(rawDecision);
  if (!decision) {
    if (!contract.sourceUseDecision && !contract.sourceReferences && !contract.sourceClaimBindings) {
      return contract;
    }
    const {
      sourceUseDecision: _sourceUseDecision,
      sourceReferences: _sourceReferences,
      sourceClaimBindings: _sourceClaimBindings,
      ...withoutSource
    } = contract;
    return withoutSource;
  }
  const references = decision.references;
  const bindings = sanitizeSourceClaimBindings(contract.sourceClaimBindings, {
    referenceIdAliases: aliases,
  });
  return {
    ...contract,
    sourceUseDecision: decision,
    sourceReferences: references,
    ...(bindings.length > 0 ? {sourceClaimBindings: bindings} : {sourceClaimBindings: undefined}),
  };
}

/**
 * Project the canonical source-only portion of a completed conclusion contract.
 * Output surfaces use this instead of copying model-authored contract objects.
 */
export function projectSafeSourceProvenance(input: {
  conclusionContract?: unknown;
  actualSourceUseDecision?: unknown;
  /** The stored verifier result; a current one adds per-claim standing and cited locations. */
  sourceClaimVerificationResult?: StoredSourceClaimVerificationResult;
}): SafeSourceProvenanceProjection | undefined {
  if (
    !isRecord(input.conclusionContract) ||
    input.conclusionContract.schemaVersion !== 'conclusion_contract_v1'
  ) {
    return undefined;
  }

  const hasActualDecision = Object.prototype.hasOwnProperty.call(
    input,
    'actualSourceUseDecision',
  );
  const actualDecision = hasActualDecision
    ? sanitizeSourceUseDecision(input.actualSourceUseDecision)
    : undefined;
  if (hasActualDecision && !actualDecision) return undefined;

  const contract = sanitizeConclusionSourceContract(
    input.conclusionContract as unknown as ConclusionContract,
    hasActualDecision
      ? {actualSourceUseDecision: actualDecision ?? null}
      : {},
  );
  const decision = sanitizeSourceUseDecision(contract.sourceUseDecision);
  if (!decision) return undefined;

  const references = decision.codeAwareMode === 'metadata_only'
    ? decision.references.filter(reference => isLocateOnlyLookupKind(reference.lookupKind))
    : decision.references;
  const referenceById = new Map(references.map(reference => [reference.id, reference]));
  const claimIds = new Set(
    (contract.claims || []).map((claim, index) => claim.id || `Q${index + 1}`),
  );
  const declaredBindings = sanitizeSourceClaimBindings(contract.sourceClaimBindings)
    .filter(binding =>
      claimIds.has(binding.claimId) &&
      binding.sourceReferenceIds.length > 0 &&
      binding.sourceReferenceIds.every(referenceId => referenceById.has(referenceId)))
    // A model-declared status is never shown; only a stored verdict is.
    .map(({mechanismStatus: _declared, ...binding}) => binding);
  const verification = input.sourceClaimVerificationResult;
  // Every surface shows the same bindings: the current verifier's, or those a
  // historical one checked, with the verdict it was stored with. Declarations
  // no verifier saw are candidates, never shown as accepted.
  const sourceClaimBindings = verification?.schemaVersion === 'source_claim_verifier@2'
    ? sanitizeSourceClaimBindings(verification.bindings)
    : historicalVerifiedBindings(declaredBindings, verification, decision.codeAwareMode);
  const reasonCode = decision.reasonCode === decision.status
    ? decision.reasonCode
    : undefined;
  const {reasonCode: _declaredReasonCode, ...decisionWithoutReasonCode} = decision;

  return {
    sourceUseDecision: {
      ...decisionWithoutReasonCode,
      ...(reasonCode ? {reasonCode} : {}),
      references,
    },
    sourceClaimBindings,
    ...(verification?.schemaVersion === 'source_claim_verifier@2'
      ? {sourceClaimStatuses: verification.claims, sourceCitations: verification.citations} : {}),
  };
}

function historicalVerifiedBindings(
  declared: SourceClaimBindingV1[],
  verification: LegacySourceClaimVerificationResultV1 | undefined,
  codeAwareMode: SourceUseDecisionV1['codeAwareMode'],
): SourceClaimBindingV1[] {
  const identity = (binding: SourceClaimBindingV1) =>
    JSON.stringify([binding.claimId, [...binding.sourceReferenceIds].sort(), [...binding.traceEvidenceRefIds].sort()]);
  const verified = new Map(sanitizeSourceClaimBindings(verification?.bindings).map(binding => [identity(binding), binding]));
  return declared.flatMap(binding => {
    const stored = verified.get(identity(binding));
    if (!stored) return [];
    const mechanismStatus = codeAwareMode === 'metadata_only' && stored.mechanismStatus === 'corroborated'
      ? 'compatible' : stored.mechanismStatus;
    return [{...binding, ...(mechanismStatus ? {mechanismStatus} : {})}];
  });
}

const MAX_STORED_CANDIDATE_REFERENCES = 16;

/** Each outcome short of `trace_linked`, with the issue that explains it. */
const SOURCE_CLAIM_OUTCOMES = {
  unbound: {status: 'unbound', code: 'source_claim_unbound',
    message: 'source-dependent claim has no binding to a reference returned by this run'},
  location_only: {status: 'location_only', code: 'source_claim_location_only',
    message: 'bound source references only locate code; no implementation body was read'},
  visible_location_only: {status: 'location_only', code: 'source_claim_location_only',
    message: 'the answer cites this claim\'s source only at locations whose body was not read'},
  trace_unlinked: {status: 'source_only', code: 'source_claim_trace_unlinked',
    message: 'source explanation has no verified Trace evidence for the same claim'},
  not_visible: {status: 'source_only', code: 'source_claim_not_visible',
    message: 'the answer body does not cite this claim\'s source, so its context cannot be checked'},
} as const satisfies Record<string, {status: SourceClaimStatus; code: SourceClaimVerificationIssue['code']; message: string}>;

/**
 * Per-claim source status from the run's issued references. A claim depends
 * on source by structure, never by wording: a `source.*` predicate, codebase
 * population, a binding, or a written source location in its text.
 *
 * Status, first match wins: `invalid` (a bound id this run never issued, or
 * outside the selection, or Trace evidence of another claim) is the only
 * error; `unbound` (no binding, or the claim's text or visible answer blocks
 * cite a location the run never returned, or one several file versions fit
 * that its binding does not pin to exactly one); `location_only` (no bound
 * reference delivered a body, or every location the answer visibly cites for
 * the claim is one whose lines the run did not read in the bound file
 * version); `source_only` (no matched same-claim Trace
 * evidence, or no answer block cites the claim's bound lines, or more
 * locations were written than are checked); `trace_linked`.
 *
 * A citation belongs to a claim when one of the claim's bound references has
 * the citation's file version and shares a written line. A claim's binding
 * pins an ambiguous citation for that claim only; the answer still carries
 * the ambiguity.
 */
export function verifySourceClaimBindings(input: {
  conclusionContract?: ConclusionContract | null;
  actualSourceUseDecision?: SourceUseDecisionV1;
  matchedTraceEvidenceRefIdsByClaimId?: Record<string, string[]>;
  /** The canonical answer body whose written source locations are checked. */
  body?: string;
}): SourceClaimVerificationResult {
  const contract = input.conclusionContract;
  const decision = sanitizeSourceUseDecision(input.actualSourceUseDecision);
  const empty = (status: SourceClaimVerificationStatus, issues: SourceClaimVerificationIssue[] = []):
    SourceClaimVerificationResult => ({schemaVersion: 'source_claim_verifier@2', status, bindings: [], claims: [],
    citations: [], issues});
  if (!contract) return empty('not_checked');
  const declaredClaims = contract.claims || [];
  const idCounts = new Map<string, number>();
  for (const claim of declaredClaims) if (claim.id) idCounts.set(claim.id, (idCounts.get(claim.id) ?? 0) + 1);
  const context = decision ? authoritativeSourceContext(contract, decision) : undefined;
  const bindings = sanitizeSourceClaimBindings(contract.sourceClaimBindings, {referenceIdAliases: context?.aliases})
    .map(({mechanismStatus: _retired, ...binding}) => binding);
  const boundClaimIds = new Set(bindings.map(binding => binding.claimId));
  const sourceDependent = declaredClaims.flatMap(claim => {
    if (typeof claim.id !== 'string' || !claim.id.trim() || idCounts.get(claim.id) !== 1) return [];
    const semantics = parseClaimSemanticsDeclaration(claim.semantics).semantics;
    const textCitations = extractSourceCitations(claim.text ?? '');
    return semantics?.predicate.startsWith('source.') || semantics?.scope.population === 'codebase' ||
      boundClaimIds.has(claim.id) || textCitations.citations.length > 0
      ? [{claimId: claim.id, semantics, textCitations}] : [];
  });
  if (!decision || !context) {
    // Declared source evidence with no authorized execution ledger cannot be checked.
    return sourceDependent.length > 0 || bindings.length > 0 || hasSourceCitation(input.body ?? '')
      ? empty('partial', [{severity: 'warning', code: 'source_claim_semantics_unchecked',
        message: 'declared source evidence has no current authorized execution ledger'}])
      : empty('not_checked');
  }

  const references = context.references;
  const referenceById = new Map(references.map(reference => [reference.id, reference]));
  const declaredById = new Map(context.declaredReferences.map(reference => [reference.id, reference]));
  const selected = new Set(decision.selectedCodebaseIds);
  const matchedTraceIdsByClaim = input.matchedTraceEvidenceRefIdsByClaimId || {};
  const traceOwners = new Map<string, Set<string>>();
  for (const [claimId, traceIds] of Object.entries(matchedTraceIdsByClaim)) {
    for (const traceId of traceIds) traceOwners.set(traceId, (traceOwners.get(traceId) ?? new Set()).add(claimId));
  }
  const issues: SourceClaimVerificationIssue[] = [];

  const body = extractSourceCitations(input.body ?? '');
  const blocks = splitAnswerBlocks(input.body ?? '');
  let blockIndex = 0;
  const citations = body.citations.map(citation => {
    while (blockIndex < blocks.length && blocks[blockIndex]!.end <= citation.index) blockIndex++;
    const block = blockIndex < blocks.length && blocks[blockIndex]!.start <= citation.index ? blockIndex : -1;
    return {...matchSourceCitation(citation, references), block};
  });
  // The file versions a citation was matched to: its pin, or an ambiguous one's candidates.
  const citedIdentities = (citation: SourceCitationV1): Set<string> => new Set(
    (citation.sourceReferenceId !== undefined ? [citation.sourceReferenceId] : citation.candidateReferenceIds ?? [])
      .flatMap(id => {
        const reference = referenceById.get(id);
        return reference ? [sourceReferenceIdentity(reference)] : [];
      }));
  if (body.truncated) {
    issues.push({severity: 'warning', code: 'source_citation_extraction_truncated',
      message: 'the answer writes more source locations than are checked'});
  }

  const claimStatuses: SourceClaimStatusV1[] = [];
  for (const {claimId, semantics, textCitations} of sourceDependent) {
    const claimBindings = bindings.filter(binding => binding.claimId === claimId);
    const sourceReferenceIds = [...new Set(claimBindings.flatMap(binding => binding.sourceReferenceIds))];
    const traceEvidenceRefIds = [...new Set(claimBindings.flatMap(binding => binding.traceEvidenceRefIds))];
    const record = (status: SourceClaimStatus) => claimStatuses.push({claimId, status, sourceReferenceIds, traceEvidenceRefIds});

    let invalid = false;
    for (const sourceReferenceId of sourceReferenceIds) {
      const declared = declaredById.get(sourceReferenceId);
      const outside = declared !== undefined && !selected.has(declared.codebaseId);
      if (outside || !referenceById.has(sourceReferenceId)) {
        issues.push({claimId, severity: 'error', sourceReferenceId,
          code: outside ? 'source_reference_outside_selection' : 'source_reference_not_returned',
          message: outside ? 'source reference is outside the current selected codebase partition'
            : 'source reference was not returned by the current run'});
        invalid = true;
      }
    }
    const matchedTraceIds = new Set(matchedTraceIdsByClaim[claimId] || []);
    for (const traceEvidenceRefId of traceEvidenceRefIds) {
      if (matchedTraceIds.has(traceEvidenceRefId)) continue;
      const otherClaim = [...(traceOwners.get(traceEvidenceRefId) || [])].some(owner => owner !== claimId);
      issues.push({claimId, severity: 'error', traceEvidenceRefId,
        code: otherClaim ? 'source_binding_trace_cross_claim' : 'source_binding_trace_support_missing',
        message: otherClaim ? 'trace evidence belongs to a different structured claim'
          : 'trace evidence was not verified for this structured claim'});
      invalid = true;
    }
    if (invalid) {
      record('invalid');
      continue;
    }
    if (semantics?.predicate === 'source.existence' && semantics.polarity === 'negated' &&
      semantics.discourse === 'asserted') {
      // A search ledger's completion flag is not an exhaustive versioned-codebase proof.
      issues.push({claimId, severity: 'warning', code: 'source_absence_requires_complete_search',
        message: 'a negative source-existence proposition requires an explicit complete absence proof'});
    }

    const bound = sourceReferenceIds.map(id => referenceById.get(id)!);
    // The file versions of this claim's bound references that share a written line.
    const boundIdentities = (citation: SourceCitationV1): Set<string> => {
      const cited = citedIdentities(citation);
      return new Set(bound.filter(reference => reference.lineRange &&
        lineRangesIntersect(reference.lineRange, citation.lineRange) && cited.has(sourceReferenceIdentity(reference)))
        .map(sourceReferenceIdentity));
    };
    // Only a location the run never returned, or an ambiguity this claim's binding does not pin to one version, mismatches.
    const mismatches = (citation: SourceCitationV1) => citation.status === 'unmatched' ||
      (citation.status === 'ambiguous' && boundIdentities(citation).size !== 1);
    // Citations of the claim's bound lines; the blocks holding the resolved ones are its visible text.
    const related = citations.filter(citation => boundIdentities(citation).size > 0);
    const visible = related.filter(citation => citation.block >= 0 && !mismatches(citation));
    const visibleBlocks = new Set(visible.map(citation => citation.block));
    // A visible citation supports the claim's reading only when the run read every line it writes,
    // in the file version the claim binds; a body read elsewhere never upgrades it.
    const readVisible = visible.some(citation => [...boundIdentities(citation)]
      .some(identity => lineRangesCover(readBodyRanges(references, identity), citation.lineRange)));
    const claimTextMismatch = textCitations.citations
      .some(citation => mismatches(matchSourceCitation(citation, references)));
    const answerMismatch = related.some(mismatches) ||
      citations.some(citation => visibleBlocks.has(citation.block) && mismatches(citation));
    const outcome = bound.length === 0 || claimTextMismatch || answerMismatch ? SOURCE_CLAIM_OUTCOMES.unbound
      : !bound.some(reference => referenceHasReadBody(reference, references)) ? SOURCE_CLAIM_OUTCOMES.location_only
        : visibleBlocks.size > 0 && !readVisible ? SOURCE_CLAIM_OUTCOMES.visible_location_only
        : !traceEvidenceRefIds.some(id => matchedTraceIds.has(id)) ? SOURCE_CLAIM_OUTCOMES.trace_unlinked
          : visibleBlocks.size === 0 ? SOURCE_CLAIM_OUTCOMES.not_visible
            : undefined;
    if (outcome) {
      issues.push({claimId, severity: 'warning', code: outcome.code, message: outcome.message});
      record(outcome.status);
    } else {
      // Locations past the extraction limit were never checked against this claim.
      record(body.truncated || textCitations.truncated ? 'source_only' : 'trace_linked');
    }
    if (textCitations.truncated) {
      issues.push({claimId, severity: 'warning', code: 'source_citation_extraction_truncated',
        message: 'the claim writes more source locations than are checked'});
    }
  }

  for (const citation of citations) {
    if (citation.status !== 'unmatched' && citation.status !== 'ambiguous') continue;
    issues.push({severity: 'warning', citation: citation.citation,
      code: citation.status === 'unmatched' ? 'source_citation_unmatched' : 'source_citation_ambiguous',
      message: citation.status === 'unmatched'
        ? 'the answer cites a source location this run never returned'
        : 'the answer cites a source location several returned file versions fit'});
  }
  const status: SourceClaimVerificationStatus = issues.some(issue => issue.severity === 'error') ? 'failed'
    : issues.length > 0 ? 'partial'
      : claimStatuses.length > 0 || citations.length > 0 ? 'passed' : 'not_checked';
  // Judged against every candidate; the stored list is bounded.
  return {schemaVersion: 'source_claim_verifier@2', status, bindings, claims: claimStatuses,
    citations: citations.map(({block: _block, ...citation}) => citation.candidateReferenceIds
      ? {...citation, candidateReferenceIds: citation.candidateReferenceIds.slice(0, MAX_STORED_CANDIDATE_REFERENCES)}
      : citation), issues};
}

export function verifySourceClaimBindingsForResult(
  result: AnalysisResult,
): SourceClaimVerificationResult | undefined {
  if (!result.conclusionContract?.sourceClaimBindings?.length || !result.claimVerificationResult) {
    return undefined;
  }
  const actualSourceUseDecision = sanitizeSourceUseDecision(result.sourceUseDecision);
  if (!actualSourceUseDecision) return undefined;
  return verifySourceClaimBindings({
    conclusionContract: result.conclusionContract,
    actualSourceUseDecision,
    matchedTraceEvidenceRefIdsByClaimId: collectMatchedTraceEvidenceRefIdsByClaimId(
      result.claimVerificationResult,
    ),
    body: result.conclusion,
  });
}

export function attachSourceUseToAnalysisResult(
  result: AnalysisResult,
  sourceUse: SourceUseDecisionReader | undefined,
): AnalysisResult {
  const actualDecision = sanitizeSourceUseDecision(sourceUse?.getSourceUseDecision());
  delete result.sourceClaimVerificationResult;
  if (actualDecision) {
    result.sourceUseDecision = actualDecision;
    result.sourceReferences = actualDecision.references;
  } else {
    delete result.sourceUseDecision;
    delete result.sourceReferences;
  }
  if (result.conclusionContract) {
    result.conclusionContract = sanitizeConclusionSourceContract(result.conclusionContract, {
      actualSourceUseDecision: actualDecision ?? null,
    });
  }
  return result;
}

/**
 * Shared runtime boundary for source-aware analysis results. It binds the
 * provider result to the actual MCP source ledger before applying the session
 * echo guard to every model-authored result surface.
 */
export function finalizeSourceAwareAnalysisResult(
  result: AnalysisResult,
  sourceUse: SourceUseDecisionReader | undefined,
): AnalysisResult {
  return finalizeSourceAwareAnalysisResultWithProjection(result, sourceUse).result;
}

export interface SourceAwareAnalysisProjection {
  result: AnalysisResult;
  conclusionProjection: CodeAwareTextProjectionReceipt;
  deliveryContext?: AnalysisDeliveryContext;
  protocolProjection?: IssuedConclusionProtocolProjection;
}

/** Final callers must consume the returned context instead of the pre-projection one. */
export function finalizeSourceAwareAnalysisResultWithProjection(
  result: AnalysisResult,
  sourceUse: SourceUseDecisionReader | undefined,
  options: {priorProjection?: CodeAwareTextProjectionReceipt; context?: AnalysisDeliveryContext} = {},
): SourceAwareAnalysisProjection {
  const originalDeclaration = {raw: result.conclusion,
    ...(result.conclusionContract ? {contract: structuredClone(result.conclusionContract)} : {})};
  const nativeCandidate = options.context?.entry !== 'historical_restore' ? options.context?.acceptedCandidate : undefined;
  const structure = () => ({
    conclusionContract: result.conclusionContract, claimSupport: result.claimSupport,
    claimVerificationResult: result.claimVerificationResult, sourceUseDecision: result.sourceUseDecision,
    sourceReferences: result.sourceReferences, sourceClaimVerificationResult: result.sourceClaimVerificationResult,
    identityResolutions: result.identityResolutions,
  });
  const before = projectCodeAwareStructuredText(undefined, structure());
  const beforeFingerprint = analysisDeliveryFingerprint(before.value);
  const originalClaimVerification = result.claimVerificationResult;
  const actualDecision = sanitizeSourceUseDecision(sourceUse?.getSourceUseDecision());
  const hasPriorProjection = isIssuedCodeAwareTextProjectionReceipt(options.priorProjection) &&
    options.priorProjection.outputFingerprint === analysisDeliveryFingerprint(result.conclusion);
  const shouldProject = Boolean(actualDecision || hasPriorProjection || nativeCandidate);
  attachSourceUseToAnalysisResult(
    result,
    actualDecision
      ? {getSourceUseDecision: () => actualDecision}
      : undefined,
  );
  // Recompute against this run's accessor before privacy projection changes text.
  // An archived or provider-authored sidecar cannot establish current source failure.
  const currentSourceVerification = actualDecision ? verifySourceClaimBindingsForResult(result) : undefined;
  const directProjection = shouldProject
    ? result.conclusion.length > 0 ? projectConclusionProtocol(result.sessionId, result.conclusion)
      : createCodeAwareStreamingTextProjection(result.sessionId, 'final-result-empty').projectCompleteWithReceipt('')
    : sanitizeCodeAwareTextWithReceipt(undefined, result.conclusion);
  const conclusionProjection = composeCodeAwareTextProjectionReceipts(options.priorProjection, directProjection);
  result.conclusion = conclusionProjection.text;
  if (shouldProject) {
    result.findings = sanitizeCodeAwareStructuredText(result.sessionId, result.findings);
    result.hypotheses = sanitizeCodeAwareStructuredText(result.sessionId, result.hypotheses);
    if (result.terminationMessage !== undefined) {
      result.terminationMessage = sanitizeCodeAwareStructuredText(result.sessionId, result.terminationMessage);
    }
    if (result.conclusionContract !== undefined) {
      result.conclusionContract = projectConclusionContractForDisplay(result.sessionId, result.conclusionContract);
    }
    if (result.claimSupport !== undefined) {
      result.claimSupport = sanitizeCodeAwareStructuredText(result.sessionId, result.claimSupport);
    }
    if (result.claimVerificationResult !== undefined) {
      result.claimVerificationResult = sanitizeCodeAwareStructuredText(result.sessionId, result.claimVerificationResult);
      // Privacy projection must not turn known machine failures into unknown strings.
      if ((originalClaimVerification?.schemaVersion === 'claim_verifier@1' ||
        originalClaimVerification?.schemaVersion === 'claim_verifier@2') && result.claimVerificationResult) {
        result.claimVerificationResult.schemaVersion = originalClaimVerification.schemaVersion;
        if (originalClaimVerification.status === 'failed') result.claimVerificationResult.status = 'failed';
        if (originalClaimVerification.passed === false) result.claimVerificationResult.passed = false;
        originalClaimVerification.issues.forEach((issue, index) => {
          if (issue.severity === 'error' && result.claimVerificationResult?.issues?.[index]) {
            result.claimVerificationResult.issues[index].severity = 'error';
          }
        });
        originalClaimVerification.claimResults.forEach((claim, index) => {
          if (claim.status === 'unsupported' && result.claimVerificationResult?.claimResults?.[index]) {
            result.claimVerificationResult.claimResults[index].status = 'unsupported';
          }
        });
      }
    }
    if (result.identityResolutions !== undefined) {
      result.identityResolutions = sanitizeCodeAwareStructuredText(result.sessionId, result.identityResolutions);
    }
    if (result.smartScenePreview !== undefined) {
      result.smartScenePreview = sanitizeCodeAwareStructuredText(result.sessionId, result.smartScenePreview);
    }
    if (result.uiActionProposals !== undefined) {
      result.uiActionProposals = sanitizeCodeAwareStructuredText(result.sessionId, result.uiActionProposals);
    }
  }
  if (currentSourceVerification?.status === 'failed') {
    result.sourceClaimVerificationResult = sanitizeCodeAwareStructuredText(result.sessionId, currentSourceVerification);
    if (result.sourceClaimVerificationResult) {
      result.sourceClaimVerificationResult.schemaVersion = 'source_claim_verifier@2';
      result.sourceClaimVerificationResult.status = 'failed';
      currentSourceVerification.issues.forEach((issue, index) => {
        if (issue.severity === 'error' && result.sourceClaimVerificationResult?.issues?.[index]) {
          result.sourceClaimVerificationResult.issues[index].severity = 'error';
        }
      });
    }
  }

  const after = projectCodeAwareStructuredText(undefined, structure());
  const structureChanged = before.changed || after.changed || beforeFingerprint !== analysisDeliveryFingerprint(after.value);
  const bodyChanged = conclusionProjection.disposition !== 'preserved';
  let deliveryContext = options.context;
  if (bodyChanged || structureChanged) {
    delete result.reportAssessment;
    delete result.investigationAssessment;
    delete result.deliveryAssurance;
    if (bodyChanged) delete result.completion;
    if (deliveryContext && deliveryContext.entry !== 'historical_restore') {
      deliveryContext = {...deliveryContext, claimVerificationBinding: undefined, sourceVerificationBinding: undefined,
        reportAssessment: undefined, investigationAssessment: undefined, evidenceRenderedProof: undefined};
      if (bodyChanged) {
        const original = deliveryContext.acceptedCandidate;
        const nativeCompletion = deliveryContext.completion;
        const candidateMatches = original && [original.candidateRef, original.runId, original.attemptId]
          .every(id => typeof id === 'string' && id.trim()) &&
          isIssuedCodeAwareTextProjectionReceipt(conclusionProjection) &&
          (original.conclusionFingerprint === conclusionProjection.inputFingerprint ||
            original.conclusionFingerprint === directProjection.inputFingerprint);
        const completionMatches = candidateMatches && nativeCompletion?.schemaVersion === 1 &&
          nativeCompletion.candidateRef === original.candidateRef && nativeCompletion.runId === original.runId &&
          nativeCompletion.attemptId === original.attemptId && nativeCompletion.conclusionFingerprint === original.conclusionFingerprint;
        if (candidateMatches) {
          const candidate = {...original, candidateRef: `projection-${randomUUID()}`,
            conclusionFingerprint: conclusionProjection.outputFingerprint};
          deliveryContext = {...deliveryContext, acceptedCandidate: candidate,
            completion: completionMatches ? {...nativeCompletion, ...candidate,
              ...(conclusionProjection.disposition === 'replaced' ? {status: 'unknown' as const} : {})} : undefined,
            outputOrigin: conclusionProjection.disposition === 'replaced' ? 'runtime_fallback' : deliveryContext.outputOrigin};
          result.completion = deliveryContext.completion;
          result.outputOrigin = deliveryContext.outputOrigin;
        } else {
          deliveryContext = {...deliveryContext, completion: undefined, outputOrigin: undefined};
          delete result.outputOrigin;
        }
      }
    }
  }
  if (conclusionProjection.disposition === 'replaced') {
    result.outputOrigin = 'runtime_fallback';
    result.success = false;
    result.partial = true;
    // A quick receipt describes the delivered candidate, which is now partial.
    refreshQuickRunStopReason(result);
    if (deliveryContext && deliveryContext.entry !== 'historical_restore') {
      deliveryContext = {...deliveryContext, outputOrigin: 'runtime_fallback'};
    }
  }
  const displayCandidate = deliveryContext?.entry !== 'historical_restore' ? deliveryContext?.acceptedCandidate : undefined;
  const protocolProjection = nativeCandidate && displayCandidate && !hasPriorProjection &&
    nativeCandidate.conclusionFingerprint === analysisDeliveryFingerprint(originalDeclaration.raw)
    ? issueConclusionProtocolProjection({original: originalDeclaration, result, nativeCandidate, displayCandidate}) : undefined;
  return {result, conclusionProjection, ...(deliveryContext ? {deliveryContext} : {}),
    ...(protocolProjection ? {protocolProjection} : {})};
}


/** Runtime delivery to the source owner; verification and issued receipts are unchanged. */
export function finalizeOwnerSourceAwareAnalysisResultWithProjection(
  ...args: Parameters<typeof finalizeSourceAwareAnalysisResultWithProjection>
): SourceAwareAnalysisProjection {
  return withOwnerCodeAwareProjection(() => finalizeSourceAwareAnalysisResultWithProjection(...args));
}
