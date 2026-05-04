// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 5 of critical-task analysis: counterfactual upper-bound estimation,
// frame timeline impact join, and falsifiable hypothesis generation.
//
// Codex P2-1: this is NOT a "projected truth" — eliminating the longest
// external segment may shift the critical path to the second-longest, so the
// estimate is labeled as an UPPER BOUND. Amdahl-style bookkeeping only.

import {nsToMs, rowObject, toNullableNumber, toNumber, toOptionalString} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';
import type {SegmentSemantics} from './criticalPathSemantics';

export interface QuantifyTaskInput {
  utid: number;
  upid: number | null;
  startTs: number;
  endTs: number;
  durMs: number;
}

export interface QuantifySegmentInput {
  segmentKey: string;
  durMs: number;
}

export interface CounterfactualEstimate {
  longestSegmentKey: string | null;
  longestSegmentDurMs: number;
  upperBoundMs: number; // task.durMs - longestSegmentDurMs
  note: string;
}

export interface FrameImpact {
  frameId: number | null;
  expectedDeadlineDurMs: number;
  jankType: string | null;
  presentType: string | null;
  layerName: string | null;
  appUpid: number | null;
  overlapMs: number;
}

export type HypothesisStrength = 'strong' | 'weak' | 'speculative';

export interface CriticalPathHypothesis {
  id: string;
  statement: string;
  strength: HypothesisStrength;
  /**
   * SQL that, when run on the same trace, will return rows iff the hypothesis
   * holds. Codex P1-8: only numeric IDs are interpolated; never string
   * literals from segment metadata.
   */
  verificationSql: string;
  notes: string[];
}

export interface CriticalPathQuantification {
  counterfactual: CounterfactualEstimate | null;
  frameImpacts: FrameImpact[];
  hypotheses: CriticalPathHypothesis[];
  warnings: string[];
}

function buildCounterfactual(
  task: QuantifyTaskInput,
  segments: QuantifySegmentInput[]
): CounterfactualEstimate | null {
  if (segments.length === 0) return null;
  // Stable order: dur DESC, then segmentKey ASC — guarantees deterministic
  // "longest segment" pick across equal-duration ties.
  const longest = [...segments].sort(
    (a, b) => b.durMs - a.durMs || a.segmentKey.localeCompare(b.segmentKey)
  )[0];
  if (!longest || longest.durMs <= 0) return null;
  const upperBoundMs = Math.max(0, Math.round((task.durMs - longest.durMs) * 100) / 100);
  return {
    longestSegmentKey: longest.segmentKey,
    longestSegmentDurMs: longest.durMs,
    upperBoundMs,
    note:
      'UPPER BOUND ONLY — eliminating the longest external segment may expose a shorter critical path; ' +
      'task duration may not decrease linearly.',
  };
}

async function loadFrameImpacts(
  tp: TraceProcessorService,
  traceId: string,
  task: QuantifyTaskInput
): Promise<{impacts: FrameImpact[]; warning?: string}> {
  // expected_frame_timeline_slice gives `ts + dur` as the deadline window
  // (end-of-expected-frame). actual_frame_timeline_slice carries jank_type
  // and present_type for that frame. Join via display_frame_token.
  try {
    await tp.query(traceId, 'INCLUDE PERFETTO MODULE android.frames.timeline;');
  } catch (error: unknown) {
    return {
      impacts: [],
      warning: `frames.timeline include failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }

  const upidFilter = task.upid !== null ? `AND exp.upid = ${task.upid}` : '';
  const sql = `
    SELECT
      exp.display_frame_token AS frame_id,
      exp.dur AS expected_dur,
      act.jank_type,
      act.present_type,
      exp.layer_name,
      exp.upid,
      MIN(exp.ts + exp.dur, ${task.endTs}) - MAX(exp.ts, ${task.startTs}) AS overlap_ns
    FROM expected_frame_timeline_slice AS exp
    LEFT JOIN actual_frame_timeline_slice AS act
      ON act.display_frame_token = exp.display_frame_token
     AND act.upid = exp.upid
    WHERE exp.ts <= ${task.endTs}
      AND exp.ts + exp.dur >= ${task.startTs}
      ${upidFilter}
    ORDER BY overlap_ns DESC
    LIMIT 4
  `;

  try {
    const result = await tp.query(traceId, sql);
    const impacts: FrameImpact[] = result.rows.map((row) => {
      const obj = rowObject(result.columns, row);
      const overlapNs = toNumber(obj.overlap_ns);
      return {
        frameId: toNullableNumber(obj.frame_id),
        expectedDeadlineDurMs: nsToMs(toNumber(obj.expected_dur)),
        jankType: toOptionalString(obj.jank_type),
        presentType: toOptionalString(obj.present_type),
        layerName: toOptionalString(obj.layer_name),
        appUpid: toNullableNumber(obj.upid),
        overlapMs: nsToMs(Math.max(0, overlapNs)),
      };
    });
    return {impacts: impacts.filter((impact) => impact.overlapMs > 0)};
  } catch (error: unknown) {
    return {
      impacts: [],
      warning: `frame timeline query failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}

interface HypothesisInput {
  task: QuantifyTaskInput;
  segments: QuantifySegmentInput[];
  semantics: SegmentSemantics[];
}

/**
 * Generate up to 3 falsifiable hypotheses ranked by evidence strength.
 *
 * SQL rule (Codex P1-8): all interpolated values must be numeric IDs taken
 * from `task.upid`, `task.utid`, `binder.binder_txn_id`, `monitor.rowId`,
 * or `task.startTs / task.endTs` (already integers from probe). NEVER
 * interpolate user-controlled strings (process name, method name, etc.) into
 * verification SQL — they appear in the natural-language statement only.
 */
function buildHypotheses(input: HypothesisInput): CriticalPathHypothesis[] {
  const hypotheses: CriticalPathHypothesis[] = [];
  const {task, semantics} = input;

  // Aggregate signals across segments to pick the most evidence-rich one.
  const allBinder = semantics.flatMap((sem) => sem.binderTxns).sort((a, b) => b.durMs - a.durMs);
  const allMonitor = semantics.flatMap((sem) => sem.monitorContention).sort((a, b) => b.durMs - a.durMs);
  const allIo = semantics.flatMap((sem) => sem.ioSignals).sort((a, b) => b.durMs - a.durMs);
  const allGc = semantics.flatMap((sem) => sem.gcEvents).sort((a, b) => b.durMs - a.durMs);
  const allCpu = semantics
    .flatMap((sem) => sem.cpuCompetition)
    .sort((a, b) => b.competingDurMs - a.competingDurMs);

  // H1: Sync binder client is blocked while server is GC'ing. Only fires when
  // this segment is on the CLIENT side AND the call is sync — server-side
  // segments reflect work-in-server, not wait-from-client (efficiency review
  // P1-5 / quality review #13).
  const longBinder = allBinder.find(
    (txn) => txn.durMs >= 4 && txn.side === 'client' && txn.isSync === true && txn.serverUtid !== null
  );
  if (longBinder && longBinder.binderTxnId !== null) {
    hypotheses.push({
      id: 'h-binder-server-gc',
      statement:
        `Sync binder client wait (txn id=${longBinder.binderTxnId}, ${longBinder.durMs} ms) is the dominant ` +
        `reason; verify that the server process was running GC during this window.`,
      strength: 'strong',
      verificationSql:
        `INCLUDE PERFETTO MODULE android.garbage_collection;\n` +
        `SELECT gc_type, gc_dur, reclaimed_mb FROM android_garbage_collection_events ` +
        `WHERE upid IN (SELECT upid FROM thread WHERE utid = ${longBinder.serverUtid}) ` +
        `AND gc_ts <= ${task.endTs} AND gc_ts + gc_dur >= ${task.startTs} ` +
        `ORDER BY gc_dur DESC LIMIT 5;`,
      notes: ['sync binder call on client side'],
    });
  }

  // H2: Java monitor lock contention is the proximate cause.
  const longMonitor = allMonitor.find((mc) => mc.durMs >= 2);
  if (longMonitor) {
    hypotheses.push({
      id: 'h-monitor-blocking',
      statement:
        `A Java monitor contention (row id=${longMonitor.rowId}) blocks this task for ${longMonitor.durMs} ms; ` +
        `verify the blocking thread's call chain via android_monitor_contention_chain.`,
      strength: longMonitor.isBlockedThreadMain ? 'strong' : 'weak',
      verificationSql:
        `INCLUDE PERFETTO MODULE android.monitor_contention;\n` +
        `SELECT parent_id, child_id, short_blocking_method, short_blocked_method, dur ` +
        `FROM android_monitor_contention_chain WHERE id = ${longMonitor.rowId};`,
      notes: longMonitor.isBlockedThreadMain ? ['main thread blocked'] : ['non-main thread'],
    });
  }

  // H3: D-state IO wait dominates — disk/storage path.
  const longIo = allIo.find((io) => io.durMs >= 4);
  if (longIo && task.upid !== null) {
    hypotheses.push({
      id: 'h-io-wait',
      statement:
        `Task spends ≥ ${longIo.durMs} ms in D-state IO wait; verify by listing all D-state slices ` +
        `with io_wait=1 in the task window for the owning process.`,
      strength: longIo.ioWait ? 'strong' : 'speculative',
      verificationSql:
        `SELECT ts, dur, blocked_function, io_wait FROM thread_state ` +
        `WHERE utid = ${task.utid} AND state = 'D' ` +
        `AND ts <= ${task.endTs} AND ts + dur >= ${task.startTs} ` +
        `ORDER BY dur DESC LIMIT 10;`,
      notes: longIo.ioWait ? ['io_wait flag confirmed'] : ['inferred from blocked_function pattern'],
    });
  }

  // H4: GC-induced stall.
  const longGc = allGc.find((gc) => gc.durMs >= 4);
  if (longGc && task.upid !== null) {
    hypotheses.push({
      id: 'h-gc-stall',
      statement:
        `A GC event of ${longGc.durMs} ms in the same process overlaps the task window; ` +
        `verify all GC events touching the window.`,
      strength: longGc.isMarkCompact ? 'strong' : 'weak',
      verificationSql:
        `INCLUDE PERFETTO MODULE android.garbage_collection;\n` +
        `SELECT gc_type, is_mark_compact, gc_dur, reclaimed_mb FROM android_garbage_collection_events ` +
        `WHERE upid = ${task.upid} ` +
        `AND gc_ts <= ${task.endTs} AND gc_ts + gc_dur >= ${task.startTs} ` +
        `ORDER BY gc_dur DESC LIMIT 5;`,
      notes: longGc.isMarkCompact ? ['mark-compact (heap-blocking)'] : ['non-mark-compact'],
    });
  }

  // H5: CPU competition for runnable segments.
  const longCpu = allCpu.find((cpu) => cpu.competingDurMs >= 2);
  if (longCpu && longCpu.competingUtid !== null) {
    hypotheses.push({
      id: 'h-cpu-competition',
      statement:
        `On CPU ${longCpu.cpu}, a competing thread (utid=${longCpu.competingUtid}) ran for ` +
        `${longCpu.competingDurMs} ms in the same window; verify priority and preemption.`,
      strength: 'weak',
      verificationSql:
        `SELECT ts, dur, priority FROM thread_state ts ` +
        `WHERE utid = ${longCpu.competingUtid} AND state = 'Running' ` +
        `AND ts.ts <= ${task.endTs} AND ts.ts + ts.dur >= ${task.startTs} ` +
        `ORDER BY dur DESC LIMIT 10;`,
      notes: longCpu.cpuMaxFreqKhz !== null ? [`CPU max freq during window: ${longCpu.cpuMaxFreqKhz} kHz`] : [],
    });
  }

  // Cap to 3 strongest.
  return hypotheses
    .sort((a, b) => {
      const order: Record<HypothesisStrength, number> = {strong: 0, weak: 1, speculative: 2};
      return order[a.strength] - order[b.strength];
    })
    .slice(0, 3);
}

export async function quantifyCriticalPath(
  tp: TraceProcessorService,
  traceId: string,
  task: QuantifyTaskInput,
  segments: QuantifySegmentInput[],
  semantics: SegmentSemantics[]
): Promise<CriticalPathQuantification> {
  const counterfactual = buildCounterfactual(task, segments);
  const frameResult = await loadFrameImpacts(tp, traceId, task);
  const hypotheses = buildHypotheses({task, segments, semantics});

  const warnings: string[] = [];
  if (frameResult.warning) warnings.push(frameResult.warning);

  return {
    counterfactual,
    frameImpacts: frameResult.impacts,
    hypotheses,
    warnings,
  };
}

export const __INTERNAL__ = {
  buildCounterfactual,
  buildHypotheses,
};
