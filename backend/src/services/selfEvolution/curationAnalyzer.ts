// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  canonicalContentHash,
  canonicalJsonString,
} from './canonicalJson';
import {attributeFailure} from './failureAttributor';
import type {
  CurationCandidate,
  CurationDiagnostic,
  CurationEvidenceSummary,
  CurationRunObservation,
  FailureAttributionResult,
} from './curationContracts';

export interface CurationAnalysisResult {
  candidates: CurationCandidate[];
  diagnostics: CurationDiagnostic[];
}

export function analyzeCurationHypotheses(input: {
  observations: readonly CurationRunObservation[];
  minLabeled?: number;
  minNegative?: number;
}): CurationAnalysisResult {
  const minLabeled = input.minLabeled ?? 8;
  const minNegative = input.minNegative ?? 3;
  const observations = [...input.observations].sort(observationOrder);
  const diagnostics: CurationDiagnostic[] = [];
  const negativeCount = observations.filter(
    observation => observation.feedback.rating === 'negative',
  ).length;
  if (
    observations.length < minLabeled ||
    negativeCount < minNegative
  ) {
    return {
      candidates: [],
      diagnostics: [{
        code: 'curation_threshold_not_met',
        details: {
          labeledCount: observations.length,
          negativeCount,
          minLabeled,
          minNegative,
        },
      }],
    };
  }

  const attributed = observations.flatMap(observation => {
    if (observation.feedback.rating !== 'negative') return [];
    const attribution = attributeFailure({
      feedback: observation.feedback,
      manifest: observation.manifest,
    });
    if (attribution.status === 'inconclusive') {
      diagnostics.push({
        code: 'curation_attribution_inconclusive',
        details: {
          feedbackId: observation.feedback.feedbackId,
          reason: attribution.reason,
        },
      });
      return [];
    }
    return [{observation, attribution}];
  });

  const groups = new Map<string, Array<{
    observation: CurationRunObservation;
    attribution: Extract<FailureAttributionResult, {status: 'attributed'}>;
  }>>();
  for (const entry of attributed) {
    const key = canonicalJsonString({
      scope: entry.observation.manifest.scope,
      category: entry.attribution.category,
      skillId: entry.attribution.skillId,
      skillContentFingerprint: entry.attribution.skillContentFingerprint,
      registry: entry.observation.manifest.skillRegistryFingerprint,
      generation: entry.observation.manifest.evolutionOverlayGeneration,
    });
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const candidates: CurationCandidate[] = [];
  for (const [groupKey, group] of [...groups.entries()].sort()) {
    if (group.length < minNegative) continue;
    const first = group[0];
    const compatible = observations.filter(observation =>
      observation.manifest.skillRegistryFingerprint ===
        first.observation.manifest.skillRegistryFingerprint &&
      observation.manifest.evolutionOverlayGeneration ===
        first.observation.manifest.evolutionOverlayGeneration &&
      observation.manifest.skills.some(skill =>
        skill.skillId === first.attribution.skillId &&
        skill.contentFingerprint ===
          first.attribution.skillContentFingerprint));
    if (
      compatible.length < minLabeled ||
      compatible.filter(row => row.feedback.rating === 'negative').length <
        minNegative
    ) {
      continue;
    }
    const evidence = summarizeEvidence(compatible);
    const sourceState = {
      scope: {...first.observation.manifest.scope},
      feedback: compatible.map(row => ({
        feedbackId: row.feedback.feedbackId,
        currentEventId: row.feedback.currentEventId,
        ...(row.feedback.runId ? {runId: row.feedback.runId} : {}),
      })),
      manifestHashes: uniqueSorted(compatible.map(row =>
        canonicalContentHash(row.manifest))),
      traceContentHashes: uniqueSorted(compatible.flatMap(row =>
        row.traceContentHashes)),
      targetIdentity: {
        failureCategory: first.attribution.category,
        skillId: first.attribution.skillId,
        skillContentFingerprint:
          first.attribution.skillContentFingerprint,
      },
      expectedRegistryFingerprint:
        first.observation.manifest.skillRegistryFingerprint,
      expectedOverlayGeneration:
        first.observation.manifest.evolutionOverlayGeneration,
    };
    candidates.push({
      source: 'technical_attribution',
      candidateKey: canonicalContentHash({
        source: 'technical_attribution',
        groupKey,
        evidence,
      }),
      kind: 'skill_note',
      tier: 'T1',
      delta: {
        op: 'add',
        targetKind: 'skill_note',
        targetId: first.attribution.skillId,
        anchor: `skillNotes[skillId=${JSON.stringify(
          first.attribution.skillId,
        )}]`,
        baseContentHash: first.attribution.skillContentFingerprint,
        afterMode: 'generated',
      },
      evidence,
      sourceState,
      promptData: {
        failureCategory: first.attribution.category,
        skillId: first.attribution.skillId,
        mappedDimension: first.attribution.dimension,
        attributedNegativeCount: group.length,
        comments: group.map(entry =>
          entry.observation.feedback.comment ?? null),
      },
    });
  }

  return {
    candidates: candidates.sort((left, right) =>
      left.candidateKey.localeCompare(right.candidateKey)),
    diagnostics,
  };
}

export function summarizeEvidence(
  observations: readonly CurationRunObservation[],
): CurationEvidenceSummary {
  return {
    negativeRunIds: uniqueSorted(observations
      .filter(row => row.feedback.rating === 'negative')
      .map(row => row.manifest.runId)),
    positiveRunIds: uniqueSorted(observations
      .filter(row => row.feedback.rating === 'positive')
      .map(row => row.manifest.runId)),
    labeledCount: observations.length,
    negativeCount: observations.filter(
      row => row.feedback.rating === 'negative',
    ).length,
    distinctTraceCount: new Set(observations.flatMap(
      row => row.traceContentHashes,
    )).size,
    distinctSessionCount: new Set(observations.map(
      row => row.feedback.sessionId,
    )).size,
  };
}

function observationOrder(
  left: CurationRunObservation,
  right: CurationRunObservation,
): number {
  return left.feedback.feedbackId.localeCompare(right.feedback.feedbackId) ||
    left.feedback.currentEventId.localeCompare(right.feedback.currentEventId);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
