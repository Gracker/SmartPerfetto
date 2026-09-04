// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  ConclusionContract,
  ConclusionContractClaimReference,
} from '../../agent/core/conclusionContract';
import {claimTextAssertsCausality} from './evidenceContractBuilder';
import type {
  EvidenceRelationCandidateV1,
  EvidenceRelationEndpointV1,
} from '../../types/evidenceContract';

export interface BoundRelationCandidateClaims {
  conclusionContract: ConclusionContract;
  relationActivationClaimIds: string[];
}

export interface RelationCandidateClaimBindingOptions {
  objectCellOnlyCandidateIds?: ReadonlySet<string>;
}

function canonicalRecord(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
}

function stableIdentifierMatches(
  reference: ConclusionContractClaimReference,
  endpoint: EvidenceRelationEndpointV1,
): boolean {
  let matchedIdentifier = false;
  if (endpoint.evidenceRefId) {
    matchedIdentifier = true;
    if (reference.evidenceRefId !== endpoint.evidenceRefId) return false;
  }
  if (endpoint.sourceToolCallId) {
    matchedIdentifier = true;
    if (reference.sourceToolCallId !== endpoint.sourceToolCallId) return false;
  }
  if (endpoint.artifactId) {
    matchedIdentifier = true;
    if (reference.artifactId !== endpoint.artifactId && reference.sourceArtifactId !== endpoint.artifactId) {
      return false;
    }
  }
  if (endpoint.sourceArtifactId) {
    matchedIdentifier = true;
    if (reference.sourceArtifactId !== endpoint.sourceArtifactId &&
      reference.artifactId !== endpoint.sourceArtifactId) return false;
  }
  return matchedIdentifier;
}

function rowMatches(
  reference: ConclusionContractClaimReference,
  endpoint: EvidenceRelationEndpointV1,
): boolean {
  if (!stableIdentifierMatches(reference, endpoint)) return false;
  if (endpoint.rowIndex !== undefined) return reference.rowIndex === endpoint.rowIndex;
  if (endpoint.rowSelector) {
    return reference.rowSelector !== undefined &&
      canonicalRecord(reference.rowSelector) === canonicalRecord(endpoint.rowSelector);
  }
  return false;
}

function pointsAtSubjectCell(
  reference: ConclusionContractClaimReference,
  candidate: EvidenceRelationCandidateV1,
): boolean {
  return Boolean(candidate.subject.column &&
    reference.column === candidate.subject.column &&
    rowMatches(reference, candidate.subject));
}

function matchesCandidateObject(
  reference: ConclusionContractClaimReference,
  candidate: EvidenceRelationCandidateV1,
  options: RelationCandidateClaimBindingOptions,
): boolean {
  if (!candidate.object || !rowMatches(reference, candidate.object)) return false;
  if (pointsAtSubjectCell(reference, candidate)) return false;
  if (!options.objectCellOnlyCandidateIds?.has(candidate.id)) return true;
  return Boolean(candidate.object.column && reference.column === candidate.object.column);
}

export function bindRelationCandidatesToClaims(
  conclusionContract: ConclusionContract,
  relationCandidates: EvidenceRelationCandidateV1[],
  options: RelationCandidateClaimBindingOptions = {},
): BoundRelationCandidateClaims {
  const conclusionContractClone = structuredClone(conclusionContract);
  const relationActivationClaimIds: string[] = [];

  for (const [index, claim] of (conclusionContractClone.claims || []).entries()) {
    // Match classification: a root-cause sentence rarely carries an explicit
    // kind, and requiring one left every producer relation unbound.
    if (claim.kind !== 'causal' && !claimTextAssertsCausality(claim.text)) continue;
    const matchingIds = Array.from(new Set(relationCandidates
      .filter(candidate => (claim.references || []).some(reference =>
        matchesCandidateObject(reference, candidate, options)))
      .map(candidate => candidate.id)))
      .sort();
    if (matchingIds.length === 0) continue;
    const claimId = claim.id || `claim-${index + 1}`;
    relationActivationClaimIds.push(claimId);
    claim.relationRefs = Array.from(new Set([...(claim.relationRefs || []), ...matchingIds]));
  }

  return {conclusionContract: conclusionContractClone, relationActivationClaimIds};
}
