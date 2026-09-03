// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type { CaseCandidate } from '../../../types/caseEvolution';
import {
  buildCaseCandidateReviewPrompt,
  __testing,
} from '../caseCandidateReviewAgentSdk';

function candidate(): CaseCandidate {
  return {
    candidateId: 'cand-sdk-1',
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

describe('caseCandidateReviewAgentSdk prompt rendering', () => {
  it('loads the strategy template and renders candidate JSON plus allowed enums', () => {
    const prompt = buildCaseCandidateReviewPrompt(candidate());

    expect(prompt).toContain('"candidateId": "cand-sdk-1"');
    expect(prompt).toContain('promote | reject | needs_more_evidence');
    expect(prompt).toContain('similar_root_cause | derived_pattern');
    for (const reasonCode of [
      'prediction_error',
      'display_hal',
      'app_jank_unattributed',
      'lock_contention',
      'render_sync_wait',
    ]) {
      expect(prompt).toContain(reasonCode);
    }
    expect(prompt).not.toContain('{{candidate_json}}');
    expect(prompt).not.toContain('```');
  });

  it('throws a controlled setup error when the template is missing', () => {
    expect(() => buildCaseCandidateReviewPrompt(candidate(), {
      loadTemplate: () => undefined,
    })).toThrow(/case-candidate-review prompt template not found/);
  });
});

describe('caseCandidateReviewAgentSdk JSON extraction', () => {
  const {extractJsonObject} = __testing;

  it('parses a clean JSON object', () => {
    expect(extractJsonObject('{"decision":"promote"}')).toEqual({decision: 'promote'});
  });

  it('extracts the first balanced JSON object from accidental prose', () => {
    expect(extractJsonObject('prose {"a":{"b":1}} trailing {"c":2}')).toEqual({a: {b: 1}});
  });

  it('returns null for arrays and malformed objects', () => {
    expect(extractJsonObject('[1,2,3]')).toBeNull();
    expect(extractJsonObject('here {not really: json}')).toBeNull();
  });
});

describe('caseCandidateReviewAgentSdk constants', () => {
  it('keeps the review worker trust boundary limits', () => {
    expect(__testing.DEFAULT_TIMEOUT_MS).toBe(90_000);
    expect(__testing.MAX_TURNS).toBe(8);
    expect(__testing.DEFAULT_MODEL).toBe('claude-haiku-4-5');
  });
});
