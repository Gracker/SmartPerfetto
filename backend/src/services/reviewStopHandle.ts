// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {reviewStoppedByUser} from './finalSemanticAssessment';

/**
 * What one stop request means for a run that may still be reviewing a
 * delivered answer:
 * - `review`: the answer is on screen and its review is still owed; end only
 *   the review, the run then commits its normal `~` turn.
 * - `full`: nothing was delivered yet, or the review was already asked to stop
 *   (a second stop is an explicit force); the owner aborts the run.
 * - `noop`: a full stop was already requested.
 */
export type ReviewStopRequest = 'review' | 'full' | 'noop';

/**
 * Stop state of one run, shared by the agent route, the conversation service
 * and the CLI. It is only a state machine: each owner keeps its own
 * single-active execution and terminal commit.
 */
export class ReviewStopHandle {
  private readonly controller = new AbortController();
  private delivered = false;
  private requested: 'none' | 'review' | 'full' = 'none';

  /** Aborted (with a `cancelled_by_user` reason) when the review must end. */
  get signal(): AbortSignal { return this.controller.signal; }

  /** The user has read the answer; the next stop ends only its review. */
  get provisionalDelivered(): boolean { return this.delivered; }

  markDelivered(): void { this.delivered = true; }

  requestStop(): ReviewStopRequest {
    if (this.requested === 'full') return 'noop';
    if (this.delivered && this.requested === 'none') {
      this.requested = 'review';
      this.controller.abort(reviewStoppedByUser());
      return 'review';
    }
    // The owner's full abort ends everything, a review included; after a
    // review-only stop the review signal is already aborted.
    this.requested = 'full';
    return 'full';
  }
}

const DEFAULT_REVIEW_STOP_WATCHDOG_MS = 15_000;
/** Above the 5 s SQLite busy_timeout, so a contended commit is not mistaken for a hang. */
const MIN_REVIEW_STOP_WATCHDOG_MS = 10_000;

/**
 * How long a run may take to commit after a review-only or force stop before
 * the owner falls back. Starts only at a stop request; finalization normally
 * settles in milliseconds, which is an expectation, not a correctness premise.
 */
export function resolveReviewStopWatchdogMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) return DEFAULT_REVIEW_STOP_WATCHDOG_MS;
  return Math.max(MIN_REVIEW_STOP_WATCHDOG_MS, parsed);
}

/**
 * True when the promise settled (resolved or rejected) before the deadline: a
 * number of milliseconds, or a promise that resolves when the deadline passes.
 */
export async function settlesWithin(promise: Promise<unknown>, deadline: number | Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = typeof deadline === 'number'
    ? new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.max(0, Math.min(deadline, 2_147_483_647)));
        timer.unref?.();
      })
    : deadline;
  try {
    return await Promise.race([promise.then(() => true, () => true), expired.then(() => false)]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REVIEW_NOT_FINISHED = 'review_not_finished' as const;

/**
 * Watchdog fallback for a delivered answer whose finalization never settled:
 * the provisional body the user read, recorded as an incomplete, unverified
 * turn. It carries no claims or verification of its own; the caller copies the
 * run's pins (source partition, owner projection) exactly as for a normal turn.
 */
export function buildReviewNotFinishedResult(input: {
  sessionId: string;
  conclusion: string;
  outputLanguage: OutputLanguage;
  base?: Pick<AnalysisResult, 'findings' | 'hypotheses' | 'rounds' | 'totalDurationMs' | 'confidence'>;
}): AnalysisResult {
  return {
    sessionId: input.sessionId, success: true,
    findings: input.base?.findings ? [...input.base.findings] : [],
    hypotheses: input.base?.hypotheses ? [...input.base.hypotheses] : [],
    conclusion: input.conclusion,
    confidence: input.base?.confidence ?? 0,
    rounds: input.base?.rounds ?? 0,
    totalDurationMs: input.base?.totalDurationMs ?? 0,
    partial: true,
    terminationReason: REVIEW_NOT_FINISHED,
    terminationMessage: localize(input.outputLanguage, '语义复核未完成：此结论未经核验。',
      'The semantic review did not finish: this answer is unverified.'),
    claimVerificationResult: {
      schemaVersion: 'claim_verifier@2', status: 'not_checked', policy: 'record_only',
      notCheckedReason: REVIEW_NOT_FINISHED, passed: false,
      checkedClaimCount: 0, unsupportedClaimCount: 0, claimResults: [], issues: [],
    },
  };
}

/**
 * The one exclusion rule for the fallback: an unverified body is persisted only
 * for a non-private run that still owns its session and whose authorization
 * still holds. Otherwise it stays live-only and the stop is the full cancel.
 */
export function mayPersistUnverifiedBody(input: {
  privateKnowledge: boolean;
  isCurrent(): boolean;
  assertAuthorized(): void;
}): boolean {
  if (input.privateKnowledge || !input.isCurrent()) return false;
  try {
    input.assertAuthorized();
    return true;
  } catch {
    return false;
  }
}

/** What an owner supplies; everything else about a stop lives in the controller. */
export interface ReviewStopOwner<T> {
  /** See mayPersistUnverifiedBody; also false once the run has committed. */
  mayPersistPartial(): boolean;
  /** Commit the read body as an unverified partial turn; false when another commit won. */
  commitPartial(body: string): boolean;
  /** The full abort; the body stays live-only. A no-op for a settled run. */
  fullCancel(): T | Promise<T>;
}

/** What the watchdog expiry did: kept the body as a partial turn, or fully cancelled. */
export type ReviewStopExpiry<T> = {kind: 'partial'} | {kind: 'cancelled'; value: T};

/**
 * One run's stop: delivery state, the delivered body, and the watchdog that a
 * stop after delivery arms once. On expiry the owner's partial commit is tried,
 * then its full cancel; the expiry runs at most once.
 */
export class ReviewStopController<T> {
  private readonly handle = new ReviewStopHandle();
  private body?: string;
  private watchdog?: {timer: ReturnType<typeof setTimeout>; elapsed: Promise<void>};
  private expiry?: Promise<ReviewStopExpiry<T>>;

  constructor(private readonly options: {owner: ReviewStopOwner<T>; watchdogMs: number}) {}

  get signal(): AbortSignal { return this.handle.signal; }

  get provisionalDelivered(): boolean { return this.handle.provisionalDelivered; }

  /** The body the user read (as the owner delivered it); the fallback only. */
  get deliveredBody(): string | undefined { return this.body; }

  markDelivered(body: string): void {
    this.body = body;
    this.handle.markDelivered();
  }

  /** A stop after delivery also arms the watchdog (once; later stops share it). */
  requestStop(): ReviewStopRequest {
    const request = this.handle.requestStop();
    if (this.handle.provisionalDelivered) this.armWatchdog();
    return request;
  }

  /**
   * Wait for the owner's commit (`settled`) up to the armed watchdog; if it has
   * not settled by then, run the one-time expiry and return what it did.
   */
  async awaitCommitOrExpire(settled: Promise<unknown>): Promise<ReviewStopExpiry<T> | undefined> {
    const elapsed = this.armWatchdog();
    return await settlesWithin(settled, elapsed) ? undefined : this.expire();
  }

  /** The run settled: the watchdog has nothing left to guard. */
  dispose(): void {
    if (this.watchdog) clearTimeout(this.watchdog.timer);
  }

  private armWatchdog(): Promise<void> {
    if (this.watchdog) return this.watchdog.elapsed;
    let fire!: () => void;
    const elapsed = new Promise<void>(resolve => {fire = resolve;});
    const timer = setTimeout(() => {
      fire();
      void this.expire().catch(() => undefined);
    }, this.options.watchdogMs);
    timer.unref?.();
    this.watchdog = {timer, elapsed};
    return elapsed;
  }

  private expire(): Promise<ReviewStopExpiry<T>> {
    this.expiry ??= Promise.resolve().then(async (): Promise<ReviewStopExpiry<T>> => {
      const {owner} = this.options;
      if (this.body?.trim() && owner.mayPersistPartial() && owner.commitPartial(this.body)) return {kind: 'partial'};
      return {kind: 'cancelled', value: await owner.fullCancel()};
    });
    return this.expiry;
  }
}
