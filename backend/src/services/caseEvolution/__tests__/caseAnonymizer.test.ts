// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import type { CaseCandidate, CaseCandidateReview } from '../../../types/caseEvolution';
import { anonymizeCaseEvolutionInput } from '../caseAnonymizer';
import { bucketPackageDomain } from '../domainBucket';

function candidate(overrides: Partial<CaseCandidate> = {}): CaseCandidate {
  return {
    candidateId: 'cand-anon-1',
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
      percentage: 20,
      evidenceSignatures: {
        reason_code: 'shader_compile',
        process_name: 'com.tencent.mm',
        path: '/data/data/com.tencent.mm/cache/frame.dump',
      },
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
    ...overrides,
  };
}

function review(overrides: Partial<CaseCandidateReview> = {}): CaseCandidateReview {
  return {
    schemaVersion: 'case_candidate_review@1',
    candidateId: 'cand-anon-1',
    decision: 'promote',
    confidence: 'high',
    proposed: {
      title: 'Shader compile jank',
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
      relations: {},
    },
    evidenceSummary: 'Process com.tencent.mm hit /data/data/com.tencent.mm/cache/file',
    risks: [],
    ...overrides,
  };
}

describe('caseAnonymizer', () => {
  it('extracts the shared package-domain bucket deterministically', () => {
    expect(bucketPackageDomain('com.tencent.mm')).toBe('tencent');
    expect(bucketPackageDomain('com.google.android.apps.nexuslauncher')).toBe('google');
    expect(bucketPackageDomain('')).toBe('unknown');
  });

  it('keeps an own __proto__ key as anonymized data instead of a prototype', () => {
    const base = candidate();
    const withProto = {
      ...base,
      cluster: {...base.cluster, ...JSON.parse('{"__proto__":{"note":"seen in com.example.demo.app"}}')},
    };
    const result = anonymizeCaseEvolutionInput(withProto, review());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(Object.getPrototypeOf(result.candidate.cluster)).toBe(Object.prototype);
    const kept = Object.getOwnPropertyDescriptor(result.candidate.cluster, '__proto__')?.value;
    expect(kept).toEqual({note: expect.not.stringContaining('com.example.demo.app')});
  });

  it('replaces package names and app data paths before ingest', () => {
    const result = anonymizeCaseEvolutionInput(candidate(), review());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join(', '));
    expect(result.candidate.cluster.evidenceSignatures.process_name).toBe('tencent');
    expect(result.candidate.cluster.evidenceSignatures.path).toBe('<app_data_dir>/cache/frame.dump');
    expect(result.review.evidenceSummary).toContain('<app_data_dir>');
    expect(result.review.evidenceSummary).not.toContain('com.tencent.mm');
  });

  it('fails closed when required review text contains PII', () => {
    const result = anonymizeCaseEvolutionInput(candidate(), review({
      proposed: {
        ...review().proposed,
        title: 'Contact user alice@example.com for shader compile jank',
      },
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected anonymizer rejection');
    expect(result.errors.join('\n')).toMatch(/PII/i);
  });

  it('is deterministic for the same input', () => {
    expect(anonymizeCaseEvolutionInput(candidate(), review())).toEqual(
      anonymizeCaseEvolutionInput(candidate(), review()),
    );
  });
});
