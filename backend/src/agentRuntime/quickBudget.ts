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
  /**
   * The user question. Supplied instead of `profile` so the profile decision
   * sees both the query and the injected conversation turns it needs to tell a
   * bounded drill from a scene-wide ask.
   */
  query?: string;
  profile?: QuickRunProfile;
  budget: QuickRunTurnBudget;
  actualTurns: number;
  elapsedMs: number;
  stopReason: QuickRunStopReason;
  evidence?: Partial<QuickRunEvidenceCounts>;
  contextInjected?: Partial<QuickRunContextInjectedCounts>;
  verifierStatus?: QuickRunVerifierStatus;
  modeDecision?: QuickRunReceipt['modeDecision'];
  adaptiveRouting?: AdaptiveRoutingReceiptV1;
}): QuickRunReceipt {
  const actualTurns = Number.isFinite(input.actualTurns)
    ? Math.max(0, Math.floor(input.actualTurns))
    : 0;
  const extended = actualTurns > input.budget.targetTurns;
  const contextInjected = {
    ...EMPTY_QUICK_RUN_CONTEXT_COUNTS,
    ...(input.contextInjected ?? {}),
  };
  return {
    requestedMode: input.requestedMode,
    resolvedMode: input.resolvedMode ?? 'quick',
    profile: input.profile ?? resolveQuickRunProfile({
      query: input.query ?? '',
      conversationTurns: contextInjected.conversationTurns,
      extended,
    }),
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
    contextInjected,
    verifierStatus: input.verifierStatus ?? 'not_checked',
    ...(input.modeDecision ? {modeDecision: input.modeDecision} : {}),
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

/**
 * Broad diagnostic intent: the user is asking *why* something is slow or what
 * to do about it, rather than asking for a specific value.
 *
 * Intent alone never decides the profile — a bounded drill ("why is THIS frame
 * slow") carries the same words as a scene-wide ask ("why is scrolling janky").
 * Pair this with `hasResolvedBoundedTarget`.
 */
const BROAD_DIAGNOSTIC_INTENT_TOKENS = [
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
] as const;

/**
 * An explicit request for a complete/comprehensive treatment. This outranks
 * boundedness: "全面分析 frame 123" still exceeds what quick mode delivers,
 * even though the target is a single frame.
 */
const EXPLICIT_COMPLETENESS_REQUEST_PATTERN =
  /(?:全面|完整|全量|全景|comprehensive|complete|full)\s*(?:地|的)?\s*(?:分析|诊断|评估|报告|体检|analysis|diagnosis|report|assessment)/i;

/** Entity nouns a bounded drill can target. */
const BOUNDED_TARGET_ENTITY_PATTERN =
  /(?:帧|frame|slice|切片|线程|thread|进程|process|函数|方法|function|method|track|轨道|调用栈|call\s*stack)/i;

/**
 * Anaphora pointing at something an earlier turn produced. Only resolvable when
 * the session actually has prior turns — otherwise it is a dangling reference
 * and the question is effectively unbounded.
 */
const PRIOR_TURN_REFERENT_PATTERN =
  /(?:刚才|刚刚|上一(?:轮|条|次|个)|上条|上面|前面|之前|该|这个|这条|这一|那个|那条|那一|above|previous|earlier|that\s+one)/i;

/**
 * A single occurrence named in the query itself, independent of conversation
 * history: `frame 123`, `slice 456`, a quoted *symbol* (one carrying a `_`,
 * `.`, `#` or `::` separator), or a bare `Class#method` token.
 *
 * Quoting alone is not enough — `why is "scrolling" slow` quotes a scene, not
 * a target, and must stay a triage.
 *
 * Deliberately excludes process/thread identifiers. A pid bounds *which*
 * process, not *how much of the run* the question covers — "process 123 为什么慢"
 * is still a whole-run diagnosis, exactly like "主线程为什么慢".
 */
const SELF_CONTAINED_TARGET_PATTERN =
  /(?:frame|帧|slice|切片|event|事件)\s*[#=:：]?\s*\d+|[`"'][A-Za-z_][A-Za-z0-9_]*(?:[._#]|::)[A-Za-z0-9_][^`"']*[`"']|\b[A-Za-z_][A-Za-z0-9_]*(?:#|::)[A-Za-z0-9_]+/;

export function hasBroadDiagnosticIntent(query: string): boolean {
  const normalized = query.toLowerCase();
  return BROAD_DIAGNOSTIC_INTENT_TOKENS.some(token => normalized.includes(token));
}

/**
 * True when the question is scoped to one resolvable object rather than a whole
 * scene. Requires an entity noun plus either a self-contained identifier or an
 * anaphor that prior turns can actually resolve.
 */
export function hasResolvedBoundedTarget(
  query: string,
  conversationTurns: number,
): boolean {
  // An identifier or symbol in the query names the target on its own.
  if (SELF_CONTAINED_TARGET_PATTERN.test(query)) return true;
  // Otherwise the boundary has to come from an anaphor that prior turns can
  // resolve, pointing at an entity rather than at the whole trace.
  return conversationTurns > 0
    && PRIOR_TURN_REFERENT_PATTERN.test(query)
    && BOUNDED_TARGET_ENTITY_PATTERN.test(query);
}

/**
 * Decide the quick-run profile.
 *
 * `triage` means "the ask is broader than quick mode can deliver", which caps
 * the answer length and makes anything longer a quality-gate failure. It must
 * therefore reflect the question's *boundary*, not just its wording: a bounded
 * drill into one frame or thread is a normal quick answer even though it says
 * "慢" or "为什么". An explicit demand for a complete analysis stays triage
 * regardless of how narrow the target is.
 */
export function resolveQuickRunProfile(input: {
  query: string;
  conversationTurns: number;
  extended: boolean;
}): QuickRunProfile {
  const query = input.query ?? '';
  if (query.trim().length > 0 && hasBroadDiagnosticIntent(query)) {
    if (
      EXPLICIT_COMPLETENESS_REQUEST_PATTERN.test(query) ||
      !hasResolvedBoundedTarget(query, input.conversationTurns)
    ) {
      return 'triage';
    }
  }
  return input.extended ? 'extended' : 'normal';
}
