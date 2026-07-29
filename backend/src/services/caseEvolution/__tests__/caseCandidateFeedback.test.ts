// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import { CaseLibrary } from '../../caseLibrary';
import { openCaseCandidateOutbox, type CaseCandidateOutboxHandle } from '../caseCandidateOutbox';
import { syncCaseCandidateFeedbackProjection } from '../caseCandidateFeedback';

let outbox: CaseCandidateOutboxHandle;
let library: CaseLibrary;
let tmpDir: string;

beforeEach(() => {
  outbox = openCaseCandidateOutbox({ dbPath: ':memory:' });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-feedback-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
});

afterEach(() => {
  outbox.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidate(candidateId = 'cand-feedback-1'): CaseCandidate {
  return {
    candidateId,
    schemaVersion: 'case_candidate@2',
    provenance: {
      sourceSessionId: 'session-1',
      sourceAnalysisRunId: 'run-1',
      sourceTurnIndex: 1,
      traceContentHash: 'trace-hash',
      capturedAt: 1_000,
      engine: 'claude',
      sceneType: 'scrolling',
      architectureType: 'unknown',
      originScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    },
    cluster: {
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      responsibility: 'app',
      severity: 'warning',
      frameCount: 4,
      percentage: 20,
      evidenceSignatures: { reason_code: 'shader_compile' },
    },
    evidenceHandle: {
      analysisRunId: 'run-1',
      clusterIndex: 0,
      evidenceRefIds: ['ev-1'],
      snapshotPath: 'snapshot',
    },
    verification: {
      claimSupportSummary: 'verified',
      verifierStatus: 'passed',
      verifierIssueSeverities: [],
      verifierErrorCount: 0,
      verifierWarningCount: 0,
      confidenceNumeric: 0.9,
      confidenceBucket: 'high',
    },
  };
}

function review(candidateId = 'cand-feedback-1'): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId,
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader case',
      primaryRootCause: 'shader_compile',
      secondaryRootCauses: [],
      responsibility: 'app',
      severity: 'warning',
      evidenceSignatures: { required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }], supportive: [] },
      findings: [],
      recommendations: { app: [], oem: [] },
      relations: {},
    },
    evidenceSummary: 'summary',
    risks: [],
  };
}

function seedReviewedCase() {
  const item = candidate();
  outbox.enqueue(item, { dedupeKey: 'dedupe' });
  const lease = outbox.leaseNext({
    candidateId: item.candidateId,
    workerOwner: 'test-feedback',
  })!;
  outbox.completeReviewedLease(lease.lease!, {review: review()});
  outbox.setLearnedCaseId(item.candidateId, 'learned:cand-feedback');
  library.saveCase({
    schemaVersion: 1,
    source: 'runtime_analysis_candidate',
    createdAt: 1,
    caseId: 'learned:cand-feedback',
    title: 'Shader case',
    status: 'draft',
    redactionState: 'redacted',
    tags: ['scrolling'],
    findings: [],
    knowledge: {
      sourceFile: 'logs/case_candidates/cand-feedback-1.json',
      body: 'body',
      quality: 'imported',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: { 'caseEvolution.v1': { candidateId: item.candidateId, supportingEvidence: 0, contradictingEvidence: 0, supported: false } },
      evidenceSignatures: { required: [], supportive: [] },
      recommendations: { app: [], oem: [] },
    },
  });
}

function feedback(
  ratings: Array<'positive' | 'negative'>,
): any[] {
  return ratings.map((rating, index) => ({
    feedbackId: `feedback-${index}`,
    currentEventId: `event-${index}`,
    sequence: index + 1,
    legacy: false,
    runId: 'run-1',
    sessionId: `session-${index}`,
    rating,
    dimensions: [],
    targetKind: 'case_candidate',
    targetId: 'cand-feedback-1',
    caseCandidateId: 'cand-feedback-1',
    source: 'ui',
    actor: {userId: 'user-1'},
    scope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    timestamp: new Date(20_000 + index).toISOString(),
  }));
}

describe('syncCaseCandidateFeedbackProjection', () => {
  it('marks a learned case supported after three active positives', () => {
    seedReviewedCase();

    const result = syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: feedback(['positive', 'positive', 'positive']),
      outbox,
      library,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    });

    expect(result).toMatchObject({found: true, supported: true});
    expect(outbox.getCandidate('cand-feedback-1')?.supported).toBe(1);
    expect(library.getCase('learned:cand-feedback')?.knowledge?.context['caseEvolution.v1']).toMatchObject({
      supportingEvidence: 3,
      supported: true,
    });
    const firstMarker = library.getCase('learned:cand-feedback')
      ?.knowledge?.context['caseEvolution.v1'] as Record<string, unknown>;

    syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: feedback(['positive', 'positive', 'positive']),
      outbox,
      library,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    });
    const retriedMarker = library.getCase('learned:cand-feedback')
      ?.knowledge?.context['caseEvolution.v1'] as Record<string, unknown>;
    expect(retriedMarker.supportedAt).toBe(firstMarker.supportedAt);

    syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: [],
      outbox,
      library,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    });
    expect(library.getCase('learned:cand-feedback')
      ?.knowledge?.context['caseEvolution.v1']).not.toHaveProperty('supportedAt');
  });

  it('retracts feedback-only rejection and restores the prior Case status', () => {
    seedReviewedCase();

    syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: feedback(['negative', 'negative']),
      outbox,
      library,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    });
    expect(outbox.getCandidate('cand-feedback-1')).toMatchObject({
      state: 'rejected',
      intrinsicState: 'reviewed',
    });
    expect(library.getCase('learned:cand-feedback')?.status).toBe('private');

    syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: [],
      outbox,
      library,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    });
    expect(outbox.getCandidate('cand-feedback-1')?.state).toBe('reviewed');
    expect(library.getCase('learned:cand-feedback')?.status).toBe('draft');
  });

  it('rejects feedback from another tenant before mutating counters', () => {
    seedReviewedCase();
    const result = syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: feedback(['positive']),
      outbox,
      library,
      knowledgeScope: {tenantId: 'tenant-b', workspaceId: 'default-workspace'},
    });

    expect(result).toMatchObject({found: false, reason: 'scope_mismatch'});
    expect(outbox.getCandidate('cand-feedback-1')?.supportingEvidence).toBe(0);
  });

  it('updates published Case evidence without changing published governance', () => {
    seedReviewedCase();
    library.publishCase('learned:cand-feedback', {reviewer: 'maintainer'});

    syncCaseCandidateFeedbackProjection({
      candidateId: 'cand-feedback-1',
      feedback: feedback(['negative', 'negative']),
      outbox,
      library,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    });

    const published = library.getCase('learned:cand-feedback');
    expect(published?.status).toBe('published');
    expect(published?.knowledge?.context['caseEvolution.v1']).toMatchObject({
      contradictingEvidence: 2,
      feedbackProjectionRejected: true,
    });
  });
});
