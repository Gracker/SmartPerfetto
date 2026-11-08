// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The runtime-independent contract of one isolated one-shot model call: its
// request, its result and the shared wall-clock budget rule. The shared
// dispatcher (`services/oneShotModelCall.ts`) and each runtime branch use it.

import type {AiSummaryFallbackReason} from '../types/criticalPathContract';
import type {EffortLevel} from './engines/claude/claudeConfig';

/** Why a one-shot call produced no model answer. */
export type OneShotFallbackReason = AiSummaryFallbackReason;

export type OneShotResult =
  | {ok: true; text: string; model: string}
  | {ok: false; reason: OneShotFallbackReason; model?: string};

/** One call's request, independent of the runtime that answers it. */
export interface OneShotCallInput {
  prompt: string;
  /** `light` uses the profile's light model and falls back to the main one (Claude only; Pi has one model). */
  tier: 'main' | 'light';
  effort?: EffortLevel;
  timeoutMs: number;
  signal?: AbortSignal;
  logLabel: string;
}

/** The wall-clock budget of one call; a missing or invalid budget is 60 s. */
export function effectiveOneShotTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
}
