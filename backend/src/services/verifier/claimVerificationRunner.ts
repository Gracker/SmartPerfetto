// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ConclusionContract } from '../../agent/core/conclusionContract';
import type { ComparisonReportSection } from '../../agentv3/sessionStateSnapshot';
import type {
  ClaimVerificationClaimStatus,
  ClaimVerificationPolicy,
  ClaimVerificationResult,
} from '../../types/claimVerification';
import {validateDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import type {
  ClaimSupportV1,
  EvidenceContractV1,
  EvidenceRelationCandidateV1,
} from '../../types/evidenceContract';
import type { IdentityResolutionV1 } from '../../types/identityContract';
import { buildEvidenceContract } from '../evidence/evidenceContractBuilder';
import { runDeterministicClaimVerifier } from './deterministicClaimVerifier';

export interface ClaimVerificationRunnerInput {
  conclusionContract?: ConclusionContract | null;
  dataEnvelopes?: DataEnvelope[];
  comparisonReportSection?: ComparisonReportSection;
  relationCandidates?: EvidenceRelationCandidateV1[];
  relationActivationClaimIds?: string[];
  policy?: ClaimVerificationPolicy;
}

export interface ClaimVerificationRunnerResult {
  evidenceContract: EvidenceContractV1;
  claimSupport: ClaimSupportV1[];
  claimVerificationResult: ClaimVerificationResult;
  identityResolutions: IdentityResolutionV1[];
  matchedTraceEvidenceRefIdsByClaimId: Record<string, string[]>;
  verifiedTraceOccurrenceRefIdsByClaimId: Record<string, string[]>;
}

function collectMatchedTraceEvidenceRefIds(
  verification: ClaimVerificationResult,
  allowedClaimStatuses: ReadonlySet<ClaimVerificationClaimStatus>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const claim of verification.claimResults) {
    if (!allowedClaimStatuses.has(claim.status)) continue;
    const ids = [...new Set((claim.referenceResults || [])
      .filter(reference => reference.status === 'matched' && Boolean(reference.evidenceRefId))
      .map(reference => reference.evidenceRefId!))].sort();
    if (ids.length > 0) result[claim.claimId] = ids;
  }
  return result;
}

export function collectMatchedTraceEvidenceRefIdsByClaimId(
  verification: ClaimVerificationResult,
): Record<string, string[]> {
  return collectMatchedTraceEvidenceRefIds(
    verification,
    new Set<ClaimVerificationClaimStatus>(['verified', 'partial']),
  );
}

export function collectVerifiedTraceOccurrenceRefIdsByClaimId(
  verification: ClaimVerificationResult,
): Record<string, string[]> {
  return collectMatchedTraceEvidenceRefIds(
    verification,
    new Set<ClaimVerificationClaimStatus>(['verified']),
  );
}

function isIdentityResolution(value: unknown): value is IdentityResolutionV1 {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as IdentityResolutionV1).version === 'identity_contract@1' &&
    typeof (value as IdentityResolutionV1).identityRefId === 'string',
  );
}

function collectIdentityResolutions(envelopes: DataEnvelope[] = []): IdentityResolutionV1[] {
  const byId = new Map<string, IdentityResolutionV1>();
  for (const envelope of envelopes) {
    const meta = envelope.meta as unknown as Record<string, unknown> | undefined;
    if (!meta) continue;
    const candidate = meta.identityResolution;
    if (isIdentityResolution(candidate)) {
      byId.set(candidate.identityRefId, candidate);
      continue;
    }

    if (typeof meta.identityRefId === 'string' && typeof meta.identityStatus === 'string') {
      byId.set(meta.identityRefId, {
        version: 'identity_contract@1',
        identityRefId: meta.identityRefId,
        target: {
          traceId: typeof meta.traceId === 'string' ? meta.traceId : 'unknown',
          traceSide: meta.traceSide === 'current' || meta.traceSide === 'reference'
            ? meta.traceSide
            : 'unknown',
          source: 'derived',
        },
        status: meta.identityStatus as IdentityResolutionV1['status'],
        processes: [],
        threads: [],
        warnings: Array.isArray(meta.identityWarnings) ? meta.identityWarnings.map(String) : [],
      });
    }
  }
  return Array.from(byId.values());
}

function supportLevelFromVerifierStatus(
  status: ClaimVerificationClaimStatus | undefined,
  fallback: ClaimSupportV1['supportLevel'],
): ClaimSupportV1['supportLevel'] {
  switch (status) {
    case 'verified':
      return 'verified';
    case 'inference':
      return 'inference';
    case 'unsupported':
      return 'unsupported';
    case 'partial':
    case 'not_checked':
      return 'partial';
    default:
      return fallback;
  }
}

function applyVerifierSupportLevels(
  claimSupport: ClaimSupportV1[],
  verification: ClaimVerificationResult,
): ClaimSupportV1[] {
  const byClaimId = new Map(verification.claimResults.map(result => [result.claimId, result.status]));
  return claimSupport.map(claim => {
    const supportLevel = supportLevelFromVerifierStatus(byClaimId.get(claim.claimId), claim.supportLevel);
    return supportLevel === claim.supportLevel ? claim : { ...claim, supportLevel };
  });
}

export function runClaimVerification(input: ClaimVerificationRunnerInput): ClaimVerificationRunnerResult {
  const evidenceContract = buildEvidenceContract({
    conclusionContract: input.conclusionContract,
    dataEnvelopes: input.dataEnvelopes,
    comparisonReportSection: input.comparisonReportSection,
    relationCandidates: input.relationCandidates,
    relationActivationClaimIds: input.relationActivationClaimIds,
  });
  const claimVerificationResult = runDeterministicClaimVerifier({
    claimSupport: evidenceContract.claimSupport,
    policy: input.policy || 'record_only',
  });
  const claimSupport = applyVerifierSupportLevels(evidenceContract.claimSupport, claimVerificationResult);
  evidenceContract.claimSupport = claimSupport;
  return {
    evidenceContract,
    claimSupport,
    claimVerificationResult,
    identityResolutions: collectIdentityResolutions(
      (input.dataEnvelopes || []).filter(envelope => validateDataEnvelope(envelope).length === 0),
    ),
    matchedTraceEvidenceRefIdsByClaimId: collectMatchedTraceEvidenceRefIdsByClaimId(
      claimVerificationResult,
    ),
    verifiedTraceOccurrenceRefIdsByClaimId: collectVerifiedTraceOccurrenceRefIdsByClaimId(
      claimVerificationResult,
    ),
  };
}
