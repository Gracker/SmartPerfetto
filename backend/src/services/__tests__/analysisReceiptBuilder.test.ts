// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  buildAnalysisReceipt,
  buildLegacyAnalysisReceipt,
} from '../analysisReceiptBuilder';
import type { QuickRunReceipt } from '../../agent/core/orchestratorTypes';
import type { ClaimVerificationResult } from '../../types/claimVerification';
import type { ClaimSupportV1 } from '../../types/evidenceContract';
import type { DataEnvelope } from '../../types/dataContract';

const quickRun: QuickRunReceipt = {
  requestedMode: 'fast',
  resolvedMode: 'quick',
  profile: 'normal',
  targetTurns: 5,
  hardCapTurns: 8,
  actualTurns: 4,
  elapsedMs: 1234,
  enforcement: 'turn_cap',
  stopReason: 'answered',
  evidence: {
    frontendPrequeryInjected: 2,
    frontendPrequeryCited: 1,
    currentRunDataEnvelopes: 2,
    citedEvidenceRefs: 2,
  },
  contextInjected: {
    conversationTurns: 1,
    recentSqlResults: 1,
    sqlPitfallPairs: 2,
    patternHints: 3,
    negativePatternHints: 1,
    caseBackgroundCases: 1,
  },
  verifierStatus: 'passed',
};

describe('buildLegacyAnalysisReceipt', () => {
  it('builds schema v1 only for explicit legacy recovery', () => {
    const receipt = buildLegacyAnalysisReceipt({
      session: {
        sessionId: 'session-legacy',
        traceId: 'trace-legacy',
      },
      result: {
        success: true,
        sessionId: 'run-legacy',
        conclusion: 'legacy result',
        findings: [],
        hypotheses: [],
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      },
      generatedAt: 123,
    });

    expect(receipt).toEqual(expect.objectContaining({
      schemaVersion: 1,
      runId: 'run-legacy',
      sessionId: 'session-legacy',
      traceId: 'trace-legacy',
      generatedAt: 123,
    }));
    expect(receipt).not.toHaveProperty('runManifestId');
  });
});

function sqlEnvelope(id: string): DataEnvelope {
  return {
    meta: {
      type: 'sql_result',
      version: '2.0.0',
      source: 'execute_sql',
      timestamp: 1,
      evidenceRefId: id,
      sourceToolCallId: 'tool-sql-1',
    },
    display: { layer: 'list', format: 'table', title: 'SQL' },
    data: { columns: ['dur_ms'], rows: [[42]] } as any,
  };
}

function skillEnvelope(id: string): DataEnvelope {
  return {
    meta: {
      type: 'skill_result',
      version: '2.0.0',
      source: 'scrolling_analysis:get_app_jank_frames',
      timestamp: 2,
      skillId: 'scrolling_analysis',
      stepId: 'get_app_jank_frames',
      evidenceRefId: id,
    },
    display: { layer: 'deep', format: 'table', title: 'Skill' },
    data: { columns: ['frame_id'], rows: [[7]] } as any,
  };
}

const claimSupport: ClaimSupportV1[] = [
  {
    claimId: 'c1',
    kind: 'numeric',
    text: 'Frame took 42 ms.',
    supportLevel: 'verified',
    anchors: [
      {
        anchorId: 'a1',
        version: 'evidence_contract@1',
        evidenceRefId: 'data:sql:current:1',
        context: {
          traceId: 'trace-1',
          producerKind: 'execute_sql',
          sourceToolCallId: 'tool-sql-1',
          artifactId: 'artifact-1',
        },
      },
    ],
  },
  {
    claimId: 'c2',
    kind: 'inference',
    text: 'Likely UI-thread pressure.',
    supportLevel: 'inference',
    anchors: [],
  },
];

const verification: ClaimVerificationResult = {
  schemaVersion: 'claim_verifier@1',
  status: 'partial',
  policy: 'record_only',
  passed: false,
  checkedClaimCount: 2,
  unsupportedClaimCount: 1,
  claimResults: [
    { claimId: 'c1', status: 'verified' },
    { claimId: 'c2', status: 'unsupported' },
  ],
  issues: [
    { claimId: 'c2', severity: 'warning', code: 'unsupported', message: 'Missing direct evidence.' },
  ],
};

describe('buildAnalysisReceipt', () => {
  it('separates trace evidence counts from injected non-evidence context', () => {
    const receipt = buildAnalysisReceipt({
      runManifestId: 'manifest-receipt-1',
      session: {
        sessionId: 'session-1',
        traceId: 'trace-1',
        providerId: null,
        dataEnvelopes: [
          sqlEnvelope('data:frontend_prequery:current:trace:query:tool'),
          skillEnvelope('data:skill:current:trace:query:tool'),
        ],
        agentResponses: [{ response: { artifactId: 'artifact-response-1' } }],
        conversationSteps: [{ eventId: 'step-1' }],
      },
      result: {
        sessionId: 'session-1',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Uses `data:skill:current:trace:query:tool`.',
        claimSupport,
        claimVerificationResult: verification,
        confidence: 0.8,
        rounds: 4,
        totalDurationMs: 1234,
        quickRun,
      },
      qualityArtifacts: {
        claimSupport,
        claimVerificationResult: verification,
        identityResolutions: [
          {
            version: 'identity_contract@1',
            identityRefId: 'identity-1',
            target: { traceId: 'trace-1', source: 'derived' },
            status: 'verified',
            processes: [],
            threads: [],
            warnings: [],
          },
        ],
      },
      finalArtifacts: {
        reportId: 'report-1',
        reportUrl: '/api/reports/report-1',
        resultSnapshotId: 'snapshot-1',
        generatedAt: 1000,
      },
      runId: 'run-1',
      runtime: 'qoder-agent-sdk',
      generatedAt: 1000,
    });

    expect(receipt).toEqual(expect.objectContaining({
      schemaVersion: 2,
      runManifestId: 'manifest-receipt-1',
      runId: 'run-1',
      sessionId: 'session-1',
      traceId: 'trace-1',
      mode: 'fast',
      resolvedMode: 'quick',
      runtime: 'qoder-agent-sdk',
      providerId: null,
      generatedAt: 1000,
    }));
    expect(receipt.traceEvidence).toEqual({
      sqlCount: 1,
      skillCount: 1,
      dataEnvelopeCount: 2,
      artifactCount: 4,
      evidenceRefCount: 4,
    });
    expect(receipt.nonEvidenceContext).toEqual({
      frontendPrequeryCount: 2,
      memoryHintCount: 5,
      conversationContextCount: 3,
      strategyHintCount: 2,
    });
    expect(receipt.claimAudit).toEqual({
      totalClaims: 2,
      verifiedClaims: 1,
      unsupportedClaims: 1,
      uncertainClaims: 0,
    });
    expect(receipt.qualityGates).toEqual({
      finalReportContract: 'not_applicable',
      claimVerification: 'partial',
      identityResolution: 'passed',
    });
    expect(receipt.outputs).toEqual({
      reportId: 'report-1',
      reportUrl: '/api/reports/report-1',
      resultSnapshotId: 'snapshot-1',
    });
  });

  it('keeps old full-mode payloads valid when optional outputs and verifier are absent', () => {
    const receipt = buildAnalysisReceipt({
      runManifestId: 'manifest-receipt-2',
      session: {
        sessionId: 'session-legacy',
        traceId: 'trace-legacy',
        dataEnvelopes: [],
      },
      result: {
        sessionId: 'session-legacy',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        confidence: 0.7,
        rounds: 2,
        totalDurationMs: 800,
      },
      finalArtifacts: { reportError: 'report failed', generatedAt: 2000 },
    });

    expect(receipt.mode).toBe('auto');
    expect(receipt.resolvedMode).toBe('full');
    expect(receipt.providerId).toBeNull();
    expect(receipt.traceEvidence).toEqual({
      sqlCount: 0,
      skillCount: 0,
      dataEnvelopeCount: 0,
      artifactCount: 0,
      evidenceRefCount: 0,
    });
    expect(receipt.qualityGates).toEqual({
      finalReportContract: 'not_applicable',
      claimVerification: 'not_applicable',
      identityResolution: 'not_applicable',
    });
    expect(receipt.outputs).toEqual({ reportError: 'report failed' });
  });

  it('marks generated reports partial when the final report contract is incomplete', () => {
    const receipt = buildAnalysisReceipt({
      runManifestId: 'manifest-receipt-3',
      session: {
        sessionId: 'session-startup',
        traceId: 'trace-startup',
        query: 'debug cold start first frame',
        analysisMode: 'full',
        dataEnvelopes: [],
      },
      result: {
        sessionId: 'session-startup',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'The launch is slow, but the report omits the required startup sections.',
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'initial_report',
          conclusions: [],
          clusters: [],
          evidenceChain: [],
          uncertainties: [],
          nextSteps: [],
          metadata: { sceneId: 'startup' },
        },
        confidence: 0.6,
        rounds: 3,
        totalDurationMs: 1000,
      },
      finalArtifacts: {
        reportId: 'report-startup',
        reportUrl: '/api/reports/report-startup',
      },
      generatedAt: 3000,
    });

    expect(receipt.mode).toBe('full');
    expect(receipt.resolvedMode).toBe('full');
    expect(receipt.qualityGates.finalReportContract).toBe('partial');
    expect(receipt.outputs.reportId).toBe('report-startup');
  });

  it('uses aggregate claim verifier counts when per-claim results are absent', () => {
    const receipt = buildAnalysisReceipt({
      runManifestId: 'manifest-receipt-4',
      session: {
        sessionId: 'session-aggregate-claims',
        traceId: 'trace-aggregate-claims',
        dataEnvelopes: [],
      },
      result: {
        sessionId: 'session-aggregate-claims',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'ok',
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'passed',
          policy: 'record_only',
          passed: true,
          checkedClaimCount: 4,
          unsupportedClaimCount: 1,
          claimResults: [],
          issues: [],
        },
        confidence: 0.7,
        rounds: 2,
        totalDurationMs: 800,
      },
    });

    expect(receipt.claimAudit).toEqual({
      totalClaims: 4,
      verifiedClaims: 3,
      unsupportedClaims: 1,
      uncertainClaims: 0,
    });
  });
});
