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

// R15 D-A2b: an internal lifetime view of an already issued admission, never a new admission.
type AdmissionLifetime = Readonly<{ownerSignal: AbortSignal; assertCurrent(): void}>;
type AdmissionLifetimeReader = (options: object, expected: typeof identity) => AdmissionLifetime | undefined;
function admissionLifetimeReader(): AdmissionLifetimeReader {
  // Keep the absent API inside each test body so the existing suite still executes for the initial RED.
  const module: {readRuntimeAdmissionLifetime?: AdmissionLifetimeReader} = require('../runtimeTaskDeadline');
  expect(typeof module.readRuntimeAdmissionLifetime).toBe('function');
  if (typeof module.readRuntimeAdmissionLifetime !== 'function') throw new Error('readRuntimeAdmissionLifetime_missing');
  return module.readRuntimeAdmissionLifetime;
}

describe('R15 D-A2b inherited admission lifetime', () => {
  it('returns only a frozen original owner signal and a live guard through real bind/forward/ensure', () => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController(), native = new AbortController();
    const guard = jest.fn();
    const scope = createScope({ownerSignal: owner.signal, assertCurrent: guard, taskTimeoutMs: undefined});
    const bound = scope.bind({queryTag: 'original'}, identity.sessionId);
    const forwarded = forwardRuntimeAdmission({...bound}, {requiredValue: 42});
    const inherited = readLifetime(forwarded, identity)!;
    expect(inherited).toBeDefined();
    expect(Object.isFrozen(inherited)).toBe(true);
    expect(Object.keys(inherited).sort()).toEqual(['assertCurrent', 'ownerSignal']);
    expect(inherited.ownerSignal).toBe(owner.signal);
    expect(inherited.ownerSignal).not.toBe(native.signal);
    const borrowed = ensureRuntimeAdmission(forwarded, {...identity, admittedAt: 10_000,
      ownerSignal: native.signal, assertCurrent() {}});
    expect(borrowed.admission.facts).toBe(scope.facts);
    borrowed.disposeOwned();
    const before = guard.mock.calls.length;
    inherited.assertCurrent();
    expect(guard).toHaveBeenCalledTimes(before + 1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not turn a missing pre-ensure binding into inherited product authority', () => {
    const readLifetime = admissionLifetimeReader(), native = new AbortController();
    const original = {taskTimeoutMs: 60_000};
    const inherited = readLifetime(original, identity);
    expect(inherited).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    const fallback = ensureRuntimeAdmission(original, {...identity, admittedAt: 0,
      ownerSignal: native.signal, assertCurrent() {}});
    try {
      expect(inherited).toBeUndefined();
      expect(readLifetime(original, identity)).toBeUndefined();
      // The accessor cannot certify product provenance. A later read sees only this real native-owned scope.
      expect(readLifetime(fallback.options, identity)?.ownerSignal).toBe(native.signal);
      expect(fallback.admission.task?.facts.hardDeadlineAt).toBe(60_000);
      expect(jest.getTimerCount()).toBe(1);
    } finally {fallback.disposeOwned();}
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps an issued ownerless scope unavailable after a native ensure with its own signal', () => {
    const readLifetime = admissionLifetimeReader(), native = new AbortController();
    const scope = createScope({taskTimeoutMs: undefined}), bound = scope.bind({}, identity.sessionId);
    expect(readLifetime(bound, identity)).toBeUndefined();
    const borrowed = ensureRuntimeAdmission(bound, {...identity, admittedAt: 35_000,
      ownerSignal: native.signal, assertCurrent() {}});
    expect(borrowed.admission.facts).toBe(scope.facts);
    expect(readLifetime(borrowed.options, identity)).toBeUndefined();
    borrowed.disposeOwned();
    expect(readRuntimeAdmission(bound, identity)?.facts).toBe(scope.facts);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['runId', 'sessionId'] as const)('still validates %s before returning an ownerless lifetime as absent', field => {
    const readLifetime = admissionLifetimeReader(), scope = createScope({taskTimeoutMs: undefined});
    const bound = scope.bind({}, identity.sessionId);
    expect(() => readLifetime(bound, {...identity, [field]: 'foreign'})).toThrow('runtime_task_deadline_identity_mismatch');
    expect(readLifetime(bound, identity)).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['run', 'session', 'options_run'] as const)('preserves the original %s identity mismatch failure', mismatch => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController();
    const scope = createScope({ownerSignal: owner.signal}), bound = scope.bind({}, identity.sessionId);
    const expected = {...identity};
    if (mismatch === 'run') expected.runId = 'foreign-run';
    if (mismatch === 'session') expected.sessionId = 'foreign-native';
    const options = mismatch === 'options_run' ? {...bound, runId: 'foreign-options'} : bound;
    expect(() => readLifetime(options, expected)).toThrow('runtime_task_deadline_identity_mismatch');
    expect(readLifetime(bound, identity)?.ownerSignal).toBe(owner.signal);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('rejects an unissued symbol token and does not create a replacement admission', () => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController();
    const scope = createScope({ownerSignal: owner.signal}), bound = scope.bind({}, identity.sessionId);
    const [symbol] = Object.getOwnPropertySymbols(bound);
    const forged = {...bound, [symbol!]: Object.freeze({})};
    expect(() => readLifetime(forged, identity)).toThrow('runtime_task_deadline_unissued');
    expect(jest.getTimerCount()).toBe(1);
    expect(readLifetime(bound, identity)?.ownerSignal).toBe(owner.signal);
  });

  it('does not recover lifetime from JSON or public-looking fields', () => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController();
    const scope = createScope({ownerSignal: owner.signal}), bound = scope.bind({taskTimeoutMs: 60_000}, identity.sessionId);
    expect(readLifetime(JSON.parse(JSON.stringify(bound)) as object, identity)).toBeUndefined();
    expect(readLifetime({runId: identity.runId, ownerSignal: owner.signal,
      runtimeTaskDeadline: scope.facts, hardDeadlineAt: 900_000}, identity)).toBeUndefined();
    expect(readLifetime({...bound}, identity)?.ownerSignal).toBe(owner.signal);
    expect(jest.getTimerCount()).toBe(1);
  });

  it.each(['initial', 'closure'] as const)('rechecks disposal after a reentrant real guard during %s lookup', phase => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController();
    let onGuard: (() => void) | undefined;
    const scope = createScope({ownerSignal: owner.signal, assertCurrent: () => onGuard?.()});
    const bound = scope.bind({}, identity.sessionId);
    const inherited = phase === 'closure' ? readLifetime(bound, identity)! : undefined;
    let nestedAdmission: ReturnType<typeof readRuntimeAdmission>;
    onGuard = () => {
      onGuard = undefined;
      nestedAdmission = readRuntimeAdmission(bound, identity);
      scope.dispose();
    };
    expect(() => phase === 'initial' ? readLifetime(bound, identity) : inherited!.assertCurrent())
      .toThrow('runtime_task_deadline_disposed');
    expect(nestedAdmission!.facts).toBe(scope.facts);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['initial', 'closure'] as const)('rechecks product abort after its real guard during %s lookup', phase => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController(), reason = new Error('product_cancelled_in_guard');
    let abortInGuard = false;
    const scope = createScope({ownerSignal: owner.signal, assertCurrent: () => {if (abortInGuard) owner.abort(reason);}});
    const bound = scope.bind({}, identity.sessionId);
    const inherited = phase === 'closure' ? readLifetime(bound, identity)! : undefined;
    abortInGuard = true;
    expect(() => phase === 'initial' ? readLifetime(bound, identity) : inherited!.assertCurrent()).toThrow(reason);
    expect(owner.signal.reason).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['superseded', 'authorization_revoked'] as const)('keeps %s product checks live after extraction', message => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController(), reason = new Error(message);
    let current = true;
    const guard = jest.fn(() => {if (!current) throw reason;});
    const scope = createScope({ownerSignal: owner.signal, assertCurrent: guard});
    const bound = scope.bind({}, identity.sessionId), inherited = readLifetime(bound, identity)!;
    expect(() => inherited.assertCurrent()).not.toThrow();
    current = false;
    const before = guard.mock.calls.length;
    expect(() => inherited.assertCurrent()).toThrow(reason);
    expect(guard).toHaveBeenCalledTimes(before + 1);
    expect(() => readLifetime(bound, identity)).toThrow(reason);
    expect(owner.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('snapshots expected identity before the first external guard can mutate it', () => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController(), expected = {...identity};
    let mutate = false;
    const scope = createScope({ownerSignal: owner.signal, assertCurrent: () => {
      if (mutate) {expected.runId = 'changed-run'; expected.sessionId = 'changed-native';}
    }});
    const bound = scope.bind({}, identity.sessionId);
    mutate = true;
    const inherited = readLifetime(bound, expected)!;
    expect(expected).toEqual({runId: 'changed-run', sessionId: 'changed-native'});
    expect(inherited.ownerSignal).toBe(owner.signal);
    expect(() => inherited.assertCurrent()).not.toThrow();
  });

  it.each(['runId', 'sessionId'] as const)('does not accept a wrong %s repaired by the first external guard', field => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController(), expected = {...identity, [field]: 'foreign'};
    let repair = false;
    const scope = createScope({ownerSignal: owner.signal, assertCurrent: () => {if (repair) expected[field] = identity[field];}});
    const bound = scope.bind({}, identity.sessionId);
    repair = true;
    expect(() => readLifetime(bound, expected)).toThrow('runtime_task_deadline_identity_mismatch');
    expect(expected[field]).toBe(identity[field]);
    expect(readLifetime(bound, identity)?.ownerSignal).toBe(owner.signal);
  });

  it('captures the original binding before an external guard replaces options with another real scope token', () => {
    const readLifetime = admissionLifetimeReader(), firstOwner = new AbortController(), nextOwner = new AbortController();
    let swap: (() => void) | undefined;
    const first = createScope({ownerSignal: firstOwner.signal, assertCurrent: () => swap?.()});
    const next = createScope({ownerSignal: nextOwner.signal});
    const options = first.bind({}, identity.sessionId), nextOptions = next.bind({}, identity.sessionId);
    const [symbol] = Object.getOwnPropertySymbols(options);
    const replacement = Object.getOwnPropertyDescriptor(nextOptions, symbol!)!;
    swap = () => {swap = undefined; Object.defineProperty(options, symbol!, replacement);};
    const inherited = readLifetime(options, identity)!;
    expect(inherited.ownerSignal).toBe(firstOwner.signal);
    expect(readLifetime(options, identity)?.ownerSignal).toBe(nextOwner.signal);
    first.dispose();
    expect(() => inherited.assertCurrent()).toThrow('runtime_task_deadline_disposed');
    expect(() => readLifetime(options, identity)!.assertCurrent()).not.toThrow();
  });

  it('does not re-read mutated options or expected identities when its closure runs later', () => {
    const readLifetime = admissionLifetimeReader(), owner = new AbortController(), successorOwner = new AbortController();
    const scope = createScope({ownerSignal: owner.signal}), next = createScope({ownerSignal: successorOwner.signal});
    const options = scope.bind({}, identity.sessionId), expected = {...identity};
    const inherited = readLifetime(options, expected)!;
    const successorOptions = next.bind({}, identity.sessionId), [symbol] = Object.getOwnPropertySymbols(options);
    Object.defineProperty(options, symbol!, Object.getOwnPropertyDescriptor(successorOptions, symbol!)!);
    expected.runId = 'unrelated-run'; expected.sessionId = 'unrelated-native';
    expect(() => inherited.assertCurrent()).not.toThrow();
    const revoked = new Error('original_owner_revoked'); owner.abort(revoked);
    expect(() => inherited.assertCurrent()).toThrow(revoked);
    expect(readLifetime(options, identity)?.ownerSignal).toBe(successorOwner.signal);
  });

  it('separates native cleanup from the real product owner after a borrowed ensure', () => {
    const readLifetime = admissionLifetimeReader(), product = new AbortController(), native = new AbortController();
    const scope = createScope({ownerSignal: product.signal}), options = scope.bind({}, identity.sessionId);
    const inherited = readLifetime(options, identity)!;
    const borrowed = ensureRuntimeAdmission(options, {...identity, admittedAt: 1_000,
      ownerSignal: native.signal, assertCurrent() {}});
    native.abort(new Error('native_scope_cleanup'));
    borrowed.disposeOwned();
    expect(inherited.ownerSignal).toBe(product.signal);
    expect(product.signal.aborted).toBe(false);
    expect(() => inherited.assertCurrent()).not.toThrow();
    expect(scope.task!.facts.hardDeadlineAt).toBe(60_000);
    const cancelled = new Error('real_product_cancel'); product.abort(cancelled);
    expect(() => inherited.assertCurrent()).toThrow(cancelled);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not create or reset task timers and keeps work expiry separate from product lifetime', () => {
    const readLifetime = admissionLifetimeReader(), product = new AbortController();
    const scope = createScope({ownerSignal: product.signal}), options = scope.bind({taskTimeoutMs: 60_000}, identity.sessionId);
    const task = readRuntimeAdmission(options, identity)!.task!;
    jest.advanceTimersByTime(35_000);
    const inherited = readLifetime({...options, taskTimeoutMs: 600_000}, identity)!;
    inherited.assertCurrent(); inherited.assertCurrent();
    expect(jest.getTimerCount()).toBe(1);
    expect(readRuntimeAdmission(options, identity)!.task).toBe(task);
    expect(task.facts.hardDeadlineAt).toBe(60_000);
    jest.advanceTimersByTime(25_000);
    expect(task.deadlineSignal.aborted).toBe(true);
    expect(() => assertRuntimeTaskWorkRemaining(task)).toThrow(RuntimeTaskDeadlineExceededError);
    expect(product.signal.aborted).toBe(false);
    expect(() => inherited.assertCurrent()).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
