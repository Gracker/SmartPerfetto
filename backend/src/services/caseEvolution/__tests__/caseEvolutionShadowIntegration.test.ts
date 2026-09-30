// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnalysisResult } from '../../../agent/core/orchestratorTypes';
import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import type { ClaimVerificationResult } from '../../../types/claimVerification';
import type { DataEnvelope } from '../../../types/dataContract';
import {
  captureCaseCandidatesAfterQualityArtifacts,
} from '../../../routes/agentRoutes';
import { openCaseCandidateOutbox, type CaseCandidateOutboxHandle } from '../caseCandidateOutbox';
import { loadCaseEvolutionConfig } from '../caseEvolutionConfig';
import { CaseEvolutionWorker } from '../caseEvolutionWorker';
import { saveCaseCandidates } from '../saveCaseCandidates';
import {NO_PRIVATE_CONTEXT} from '../../security/analysisPrivateContext';

let outbox: CaseCandidateOutboxHandle;
let tempDir: string;

beforeEach(() => {
  outbox = openCaseCandidateOutbox({dbPath: ':memory:'});
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-shadow-'));
});

afterEach(() => {
  outbox.close();
  fs.rmSync(tempDir, {recursive: true, force: true});
});

function rootCauseEnvelope(): DataEnvelope {
  return {
    schemaVersion: 'data-envelope@1',
    data: {
      columns: ['reason_code', 'jank_responsibility', 'frame_count', 'percentage', 'frame_id', 'dur_ms', 'vsync_missed', 'render_slices_json'],
      rows: [[
        'shader_compile',
        'APP',
        4,
        18,
        'frame-1',
        24.5,
        2,
        '["compileShader"]',
      ]],
    },
    meta: {
      skillId: 'scrolling_analysis',
      stepId: 'batch_frame_root_cause',
      evidenceRefId: 'ev-root-cause',
    },
  } as unknown as DataEnvelope;
}

function analysisResult(): AnalysisResult {
  return {
    sessionId: 'session-shadow',
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: 'Shader compilation caused repeated scroll jank.',
    confidence: 0.91,
    rounds: 2,
    totalDurationMs: 1000,
  };
}

function claimVerification(): ClaimVerificationResult {
  return {
    status: 'passed',
    summary: {
      checkedClaims: 1,
      supportedClaims: 1,
      unsupportedClaims: 0,
      warningClaims: 0,
    },
    issues: [],
  } as unknown as ClaimVerificationResult;
}

function review(candidateId: string): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId,
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader compilation causes scroll jank',
      primaryRootCause: 'shader_compile',
      secondaryRootCauses: [],
      responsibility: 'app',
      severity: 'warning',
      evidenceSignatures: {
        required: [{field: 'reason_code', op: 'eq', value: 'shader_compile'}],
        supportive: [{field: 'jank_responsibility', op: 'eq', value: 'APP'}],
      },
      findings: [{id: 'finding-1', title: 'Shader compile frames', evidence_refs: ['ev-root-cause'], confidence: 'high'}],
      recommendations: {
        app: [{id: 'rec-1', priority: 'P1', action: 'Warm shader cache', applies_when: 'reason_code is shader_compile', risks: 'May move work earlier'}],
        oem: [],
      },
      relations: {},
    },
    evidenceSummary: 'The candidate is supported by the captured batch root-cause distribution.',
    risks: [],
  };
}

describe('case evolution shadow integration', () => {
  it('captures, reviews, and writes a shadow sidecar without case-library writes', async () => {
    const capture = await saveCaseCandidates({
      result: analysisResult(),
      claimVerificationResult: claimVerification(),
      dataEnvelopes: [rootCauseEnvelope()],
      sceneType: 'scrolling',
      architectureType: 'android',
      snapshotPath: 'session-persistence://sessions/session-shadow/metadata/sessionStateSnapshot',
      provenance: {
        sessionId: 'session-shadow',
        runId: 'run-shadow',
        turnIndex: 1,
        engine: 'claude',
        traceContentHash: 'trace-hash-shadow',
      },
    }, {
      config: loadCaseEvolutionConfig({CASE_EVOLUTION_CAPTURE_ENABLED: '1'}),
      outbox,
    });
    expect(capture).toEqual({captured: 1});

    const worker = new CaseEvolutionWorker({
      outbox,
      executeReview: jest.fn(async (candidate: CaseCandidate) => ({
        ok: true as const,
        review: review(candidate.candidateId) as unknown as Record<string, unknown>,
      })),
      config: {
        captureEnabled: true,
        reviewEnabled: true,
        notesWriteEnabled: true,
      },
      notesDir: path.join(tempDir, 'case_candidates'),
    });
    await worker.tick();

    const row = outbox.countCandidatesByState();
    expect(row.reviewed).toBe(1);
    const reviewed = outbox.getCandidate(
      outbox.leaseNext({workerOwner: 'no-more-work'})?.candidateId || 'missing',
    );
    expect(reviewed).toBeNull();
    const sidecars = fs.readdirSync(path.join(tempDir, 'case_candidates'));
    expect(sidecars).toHaveLength(1);
    expect(fs.existsSync(path.join(tempDir, 'case_library.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'case_graph.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'rag_store.json'))).toBe(false);
  });

  it('builds capture input from live result and session data after reconnect-style reconstruction', async () => {
    const liveEnvelope = rootCauseEnvelope();
    const saveCandidates = jest.fn<(input: unknown) => Promise<{captured: number; skipped: string}>>(
      async () => ({captured: 0, skipped: 'no_candidates'}),
    );
    const result = analysisResult() as AnalysisResult & {conclusionContract?: any};
    const normalizedConclusionContract = {schemaVersion: 'conclusion-contract@1', claims: []};
    const staleSnapshotContract = {schemaVersion: 'stale', claims: ['do-not-use']};

    await captureCaseCandidatesAfterQualityArtifacts({
      sessionId: 'session-shadow',
      traceId: 'trace-shadow',
      session: {
        activeRun: {runId: 'run-shadow', sequence: 7, privateContext: NO_PRIVATE_CONTEXT},
        dataEnvelopes: [liveEnvelope],
        orchestrator: {getCachedArchitecture: () => ({type: 'android'})},
        _lastSnapshot: {conclusionContract: staleSnapshotContract},
      } as any,
      result,
      normalizedConclusionContract: normalizedConclusionContract as any,
      sceneIdHint: 'scrolling',
      runIdForAnalysis: 'run-shadow',
      caseEvolutionConfig: {captureEnabled: true} as any,
      computeTraceHash: jest.fn(async () => 'trace-hash-shadow'),
      saveCandidates,
      logger: {warn: jest.fn(), info: jest.fn()} as any,
    });

    expect(saveCandidates).toHaveBeenCalledWith(expect.objectContaining({
      dataEnvelopes: [liveEnvelope],
      conclusionContract: normalizedConclusionContract,
      provenance: expect.objectContaining({turnIndex: 7}),
    }));
  });

  it('does not attach or prune case recommendations in PR A capture', async () => {
    const caseRecommendations = [{caseId: 'case-1', matchStrength: 'strong'}];
    const result = {
      ...analysisResult(),
      conclusionContract: {
        schemaVersion: 'conclusion-contract@1',
        caseRecommendations,
      },
    } as AnalysisResult & {conclusionContract: any};

    await saveCaseCandidates({
      result,
      conclusionContract: result.conclusionContract,
      claimVerificationResult: claimVerification(),
      dataEnvelopes: [rootCauseEnvelope()],
      sceneType: 'scrolling',
      architectureType: 'android',
      snapshotPath: 'session-persistence://sessions/session-shadow/metadata/sessionStateSnapshot',
      provenance: {
        sessionId: 'session-shadow',
        runId: 'run-shadow',
        turnIndex: 1,
        engine: 'claude',
        traceContentHash: 'trace-hash-shadow',
      },
    }, {
      config: loadCaseEvolutionConfig({CASE_EVOLUTION_CAPTURE_ENABLED: '1'}),
      outbox,
    });

    expect(result.conclusionContract.caseRecommendations).toBe(caseRecommendations);
  });
});
