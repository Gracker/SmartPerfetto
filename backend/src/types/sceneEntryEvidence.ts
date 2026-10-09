// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Product-owned scene entry evidence: the strategy-declared entry Skill a
 * scene-wide investigation runs before the model's first turn. Light types
 * only, shared by the strategy loader, the runtime receipt and the benchmark
 * parser without pulling the execution path into their import graphs.
 */

/** How one entry Skill parameter is bound; a closed set, never a literal value. */
export const ENTRY_SKILL_BINDINGS = [
  'focus_app', 'user_target', 'trace_start', 'trace_end', 'selection_start', 'selection_end',
] as const;
export type EntrySkillBinding = typeof ENTRY_SKILL_BINDINGS[number];

export const ENTRY_SKILL_PROCESS_BINDINGS: readonly EntrySkillBinding[] = ['focus_app', 'user_target'];
export const ENTRY_SKILL_START_BINDINGS: readonly EntrySkillBinding[] = ['trace_start', 'selection_start'];
export const ENTRY_SKILL_END_BINDINGS: readonly EntrySkillBinding[] = ['trace_end', 'selection_end'];

/** Strategy frontmatter `entry_skill`, parsed. */
export interface StrategyEntrySkill {
  id: string;
  params: Readonly<Record<string, EntrySkillBinding>>;
}

/** Why the entry Skill did not run. One closed set for the helper, prompt, receipt and tests. */
export const SCENE_ENTRY_NOT_RUN_REASONS = [
  'no_entry_skill', 'not_scene_wide', 'existing_only', 'acquisition_closed', 'cancelled',
  'authorization_revoked', 'target_unresolved', 'identity_ambiguous', 'capability_missing', 'timeout', 'failed',
] as const;
export type SceneEntryNotRunReason = typeof SCENE_ENTRY_NOT_RUN_REASONS[number];

/** One run's entry evidence attempt: observation and closed counts only, no payload or path. */
export interface RuntimePerformanceSceneEvidenceReceiptV1 {
  skillId: string;
  status: 'ran' | 'not_run';
  reason?: SceneEntryNotRunReason;
  durationMs: number;
  artifactCount: number;
  captureCount: number;
}

export function isSceneEntryNotRunReason(value: unknown): value is SceneEntryNotRunReason {
  return typeof value === 'string' && (SCENE_ENTRY_NOT_RUN_REASONS as readonly string[]).includes(value);
}
