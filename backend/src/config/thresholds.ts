// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Frame-time display thresholds shared by the Skill summary generators.
 *
 * @module config/thresholds
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
 * Display coloring at 120Hz (1 VSync = 8.33 ms). Jank detection uses the
 * vsync_config Skill, not these values.
 */
export const DEFAULT_FRAME_TIME_DISPLAY_THRESHOLDS: FrameTimeDisplayThresholds = {
  avgWarningMs: 8.33,    // 1 VSync
  avgCriticalMs: 16.67,  // 2 VSyncs
  maxWarningMs: 16.67,   // 2 VSyncs
  maxCriticalMs: 100,    // ~12 VSyncs (severe)
};
