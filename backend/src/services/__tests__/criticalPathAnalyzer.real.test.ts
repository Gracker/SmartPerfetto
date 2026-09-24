// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Real-trace gate for the critical-path engine. The pinned trace_processor_shell
// runs every engine query (task, waker, _critical_path_stack, L3 loaders, frame
// impact) on two constructed cases and one canonical real trace, and each
// hypothesis' verification SQL is executed back on the same processor.
// `npm run test:critical-path` ensures the binary and materializes the
// constructed traces first, so nothing here skips.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import {randomUUID} from 'crypto';
import {WorkingTraceProcessor} from '../workingTraceProcessor';
import type {TraceProcessorService} from '../traceProcessorService';
import {resolveTraceCase} from '../../utils/traceCorpus';
import {analyzeCriticalPath, CriticalPathInputError} from '../criticalPathAnalyzer';
import {CRITICAL_PATH_HYPOTHESIS_IDS, type CriticalPathAnalysis} from '../../types/criticalPathContract';

jest.setTimeout(120_000);
const processors: WorkingTraceProcessor[] = [];
afterEach(() => {for (const processor of processors.splice(0)) processor.destroy();});

const TRACES = [
  {selector: 'binder-io-blocking', constructed: true},
  {selector: 'scheduler-cpu-contention', constructed: true},
  // Canonical light launch. Not the base of either constructed case, and the
  // only corpus trace whose chain carries a >= 4 ms sync binder client wait.
  {selector: 'launch_light.pftrace', constructed: false},
];

// Every id criticalPathQuantify.ts emits is either required from the corpus or
// listed with the input no available trace carries; the final test enforces
// both. If an "unproducible" id starts appearing, the corpus now carries its
// input: move it to REQUIRED_HYPOTHESES.
// h-monitor-blocking is produced from the lock owner's side: while a thread
// waits for a monitor the chain follows the owner, whose segment now carries
// the contention of the wait it explains.
const REQUIRED_HYPOTHESES = ['h-binder-server-gc', 'h-cpu-competition', 'h-gc-stall', 'h-monitor-blocking'];
const UNPRODUCIBLE_HYPOTHESES = [
  // Missing input: a D/DK thread_state row with io_wait = 1 or a
  // blocked_function (sched_blocked_reason). No corpus trace records either;
  // the per-trace count is asserted to be zero.
  'h-io-wait',
];
// H1 checks a further claim (the server process ran GC), so its SQL may return
// nothing; every other hypothesis re-selects the evidence that produced it.
const CLAIM_ONLY_HYPOTHESES = new Set(['h-binder-server-gc']);
const UNAVAILABLE_REASONS = [
  'task_state_running', 'no_critical_path_stack', 'no_waiting_time', 'no_thread_state_in_window', 'wait_open_at_trace_end',
];
const ROOT_WAIT_CONTEXTS = ['in_slice', 'between_slices', 'no_slice_data'];
// Names a stdlib_missing warning must mention: `INCLUDE <module> failed` or
// `stdlib table missing: ... <table> ...`.
const SOURCE_STDLIB_NAMES: Record<string, string[]> = {
  binder: ['android.binder', 'android_binder_txns'],
  monitor: ['android.monitor_contention', 'android_monitor_contention'],
  gc: ['android.garbage_collection', 'android_garbage_collection_events'],
  io: ['thread_state'],
  cpu: ['linux.cpu.frequency', 'cpu_frequency_counters', 'thread_state'],
};
// Distinct stack keys bound the merged chain from above, so a candidate within
// this many keys is never truncated at the analyzer's default 160 displayed
// segments, even with the range-mode margin. The row bound only keeps the
// candidate set, and so the runs, the same as when the analyzer capped rows.
const MAX_PROBE_SEGMENTS = 100;
const MAX_STACK_ROWS = 3200;
const MAX_POOL_RUNS = 8;
const RANGE_MARGIN_NS = 1_000_000;

const observed = {
  traces: new Set<string>(),
  produced: new Map<string, Set<string>>(),
  ioInputRows: {} as Record<string, number>,
};

interface Candidate {id: number; utid: number; ts: number; dur: number; wakerUtid: number}

interface TraceContext {
  selector: string;
  constructed: boolean;
  traceId: string;
  processor: WorkingTraceProcessor;
  service: TraceProcessorService;
  engineErrors: string[];
  problems: string[];
  produced: Set<string>;
  /** stackFits verdicts by thread_state id: the pools re-list many candidates. */
  fits: Map<number, boolean>;
}

async function sql(processor: WorkingTraceProcessor, text: string) {
  const result = await processor.query(text);
  if (result.error) throw new Error(`gate SQL failed: ${result.error}\n${text}`);
  return result;
}

// The production service resolves a failed statement with `error` instead of
// throwing. The engine now routes every query through `assertQuerySucceeded`,
// and this recorder independently logs each failure so the gate cannot pass on
// a query the engine mishandles. Results pass through unchanged.
function recordingService(processor: WorkingTraceProcessor, traceId: string, errors: string[]): TraceProcessorService {
  return {query: async (id: string, text: string, options: unknown) => {
    if (id !== traceId) errors.push(`query addressed to trace ${id}`);
    const result = await processor.query(text, options as Parameters<WorkingTraceProcessor['query']>[1]);
    if (result.error) errors.push(`${result.error.split('\n')[0]} <- ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    return result;
  }} as unknown as TraceProcessorService;
}

// An S/D row of at least 1 ms whose successor R/R+ row at ts + dur carries the
// waker: Perfetto records the wakeup on that row, never on the sleep itself.
// Sleeps over 300 ms are skipped; their stacks run to tens of thousands of rows.
function candidateSql(filter: string, order: string): string {
  return `
    SELECT s.id, s.utid, s.ts, s.dur, MAX(nxt.waker_utid) AS waker_utid
    FROM thread_state AS s
    JOIN thread AS t ON t.utid = s.utid
    LEFT JOIN process AS p ON p.upid = t.upid
    JOIN thread_state AS nxt
      ON nxt.utid = s.utid AND nxt.ts = s.ts + s.dur
     AND nxt.state IN ('R', 'R+') AND nxt.waker_utid IS NOT NULL
    JOIN thread AS w ON w.utid = nxt.waker_utid
    WHERE s.state IN ('S', 'D') AND s.dur BETWEEN 1000000 AND 300000000
      AND ${filter}
    GROUP BY s.id
    ORDER BY ${order}, s.id
    LIMIT 40`;
}

// App main threads, busiest (most Running time) first.
const MAIN_THREAD_SQL = candidateSql(
  '(t.is_main_thread = 1 OR t.tid = p.pid) AND p.uid >= 10000',
  "(SELECT SUM(r.dur) FROM thread_state AS r WHERE r.utid = s.utid AND r.state = 'Running') DESC, s.dur DESC"
);

const overlapAtLeast = (start: string, end: string, minNs: number): string =>
  `MIN(${end}, s.ts + s.dur) - MAX(${start}, s.ts) >= ${minNs}`;

// Rows whose waker carried the evidence a hypothesis is built from while the
// row waited. A pool stops at the first run that produces its target, or after
// `maxRuns` (default MAX_POOL_RUNS) runs.
const EVIDENCE_POOLS: Array<{target: string; module?: string; filter: string; maxRuns?: number}> = [
  {target: 'h-gc-stall', module: 'android.garbage_collection', filter: `EXISTS (
    SELECT 1 FROM android_garbage_collection_events AS gc
    WHERE gc.upid = w.upid AND ${overlapAtLeast('gc.gc_ts', 'gc.gc_ts + gc.gc_dur', 4_000_000)})`},
  {target: 'h-cpu-competition', filter: `EXISTS (
    SELECT 1 FROM thread_state AS r
    WHERE r.utid = w.utid AND r.state IN ('R', 'R+') AND ${overlapAtLeast('r.ts', 'r.ts + r.dur', 2_000_000)})`},
  {target: 'h-binder-server-gc', module: 'android.binder', filter: `EXISTS (
    SELECT 1 FROM android_binder_txns AS b
    WHERE b.client_utid = w.utid AND b.is_sync
      AND ${overlapAtLeast('b.client_ts', 'b.client_ts + b.client_dur', 4_000_000)})`},
  {target: 'h-monitor-blocking', module: 'android.monitor_contention', filter: `EXISTS (
    SELECT 1 FROM android_monitor_contention AS m
    WHERE m.blocked_utid = w.utid AND ${overlapAtLeast('m.ts', 'm.ts + m.dur', 2_000_000)})`},
];

async function candidates(processor: WorkingTraceProcessor, text: string): Promise<Candidate[]> {
  const result = await sql(processor, text);
  return result.rows.map(([id, utid, ts, dur, wakerUtid]) => ({
    id: Number(id), utid: Number(utid), ts: Number(ts), dur: Number(dur), wakerUtid: Number(wakerUtid),
  }));
}

// Mirrors the analyzer's stack query (enable_self_slice = 0, root rows excluded).
// Each probe runs a full _critical_path_stack, so verdicts are cached per trace.
async function stackFits(ctx: TraceContext, candidate: Candidate): Promise<boolean> {
  const cached = ctx.fits.get(candidate.id);
  if (cached !== undefined) return cached;
  const result = await sql(ctx.processor, `
    SELECT COUNT(*) AS stack_rows,
           COUNT(DISTINCT CASE WHEN cr.dur > 0 THEN cr.ts || '|' || cr.dur || '|' || cr.utid END) AS stack_keys
    FROM _critical_path_stack(${candidate.utid}, ${candidate.ts}, ${candidate.dur}, 1, 1, 0, 1) AS cr
    WHERE cr.name IS NOT NULL AND cr.utid != cr.root_utid`);
  const [rows, keys] = result.rows[0].map(Number);
  const fits = keys >= 1 && keys <= MAX_PROBE_SEGMENTS && rows <= MAX_STACK_ROWS;
  ctx.fits.set(candidate.id, fits);
  return fits;
}

async function verificationSqlProblems(processor: WorkingTraceProcessor, id: string, text: string): Promise<string[]> {
  const lines = text.split('\n');
  const isInclude = (line: string) => /^\s*INCLUDE PERFETTO MODULE\s/i.test(line);
  const statements = [...lines.filter(isInclude), lines.filter(line => !isInclude(line)).join('\n').trim()];
  const problems: string[] = [];
  for (const [index, statement] of statements.entries()) {
    const result = await processor.query(statement);
    if (result.error) problems.push(`${id} verificationSql failed: ${result.error.split('\n')[0]} <- ${statement}`);
    else if (index === statements.length - 1 && !CLAIM_ONLY_HYPOTHESES.has(id) && result.rows.length === 0) {
      problems.push(`${id} verificationSql returned no rows for its own evidence <- ${statement}`);
    }
  }
  return problems;
}

async function checkAnalysis(ctx: TraceContext, analysis: CriticalPathAnalysis, where: string): Promise<void> {
  const problem = (text: string) => ctx.problems.push(`${ctx.selector} ${where}: ${text}`);
  for (const error of ctx.engineErrors.splice(0)) problem(`engine SQL failed: ${error}`);

  for (const [source, status] of Object.entries(analysis.semanticSources ?? {})) {
    if (status === 'sql_error') problem(`semanticSources.${source} = sql_error (warnings: ${JSON.stringify(analysis.warnings)})`);
    if (status === 'stdlib_missing' &&
      !analysis.warnings.some(warning => (SOURCE_STDLIB_NAMES[source] ?? []).some(name => warning.includes(name)))) {
      problem(`semanticSources.${source} = stdlib_missing without a warning naming the module (${JSON.stringify(analysis.warnings)})`);
    }
  }

  for (const hypothesis of analysis.quantification?.hypotheses ?? []) {
    for (const text of await verificationSqlProblems(ctx.processor, hypothesis.id, hypothesis.verificationSql)) problem(text);
    ctx.produced.add(hypothesis.id);
    const producers = observed.produced.get(hypothesis.id) ?? new Set<string>();
    producers.add(`${ctx.selector} ${where}`);
    observed.produced.set(hypothesis.id, producers);
  }

  // Durations are summed in ns, so the external share cannot pass 100%; the
  // module shares may only overshoot by their own 0.01 rounding each.
  if (analysis.externalBlockingPercentage > 100) {
    problem(`externalBlockingPercentage is ${analysis.externalBlockingPercentage}`);
  }
  // Each segment counts once, under its primary module.
  const shareSum = analysis.moduleBreakdown.reduce((sum, stat) => sum + stat.percentage, 0);
  if (shareSum > 100 + 0.005 * analysis.moduleBreakdown.length) problem(`moduleBreakdown shares sum to ${shareSum}`);
  const segmentCount = analysis.moduleBreakdown.reduce((sum, stat) => sum + stat.segmentCount, 0);
  if (!analysis.truncated && segmentCount !== analysis.wakeupChain.length) {
    problem(`moduleBreakdown counts ${segmentCount} segments for a ${analysis.wakeupChain.length}-segment chain`);
  }
  if (ctx.constructed && analysis.truncated) problem('truncated on a constructed case');

  // The exact ns totals are what evidence captures read; the ms fields are
  // each rounded from them once.
  const toMs = (ns: number) => Math.round((ns / 1e6) * 100) / 100;
  const totals = analysis.totalsNs;
  if (!totals) {
    problem('totalsNs missing');
  } else {
    if (toMs(totals.blocking) !== analysis.blockingMs ||
      toMs(Math.max(0, analysis.task.dur - totals.blocking)) !== analysis.selfMs ||
      toMs(totals.chainWait) !== (analysis.chainWaitMs ?? 0)) {
      problem(`ms totals are not rounded from totalsNs: ${JSON.stringify(totals)}`);
    }
    const ownWaitNs = (analysis.slices ?? [])
      .filter(slice => slice.kind === 'sleeping' || slice.kind === 'uninterruptible')
      .reduce((sum, slice) => sum + slice.endTs - slice.startTs, 0);
    if (totals.waiting !== ownWaitNs || totals.waiting > analysis.task.dur) {
      problem(`totalsNs.waiting ${totals.waiting} != the window's own S/I/D time ${ownWaitNs}`);
    }
    // One accounting: the path roles add up to the coverage, attributable and
    // chain-wait time are sums of them, and the ms fields are rounded from them.
    if (totals.work + totals.runnable + totals.deviceWait + totals.eventWait + totals.other !== totals.blocking ||
      totals.attributable !== totals.work + totals.runnable + totals.deviceWait ||
      totals.chainWait !== totals.deviceWait + totals.eventWait) {
      problem(`path-role totals do not add up: ${JSON.stringify(totals)}`);
    }
    if (toMs(totals.attributable) !== analysis.attributableMs || toMs(totals.eventWait) !== analysis.eventWaitMs) {
      problem(`attributable/eventWait ms are not rounded from totalsNs: ${JSON.stringify(totals)}`);
    }
  }

  await checkChainLeaves(ctx, analysis, problem);
  if (analysis.available) {
    const rootWait = analysis.rootWait;
    if (!rootWait || !ROOT_WAIT_CONTEXTS.includes(rootWait.context)) {
      problem(`rootWait missing or unclassified: ${JSON.stringify(rootWait)}`);
    } else if ((rootWait.context === 'in_slice') !== (rootWait.enclosingSlice !== null)) {
      problem(`rootWait ${rootWait.context} disagrees with its enclosing slice ${JSON.stringify(rootWait.enclosingSlice)}`);
    }
  }

  const counterfactual = analysis.quantification?.counterfactual;
  if (counterfactual) {
    if (counterfactual.bestCaseDurationNs !== Math.max(0, analysis.task.dur - counterfactual.maxSavingNs)) {
      problem(`counterfactual bestCase ${counterfactual.bestCaseDurationNs} ns + maxSaving ${counterfactual.maxSavingNs} ns != window ${analysis.task.dur} ns`);
    }
    if (toMs(counterfactual.bestCaseDurationNs) !== counterfactual.bestCaseDurationMs ||
      toMs(counterfactual.maxSavingNs) !== counterfactual.maxSavingMs) {
      problem(`counterfactual ms fields are not rounded from ns: ${JSON.stringify(counterfactual)}`);
    }
    if (counterfactual.maxSavingNs !== counterfactual.longestSegmentDurNs ||
      counterfactual.maxSavingMs !== counterfactual.longestSegmentDurMs) {
      problem(`counterfactual fields disagree: ${JSON.stringify(counterfactual)}`);
    }
  }
}

/**
 * Perfetto's thread_executing_span starts a span only at a wakeup from process
 * context (`_runnable_state.is_irq` = 0: irq_context not 1 and io_wait not 1,
 * with a recorded waker), so every S/I/D segment of another thread on the
 * chain must end in a wakeup the graph cannot follow: no waker, the idle task
 * (tid 0), IRQ context or io_wait. That is why the engine treats them as
 * leaves, never recurses into them, and never counts them as attributable.
 */
async function checkChainLeaves(
  ctx: TraceContext,
  analysis: CriticalPathAnalysis,
  problem: (text: string) => void,
): Promise<void> {
  const leaves = analysis.wakeupChain.filter(segment =>
    (segment.pathRole === 'event_wait' || segment.pathRole === 'device_wait') && typeof segment.threadStateId === 'number');
  for (const segment of analysis.wakeupChain) {
    if (!segment.pathRole) problem(`segment ${segment.utid}@${segment.startTs} has no pathRole`);
    if (segment.children?.length && segment.pathRole !== 'work') {
      problem(`recursed into a ${segment.pathRole} segment ${segment.utid}@${segment.startTs}`);
    }
  }
  if (leaves.length === 0) return;
  const result = await sql(ctx.processor, `
    SELECT s.id
    FROM thread_state AS s
    JOIN thread_state AS nxt ON nxt.utid = s.utid AND nxt.ts = s.ts + s.dur AND nxt.state IN ('R', 'R+')
    LEFT JOIN thread AS w ON w.utid = nxt.waker_utid
    WHERE s.id IN (${leaves.map(segment => segment.threadStateId).join(', ')})
      AND nxt.waker_id IS NOT NULL
      AND nxt.waker_utid IS NOT NULL
      AND COALESCE(w.tid, -1) != 0
      AND COALESCE(nxt.irq_context, 0) != 1
      AND COALESCE(nxt.io_wait, 0) != 1`);
  for (const [id] of result.rows) {
    problem(`chain leaf thread_state ${id} was woken from process context: the chain should have continued`);
  }
}

async function runThreadState(ctx: TraceContext, candidate: Candidate, label: string): Promise<CriticalPathAnalysis> {
  const where = `${label} thread_state=${candidate.id}`;
  const analysis = await analyzeCriticalPath(ctx.service, ctx.traceId, {threadStateId: candidate.id});
  if (!analysis.available) ctx.problems.push(`${ctx.selector} ${where}: unavailable (${analysis.unavailableReason})`);
  const wakerUtid = analysis.directWaker?.utid ?? null;
  if (wakerUtid !== candidate.wakerUtid) {
    ctx.problems.push(`${ctx.selector} ${where}: directWaker.utid ${wakerUtid} != successor waker_utid ${candidate.wakerUtid}`);
  }
  await checkAnalysis(ctx, analysis, where);
  return analysis;
}

async function runRange(ctx: TraceContext, candidate: Candidate): Promise<void> {
  const window = {utid: candidate.utid, startTs: candidate.ts - RANGE_MARGIN_NS, dur: candidate.dur + 2 * RANGE_MARGIN_NS};
  const where = `range utid=${window.utid} [${window.startTs}, +${window.dur}) around thread_state=${candidate.id}`;
  const analysis = await analyzeCriticalPath(ctx.service, ctx.traceId, window);
  if (!analysis.available && !UNAVAILABLE_REASONS.includes(analysis.unavailableReason ?? '')) {
    ctx.problems.push(`${ctx.selector} ${where}: unavailable without a C5 reason (${analysis.unavailableReason})`);
  }
  if (analysis.directWaker && !analysis.directWaker.hintCodes.includes('range_longest_waiting_slice')) {
    ctx.problems.push(`${ctx.selector} ${where}: range waker lacks the longest-waiting-slice hint`);
  }
  await checkAnalysis(ctx, analysis, where);
}

async function openTrace(selector: string, constructed: boolean): Promise<TraceContext> {
  const tracePath = resolveTraceCase(selector);
  if (!fs.existsSync(tracePath)) {
    throw new Error(`${selector} is not materialized at ${tracePath}; run npm run trace:materialize`);
  }
  const traceId = `critical-path-real-${randomUUID()}`;
  const processor = new WorkingTraceProcessor(traceId, tracePath);
  processors.push(processor);
  await processor.initialize();
  const engineErrors: string[] = [];
  return {selector, constructed, traceId, processor, service: recordingService(processor, traceId, engineErrors),
    engineErrors, problems: [], produced: new Set(), fits: new Map()};
}

describe('critical-path engine on the pinned trace processor', () => {
  it.each(TRACES)('$selector: every engine query, waker and hypothesis holds on real data', async ({selector, constructed}) => {
    const ctx = await openTrace(selector, constructed);
    const {processor} = ctx;

    const ioInput = await sql(processor, `
      SELECT COUNT(*) FROM thread_state
      WHERE state IN ('D', 'DK') AND (io_wait = 1 OR blocked_function IS NOT NULL)`);
    observed.ioInputRows[selector] = Number(ioInput.rows[0][0]);

    // Candidate probing needs the stack table function. The modules the
    // evidence pools read are included only after the main-thread runs, so
    // those runs still depend on the engine's own INCLUDEs (android.binder
    // excepted: the processor preloads it).
    await sql(processor, 'INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;');
    let primary: Candidate | undefined;
    for (const candidate of await candidates(processor, MAIN_THREAD_SQL)) {
      if (await stackFits(ctx, candidate)) {
        primary = candidate;
        break;
      }
    }
    if (!primary) throw new Error(`${selector}: no app main-thread S/D row with a woken successor and a bounded stack`);
    await runThreadState(ctx, primary, 'main-thread');
    await runRange(ctx, primary);

    const missing = await analyzeCriticalPath(ctx.service, ctx.traceId, {threadStateId: 2 ** 40})
      .then(() => undefined, (error: unknown) => error);
    expect(missing).toBeInstanceOf(CriticalPathInputError);
    expect(missing).toMatchObject({code: 'thread_state_not_found'});
    expect(ctx.engineErrors.splice(0)).toEqual([]);

    for (const pool of EVIDENCE_POOLS) {
      if (pool.module) await sql(processor, `INCLUDE PERFETTO MODULE ${pool.module};`);
      let runs = 0;
      for (const candidate of await candidates(processor, candidateSql(pool.filter, 's.dur DESC'))) {
        if (runs >= (pool.maxRuns ?? MAX_POOL_RUNS)) break;
        if (!(await stackFits(ctx, candidate))) continue;
        runs += 1;
        const analysis = await runThreadState(ctx, candidate, `pool ${pool.target}`);
        if (analysis.quantification?.hypotheses.some(hypothesis => hypothesis.id === pool.target)) break;
      }
    }

    if (constructed && ctx.produced.size === 0) ctx.problems.push(`${selector}: no run produced a hypothesis`);
    expect(ctx.problems).toEqual([]);
    observed.traces.add(selector);
  });

  it('produces every hypothesis id the corpus supports and names the missing input for the rest', () => {
    expect([...observed.traces].sort()).toEqual(TRACES.map(trace => trace.selector).sort());
    // Every id the engine can emit is either required from the corpus or
    // named with the input no trace carries.
    expect([...CRITICAL_PATH_HYPOTHESIS_IDS].sort()).toEqual([...REQUIRED_HYPOTHESES, ...UNPRODUCIBLE_HYPOTHESES].sort());

    const produced = [...observed.produced.keys()].sort();
    expect(produced).toEqual(REQUIRED_HYPOTHESES);
    // h-io-wait: no trace carries its input.
    expect(observed.ioInputRows).toEqual(Object.fromEntries(TRACES.map(trace => [trace.selector, 0])));
  });
});
