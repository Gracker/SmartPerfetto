// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {EvalCaseV1, EvalScoreV1} from '../../../types/selfEvolution';
import {
  evalPinnedFingerprint,
  evalScoreKey,
  parseEvalCase,
  parseEvalScore,
  semanticEvalCaseFingerprint,
} from '../evalContracts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function evalCase(overrides: Partial<EvalCaseV1> = {}): EvalCaseV1 {
  return {
    schemaVersion: 1,
    caseId: 'case-a',
    evalSetId: 'set-a',
    origin: 'synthetic_seed',
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    traces: [{
      role: 'current',
      catalogAlias: 'startup-lifecycle',
      contentHash: HASH_A,
    }],
    query: 'Analyze startup latency.',
    analysisMode: 'full',
    expectedScene: 'startup',
    goldenPoints: ['Identify the blocking startup slice.'],
    split: 'validation',
    createdAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function score(overrides: Partial<EvalScoreV1> = {}): EvalScoreV1 {
  return {
    schemaVersion: 1,
    caseId: 'case-a',
    evalSetId: 'set-a',
    runId: 'run-a',
    runManifestId: 'manifest-a',
    attempt: 1,
    role: 'baseline',
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    pinned: {
      runtime: 'openai-agents-sdk',
      providerId: 'provider-a',
      model: 'gpt-test',
      outputLanguage: 'zh-CN',
      toolAllowlistHash: HASH_B,
      injections: 'off',
      overlayGeneration: 'builtin:registry-a',
    },
    availability: 'available',
    l0: {
      runOk: true,
      sqlErrorFree: true,
      reportContractPass: true,
      skillCrashFree: true,
    },
    l1: {
      claimVerifiedRatio: 0.75,
      unsupportedClaims: 1,
      evidenceAnchors: 3,
    },
    l3: {
      turns: 4,
      wallclockMs: 1200,
      estimatedTokens: 500,
      toolCalls: 2,
    },
    ...overrides,
  };
}

describe('EvalCase and EvalScore contracts', () => {
  it('accepts one current trace plus an optional reference trace', () => {
    const parsed = parseEvalCase(evalCase({
      traces: [
        {
          role: 'current',
          corpusId: HASH_A,
          contentHash: HASH_A,
        },
        {
          role: 'reference',
          catalogAlias: 'startup-reference',
          contentHash: HASH_B,
        },
      ],
    }));

    expect(parsed.traces).toHaveLength(2);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects unknown fields, unusable trace locators, and duplicate roles', () => {
    expect(() => parseEvalCase({
      ...evalCase(),
      unknown: true,
    })).toThrow('eval_case_unknown_field');
    expect(() => parseEvalCase(evalCase({
      traces: [{role: 'current', contentHash: HASH_A}],
    }))).toThrow('eval_case_trace_locator_required');
    expect(() => parseEvalCase(evalCase({
      traces: [
        {
          role: 'current',
          catalogAlias: 'one',
          contentHash: HASH_A,
        },
        {
          role: 'current',
          catalogAlias: 'two',
          contentHash: HASH_B,
        },
      ],
    }))).toThrow('eval_case_trace_roles_invalid');
  });

  it('separates immutable payload identity from semantic case identity', () => {
    const first = evalCase();
    const semanticallySame = evalCase({
      caseId: 'case-b',
      evalSetId: 'set-b',
      origin: 'manual_golden',
      sourceRunId: 'run-source',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    expect(semanticEvalCaseFingerprint(semanticallySame))
      .toBe(semanticEvalCaseFingerprint(first));

    expect(semanticEvalCaseFingerprint(evalCase({
      label: {
        rating: 'negative',
        dimensions: ['missed_root_cause'],
      },
    }))).not.toBe(semanticEvalCaseFingerprint(first));
  });

  it('strictly validates score metrics and produces deterministic keys', () => {
    const parsed = parseEvalScore(score());
    expect(parsed).toEqual(score());
    expect(evalScoreKey(parsed)).toBe(evalScoreKey(score()));
    expect(evalPinnedFingerprint(parsed.pinned)).toHaveLength(64);

    expect(() => parseEvalScore(score({
      l1: {
        claimVerifiedRatio: 1.1,
        unsupportedClaims: 0,
        evidenceAnchors: 0,
      },
    }))).toThrow('eval_score_l1_claim_ratio_invalid');
    expect(() => parseEvalScore({
      ...score(),
      pinned: {...score().pinned, extra: true},
    })).toThrow('eval_pinned_unknown_field');
  });
});
