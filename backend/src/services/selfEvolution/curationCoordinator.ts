// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {canonicalContentHash} from './canonicalJson';
import {
  CURATION_ANALYZER_VERSION,
  CURATION_COORDINATOR_VERSION,
  FAILURE_ATTRIBUTOR_VERSION,
  PROPOSAL_GENERATOR_VERSION,
  RETIRE_PROPOSER_VERSION,
  type CurationCandidate,
  type SelectedCurationCandidate,
} from './curationContracts';

const SOURCE_PRIORITY: Readonly<Record<CurationCandidate['source'], number>> = {
  technical_attribution: 0,
  retire_injection: 1,
};

/**
 * The only M6 candidate selector. Even when both technical attribution and
 * observational retirement match, this coordinator returns zero or one item.
 */
export function selectSingleCurationCandidate(input: {
  candidates: readonly CurationCandidate[];
  templateContentHash: string;
}): SelectedCurationCandidate | null {
  const candidate = [...input.candidates].sort((left, right) =>
    SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
    left.candidateKey.localeCompare(right.candidateKey))[0];
  if (!candidate) return null;
  const idempotencyKey = canonicalContentHash({
    schemaVersion: 1,
    versions: {
      analyzer: CURATION_ANALYZER_VERSION,
      attributor: FAILURE_ATTRIBUTOR_VERSION,
      retireProposer: RETIRE_PROPOSER_VERSION,
      coordinator: CURATION_COORDINATOR_VERSION,
      generator: PROPOSAL_GENERATOR_VERSION,
    },
    templateContentHash: input.templateContentHash,
    source: candidate.source,
    kind: candidate.kind,
    tier: candidate.tier,
    delta: candidate.delta,
    sourceState: candidate.sourceState,
  });
  return {
    ...candidate,
    proposalId: `proposal-${idempotencyKey.slice(0, 32)}`,
    operationId: `operation-${idempotencyKey.slice(0, 32)}`,
    idempotencyKey,
    templateContentHash: input.templateContentHash,
  };
}
