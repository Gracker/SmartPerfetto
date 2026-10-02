// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { bootstrap, resolveInvocationPath } from '../bootstrap';
import type { OutputFormat } from '../repl/renderer';
import { CliAnalyzeService } from '../services/cliAnalyzeService';
import { getTraceProcessorService, type QueryResult } from '../../services/traceProcessorService';
import { withConsoleLogToStderr } from '../io/stdio';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {rowObject} from '../../utils/traceProcessorRowUtils';

export interface QueryCommandArgs {
  trace: string;
  sql: string;
  envFile?: string;
  sessionDir?: string;
  format?: OutputFormat;
}

export async function runQueryCommand(args: QueryCommandArgs): Promise<number> {
  const tracePath = resolveInvocationPath(args.trace);
  const format = args.format ?? 'text';
  const lifecycle: { service?: CliAnalyzeService } = {};

  try {
    const { traceId, result } = await withConsoleLogToStderr(true, async () => {
      bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
      const service = new CliAnalyzeService();
      lifecycle.service = service;
      const loadedTraceId = await service.loadTrace(tracePath);
      const queryResult = await getTraceProcessorService().query(loadedTraceId, args.sql);
      return { traceId: loadedTraceId, result: queryResult };
    });
    writeQueryOutput(format, { tracePath, traceId, sql: args.sql, result });
    return result.error ? 1 : 0;
  } catch (err) {
    writeError(format, (err as Error).message);
    return 1;
  } finally {
    await lifecycle.service?.shutdown();
  }
}

function writeQueryOutput(
  format: OutputFormat,
  payload: { tracePath: string; traceId: string; sql: string; result: QueryResult },
): void {
  if (format === 'json') {
    console.log(JSON.stringify({ ok: !payload.result.error, ...payload }, null, 2));
    return;
  }
  if (format === 'ndjson') {
    console.log(JSON.stringify({
      type: 'metadata',
      tracePath: payload.tracePath,
      traceId: payload.traceId,
      sql: payload.sql,
      columns: payload.result.columns,
      durationMs: payload.result.durationMs,
    }));
    for (const row of payload.result.rows) {
      console.log(JSON.stringify({ type: 'row', row: rowObject(payload.result.columns, row) }));
    }
    console.log(JSON.stringify({ type: 'complete', ok: !payload.result.error, rowCount: payload.result.rows.length }));
    return;
  }

  if (payload.result.error) console.error(`Error: ${payload.result.error}`);
  printTable(payload.result);
  console.log(`\n${payload.result.rows.length} row(s), ${payload.result.durationMs}ms`);
}

function writeError(format: OutputFormat, message: string): void {
  if (format === 'json' || format === 'ndjson') {
    // The machine-readable shape keeps its stable English key and value; only
    // the human-facing frame follows the configured output language, the way
    // `batch` already does it.
    console.error(JSON.stringify({ ok: false, type: 'error', error: message }));
  } else {
    const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    console.error(localize(language, `错误：${message}`, `Error: ${message}`));
  }
}

function printTable(result: QueryResult): void {
  if (result.columns.length === 0) {
    console.log('(no columns)');
    return;
  }
  const rows = result.rows.map((row) => row.map(formatCell));
  const widths = result.columns.map((col, i) =>
    Math.min(80, Math.max(col.length, ...rows.map((row) => row[i]?.length ?? 0))),
  );
  const pad = (value: string, width: number) =>
    value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value.padEnd(width);
  console.log(result.columns.map((c, i) => pad(c, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
