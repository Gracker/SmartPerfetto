// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {EvalScoreV1} from '../../types/selfEvolution';
import {canonicalContentHash, canonicalJsonString} from './canonicalJson';

export interface EvalParetoTolerances {
  claimVerifiedRatio: number;
  unsupportedClaims: number;
  evidenceAnchors: number;
  turns: number;
  estimatedTokens: number;
  toolCalls: number;
  wallclockMs: number;
}

export interface EvalReplayTolerancePresetV1 {
  schemaVersion: 1;
  presetId: string;
  tolerances: EvalParetoTolerances;
  contentHash: string;
}

export type EvalParetoResult =
  | {
      status: 'comparable';
      relation:
        | 'candidate_dominates'
        | 'baseline_dominates'
        | 'equivalent'
        | 'tradeoff';
      improved: string[];
      regressed: string[];
    }
  | {
      status: 'inconclusive';
      reason: string;
    };

const DEFAULT_TOLERANCES: EvalParetoTolerances = {
  claimVerifiedRatio: 0,
  unsupportedClaims: 0,
  evidenceAnchors: 0,
  turns: 0,
  estimatedTokens: 0,
  toolCalls: 0,
  wallclockMs: 0,
};

const FRESH_LLM_TOLERANCES_V1: EvalParetoTolerances = {
  claimVerifiedRatio: 0.02,
  unsupportedClaims: 0,
  evidenceAnchors: 0,
  turns: 1,
  estimatedTokens: 256,
  toolCalls: 1,
  wallclockMs: 2_000,
};

export const FRESH_LLM_TOLERANCE_PRESET_V1:
EvalReplayTolerancePresetV1 = Object.freeze({
  schemaVersion: 1,
  presetId: 'fresh-llm-v1',
  tolerances: Object.freeze({...FRESH_LLM_TOLERANCES_V1}),
  contentHash: canonicalContentHash({
    schemaVersion: 1,
    presetId: 'fresh-llm-v1',
    tolerances: FRESH_LLM_TOLERANCES_V1,
  }),
});

export function normalizeEvalReplayTolerancePreset(
  value: EvalReplayTolerancePresetV1,
): EvalReplayTolerancePresetV1 {
  const tolerances = {...value.tolerances};
  const withoutHash = {
    schemaVersion: 1 as const,
    presetId: value.presetId,
    tolerances,
  };
  if (
    value.schemaVersion !== 1
    || !value.presetId?.trim()
    || Object.keys(tolerances).length
      !== Object.keys(DEFAULT_TOLERANCES).length
    || Object.keys(DEFAULT_TOLERANCES).some(
      key => !(key in tolerances),
    )
    || Object.values(tolerances).some(
      amount => !Number.isFinite(amount) || amount < 0,
    )
    || value.contentHash !== canonicalContentHash(withoutHash)
  ) {
    throw new Error('eval_replay_tolerance_preset_invalid');
  }
  return Object.freeze({
    ...withoutHash,
    tolerances: Object.freeze(tolerances),
    contentHash: value.contentHash,
  });
}

function l0Passed(score: EvalScoreV1): boolean {
  return Object.values(score.l0).every(Boolean)
    && (score.golden?.passed ?? true);
}

function compareHigher(
  name: string,
  baseline: number,
  candidate: number,
  tolerance: number,
  improved: string[],
  regressed: string[],
): void {
  if (candidate > baseline + tolerance) improved.push(name);
  if (candidate < baseline - tolerance) regressed.push(name);
}

function compareLower(
  name: string,
  baseline: number,
  candidate: number,
  tolerance: number,
  improved: string[],
  regressed: string[],
): void {
  if (candidate < baseline - tolerance) improved.push(name);
  if (candidate > baseline + tolerance) regressed.push(name);
}

export function paretoCompareEvalScores(input: {
  baseline?: EvalScoreV1;
  candidate?: EvalScoreV1;
  tolerances?: Partial<EvalParetoTolerances>;
}): EvalParetoResult {
  if (!input.baseline || !input.candidate) {
    return {status: 'inconclusive', reason: 'score_unavailable'};
  }
  if (
    input.baseline.availability !== 'available'
    || input.candidate.availability !== 'available'
  ) {
    return {status: 'inconclusive', reason: 'score_unavailable'};
  }
  if (
    input.baseline.caseId !== input.candidate.caseId
    || input.baseline.evalSetId !== input.candidate.evalSetId
    || canonicalJsonString(input.baseline.pinned)
      !== canonicalJsonString(input.candidate.pinned)
  ) {
    return {status: 'inconclusive', reason: 'score_case_mismatch'};
  }
  if ((input.baseline.golden === undefined) !== (input.candidate.golden === undefined)) {
    return {status: 'inconclusive', reason: 'golden_score_mismatch'};
  }
  const baselineL0 = l0Passed(input.baseline);
  const candidateL0 = l0Passed(input.candidate);
  if (baselineL0 && !candidateL0) {
    return {
      status: 'comparable',
      relation: 'baseline_dominates',
      improved: [],
      regressed: ['l0'],
    };
  }
  if (!baselineL0 && candidateL0) {
    return {
      status: 'comparable',
      relation: 'candidate_dominates',
      improved: ['l0'],
      regressed: [],
    };
  }
  if (!baselineL0 && !candidateL0) {
    return {status: 'inconclusive', reason: 'l0_baseline_not_passed'};
  }
  const tolerance = {...DEFAULT_TOLERANCES, ...input.tolerances};
  if (Object.values(tolerance).some(value =>
    !Number.isFinite(value) || value < 0)) {
    return {status: 'inconclusive', reason: 'pareto_tolerance_invalid'};
  }
  const improved: string[] = [];
  const regressed: string[] = [];
  compareHigher(
    'l1.claimVerifiedRatio',
    input.baseline.l1.claimVerifiedRatio,
    input.candidate.l1.claimVerifiedRatio,
    tolerance.claimVerifiedRatio,
    improved,
    regressed,
  );
  compareLower(
    'l1.unsupportedClaims',
    input.baseline.l1.unsupportedClaims,
    input.candidate.l1.unsupportedClaims,
    tolerance.unsupportedClaims,
    improved,
    regressed,
  );
  compareHigher(
    'l1.evidenceAnchors',
    input.baseline.l1.evidenceAnchors,
    input.candidate.l1.evidenceAnchors,
    tolerance.evidenceAnchors,
    improved,
    regressed,
  );
  compareLower(
    'l3.turns',
    input.baseline.l3.turns,
    input.candidate.l3.turns,
    tolerance.turns,
    improved,
    regressed,
  );
  if (
    input.baseline.l3.estimatedTokens === undefined
    || input.candidate.l3.estimatedTokens === undefined
  ) {
    return {status: 'inconclusive', reason: 'token_usage_unavailable'};
  }
  compareLower(
    'l3.estimatedTokens',
    input.baseline.l3.estimatedTokens,
    input.candidate.l3.estimatedTokens,
    tolerance.estimatedTokens,
    improved,
    regressed,
  );
  compareLower(
    'l3.toolCalls',
    input.baseline.l3.toolCalls,
    input.candidate.l3.toolCalls,
    tolerance.toolCalls,
    improved,
    regressed,
  );
  compareLower(
    'l3.wallclockMs',
    input.baseline.l3.wallclockMs,
    input.candidate.l3.wallclockMs,
    tolerance.wallclockMs,
    improved,
    regressed,
  );
  const relation = improved.length === 0 && regressed.length === 0
    ? 'equivalent'
    : regressed.length === 0
      ? 'candidate_dominates'
      : improved.length === 0
        ? 'baseline_dominates'
        : 'tradeoff';
  return {status: 'comparable', relation, improved, regressed};
}
