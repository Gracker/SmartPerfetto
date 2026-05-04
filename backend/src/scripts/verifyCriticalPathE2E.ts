// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// E2E verification for the layered critical-path analyzer. Pick a slow main
// thread slice in scroll-demo-customer-scroll.pftrace, run analyzeCriticalPath
// against the real Perfetto trace, and snapshot the result so future PRs can
// detect schema/semantic regressions.

import * as fs from 'fs';
import * as path from 'path';
import {analyzeCriticalPath} from '../services/criticalPathAnalyzer';
import {getTraceProcessorService} from '../services/traceProcessorService';

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const tracePath = path.join(repoRoot, 'test-traces', 'scroll-demo-customer-scroll.pftrace');
  if (!fs.existsSync(tracePath)) {
    throw new Error(`fixture missing: ${tracePath}`);
  }

  const tp = getTraceProcessorService();
  const traceId = await tp.loadTraceFromFilePath(tracePath);

  // Pick a long-running thread_state row that we can analyze. Prefer S/D
  // states on a main thread that have a recorded waker — that's the "real"
  // critical-path use case.
  // Pick a slice that empirically has a non-empty _critical_path_stack. Note
  // that thread_state.waker_id is often NULL on production traces even when
  // sched_wakeup data exists — _critical_path_stack derives the chain from
  // the wakeup table directly, so we don't filter on waker_id here. Instead
  // we fetch a batch of candidates and probe each one for actual stack rows.
  await tp.query(traceId, 'INCLUDE PERFETTO MODULE sched.thread_executing_span_with_slice;');
  const batch = await tp.query(
    traceId,
    `
    SELECT ts.id, ts.utid, ts.ts, ts.dur, ts.state, thread.name, process.name
    FROM thread_state ts
    LEFT JOIN thread USING(utid)
    LEFT JOIN process USING(upid)
    WHERE ts.state IN ('S', 'D')
      AND ts.dur >= 4000000
      AND ts.dur <= 80000000
      AND thread.name IS NOT NULL
      AND process.name IS NOT NULL
    ORDER BY ts.dur DESC
    LIMIT 20
    `
  );

  let pickedRow: unknown[] | null = null;
  for (const candidate of batch.rows) {
    const utid = Number(candidate[1]);
    const ts = Number(candidate[2]);
    const dur = Number(candidate[3]);
    try {
      const probe = await tp.query(
        traceId,
        `SELECT COUNT(*) FROM _critical_path_stack(${utid}, ${ts}, ${dur}, 1, 1, 1, 1) WHERE name IS NOT NULL AND utid != root_utid AND dur > 0`
      );
      if (Number(probe.rows[0]?.[0] ?? 0) >= 5) {
        pickedRow = candidate;
        break;
      }
    } catch {
      // skip rows that fail the stack probe
    }
  }

  const candidateRows = {rows: pickedRow ? [pickedRow] : []};
  if (candidateRows.rows.length === 0) {
    throw new Error('no candidate thread_state row found in fixture');
  }
  const row = candidateRows.rows[0];
  const threadStateId = Number(row[0]);

  console.log(
    `[E2E] picked thread_state id=${threadStateId} state=${row[4]} thread=${row[5]} process=${row[6]} dur=${(Number(row[3]) / 1e6).toFixed(2)}ms`
  );

  const analysis = await analyzeCriticalPath(tp, traceId, {
    threadStateId,
    recursionEnabled: true,
    recursionDepth: 2,
    segmentBudget: 16,
  });

  // Sanity assertions — fail loudly if structure regresses.
  const failures: string[] = [];
  if (typeof analysis.available !== 'boolean') failures.push('available is not boolean');
  if (typeof analysis.totalMs !== 'number') failures.push('totalMs is not number');
  if (!analysis.task || typeof analysis.task.utid !== 'number') failures.push('task.utid missing');
  if (analysis.available && !Array.isArray(analysis.wakeupChain)) failures.push('wakeupChain is not array');
  if (analysis.available && !analysis.quantification) failures.push('quantification missing');
  if (analysis.available && !analysis.semanticSources) failures.push('semanticSources missing');
  if (analysis.available && analysis.directWaker === undefined) failures.push('directWaker is undefined');
  for (const hyp of analysis.quantification?.hypotheses ?? []) {
    if (hyp.verificationSql.includes("'")) {
      failures.push(`hypothesis ${hyp.id} contains a string literal (apostrophe) in SQL — must be numeric only`);
    }
  }

  if (failures.length > 0) {
    console.error('[E2E] FAILURES:');
    for (const failure of failures) console.error('  -', failure);
    await tp.deleteTrace(traceId);
    process.exit(1);
  }

  // Snapshot a redacted summary so the user can review tomorrow.
  const summary = {
    fixture: 'scroll-demo-customer-scroll.pftrace',
    threadStateId,
    state: String(row[4]),
    thread: String(row[5]),
    process: String(row[6]),
    available: analysis.available,
    totalMs: analysis.totalMs,
    blockingMs: analysis.blockingMs,
    externalBlockingPercentage: analysis.externalBlockingPercentage,
    wakeupChainLength: analysis.wakeupChain.length,
    moduleBreakdown: analysis.moduleBreakdown,
    semanticSources: analysis.semanticSources,
    directWaker: analysis.directWaker,
    counterfactual: analysis.quantification?.counterfactual ?? null,
    frameImpactsCount: analysis.quantification?.frameImpacts.length ?? 0,
    hypothesesCount: analysis.quantification?.hypotheses.length ?? 0,
    hypothesesIds: (analysis.quantification?.hypotheses ?? []).map((h) => `${h.id}/${h.strength}`),
    warnings: analysis.warnings,
    recursionFound: analysis.wakeupChain.some((segment) => Array.isArray(segment.children) && segment.children.length > 0),
  };

  const outDir = path.join(repoRoot, 'backend', 'test-output');
  fs.mkdirSync(outDir, {recursive: true});
  const outPath = path.join(outDir, 'critical-path-e2e.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log('\n[E2E] Summary:');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[E2E] Wrote ${outPath}`);

  await tp.deleteTrace(traceId);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[E2E] failed:', error);
    process.exit(1);
  });
