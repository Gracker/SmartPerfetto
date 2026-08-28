// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ConclusionContract} from '../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {
  sanitizeSourceClaimBindings,
  sanitizeSourceReference,
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
import {sanitizeCodeAwareStructuredText} from '../security/codeAwareOutputRegistry';

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
  if (!Array.isArray(value)) return aliases;
  for (const candidate of value.slice(0, MAX_SOURCE_REFERENCE_COUNT)) {
    const sanitized = sanitizeSourceReference(candidate);
    if (!sanitized) continue;
    aliases.set(sanitized.id, sanitized.id);
    if (isRecord(candidate) && typeof candidate.id === 'string' && candidate.id.trim()) {
      aliases.set(candidate.id.trim(), sanitized.id);
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
  const aliases = sourceReferenceAliases(declaredCandidates);
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
  const aliases = sourceReferenceAliases(boundedSourceReferenceCandidates(
    rawDecisionReferences,
    contract.sourceReferences,
  ));
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
    ? decision.references.filter(reference =>
        reference.lookupKind === 'metadata' || reference.lookupKind === 'graph')
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
        return reference?.lookupKind === 'body' || reference?.lookupKind === 'indexed';
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
}): SourceClaimVerificationResult {
  const contract = input.conclusionContract;
  const actualSourceUseDecision = sanitizeSourceUseDecision(input.actualSourceUseDecision);
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

  const claims = new Map((contract.claims || []).map((claim, index) => [claim.id || `Q${index + 1}`, claim]));
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
        severity: 'error',
        code: 'source_claim_missing',
        message: 'source binding claimId does not exist in the structured claims',
      });
      continue;
    }
    if (context.decision.status === 'search_incomplete' && negativeSourceAbsenceClaim(claim.text)) {
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
    if (mechanismStatus === 'corroborated') {
      const hasProviderBody = context.decision.codeAwareMode === 'provider_send' &&
        bindingReferences.some(reference => reference.lookupKind === 'body' || reference.lookupKind === 'indexed');
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
  const actualDecision = sanitizeSourceUseDecision(sourceUse?.getSourceUseDecision());
  attachSourceUseToAnalysisResult(
    result,
    actualDecision
      ? {getSourceUseDecision: () => actualDecision}
      : undefined,
  );
  if (!actualDecision) return result;

  result.conclusion = sanitizeCodeAwareStructuredText(result.sessionId, result.conclusion);
  result.findings = sanitizeCodeAwareStructuredText(result.sessionId, result.findings);
  result.hypotheses = sanitizeCodeAwareStructuredText(result.sessionId, result.hypotheses);
  if (result.terminationMessage !== undefined) {
    result.terminationMessage = sanitizeCodeAwareStructuredText(
      result.sessionId,
      result.terminationMessage,
    );
  }
  if (result.conclusionContract !== undefined) {
    result.conclusionContract = sanitizeCodeAwareStructuredText(
      result.sessionId,
      result.conclusionContract,
    );
  }
  if (result.claimSupport !== undefined) {
    result.claimSupport = sanitizeCodeAwareStructuredText(result.sessionId, result.claimSupport);
  }
  if (result.claimVerificationResult !== undefined) {
    result.claimVerificationResult = sanitizeCodeAwareStructuredText(
      result.sessionId,
      result.claimVerificationResult,
    );
  }
  if (result.identityResolutions !== undefined) {
    result.identityResolutions = sanitizeCodeAwareStructuredText(
      result.sessionId,
      result.identityResolutions,
    );
  }
  if (result.smartScenePreview !== undefined) {
    result.smartScenePreview = sanitizeCodeAwareStructuredText(
      result.sessionId,
      result.smartScenePreview,
    );
  }
  if (result.uiActionProposals !== undefined) {
    result.uiActionProposals = sanitizeCodeAwareStructuredText(
      result.sessionId,
      result.uiActionProposals,
    );
  }

  if (
    result.success &&
    (actualDecision.status === 'pending' || actualDecision.status === 'attempted')
  ) {
    result.success = false;
    result.partial = true;
    result.terminationReason = 'plan_incomplete';
  }
  return result;
}
