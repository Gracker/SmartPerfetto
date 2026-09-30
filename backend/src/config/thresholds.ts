// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Configurable Thresholds
 *
 * VSync period inference and frame-time display thresholds shared by the
 * Skill summary generators and frame statistics analysis.
 *
 * @module config/thresholds
 */

// =============================================================================
// VSync Period Configuration
// =============================================================================

/**
 * Standard refresh rate to VSync period mapping (in nanoseconds).
 *
 * This is used when VSync period cannot be detected from the trace
 * and must be estimated from device configuration.
 */
export const VSYNC_PERIODS_NS: Record<number, bigint> = {
  60: 16666667n,   // 16.67ms
  90: 11111111n,   // 11.11ms
  120: 8333333n,   // 8.33ms
  144: 6944444n,   // 6.94ms
  165: 6060606n,   // 6.06ms
  240: 4166667n,   // 4.17ms
};

/**
 * Default VSync period when refresh rate is unknown.
 * Uses 120Hz as the modern default for flagship devices.
 *
 * Rationale: Most modern Android flagships (2022+) support 120Hz displays.
 * Using 120Hz as default is more conservative for jank detection:
 * - A frame that's fine at 60Hz (16ms) would be janky at 120Hz (8.3ms)
 * - Better to catch potential issues than miss them
 * - The vsync_config skill will override this with actual trace data
 */
export const DEFAULT_VSYNC_PERIOD_NS = VSYNC_PERIODS_NS[120];

/**
 * Infer VSync period from trace context or use default.
 *
 * Resolution order:
 * 1. Detected VSync period from trace (vsync_period_ns) - from vsync_config skill
 * 2. Device refresh rate config (device_refresh_rate)
 * 3. Default 120Hz (modern flagship assumption)
 *
 * @param traceContext - Context containing detected trace properties
 * @returns VSync period in nanoseconds as BigInt
 */
export function inferVsyncPeriodNs(traceContext?: {
  detectedVsyncPeriodNs?: string | bigint | number;
  deviceRefreshRate?: number;
}): bigint {
  // Try detected value first (from vsync_config skill)
  if (traceContext?.detectedVsyncPeriodNs) {
    try {
      const detected = BigInt(traceContext.detectedVsyncPeriodNs);
      if (detected > 0n) return detected;
    } catch {
      // Fall through to next option
    }
  }

  // Try device refresh rate
  if (traceContext?.deviceRefreshRate) {
    const rate = traceContext.deviceRefreshRate;
    if (VSYNC_PERIODS_NS[rate]) {
      return VSYNC_PERIODS_NS[rate];
    }
    // Calculate for non-standard refresh rates
    if (rate > 0 && rate <= 500) {
      return BigInt(Math.round(1_000_000_000 / rate));
    }
  }

  // Default to 120Hz (modern flagship devices)
  return DEFAULT_VSYNC_PERIOD_NS;
}

// =============================================================================
// Frame Time UI Thresholds (for display coloring)
// =============================================================================

/**
 * Frame time thresholds for UI display (warning/critical coloring).
 *
 * These are derived from VSync periods:
 * - warningMs: 1 VSync period (16.67ms at 60Hz)
 * - criticalMs: 2 VSync periods (33.33ms at 60Hz)
 * - maxCriticalMs: ~6 VSync periods (100ms - severe jank)
 */
export interface FrameTimeDisplayThresholds {
  /** Average frame time warning threshold (ms) */
  avgWarningMs: number;
  /** Average frame time critical threshold (ms) */
  avgCriticalMs: number;
  /** Max frame time warning threshold (ms) */
  maxWarningMs: number;
  /** Max frame time critical threshold (ms) */
  maxCriticalMs: number;
}

/**
 * Default frame time display thresholds (120Hz assumptions).
 *
 * Updated from 60Hz to 120Hz to match modern devices.
 * These are UI display thresholds; actual jank detection uses vsync_config skill.
 */
export const DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS: FrameTimeDisplayThresholds = {
  avgWarningMs: 8.33,    // 1 VSync (120Hz)
  avgCriticalMs: 16.67,  // 2 VSyncs (120Hz)
  maxWarningMs: 16.67,   // 2 VSyncs (120Hz)
  maxCriticalMs: 100,    // ~12 VSyncs (severe)
};
