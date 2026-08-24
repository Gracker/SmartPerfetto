// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  DEFAULT_AGENT_QUICK_TARGET_TURNS,
  resolveAgentRuntimeBudgetConfig,
} from '../config';
import type {
  QuickRunContextInjectedCounts,
  QuickRunEvidenceCounts,
  QuickRunProfile,
  QuickRunReceipt,
  QuickRunRequestedMode,
  QuickRunResolvedMode,
  QuickRunStopReason,
  QuickRunTurnBudget,
  QuickRunVerifierStatus,
} from '../agent/core/orchestratorTypes';
import type {AdaptiveRoutingReceiptV1} from '../types/adaptiveRouting';
import {parseAdaptiveRoutingReceipt} from './adaptiveEvidenceRouter';

function parsePositiveIntEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ResolveQuickTurnBudgetInput {
  env?: Record<string, string | undefined>;
  hardCapTurns?: number;
  targetTurns?: number;
  targetEnvKeys?: string[];
  hardCapEnvKeys?: string[];
  enforcement?: QuickRunTurnBudget['enforcement'];
}

export function resolveQuickTurnBudget(input: ResolveQuickTurnBudgetInput = {}): QuickRunTurnBudget {
  const env = input.env ?? process.env;
  const shared = resolveAgentRuntimeBudgetConfig(env);
  let hardCapTurns = input.hardCapTurns ?? shared.quickMaxTurns;
  for (const key of input.hardCapEnvKeys ?? []) {
    hardCapTurns = parsePositiveIntEnv(env, key, hardCapTurns);
  }
  const sharedTarget = shared.quickTargetTurns || DEFAULT_AGENT_QUICK_TARGET_TURNS;
  let targetTurns = input.targetTurns ?? sharedTarget;
  for (const key of input.targetEnvKeys ?? []) {
    targetTurns = parsePositiveIntEnv(env, key, targetTurns);
  }
  hardCapTurns = Math.max(1, hardCapTurns);
  targetTurns = Math.min(Math.max(1, targetTurns), hardCapTurns);
  return {
    targetTurns,
    hardCapTurns,
    extended: false,
    enforcement: input.enforcement ?? 'turn_cap',
  };
}

export const EMPTY_QUICK_RUN_EVIDENCE_COUNTS: QuickRunEvidenceCounts = {
  frontendPrequeryInjected: 0,
  frontendPrequeryCited: 0,
  currentRunDataEnvelopes: 0,
  citedEvidenceRefs: 0,
};

export const EMPTY_QUICK_RUN_CONTEXT_COUNTS: QuickRunContextInjectedCounts = {
  conversationTurns: 0,
  recentSqlResults: 0,
  sqlPitfallPairs: 0,
  patternHints: 0,
  negativePatternHints: 0,
  caseBackgroundCases: 0,
};

export function buildQuickRunReceipt(input: {
  requestedMode: QuickRunRequestedMode;
  resolvedMode?: QuickRunResolvedMode;
  profile?: QuickRunProfile;
  budget: QuickRunTurnBudget;
  actualTurns: number;
  elapsedMs: number;
  stopReason: QuickRunStopReason;
  evidence?: Partial<QuickRunEvidenceCounts>;
  contextInjected?: Partial<QuickRunContextInjectedCounts>;
  verifierStatus?: QuickRunVerifierStatus;
  adaptiveRouting?: AdaptiveRoutingReceiptV1;
}): QuickRunReceipt {
  const actualTurns = Number.isFinite(input.actualTurns)
    ? Math.max(0, Math.floor(input.actualTurns))
    : 0;
  const extended = actualTurns > input.budget.targetTurns;
  return {
    requestedMode: input.requestedMode,
    resolvedMode: input.resolvedMode ?? 'quick',
    profile: input.profile ?? (extended ? 'extended' : 'normal'),
    targetTurns: input.budget.targetTurns,
    hardCapTurns: input.budget.hardCapTurns,
    actualTurns,
    elapsedMs: Math.max(0, Math.floor(input.elapsedMs)),
    enforcement: input.budget.enforcement,
    stopReason: input.stopReason,
    evidence: {
      ...EMPTY_QUICK_RUN_EVIDENCE_COUNTS,
      ...(input.evidence ?? {}),
    },
    contextInjected: {
      ...EMPTY_QUICK_RUN_CONTEXT_COUNTS,
      ...(input.contextInjected ?? {}),
    },
    verifierStatus: input.verifierStatus ?? 'not_checked',
    ...(input.adaptiveRouting
      ? {adaptiveRouting: parseAdaptiveRoutingReceipt(input.adaptiveRouting)}
      : {}),
  };
}

export function quickStopReasonFromTermination(input: {
  partial?: boolean;
  terminationReason?: string;
  actualTurns: number;
  targetTurns: number;
  hardCapTurns: number;
}): QuickRunStopReason {
  if (input.terminationReason === 'timeout') return 'timeout';
  if (input.terminationReason === 'max_turns' || input.actualTurns >= input.hardCapTurns) return 'hard_cap';
  if (input.partial) return 'partial';
  if (input.actualTurns > input.targetTurns) return 'extended_answered';
  return 'answered';
}

export function shouldMarkQuickRunTriage(query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    '根因',
    '为什么',
    '怎么优化',
    '优化建议',
    '全面',
    '完整分析',
    '完整诊断',
    '性能分析',
    '卡顿',
    '慢',
    'root cause',
    'why',
    'optimize',
    'optimization',
    'full diagnosis',
    'complete diagnosis',
    'comprehensive',
  ].some(token => normalized.includes(token));
}
