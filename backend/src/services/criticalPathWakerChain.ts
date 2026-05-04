// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Layer 2 of critical-task analysis: resolve the *direct* waker of the
// selected task slice and annotate IRQ/swapper termination semantics.
//
// Codex P1-1: this module deliberately does NOT recurse on waker_id. Recursing
// "who woke the thread that woke me?" does not yield a wait chain — it yields
// a notification chain that quickly devolves into IRQ handlers and softirqd.
// The actual wait chain (what each upstream thread was itself blocked on) is
// answered by L4's recursive _critical_path_stack call. This module is a
// single-hop annotator.

import {
  rowObject,
  toBool,
  toNullableNumber,
  toOptionalString,
} from '../utils/traceProcessorRowUtils';
import type {TraceProcessorService} from './traceProcessorService';

export type WakerKind = 'irq' | 'swapper' | 'thread' | 'unknown';

export interface WakerHop {
  threadStateId: number | null;
  utid: number | null;
  tid: number | null;
  threadName: string | null;
  processName: string | null;
  state: string | null;
  cpu: number | null;
  irqContext: boolean;
  kind: WakerKind;
  // Co-occurring semantic hints around the wakeup ts (best-effort).
  hints: string[];
}

export interface WakerChainResult {
  available: boolean;
  hop: WakerHop | null;
  warnings: string[];
}

function classifyWaker(
  threadName: string | null,
  tid: number | null,
  irqContext: boolean
): WakerKind {
  if (irqContext) return 'irq';
  // swapper threads: tid=0 or name like 'swapper/N'
  if (tid === 0) return 'swapper';
  if (threadName && /^swapper(\/\d+)?$/.test(threadName)) return 'swapper';
  if (threadName) return 'thread';
  return 'unknown';
}

export interface ResolveWakerOptions {
  threadStateId: number;
}

/**
 * Resolve the direct waker for a given thread_state row id. Returns a single
 * hop (NOT a recursive chain) annotated with IRQ/swapper context.
 *
 * Failure modes:
 *  - thread_state row missing → available=false, warning
 *  - waker_id is NULL (no recorded waker) → available=true, hop=null
 *  - SQL error → available=false, warning
 */
export async function resolveDirectWaker(
  tp: TraceProcessorService,
  traceId: string,
  options: ResolveWakerOptions
): Promise<WakerChainResult> {
  const {threadStateId} = options;
  if (!Number.isInteger(threadStateId) || threadStateId < 0) {
    return {available: false, hop: null, warnings: ['invalid threadStateId']};
  }

  const sql = `
    SELECT
      target.id AS target_id,
      target.ts AS target_ts,
      target.waker_id,
      target.irq_context AS target_irq_context,
      waker.id AS waker_id_resolved,
      waker.utid AS waker_utid,
      waker.state AS waker_state,
      waker.cpu AS waker_cpu,
      waker.irq_context AS waker_irq_context,
      thread.tid AS waker_tid,
      thread.name AS waker_thread_name,
      process.name AS waker_process_name
    FROM thread_state AS target
    LEFT JOIN thread_state AS waker ON target.waker_id = waker.id
    LEFT JOIN thread ON waker.utid = thread.utid
    LEFT JOIN process ON thread.upid = process.upid
    WHERE target.id = ${Math.trunc(threadStateId)}
    LIMIT 1
  `;

  let result;
  try {
    result = await tp.query(traceId, sql);
  } catch (error: unknown) {
    return {
      available: false,
      hop: null,
      warnings: [`waker query failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`],
    };
  }

  if (result.rows.length === 0) {
    return {
      available: false,
      hop: null,
      warnings: [`thread_state ${threadStateId} not found`],
    };
  }

  const row = rowObject(result.columns, result.rows[0]);
  const wakerIdRaw = toNullableNumber(row.waker_id);
  const targetIrq = toBool(row.target_irq_context) === true;

  // No waker recorded — common when thread_state was scheduled by self-yield
  // or when waker_id wasn't captured.
  if (wakerIdRaw === null || row.waker_id_resolved === null || row.waker_id_resolved === undefined) {
    if (targetIrq) {
      return {
        available: true,
        hop: {
          threadStateId: null,
          utid: null,
          tid: null,
          threadName: null,
          processName: null,
          state: null,
          cpu: null,
          irqContext: true,
          kind: 'irq',
          hints: ['target slice was scheduled in IRQ context (target.irq_context=1)'],
        },
        warnings: [],
      };
    }
    return {
      available: true,
      hop: null,
      warnings: ['no recorded waker (waker_id is NULL)'],
    };
  }

  const wakerThreadName = toOptionalString(row.waker_thread_name);
  const wakerTid = toNullableNumber(row.waker_tid);
  const wakerIrq = toBool(row.waker_irq_context) === true;
  const kind = classifyWaker(wakerThreadName, wakerTid, wakerIrq || targetIrq);

  const hints: string[] = [];
  if (targetIrq) hints.push('target was woken in IRQ context');
  if (wakerIrq) hints.push('waker itself was running in IRQ context');
  if (kind === 'swapper') hints.push('woken by idle/swapper — no upstream wait chain to chase');

  return {
    available: true,
    hop: {
      threadStateId: toNullableNumber(row.waker_id_resolved),
      utid: toNullableNumber(row.waker_utid),
      tid: wakerTid,
      threadName: wakerThreadName,
      processName: toOptionalString(row.waker_process_name),
      state: toOptionalString(row.waker_state),
      cpu: toNullableNumber(row.waker_cpu),
      irqContext: wakerIrq || targetIrq,
      kind,
      hints,
    },
    warnings: [],
  };
}

export const __INTERNAL__ = {
  classifyWaker,
};
