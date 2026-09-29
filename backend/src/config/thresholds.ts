// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Configurable Thresholds
 *
 * This module defines configurable thresholds for performance analysis.
 * These values were previously hardcoded throughout the codebase but are
 * now centralized here for:
 * - Easy customization per device/scenario
 * - Clear documentation of threshold semantics
 * - Future extensibility (e.g., device profiles)
 *
 * @module config/thresholds
 */

// =============================================================================
// Jank Detection Thresholds
// =============================================================================

/**
 * Thresholds for classifying jank severity based on rate and count.
 *
 * These are used by FrameAgent and other components to determine
 * whether a jank issue is critical, warning, or informational.
 */
export interface JankSeverityThresholds {
  /** Jank rate (%) above which severity is 'critical' */
  criticalRate: number;
  /** Jank count above which severity is 'critical' */
  criticalCount: number;
  /** Jank rate (%) above which severity is 'warning' */
  warningRate: number;
  /** Jank count above which severity is 'warning' */
  warningCount: number;
}

/**
 * Default jank severity thresholds.
 *
 * Rationale:
 * - criticalRate (15%): 1 in 7 frames is janky - very noticeable to users
 * - criticalCount (30): ~0.5s of jank in a typical scroll session
 * - warningRate (5%): 1 in 20 frames - perceptible to sensitive users
 * - warningCount (10): ~0.17s of jank - worth investigating
 *
 * Note: These thresholds apply to all refresh rates. For 120Hz devices,
 * the same rate means more absolute jank events but the user perception
 * of jank rate (%) remains consistent.
 */
export const DEFAULT_JANK_THRESHOLDS: JankSeverityThresholds = {
  criticalRate: 15,
  criticalCount: 30,
  warningRate: 5,
  warningCount: 10,
};

/**
 * Get jank thresholds adjusted for game scenarios.
 * Games typically have lower frame rates and different tolerance.
 */
export function getGameJankThresholds(): JankSeverityThresholds {
  return {
    criticalRate: 10, // Games: lower tolerance
    criticalCount: 20,
    warningRate: 3,
    warningCount: 5,
  };
}

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
// VRR (Variable Refresh Rate) Support
// =============================================================================

/**
 * VRR detection indicators.
 * Used to determine if a device is using Variable Refresh Rate.
 */
export interface VRRIndicators {
  /** Whether VRR is detected */
  isVRR: boolean;
  /** Min observed refresh rate (Hz) */
  minRefreshRate?: number;
  /** Max observed refresh rate (Hz) */
  maxRefreshRate?: number;
  /** Dominant refresh rate (Hz) - most common during trace */
  dominantRefreshRate?: number;
}

/**
 * Get jank detection multiplier for VRR devices.
 *
 * VRR devices can dynamically adjust refresh rate, so jank detection
 * needs to account for variable vsync periods. The multiplier adjusts
 * the frame deadline threshold.
 *
 * @param vrr - VRR indicators from trace analysis
 * @returns Multiplier for frame deadline (1.0 = no adjustment)
 */
export function getVRRJankMultiplier(vrr: VRRIndicators): number {
  if (!vrr.isVRR) {
    return 1.0; // Fixed refresh rate - no adjustment
  }

  // VRR devices: use a more lenient threshold since frame timing varies
  // If dominant rate is known, use that as baseline
  if (vrr.dominantRefreshRate && vrr.maxRefreshRate) {
    // Allow more tolerance when refresh rate varies significantly
    const variation = vrr.maxRefreshRate / vrr.dominantRefreshRate;
    if (variation > 1.5) {
      return 1.3; // High variation: 30% more lenient
    }
    return 1.15; // Moderate variation: 15% more lenient
  }

  return 1.2; // Default VRR adjustment: 20% more lenient
}

// =============================================================================
// Jank List Severity (for UI display)
// =============================================================================

/**
 * Threshold for jank list to be classified as 'critical' severity.
 *
 * When the number of detected jank frames exceeds this, the finding
 * is reported as critical severity in the UI.
 */
export const JANK_LIST_CRITICAL_THRESHOLD = 20;

// =============================================================================
// Confidence Thresholds
// =============================================================================

/**
 * Minimum confidence required to accept analysis results without
 * triggering additional rounds of investigation.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Confidence assigned to findings extracted from raw SQL results
 * (as opposed to AI-generated conclusions).
 */
export const DEFAULT_RAW_FINDING_CONFIDENCE = 0.75;

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

/**
 * Generate frame time thresholds for a specific refresh rate.
 *
 * @param hz - Refresh rate in Hz (must be > 0 and <= 500)
 * @returns Thresholds for the given refresh rate, or default 60Hz thresholds for invalid input
 */
export function getFrameTimeThresholdsForHz(hz: number): FrameTimeDisplayThresholds {
  // Guard against invalid refresh rates
  if (!hz || hz <= 0 || hz > 500 || !Number.isFinite(hz)) {
    return DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS;
  }

  const vsyncMs = 1000 / hz;
  return {
    avgWarningMs: vsyncMs,
    avgCriticalMs: vsyncMs * 2,
    maxWarningMs: vsyncMs * 2,
    maxCriticalMs: 100, // Absolute max, not scaled
  };
}

// =============================================================================
// SQL Query VSync Threshold (nanoseconds)
// =============================================================================

/**
 * VSync period in nanoseconds for SQL queries.
 * Used as a constant in SQL WHERE clauses for jank detection.
 *
 * Note: We use 16666666 (rounded down from 16666667) for two reasons:
 * 1. Many existing SQL queries in the codebase use this value
 * 2. Slightly lower threshold is more conservative (catches edge cases)
 *
 * The 1ns difference (0.000001ms) is negligible in practice.
 */
export const SQL_VSYNC_THRESHOLD_NS = 16666666;

/**
 * Double VSync period for jank detection in SQL.
 * Missing 2+ VSyncs is typically considered jank.
 */
export const SQL_JANK_THRESHOLD_NS = SQL_VSYNC_THRESHOLD_NS * 2;

// =============================================================================
// Root Cause Analysis Thresholds
// =============================================================================

/**
 * Thresholds used in jank_frame_detail.skill.yaml root cause analysis.
 *
 * These define when specific conditions trigger diagnostic rules.
 * Priority order in the YAML determines which rule fires first.
 *
 * Design rationale:
 * - sliceDur (>8ms): Half of 16.7ms vsync, significant for 60Hz
 * - gpuFence (>3ms): Noticeable GPU blocking
 * - schedLatency (>5ms): Severe scheduling issue
 * - ioBlock (>2ms): IO on main thread is problematic
 * - totalSchedLatency (>3ms): Cumulative runnable wait
 * - q3 (>20%): Significant CPU contention
 * - q4 (>30%): Too much blocking/sleeping
 * - bigFreq (<1200MHz): Below typical boost frequency
 * - bigLoadPct (>90%): CPU cluster near saturation
 */
export const ROOT_CAUSE_THRESHOLDS = {
  // Priority 1: Main thread slice duration (ms)
  sliceDurCritical: 8,
  sliceDurWarning: 3,

  // Priority 2: GPU Fence wait (ms)
  gpuFenceCritical: 3,
  gpuFenceWarning: 1,

  // Priority 3: Single scheduling latency (ms)
  schedLatencyCritical: 5,

  // Priority 4: Runnable percentage (Q3)
  q3CriticalPct: 20,

  // Priority 5: IO blocking (ms)
  ioBlockCritical: 2,

  // Priority 6: Total scheduling latency (ms)
  totalSchedLatencyCritical: 3,

  // Priority 7: Sleep/blocking percentage (Q4)
  q4WarningPct: 30,

  // Priority 8: RenderThread Q4 percentage
  renderQ4WarningPct: 50,

  // Priority 9: Small core percentage (Q2)
  q2WarningPct: 50,

  // Priority 10: Big core frequency (MHz)
  bigFreqWarningMhz: 1200,

  // Priority 11: Big cluster load percentage
  bigLoadCriticalPct: 90,
  bigLoadWarningPct: 70,

  // Priority 12-13: Already covered by gpuFence thresholds

  // Priority 14: Lower slice duration warning
  // Already covered by sliceDurWarning
};

// =============================================================================
// Export All Defaults for Easy Access
// =============================================================================

export const ANALYSIS_THRESHOLDS = {
  jank: DEFAULT_JANK_THRESHOLDS,
  vsync: {
    periods: VSYNC_PERIODS_NS,
    default: DEFAULT_VSYNC_PERIOD_NS,
  },
  confidence: {
    threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    rawFinding: DEFAULT_RAW_FINDING_CONFIDENCE,
  },
  ui: {
    jankListCriticalThreshold: JANK_LIST_CRITICAL_THRESHOLD,
    frameTimeDisplay: DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS,
  },
  sql: {
    vsyncThresholdNs: SQL_VSYNC_THRESHOLD_NS,
    jankThresholdNs: SQL_JANK_THRESHOLD_NS,
  },
  rootCause: ROOT_CAUSE_THRESHOLDS,
};
