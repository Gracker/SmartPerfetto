// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {parseClaimSemanticsDeclaration, type ConclusionContract} from '../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {
  isLocateOnlyLookupKind,
  referenceHasReadBody,
  sanitizeSourceClaimBindings,
  sanitizeSourceReferences,
  sanitizeSourceUseDecision,
  MAX_SOURCE_REFERENCE_COUNT,
  type SourceClaimBindingV1,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from './sourceUseDecision';
import {
  collectMatchedTraceEvidenceRefIdsByClaimId,
  collectVerifiedTraceOccurrenceRefIdsByClaimId,
} from '../verifier/claimVerificationRunner';
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

export type SourceClaimVerificationStatus = 'passed' | 'failed' | 'partial' | 'not_checked';

export interface SourceClaimVerificationIssue {
  claimId?: string;
  severity: 'error' | 'warning';
  code:
    | 'source_claim_missing'
    | 'source_reference_not_returned'
    | 'source_reference_outside_selection'
    | 'source_binding_trace_support_missing'
    | 'source_binding_trace_cross_claim'
    | 'source_binding_trace_occurrence_not_verified'
    | 'source_absence_requires_complete_search'
    | 'source_claim_semantics_unchecked'
    | 'source_binding_mechanism_unverified'
    | 'source_binding_strength_downgraded';
  message: string;
  sourceReferenceId?: string;
  traceEvidenceRefId?: string;
}

export interface SourceClaimVerificationResult {
  schemaVersion: 'source_claim_verifier@1';
  status: SourceClaimVerificationStatus;
  bindings: SourceClaimBindingV1[];
  issues: SourceClaimVerificationIssue[];
}

export interface SourceUseDecisionReader {
  getSourceUseDecision(): SourceUseDecisionV1 | undefined;
}

export interface SafeSourceProvenanceProjection {
  sourceUseDecision: SourceUseDecisionV1;
  sourceClaimBindings: SourceClaimBindingV1[];
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

function negativeSourceAbsenceClaim(value: string): boolean {
  const text = String(value || '').slice(0, 512).replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /(?:源码|源代码|代码|实现|函数|方法|类|调用).{0,32}(?:不存在|没有|未找到|找不到|未定义|未实现|不包含|未出现)/i.test(text) ||
    /(?:不存在|没有|未找到|找不到|未定义|未实现|不包含|未出现).{0,32}(?:源码|源代码|代码|实现|函数|方法|类|调用)/i.test(text) ||
    /(?:source|code|implementation|function|method|class).{0,48}(?:does\s+not|doesn't|not\s+(?:exist|found|present|defined|implemented)|never\s+(?:appears|occurs)|contains?\s+no)/i.test(text) ||
    /(?:no|not|never).{0,32}(?:source|code|implementation|function|method|class)/i.test(text);
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
  const sourceClaimBindings = sanitizeSourceClaimBindings(contract.sourceClaimBindings)
    .filter(binding =>
      claimIds.has(binding.claimId) &&
      binding.sourceReferenceIds.length > 0 &&
      binding.sourceReferenceIds.every(referenceId => referenceById.has(referenceId)))
    .map(binding => {
      if (binding.mechanismStatus !== 'corroborated') return binding;
      const hasBodyReference = binding.sourceReferenceIds.some(referenceId => {
        const reference = referenceById.get(referenceId);
        return reference !== undefined && referenceHasReadBody(reference, references);
      });
      return decision.codeAwareMode === 'provider_send' &&
        hasBodyReference &&
        binding.traceEvidenceRefIds.length > 0
        ? binding
        : {...binding, mechanismStatus: 'compatible' as const};
    });
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
  };
}

export function verifySourceClaimBindings(input: {
  conclusionContract?: ConclusionContract | null;
  actualSourceUseDecision?: SourceUseDecisionV1;
  matchedTraceEvidenceRefIdsByClaimId?: Record<string, string[]>;
  verifiedTraceOccurrenceRefIdsByClaimId?: Record<string, string[]>;
  /** Current @2 verification never classifies source assertions by their prose. */
  semanticsPolicy?: 'declared' | 'legacy';
}): SourceClaimVerificationResult {
  const contract = input.conclusionContract;
  const actualSourceUseDecision = sanitizeSourceUseDecision(input.actualSourceUseDecision);
  if (contract && !actualSourceUseDecision && input.semanticsPolicy === 'declared' &&
    (contract.sourceClaimBindings?.length || contract.sourceReferences?.length || contract.sourceUseDecision)) {
    return {schemaVersion: 'source_claim_verifier@1', status: 'partial', bindings: [], issues: [{severity: 'warning',
      code: 'source_claim_semantics_unchecked', message: 'declared source evidence has no current authorized execution ledger'}]};
  }
  if (!contract || !actualSourceUseDecision) {
    return {schemaVersion: 'source_claim_verifier@1', status: 'not_checked', bindings: [], issues: []};
  }
  const context = authoritativeSourceContext(contract, actualSourceUseDecision);
  const candidates = sanitizeSourceClaimBindings(contract.sourceClaimBindings, {
    referenceIdAliases: context.aliases,
  });
  if (!context.decision || candidates.length === 0) {
    return {schemaVersion: 'source_claim_verifier@1', status: 'not_checked', bindings: [], issues: []};
  }

  const declaredClaims = contract.claims || [];
  const claims = input.semanticsPolicy === 'declared'
    ? new Map(declaredClaims.filter(claim => typeof claim.id === 'string' && claim.id.trim() &&
      declaredClaims.filter(other => other.id === claim.id).length === 1).map(claim => [claim.id!, claim]))
    : new Map(declaredClaims.map((claim, index) => [claim.id || `Q${index + 1}`, claim]));
  const actualReferences = new Map(context.references.map(reference => [reference.id, reference]));
  const declaredReferences = new Map(context.declaredReferences.map(reference => [reference.id, reference]));
  const selectedCodebaseIds = new Set(context.decision.selectedCodebaseIds);
  const matchedTraceIdsByClaim = input.matchedTraceEvidenceRefIdsByClaimId || {};
  const verifiedOccurrenceIdsByClaim = input.verifiedTraceOccurrenceRefIdsByClaimId || {};
  const allTraceOwners = new Map<string, Set<string>>();
  for (const [claimId, traceIds] of Object.entries(matchedTraceIdsByClaim)) {
    for (const traceId of traceIds) {
      const owners = allTraceOwners.get(traceId) ?? new Set<string>();
      owners.add(claimId);
      allTraceOwners.set(traceId, owners);
    }
  }

  const bindings: SourceClaimBindingV1[] = [];
  const issues: SourceClaimVerificationIssue[] = [];
  for (const candidate of candidates) {
    const claim = claims.get(candidate.claimId);
    if (!claim) {
      issues.push({
        claimId: candidate.claimId,
        severity: input.semanticsPolicy === 'declared' ? 'warning' : 'error',
        code: input.semanticsPolicy === 'declared' ? 'source_claim_semantics_unchecked' : 'source_claim_missing',
        message: 'source binding claimId does not exist in the structured claims',
      });
      continue;
    }
    if (candidate.sourceReferenceIds.length === 0) {
      issues.push({claimId: candidate.claimId, severity: 'error', code: 'source_reference_not_returned',
        message: 'source binding requires at least one reference returned by the current run'});
      continue;
    }
    if (input.semanticsPolicy === 'declared') {
      const semantics = parseClaimSemanticsDeclaration(claim.semantics).semantics;
      if (!semantics || claim.semanticsParseIssues?.length || claim.rawSemantics !== undefined ||
        contract.bindingEligibility === 'ineligible') {
        issues.push({claimId: candidate.claimId, severity: 'warning', code: 'source_claim_semantics_unchecked',
          message: 'source references do not establish the meaning of an unchecked claim declaration'});
      } else if (semantics.predicate === 'source.existence' && semantics.polarity === 'negated' &&
        semantics.discourse === 'asserted') {
        // A search ledger's completion flag is not an exhaustive versioned-codebase proof.
        issues.push({claimId: candidate.claimId, severity: 'warning', code: 'source_absence_requires_complete_search',
          message: 'a negative source-existence proposition requires an explicit complete absence proof'});
      }
    } else if ((context.decision.coverageComplete === false || context.decision.status === 'search_incomplete') &&
      negativeSourceAbsenceClaim(claim.text)) {
      issues.push({
        claimId: candidate.claimId,
        severity: 'error',
        code: 'source_absence_requires_complete_search',
        message: 'an incomplete source search cannot support a negative source-absence claim',
      });
      continue;
    }

    let rejected = false;
    const bindingReferences: SourceReferenceV1[] = [];
    for (const sourceReferenceId of candidate.sourceReferenceIds) {
      const declared = declaredReferences.get(sourceReferenceId);
      if (declared && !selectedCodebaseIds.has(declared.codebaseId)) {
        issues.push({
          claimId: candidate.claimId,
          severity: 'error',
          code: 'source_reference_outside_selection',
          message: 'source reference is outside the current selected codebase partition',
          sourceReferenceId,
        });
        rejected = true;
        continue;
      }
      const actual = actualReferences.get(sourceReferenceId);
      if (!actual) {
        issues.push({
          claimId: candidate.claimId,
          severity: 'error',
          code: 'source_reference_not_returned',
          message: 'source reference was not returned by the current run',
          sourceReferenceId,
        });
        rejected = true;
        continue;
      }
      bindingReferences.push(actual);
    }

    const allowedTraceIds = new Set(matchedTraceIdsByClaim[candidate.claimId] || []);
    for (const traceEvidenceRefId of candidate.traceEvidenceRefIds) {
      if (allowedTraceIds.has(traceEvidenceRefId)) continue;
      const belongsToOtherClaim = [...(allTraceOwners.get(traceEvidenceRefId) || [])]
        .some(owner => owner !== candidate.claimId);
      issues.push({
        claimId: candidate.claimId,
        severity: 'error',
        code: belongsToOtherClaim
          ? 'source_binding_trace_cross_claim'
          : 'source_binding_trace_support_missing',
        message: belongsToOtherClaim
          ? 'trace evidence belongs to a different structured claim'
          : 'trace evidence was not verified for this structured claim',
        traceEvidenceRefId,
      });
      rejected = true;
    }
    if (rejected) continue;

    let mechanismStatus = candidate.mechanismStatus;
    if (mechanismStatus === 'corroborated' && input.semanticsPolicy === 'declared') {
      mechanismStatus = 'compatible';
      issues.push({claimId: candidate.claimId, severity: 'warning', code: 'source_binding_mechanism_unverified',
        message: 'source text and a trace interval do not establish a native execution mechanism'});
    } else if (mechanismStatus === 'corroborated') {
      // A bound search hit counts once a read window of the same file covered it.
      const hasProviderBody = context.decision.codeAwareMode === 'provider_send' &&
        bindingReferences.some(reference => referenceHasReadBody(reference, context.references));
      const verifiedOccurrenceIds = new Set(
        verifiedOccurrenceIdsByClaim[candidate.claimId] || [],
      );
      const hasVerifiedTraceOccurrence = candidate.traceEvidenceRefIds.some(
        traceId => verifiedOccurrenceIds.has(traceId),
      );
      if (!hasProviderBody || !hasVerifiedTraceOccurrence) {
        mechanismStatus = 'compatible';
        issues.push({
          claimId: candidate.claimId,
          severity: 'warning',
          code: hasVerifiedTraceOccurrence
            ? 'source_binding_strength_downgraded'
            : candidate.traceEvidenceRefIds.length > 0
              ? 'source_binding_trace_occurrence_not_verified'
              : 'source_binding_trace_support_missing',
          message: hasVerifiedTraceOccurrence
            ? 'corroborated requires provider-send body or indexed source evidence'
            : 'corroborated requires a verified trace occurrence for the same claim',
        });
      }
    }
    bindings.push({...candidate, mechanismStatus});
  }

  const status: SourceClaimVerificationStatus = issues.some(issue => issue.severity === 'error')
    ? 'failed'
    : issues.length > 0
      ? 'partial'
      : bindings.length > 0
        ? 'passed'
        : 'not_checked';
  return {schemaVersion: 'source_claim_verifier@1', status, bindings, issues};
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
    semanticsPolicy: result.claimVerificationResult.schemaVersion === 'claim_verifier@2' ? 'declared' : 'legacy',
    matchedTraceEvidenceRefIdsByClaimId: collectMatchedTraceEvidenceRefIdsByClaimId(
      result.claimVerificationResult,
    ),
    verifiedTraceOccurrenceRefIdsByClaimId: collectVerifiedTraceOccurrenceRefIdsByClaimId(
      result.claimVerificationResult,
    ),
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
      result.sourceClaimVerificationResult.schemaVersion = 'source_claim_verifier@1';
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
