// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 5 of critical-task analysis: counterfactual best-case estimation,
// frame timeline impact join, and falsifiable hypothesis generation.
//
// Codex P2-1: this is NOT a "projected truth". Removing the longest external
// segment saves at most its duration, and a previously shorter path may become
// critical, so the remaining duration is a best case, never a prediction.
// Amdahl-style bookkeeping only.

import {queryRows, assertQuerySucceeded, nsToMs, toNullableNumber, toNumber, toOptionalString} from '../utils/traceProcessorRowUtils';
import {errorLine, hypothesisText, noteText} from './criticalPathText';
import {rethrowIfTraceProcessorQueryCancelled} from './traceProcessorCancellation';
import type {TraceProcessorService} from './traceProcessorService';
import type {
  CounterfactualEstimate,
  CriticalPathHypothesis,
  CriticalPathHypothesisId,
  CriticalPathNote,
  CriticalPathQuantification,
  CriticalPathWarning,
  FrameImpact,
  HypothesisStrength,
  SegmentSemantics,
  TextParams,
} from '../types/criticalPathContract';

export interface QuantifyTaskInput {
  upid: number | null;
  startTs: number;
  endTs: number;
}

export interface QuantifySegmentInput {
  segmentKey: string;
  durNs: number;
}

function buildCounterfactual(
  task: QuantifyTaskInput,
  segments: QuantifySegmentInput[]
): CounterfactualEstimate | null {
  if (segments.length === 0) return null;
  // Stable order: dur DESC, then segmentKey ASC — guarantees deterministic
  // "longest segment" pick across equal-duration ties.
  const longest = [...segments].sort(
    (a, b) => b.durNs - a.durNs || a.segmentKey.localeCompare(b.segmentKey)
  )[0];
  if (!longest || longest.durNs <= 0) return null;
  // Subtracted in ns and rounded once, like the analysis totals.
  const bestCaseDurationNs = Math.max(0, task.endTs - task.startTs - longest.durNs);
  const bestCaseDurationMs = nsToMs(bestCaseDurationNs);
  return {
    longestSegmentKey: longest.segmentKey,
    longestSegmentDurMs: nsToMs(longest.durNs),
    bestCaseDurationMs,
    maxSavingMs: nsToMs(longest.durNs),
    longestSegmentDurNs: longest.durNs,
    bestCaseDurationNs,
    maxSavingNs: longest.durNs,
    noteCode: 'best_case_only',
    note: noteText({code: 'best_case_only'}, 'en'),
  };
}

async function loadFrameImpacts(
  tp: TraceProcessorService,
  traceId: string,
  task: QuantifyTaskInput,
  signal: AbortSignal | undefined
): Promise<{impacts: FrameImpact[]; warning?: CriticalPathWarning}> {
  // expected_frame_timeline_slice gives `ts + dur` as the deadline window
  // (end-of-expected-frame). actual_frame_timeline_slice carries jank_type
  // and present_type for that frame. Join via display_frame_token.
  try {
    assertQuerySucceeded(await tp.query(traceId, 'INCLUDE PERFETTO MODULE android.frames.timeline;', {signal}));
  } catch (error: unknown) {
    rethrowIfTraceProcessorQueryCancelled(error);
    return {impacts: [], warning: {code: 'frames_include_failed', params: {message: errorLine(error)}}};
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
    WHERE exp.ts < ${task.endTs}
      AND exp.ts + exp.dur > ${task.startTs}
      ${upidFilter}
    ORDER BY overlap_ns DESC
    LIMIT 4
  `;

  try {
    const rows = await queryRows(tp, traceId, sql, {signal});
    const impacts: FrameImpact[] = rows.map((obj) => {
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
    rethrowIfTraceProcessorQueryCancelled(error);
    return {impacts: [], warning: {code: 'frame_query_failed', params: {message: errorLine(error)}}};
  }
}

/** A signal together with the segment (entity + window) that produced it. */
interface Attributed<T> {
  sem: SegmentSemantics;
  item: T;
}

function rankBy<T>(
  semantics: SegmentSemantics[],
  pick: (sem: SegmentSemantics) => T[],
  durMs: (item: T) => number
): Array<Attributed<T>> {
  return semantics
    .flatMap((sem) => pick(sem).map((item) => ({sem, item})))
    .sort((a, b) => durMs(b.item) - durMs(a.item));
}

/**
 * Generate up to 3 falsifiable hypotheses ranked by evidence strength.
 *
 * Each hypothesis names the entity and window of the segment whose evidence
 * produced it; that segment is usually another thread on the chain, not the
 * task. Durations and thresholds use time clipped to that segment; the whole
 * event is quoted as `eventDurMs`.
 *
 * SQL rule (Codex P1-8): all interpolated values must be numeric — utid/upid,
 * `binder.serverUtid`, `monitor.rowId` and segment timestamps. NEVER
 * interpolate user-controlled strings (process name, method name, etc.) into
 * verification SQL — they appear in the natural-language statement only.
 */
function buildHypotheses(semantics: SegmentSemantics[]): CriticalPathHypothesis[] {
  const hypotheses: CriticalPathHypothesis[] = [];
  // Statements and notes are rendered from ids and numbers; English is the
  // engine's neutral rendering, and a projection re-renders the language.
  const hypothesis = (
    id: CriticalPathHypothesisId,
    params: TextParams,
    strength: HypothesisStrength,
    verificationSql: string,
    noteCodes: CriticalPathNote[]
  ): CriticalPathHypothesis => ({
    id,
    params,
    statement: hypothesisText(id, params, 'en'),
    strength,
    verificationSql,
    noteCodes,
    notes: noteCodes.map((note) => noteText(note, 'en')),
  });
  const segment = (sem: SegmentSemantics): TextParams => ({utid: sem.utid, start: sem.startTs, end: sem.endTs});

  // H1: Sync binder client is blocked while server is GC'ing. Only fires when
  // this segment is on the CLIENT side AND the call is sync — server-side
  // segments reflect work-in-server, not wait-from-client (efficiency review
  // P1-5 / quality review #13).
  const longBinder = rankBy(semantics, (sem) => sem.binderTxns, (txn) => txn.durMs).find(
    ({item: txn}) =>
      txn.durMs >= 4 && txn.side === 'client' && txn.isSync === true && txn.serverUtid !== null && txn.binderTxnId !== null
  );
  if (longBinder) {
    const {sem, item: txn} = longBinder;
    hypotheses.push(hypothesis(
      'h-binder-server-gc',
      {...segment(sem), txnId: txn.binderTxnId, durMs: txn.durMs, eventDurMs: txn.eventDurMs},
      'strong',
      `INCLUDE PERFETTO MODULE android.garbage_collection;\n` +
        `SELECT gc_type, gc_dur, reclaimed_mb FROM android_garbage_collection_events ` +
        `WHERE upid IN (SELECT upid FROM thread WHERE utid = ${txn.serverUtid}) ` +
        `AND gc_ts < ${sem.endTs} AND gc_ts + gc_dur > ${sem.startTs} ` +
        `ORDER BY gc_dur DESC LIMIT 5;`,
      [{code: 'sync_binder_client'}]
    ));
  }

  // H2: Java monitor lock contention is the proximate cause. A chain segment
  // usually carries it from the owner's side: while a thread waits for a lock
  // the path follows the thread holding it.
  const longMonitor = rankBy(semantics, (sem) => sem.monitorContention, (mc) => mc.durMs).find(
    ({item: mc}) => mc.durMs >= 2
  );
  if (longMonitor) {
    const {sem, item: mc} = longMonitor;
    hypotheses.push(hypothesis(
      'h-monitor-blocking',
      {...segment(sem), side: mc.side, rowId: mc.rowId, blockedUtid: mc.blockedUtid, durMs: mc.durMs, eventDurMs: mc.eventDurMs},
      mc.isBlockedThreadMain ? 'strong' : 'weak',
      `INCLUDE PERFETTO MODULE android.monitor_contention;\n` +
        `SELECT parent_id, child_id, short_blocking_method, short_blocked_method, dur ` +
        `FROM android_monitor_contention_chain WHERE id = ${mc.rowId};`,
      [{code: mc.isBlockedThreadMain ? 'main_thread_blocked' : 'non_main_thread'}]
    ));
  }

  // H3: io_wait or IO/page-cache blocked_function candidate on the segment's thread.
  const longIo = rankBy(semantics, (sem) => sem.ioSignals, (io) => io.durMs).find(({item: io}) => io.durMs >= 4);
  if (longIo) {
    const {sem, item: io} = longIo;
    hypotheses.push(hypothesis(
      'h-io-wait',
      {...segment(sem), durMs: io.durMs, eventDurMs: io.eventDurMs},
      io.ioWait ? 'strong' : 'speculative',
      `SELECT ts, dur, state, blocked_function, io_wait FROM thread_state ` +
        `WHERE utid = ${sem.utid} AND state IN ('D', 'DK') ` +
        `AND ts < ${sem.endTs} AND ts + dur > ${sem.startTs} ` +
        `ORDER BY dur DESC LIMIT 10;`,
      [{code: io.ioWait ? 'io_wait_confirmed' : 'inferred_from_blocked_function'}]
    ));
  }

  // H4: GC-induced stall in the segment's process.
  const longGc = rankBy(semantics, (sem) => sem.gcEvents, (gc) => gc.durMs).find(
    ({sem, item: gc}) => gc.durMs >= 4 && sem.upid !== null
  );
  if (longGc) {
    const {sem, item: gc} = longGc;
    hypotheses.push(hypothesis(
      'h-gc-stall',
      {...segment(sem), upid: sem.upid, durMs: gc.durMs, eventDurMs: gc.eventDurMs},
      gc.isMarkCompact ? 'strong' : 'weak',
      `INCLUDE PERFETTO MODULE android.garbage_collection;\n` +
        `SELECT gc_type, is_mark_compact, gc_dur, reclaimed_mb FROM android_garbage_collection_events ` +
        `WHERE upid = ${sem.upid} ` +
        `AND gc_ts < ${sem.endTs} AND gc_ts + gc_dur > ${sem.startTs} ` +
        `ORDER BY gc_dur DESC LIMIT 5;`,
      [{code: gc.isMarkCompact ? 'mark_compact' : 'non_mark_compact'}]
    ));
  }

  // H5: CPU competition for runnable segments. `priority` lives on `sched`,
  // not on `thread_state`.
  const longCpu = rankBy(semantics, (sem) => sem.cpuCompetition, (cpu) => cpu.competingDurMs).find(
    ({item: cpu}) => cpu.competingDurMs >= 2 && cpu.competingUtid !== null
  );
  if (longCpu) {
    const {sem, item: cpu} = longCpu;
    hypotheses.push(hypothesis(
      'h-cpu-competition',
      {...segment(sem), competingUtid: cpu.competingUtid, cpu: cpu.cpu, durMs: cpu.competingDurMs, eventDurMs: cpu.eventDurMs},
      'weak',
      `SELECT ts, dur, priority FROM sched ` +
        `WHERE utid = ${cpu.competingUtid} ` +
        `AND ts < ${sem.endTs} AND ts + dur > ${sem.startTs} ` +
        `ORDER BY dur DESC LIMIT 10;`,
      cpu.cpuMaxFreqKhz !== null ? [{code: 'cpu_max_freq', params: {khz: cpu.cpuMaxFreqKhz}}] : []
    ));
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
  semantics: SegmentSemantics[],
  signal?: AbortSignal
): Promise<CriticalPathQuantification> {
  const counterfactual = buildCounterfactual(task, segments);
  const frameResult = await loadFrameImpacts(tp, traceId, task, signal);
  const hypotheses = buildHypotheses(semantics);

  const warnings: CriticalPathWarning[] = frameResult.warning ? [frameResult.warning] : [];

  return {
    counterfactual,
    frameImpacts: frameResult.impacts,
    hypotheses,
    warnings,
  };
}

/** @internal Test seam. */
export const __INTERNAL__ = {
  buildCounterfactual,
  buildHypotheses,
};
