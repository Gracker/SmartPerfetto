// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import {
  openCaseCandidateOutbox,
  type CaseCandidateOutboxHandle,
} from '../caseCandidateOutbox';
import {
  CaseEvolutionWorker,
  __testing,
} from '../caseEvolutionWorker';
import type {
  IngestReviewedCaseCandidateOptions,
  IngestReviewedCaseCandidateResult,
} from '../caseCandidateIngester';

let outbox: CaseCandidateOutboxHandle;
let tempDir: string;

beforeEach(() => {
  outbox = openCaseCandidateOutbox({dbPath: ':memory:'});
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-worker-'));
});

afterEach(() => {
  outbox.close();
  fs.rmSync(tempDir, {recursive: true, force: true});
});

function candidate(candidateId = 'cand-worker-1'): CaseCandidate {
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

function review(candidateId = 'cand-worker-1'): CaseCandidateReview {
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

function enqueue(item = candidate()): void {
  const result = outbox.enqueue(item, {dedupeKey: `${item.candidateId}:dedupe`});
  expect(result.enqueued).toBe(true);
}

function executeOk(item = review()) {
  return jest.fn(async () => ({
    ok: true as const,
    review: item as unknown as Record<string, unknown>,
  }));
}

function executeFailure(reason: 'sdk_timeout' | 'sdk_error' | 'sdk_invalid' = 'sdk_timeout') {
  return jest.fn(async () => ({
    ok: false as const,
    reason,
    details: 'budget',
  }));
}

describe('CaseEvolutionWorker', () => {
  it('start() is a no-op when review flag is disabled', () => {
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeFailure('sdk_error'),
      config: {reviewEnabled: false},
    });

    expect(worker.start()).toBe(false);
  });

  it('does not lease work when review is enabled without capture', async () => {
    enqueue();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const executeReview = executeOk();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview,
      config: {reviewEnabled: true, captureEnabled: false},
    });

    await worker.tick();

    expect(executeReview).not.toHaveBeenCalled();
    expect(outbox.getCandidate('cand-worker-1')?.attempts).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('REVIEW_ENABLED requires CAPTURE_ENABLED'));
  });

  it('writes a sidecar and marks promote reviews as reviewed', async () => {
    enqueue();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeOk(),
      config: {captureEnabled: true, reviewEnabled: true, notesWriteEnabled: true},
      notesDir: tempDir,
    });

    await worker.tick();

    const row = outbox.getCandidate('cand-worker-1')!;
    expect(row.state).toBe('reviewed');
    expect(row.learnedCaseId).toBeNull();
    expect(row.review?.decision).toBe('promote');
    expect(row.notePath).toBe(path.join(tempDir, 'cand-worker-1.json'));
    expect(fs.existsSync(row.notePath!)).toBe(true);
  });

  it('stores valid reviews without sidecars when notes writes are disabled', async () => {
    enqueue();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeOk(),
      config: {captureEnabled: true, reviewEnabled: true, notesWriteEnabled: false},
      notesDir: tempDir,
    });

    await worker.tick();

    const row = outbox.getCandidate('cand-worker-1')!;
    expect(row.state).toBe('reviewed');
    expect(row.review?.decision).toBe('promote');
    expect(row.notePath).toBeNull();
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('ingests promoted reviews when ingest is explicitly enabled', async () => {
    enqueue();
    const ingestReviewedCandidate = jest.fn((_input: any) => ({
      learnedCaseId: 'learned:cand-worker-1',
      warnings: [],
    }));
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeOk(),
      config: {captureEnabled: true, reviewEnabled: true, notesWriteEnabled: false, ingestEnabled: true},
      ingestReviewedCandidate,
    });

    await worker.tick();

    expect(ingestReviewedCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidate: expect.objectContaining({candidateId: 'cand-worker-1'}),
      review: expect.objectContaining({candidateId: 'cand-worker-1'}),
      sidecarRelativePath: undefined,
      knowledgeScope: {tenantId: 'default-dev-tenant', workspaceId: 'default-workspace'},
    }));
    expect(outbox.getCandidate('cand-worker-1')?.learnedCaseId).toBe('learned:cand-worker-1');
  });

  it('rejects legacy unscoped rows before review or ingestion', async () => {
    const legacy = candidate() as any;
    delete legacy.provenance.originScope;
    outbox.enqueue(legacy, {dedupeKey: 'legacy-unscoped'});
    const executeReview = executeOk();
    const ingestReviewedCandidate = jest.fn<
      (input: IngestReviewedCaseCandidateOptions) => IngestReviewedCaseCandidateResult
    >();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview,
      ingestReviewedCandidate,
      config: {captureEnabled: true, reviewEnabled: true, ingestEnabled: true},
    });

    await worker.tick();

    expect(executeReview).not.toHaveBeenCalled();
    expect(ingestReviewedCandidate).not.toHaveBeenCalled();
    expect(outbox.getCandidate(legacy.candidateId)).toMatchObject({
      state: 'rejected',
      lastError: 'candidate is missing a valid immutable origin scope',
    });
  });

  it('rejects schema/content validation failures permanently', async () => {
    enqueue();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeOk({...review(), candidateId: 'wrong'}),
      config: {captureEnabled: true, reviewEnabled: true, notesWriteEnabled: true},
      notesDir: tempDir,
    });

    await worker.tick();

    const row = outbox.getCandidate('cand-worker-1')!;
    expect(row.state).toBe('rejected');
    expect(row.lastError).toMatch(/candidateId/);
    expect(row.notePath).toBeNull();
  });

  it('retries SDK failures until max attempts and then rejects', async () => {
    enqueue();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeFailure('sdk_timeout'),
      config: {captureEnabled: true, reviewEnabled: true, maxAttempts: 2},
    });

    await worker.tick();
    expect(outbox.getCandidate('cand-worker-1')!.state).toBe('pending_review');

    await worker.tick();
    const row = outbox.getCandidate('cand-worker-1')!;
    expect(row.state).toBe('rejected');
    expect(row.lastError).toMatch(/sdk_timeout/);
  });

  it('honors daily budget before leasing', async () => {
    enqueue();
    const executeReview = executeOk();
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview,
      config: {captureEnabled: true, reviewEnabled: true, dailyBudget: 0},
    });

    await worker.tick();

    expect(executeReview).not.toHaveBeenCalled();
    expect(outbox.getCandidate('cand-worker-1')!.attempts).toBe(0);
  });

  it('caps concurrency at two', () => {
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeFailure('sdk_error'),
      config: {captureEnabled: true, reviewEnabled: true, workerConcurrency: 99},
    });

    expect(worker.snapshot().concurrency).toBe(__testing.MAX_CONCURRENCY);
  });

  it('expires stale leases before leasing work', async () => {
    enqueue();
    const leased = outbox.leaseNext({workerOwner: 'old-worker', leaseDurationMs: 1})!;
    expect(leased.leaseOwner).toBe('old-worker');
    await new Promise(resolve => setTimeout(resolve, 5));

    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: executeOk(),
      config: {captureEnabled: true, reviewEnabled: true, notesWriteEnabled: false},
    });

    await worker.tick();

    expect(outbox.getCandidate('cand-worker-1')!.state).toBe('reviewed');
  });

  it('rechecks the fence before sidecar and ingest side effects', async () => {
    enqueue();
    let now = 100;
    const ingestReviewedCandidate = jest.fn(
      (_input: IngestReviewedCaseCandidateOptions) => ({
        learnedCaseId: 'learned:stale',
        warnings: [],
      }),
    );
    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: jest.fn(async () => {
        now = 111;
        return {
          ok: true as const,
          review: review() as unknown as Record<string, unknown>,
        };
      }),
      ingestReviewedCandidate,
      config: {
        captureEnabled: true,
        reviewEnabled: true,
        notesWriteEnabled: true,
        ingestEnabled: true,
        leaseMs: 10,
      },
      notesDir: tempDir,
      clock: () => now,
    });

    await worker.tick();

    expect(fs.readdirSync(tempDir)).toEqual([]);
    expect(ingestReviewedCandidate).not.toHaveBeenCalled();
    expect(outbox.getCandidate('cand-worker-1')).toMatchObject({
      state: 'pending_review',
      leaseOwner: 'case-evolution-' + process.pid,
    });
    expect(worker.stats.failedTransient).toBe(1);
  });
});
