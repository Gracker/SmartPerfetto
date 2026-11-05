// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {assertRuntimeTaskWorkRemaining, RuntimeTaskDeadlineExceededError,
  createRuntimeAdmissionScope, ensureRuntimeAdmission, readRuntimeAdmission, forwardRuntimeAdmission,
  type RuntimeAdmissionScope} from '../runtimeTaskDeadline';

const identity = {runId: 'run-a', sessionId: 'native-a'};
const admissions: RuntimeAdmissionScope[] = [];
function createScope(input: Partial<Parameters<typeof createRuntimeAdmissionScope>[0]> = {}): RuntimeAdmissionScope {
  const scope = createRuntimeAdmissionScope({runId: identity.runId, admittedAt: 0,
    taskTimeoutMs: 60_000, assertCurrent() {}, ...input});
  admissions.push(scope);
  return scope;
}

beforeEach(() => {jest.useFakeTimers({now: 0});});
afterEach(() => {
  for (const scope of admissions.splice(0)) scope.dispose();
  jest.useRealTimers();
});

describe('single run admission envelope', () => {
  it('issues default admission without a timer and preserves unnormalized option shapes through whitelists', () => {
    const scope = createRuntimeAdmissionScope({runId: identity.runId, admittedAt: 0, assertCurrent() {}});
    admissions.push(scope);
    const timeRange: unknown = {start: 'unparsed'};
    const bound = scope.bind({analysisMode: 'auto' as const, timeRange}, identity.sessionId);
    const mode: 'auto' = bound.analysisMode;
    expect(mode).toBe('auto');
    expect(bound.timeRange).toBe(timeRange);
    const forwarded = forwardRuntimeAdmission({...bound}, {requiredValue: 42, timeRange});
    expect(forwarded.requiredValue).toBe(42);
    expect(readRuntimeAdmission(forwarded, identity)?.facts).toBe(scope.facts);
    expect(readRuntimeAdmission(forwarded, identity)?.task).toBeUndefined();
    expect(Object.isFrozen(scope.facts)).toBe(true);
    expect(Object.getOwnPropertySymbols(bound)).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(readRuntimeAdmission(JSON.parse(JSON.stringify(bound)) as object, identity)).toBeUndefined();
  });

  it('does not reset default admission or create a timer from a later raw timeout', () => {
    const created = ensureRuntimeAdmission({}, {...identity, admittedAt: 0, assertCurrent() {}});
    try {
      jest.setSystemTime(35_000);
      const modified = {...created.options, taskTimeoutMs: 60_000};
      const borrowed = ensureRuntimeAdmission(modified, {...identity, admittedAt: Date.now(), assertCurrent() {}});
      expect(borrowed.admission).toBe(created.admission);
      expect(borrowed.admission.facts.admittedAt).toBe(0);
      expect(borrowed.admission.task).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      borrowed.disposeOwned();
      expect(readRuntimeAdmission(created.options, identity)).toBe(created.admission);
    } finally {created.disposeOwned();}
    expect(() => ensureRuntimeAdmission(created.options, {...identity, admittedAt: 40_000, assertCurrent() {}}))
      .toThrow('disposed');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps an existing explicit binding at its original admission without issuing a second identity or timer', () => {
    const scope = createScope();
    const bound = scope.bind({taskTimeoutMs: 60_000}, identity.sessionId);
    jest.advanceTimersByTime(35_000);
    const ensured = ensureRuntimeAdmission(bound, {...identity, admittedAt: Date.now(), assertCurrent() {}});
    expect(ensured.admission.facts.admittedAt).toBe(scope.facts.admittedAt);
    expect(ensured.admission.task).toBe(readRuntimeAdmission(bound, identity)?.task);
    expect(ensured.admission.task?.facts.hardDeadlineAt).toBe(60_000);
    expect(jest.getTimerCount()).toBe(1);
    ensured.disposeOwned();
    expect(readRuntimeAdmission(bound, identity)).toBe(ensured.admission);
  });

  it('rejects default identity conflicts and synchronous disposal without falling back to a new admission', () => {
    const scope = createRuntimeAdmissionScope({runId: identity.runId, admittedAt: 0, assertCurrent() {}});
    admissions.push(scope);
    const options = scope.bind({}, identity.sessionId);
    expect(() => ensureRuntimeAdmission(options, {...identity, runId: 'foreign', admittedAt: 1000, assertCurrent() {}}))
      .toThrow('identity_mismatch');
    expect(() => ensureRuntimeAdmission(options, {...identity, sessionId: 'foreign', admittedAt: 1000, assertCurrent() {}}))
      .toThrow('identity_mismatch');
    expect(() => ensureRuntimeAdmission(options, {...identity, admittedAt: 1000, assertCurrent: () => scope.dispose()}))
      .toThrow('disposed');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('issued task deadline', () => {
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'issues admission with valid ownership but no explicit timer for %s', taskTimeoutMs => {
      const assertCurrent = jest.fn();
      const ensured = ensureRuntimeAdmission({taskTimeoutMs}, {...identity, admittedAt: 0, assertCurrent});
      try {
        expect(ensured.admission.facts).toEqual({schemaVersion: 1, runId: identity.runId, admittedAt: 0});
        expect(ensured.admission.task).toBeUndefined();
        expect(assertCurrent).toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
      } finally {ensured.disposeOwned();}
    });

  it('keeps the admission deadline after classification and preparation; expiry does not cancel the owner', () => {
    const owner = new AbortController();
    const scope = createScope({ownerSignal: owner.signal});
    const options = scope.bind({taskTimeoutMs: 60_000}, identity.sessionId);
    jest.advanceTimersByTime(35_000);
    const ensured = ensureRuntimeAdmission({...options, taskTimeoutMs: 600_000},
      {...identity, admittedAt: Date.now(), assertCurrent() {}});
    expect(ensured.admission.task?.facts).toEqual({schemaVersion: 1, source: 'task_timeout', runId: identity.runId,
      admittedAt: 0, hardDeadlineAt: 60_000});
    expect(Object.isFrozen(ensured.admission.task?.facts)).toBe(true);
    ensured.disposeOwned(); // The native consumer does not own the product admission.
    jest.advanceTimersByTime(25_000);
    expect(scope.task!.deadlineSignal.aborted).toBe(true);
    expect(scope.task!.deadlineSignal.reason).toBeInstanceOf(RuntimeTaskDeadlineExceededError);
    expect(owner.signal.aborted).toBe(false);
    // Current ownership remains valid for deterministic finalization of the original body.
    expect(readRuntimeAdmission(options, identity)?.task?.facts.hardDeadlineAt).toBe(60_000);
  });

  it('exposes already-expired preparation synchronously without granting another millisecond', () => {
    jest.setSystemTime(70_000);
    const scope = createScope();
    expect(scope.task!.deadlineSignal.aborted).toBe(true);
    expect(scope.task!.facts.hardDeadlineAt).toBe(60_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(() => assertRuntimeTaskWorkRemaining(scope.task)).toThrow(RuntimeTaskDeadlineExceededError);
  });

  it('blocks work at the absolute cap before the timer receives an event-loop turn', () => {
    const scope = createScope();
    jest.setSystemTime(60_000);
    expect(scope.task!.deadlineSignal.aborted).toBe(false);
    expect(() => assertRuntimeTaskWorkRemaining(scope.task)).toThrow(RuntimeTaskDeadlineExceededError);
    expect(() => assertRuntimeTaskWorkRemaining(undefined)).not.toThrow();
  });

  it('survives internal spreads and explicit whitelists but cannot be restored from JSON', () => {
    const scope = createScope();
    const options = scope.bind({taskTimeoutMs: 60_000, outputLanguage: 'zh-CN' as const}, identity.sessionId);
    const spread = {...options, analysisMode: 'fast' as const};
    const forwarded = forwardRuntimeAdmission(spread, {outputLanguage: 'en' as const});
    expect(readRuntimeAdmission(forwarded, identity)?.task).toBe(readRuntimeAdmission(options, identity)?.task);
    const json = JSON.stringify(options);
    expect(json).not.toMatch(/hardDeadlineAt|admittedAt|deadlineSignal|runtimeTaskDeadline/);
    expect(readRuntimeAdmission(JSON.parse(json) as AnalysisOptions, identity)?.task).toBeUndefined();
    const plain = {runId: identity.runId, hardDeadlineAt: 900_000, runtimeTaskDeadline: scope.facts};
    expect(readRuntimeAdmission(plain, identity)?.task).toBeUndefined();
  });

  it('rejects a forged symbol token instead of reissuing the raw timeout', () => {
    const options = createScope().bind({taskTimeoutMs: 60_000}, identity.sessionId);
    const [symbol] = Object.getOwnPropertySymbols(options);
    const forged = {...options, [symbol!]: Object.freeze({})};
    const timerCount = jest.getTimerCount();
    expect(() => ensureRuntimeAdmission(forged, {...identity, admittedAt: 50_000, assertCurrent() {}}))
      .toThrow('runtime_task_deadline_unissued');
    expect(jest.getTimerCount()).toBe(timerCount);
  });

  it('rejects conflicting run/session/options identities without changing the original binding', () => {
    const scope = createScope();
    const options = scope.bind({}, identity.sessionId);
    expect(() => readRuntimeAdmission(options, {...identity, runId: 'run-b'})?.task).toThrow('identity_mismatch');
    expect(() => readRuntimeAdmission(options, {...identity, sessionId: 'native-b'})?.task).toThrow('identity_mismatch');
    expect(() => readRuntimeAdmission({...options, runId: 'run-b'}, identity)?.task).toThrow('identity_mismatch');
    expect(() => scope.bind({}, 'native-b')).toThrow('identity_mismatch');
    expect(() => forwardRuntimeAdmission(options, {runId: 'run-b'})).toThrow('identity_mismatch');
    expect(readRuntimeAdmission(scope.bind(options, identity.sessionId), identity)?.task?.facts).toBe(scope.task!.facts);
  });

  it('cannot overwrite another issued scope, even with the same run/session identifiers', () => {
    const first = createScope();
    const second = createScope({taskTimeoutMs: 90_000});
    const a = first.bind({}, identity.sessionId);
    const b = second.bind({}, identity.sessionId);
    expect(() => first.bind(b, identity.sessionId)).toThrow('binding_conflict');
    expect(() => forwardRuntimeAdmission(a, b)).toThrow('binding_conflict');
    expect(readRuntimeAdmission(b, identity)?.task?.facts.hardDeadlineAt).toBe(90_000);
  });

  it('disposes only its own lifetime and rejects late forwarding or fallback', () => {
    const expiredObserver = jest.fn();
    const old = createScope();
    const bound = old.bind({taskTimeoutMs: 60_000}, identity.sessionId);
    old.task!.deadlineSignal.addEventListener('abort', expiredObserver);
    const next = createScope({runId: 'run-b', taskTimeoutMs: 90_000});
    old.dispose();
    old.dispose();
    expect(() => forwardRuntimeAdmission(bound, {})).toThrow('disposed');
    expect(() => ensureRuntimeAdmission(bound, {...identity, admittedAt: 50_000, assertCurrent() {}})).toThrow('disposed');
    jest.advanceTimersByTime(60_000);
    expect(expiredObserver).not.toHaveBeenCalled();
    expect(next.task!.deadlineSignal.aborted).toBe(false);
    jest.advanceTimersByTime(30_000);
    expect(next.task!.deadlineSignal.aborted).toBe(true);
  });

  it('drops a stale timer without invoking its old work listeners or throwing from the timer', () => {
    let current = true;
    const scope = createScope({assertCurrent: () => {if (!current) throw new Error('superseded');}});
    const options = scope.bind({}, identity.sessionId);
    const onWorkExpiry = jest.fn();
    scope.task!.deadlineSignal.addEventListener('abort', onWorkExpiry);
    current = false;
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
    expect(onWorkExpiry).not.toHaveBeenCalled();
    expect(() => readRuntimeAdmission(options, identity)?.task).toThrow('disposed');
  });

  it('preserves user/auth cancellation reason without turning it into a task timeout or releasing the owner', () => {
    const owner = new AbortController();
    const scope = createScope({ownerSignal: owner.signal});
    const options = scope.bind({}, identity.sessionId);
    const revoked = new Error('authorization_revoked');
    owner.abort(revoked);
    expect(() => readRuntimeAdmission(options, identity)?.task).toThrow(revoked);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(scope.task!.deadlineSignal.aborted).toBe(false);
    expect(owner.signal.reason).toBe(revoked);
  });

  it('checks a consuming runtime owner without taking ownership of the product scope', () => {
    const scope = createScope();
    const options = scope.bind({}, identity.sessionId);
    const runtimeOwner = new AbortController();
    runtimeOwner.abort(new Error('runtime_owner_cancelled'));
    expect(() => ensureRuntimeAdmission(options, {...identity, admittedAt: 10_000,
      ownerSignal: runtimeOwner.signal, assertCurrent() {}})).toThrow('runtime_owner_cancelled');
    expect(readRuntimeAdmission(options, identity)?.task?.facts).toBe(scope.task!.facts);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('does not create a timer if the current-owner check synchronously revokes admission', () => {
    const owner = new AbortController();
    expect(() => createRuntimeAdmissionScope({...identity, admittedAt: 0, taskTimeoutMs: 60_000,
      ownerSignal: owner.signal, assertCurrent: () => owner.abort(new Error('admission_revoked'))}))
      .toThrow('admission_revoked');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects an inherited scope disposed by the consuming runtime check without reissuing it', () => {
    const scope = createScope();
    const options = scope.bind({taskTimeoutMs: 90_000}, identity.sessionId);
    expect(() => ensureRuntimeAdmission(options, {...identity, admittedAt: 10_000,
      assertCurrent: () => scope.dispose()})).toThrow('runtime_task_deadline_disposed');
    expect(jest.getTimerCount()).toBe(0);
    expect(scope.task!.deadlineSignal.aborted).toBe(false);
  });

  it('cleans a direct-runtime scope on failed binding, and disposes a successful owned scope', () => {
    expect(() => ensureRuntimeAdmission({runId: 'foreign', taskTimeoutMs: 60_000},
      {...identity, admittedAt: 0, assertCurrent() {}})).toThrow('identity_mismatch');
    expect(jest.getTimerCount()).toBe(0);
    const ensured = ensureRuntimeAdmission({taskTimeoutMs: 60_000}, {...identity, admittedAt: 0, assertCurrent() {}});
    expect(jest.getTimerCount()).toBe(1);
    ensured.disposeOwned();
    expect(jest.getTimerCount()).toBe(0);
    expect(() => readRuntimeAdmission(ensured.options, identity)?.task).toThrow('disposed');
  });

  it('keeps very large finite timeouts finite and lets the existing timer re-arm safely', () => {
    const scope = createScope({taskTimeoutMs: Number.MAX_VALUE});
    expect(scope.task!.facts.hardDeadlineAt).toBe(Number.MAX_SAFE_INTEGER);
    jest.advanceTimersByTime(2_147_483_647);
    expect(scope.task!.deadlineSignal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
  });
});
