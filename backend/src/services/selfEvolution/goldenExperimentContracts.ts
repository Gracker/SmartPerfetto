// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {__testing as evalContractTesting} from './evalContracts';
import {
  normalizeEvaluationBudgetLimits,
  type EvaluationBudgetLimitsV1,
} from './evaluationTelemetry';
import type {GoldenTraceRegistryV1} from './goldenTraceRegistry';

export type GoldenExperimentTier = 'pr' | 'nightly' | 'release';

export interface GoldenExperimentProfileV1 {
  profileId: string;
  pinned: EvalPinnedEnvironmentV1;
  analysisMode: 'fast' | 'full';
  budget: EvaluationBudgetLimitsV1;
}

export interface GoldenExperimentCaseRefV1 {
  caseId: string;
  split: EvalCaseV1['split'];
  caseContentHash: string;
}

export interface GoldenExperimentCellV1 {
  cellId: string;
  caseId: string;
  caseContentHash: string;
  profileId: string | null;
  repeat: number;
  ordinal: number;
  execution: 'deterministic_contract' | 'provider_replay';
}

export interface GoldenExperimentManifestV1 {
  schemaVersion: 1;
  experimentId: string;
  tier: GoldenExperimentTier;
  evalSetId: string;
  registryContentHash: string;
  createdAt: string;
  profiles: GoldenExperimentProfileV1[];
  baselineProfileId: string | null;
  cases: GoldenExperimentCaseRefV1[];
  cells: GoldenExperimentCellV1[];
  policy: {
    concurrency: 1;
    repeats: number;
    order: 'rotating_blocks';
    holdoutExecution: 'redacted';
  };
  contentHash: string;
}

export interface CompileGoldenExperimentManifestInput {
  tier: GoldenExperimentTier;
  registry: GoldenTraceRegistryV1;
  profiles: GoldenExperimentProfileV1[];
  repeats?: number;
  baselineProfileId?: string;
  selectedCaseIds?: string[];
  createdAt: string;
}

function nonempty(value: string, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function positiveInteger(value: number, error: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(error);
  return value;
}

function normalizeProfile(
  profile: GoldenExperimentProfileV1,
): GoldenExperimentProfileV1 {
  if (
    !profile
    || typeof profile !== 'object'
    || Array.isArray(profile)
    || Object.keys(profile).some(key =>
      !['profileId', 'pinned', 'analysisMode', 'budget'].includes(key))
  ) {
    throw new Error('golden_experiment_profile_invalid');
  }
  if (profile.analysisMode !== 'fast' && profile.analysisMode !== 'full') {
    throw new Error('golden_experiment_profile_mode_invalid');
  }
  return {
    profileId: nonempty(
      profile.profileId,
      'golden_experiment_profile_id_invalid',
    ),
    pinned: evalContractTesting.parsePinned(profile.pinned),
    analysisMode: profile.analysisMode,
    budget: normalizeEvaluationBudgetLimits(profile.budget),
  };
}

function eligibleSplit(
  tier: GoldenExperimentTier,
  split: EvalCaseV1['split'],
): boolean {
  if (tier === 'pr') return true;
  if (tier === 'nightly') return split !== 'holdout';
  return split === 'validation' || split === 'holdout';
}

function rotate<T>(values: readonly T[], amount: number): T[] {
  if (values.length === 0) return [];
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function compileGoldenExperimentManifest(
  input: CompileGoldenExperimentManifestInput,
): GoldenExperimentManifestV1 {
  if (!['pr', 'nightly', 'release'].includes(input.tier)) {
    throw new Error('golden_experiment_tier_invalid');
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('golden_experiment_created_at_invalid');
  }
  if (
    input.registry.schemaVersion !== 1
    || !input.registry.evalSetId?.trim()
    || !Array.isArray(input.registry.cases)
    || input.registry.cases.length === 0
  ) {
    throw new Error('golden_experiment_registry_invalid');
  }
  const profiles = input.profiles.map(normalizeProfile);
  if (new Set(profiles.map(item => item.profileId)).size !== profiles.length) {
    throw new Error('golden_experiment_profile_id_duplicate');
  }
  const repeats = input.tier === 'pr'
    ? positiveInteger(input.repeats ?? 1, 'golden_experiment_repeats_invalid')
    : positiveInteger(
      input.repeats ?? 0,
      'golden_experiment_provider_repeats_invalid',
    );
  if (input.tier === 'pr') {
    if (profiles.length > 0 || repeats !== 1) {
      throw new Error('golden_experiment_pr_policy_invalid');
    }
  } else {
    if (repeats < 3 || repeats > 20) {
      throw new Error('golden_experiment_provider_repeats_invalid');
    }
    if (profiles.length === 0) {
      throw new Error('golden_experiment_profiles_required');
    }
  }
  const profileIds = new Set(profiles.map(item => item.profileId));
  const baselineProfileId = input.tier === 'pr'
    ? null
    : input.baselineProfileId ?? profiles[0]?.profileId ?? null;
  if (baselineProfileId !== null && !profileIds.has(baselineProfileId)) {
    throw new Error('golden_experiment_baseline_profile_invalid');
  }

  const selected = input.selectedCaseIds
    ? new Set(input.selectedCaseIds)
    : undefined;
  if (selected && selected.size !== input.selectedCaseIds!.length) {
    throw new Error('golden_experiment_case_id_duplicate');
  }
  const eligibleCases = input.registry.cases
    .filter(item => eligibleSplit(input.tier, item.split))
    .filter(item => !selected || selected.has(item.caseId))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (
    eligibleCases.length === 0
    || (selected && [...selected].some(caseId =>
      !eligibleCases.some(item => item.caseId === caseId)))
  ) {
    throw new Error('golden_experiment_cases_unavailable');
  }
  const cases: GoldenExperimentCaseRefV1[] = eligibleCases.map(item => ({
    caseId: item.caseId,
    split: item.split,
    caseContentHash: canonicalContentHash(item),
  }));
  const registryContentHash = canonicalContentHash(input.registry);
  const cellsWithoutIds: Array<Omit<GoldenExperimentCellV1, 'cellId'>> = [];
  if (input.tier === 'pr') {
    for (const item of cases) {
      cellsWithoutIds.push({
        caseId: item.caseId,
        caseContentHash: item.caseContentHash,
        profileId: null,
        repeat: 1,
        ordinal: cellsWithoutIds.length + 1,
        execution: 'deterministic_contract',
      });
    }
  } else {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const caseBlock = rotate(cases, repeat - 1);
      const profileBlock = rotate(profiles, repeat - 1);
      for (let index = 0; index < caseBlock.length; index += 1) {
        const item = caseBlock[index];
        for (const currentProfile of rotate(profileBlock, index)) {
          cellsWithoutIds.push({
            caseId: item.caseId,
            caseContentHash: item.caseContentHash,
            profileId: currentProfile.profileId,
            repeat,
            ordinal: cellsWithoutIds.length + 1,
            execution: 'provider_replay',
          });
        }
      }
    }
  }
  const cells = cellsWithoutIds.map(cell => ({
    ...cell,
    cellId: canonicalContentHash({
      evalSetId: input.registry.evalSetId,
      tier: input.tier,
      ...cell,
    }),
  }));
  const body = {
    schemaVersion: 1 as const,
    tier: input.tier,
    evalSetId: input.registry.evalSetId,
    registryContentHash,
    createdAt: input.createdAt,
    profiles,
    baselineProfileId,
    cases,
    cells,
    policy: {
      concurrency: 1 as const,
      repeats,
      order: 'rotating_blocks' as const,
      holdoutExecution: 'redacted' as const,
    },
  };
  const experimentId = `gx-${canonicalContentHash(body).slice(0, 32)}`;
  const withoutHash = {...body, experimentId};
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}
