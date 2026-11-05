// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {AsyncLocalStorage} from 'node:async_hooks';
import type {RuntimePerformanceRecorder, RuntimeModelCallPurpose, RuntimeModelCallTrigger} from './runtimePerformance';
import type {RuntimeActivitySnapshot} from './runtimeActivity';
import type {RunManifestIdentity} from '../types/selfEvolution';

export interface RuntimePerformanceSource {
  readonly runtimePerformanceRecorder?: RuntimePerformanceRecorder;
  readonly identity?: RunManifestIdentity;
}

interface RuntimePerformanceContext {
  readonly identity: RunManifestIdentity;
  readonly recorder: RuntimePerformanceRecorder;
  readonly assertCurrent: () => void;
  disposed: boolean;
  suppressed: boolean;
}

const context = new AsyncLocalStorage<RuntimePerformanceContext>();
const suppression = new AsyncLocalStorage<true>();
const requestPurpose = new AsyncLocalStorage<{purpose?: RuntimeModelCallPurpose; trigger?: RuntimeModelCallTrigger}>();

/** Per-dispatch attribution only; this never selects provider policy. */
export function withModelRequestPurpose<T>(purpose: {purpose?: RuntimeModelCallPurpose; trigger?: RuntimeModelCallTrigger},
  execute: () => T): T {
  return requestPurpose.run(purpose, execute);
}

export function currentModelRequestPurpose() {
  return requestPurpose.getStore();
}

/** No recorder may be recovered downstream of an attribution conflict. */
export function withRuntimePerformanceSuppressed<T>(execute: () => T): T {
  return suppression.run(true, execute);
}
/** @internal Exact product run identity, not a caller-provided selector. */
export const sameRuntimePerformanceIdentity = (left: RunManifestIdentity, right: RunManifestIdentity): boolean =>
  Boolean(left?.runId && right?.runId && left?.scope && right?.scope &&
    left.runId === right.runId && left.sessionId === right.sessionId &&
    left.scope.tenantId === right.scope.tenantId && left.scope.workspaceId === right.scope.workspaceId);

function active(state: RuntimePerformanceContext): boolean {
  if (state.disposed || state.suppressed) return false;
  try { state.assertCurrent(); return true; } catch { return false; }
}

/** Bind SDK callbacks created during a run even when their transport loses async context. */
export function bindRuntimePerformanceContext<Args extends unknown[], Result>(callback: (...args: Args) => Result):
  (...args: Args) => Result {
  const captured = context.getStore();
  const capturedSuppression = suppression.getStore() === true;
  if (!captured && !capturedSuppression) return callback;
  return (...args) => {
    const execute = () => {
      if (!captured) return callback(...args);
      const caller = context.getStore();
      if (caller && caller !== captured && !suppression.getStore()) {
        // A held old callback cannot add observations to its caller's new run.
        captured.suppressed = true;
        captured.recorder.markActivityPartial();
      }
      return context.run(captured, () => callback(...args));
    };
    return capturedSuppression ? withRuntimePerformanceSuppressed(execute) : execute();
  };
}

/** Private execution scope: never placed in request options, JSON or snapshots. */
export function createRuntimePerformanceScope(input: {
  identity: RunManifestIdentity;
  recorder: RuntimePerformanceRecorder;
  assertCurrent(): void;
}) {
  const state: RuntimePerformanceContext = {...input, identity: {...input.identity, scope: {...input.identity.scope}},
    disposed: false, suppressed: false};
  input.recorder.bindActivityLifetime(() => active(state));
  return Object.freeze({
    run<T>(execute: () => T): T { return context.run(state, execute); },
    dispose(): RuntimeActivitySnapshot {
      state.disposed = true;
      input.recorder.seal();
      return input.recorder.activitySnapshot();
    },
  });
}

type RuntimePerformanceResolution =
  | {kind: 'available'; recorder: RuntimePerformanceRecorder}
  | {kind: 'unavailable' | 'suppressed'};

/** Resolve all candidates together; disagreement suppresses instead of switching runs. */
function resolveRuntimePerformance(...sources: Array<RuntimePerformanceSource | undefined>): RuntimePerformanceResolution {
  if (suppression.getStore()) return {kind: 'suppressed'};
  const state = context.getStore();
  if (state && !active(state)) return {kind: 'suppressed'};
  const present = sources.filter((source): source is RuntimePerformanceSource => Boolean(source));
  const identities = present.flatMap(source => source.identity ? [source.identity] : []);
  if (state) identities.push(state.identity);
  const recorders = present.flatMap(source => source.runtimePerformanceRecorder ? [source.runtimePerformanceRecorder] : []);
  if (state) recorders.push(state.recorder);
  const mismatch = identities.some(identity => !sameRuntimePerformanceIdentity(identities[0], identity)) ||
    recorders.some(recorder => recorder !== recorders[0]);
  if (mismatch) {
    if (state) {
      state.suppressed = true;
      state.recorder.markActivityPartial();
    }
    return {kind: 'suppressed'};
  }
  return recorders[0] ? {kind: 'available', recorder: recorders[0]} : {kind: 'unavailable'};
}

export function resolveRuntimePerformanceRecorder(...sources: Array<RuntimePerformanceSource | undefined>):
  RuntimePerformanceRecorder | undefined {
  const resolved = resolveRuntimePerformance(...sources);
  return resolved.kind === 'available' ? resolved.recorder : undefined;
}

/** The registry binding is authoritative for execution; foreign candidates are never mutated. */
export function resolveRuntimeActivityObservation(bound: RuntimePerformanceSource | undefined,
  perCall: RuntimePerformanceSource | undefined, ambient: RuntimePerformanceSource | undefined): RuntimePerformanceResolution {
  const resolved = resolveRuntimePerformance(bound, perCall, ambient);
  if (resolved.kind === 'suppressed' && !context.getStore() && !suppression.getStore()) {
    bound?.runtimePerformanceRecorder?.markActivityPartial();
  }
  return resolved;
}

/** Identity for internal comparison only; never serialize it as a capture receipt. */
export function runtimePerformanceRunId(source?: RuntimePerformanceSource): string | undefined {
  if (!resolveRuntimePerformanceRecorder(source)) return undefined;
  return context.getStore()?.identity.runId ?? source?.identity?.runId;
}
