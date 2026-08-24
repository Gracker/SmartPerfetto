// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  adaptiveRoutingProductionPolicy,
  evaluateAdaptiveRoutingAdmission,
  type AdaptiveRoutingAdmissionSplitEvidenceV1,
} from '../adaptiveRoutingAdmission';

const split = (
  splitName: 'validation' | 'holdout',
  overrides: Partial<AdaptiveRoutingAdmissionSplitEvidenceV1> = {},
): AdaptiveRoutingAdmissionSplitEvidenceV1 => ({
  schemaVersion: 1,
  split: splitName,
  experimentContentHash: splitName === 'validation'
    ? 'a'.repeat(64)
    : 'b'.repeat(64),
  baselineProfileId: 'full-pro',
  candidateProfileId: 'fast-light',
  caseCount: 3,
  repeatsPerCaseProfile: 3,
  actualUsageAvailable: true,
  l0PassRate: 1,
  unsupportedClaims: 0,
  identityErrors: 0,
  falseQuick: 0,
  claimVerifiedRatioDelta: -0.01,
  goldenHitRatioDelta: -0.04,
  baselineMedianWallclockMs: 100,
  candidateMedianWallclockMs: 65,
  baselineMedianTokens: 1_000,
  candidateMedianTokens: 700,
  baselineMedianToolCalls: 10,
  candidateMedianToolCalls: 11,
  ...overrides,
});

describe('adaptive routing admission', () => {
  it('requires both validation and holdout to meet every threshold', () => {
    const verdict = evaluateAdaptiveRoutingAdmission({
      validation: split('validation'),
      holdout: split('holdout'),
    });
    expect(verdict).toMatchObject({
      schemaVersion: 'adaptive_routing_admission@1',
      status: 'eligible_for_enforcement',
      reasons: [],
      checks: {
        validation: {passed: true},
        holdout: {passed: true},
      },
    });
    expect(verdict.contentHash).toHaveLength(64);
  });

  it.each([
    ['l0', {l0PassRate: 0.99}, 'l0_pass_rate_failed'],
    ['unsupported', {unsupportedClaims: 1}, 'unsupported_claims_present'],
    ['identity', {identityErrors: 1}, 'identity_errors_present'],
    ['false quick', {falseQuick: 1}, 'false_quick_present'],
    ['claim delta', {claimVerifiedRatioDelta: -0.021}, 'claim_verified_delta_failed'],
    ['golden delta', {goldenHitRatioDelta: -0.051}, 'golden_hit_delta_failed'],
    ['speed', {
      candidateMedianWallclockMs: 71,
      candidateMedianTokens: 660,
    }, 'cost_reduction_failed'],
    ['tools', {candidateMedianToolCalls: 11.01}, 'tool_call_growth_failed'],
    ['repeats', {repeatsPerCaseProfile: 2}, 'repeat_count_failed'],
  ] as const)('rejects a single %s regression', (_label, override, reason) => {
    const verdict = evaluateAdaptiveRoutingAdmission({
      validation: split('validation', override),
      holdout: split('holdout'),
    });
    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons).toContain(reason);
  });

  it('is inconclusive when actual usage or comparable cells are unavailable', () => {
    expect(evaluateAdaptiveRoutingAdmission({
      validation: split('validation', {actualUsageAvailable: false}),
      holdout: split('holdout'),
    })).toMatchObject({
      status: 'inconclusive',
      reasons: ['actual_usage_unavailable'],
    });
    expect(() => evaluateAdaptiveRoutingAdmission({
      validation: {...split('validation'), privateQuery: 'secret'} as never,
      holdout: split('holdout'),
    })).toThrow('adaptive_routing_admission_unknown_field');
  });

  it('rejects known quality failures even when cost usage is unavailable', () => {
    const verdict = evaluateAdaptiveRoutingAdmission({
      validation: split('validation', {
        actualUsageAvailable: false,
        unsupportedClaims: 1,
      }),
      holdout: split('holdout'),
    });

    expect(verdict.status).toBe('rejected');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'actual_usage_unavailable',
      'unsupported_claims_present',
    ]));
  });

  it('keeps the production policy shadow-only even for eligible synthetic evidence', () => {
    expect(adaptiveRoutingProductionPolicy()).toMatchObject({
      enforcement: 'shadow',
      reason: 'admission_not_activated',
    });
  });
});
