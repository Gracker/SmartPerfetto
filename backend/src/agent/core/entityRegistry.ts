// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type EntityCaptureKind =
  | 'frame'
  | 'session'
  | 'cpu_slice'
  | 'binder'
  | 'gc'
  | 'memory';

const ENTITY_CAPTURE_STEP_PATTERNS: Record<EntityCaptureKind, readonly string[]> = {
  frame: ['get_app_jank_frames', 'batch_frame_root_cause', 'jank_frames', 'frame_list', 'frames'],
  session: ['scroll_sessions', 'sessions', 'session_list'],
  cpu_slice: ['cpu_slices', 'sched_slices', 'thread_slices', 'scheduling', 'cpu_timeline'],
  binder: ['binder_transactions', 'binder_calls', 'ipc_transactions', 'binder_blocking'],
  gc: ['gc_events', 'garbage_collection', 'gc_analysis', 'gc_pauses'],
  memory: ['memory_events', 'allocations', 'oom_events', 'lmk_events', 'memory_stats'],
};

export function resolveCaptureEntityKindByStepId(
  stepId: string,
  matchMode: 'exact' | 'contains' = 'exact'
): EntityCaptureKind | null {
  const normalizedStepId = String(stepId || '').trim().toLowerCase();
  if (!normalizedStepId) return null;

  for (const kind of Object.keys(ENTITY_CAPTURE_STEP_PATTERNS) as EntityCaptureKind[]) {
    const patterns = ENTITY_CAPTURE_STEP_PATTERNS[kind];
    for (const pattern of patterns) {
      const normalizedPattern = pattern.toLowerCase();
      if (matchMode === 'exact' && normalizedStepId === normalizedPattern) {
        return kind;
      }
      if (matchMode === 'contains' && normalizedStepId.includes(normalizedPattern)) {
        return kind;
      }
    }
  }
  return null;
}
