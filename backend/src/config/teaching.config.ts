// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Teaching Module Configuration
 *
 * Centralized configuration for the teaching pipeline feature.
 * These values were previously hardcoded throughout the codebase.
 *
 * Configuration categories:
 * - Default values for fallback scenarios
 * - Limits for SQL queries and data processing
 * - Step IDs read from the pipeline detection Skill
 *
 * @module config/teaching
 */

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default pipeline configuration when detection fails or returns incomplete data.
 *
 * The default pipeline/type/document selection belongs to the rendering
 * catalog. This object only contains generic presentation defaults.
 */
export const TEACHING_DEFAULTS = {
  /** Default confidence when parsing fails (0.5 = uncertain) */
  confidence: 0.5,

  /** Default icon for unknown pipeline types */
  icon: '📱',

  /** Default family classification */
  family: 'android_view',
} as const;

// =============================================================================
// Processing Limits
// =============================================================================

/**
 * Limits for SQL queries and data processing to prevent unbounded results.
 *
 * Rationale:
 * - maxActiveProcesses: 10 covers most apps, prevents huge result sets
 * - maxCandidates: 10 keeps detection focused, avoids noise
 * - maxPinInstructions: 50 supports complex pipelines while limiting memory
 * - maxKeySlices: 20 provides comprehensive coverage without overwhelming UI
 * - summaryLength: 500 chars fits in typical UI panels
 */
export const TEACHING_LIMITS = {
  /** Maximum active rendering processes to return from SQL */
  maxActiveProcesses: 10,

  /** Maximum pipeline candidates from detection */
  maxCandidates: 10,

  /** Maximum pin instructions per pipeline */
  maxPinInstructions: 50,

  /** Maximum key slices to extract from documentation */
  maxKeySlices: 20,

  /** Maximum summary length in characters */
  summaryLength: 500,

  /** Maximum mermaid blocks to render */
  maxMermaidBlocks: 5,

  /** Maximum thread roles to display */
  maxThreadRoles: 20,

  /** SQL result row limit for safety */
  sqlRowLimit: 1000,
} as const;

// =============================================================================
// SQL Step IDs
// =============================================================================

/**
 * Step IDs used to extract results from skill execution.
 *
 * These must match the `id` fields in rendering_pipeline_detection.skill.yaml
 */
export const TEACHING_STEP_IDS = {
  /** Pipeline detection result step */
  pipelineDetection: 'pipeline_detection',

  /** Active rendering processes step */
  activeProcesses: 'active_rendering_processes',

  /** Frame timeline detection step */
  frameTimeline: 'frame_timeline_detection',

  /** Compose detection step */
  composeDetection: 'compose_detection',
} as const;
