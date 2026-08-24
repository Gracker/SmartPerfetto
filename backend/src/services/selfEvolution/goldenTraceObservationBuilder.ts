// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ClaimSupportV1, EvidenceCellV1} from '../../types/evidenceContract';
import type {
  EvalCaseV1,
  EvalScalar,
  RunManifestV1,
} from '../../types/selfEvolution';
import {
  parseGoldenTraceObservation,
  type GoldenTraceObservationV1,
} from './goldenTraceScorer';

interface CandidateValue {
  value: EvalScalar;
  unit?: string;
  evidenceIds: string[];
}

function scalar(value: unknown): EvalScalar | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedUnit(column: string, unit: string | undefined): string | undefined {
  if (unit?.trim()) return unit;
  const key = column.toLowerCase();
  if (key.endsWith('_ns') || key === 'dur' || key === 'dur_str') return 'ns';
  if (key.endsWith('_us')) return 'us';
  if (key.endsWith('_ms')) return 'ms';
  if (key.endsWith('_kb')) return 'KiB';
  if (key.includes('bytes')) return 'bytes';
  if (key.includes('count')) return 'count';
  return undefined;
}

function fieldAliases(field: string): Set<string> {
  const aliases = new Set([field.toLowerCase()]);
  if (field === 'duration_ns') {
    aliases.add('dur');
    aliases.add('dur_ns');
    aliases.add('dur_str');
    aliases.add('duration');
  }
  if (field === 'process_name') {
    aliases.add('process');
    aliases.add('process_name');
  }
  if (field === 'thread_name') {
    aliases.add('thread');
    aliases.add('thread_name');
  }
  return aliases;
}

function candidateKey(candidate: CandidateValue): string {
  return JSON.stringify([candidate.value, candidate.unit ?? null]);
}

function uniqueCandidate(
  values: readonly CandidateValue[],
): CandidateValue | undefined {
  const byValue = new Map<string, CandidateValue>();
  for (const value of values) {
    const key = candidateKey(value);
    const existing = byValue.get(key);
    byValue.set(key, existing
      ? {
          ...existing,
          evidenceIds: [...new Set([
            ...existing.evidenceIds,
            ...value.evidenceIds,
          ])],
        }
      : value);
  }
  return byValue.size === 1 ? [...byValue.values()][0] : undefined;
}

function cellCandidate(
  cell: EvidenceCellV1,
  evidenceRefId: string,
): CandidateValue | undefined {
  const value = scalar(cell.actualValue ?? cell.value);
  if (value === undefined) return undefined;
  const unit = normalizedUnit(cell.column, cell.unit);
  return {
    value,
    ...(unit ? {unit} : {}),
    evidenceIds: [evidenceRefId],
  };
}

function collectCandidates(claimSupport: readonly ClaimSupportV1[]): {
  byColumn: Map<string, CandidateValue[]>;
  evidenceRefs: Set<string>;
} {
  const byColumn = new Map<string, CandidateValue[]>();
  const evidenceRefs = new Set<string>();
  const add = (column: string, candidate: CandidateValue) => {
    const key = column.toLowerCase();
    byColumn.set(key, [...(byColumn.get(key) ?? []), candidate]);
  };
  for (const claim of claimSupport) {
    if (claim.supportLevel !== 'verified') continue;
    for (const anchor of [...claim.anchors, ...(claim.relationAnchors ?? [])]) {
      evidenceRefs.add(anchor.evidenceRefId);
      for (const cell of anchor.cells ?? []) {
        const candidate = cellCandidate(cell, anchor.evidenceRefId);
        if (candidate) add(cell.column, candidate);
      }
      const identity = anchor.identity;
      if (identity?.processName) {
        add('process_name', {
          value: identity.processName,
          evidenceIds: [anchor.evidenceRefId],
        });
      }
      if (identity?.threadName) {
        add('thread_name', {
          value: identity.threadName,
          evidenceIds: [anchor.evidenceRefId],
        });
      }
      if (identity?.packageName) {
        add('package_name', {
          value: identity.packageName,
          evidenceIds: [anchor.evidenceRefId],
        });
      }
    }
  }
  return {byColumn, evidenceRefs};
}

function candidatesFor(
  byColumn: Map<string, CandidateValue[]>,
  observationKey: string,
): CandidateValue[] {
  const field = observationKey.split('.').pop() ?? observationKey;
  return [...fieldAliases(field)].flatMap(alias => byColumn.get(alias) ?? []);
}

function coverageObserved(
  expectationId: string,
  manifest: RunManifestV1,
): boolean {
  const invoked = new Set(manifest.skills
    .filter(skill => skill.invocations > 0 && skill.okCount > 0)
    .map(skill => skill.skillId));
  const skillPrefix = expectationId.startsWith('execute-')
    ? 'execute-'
    : expectationId.startsWith('definition-')
      ? 'definition-'
      : undefined;
  if (skillPrefix && invoked.has(expectationId.slice(skillPrefix.length))) {
    return true;
  }
  if (expectationId.startsWith('strategy-')) {
    const strategy = expectationId.slice('strategy-'.length);
    return manifest.strategyId === strategy || manifest.sceneType === strategy;
  }
  return false;
}

/**
 * Builds the authoritative golden observation only from structured, verified
 * analysis evidence and the sealed run manifest. It never scrapes numbers from
 * prose and never copies expected oracle values into the observation.
 */
export function buildGoldenTraceObservationFromAnalysis(input: {
  evalCase: EvalCaseV1;
  runManifest: RunManifestV1;
  claimSupport: readonly ClaimSupportV1[];
}): GoldenTraceObservationV1 | undefined {
  const groundTruth = input.evalCase.groundTruth;
  if (!groundTruth) return undefined;
  const {byColumn, evidenceRefs} = collectCandidates(input.claimSupport);
  const facts: GoldenTraceObservationV1['facts'] = {};
  const identities: GoldenTraceObservationV1['identities'] = {};

  for (const fact of groundTruth.requiredFacts) {
    if (fact.evaluation !== 'deterministic' || !fact.observationKey) continue;
    const candidate = uniqueCandidate(candidatesFor(byColumn, fact.observationKey));
    if (candidate) facts[fact.observationKey] = candidate;
  }
  for (const expectation of groundTruth.numericExpectations) {
    const candidates = candidatesFor(byColumn, expectation.observationKey)
      .flatMap(candidate => {
        const value = numeric(candidate.value);
        return value === undefined ? [] : [{...candidate, value}];
      });
    const candidate = uniqueCandidate(candidates);
    if (candidate) facts[expectation.observationKey] = candidate;
  }
  for (const expectation of groundTruth.identityExpectations) {
    const candidate = uniqueCandidate(candidatesFor(
      byColumn,
      expectation.observationKey,
    ));
    if (candidate) identities[expectation.observationKey] = candidate.value;
  }

  const evidence = groundTruth.requiredEvidence.flatMap(expectation =>
    evidenceRefs.has(expectation.locator)
      || (
        expectation.kind === 'coverage_expectation'
        && coverageObserved(
          expectation.id,
          input.runManifest,
        )
      )
      ? [expectation.locator]
      : []);
  const claims = input.claimSupport.map(claim => ({
    text: claim.text,
    supportLevel: claim.supportLevel,
  }));
  const causalEdges = input.claimSupport.flatMap(claim =>
    (claim.relations ?? []).flatMap(relation =>
      relation.verificationStatus === 'verified'
        ? [{
            subject: relation.subjectAnchorId,
            relation: relation.kind,
            object: relation.objectAnchorId ?? relation.subjectAnchorId,
            level: relation.supportLevel === 'verified'
              ? 'mechanism' as const
              : 'correlation' as const,
            verified: true,
          }]
        : []));
  return parseGoldenTraceObservation({
    schemaVersion: 1,
    facts,
    evidence,
    claims,
    gaps: [],
    identities,
    causalEdges,
  });
}
