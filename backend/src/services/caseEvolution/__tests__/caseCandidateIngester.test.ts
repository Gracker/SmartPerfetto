// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import { CaseGraph } from '../../caseGraph';
import { CaseLibrary } from '../../caseLibrary';
import { RagStore } from '../../ragStore';
import { openCaseCandidateOutbox, type CaseCandidateOutboxHandle } from '../caseCandidateOutbox';
import {
  ingestReviewedCaseCandidate,
  learnedCaseIdForCandidate,
  rederiveLearnedCandidates,
} from '../caseCandidateIngester';

let tmpDir: string;
let library: CaseLibrary;
let graph: CaseGraph;
let ragStore: RagStore;
let outbox: CaseCandidateOutboxHandle;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-ingester-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
  graph = new CaseGraph(path.join(tmpDir, 'case_graph.json'));
  ragStore = new RagStore(path.join(tmpDir, 'rag_store.json'));
  outbox = openCaseCandidateOutbox({ dbPath: ':memory:' });
});

afterEach(() => {
  outbox.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function candidate(candidateId = 'cand-ingest-1'): CaseCandidate {
  return {
    candidateId,
    schemaVersion: 'case_candidate@2',
    provenance: {
      sourceSessionId: 'session-1',
      sourceAnalysisRunId: 'run-1',
      sourceTurnIndex: 1,
      traceContentHash: 'trace-hash',
      capturedAt: 1000,
      engine: 'claude',
      sceneType: 'scrolling',
      architectureType: 'FLUTTER',
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
      evidenceSignatures: { reason_code: 'shader_compile', render_slices: ['makePipeline'] },
    },
    evidenceHandle: {
      analysisRunId: 'run-1',
      clusterIndex: 0,
      evidenceRefIds: ['ev-1'],
      snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
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

function review(candidateId = 'cand-ingest-1'): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId,
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader compilation causes jank',
      primaryRootCause: 'shader_compile',
      secondaryRootCauses: [],
      responsibility: 'app',
      severity: 'warning',
      evidenceSignatures: {
        required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }],
        supportive: [{ field: 'render_slices', op: 'contains_any', value: ['makePipeline'] }],
      },
      findings: [{ id: 'f1', title: 'Shader compile frames', evidence_refs: ['ev-1'], confidence: 'high' }],
      recommendations: {
        app: [{ id: 'r1', priority: 'P1', action: 'Warm shaders', applies_when: 'shader_compile', risks: 'Startup cost' }],
        oem: [],
      },
      relations: { similar_root_cause: ['case-published'] },
    },
    evidenceSummary: 'Supported by evidence',
    risks: [],
  };
}

describe('caseCandidateIngester', () => {
  it('ingests a promoted review as draft imported redacted case with learned graph and RAG rows', () => {
    library.saveCase({
      schemaVersion: 1,
      source: 'curated_markdown_case',
      createdAt: 1,
      caseId: 'case-published',
      title: 'Published case',
      status: 'reviewed',
      redactionState: 'redacted',
      tags: ['scrolling'],
      findings: [],
    });

    const result = ingestReviewedCaseCandidate({
      candidate: candidate(),
      review: review(),
      library,
      graph,
      ragStore,
      sidecarRelativePath: 'logs/case_candidates/cand-ingest-1.json',
    });

    const expectedLearnedId = learnedCaseIdForCandidate('cand-ingest-1');
    expect(result.learnedCaseId).toBe(expectedLearnedId);
    const learned = library.getCase(result.learnedCaseId)!;
    expect(learned).toMatchObject({
      status: 'draft',
      source: 'runtime_analysis_candidate',
      redactionState: 'redacted',
      title: 'Shader compilation causes jank',
    });
    expect(learned.knowledge).toMatchObject({
      quality: 'imported',
      sourceFile: 'logs/case_candidates/cand-ingest-1.json',
      domainPack: 'scrolling.v1',
    });
    expect(learned.findings[0]).toMatchObject({
      id: 'f1',
      severity: 'critical',
      evidence: { externalRef: 'data-envelope:ev-1' },
    });
    expect(graph.listEdges()).toEqual([
      expect.objectContaining({
        edgeId: `case-learned-edge:${expectedLearnedId}:similar_root_cause:case-published`,
      }),
    ]);
    expect(ragStore.listChunks({ kind: 'case_library', uriPrefix: 'case://learned/' })).toEqual([
      expect.objectContaining({
        chunkId: `case:${expectedLearnedId}:summary`,
        registryOrigin: 'plan54_cases',
        uri: `case://learned/${expectedLearnedId}`,
      }),
    ]);
  });

  it('rederives learned candidates with upsert plus demote-to-private convergence', () => {
    const first = candidate('cand-ingest-1');
    const second = candidate('cand-ingest-2');
    const firstLearned = learnedCaseIdForCandidate(first.candidateId);
    const secondLearned = learnedCaseIdForCandidate(second.candidateId);
    outbox.enqueue(first, { dedupeKey: 'dedupe-1' });
    const firstLease = outbox.leaseNext({
      candidateId: first.candidateId,
      workerOwner: 'test-ingest-first',
    })!;
    outbox.completeReviewedLease(firstLease.lease!, {
      review: review(first.candidateId),
    });
    outbox.setLearnedCaseId(first.candidateId, firstLearned);
    outbox.enqueue(second, { dedupeKey: 'dedupe-2' });
    const secondLease = outbox.leaseNext({
      candidateId: second.candidateId,
      workerOwner: 'test-ingest-second',
    })!;
    outbox.completeReviewedLease(secondLease.lease!, {
      review: review(second.candidateId),
    });
    outbox.setLearnedCaseId(second.candidateId, secondLearned);

    rederiveLearnedCandidates({ outbox, library, graph, ragStore });
    expect(library.getCase(firstLearned)?.status).toBe('draft');
    expect(library.getCase(secondLearned)?.status).toBe('draft');

    outbox.rejectReviewedForGovernance(
      'cand-ingest-2',
      'operator rejected',
    );
    rederiveLearnedCandidates({ outbox, library, graph, ragStore });

    expect(library.getCase(firstLearned)?.status).toBe('draft');
    expect(library.getCase(secondLearned)?.status).toBe('private');
  });

  // Regression: candidate ids longer than 16 chars (the realistic
  // `casecand-${runId}-${digest}` shape) must NOT collide onto the same
  // learned id. The original `slice(0, 16)` impl dropped the disambiguating
  // digest for long run ids and silently overwrote distinct cases.
  it('produces distinct learned ids for distinct candidate ids that share a long common prefix', () => {
    const longA = 'casecand-session-abc123def4567890ghi1111111111111111';
    const longB = 'casecand-session-abc123def4567890ghi2222222222222222';
    // Sanity: these two ids share their first 16 chars but differ later.
    expect(longA.slice(0, 16)).toBe(longB.slice(0, 16));
    const learnedA = learnedCaseIdForCandidate(longA);
    const learnedB = learnedCaseIdForCandidate(longB);
    expect(learnedA).not.toBe(learnedB);
    // And the same input is stable.
    expect(learnedCaseIdForCandidate(longA)).toBe(learnedA);
  });
});
