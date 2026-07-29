// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  RunInjectionCategory,
  RunInjectionReference,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
} from './canonicalJson';
import {summarizeEvidence} from './curationAnalyzer';
import type {
  CurationCandidate,
  CurationDiagnostic,
  CurationRunObservation,
} from './curationContracts';

type RetirableCategory = 'phaseHints' | 'skillNotes';

interface RetireInjectionTarget extends RunInjectionReference {
  category: RetirableCategory;
}

export interface RetireInjectionAnalysisResult {
  candidates: CurationCandidate[];
  diagnostics: CurationDiagnostic[];
}

const SUPPORTED_TIERS: Readonly<Record<
  RetirableCategory,
  'T0' | 'T1'
>> = {
  phaseHints: 'T0',
  skillNotes: 'T1',
};

export function proposeRetireInjectionHypotheses(
  observations: readonly CurationRunObservation[],
): RetireInjectionAnalysisResult {
  const sorted = [...observations].sort((left, right) =>
    left.feedback.feedbackId.localeCompare(right.feedback.feedbackId));
  const diagnostics: CurationDiagnostic[] = [];
  const unsupported = new Set<RunInjectionCategory>();
  for (const observation of sorted) {
    for (const category of [
      'patterns',
      'cases',
      'knowledgeDocs',
    ] as const) {
      if (observation.manifest.injections[category].length > 0) {
        unsupported.add(category);
      }
    }
  }
  for (const category of [...unsupported].sort()) {
    diagnostics.push({
      code: 'retire_category_unsupported',
      details: {category},
    });
  }

  const targets = uniqueTargets(sorted.flatMap(observation =>
    (['phaseHints', 'skillNotes'] as const).flatMap(category =>
      observation.manifest.injections[category].map(ref => ({
        category,
        ...ref,
      })))));
  const candidates: CurationCandidate[] = [];
  for (const target of targets) {
    const cohorts = new Map<string, {
      negative: Array<{
        observation: CurationRunObservation;
        exposed: boolean;
      }>;
      positive: Array<{
        observation: CurationRunObservation;
        exposed: boolean;
      }>;
    }>();
    for (const observation of sorted) {
      const hasTarget = containsTarget(observation, target);
      const key = retirementCohortKey(observation, target);
      const cohort = cohorts.get(key) ?? {
        negative: [],
        positive: [],
      };
      if (observation.feedback.rating === 'negative') {
        cohort.negative.push({observation, exposed: hasTarget});
      } else {
        cohort.positive.push({observation, exposed: hasTarget});
      }
      cohorts.set(key, cohort);
    }
    for (const [cohortKey, cohort] of [...cohorts.entries()].sort()) {
      const exposedNegative = cohort.negative.filter(row => row.exposed);
      const unexposedPositive = cohort.positive.filter(row => !row.exposed);
      const negativeExposureRate = cohort.negative.length > 0
        ? exposedNegative.length / cohort.negative.length
        : 0;
      const positiveExposureRate = cohort.positive.length > 0
        ? (cohort.positive.length - unexposedPositive.length) /
          cohort.positive.length
        : 0;
      if (
        exposedNegative.length < 3 ||
        unexposedPositive.length < 1 ||
        cohort.negative.length + cohort.positive.length < 8 ||
        negativeExposureRate <= positiveExposureRate
      ) {
        continue;
      }
      const evidenceRows = [
        ...cohort.negative.map(row => row.observation),
        ...cohort.positive.map(row => row.observation),
      ];
      const evidence = summarizeEvidence(evidenceRows);
      const first = exposedNegative[0].observation;
      const sourceState = {
        scope: {...first.manifest.scope},
        feedback: evidenceRows.map(row => ({
          feedbackId: row.feedback.feedbackId,
          currentEventId: row.feedback.currentEventId,
          ...(row.feedback.runId ? {runId: row.feedback.runId} : {}),
        })),
        manifestHashes: uniqueSorted(evidenceRows.map(row =>
          canonicalContentHash(row.manifest))),
        traceContentHashes: uniqueSorted(evidenceRows.flatMap(row =>
          row.traceContentHashes)),
        targetIdentity: {
          category: target.category,
          id: target.id,
          contentHash: target.contentHash,
        },
        expectedRegistryFingerprint:
          first.manifest.skillRegistryFingerprint,
        expectedOverlayGeneration:
          first.manifest.evolutionOverlayGeneration,
      };
      candidates.push({
        source: 'retire_injection',
        candidateKey: canonicalContentHash({
          source: 'retire_injection',
          target,
          cohortKey,
          evidence,
        }),
        kind: 'retire_injection',
        tier: SUPPORTED_TIERS[target.category],
        delta: {
          op: 'remove',
          targetKind: 'injection',
          targetId: target.id,
          anchor: `injections.${target.category}[id=${JSON.stringify(
            target.id,
          )}]`,
          baseContentHash: target.contentHash,
          afterMode: 'none',
        },
        evidence,
        sourceState,
        promptData: {
          target: {
            category: target.category,
            id: target.id,
            contentHash: target.contentHash,
          },
          negativeExposedCount: exposedNegative.length,
          positiveUnexposedCount: unexposedPositive.length,
          negativeExposureRate,
          positiveExposureRate,
        },
      });
    }
  }
  if (candidates.length === 0) {
    diagnostics.push({code: 'retire_cohort_inconclusive'});
  }
  return {
    candidates: candidates.sort((left, right) =>
      left.candidateKey.localeCompare(right.candidateKey)),
    diagnostics,
  };
}

function retirementCohortKey(
  observation: CurationRunObservation,
  target: RetireInjectionTarget,
): string {
  const {manifest} = observation;
  const injections = (Object.keys(manifest.injections) as RunInjectionCategory[])
    .flatMap(category => manifest.injections[category].map(ref => ({
      category,
      ...ref,
    })))
    .filter(ref =>
      ref.category !== target.category ||
      ref.id !== target.id ||
      ref.contentHash !== target.contentHash)
    .sort((left, right) =>
      left.category.localeCompare(right.category) ||
      left.id.localeCompare(right.id) ||
      left.contentHash.localeCompare(right.contentHash));
  return canonicalJsonString({
    scope: manifest.scope,
    traceContentHashes: [...observation.traceContentHashes].sort(),
    sceneType: manifest.sceneType,
    architecture: manifest.architecture ?? null,
    analysisMode: manifest.analysisMode,
    resolvedMode: manifest.resolvedMode,
    runtime: manifest.runtime,
    providerId: manifest.providerId,
    model: manifest.model ?? null,
    outputLanguage: manifest.outputLanguage,
    toolAllowlistHash: manifest.toolAllowlistHash,
    skillRegistryFingerprint: manifest.skillRegistryFingerprint,
    evolutionOverlayGeneration: manifest.evolutionOverlayGeneration,
    otherInjections: injections,
  });
}

function containsTarget(
  observation: CurationRunObservation,
  target: RetireInjectionTarget,
): boolean {
  return observation.manifest.injections[target.category].some(ref =>
    ref.id === target.id && ref.contentHash === target.contentHash);
}

function uniqueTargets(
  targets: readonly RetireInjectionTarget[],
): RetireInjectionTarget[] {
  const byKey = new Map<string, RetireInjectionTarget>();
  for (const target of targets) {
    byKey.set(
      `${target.category}\0${target.id}\0${target.contentHash}`,
      target,
    );
  }
  return [...byKey.values()].sort((left, right) =>
    left.category.localeCompare(right.category) ||
    left.id.localeCompare(right.id) ||
    left.contentHash.localeCompare(right.contentHash));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
