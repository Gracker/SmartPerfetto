// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';
import type {RuntimeToolExtra, RuntimeToolResult, SharedToolSpec} from './runtimeToolSpec';

interface RuntimeToolInvocation {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  extra: RuntimeToolExtra;
}

export type RuntimeToolInvocationEvent = RuntimeToolInvocation & (
  | {phase: 'started'}
  | {phase: 'completed'; result: RuntimeToolResult}
  | {phase: 'failed'; error: unknown}
);

export type RuntimeToolObserver = (event: RuntimeToolInvocationEvent) => void | Promise<void>;

/** The runtime-supplied call id, or a fresh one when the runtime supplied none. */
export function resolveRuntimeToolCallId(extra: RuntimeToolExtra): string {
  const suppliedId = typeof extra.toolCallId === 'string' ? extra.toolCallId.trim() : '';
  return suppliedId && suppliedId !== 'unknown' ? suppliedId : randomUUID();
}

/** Observe an admitted invocation without changing the tool's result or failure. */
export function withRuntimeToolObserver(
  spec: SharedToolSpec,
  observer: RuntimeToolObserver | undefined,
): SharedToolSpec {
  if (!observer) return spec;
  const notify = async (event: RuntimeToolInvocationEvent): Promise<void> => {
    try {
      await observer(event);
    } catch {
      // Observability must not change the actual tool outcome.
    }
  };
  const handler: SharedToolSpec['handler'] = async (params, extra) => {
    const toolCallId = resolveRuntimeToolCallId(extra);
    const invocation = {
      toolCallId,
      toolName: spec.name,
      params,
      extra: {...extra, toolCallId},
    };
    await notify({...invocation, phase: 'started'});
    try {
      const result = await spec.handler(params, invocation.extra);
      await notify({...invocation, phase: 'completed', result});
      return result;
    } catch (error) {
      await notify({...invocation, phase: 'failed', error});
      throw error;
    }
  };
  // Preserve wrapper metadata, including timing's idempotence marker.
  Object.assign(handler, spec.handler);
  return {...spec, handler};
}
