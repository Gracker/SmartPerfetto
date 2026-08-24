// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import {
  auditCurrentRealTraceCatalog,
  qualifyRealTraceCohort,
  type RealTraceCandidateV1,
  type RealTraceSplitLedgerV1,
} from '../realTraceCuration';

const evalSetId = 'real-generalization-v1';

function hash(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function candidate(
  index: number,
  value: number,
  overrides: Partial<RealTraceCandidateV1> = {},
): RealTraceCandidateV1 {
  return {
    schemaVersion: 1,
    traceContentHash: hash(index),
    source: 'macrobenchmark',
    scene: 'startup',
    platform: {
      androidApiLevel: 36,
      androidRelease: '16',
      oemClass: 'aosp',
      deviceClass: 'flagship',
      refreshRateBucketHz: 120,
    },
    governance: {
      license: 'owner-approved-evaluation',
      licenseReview: 'approved',
      consent: 'approved',
      privacyReview: 'approved',
      sanitizationReview: 'approved',
      publication: 'private_evaluation',
    },
    metric: {
      name: 'startup_ms',
      value,
      unit: 'ms',
      worseDirection: 'higher',
    },
    capturedAt: '2026-08-20T00:00:00.000Z',
    importedAt: '2026-08-22T00:00:00.000Z',
    reviews: [],
    ...overrides,
  };
}

function emptyLedger(): RealTraceSplitLedgerV1 {
  return {
    schemaVersion: 1,
    evalSetId,
    assignments: {},
  };
}

describe('real trace cohort qualification', () => {
  it('reports nearest-rank P50/P90/P99 and qualifies reviewed P90 outliers', () => {
    const candidates = Array.from({length: 100}, (_, index) =>
      candidate(index + 1, index + 1, index === 99
        ? {
            reviews: [
              {
                reviewerId: 'reviewer-a',
                attestationContentHash: 'a'.repeat(64),
              },
              {
                reviewerId: 'reviewer-b',
                attestationContentHash: 'b'.repeat(64),
              },
            ],
            groundTruthContentHash: 'f'.repeat(64),
          }
        : {}));
    const result = qualifyRealTraceCohort({
      evalSetId,
      candidates,
      splitLedger: emptyLedger(),
    });
    const summary = Object.values(result.cohorts)[0];
    expect(summary).toMatchObject({
      sampleCount: 100,
      p50: 50,
      p90: 90,
      p99: 99,
      p99Status: 'qualified',
    });
    expect(result.decisions.find(item =>
      item.traceContentHash === hash(100))).toMatchObject({
      status: 'eligible_for_manual_golden',
      reason: 'reviewed_p90_outlier',
    });
    expect(Object.keys(result.splitLedger.assignments)).toHaveLength(100);
  });

  it('keeps small cohorts shadow-only and marks P99 provisional below 100', () => {
    const result = qualifyRealTraceCohort({
      evalSetId,
      candidates: Array.from({length: 19}, (_, index) =>
        candidate(index + 1, index + 1)),
      splitLedger: emptyLedger(),
    });
    expect(Object.values(result.cohorts)[0]).toMatchObject({
      sampleCount: 19,
      qualification: 'insufficient_cohort',
      p99Status: 'provisional',
    });
    expect(result.decisions.every(item =>
      item.status === 'shadow_insufficient_cohort')).toBe(true);
  });

  it('normalizes lower-is-worse metrics without changing stored units', () => {
    const result = qualifyRealTraceCohort({
      evalSetId,
      candidates: Array.from({length: 20}, (_, index) =>
        candidate(index + 1, index + 1, {
          metric: {
            name: 'fps',
            value: index + 1,
            unit: 'fps',
            worseDirection: 'lower',
          },
        })),
      splitLedger: emptyLedger(),
    });
    const lowest = result.decisions.find(item =>
      item.traceContentHash === hash(1));
    expect(lowest).toMatchObject({
      status: 'qualified_shadow',
      reason: 'p90_outlier_missing_review',
    });
    expect(Object.values(result.cohorts)[0]).toMatchObject({
      unit: 'fps',
      worseDirection: 'lower',
    });
  });

  it('rejects privacy failures, duplicate hashes, and corrupted split ledgers', () => {
    const privacyFailure = candidate(1, 10, {
      governance: {
        license: 'owner-approved-evaluation',
        licenseReview: 'approved',
        consent: 'approved',
        privacyReview: 'rejected',
        sanitizationReview: 'approved',
        publication: 'private_evaluation',
      },
    });
    expect(qualifyRealTraceCohort({
      evalSetId,
      candidates: [privacyFailure],
      splitLedger: emptyLedger(),
    }).decisions[0]).toMatchObject({
      status: 'rejected',
      reason: 'privacy_contract_failed',
    });
    expect(() => qualifyRealTraceCohort({
      evalSetId,
      candidates: [candidate(1, 1), candidate(1, 2)],
      splitLedger: emptyLedger(),
    })).toThrow('real_trace_candidate_hash_duplicate');
    expect(() => qualifyRealTraceCohort({
      evalSetId,
      candidates: [candidate(0, 1)],
      splitLedger: {
        schemaVersion: 1,
        evalSetId,
        assignments: {[hash(0)]: 'holdout'},
      },
    })).toThrow('real_trace_split_ledger_conflict');
  });

  it('strictly rejects identity-bearing and unknown candidate fields', () => {
    expect(() => qualifyRealTraceCohort({
      evalSetId,
      candidates: [{
        ...candidate(1, 1),
        packageName: 'com.private.app',
      } as never],
      splitLedger: emptyLedger(),
    })).toThrow('real_trace_candidate_unknown_field');
  });
});

describe('current real trace catalog qualification boundary', () => {
  it('keeps all six current real fixtures not-evaluable without unified ground truth', () => {
    const catalog = JSON.parse(fs.readFileSync(path.resolve(
      __dirname,
      '../../../../../Trace/catalog.json',
    ), 'utf8'));
    const audit = auditCurrentRealTraceCatalog(catalog);
    expect(audit).toHaveLength(6);
    expect(audit.every(item => item.status === 'not_evaluable')).toBe(true);
    expect(audit.every(item =>
      item.reasons.includes('ground_truth_missing')
      && item.reasons.includes('coverage_expectations_missing'))).toBe(true);
  });
});
