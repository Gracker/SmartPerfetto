// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const DEFAULT_FULL_REQUEST_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Maximum run time a progressing run may be extended to, including its delivery call. */
export const DEFAULT_MAX_RUN_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS = 2_000;
export const DEFAULT_OPENAI_HISTORY_MAX_BYTES = 4 * 1024 * 1024;

export type RuntimeTimeoutKind = 'request' | 'stream_idle';

export function resolveFullRequestTimeoutMs(
  perTurnMs: number,
  maxTurns: number,
  hardLimitMs: number,
): number {
  return Math.min(perTurnMs * maxTurns, hardLimitMs);
}

function stringifyExternalValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[unserializable tool result]';
  }
}

export function summarizeExternalToolResult(
  value: unknown,
  maxChars = DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS,
): string {
  const serialized = stringifyExternalValue(value);
  if (serialized.length <= maxChars) return serialized;
  const marker = `\n[truncated external tool result; originalChars=${serialized.length}]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${serialized.slice(0, maxChars - marker.length)}${marker}`;
}

export function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Wall-clock budget for one analysis run that follows observed progress.
 *
 * `perTurnMs × maxTurns` assumes every model turn fits the per-turn estimate.
 * A slow but working endpoint breaks that assumption: Round 60 turns took
 * 144–528 s against a 40 s estimate, and a fixed deadline killed runs that were
 * still producing. The base budget stays the initial deadline, so fast
 * endpoints see no change. Each returned tool result moves the investigation
 * deadline to at least `now + grace`, where grace follows the slowest of the
 * recent rounds; a deadline that arrives while the provider is still emitting
 * output is extended one per-turn step at a time.
 *
 * The deadline never moves backwards and never enters the delivery reserve,
 * which is fixed at start below the hard deadline so a no-tool delivery call
 * always fits. Part of that reserve is kept for finalization: its evidence
 * reads are bounded by the deadline the run hands over, and a delivery call
 * that used the whole reserve would leave the answer it produced unverifiable.
 */
export interface FinalizationBudgetOptions {
  /** Spend the remaining budget up to the hard deadline instead of at most the delivery reserve. */
  useRemainingBudget?: boolean;
}

export interface ProgressAwareRunDeadline {
  readonly startedAt: number;
  /** Initial deadline span before any extension. */
  readonly baseBudgetMs: number;
  readonly perTurnMs: number;
  /** Fixed when the run starts; never extended. */
  readonly hardDeadlineAt: number;
  /** Fixed when the run starts; time kept for one no-tool delivery call and finalization. */
  readonly deliveryReserveMs: number;
  /** Fixed part of the delivery reserve that a delivery call may not consume. */
  readonly finalizationReserveMs: number;
  /** Fixed latest investigation deadline: `hardDeadlineAt - deliveryReserveMs`. */
  readonly investigationLimitAt: number;
  /** Current investigation deadline; monotone non-decreasing. */
  current(): number;
  /** A tool result returned to the model. */
  recordProgress(now?: number): void;
  /** The provider emitted output (text, reasoning or tool-call arguments). */
  recordOutput(now?: number): void;
  /** At the deadline: extend one bounded step if output arrived recently. */
  extendIfStreaming(now?: number): boolean;
  /** Window a delivery call may use from now, keeping the finalization reserve. */
  deliveryWindowMs(now?: number): number;
  /** One completed-answer protocol repair may use the delivery reserve, never the finalization reserve. */
  completedOutputRepairDeadlineAt(now?: number): number;
  /**
   * Deadline handed to finalization; never past the hard deadline. When no
   * delivery call ran, the unused delivery reserve funds finalization (at most
   * that reserve from now): its one no-tool semantic review is exactly the
   * call the reserve exists for. A report deliverable that will make that call
   * may use the whole remaining budget instead, because its quality gate fails
   * whenever the review does not finish.
   */
  finalizationDeadlineAt(now?: number, deliveryDeadlineAt?: number, options?: FinalizationBudgetOptions): number;
  snapshot(now?: number): RunDeadlineSnapshot;
}

export interface RunDeadlineSnapshot {
  baseBudgetMs: number;
  maxRunMs: number;
  elapsedMs: number;
  deadlineMs: number;
  deliveryReserveMs: number;
  progressCount: number;
  recentSlowestRoundMs: number;
  /** Times a returned tool result, or recent provider output at the deadline, moved it forward. */
  progressExtensions: number;
  outputExtensions: number;
  extended: boolean;
}

const RECENT_ROUND_WINDOW = 4;

export function createProgressAwareRunDeadline(input: {
  baseBudgetMs: number;
  perTurnMs: number;
  /** Maximum run time including extensions; values below the base budget use the base budget. */
  maxRunMs: number;
  now?: number;
}): ProgressAwareRunDeadline {
  const positive = (value: number, fallback: number) =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const startedAt = input.now ?? Date.now();
  const perTurnMs = positive(input.perTurnMs, 1);
  const baseBudgetMs = positive(input.baseBudgetMs, perTurnMs);
  const maxRunMs = Math.max(baseBudgetMs, positive(input.maxRunMs, baseBudgetMs));
  const hardDeadlineAt = startedAt + maxRunMs;
  const deliveryReserveMs = Math.min(Math.max(perTurnMs, Math.floor(maxRunMs / 6)), maxRunMs - baseBudgetMs);
  const finalizationReserveMs = Math.min(perTurnMs, Math.floor(deliveryReserveMs / 4));
  const investigationLimitAt = hardDeadlineAt - deliveryReserveMs;
  let deadlineAt = startedAt + baseBudgetMs;
  let lastProgressAt = startedAt;
  let lastOutputAt: number | undefined;
  let progressCount = 0;
  let progressExtensions = 0;
  let outputExtensions = 0;
  const recentRounds: number[] = [];
  const recentSlowest = () => recentRounds.reduce((max, value) => Math.max(max, value), 0);
  const current = () => Math.min(deadlineAt, investigationLimitAt);
  return {
    startedAt,
    baseBudgetMs,
    perTurnMs,
    hardDeadlineAt,
    deliveryReserveMs,
    finalizationReserveMs,
    investigationLimitAt,
    current,
    recordProgress(now = Date.now()) {
      progressCount++;
      recentRounds.push(Math.max(0, now - lastProgressAt));
      if (recentRounds.length > RECENT_ROUND_WINDOW) recentRounds.shift();
      lastProgressAt = now;
      const before = current();
      deadlineAt = Math.max(deadlineAt, now + Math.max(perTurnMs, Math.ceil(recentSlowest() * 1.5)));
      if (current() > before && current() > startedAt + baseBudgetMs) progressExtensions++;
    },
    recordOutput(now = Date.now()) {
      lastOutputAt = now;
    },
    extendIfStreaming(now = Date.now()) {
      if (lastOutputAt === undefined || now - lastOutputAt > perTurnMs || now >= investigationLimitAt) return false;
      deadlineAt = Math.max(deadlineAt, now + perTurnMs);
      if (current() <= now) return false;
      outputExtensions++;
      return true;
    },
    deliveryWindowMs(now = Date.now()) {
      return Math.max(0, Math.min(deliveryReserveMs, hardDeadlineAt - now) - finalizationReserveMs);
    },
    completedOutputRepairDeadlineAt(now = Date.now()) {
      // Preserve an already longer investigation window. A late protocol repair
      // gets the same bounded delivery reserve as a no-tool timeout closeout;
      // this does not move the investigation or hard deadline.
      return Math.min(hardDeadlineAt - finalizationReserveMs,
        Math.max(current(), now + deliveryReserveMs - finalizationReserveMs));
    },
    finalizationDeadlineAt(now = Date.now(), deliveryDeadlineAt?: number, options: FinalizationBudgetOptions = {}) {
      // A delivery window already excluded the reserve. Without a delivery call the
      // reserve is unspent: finalization may use it, bounded from now and by the hard deadline.
      if (deliveryDeadlineAt !== undefined) return Math.min(hardDeadlineAt, deliveryDeadlineAt + finalizationReserveMs);
      if (options.useRemainingBudget) return hardDeadlineAt;
      return Math.min(hardDeadlineAt, Math.max(current(), now + finalizationReserveMs, now + deliveryReserveMs));
    },
    snapshot(now = Date.now()) {
      return {baseBudgetMs, maxRunMs, elapsedMs: now - startedAt, deadlineMs: current() - startedAt, deliveryReserveMs,
        progressCount, recentSlowestRoundMs: recentSlowest(), progressExtensions, outputExtensions,
        extended: current() > startedAt + baseBudgetMs};
    },
  };
}

/** A timeout that re-reads its deadline when it fires instead of fixing a delay up front. */
export function createDeadlineRuntimeTimeout(input: {
  deadlineAt: () => number;
  /** Called at the deadline; returning true means the deadline moved and the timer re-arms. */
  tryExtend?: (now: number) => boolean;
  message: (now: number) => string;
  onTimeout: () => void;
}): ResettableRuntimeTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  let settled = false;
  const promise = new Promise<never>((_, reject) => {rejectTimeout = reject;});
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    if (settled) return;
    clearTimer();
    // setTimeout clamps delays above 2^31-1 ms; re-arming handles longer budgets.
    const delay = Math.max(0, Math.min(input.deadlineAt() - Date.now(), 2_147_483_647));
    timer = setTimeout(() => {
      if (settled) return;
      timer = undefined;
      const now = Date.now();
      if (now < input.deadlineAt() || input.tryExtend?.(now)) {arm(); return;}
      settled = true;
      input.onTimeout();
      rejectTimeout?.(new Error(input.message(now)));
    }, delay);
  };
  arm();
  return {promise, reset: arm, clear: () => {settled = true; clearTimer();}};
}

export interface ResettableRuntimeTimeout {
  readonly promise: Promise<never>;
  reset(): void;
  clear(): void;
}

export function createResettableRuntimeTimeout(input: {
  timeoutMs: number;
  message: string;
  onTimeout: () => void;
}): ResettableRuntimeTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  let settled = false;
  const promise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    if (settled) return;
    clear();
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timer = undefined;
      input.onTimeout();
      rejectTimeout?.(new Error(input.message));
    }, input.timeoutMs);
  };
  reset();
  return {
    promise,
    reset,
    clear: () => {
      settled = true;
      clear();
    },
  };
}
