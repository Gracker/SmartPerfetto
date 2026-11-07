// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDeadlineRuntimeTimeout, type ResettableRuntimeTimeout} from './runtimeLimits';

export interface RuntimeAdmissionFacts {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly admittedAt: number;
}

export interface RuntimeTaskDeadlineFacts extends RuntimeAdmissionFacts {
  readonly source: 'task_timeout';
  readonly hardDeadlineAt: number;
}

export interface RuntimeTaskDeadline {
  readonly facts: RuntimeTaskDeadlineFacts;
  /** Work expiry only. Never replace the owner's cancellation/authorization signal. */
  readonly deadlineSignal: AbortSignal;
}

export interface RuntimeAdmission {
  readonly facts: RuntimeAdmissionFacts;
  /** An optional explicit constraint of this same admission, never a second issued identity. */
  readonly task?: RuntimeTaskDeadline;
}

export interface RuntimeAdmissionScope extends RuntimeAdmission {
  bind<T extends object>(options: T, runtimeSessionId: string): T;
  dispose(): void;
}

export interface RuntimeAdmissionInput {
  runId: string;
  admittedAt: number;
  taskTimeoutMs?: number;
  assertCurrent(): void;
  ownerSignal?: AbortSignal;
}

export interface RuntimeTaskDeadlineIdentity {
  runId: string;
  sessionId: string;
}

export class RuntimeTaskDeadlineExceededError extends Error {
  readonly code = 'runtime_task_deadline_exceeded';
  constructor() {
    super('Runtime task deadline exceeded');
    this.name = 'RuntimeTaskDeadlineExceededError';
  }
}

/** Check work admission even when the deadline timer has not had an event-loop turn yet. */
export function assertRuntimeTaskWorkRemaining(task: RuntimeTaskDeadline | undefined, now = Date.now()): void {
  if (!task) return;
  task.deadlineSignal.throwIfAborted();
  if (now >= task.facts.hardDeadlineAt) throw new RuntimeTaskDeadlineExceededError();
}

interface ScopeState {
  readonly view: RuntimeAdmission;
  readonly assertCurrent: () => void;
  readonly ownerSignal?: AbortSignal;
  disposed: boolean;
  binding?: Binding;
}

interface Binding {
  readonly scope: ScopeState;
  readonly sessionId: string;
  readonly token: object;
}

// Internal spreads retain the token; request JSON and persisted snapshots cannot.
const deadlineBinding = Symbol('runtimeTaskDeadline');
const issuedBindings = new WeakMap<object, Binding>();

function assertActive(scope: ScopeState): void {
  scope.ownerSignal?.throwIfAborted();
  if (scope.disposed) throw new Error('runtime_task_deadline_disposed');
  scope.assertCurrent();
  scope.ownerSignal?.throwIfAborted();
  if (scope.disposed) throw new Error('runtime_task_deadline_disposed');
}

function assertOptionsRunId(options: object, runId: string): void {
  const supplied = (options as {runId?: unknown}).runId;
  if (supplied !== undefined && supplied !== runId) throw new Error('runtime_task_deadline_identity_mismatch');
}

function bindingOf(options: object): Binding | undefined {
  if (!(deadlineBinding in options)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, deadlineBinding);
  const token: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const binding = token && typeof token === 'object' ? issuedBindings.get(token) : undefined;
  if (!binding) throw new Error('runtime_task_deadline_unissued');
  assertActive(binding.scope);
  assertOptionsRunId(options, binding.scope.view.facts.runId);
  return binding;
}

function assertIdentity(binding: Binding, identity: RuntimeTaskDeadlineIdentity): void {
  if (binding.scope.view.facts.runId !== identity.runId || binding.sessionId !== identity.sessionId) {
    throw new Error('runtime_task_deadline_identity_mismatch');
  }
}

function explicitTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Pure constraint for authorized preparation before a real run id exists; issues no capability. */
export function runtimeTaskHardDeadlineAt(admittedAt: number, taskTimeoutMs: unknown): number | undefined {
  const timeoutMs = explicitTimeoutMs(taskTimeoutMs);
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(admittedAt) || admittedAt < 0 || admittedAt > Number.MAX_SAFE_INTEGER) {
    throw new Error('runtime_task_deadline_invalid');
  }
  return Math.min(Number.MAX_SAFE_INTEGER, admittedAt + timeoutMs);
}

/** One issued admission for every run. Default native budgets add no product timer. */
export function createRuntimeAdmissionScope(input: RuntimeAdmissionInput): RuntimeAdmissionScope {
  if (!input.runId.trim() || !Number.isFinite(input.admittedAt) || input.admittedAt < 0 ||
    input.admittedAt > Number.MAX_SAFE_INTEGER) throw new Error('runtime_task_deadline_invalid');
  const facts: RuntimeAdmissionFacts = Object.freeze({schemaVersion: 1, runId: input.runId, admittedAt: input.admittedAt});
  const hardDeadlineAt = runtimeTaskHardDeadlineAt(input.admittedAt, input.taskTimeoutMs);
  const controller = hardDeadlineAt === undefined ? undefined : new AbortController();
  const task: RuntimeTaskDeadline | undefined = hardDeadlineAt === undefined ? undefined : Object.freeze({
    facts: Object.freeze({...facts, source: 'task_timeout', hardDeadlineAt}),
    deadlineSignal: controller!.signal,
  });
  const view: RuntimeAdmission = Object.freeze({facts, ...(task ? {task} : {})});
  const state: ScopeState = {view, assertCurrent: input.assertCurrent, ownerSignal: input.ownerSignal, disposed: false};
  assertActive(state);
  let timer: ResettableRuntimeTimeout | undefined;
  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    timer?.clear();
    input.ownerSignal?.removeEventListener('abort', dispose);
  };
  input.ownerSignal?.addEventListener('abort', dispose, {once: true});
  if (task && controller) {
    const expire = () => {
      try { assertActive(state); } catch { dispose(); return; }
      controller.abort(new RuntimeTaskDeadlineExceededError());
    };
    // Already-expired admissions must be visible before any asynchronous dispatch.
    if (Date.now() >= task.facts.hardDeadlineAt) expire();
    else {
      timer = createDeadlineRuntimeTimeout({deadlineAt: () => task.facts.hardDeadlineAt,
        message: () => 'Runtime task deadline exceeded', onTimeout: expire});
      void timer.promise.catch(() => undefined);
    }
  }
  return Object.freeze({...view, dispose, bind<T extends object>(options: T, sessionId: string): T {
    assertActive(state);
    if (!sessionId.trim()) throw new Error('runtime_task_deadline_identity_mismatch');
    assertOptionsRunId(options, facts.runId);
    const existing = bindingOf(options);
    if (existing && existing.scope !== state) throw new Error('runtime_task_deadline_binding_conflict');
    if (state.binding && state.binding.sessionId !== sessionId) throw new Error('runtime_task_deadline_identity_mismatch');
    if (!state.binding) {
      const token = Object.freeze({});
      state.binding = {scope: state, sessionId, token};
      issuedBindings.set(token, state.binding);
    }
    return {...options, runId: facts.runId, [deadlineBinding]: state.binding.token};
  }});
}

export function readRuntimeAdmission(options: object, expected: RuntimeTaskDeadlineIdentity):
RuntimeAdmission | undefined {
  const binding = bindingOf(options);
  if (!binding) return undefined;
  assertIdentity(binding, expected);
  return binding.scope.view;
}

/** Read before native ensure; this view does not certify where an admission originated. */
export function readRuntimeAdmissionLifetime(options: object, expected: RuntimeTaskDeadlineIdentity):
Readonly<{ownerSignal: AbortSignal; assertCurrent(): void}> | undefined {
  const capturedIdentity = Object.freeze({runId: expected.runId, sessionId: expected.sessionId});
  const binding = bindingOf(options);
  if (!binding) return undefined;
  assertIdentity(binding, capturedIdentity);
  const scope = binding.scope, ownerSignal = scope.ownerSignal;
  if (!ownerSignal) return undefined;
  return Object.freeze({ownerSignal, assertCurrent() {
    assertActive(scope);
    assertIdentity(binding, capturedIdentity);
  }});
}

/** Forward only this issued sidecar through an explicit options whitelist. */
export function forwardRuntimeAdmission<T extends object>(source: object, target: T): T {
  const sourceBinding = bindingOf(source);
  const targetBinding = bindingOf(target);
  if (targetBinding && targetBinding !== sourceBinding) throw new Error('runtime_task_deadline_binding_conflict');
  if (!sourceBinding) return target;
  assertOptionsRunId(target, sourceBinding.scope.view.facts.runId);
  return {...target, runId: sourceBinding.scope.view.facts.runId, [deadlineBinding]: sourceBinding.token};
}

/** Direct-runtime fallback. Existing product admission always wins over a later raw timeout. */
export function ensureRuntimeAdmission<T extends object>(options: T,
  input: RuntimeTaskDeadlineIdentity & {admittedAt: number; assertCurrent(): void; ownerSignal?: AbortSignal},
): {options: T; admission: RuntimeAdmission; disposeOwned(): void} {
  const admission = readRuntimeAdmission(options, input);
  if (admission) {
    input.ownerSignal?.throwIfAborted();
    input.assertCurrent();
    input.ownerSignal?.throwIfAborted();
    if (readRuntimeAdmission(options, input) !== admission) throw new Error('runtime_task_deadline_binding_conflict');
    return {options, admission, disposeOwned() {}};
  }
  const owned = createRuntimeAdmissionScope({...input,
    taskTimeoutMs: explicitTimeoutMs((options as {taskTimeoutMs?: unknown}).taskTimeoutMs)});
  try {
    const bound = owned.bind(options, input.sessionId);
    return {options: bound, admission: readRuntimeAdmission(bound, input)!, disposeOwned: owned.dispose};
  } catch (error) {
    owned.dispose();
    throw error;
  }
}
