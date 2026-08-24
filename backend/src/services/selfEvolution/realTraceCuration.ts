// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {EvalCaseV1} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OEM_CLASSES = new Set([
  'aosp',
  'google',
  'samsung',
  'xiaomi',
  'oppo',
  'vivo',
  'honor',
  'oneplus',
  'motorola',
  'other',
]);
const DEVICE_CLASSES = new Set([
  'entry',
  'midrange',
  'flagship',
  'tablet',
  'foldable',
  'tv',
  'automotive',
  'wear',
  'other',
]);
const REFRESH_RATE_BUCKETS = new Set([30, 60, 90, 120, 144, 165, 240]);

export interface RealTraceCandidateV1 {
  schemaVersion: 1;
  traceContentHash: string;
  source:
    | 'profiling_manager'
    | 'macrobenchmark'
    | 'vitals_outlier'
    | 'maintainer_capture';
  scene: string;
  platform: {
    androidApiLevel: number;
    androidRelease?: string;
    oemClass: string;
    deviceClass: string;
    refreshRateBucketHz: number;
  };
  governance: {
    license: string;
    licenseReview: 'approved' | 'rejected' | 'unknown';
    consent: 'approved' | 'rejected' | 'unknown';
    privacyReview: 'approved' | 'rejected' | 'unknown';
    sanitizationReview: 'approved' | 'rejected' | 'unknown';
    publication: 'public' | 'private_evaluation';
  };
  metric: {
    name: string;
    value: number;
    unit: string;
    worseDirection: 'higher' | 'lower';
  };
  capturedAt: string;
  importedAt: string;
  reviews: Array<{
    reviewerId: string;
    attestationContentHash: string;
  }>;
  groundTruthContentHash?: string;
}

export interface RealTraceSplitLedgerV1 {
  schemaVersion: 1;
  evalSetId: string;
  assignments: Record<string, EvalCaseV1['split']>;
}

export interface RealTraceCohortSummaryV1 {
  cohortKey: string;
  sampleCount: number;
  metricName: string;
  unit: string;
  worseDirection: 'higher' | 'lower';
  p50: number;
  p90: number;
  p99: number;
  worseP90Threshold: number;
  worseP99Threshold: number;
  p99Status: 'qualified' | 'provisional';
  qualification: 'qualified' | 'insufficient_cohort';
}

export interface RealTraceCurationDecisionV1 {
  traceContentHash: string;
  cohortKey: string;
  split?: EvalCaseV1['split'];
  status:
    | 'eligible_for_manual_golden'
    | 'qualified_shadow'
    | 'shadow_insufficient_cohort'
    | 'rejected';
  reason:
    | 'reviewed_p90_outlier'
    | 'p90_outlier_missing_review'
    | 'within_cohort'
    | 'insufficient_cohort'
    | 'privacy_contract_failed';
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  error: string,
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some(key => !keys.has(key))) throw new Error(error);
}

function nonempty(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function finite(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(error);
  }
  return value;
}

function positive(value: unknown, error: string): number {
  const parsed = finite(value, error);
  if (parsed <= 0) throw new Error(error);
  return parsed;
}

function timestamp(value: unknown, error: string): string {
  const parsed = nonempty(value, error);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(error);
  return parsed;
}

function parseCandidate(value: unknown): RealTraceCandidateV1 {
  const candidate = record(value, 'real_trace_candidate_invalid');
  exactKeys(candidate, [
    'schemaVersion',
    'traceContentHash',
    'source',
    'scene',
    'platform',
    'governance',
    'metric',
    'capturedAt',
    'importedAt',
    'reviews',
    'groundTruthContentHash',
  ], 'real_trace_candidate_unknown_field');
  if (candidate.schemaVersion !== 1) {
    throw new Error('real_trace_candidate_schema_invalid');
  }
  const traceContentHash = nonempty(
    candidate.traceContentHash,
    'real_trace_candidate_hash_invalid',
  );
  if (!SHA256_PATTERN.test(traceContentHash)) {
    throw new Error('real_trace_candidate_hash_invalid');
  }
  if (![
    'profiling_manager',
    'macrobenchmark',
    'vitals_outlier',
    'maintainer_capture',
  ].includes(String(candidate.source))) {
    throw new Error('real_trace_candidate_source_invalid');
  }
  const platform = record(candidate.platform, 'real_trace_platform_invalid');
  exactKeys(platform, [
    'androidApiLevel',
    'androidRelease',
    'oemClass',
    'deviceClass',
    'refreshRateBucketHz',
  ], 'real_trace_platform_unknown_field');
  if (
    !Number.isSafeInteger(platform.androidApiLevel)
    || (platform.androidApiLevel as number) < 1
  ) {
    throw new Error('real_trace_android_api_invalid');
  }
  if (
    !OEM_CLASSES.has(String(platform.oemClass))
    || !DEVICE_CLASSES.has(String(platform.deviceClass))
    || !REFRESH_RATE_BUCKETS.has(Number(platform.refreshRateBucketHz))
  ) {
    throw new Error('real_trace_platform_bucket_invalid');
  }
  const governance = record(
    candidate.governance,
    'real_trace_governance_invalid',
  );
  exactKeys(governance, [
    'license',
    'licenseReview',
    'consent',
    'privacyReview',
    'sanitizationReview',
    'publication',
  ], 'real_trace_governance_unknown_field');
  const reviewState = (state: unknown) =>
    state === 'approved' || state === 'rejected' || state === 'unknown';
  if (
    !reviewState(governance.licenseReview)
    || !reviewState(governance.consent)
    || !reviewState(governance.privacyReview)
    || !reviewState(governance.sanitizationReview)
    || !['public', 'private_evaluation'].includes(String(governance.publication))
  ) {
    throw new Error('real_trace_governance_state_invalid');
  }
  const metric = record(candidate.metric, 'real_trace_metric_invalid');
  exactKeys(
    metric,
    ['name', 'value', 'unit', 'worseDirection'],
    'real_trace_metric_unknown_field',
  );
  if (metric.worseDirection !== 'higher' && metric.worseDirection !== 'lower') {
    throw new Error('real_trace_metric_direction_invalid');
  }
  if (!Array.isArray(candidate.reviews)) {
    throw new Error('real_trace_reviews_invalid');
  }
  const reviews = candidate.reviews.map(rawReview => {
    const review = record(rawReview, 'real_trace_review_invalid');
    exactKeys(
      review,
      ['reviewerId', 'attestationContentHash'],
      'real_trace_review_unknown_field',
    );
    const attestationContentHash = nonempty(
      review.attestationContentHash,
      'real_trace_review_attestation_hash_invalid',
    );
    if (!SHA256_PATTERN.test(attestationContentHash)) {
      throw new Error('real_trace_review_attestation_hash_invalid');
    }
    return {
      reviewerId: nonempty(
        review.reviewerId,
        'real_trace_reviewer_id_invalid',
      ),
      attestationContentHash,
    };
  });
  if (new Set(reviews.map(item => item.reviewerId)).size !== reviews.length) {
    throw new Error('real_trace_reviewer_id_duplicate');
  }
  const groundTruthContentHash = candidate.groundTruthContentHash === undefined
    ? undefined
    : nonempty(
      candidate.groundTruthContentHash,
      'real_trace_ground_truth_hash_invalid',
    );
  if (groundTruthContentHash && !SHA256_PATTERN.test(groundTruthContentHash)) {
    throw new Error('real_trace_ground_truth_hash_invalid');
  }
  const scene = nonempty(candidate.scene, 'real_trace_scene_invalid');
  const metricName = nonempty(metric.name, 'real_trace_metric_name_invalid');
  const metricUnit = nonempty(metric.unit, 'real_trace_metric_unit_invalid');
  if (
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(scene)
    || !/^[a-z][a-z0-9_.-]{0,63}$/.test(metricName)
    || !/^[A-Za-z%][A-Za-z0-9%/_.-]{0,31}$/.test(metricUnit)
  ) {
    throw new Error('real_trace_public_dimension_invalid');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    traceContentHash,
    source: candidate.source as RealTraceCandidateV1['source'],
    scene,
    platform: {
      androidApiLevel: platform.androidApiLevel as number,
      ...(platform.androidRelease === undefined
        ? {}
        : {
            androidRelease: nonempty(
              platform.androidRelease,
              'real_trace_android_release_invalid',
            ),
          }),
      oemClass: nonempty(platform.oemClass, 'real_trace_oem_class_invalid'),
      deviceClass: nonempty(
        platform.deviceClass,
        'real_trace_device_class_invalid',
      ),
      refreshRateBucketHz: positive(
        platform.refreshRateBucketHz,
        'real_trace_refresh_rate_invalid',
      ),
    },
    governance: {
      license: nonempty(governance.license, 'real_trace_license_invalid'),
      licenseReview: governance.licenseReview as RealTraceCandidateV1[
        'governance'
      ]['licenseReview'],
      consent: governance.consent as RealTraceCandidateV1[
        'governance'
      ]['consent'],
      privacyReview: governance.privacyReview as RealTraceCandidateV1[
        'governance'
      ]['privacyReview'],
      sanitizationReview: governance.sanitizationReview as RealTraceCandidateV1[
        'governance'
      ]['sanitizationReview'],
      publication: governance.publication as RealTraceCandidateV1[
        'governance'
      ]['publication'],
    },
    metric: {
      name: metricName,
      value: finite(metric.value, 'real_trace_metric_value_invalid'),
      unit: metricUnit,
      worseDirection: metric.worseDirection,
    },
    capturedAt: timestamp(candidate.capturedAt, 'real_trace_captured_at_invalid'),
    importedAt: timestamp(candidate.importedAt, 'real_trace_imported_at_invalid'),
    reviews,
    ...(groundTruthContentHash ? {groundTruthContentHash} : {}),
  });
}

function parseLedger(
  value: RealTraceSplitLedgerV1,
  evalSetId: string,
): RealTraceSplitLedgerV1 {
  const ledger = record(value, 'real_trace_split_ledger_invalid');
  exactKeys(
    ledger,
    ['schemaVersion', 'evalSetId', 'assignments'],
    'real_trace_split_ledger_unknown_field',
  );
  if (ledger.schemaVersion !== 1 || ledger.evalSetId !== evalSetId) {
    throw new Error('real_trace_split_ledger_eval_set_mismatch');
  }
  const rawAssignments = record(
    ledger.assignments,
    'real_trace_split_assignments_invalid',
  );
  const assignments: Record<string, EvalCaseV1['split']> = {};
  for (const [hash, split] of Object.entries(rawAssignments)) {
    if (
      !SHA256_PATTERN.test(hash)
      || !['train', 'validation', 'holdout'].includes(String(split))
    ) {
      throw new Error('real_trace_split_assignment_invalid');
    }
    assignments[hash] = split as EvalCaseV1['split'];
  }
  return immutableCanonicalSnapshot({schemaVersion: 1, evalSetId, assignments});
}

function derivedSplit(hash: string): EvalCaseV1['split'] {
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
  if (bucket < 60) return 'train';
  if (bucket < 80) return 'validation';
  return 'holdout';
}

function privacyApproved(candidate: RealTraceCandidateV1): boolean {
  return candidate.governance.consent === 'approved'
    && candidate.governance.licenseReview === 'approved'
    && candidate.governance.privacyReview === 'approved'
    && candidate.governance.sanitizationReview === 'approved';
}

function cohortKey(candidate: RealTraceCandidateV1): string {
  return canonicalContentHash({
    source: candidate.source,
    scene: candidate.scene,
    platform: candidate.platform,
    metric: {
      name: candidate.metric.name,
      unit: candidate.metric.unit,
      worseDirection: candidate.metric.worseDirection,
    },
  });
}

function nearestRank(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

export function qualifyRealTraceCohort(input: {
  evalSetId: string;
  candidates: RealTraceCandidateV1[];
  splitLedger: RealTraceSplitLedgerV1;
}): {
  evalSetId: string;
  cohorts: Record<string, RealTraceCohortSummaryV1>;
  decisions: RealTraceCurationDecisionV1[];
  splitLedger: RealTraceSplitLedgerV1;
} {
  const evalSetId = nonempty(input.evalSetId, 'real_trace_eval_set_id_invalid');
  const candidates = input.candidates.map(parseCandidate);
  if (new Set(candidates.map(item => item.traceContentHash)).size !== candidates.length) {
    throw new Error('real_trace_candidate_hash_duplicate');
  }
  const ledger = parseLedger(input.splitLedger, evalSetId);
  const assignments = {...ledger.assignments};
  for (const candidate of candidates) {
    const expected = derivedSplit(candidate.traceContentHash);
    if (
      assignments[candidate.traceContentHash]
      && assignments[candidate.traceContentHash] !== expected
    ) {
      throw new Error('real_trace_split_ledger_conflict');
    }
    if (privacyApproved(candidate)) {
      assignments[candidate.traceContentHash] = expected;
    }
  }
  const approved = candidates.filter(privacyApproved);
  const groups = new Map<string, RealTraceCandidateV1[]>();
  for (const candidate of approved) {
    const key = cohortKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const cohorts: Record<string, RealTraceCohortSummaryV1> = {};
  const severityP90 = new Map<string, number>();
  for (const [key, group] of groups) {
    const values = group.map(item => item.metric.value);
    const severityValues = group.map(item =>
      item.metric.worseDirection === 'higher'
        ? item.metric.value
        : -item.metric.value);
    cohorts[key] = {
      cohortKey: key,
      sampleCount: group.length,
      metricName: group[0].metric.name,
      unit: group[0].metric.unit,
      worseDirection: group[0].metric.worseDirection,
      p50: nearestRank(values, 0.5),
      p90: nearestRank(values, 0.9),
      p99: nearestRank(values, 0.99),
      worseP90Threshold: group[0].metric.worseDirection === 'higher'
        ? nearestRank(severityValues, 0.9)
        : -nearestRank(severityValues, 0.9),
      worseP99Threshold: group[0].metric.worseDirection === 'higher'
        ? nearestRank(severityValues, 0.99)
        : -nearestRank(severityValues, 0.99),
      p99Status: group.length >= 100 ? 'qualified' : 'provisional',
      qualification: group.length >= 20
        ? 'qualified'
        : 'insufficient_cohort',
    };
    severityP90.set(key, nearestRank(severityValues, 0.9));
  }
  const decisions = candidates.map(candidate => {
    const key = cohortKey(candidate);
    if (!privacyApproved(candidate)) {
      return {
        traceContentHash: candidate.traceContentHash,
        cohortKey: key,
        status: 'rejected' as const,
        reason: 'privacy_contract_failed' as const,
      };
    }
    const cohort = cohorts[key];
    const split = assignments[candidate.traceContentHash];
    if (cohort.qualification === 'insufficient_cohort') {
      return {
        traceContentHash: candidate.traceContentHash,
        cohortKey: key,
        split,
        status: 'shadow_insufficient_cohort' as const,
        reason: 'insufficient_cohort' as const,
      };
    }
    const severity = candidate.metric.worseDirection === 'higher'
      ? candidate.metric.value
      : -candidate.metric.value;
    const outlier = severity >= severityP90.get(key)!;
    if (!outlier) {
      return {
        traceContentHash: candidate.traceContentHash,
        cohortKey: key,
        split,
        status: 'qualified_shadow' as const,
        reason: 'within_cohort' as const,
      };
    }
    if (
      candidate.reviews.length >= 2
      && candidate.groundTruthContentHash
    ) {
      return {
        traceContentHash: candidate.traceContentHash,
        cohortKey: key,
        split,
        status: 'eligible_for_manual_golden' as const,
        reason: 'reviewed_p90_outlier' as const,
      };
    }
    return {
      traceContentHash: candidate.traceContentHash,
      cohortKey: key,
      split,
      status: 'qualified_shadow' as const,
      reason: 'p90_outlier_missing_review' as const,
    };
  });
  return immutableCanonicalSnapshot({
    evalSetId,
    cohorts,
    decisions,
    splitLedger: {
      schemaVersion: 1,
      evalSetId,
      assignments,
    },
  });
}

export function auditCurrentRealTraceCatalog(value: unknown): Array<{
  caseId: string;
  status: 'not_evaluable';
  reasons: string[];
}> {
  const catalog = record(value, 'real_trace_catalog_invalid');
  if (!Array.isArray(catalog.cases)) throw new Error('real_trace_catalog_invalid');
  return immutableCanonicalSnapshot(catalog.cases.flatMap(rawCase => {
    const item = record(rawCase, 'real_trace_catalog_case_invalid');
    if (item.kind !== 'real') return [];
    const coverage = record(
      item.coverage,
      'real_trace_catalog_coverage_invalid',
    );
    const expectations = Array.isArray(coverage.expectations)
      ? coverage.expectations
      : [];
    const reasons = [
      ...('ground_truth' in item ? [] : ['ground_truth_missing']),
      ...(expectations.length === 0
        ? ['coverage_expectations_missing']
        : []),
    ];
    return [{
      caseId: nonempty(item.id, 'real_trace_catalog_case_id_invalid'),
      status: 'not_evaluable' as const,
      reasons,
    }];
  }));
}
