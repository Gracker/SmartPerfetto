// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import { openCaseCandidateOutbox, type CaseCandidateOutboxHandle } from '../caseCandidateOutbox';
import { collectCaseEvolutionMetrics } from '../caseEvolutionMetricsAggregator';
import {
  __testing as runtimeMetricsTesting,
  recordCaseEvolutionCaseHitsPruned,
  recordCaseEvolutionPromptDroppedForBudget,
  recordCaseEvolutionPromptSegmentBuilt,
  recordCaseEvolutionRetrieverQuery,
  recordCaseEvolutionWorkerPoll,
  recordCaseEvolutionWorkerRunning,
} from '../caseEvolutionRuntimeMetrics';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-metrics-'));
});

afterEach(() => {
  runtimeMetricsTesting.resetCaseEvolutionRuntimeMetrics();
  fs.rmSync(tempDir, {recursive: true, force: true});
});

function candidate(candidateId: string): CaseCandidate {
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
      percentage: 18,
      evidenceSignatures: {reason_code: 'shader_compile'},
    },
    evidenceHandle: {
      analysisRunId: 'run-1',
      clusterIndex: 0,
      evidenceRefIds: ['ev-1'],
      snapshotPath: 'session-persistence://sessions/session-1/metadata/sessionStateSnapshot',
    },
    verification: {
      claimSupportSummary: 'claims verified',
      verifierStatus: 'passed',
      verifierIssueSeverities: [],
      verifierErrorCount: 0,
      verifierWarningCount: 0,
      confidenceNumeric: 0.9,
      confidenceBucket: 'high',
    },
  };
}

function review(candidateId: string): CaseCandidateReview {
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
        required: [{field: 'reason_code', op: 'eq', value: 'shader_compile'}],
        supportive: [],
      },
      findings: [{id: 'finding-1', title: 'Shader compile frames', evidence_refs: ['ev-1'], confidence: 'high'}],
      recommendations: {
        app: [{id: 'rec-1', priority: 'P1', action: 'Warm shader cache', applies_when: 'shader_compile', risks: 'Startup cost'}],
        oem: [],
      },
      relations: {},
    },
    evidenceSummary: 'Supported by root-cause evidence',
    risks: [],
  };
}

function withOutbox(fn: (outbox: CaseCandidateOutboxHandle, dbPath: string) => void): string {
  const dbPath = path.join(tempDir, 'case_evolution.db');
  const outbox = openCaseCandidateOutbox({dbPath});
  try {
    fn(outbox, dbPath);
  } finally {
    outbox.close();
  }
  return dbPath;
}

describe('caseEvolutionMetricsAggregator', () => {
  it('returns zeros when DB and sidecar directory are absent', () => {
    const metrics = collectCaseEvolutionMetrics({
      dbPath: path.join(tempDir, 'missing.db'),
      sidecarDir: path.join(tempDir, 'missing-sidecars'),
      env: {},
    });

    expect(metrics.candidates.byState).toEqual({
      pending_review: 0,
      reviewed: 0,
      rejected: 0,
      archived: 0,
    });
    expect(metrics.candidates.supported).toBe(0);
    expect(metrics.sidecars.files).toBe(0);
    expect(metrics.warnings).toEqual([]);
  });

  it('counts outbox states, supported candidates, budget, and sidecars', () => {
    const dbPath = withOutbox((box) => {
      box.enqueue(candidate('cand-pending'), {dedupeKey: 'pending'});
      box.enqueue(candidate('cand-reviewed'), {dedupeKey: 'reviewed'});
      box.enqueue(candidate('cand-rejected'), {dedupeKey: 'rejected'});
      box.applyFeedbackProjection('cand-reviewed', [
        {rating: 'positive'},
        {rating: 'positive'},
        {rating: 'positive'},
      ]);
      box.markReviewed('cand-reviewed', {review: review('cand-reviewed'), notePath: 'logs/case_candidates/cand-reviewed.json'});
      box.markRejected('cand-rejected', 'bad review');
    });
    const sidecarDir = path.join(tempDir, 'case_candidates');
    fs.mkdirSync(sidecarDir, {recursive: true});
    fs.writeFileSync(path.join(sidecarDir, 'cand-reviewed.json'), '{"ok":true}\n');
    fs.writeFileSync(path.join(sidecarDir, 'bad.json'), '{bad json');

    const metrics = collectCaseEvolutionMetrics({
      dbPath,
      sidecarDir,
      env: {
        CASE_EVOLUTION_DAILY_BUDGET: '12',
        CASE_EVOLUTION_REVIEW_ENABLED: '1',
      },
    });

    expect(metrics.candidates.byState.pending_review).toBe(1);
    expect(metrics.candidates.byState.reviewed).toBe(1);
    expect(metrics.candidates.byState.rejected).toBe(1);
    expect(metrics.candidates.supported).toBe(1);
    expect(metrics.outbox.dailyBudgetLimit).toBe(12);
    expect(metrics.outbox.dailyBudgetUsed).toBe(
      metrics.outbox.todayReviewed + metrics.outbox.todayFailed,
    );
    expect(metrics.sidecars.files).toBe(2);
    expect(metrics.flags.reviewEnabled).toBe(true);
    expect(metrics.warnings.join('\n')).toMatch(/bad\.json/);
  });

  it('reports corrupt DB open failures as warnings', () => {
    const dbPath = path.join(tempDir, 'corrupt.db');
    fs.writeFileSync(dbPath, 'not sqlite');

    const metrics = collectCaseEvolutionMetrics({
      dbPath,
      sidecarDir: path.join(tempDir, 'missing-sidecars'),
      env: {},
    });

    expect(metrics.candidates.byState.pending_review).toBe(0);
    expect(metrics.warnings.join('\n')).toMatch(/case_evolution outbox/);
  });

  it('counts only effective case-candidate feedback', () => {
    const requestedTargetKinds: unknown[] = [];
    const metrics = collectCaseEvolutionMetrics({
      dbPath: path.join(tempDir, 'missing.db'),
      sidecarDir: path.join(tempDir, 'missing-sidecars'),
      feedbackStore: {
        effectiveStats: targetKind => {
          requestedTargetKinds.push(targetKind);
          return {
            totalPositive: 2,
            totalNegative: 1,
            distinctSessions: 3,
          };
        },
        close: () => undefined,
      },
      env: {},
    });

    expect(requestedTargetKinds).toEqual(['case_candidate']);
    expect(metrics.feedback).toEqual({
      totalPositive: 2,
      totalNegative: 1,
      distinctSessions: 3,
    });
  });

  it('includes process-local retriever and prompt counters', () => {
    recordCaseEvolutionRetrieverQuery({latencyMs: 4, strongHits: 2});
    recordCaseEvolutionRetrieverQuery({latencyMs: 8, strongHits: 1});
    recordCaseEvolutionCaseHitsPruned(1);
    recordCaseEvolutionPromptSegmentBuilt();
    recordCaseEvolutionPromptDroppedForBudget();
    recordCaseEvolutionWorkerRunning(true);
    recordCaseEvolutionWorkerPoll(12345);

    const metrics = collectCaseEvolutionMetrics({
      dbPath: path.join(tempDir, 'missing.db'),
      sidecarDir: path.join(tempDir, 'missing-sidecars'),
      env: {},
    });

    expect(metrics.retriever).toEqual({
      todayQueries: 2,
      todayStrongHits: 3,
      todayPruned: 1,
      avgLatencyMs: 6,
    });
    expect(metrics.prompt).toEqual({
      todaySegmentsBuilt: 1,
      todayDroppedForBudget: 1,
    });
    expect(metrics.worker.running).toBe(true);
    expect(metrics.worker.lastPollAt).toBe(12345);
  });
});
