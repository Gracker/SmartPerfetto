// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Thread State + Scheduler Context Aggregator (Spark Plan 11)
 *
 * Aggregates per-thread `thread_state` rows + `sched.with_context` wakeup
 * edges into a `ThreadSchedContextContract`. The contract is the
 * prerequisite prior used by jank, ANR, and startup decision trees.
 */

import {
  makeSparkProvenance,
  type CriticalTaskChainEntry,
  type NsTimeRange,
  type SchedulerWakeupEdge,
  type ThreadSchedContextContract,
  type ThreadStateBreakdown,
} from '../types/sparkContracts';

export interface ThreadStateRow {
  utid: number;
  pid: number;
  threadName: string;
  state: string;
  durNs: number;
}

export interface WakeupRow {
  fromUtid: number;
  toUtid: number;
  fromThread?: string;
  toThread?: string;
  ts: number;
  latencyNs?: number;
  reason?: string;
}

export interface CriticalChainRow {
  utid: number;
  threadName: string;
  startNs: number;
  endNs: number;
  reason: string;
}

export interface ThreadSchedContextOptions {
  range: NsTimeRange;
  threadStateRows: ThreadStateRow[];
  wakeupEdges?: WakeupRow[];
  criticalChain?: CriticalChainRow[];
  /**
   * Per-utid runnable-latency p95 in ns. Caller computes via SQL window
   * aggregation; supplying it as a separate input keeps this function pure.
   */
  runnableLatencyP95Ns?: Record<number, number>;
}

/** Group rows by utid and pivot duration by state. */
function groupBreakdowns(
  rows: ThreadStateRow[],
  range: NsTimeRange,
  runnableP95: Record<number, number> | undefined,
  wakeupCounts: Record<number, number>,
): ThreadStateBreakdown[] {
  const byUtid = new Map<number, {row: ThreadStateRow; states: Record<string, number>}>();
  for (const row of rows) {
    let entry = byUtid.get(row.utid);
    if (!entry) {
      entry = {row, states: {}};
      byUtid.set(row.utid, entry);
    }
    entry.states[row.state] = (entry.states[row.state] ?? 0) + row.durNs;
  }
  const breakdowns: ThreadStateBreakdown[] = [];
  for (const [utid, entry] of byUtid) {
    breakdowns.push({
      utid,
      pid: entry.row.pid,
      threadName: entry.row.threadName,
      range,
      durByStateNs: entry.states,
      ...(wakeupCounts[utid] ? {wakeupCount: wakeupCounts[utid]} : {}),
      ...(runnableP95?.[utid] ? {runnableLatencyP95Ns: runnableP95[utid]} : {}),
    });
  }
  // Stable order: utid ascending.
  breakdowns.sort((a, b) => a.utid - b.utid);
  return breakdowns;
}

/**
 * Assemble the contract from raw rows. Caller is responsible for clamping
 * thread_state durations to the analysis window — this function trusts the
 * inputs and just pivots them.
 */
export function buildThreadSchedContext(
  options: ThreadSchedContextOptions,
): ThreadSchedContextContract {
  const wakeupCounts: Record<number, number> = {};
  for (const edge of options.wakeupEdges ?? []) {
    wakeupCounts[edge.toUtid] = (wakeupCounts[edge.toUtid] ?? 0) + 1;
  }

  const threadStates = groupBreakdowns(
    options.threadStateRows,
    options.range,
    options.runnableLatencyP95Ns,
    wakeupCounts,
  );

  const wakeupEdges: SchedulerWakeupEdge[] | undefined = options.wakeupEdges?.map(
    e => ({
      fromUtid: e.fromUtid,
      toUtid: e.toUtid,
      ts: e.ts,
      ...(e.fromThread ? {fromThread: e.fromThread} : {}),
      ...(e.toThread ? {toThread: e.toThread} : {}),
      ...(e.latencyNs !== undefined ? {latencyNs: e.latencyNs} : {}),
      ...(e.reason ? {reason: e.reason} : {}),
    }),
  );

  const criticalChain: CriticalTaskChainEntry[] | undefined =
    options.criticalChain?.map(r => ({
      utid: r.utid,
      threadName: r.threadName,
      range: {startNs: r.startNs, endNs: r.endNs},
      reason: r.reason,
    }));

  const allEmpty = threadStates.length === 0;
  return {
    ...makeSparkProvenance({
      source: 'thread-sched-context',
      ...(allEmpty ? {unsupportedReason: 'thread_state input is empty'} : {}),
    }),
    range: options.range,
    threadStates,
    ...(wakeupEdges && wakeupEdges.length > 0 ? {wakeupEdges} : {}),
    ...(criticalChain && criticalChain.length > 0 ? {criticalChain} : {}),
    coverage: [
      {sparkId: 6, planId: '11', status: 'implemented'},
      {sparkId: 17, planId: '11', status: criticalChain && criticalChain.length > 0 ? 'implemented' : 'scaffolded'},
    ],
  };
}
