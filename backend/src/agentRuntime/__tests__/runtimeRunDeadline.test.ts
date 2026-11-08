// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {createDeadlineRuntimeTimeout, createProgressAwareRunDeadline} from '../runtimeLimits';

const S = 1000;
// quick mode defaults: 40 s per turn × 50 turns, 60 min maximum run time
const budget = {baseBudgetMs: 2000 * S, perTurnMs: 40 * S, maxRunMs: 3600 * S, now: 0};

describe('progress-aware run deadline', () => {
  it('keeps the base budget when no progress is recorded', () => {
    const deadline = createProgressAwareRunDeadline(budget);
    expect(deadline.current()).toBe(2000 * S);
    expect(deadline.hardDeadlineAt).toBe(3600 * S);
    expect(deadline.deliveryReserveMs).toBe(600 * S);
  });

  it('does not change the base budget for rounds inside the per-turn estimate', () => {
    const deadline = createProgressAwareRunDeadline(budget);
    for (let t = 20; t <= 400; t += 20) deadline.recordProgress(t * S);
    expect(deadline.current()).toBe(2000 * S);
    expect(deadline.snapshot(400 * S)).toMatchObject({extended: false, progressCount: 20, recentSlowestRoundMs: 20 * S});
  });

  it('keeps a slow but producing Round 60 run alive past the fixed 2000 s wall', () => {
    // r60anrib_a2: tool results at these seconds; the final answer was still
    // being written when the fixed deadline killed the run at 2000 s.
    const deadline = createProgressAwareRunDeadline(budget);
    for (const t of [105, 249, 450, 784, 1312, 1355, 1428, 1453]) deadline.recordProgress(t * S);
    // the 528 s round is still in the recent window → grace 792 s
    expect(deadline.current()).toBe((1453 + 792) * S);
    for (const t of [1513, 1529, 1544]) deadline.recordProgress(t * S);
    // the outlier left the window, but a granted deadline never moves back
    expect(deadline.snapshot(1544 * S).recentSlowestRoundMs).toBe(60 * S);
    expect(deadline.current()).toBe((1453 + 792) * S);
    expect(deadline.snapshot(1544 * S)).toMatchObject({extended: true, progressCount: 11, progressExtensions: 4,
      outputExtensions: 0, deliveryReserveMs: 600 * S});
  });

  it('never extends into the fixed delivery reserve', () => {
    const deadline = createProgressAwareRunDeadline(budget);
    deadline.recordProgress(600 * S);
    deadline.recordProgress(2900 * S);
    expect(deadline.current()).toBe(3000 * S);
    expect(deadline.hardDeadlineAt - deadline.current()).toBe(deadline.deliveryReserveMs);
  });

  it('extends one bounded step only while provider output keeps arriving', () => {
    const deadline = createProgressAwareRunDeadline(budget);
    expect(deadline.extendIfStreaming(2000 * S)).toBe(false);
    deadline.recordOutput(1990 * S);
    expect(deadline.extendIfStreaming(2000 * S)).toBe(true);
    expect(deadline.current()).toBe(2040 * S);
    expect(deadline.snapshot().outputExtensions).toBe(1);
    // the last output is older than one per-turn window
    expect(deadline.extendIfStreaming(2040 * S + 1)).toBe(false);
    deadline.recordOutput(2995 * S);
    expect(deadline.extendIfStreaming(3000 * S)).toBe(false);
  });

  it('keeps a finalization reserve that a delivery call cannot consume', () => {
    const deadline = createProgressAwareRunDeadline(budget);
    // Finalization makes no model call: one bounded evidence read (1.5 s) plus a 1 s margin,
    // independent of the per-turn model estimate.
    expect(deadline.finalizationReserveMs).toBe(2500);
    expect(createProgressAwareRunDeadline({...budget, perTurnMs: 400 * S}).finalizationReserveMs).toBe(2500);
    // investigation stopped at 3000 s: delivery may use 600 − 2.5 s, finalization the rest
    expect(deadline.deliveryWindowMs(3000 * S)).toBe(600 * S - 2500);
    expect(deadline.finalizationDeadlineAt(3100 * S, 3600 * S - 2500)).toBe(3600 * S);
    // Without a delivery call the unspent delivery reserve funds finalization, bounded from now:
    // an early finish keeps the longer of its own deadline and that window, and nothing passes hard.
    expect(deadline.finalizationDeadlineAt(100 * S)).toBe(2000 * S);
    expect(deadline.finalizationDeadlineAt(1995 * S)).toBe(2595 * S);
    expect(deadline.finalizationDeadlineAt(3590 * S)).toBe(3600 * S);
    // a delivery call that ran keeps only the fixed finalization reserve after its own window
    expect(deadline.finalizationDeadlineAt(3100 * S, 3200 * S)).toBe(3200 * S + 2500);
  });

  it('bounds the unused-reserve window by the reserve itself, never by the whole hard budget', () => {
    const deadline = createProgressAwareRunDeadline(budget);
    // investigation ended at 1800 s with 1800 s left before hard: finalization gets 600 s, not 1800 s
    expect(deadline.finalizationDeadlineAt(1800 * S)).toBe(2400 * S);
    expect(deadline.investigationLimitAt).toBe(3000 * S);
  });

  it('treats a maximum below the base budget as the base budget and keeps no reserve', () => {
    const deadline = createProgressAwareRunDeadline({...budget, maxRunMs: 1});
    expect(deadline.hardDeadlineAt).toBe(2000 * S);
    expect(deadline.deliveryReserveMs).toBe(0);
    expect(deadline.deliveryWindowMs(1000 * S)).toBe(0);
    expect(deadline.finalizationDeadlineAt(1990 * S)).toBe(2000 * S);
    deadline.recordProgress(1990 * S);
    expect(deadline.current()).toBe(2000 * S);
  });

  it('subtracts preparation already spent from a short admission cap instead of raising it to base', () => {
    const deadline = createProgressAwareRunDeadline({...budget, now: 35 * S, hardDeadlineAt: 60 * S});
    expect(deadline.hardDeadlineAt).toBe(60 * S);
    expect(deadline.snapshot(35 * S).maxRunMs).toBe(25 * S);
    expect(deadline.deliveryReserveMs).toBe(4166);
    expect(deadline.finalizationReserveMs).toBe(17);
    deadline.recordProgress(58 * S);
    deadline.recordOutput(58 * S);
    expect(deadline.current()).toBe(60 * S - 4166);
    expect(deadline.extendIfStreaming(60 * S)).toBe(false);
    expect(deadline.finalizationDeadlineAt(59 * S)).toBe(60 * S);
    expect(deadline.deliveryWindowMs(60 * S)).toBe(0);
  });

  it('does not restart an admission cap that expired during preparation', () => {
    const deadline = createProgressAwareRunDeadline({...budget, now: 70 * S, hardDeadlineAt: 60 * S});
    expect(deadline.current()).toBe(60 * S);
    expect(deadline.snapshot(70 * S).maxRunMs).toBe(0);
    expect(deadline.deliveryReserveMs).toBe(0);
    expect(deadline.finalizationReserveMs).toBe(0);
    expect(deadline.deliveryWindowMs(70 * S)).toBe(0);
    expect(deadline.finalizationDeadlineAt(70 * S)).toBe(60 * S);
    deadline.recordProgress(70 * S);
    expect(deadline.current()).toBe(60 * S);
  });

  it('keeps legacy budgets unchanged under a later task cap and adds no reserve to a fixed native budget', () => {
    const original = createProgressAwareRunDeadline(budget);
    const laterCap = createProgressAwareRunDeadline({...budget, hardDeadlineAt: 7200 * S});
    for (const deadline of [original, laterCap]) {
      deadline.recordProgress(2500 * S);
      deadline.recordOutput(2600 * S);
    }
    expect(laterCap.snapshot(2600 * S)).toEqual(original.snapshot(2600 * S));
    expect(laterCap.finalizationReserveMs).toBe(original.finalizationReserveMs);
    const fixed = createProgressAwareRunDeadline({...budget, maxRunMs: budget.baseBudgetMs, hardDeadlineAt: 5 * S});
    expect(fixed.current()).toBe(5 * S);
    expect(fixed.deliveryReserveMs).toBe(0);
    expect(fixed.finalizationReserveMs).toBe(0);
  });

  it('rejects invalid internal task caps instead of removing the constraint', () => {
    expect(() => createProgressAwareRunDeadline({...budget, hardDeadlineAt: Number.NaN})).toThrow('runtime_task_deadline_invalid');
    expect(() => createProgressAwareRunDeadline({...budget, hardDeadlineAt: Number.POSITIVE_INFINITY})).toThrow('runtime_task_deadline_invalid');
  });
});

describe('deadline runtime timeout', () => {
  afterEach(() => {jest.useRealTimers();});

  it('re-arms when the deadline moved before it fires and rejects once it expires', async () => {
    jest.useFakeTimers({now: 0});
    let deadlineAt = 1000;
    const onTimeout = jest.fn();
    const timeout = createDeadlineRuntimeTimeout({deadlineAt: () => deadlineAt, onTimeout,
      message: now => `expired at ${now}`});
    const rejection = expect(timeout.promise).rejects.toThrow('expired at 3000');
    jest.advanceTimersByTime(500);
    deadlineAt = 3000;
    jest.advanceTimersByTime(600);
    expect(onTimeout).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1900);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await rejection;
  });

  it('asks for a bounded extension at the deadline and stops when it is refused', async () => {
    jest.useFakeTimers({now: 0});
    let deadlineAt = 100;
    const tryExtend = jest.fn((now: number) => {
      if (now >= 300) return false;
      deadlineAt = now + 100;
      return true;
    });
    const onTimeout = jest.fn();
    const timeout = createDeadlineRuntimeTimeout({deadlineAt: () => deadlineAt, tryExtend, onTimeout,
      message: () => 'expired'});
    const rejection = expect(timeout.promise).rejects.toThrow('expired');
    jest.advanceTimersByTime(299);
    expect(onTimeout).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(tryExtend).toHaveBeenCalledTimes(3);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await rejection;
  });

  it('does not fire after it is cleared', () => {
    jest.useFakeTimers({now: 0});
    const onTimeout = jest.fn();
    const timeout = createDeadlineRuntimeTimeout({deadlineAt: () => 10, onTimeout, message: () => 'expired'});
    void timeout.promise.catch(() => undefined);
    timeout.clear();
    jest.advanceTimersByTime(100);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
