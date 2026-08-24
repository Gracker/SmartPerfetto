// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ClaimVerificationResult} from '../../types/claimVerification';
import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunManifestV1,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {parseEvalCase} from './evalContracts';
import type {EvaluationUsageReceiptV1} from './evaluationTelemetry';
import {
  scoreGoldenTraceObservation,
  type GoldenTraceObservationV1,
  type GoldenTraceScoreResult,
} from './goldenTraceScorer';

export interface FrozenEvaluationArtifactsV1 {
  schemaVersion: 1;
  evalCase: EvalCaseV1;
  runManifest: RunManifestV1;
  pinned: EvalPinnedEnvironmentV1;
  role: EvalScoreV1['role'];
  attempt: number;
  candidateId?: string;
  runOk: boolean;
  reportContractPass: boolean;
  claimVerificationResult: ClaimVerificationResult;
  goldenTraceObservation?: GoldenTraceObservationV1;
  usageReceipt: EvaluationUsageReceiptV1;
  contentHash: string;
}

export type EvalScorerResult =
  | {
      status: 'scored';
      score: EvalScoreV1;
      frozenArtifactsHash: string;
    }
  | {
      status: 'inconclusive';
      reason: string;
      frozenArtifactsHash?: string;
    };

function artifactsContentHash(
  value: Omit<FrozenEvaluationArtifactsV1, 'contentHash'>,
): string {
  return canonicalContentHash(value);
}

export function freezeEvaluationArtifacts(
  value: Omit<FrozenEvaluationArtifactsV1, 'contentHash'>,
): FrozenEvaluationArtifactsV1 {
  const snapshot = immutableCanonicalSnapshot(value);
  return immutableCanonicalSnapshot({
    ...snapshot,
    contentHash: artifactsContentHash(snapshot),
  });
}

function assertFrozenArtifacts(
  value: FrozenEvaluationArtifactsV1,
): FrozenEvaluationArtifactsV1 {
  if (value.schemaVersion !== 1) {
    throw new Error('eval_artifacts_schema_invalid');
  }
  const {contentHash, ...withoutHash} = value;
  if (
    !/^[0-9a-f]{64}$/.test(contentHash)
    || artifactsContentHash(withoutHash) !== contentHash
  ) {
    throw new Error('eval_artifacts_hash_mismatch');
  }
  return immutableCanonicalSnapshot(value);
}

function anchorKey(
  value: NonNullable<
    ClaimVerificationResult['claimResults'][number]['referenceResults']
  >[number],
): string | undefined {
  if (value.status !== 'matched') return undefined;
  if (value.evidenceRefId) return `evidence:${value.evidenceRefId}`;
  if (value.artifactId) return `artifact:${value.artifactId}`;
  if (value.sourceToolCallId) return `tool:${value.sourceToolCallId}`;
  if (value.sourceRef) return `source:${value.sourceRef}`;
  return undefined;
}

function requireRecord(
  value: unknown,
  error: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  error: string,
): void {
  if (
    Object.keys(value).some(key => !allowed.has(key))
    || [...required].some(key => !(key in value))
  ) {
    throw new Error(error);
  }
}

function requireNonemptyString(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function requireOptionalNonemptyString(
  value: unknown,
  error: string,
): string | undefined {
  return value === undefined ? undefined : requireNonemptyString(value, error);
}

function validateClaimVerification(
  value: unknown,
): {verifiedRatio: number; unsupportedClaims: number; evidenceAnchors: number} {
  const result = requireRecord(value, 'eval_claim_verification_invalid');
  requireExactKeys(
    result,
    new Set([
      'schemaVersion',
      'status',
      'policy',
      'notCheckedReason',
      'passed',
      'checkedClaimCount',
      'unsupportedClaimCount',
      'claimResults',
      'issues',
    ]),
    new Set([
      'schemaVersion',
      'status',
      'policy',
      'passed',
      'checkedClaimCount',
      'unsupportedClaimCount',
      'claimResults',
      'issues',
    ]),
    'eval_claim_verification_shape_invalid',
  );
  const statuses = new Set(['passed', 'failed', 'partial', 'not_checked']);
  const policies = new Set(['block', 'retry', 'warn_only', 'record_only']);
  if (
    result.schemaVersion !== 'claim_verifier@1'
    || !statuses.has(String(result.status))
    || !policies.has(String(result.policy))
    || typeof result.passed !== 'boolean'
    || !Number.isSafeInteger(result.checkedClaimCount)
    || (result.checkedClaimCount as number) < 0
    || !Number.isSafeInteger(result.unsupportedClaimCount)
    || (result.unsupportedClaimCount as number) < 0
    || !Array.isArray(result.claimResults)
    || !Array.isArray(result.issues)
  ) {
    throw new Error('eval_claim_verification_shape_invalid');
  }
  requireOptionalNonemptyString(
    result.notCheckedReason,
    'eval_claim_verification_not_checked_reason_invalid',
  );
  const claimStatuses = new Set([
    'verified',
    'partial',
    'inference',
    'unsupported',
    'not_checked',
  ]);
  const referenceStatuses = new Set([
    'matched',
    'missing',
    'ambiguous',
    'value_mismatch',
    'not_checked',
  ]);
  const claimIds = new Set<string>();
  const claimResults = result.claimResults.map(value => {
    const claim = requireRecord(
      value,
      'eval_claim_verification_claim_invalid',
    );
    requireExactKeys(
      claim,
      new Set(['claimId', 'status', 'referenceResults']),
      new Set(['claimId', 'status']),
      'eval_claim_verification_claim_invalid',
    );
    const claimId = requireNonemptyString(
      claim.claimId,
      'eval_claim_verification_claim_invalid',
    );
    if (claimIds.has(claimId) || !claimStatuses.has(String(claim.status))) {
      throw new Error('eval_claim_verification_claim_invalid');
    }
    claimIds.add(claimId);
    if (
      claim.referenceResults !== undefined
      && !Array.isArray(claim.referenceResults)
    ) {
      throw new Error('eval_claim_verification_reference_invalid');
    }
    const referenceResults = (claim.referenceResults ?? []).map(value => {
      const reference = requireRecord(
        value,
        'eval_claim_verification_reference_invalid',
      );
      requireExactKeys(
        reference,
        new Set([
          'evidenceRefId',
          'sourceRef',
          'artifactId',
          'sourceToolCallId',
          'status',
          'message',
        ]),
        new Set(['status']),
        'eval_claim_verification_reference_invalid',
      );
      if (!referenceStatuses.has(String(reference.status))) {
        throw new Error('eval_claim_verification_reference_invalid');
      }
      const parsed = {
        status: reference.status as NonNullable<
          ClaimVerificationResult['claimResults'][number]['referenceResults']
        >[number]['status'],
        ...(requireOptionalNonemptyString(
          reference.evidenceRefId,
          'eval_claim_verification_reference_invalid',
        ) === undefined
          ? {}
          : {evidenceRefId: reference.evidenceRefId as string}),
        ...(requireOptionalNonemptyString(
          reference.sourceRef,
          'eval_claim_verification_reference_invalid',
        ) === undefined
          ? {}
          : {sourceRef: reference.sourceRef as string}),
        ...(requireOptionalNonemptyString(
          reference.artifactId,
          'eval_claim_verification_reference_invalid',
        ) === undefined
          ? {}
          : {artifactId: reference.artifactId as string}),
        ...(requireOptionalNonemptyString(
          reference.sourceToolCallId,
          'eval_claim_verification_reference_invalid',
        ) === undefined
          ? {}
          : {sourceToolCallId: reference.sourceToolCallId as string}),
        ...(requireOptionalNonemptyString(
          reference.message,
          'eval_claim_verification_reference_invalid',
        ) === undefined
          ? {}
          : {message: reference.message as string}),
      };
      if (parsed.status === 'matched' && anchorKey(parsed) === undefined) {
        throw new Error('eval_claim_verification_reference_invalid');
      }
      return parsed;
    });
    return {
      claimId,
      status: claim.status as ClaimVerificationResult[
        'claimResults'
      ][number]['status'],
      referenceResults,
    };
  });
  const issues = result.issues.map(value => {
    const issue = requireRecord(
      value,
      'eval_claim_verification_issue_invalid',
    );
    requireExactKeys(
      issue,
      new Set([
        'claimId',
        'severity',
        'code',
        'message',
        'evidenceRefId',
      ]),
      new Set(['claimId', 'severity', 'code', 'message']),
      'eval_claim_verification_issue_invalid',
    );
    if (issue.severity !== 'error' && issue.severity !== 'warning') {
      throw new Error('eval_claim_verification_issue_invalid');
    }
    return {
      claimId: requireNonemptyString(
        issue.claimId,
        'eval_claim_verification_issue_invalid',
      ),
      severity: issue.severity,
      code: requireNonemptyString(
        issue.code,
        'eval_claim_verification_issue_invalid',
      ),
      message: requireNonemptyString(
        issue.message,
        'eval_claim_verification_issue_invalid',
      ),
      evidenceRefId: requireOptionalNonemptyString(
        issue.evidenceRefId,
        'eval_claim_verification_issue_invalid',
      ),
    };
  });
  if (
    claimResults.length > 0
    && issues.some(issue => !claimIds.has(issue.claimId))
  ) {
    throw new Error('eval_claim_verification_issue_claim_invalid');
  }
  for (const claim of claimResults) {
    const referenceStatuses = claim.referenceResults.map(
      reference => reference.status,
    );
    const claimIssues = issues.filter(issue => issue.claimId === claim.claimId);
    const hasReferenceFailure = referenceStatuses.some(
      status => status === 'missing' || status === 'value_mismatch',
    );
    if (
      (
        claim.status === 'verified'
        && (
          referenceStatuses.length === 0
          || referenceStatuses.some(status => status !== 'matched')
          || claimIssues.length > 0
        )
      )
      || (
        claim.status === 'inference'
        && referenceStatuses.some(status => status !== 'matched')
      )
      || (
        claim.status === 'partial'
        && (
          hasReferenceFailure
          || referenceStatuses.length === 0
          || referenceStatuses.every(status => status === 'not_checked')
        )
      )
      || (
        claim.status === 'not_checked'
        && (
          referenceStatuses.length === 0
          || referenceStatuses.some(status => status !== 'not_checked')
        )
      )
    ) {
      throw new Error('eval_claim_verification_claim_invariant_failed');
    }
  }
  const unsupportedClaimCount = claimResults.filter(
    claim => claim.status === 'unsupported',
  ).length;
  const hasError = issues.some(issue => issue.severity === 'error');
  const expectedStatus = hasError || unsupportedClaimCount > 0
    ? 'failed'
    : claimResults.length === 0
      ? 'not_checked'
      : claimResults.every(claim => claim.status === 'not_checked')
        ? 'not_checked'
        : claimResults.some(claim =>
            claim.status === 'partial'
            || claim.status === 'inference'
            || claim.status === 'not_checked')
          ? 'partial'
          : 'passed';
  if (
    result.checkedClaimCount !== claimResults.length
    || result.unsupportedClaimCount !== unsupportedClaimCount
    || result.passed !== (result.status === 'passed')
    || result.status !== expectedStatus
  ) {
    throw new Error('eval_claim_verification_invariant_failed');
  }
  if (result.status === 'not_checked') {
    throw new Error('eval_claim_verification_not_checked');
  }
  const verified = claimResults.filter(
    claim => claim.status === 'verified',
  ).length;
  const verifiedRatio = verified / claimResults.length;
  const anchors = new Set<string>();
  for (const claim of claimResults) {
    for (const reference of claim.referenceResults) {
      const key = anchorKey(reference);
      if (key) anchors.add(key);
    }
  }
  return {
    verifiedRatio,
    unsupportedClaims: unsupportedClaimCount,
    evidenceAnchors: anchors.size,
  };
}

function usageUnavailable(receipt: EvaluationUsageReceiptV1): string | undefined {
  const {contentHash, ...withoutHash} = receipt;
  if (
    !/^[0-9a-f]{64}$/.test(contentHash)
    || canonicalContentHash(withoutHash) !== contentHash
  ) {
    return 'usage_receipt_hash_mismatch';
  }
  if (receipt.exceeded) return `budget_exceeded:${receipt.exceeded}`;
  if (receipt.tokens.guarantee === 'unavailable') {
    return 'token_usage_unavailable';
  }
  if (receipt.traceProcessorCpu.guarantee === 'unavailable') {
    return 'trace_processor_cpu_unavailable';
  }
  return undefined;
}

export function scoreFrozenEvaluationArtifacts(
  artifactsValue: FrozenEvaluationArtifactsV1,
): EvalScorerResult {
  let artifacts: FrozenEvaluationArtifactsV1 | undefined;
  try {
    artifacts = assertFrozenArtifacts(artifactsValue);
    const evalCase = parseEvalCase(artifacts.evalCase);
    let goldenResult: Extract<GoldenTraceScoreResult, {status: 'scored'}>
      | undefined;
    if (evalCase.groundTruth) {
      if (!artifacts.goldenTraceObservation) {
        return {
          status: 'inconclusive',
          reason: 'golden_trace_observation_missing',
          frozenArtifactsHash: artifacts.contentHash,
        };
      }
      const result = scoreGoldenTraceObservation(
        evalCase.groundTruth,
        artifacts.goldenTraceObservation,
      );
      if (result.status !== 'scored') {
        return {
          status: 'inconclusive',
          reason: result.reason,
          frozenArtifactsHash: artifacts.contentHash,
        };
      }
      goldenResult = result;
    }
    const manifest = artifacts.runManifest;
    const manifestPinned: EvalPinnedEnvironmentV1 = {
      runtime: manifest.runtime,
      providerId: manifest.providerId,
      ...(manifest.model === undefined ? {} : {model: manifest.model}),
      outputLanguage: manifest.outputLanguage,
      toolAllowlistHash: manifest.toolAllowlistHash,
      injections: artifacts.pinned.injections,
      overlayGeneration: manifest.evolutionOverlayGeneration,
    };
    if (
      manifest.scope.tenantId !== evalCase.scope.tenantId
      || manifest.scope.workspaceId !== evalCase.scope.workspaceId
      || canonicalJsonString(manifestPinned)
        !== canonicalJsonString(artifacts.pinned)
      || !Number.isSafeInteger(artifacts.attempt)
      || artifacts.attempt < 1
      || (
        artifacts.role === 'candidate'
          ? !artifacts.candidateId
          : artifacts.candidateId !== undefined
      )
    ) {
      return {
        status: 'inconclusive',
        reason: 'eval_artifacts_scope_mismatch',
        frozenArtifactsHash: artifacts.contentHash,
      };
    }
    const unavailable = usageUnavailable(artifacts.usageReceipt);
    if (unavailable) {
      return {
        status: 'inconclusive',
        reason: unavailable,
        frozenArtifactsHash: artifacts.contentHash,
      };
    }
    const verified = validateClaimVerification(
      artifacts.claimVerificationResult,
    );
    const l1: EvalScoreV1['l1'] = {
      claimVerifiedRatio: verified.verifiedRatio,
      unsupportedClaims: verified.unsupportedClaims,
      evidenceAnchors: verified.evidenceAnchors,
    };
    const score: EvalScoreV1 = immutableCanonicalSnapshot({
      schemaVersion: 1,
      caseId: evalCase.caseId,
      evalSetId: evalCase.evalSetId,
      runId: manifest.runId,
      runManifestId: manifest.runManifestId,
      attempt: artifacts.attempt,
      role: artifacts.role,
      ...(artifacts.candidateId ? {candidateId: artifacts.candidateId} : {}),
      scope: evalCase.scope,
      pinned: artifacts.pinned,
      availability: 'available',
      ...(goldenResult
        ? {
            golden: {
              passed: goldenResult.passed,
              assertionCount: goldenResult.assertions.length,
              passedAssertions: goldenResult.summary.passed,
              failedAssertions: goldenResult.summary.failed,
              notEvaluableAssertions: goldenResult.summary.notEvaluable,
              blockers: goldenResult.blockers,
              contentHash: goldenResult.contentHash,
            },
          }
        : {}),
      l0: {
        runOk: artifacts.runOk,
        sqlErrorFree: manifest.sqlErrorCount === 0,
        reportContractPass: artifacts.reportContractPass,
        skillCrashFree: manifest.skills.every(skill => skill.errorCount === 0),
      },
      l1,
      l3: {
        turns: manifest.turns,
        wallclockMs: artifacts.usageReceipt.wallclock.usedMs,
        estimatedTokens: artifacts.usageReceipt.tokens.used,
        toolCalls: artifacts.usageReceipt.toolCalls.used,
      },
    });
    return {
      status: 'scored',
      score,
      frozenArtifactsHash: artifacts.contentHash,
    };
  } catch (error) {
    return {
      status: 'inconclusive',
      reason: error instanceof Error ? error.message : String(error),
      ...(artifacts === undefined
        ? {}
        : {frozenArtifactsHash: artifacts.contentHash}),
    };
  }
}
