// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Pre-rot token meter for v2.1 Phase 3-1.
 *
 * The Claude Agent SDK does not let user code push a recovery message
 * mid-stream (see `docs/sdk-capability-spike-2026-04-28.md`). The
 * fallback is to monitor the *uncached* portion of the running
 * conversation and trip a threshold *before* the SDK runs out of
 * context, so the orchestrator can `interrupt()` and start a fresh
 * `query({ resume })` carrying a recovery preamble.
 *
 * This module is the pure decision layer — it does not call the SDK.
 * Phase 3-3 will wire the orchestrator to consult it on every turn.
 *
 * Why "uncached + creation + recent payload" rather than raw
 * `inputTokens`:
 *   - `cache_read_input_tokens` is essentially free for the model's
 *     attention budget — counting it would trip the meter spuriously
 *     on long conversations whose prefix is fully cached.
 *   - `cache_creation_input_tokens` IS new attention pressure (it's
 *     the first time the model sees that block), so it counts.
 *   - `inputTokens` from the SDK is the uncached prompt tail (cached
 *     blocks are reported in the cache-* fields), which always counts.
 *   - The recent tool-result payload bytes are the most volatile
 *     signal (they balloon when fetch_artifact full mode runs); we
 *     convert bytes to a rough token estimate (4 bytes ≈ 1 token for
 *     mixed CN/EN) to keep the meter on the same scale as the SDK.
 */

/** Default Sonnet 4.6 context window. Override via {@link ThresholdConfig.contextLimit}. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Default fraction of context limit that trips the meter. Env-overridable. */
export const DEFAULT_PRECOMPACT_FRACTION = 0.6;

/** Bytes per token for SmartPerfetto-style mixed CN/EN tool payloads. */
const BYTES_PER_TOKEN_ESTIMATE = 4;

export interface CumulativeUsageSample {
  /** SDK `usage.input_tokens` — the uncached prompt tail. */
  uncachedInputTokens: number;
  /** SDK `usage.cache_creation_input_tokens` — fresh blocks added to the cache. */
  cacheCreationInputTokens: number;
  /**
   * Total bytes of tool-result payloads observed since session start.
   * Available on `TurnMetricsSummary.totalPayloadBytes`.
   */
  recentToolPayloadBytes: number;
}

export interface ThresholdConfig {
  /** Total SDK context window in tokens. Default {@link DEFAULT_CONTEXT_LIMIT}. */
  contextLimit?: number;
  /**
   * Fraction of context limit that trips the meter. Resolved from
   * `process.env.CLAUDE_PRECOMPACT_THRESHOLD` when omitted, falling back to
   * {@link DEFAULT_PRECOMPACT_FRACTION}.
   */
  fraction?: number;
}

export interface MeterDecision {
  /** True when the meter has crossed the configured threshold. */
  shouldPrecompact: boolean;
  /** Effective threshold in tokens (for logging / telemetry). */
  thresholdTokens: number;
  /** Estimated attention pressure in tokens (uncached + creation + payload-derived). */
  pressureTokens: number;
  /** `pressureTokens / thresholdTokens` clamped to [0, 1] for dashboards. */
  pressureRatio: number;
}

function resolveFraction(cfg?: ThresholdConfig): number {
  if (cfg?.fraction !== undefined) return cfg.fraction;
  const envValue = process.env.CLAUDE_PRECOMPACT_THRESHOLD;
  if (envValue) {
    const parsed = Number.parseFloat(envValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) return parsed;
  }
  return DEFAULT_PRECOMPACT_FRACTION;
}

/**
 * Convert a tool-result-payload byte count into a rough token estimate.
 * Exposed for tests; production code should use {@link evaluateThreshold}.
 */
export function payloadBytesToTokens(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

/**
 * Decide whether the running conversation has enough attention pressure
 * accumulated to warrant a pre-rot `interrupt()` + `resume` cycle.
 *
 * Pure function — callers (orchestrator, tests) provide the cumulative
 * sample. The decision is intentionally not stateful: callers set their
 * own one-shot guard so `shouldPrecompact = true` doesn't fire on every
 * subsequent turn.
 */
export function evaluateThreshold(
  sample: CumulativeUsageSample,
  config?: ThresholdConfig,
): MeterDecision {
  const contextLimit = config?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const fraction = resolveFraction(config);
  const thresholdTokens = Math.floor(contextLimit * fraction);

  const pressureTokens =
    Math.max(0, sample.uncachedInputTokens) +
    Math.max(0, sample.cacheCreationInputTokens) +
    payloadBytesToTokens(sample.recentToolPayloadBytes);

  const pressureRatio = thresholdTokens === 0
    ? 0
    : Math.min(1, pressureTokens / thresholdTokens);

  return {
    shouldPrecompact: pressureTokens >= thresholdTokens,
    thresholdTokens,
    pressureTokens,
    pressureRatio,
  };
}
