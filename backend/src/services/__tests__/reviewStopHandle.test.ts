// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {
  buildReviewNotFinishedResult,
  mayPersistUnverifiedBody,
  resolveReviewStopWatchdogMs,
  ReviewStopController,
  ReviewStopHandle,
  settlesWithin,
  type ReviewStopOwner,
} from '../reviewStopHandle';

describe('ReviewStopHandle', () => {
  it('turns every stop into a full stop before anything was delivered', () => {
    const handle = new ReviewStopHandle();
    expect(handle.requestStop()).toBe('full');
    // The owner's full abort ends the run; the review signal is not the abort channel.
    expect(handle.signal.aborted).toBe(false);
    expect(handle.requestStop()).toBe('noop');
    // A delivery that races a full stop cannot make the next stop review-only.
    handle.markDelivered();
    expect(handle.requestStop()).toBe('noop');
  });

  it('ends only the review on the first stop after delivery, then forces', () => {
    const handle = new ReviewStopHandle();
    handle.markDelivered();
    expect(handle.signal.aborted).toBe(false);
    expect(handle.requestStop()).toBe('review');
    expect(handle.signal.aborted).toBe(true);
    expect((handle.signal.reason as DOMException).message).toMatch(/review/i);
    expect(handle.requestStop()).toBe('full');
    expect(handle.requestStop()).toBe('noop');
  });
});

describe('ReviewStopController', () => {
  const owner = (overrides: Partial<ReviewStopOwner<string>> = {}) => ({
    mayPersistPartial: jest.fn(() => true),
    commitPartial: jest.fn((_body: string) => true),
    fullCancel: jest.fn(() => 'cancelled'),
    ...overrides,
  });

  it('arms no watchdog before delivery and keeps the delivered body', () => {
    const value = new ReviewStopController({owner: owner(), watchdogMs: 5});
    expect(value.requestStop()).toBe('full');
    expect(value.deliveredBody).toBeUndefined();
    const delivered = new ReviewStopController({owner: owner(), watchdogMs: 5});
    delivered.markDelivered('Body read.');
    expect(delivered.provisionalDelivered).toBe(true);
    expect(delivered.deliveredBody).toBe('Body read.');
    delivered.dispose();
  });

  it('waits for the commit and runs no expiry when the run settles in time', async () => {
    const callbacks = owner();
    const value = new ReviewStopController({owner: callbacks, watchdogMs: 1_000});
    value.markDelivered('Body read.');
    value.requestStop();
    await expect(value.awaitCommitOrExpire(Promise.resolve())).resolves.toBeUndefined();
    value.dispose();
    expect(callbacks.commitPartial).not.toHaveBeenCalled();
    expect(callbacks.fullCancel).not.toHaveBeenCalled();
  });

  it('expires once: the partial commit when the owner allows it, else the full cancel', async () => {
    const callbacks = owner();
    const value = new ReviewStopController({owner: callbacks, watchdogMs: 5});
    value.markDelivered('Body read.');
    value.requestStop();
    await expect(value.awaitCommitOrExpire(new Promise(() => undefined))).resolves.toEqual({kind: 'partial'});
    await expect(value.awaitCommitOrExpire(new Promise(() => undefined))).resolves.toEqual({kind: 'partial'});
    expect(callbacks.commitPartial).toHaveBeenCalledTimes(1);
    expect(callbacks.commitPartial).toHaveBeenCalledWith('Body read.');

    const excluded = owner({mayPersistPartial: jest.fn(() => false)});
    const other = new ReviewStopController({owner: excluded, watchdogMs: 5});
    other.markDelivered('Body read.');
    other.requestStop();
    await expect(other.awaitCommitOrExpire(new Promise(() => undefined)))
      .resolves.toEqual({kind: 'cancelled', value: 'cancelled'});
    expect(excluded.commitPartial).not.toHaveBeenCalled();
  });

  it('runs the expiry from the watchdog alone when no second stop arrives', async () => {
    const callbacks = owner();
    const value = new ReviewStopController({owner: callbacks, watchdogMs: 5});
    value.markDelivered('Body read.');
    value.requestStop();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(callbacks.commitPartial).toHaveBeenCalledTimes(1);
  });

  it('applies one exclusion rule for private runs, lost ownership and revoked authorization', () => {
    const current = {isCurrent: () => true, assertAuthorized: () => undefined};
    expect(mayPersistUnverifiedBody({privateKnowledge: false, ...current})).toBe(true);
    expect(mayPersistUnverifiedBody({privateKnowledge: true, ...current})).toBe(false);
    expect(mayPersistUnverifiedBody({...current, privateKnowledge: false, isCurrent: () => false})).toBe(false);
    expect(mayPersistUnverifiedBody({...current, privateKnowledge: false,
      assertAuthorized: () => { throw new Error('revoked'); }})).toBe(false);
  });
});

describe('review stop watchdog', () => {
  it('defaults to 15 s and never drops below 10 s', () => {
    expect(resolveReviewStopWatchdogMs({})).toBe(15_000);
    expect(resolveReviewStopWatchdogMs({SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS: '30000'})).toBe(30_000);
    expect(resolveReviewStopWatchdogMs({SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS: '2000'})).toBe(10_000);
    expect(resolveReviewStopWatchdogMs({SMARTPERFETTO_REVIEW_STOP_WATCHDOG_MS: 'soon'})).toBe(15_000);
  });

  it('reports whether a promise settled within a bound or before a deadline promise', async () => {
    await expect(settlesWithin(Promise.resolve(), 50)).resolves.toBe(true);
    await expect(settlesWithin(Promise.reject(new Error('failed')), 50)).resolves.toBe(true);
    await expect(settlesWithin(new Promise(() => undefined), 5)).resolves.toBe(false);
    await expect(settlesWithin(new Promise(() => undefined), Promise.resolve())).resolves.toBe(false);
  });

  it('builds an incomplete, unverified fallback turn from the read body only', () => {
    const result = buildReviewNotFinishedResult({sessionId: 's', conclusion: 'Body the user read.', outputLanguage: 'zh-CN'});
    expect(result).toMatchObject({conclusion: 'Body the user read.', partial: true, terminationReason: 'review_not_finished',
      terminationMessage: '语义复核未完成：此结论未经核验。',
      claimVerificationResult: {status: 'not_checked', notCheckedReason: 'review_not_finished', passed: false}});
    expect(result).not.toHaveProperty('conclusionContract');
    expect(result).not.toHaveProperty('completion');
  });
});
