// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * A supplement a user sends to a running analysis. `delivered` means it entered
 * the agent's context; it does not claim the provider received it.
 */
export type RunSupplementState = 'classifying' | 'queued' | 'delivered' | 'restart_required' | 'rejected' | 'not_applied';
export type RunSupplementNotAppliedReason = 'window_closed' | 'turn_budget' | 'run_stopped' | 'run_failed';
export type RunSupplementRejectedReason = 'classification_unavailable' | 'policy';
export type RunSupplementRestartReason = 'goal_changed' | 'scene_changed' | 'scope_changed' | 'trace_changed'
  | 'provider_changed' | 'authorization_changed' | 'needs_selection' | 'evidence_access_changed'
  | 'deliverable_changed' | 'budget_changed';
export type RunSupplementReason = RunSupplementNotAppliedReason | RunSupplementRejectedReason | RunSupplementRestartReason;
export type RunSupplementDisposition = 'in_place' | 'restart_required';

/** Ids and enums only: the supplement text and its hash never appear here. */
export interface RunSupplementReceipt {
  id: string;
  runId: string;
  sequence: number;
  state: RunSupplementState;
  reason?: RunSupplementReason;
  disposition?: RunSupplementDisposition;
}

/** A delivered supplement kept with the result; private runs carry no text. */
export interface RunSupplementRecord {
  id: string;
  sequence: number;
  deliveredRequestIndex?: number;
  text?: string;
}

/** SSE `run_supplement`: the receipt after each state change. */
export interface RunSupplementEvent {
  type: 'run_supplement';
  id: string;
  data: RunSupplementReceipt;
  timestamp: number;
}
