// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {ExternalIssueReviewV1} from '../../../types/externalIssueReporting';
import {
  issueExternalIssueReviewAttestation,
  verifyExternalIssueReviewAttestation,
} from '../reviewAttestation';

const scope = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  userId: 'user-1',
};

function review(): ExternalIssueReviewV1 {
  return {
    schemaVersion: 'external_issue_review@1',
    runId: 'run-1',
    runManifestId: 'manifest-1',
    source: 'deterministic_fallback',
    fallbackReason: 'runtime_not_supported',
    candidates: [{
      candidateId: 'candidate-1',
      decision: 'needs_verification',
      ownership: 'runtime',
      contributionKind: 'runtime_compatibility',
      confidence: 'low',
      title: 'Runtime requires verification',
      agentAssessment: 'The pinned runtime does not support triage.',
      basisSignalIds: ['signal-1'],
      references: {
        claimIds: [],
        findingIds: [],
        evidenceRefIds: [],
        skillIds: [],
      },
      missingEvidence: ['A supported Provider review'],
      userQuestions: [],
      draftSeed: {
        problemStatement: 'The runtime could not perform review.',
        expectedBehavior: 'Use a supported pinned runtime.',
        reproductionHint: 'Revisit the completed run.',
        suggestedContribution: 'Share runtime compatibility details.',
      },
    }],
  };
}

describe('external issue review attestation', () => {
  it('binds the review, source run, Provider snapshot, owner, and expiry', () => {
    const value = review();
    value.serverAttestation = issueExternalIssueReviewAttestation({
      review: value,
      providerSnapshotHash: 'snapshot-1',
      providerScope: scope,
      now: 1_000,
      ttlMs: 60_000,
    });

    expect(verifyExternalIssueReviewAttestation({
      review: value,
      providerSnapshotHash: 'snapshot-1',
      providerScope: scope,
      now: 2_000,
    })).toBe(true);

    expect(verifyExternalIssueReviewAttestation({
      review: {
        ...value,
        candidates: [{
          ...value.candidates[0],
          title: 'Client-altered title',
        }],
      },
      providerSnapshotHash: 'snapshot-1',
      providerScope: scope,
      now: 2_000,
    })).toBe(false);

    expect(verifyExternalIssueReviewAttestation({
      review: value,
      providerSnapshotHash: 'snapshot-1',
      providerScope: {...scope, userId: 'other-user'},
      now: 2_000,
    })).toBe(false);

    expect(verifyExternalIssueReviewAttestation({
      review: value,
      providerSnapshotHash: 'snapshot-1',
      providerScope: scope,
      now: 61_001,
    })).toBe(false);
  });
});
