// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase 3-1 of v2.1 — pre-rot token meter unit tests.
 *
 * The orchestrator wiring (Phase 3-3) is intentionally separate; here
 * we only verify the pure decision logic so the threshold tuning can
 * iterate without round-tripping through a full e2e.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  evaluateThreshold,
  payloadBytesToTokens,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_PRECOMPACT_FRACTION,
} from '../contextTokenMeter';

const ORIGINAL_THRESHOLD_ENV = process.env.CLAUDE_PRECOMPACT_THRESHOLD;

afterEach(() => {
  if (ORIGINAL_THRESHOLD_ENV === undefined) {
    delete process.env.CLAUDE_PRECOMPACT_THRESHOLD;
  } else {
    process.env.CLAUDE_PRECOMPACT_THRESHOLD = ORIGINAL_THRESHOLD_ENV;
  }
});

describe('payloadBytesToTokens', () => {
  it('returns 0 for non-positive byte counts', () => {
    expect(payloadBytesToTokens(0)).toBe(0);
    expect(payloadBytesToTokens(-100)).toBe(0);
  });

  it('rounds up to the next whole token (4 bytes per token estimate)', () => {
    expect(payloadBytesToTokens(4)).toBe(1);
    expect(payloadBytesToTokens(5)).toBe(2);
    expect(payloadBytesToTokens(40_000)).toBe(10_000);
  });
});

describe('evaluateThreshold', () => {
  it('does not trip when pressure stays below the configured fraction', () => {
    const decision = evaluateThreshold({
      uncachedInputTokens: 10_000,
      cacheCreationInputTokens: 5_000,
      recentToolPayloadBytes: 0,
    }, { contextLimit: 200_000, fraction: 0.6 });
    expect(decision.shouldPrecompact).toBe(false);
    expect(decision.thresholdTokens).toBe(120_000);
    expect(decision.pressureTokens).toBe(15_000);
    expect(decision.pressureRatio).toBeCloseTo(15_000 / 120_000, 3);
  });

  it('trips when uncached + creation alone crosses the threshold', () => {
    const decision = evaluateThreshold({
      uncachedInputTokens: 100_000,
      cacheCreationInputTokens: 21_000,
      recentToolPayloadBytes: 0,
    }, { contextLimit: 200_000, fraction: 0.6 });
    expect(decision.shouldPrecompact).toBe(true);
    expect(decision.pressureTokens).toBe(121_000);
  });

  it('payload bytes contribute to pressure (in tokens)', () => {
    const decision = evaluateThreshold({
      uncachedInputTokens: 100_000,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 80_000, // ≈ 20_000 tokens
    }, { contextLimit: 200_000, fraction: 0.6 });
    expect(decision.pressureTokens).toBe(120_000);
    expect(decision.shouldPrecompact).toBe(true);
  });

  it('cache_read tokens are NOT counted (they do not push attention)', () => {
    // Caller provides the *uncached* tail in `uncachedInputTokens`. If callers
    // accidentally pass the full `inputTokens` (which on cached prompts equals
    // the uncached tail in the SDK's payload anyway) the math still stays
    // honest because we do not have a `cacheReadInputTokens` field.
    const decision = evaluateThreshold({
      uncachedInputTokens: 5_000,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    }, { contextLimit: 200_000, fraction: 0.6 });
    expect(decision.shouldPrecompact).toBe(false);
    expect(decision.pressureTokens).toBe(5_000);
  });

  it('clamps the pressure ratio at 1.0', () => {
    const decision = evaluateThreshold({
      uncachedInputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    }, { contextLimit: 200_000, fraction: 0.6 });
    expect(decision.pressureRatio).toBe(1);
  });

  it('treats negative inputs as 0 (defensive)', () => {
    const decision = evaluateThreshold({
      uncachedInputTokens: -5_000,
      cacheCreationInputTokens: -1_000,
      recentToolPayloadBytes: -100,
    }, { contextLimit: 200_000, fraction: 0.6 });
    expect(decision.pressureTokens).toBe(0);
    expect(decision.shouldPrecompact).toBe(false);
  });

  it('reads the threshold fraction from CLAUDE_PRECOMPACT_THRESHOLD env when no override is provided', () => {
    process.env.CLAUDE_PRECOMPACT_THRESHOLD = '0.75';
    const decision = evaluateThreshold({
      uncachedInputTokens: 130_000,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    }, { contextLimit: 200_000 });
    expect(decision.thresholdTokens).toBe(150_000);
    expect(decision.shouldPrecompact).toBe(false);
  });

  it('rejects an out-of-range env fraction and falls back to default', () => {
    process.env.CLAUDE_PRECOMPACT_THRESHOLD = '1.5'; // invalid
    const decision = evaluateThreshold({
      uncachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    }, { contextLimit: 200_000 });
    expect(decision.thresholdTokens).toBe(Math.floor(200_000 * DEFAULT_PRECOMPACT_FRACTION));
  });

  it('uses sensible defaults when no config is supplied', () => {
    delete process.env.CLAUDE_PRECOMPACT_THRESHOLD;
    const decision = evaluateThreshold({
      uncachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    });
    expect(decision.thresholdTokens).toBe(
      Math.floor(DEFAULT_CONTEXT_LIMIT * DEFAULT_PRECOMPACT_FRACTION),
    );
  });

  it('shouldPrecompact is monotonic — once you cross, you stay tripped for higher samples', () => {
    const cfg = { contextLimit: 200_000, fraction: 0.6 };
    const justAcross = evaluateThreshold({
      uncachedInputTokens: 120_000,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    }, cfg);
    const wayAcross = evaluateThreshold({
      uncachedInputTokens: 180_000,
      cacheCreationInputTokens: 0,
      recentToolPayloadBytes: 0,
    }, cfg);
    expect(justAcross.shouldPrecompact).toBe(true);
    expect(wayAcross.shouldPrecompact).toBe(true);
  });
});
