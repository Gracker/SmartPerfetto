// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {summarizeVerdictStability} from '../verdictStability';

const run = (status: string, reviews: Array<[string, string, string[]]>, notCheckedReason?: string) => ({
  schemaVersion: 'claim_verifier@2', status, passed: status === 'passed', policy: 'record_only',
  ...(notCheckedReason ? {notCheckedReason} : {}),
  checkedClaimCount: reviews.length, unsupportedClaimCount: 0, issues: [],
  claimResults: reviews.map(([claimId, consistency, hashes]) => ({claimId, status: 'partial',
    semanticReview: {consistency, contentLocations: hashes.map((textHash, index) => ({start: index, end: index + 1, textHash}))}})),
});

describe('verdict stability summary', () => {
  it('joins review fragments across runs by text hash and separates stable from unstable verdicts', () => {
    const summary = summarizeVerdictStability([
      run('partial', [['c1', 'consistent', ['aaaa', 'bbbb']], ['c2', 'inconsistent', ['cccc']]]),
      run('failed', [['q1', 'consistent', ['aaaa']], ['q2', 'consistent', ['cccc']]]),
      run('partial', [], 'budget_insufficient'),
      undefined,
      {not: 'a verification'},
    ]);
    expect(summary).toEqual({
      schemaVersion: 'verdict_stability@1', runs: 3, unreadable: 2,
      statuses: {partial: 2, failed: 1}, notCheckedReasons: {budget_insufficient: 1},
      claimStatuses: {partial: 4},
      fragments: {total: 3, repeated: 2, stable: 1, unstable: 1},
      unstableFragments: [{textHash: 'cccc', consistencies: {inconsistent: 1, consistent: 1}}],
    });
  });
});
