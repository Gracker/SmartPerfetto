// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'async_hooks';
import {resolveRuntimeToolCallId} from './runtimeToolObserver';
import type {SharedToolSpec} from './runtimeToolSpec';

/**
 * The runtime tool invocation a piece of work runs inside. Evidence captures
 * name their producer with a synthetic id no tool observation carries, so a
 * capture registered inside a call inherits that call's runtime id and run id
 * from here; no handler has to forward `extra`.
 */
export interface RuntimeToolInvocation {
  readonly toolCallId: string;
  readonly runId?: string;
}

interface InvocationScope extends RuntimeToolInvocation {
  active: boolean;
}

const invocationScope = new AsyncLocalStorage<InvocationScope>();

/**
 * Run one tool invocation. Background work the handler leaves behind keeps the
 * run id after the handler settles, but not the call id: a capture registered
 * after the call completed was not produced by it.
 */
export async function runWithinRuntimeToolInvocation<T>(
  invocation: RuntimeToolInvocation, execute: () => Promise<T>,
): Promise<T> {
  const scope: InvocationScope = {...invocation, active: true};
  try {
    return await invocationScope.run(scope, execute);
  } finally {
    scope.active = false;
  }
}

export function currentRuntimeToolInvocation(): {toolCallId?: string; runId?: string} {
  const scope = invocationScope.getStore();
  return {toolCallId: scope?.active ? scope.toolCallId : undefined, runId: scope?.runId};
}

/**
 * Give every call of this tool one invocation id and run the handler, and the
 * observers inside it, within that invocation.
 */
export function withRuntimeToolInvocationScope(spec: SharedToolSpec, runId: string | undefined): SharedToolSpec {
  const handler: SharedToolSpec['handler'] = (params, extra) => {
    const toolCallId = resolveRuntimeToolCallId(extra);
    return runWithinRuntimeToolInvocation({toolCallId, runId}, () => spec.handler(params, {...extra, toolCallId}));
  };
  // Preserve wrapper metadata, including timing's idempotence marker.
  Object.assign(handler, spec.handler);
  return {...spec, handler};
}
