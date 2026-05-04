// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import { getTraceProcessorService } from '../services/traceProcessorService';

interface ProbeColumn {
  name: string;
  presentInRows: number;
  sampleValue: string | null;
}

interface ProbeTable {
  module: string;
  table: string;
  status: 'present' | 'include_failed' | 'query_failed' | 'empty';
  columns: ProbeColumn[];
  sampleRowCount: number;
  errorMessage?: string;
}

interface ProbeReport {
  trace: string;
  perfettoVersion?: string;
  tables: ProbeTable[];
}

const PROBE_TARGETS: Array<{module: string; table: string; sampleSql?: string}> = [
  // Binder
  {module: 'android.binder', table: 'android_binder_txns'},
  {module: 'android.binder', table: 'android_sync_binder_metrics_by_txn'},
  // Monitor contention
  {module: 'android.monitor_contention', table: 'android_monitor_contention'},
  {module: 'android.monitor_contention', table: 'android_monitor_contention_chain'},
  // IO — Codex flagged that android_io may not exist in v54
  {module: 'android.io', table: 'android_io'},
  {module: 'android.io', table: 'android_io_long_tasks'},
  // GC
  {module: 'android.garbage_collection', table: 'android_garbage_collection_events'},
  // CPU utilization
  {module: 'linux.cpu.utilization.thread', table: 'cpu_utilization_per_thread'},
  {module: 'linux.cpu.utilization.thread', table: 'cpu_cycles_per_thread'},
  // CPU frequency / topology
  {module: 'linux.cpu.frequency', table: 'cpu_frequency_counters'},
  // Frames timeline
  {module: 'android.frames.timeline', table: 'android_frames'},
  {module: 'android.frames.timeline', table: 'expected_frame_timeline_slice'},
  {module: 'android.frames.timeline', table: 'actual_frame_timeline_slice'},
  // Critical path source-of-truth
  {module: 'sched.thread_executing_span_with_slice', table: '_critical_path_stack', sampleSql: 'SELECT * FROM _critical_path_stack(0, 0, 0, 0, 0, 0, 0) LIMIT 0'},
];

async function probeOne(
  tp: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
  target: typeof PROBE_TARGETS[number]
): Promise<ProbeTable> {
  // 1) INCLUDE module
  try {
    await tp.query(traceId, `INCLUDE PERFETTO MODULE ${target.module};`);
  } catch (error: unknown) {
    return {
      module: target.module,
      table: target.table,
      status: 'include_failed',
      columns: [],
      sampleRowCount: 0,
      errorMessage: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }

  // 2) Probe columns via LIMIT 0
  let columns: ProbeColumn[] = [];
  try {
    const sample = target.sampleSql ?? `SELECT * FROM ${target.table} LIMIT 0`;
    const result = await tp.query(traceId, sample);
    columns = result.columns.map((name) => ({
      name,
      presentInRows: 0,
      sampleValue: null,
    }));
  } catch (error: unknown) {
    return {
      module: target.module,
      table: target.table,
      status: 'query_failed',
      columns: [],
      sampleRowCount: 0,
      errorMessage: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }

  // 3) Sample 5 rows for value examples (skip parameterized critical path)
  let rowCount = 0;
  if (!target.sampleSql) {
    try {
      const result = await tp.query(traceId, `SELECT * FROM ${target.table} LIMIT 5`);
      rowCount = result.rows.length;
      result.rows.forEach((row) => {
        result.columns.forEach((col, idx) => {
          const probe = columns.find((c) => c.name === col);
          if (probe) {
            probe.presentInRows += row[idx] !== null && row[idx] !== undefined ? 1 : 0;
            if (probe.sampleValue === null && row[idx] !== null && row[idx] !== undefined) {
              probe.sampleValue = String(row[idx]).slice(0, 80);
            }
          }
        });
      });
    } catch (error: unknown) {
      return {
        module: target.module,
        table: target.table,
        status: 'query_failed',
        columns,
        sampleRowCount: 0,
        errorMessage: error instanceof Error ? error.message.split('\n')[0] : String(error),
      };
    }
  }

  return {
    module: target.module,
    table: target.table,
    status: rowCount > 0 || target.sampleSql ? 'present' : 'empty',
    columns,
    sampleRowCount: rowCount,
  };
}

async function probeTrace(filePath: string): Promise<ProbeReport> {
  const tp = getTraceProcessorService();
  const traceId = await tp.loadTraceFromFilePath(filePath);
  const report: ProbeReport = {
    trace: path.basename(filePath),
    tables: [],
  };

  try {
    const versionResult = await tp.query(
      traceId,
      `SELECT str_value FROM metadata WHERE name = 'trace_processor_version' LIMIT 1`
    );
    if (versionResult.rows[0]) {
      report.perfettoVersion = String(versionResult.rows[0][0] ?? '');
    }
  } catch {
    // ignore
  }

  for (const target of PROBE_TARGETS) {
    process.stdout.write(`  [${target.module}.${target.table}] `);
    const result = await probeOne(tp, traceId, target);
    process.stdout.write(`${result.status}\n`);
    report.tables.push(result);
  }

  await tp.deleteTrace(traceId);
  return report;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '../../..');
  const traceDir = path.join(repoRoot, 'test-traces');
  const traceFiles = fs
    .readdirSync(traceDir)
    .filter((file) => file.endsWith('.pftrace'))
    .map((file) => path.join(traceDir, file));

  if (traceFiles.length === 0) {
    console.error(`No .pftrace files found in ${traceDir}`);
    process.exit(1);
  }

  const reports: ProbeReport[] = [];
  for (const file of traceFiles) {
    console.log(`\n=== Probing ${path.basename(file)} ===`);
    try {
      const report = await probeTrace(file);
      reports.push(report);
    } catch (error: unknown) {
      console.error(`Failed to probe ${file}:`, error);
    }
  }

  const outputPath = path.join(repoRoot, 'backend', 'test-output', 'stdlib-schema-probe.json');
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  fs.writeFileSync(outputPath, JSON.stringify(reports, null, 2));
  console.log(`\nReport written to ${outputPath}`);

  // Summary
  console.log('\n=== Summary ===');
  for (const target of PROBE_TARGETS) {
    const presence = reports.map((r) => {
      const t = r.tables.find((x) => x.module === target.module && x.table === target.table);
      return t?.status ?? 'unknown';
    });
    const presentCount = presence.filter((s) => s === 'present').length;
    const emptyCount = presence.filter((s) => s === 'empty').length;
    const failCount = presence.filter((s) => s === 'include_failed' || s === 'query_failed').length;
    console.log(
      `  ${target.module}.${target.table}: present=${presentCount}/${reports.length} empty=${emptyCount} fail=${failCount}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Probe failed:', error);
    process.exit(1);
  });
