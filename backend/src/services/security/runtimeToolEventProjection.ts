// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {RuntimeToolRole} from '../../agentRuntime/runtimeToolSpec';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';

interface RuntimeToolEventPayload {
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  extra?: unknown;
}

/** Disclosure only. A registered role never authenticates a submission or a native terminal. */
export function projectRuntimeToolEventPayload<T extends RuntimeToolEventPayload>(
  role: RuntimeToolRole | undefined,
  event: T,
): T {
  if (role !== 'final_candidate_submission') return event;
  const {success} = readRuntimeToolResultFacts(event.result);
  // Final submissions carry no plan attribution. Arbitrary phase strings are not public metadata.
  const facts = success === undefined ? {} : {success};
  const failed = Object.prototype.hasOwnProperty.call(event, 'error') || facts.success === false ||
    Boolean(event.result && typeof event.result === 'object' && (event.result as {isError?: unknown}).isError === true);
  const summary = {kind: 'authored_final_submission', status: failed ? 'rejected' : 'pending',
    ...(failed ? {reason: 'submission_rejected'} : {})};
  return {
    ...event,
    ...(Object.prototype.hasOwnProperty.call(event, 'params') ? {params: summary} : {}),
    ...(Object.prototype.hasOwnProperty.call(event, 'result')
      ? {result: createRuntimeToolResult(summary, {facts, ...(failed ? {isError: true} : {})})} : {}),
    ...(Object.prototype.hasOwnProperty.call(event, 'error') ? {error: summary} : {}),
    // External observers do not inherit arbitrary MCP extra values or private callbacks.
    ...(Object.prototype.hasOwnProperty.call(event, 'extra') ? {extra: {}} : {}),
  } as T;
}
