// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The `analyze_wait_chain` selectors as the caller meant them. Strict tool
// schemas make a model fill every field, so the raw arguments carry
// placeholders; the handler and the timeline narration read them through this
// one normalization. Pure: no trace access, no engine import.

import {isPlaceholderToolString} from '../agentRuntime/toolArgPlaceholders';

/** The `analyze_wait_chain` selectors after placeholder removal. */
export interface WaitChainSelectors {
  threadStateId?: number | string;
  utid?: number | string;
  upid?: number | string;
  pid?: number | string;
  processName?: string;
  tid?: number | string;
  threadName?: string;
  mainThread?: true;
  startTs?: number | string;
  endTs?: number | string;
}

/** A value a strict tool schema forced the model to fill, read as absent. */
function presentArg<T>(value: T): T | undefined {
  return value === undefined || value === null || isPlaceholderToolString(value) ? undefined : value;
}

/** An id where 0 names the idle task or process, never a target: a placeholder. */
function presentId<T>(value: T): T | undefined {
  const present = presentArg(value);
  return present !== undefined && String(present).trim() === '0' ? undefined : present;
}

/**
 * Drop the placeholders strict tool schemas make a model send for every field
 * (`""`, `"null"`, `0`, `false`). The runtime adapters already drop null and
 * placeholder strings in optional fields; the rules here are the wait-chain
 * ones no shared layer can know (20 of 33 real calls carried some). utid/tid/upid/pid 0 is the idle task or
 * process, and a 0..0 window is no window. `thread_state_id` 0 is a real row
 * id and stays; the owner consistency check catches a placeholder one.
 */
export function normalizeWaitChainSelectors(input: {
  thread_state_id?: unknown; utid?: unknown; upid?: unknown; pid?: unknown; process_name?: unknown;
  tid?: unknown; thread_name?: unknown; main_thread?: unknown; start_ts?: unknown; end_ts?: unknown;
}): WaitChainSelectors {
  const intLike = (value: unknown): number | string | undefined =>
    typeof value === 'number' || typeof value === 'string' ? value : undefined;
  const name = (value: unknown): string | undefined =>
    typeof value === 'string' ? presentArg(value) : undefined;
  const threadStateId = presentArg(intLike(input.thread_state_id));
  let startTs = presentArg(intLike(input.start_ts));
  let endTs = presentArg(intLike(input.end_ts));
  const bothZero = startTs !== undefined && endTs !== undefined
    && String(startTs).trim() === '0' && String(endTs).trim() === '0';
  // With a thread_state row the row is the window; an empty window beside it
  // is a filled-in field, not a request for zero time.
  const emptyBesideRow = threadStateId !== undefined && startTs !== undefined && endTs !== undefined
    && String(startTs).trim() === String(endTs).trim();
  if (bothZero || emptyBesideRow) {
    startTs = undefined;
    endTs = undefined;
  }
  const selectors: WaitChainSelectors = {
    threadStateId,
    utid: presentId(intLike(input.utid)),
    upid: presentId(intLike(input.upid)),
    pid: presentId(intLike(input.pid)),
    processName: name(input.process_name),
    tid: presentId(intLike(input.tid)),
    threadName: name(input.thread_name),
    ...(input.main_thread === true ? {mainThread: true as const} : {}),
    startTs,
    endTs,
  };
  return Object.fromEntries(Object.entries(selectors).filter(([, value]) => value !== undefined)) as WaitChainSelectors;
}

/** True when the selectors name one thread on their own, not just a process. */
export function waitChainNamesThread(selectors: WaitChainSelectors): boolean {
  return selectors.utid !== undefined || selectors.tid !== undefined
    || selectors.threadName !== undefined || selectors.mainThread === true;
}

/** The requested window, when both ends are given and it has positive length. */
export function waitChainWindow(selectors: WaitChainSelectors): {startTs: number; endTs: number} | undefined {
  if (selectors.startTs === undefined || selectors.endTs === undefined) return undefined;
  const startTs = Number(selectors.startTs);
  const endTs = Number(selectors.endTs);
  return Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs ? {startTs, endTs} : undefined;
}
