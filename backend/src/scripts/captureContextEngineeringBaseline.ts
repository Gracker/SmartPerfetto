// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Phase -1 of v2.1 — capture a metrics baseline for the
 * context-engineering refactor.
 *
 * The script does **not** drive the analyses itself; it simply walks
 * the on-disk session metrics emitted by `AgentMetricsCollector`
 * (see `agentMetrics.persistSessionMetrics`) and produces an aggregated
 * JSON report so post-PR runs can be diffed against the baseline.
 *
 * Typical workflow:
 *
 *   1. Run the canonical analyses (e.g. via `verifyAgentSseScrolling`)
 *      against the 6 regression traces with the same query.
 *   2. Immediately call this script with `--stage current` (or
 *      `post-P0` / `post-v2.1` after each milestone).
 *   3. Diff the JSON files for cache-read ratio, cost, and so on.
 *
 * Usage:
 *   tsx src/scripts/captureContextEngineeringBaseline.ts \
 *     --stage current \
 *     --since-mins 30 \
 *     --out test-output/baseline-current.json
 */

import * as fs from 'fs';
import * as path from 'path';

type OutputFormat = 'json' | 'markdown';

interface CliOptions {
  stage: string;
  outPath: string;
  sinceMins: number;
  metricsDir: string;
  format: OutputFormat;
}

interface PersistedSessionMetrics {
  sessionId: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  turns: number;
  toolSummary: {
    totalCalls: number;
    totalDurationMs: number;
    successCount: number;
    failureCount: number;
    byTool: Record<string, { calls: number; totalMs: number; avgMs: number; failures: number }>;
  };
  cache?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalCostUsd: number;
    cacheHitRate: number;
  };
  turnMetrics?: {
    totalTurns: number;
    totalDurationMs: number;
    totalToolCalls: number;
    totalPayloadBytes: number;
  };
  analysisMode?: 'fast' | 'full' | 'auto';
  classifierSource?: 'user_explicit' | 'hard_rule' | 'ai';
}

const DEFAULT_METRICS_DIR = path.resolve(__dirname, '..', '..', 'logs', 'metrics');
const DEFAULT_SINCE_MINS = 30;

function printUsage(): void {
  console.log('Usage: tsx src/scripts/captureContextEngineeringBaseline.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --stage <name>       Baseline stage label (current / post-P0 / post-v2.1) — required');
  console.log('  --out <path>         Output report path — required');
  console.log('  --format <kind>      Output format: json (default) or markdown');
  console.log(`  --since-mins <n>     Only include sessions whose mtime is within the last N minutes (default: ${DEFAULT_SINCE_MINS})`);
  console.log(`  --metrics-dir <dir>  Override metrics directory (default: ${DEFAULT_METRICS_DIR})`);
  console.log('  --help               Show this help');
}

function parseArgs(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = {
    sinceMins: DEFAULT_SINCE_MINS,
    metricsDir: DEFAULT_METRICS_DIR,
    format: 'json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--stage') {
      if (!next) throw new Error('--stage requires a value');
      opts.stage = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('--out requires a value');
      opts.outPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--format') {
      if (next !== 'json' && next !== 'markdown') {
        throw new Error(`--format must be 'json' or 'markdown' (got: ${next})`);
      }
      opts.format = next;
      i += 1;
      continue;
    }
    if (arg === '--since-mins') {
      if (!next) throw new Error('--since-mins requires a value');
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --since-mins value: ${next}`);
      }
      opts.sinceMins = parsed;
      i += 1;
      continue;
    }
    if (arg === '--metrics-dir') {
      if (!next) throw new Error('--metrics-dir requires a value');
      opts.metricsDir = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.stage) throw new Error('--stage is required');
  if (!opts.outPath) throw new Error('--out is required');
  return opts as CliOptions;
}

function aggregate(sessions: PersistedSessionMetrics[]) {
  const cacheCapable = sessions.filter(s => s.cache);
  const sumOf = (sel: (s: PersistedSessionMetrics) => number) =>
    sessions.reduce((acc, s) => acc + sel(s), 0);
  const meanOf = (sel: (s: PersistedSessionMetrics) => number | undefined) => {
    const values = sessions.map(sel).filter((v): v is number => typeof v === 'number');
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  };
  return {
    sessionCount: sessions.length,
    cacheCapableCount: cacheCapable.length,
    totalDurationMs: sumOf(s => s.totalDurationMs),
    totalTurns: sumOf(s => s.turns),
    totalToolCalls: sumOf(s => s.toolSummary?.totalCalls ?? 0),
    totalCostUsd: sumOf(s => s.cache?.totalCostUsd ?? 0),
    totalInputTokens: sumOf(s => s.cache?.inputTokens ?? 0),
    totalCacheReadInputTokens: sumOf(s => s.cache?.cacheReadInputTokens ?? 0),
    totalCacheCreationInputTokens: sumOf(s => s.cache?.cacheCreationInputTokens ?? 0),
    meanCacheHitRate: meanOf(s => s.cache?.cacheHitRate),
    meanDurationMs: meanOf(s => s.totalDurationMs),
    meanTurns: meanOf(s => s.turns),
  };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.metricsDir)) {
    console.error(`Metrics directory not found: ${opts.metricsDir}`);
    console.error('Run an analysis first so AgentMetricsCollector has metrics to aggregate.');
    process.exit(2);
  }

  const cutoff = Date.now() - opts.sinceMins * 60 * 1000;
  const files = fs.readdirSync(opts.metricsDir).filter(f => f.endsWith('_metrics.json'));

  const eligible: Array<{ file: string; data: PersistedSessionMetrics; mtimeMs: number }> = [];
  for (const file of files) {
    const filePath = path.join(opts.metricsDir, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedSessionMetrics;
      eligible.push({ file, data, mtimeMs: stat.mtimeMs });
    } catch (err) {
      console.warn(`Skipping malformed metrics file ${file}: ${(err as Error).message}`);
    }
  }
  eligible.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const sessions = eligible.map(e => e.data);
  const report = {
    stage: opts.stage,
    capturedAt: new Date().toISOString(),
    sinceMins: opts.sinceMins,
    metricsDir: opts.metricsDir,
    aggregate: aggregate(sessions),
    sessions: sessions.map(s => ({
      sessionId: s.sessionId,
      analysisMode: s.analysisMode,
      classifierSource: s.classifierSource,
      durationMs: s.totalDurationMs,
      turns: s.turns,
      totalToolCalls: s.toolSummary?.totalCalls ?? 0,
      cache: s.cache,
    })),
  };

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const body = opts.format === 'markdown'
    ? renderMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(opts.outPath, body);
  console.log(`Wrote ${sessions.length} session(s) to ${opts.outPath} (${opts.format})`);
  console.log(`Mean cache hit rate: ${report.aggregate.meanCacheHitRate ?? 'n/a'}`);
  console.log(`Total cost: $${(report.aggregate.totalCostUsd ?? 0).toFixed(4)}`);
}

interface AggregateReport {
  stage: string;
  capturedAt: string;
  sinceMins: number;
  metricsDir: string;
  aggregate: ReturnType<typeof aggregate>;
  sessions: Array<{
    sessionId: string;
    analysisMode?: string;
    classifierSource?: string;
    durationMs: number;
    turns: number;
    totalToolCalls: number;
    cache?: PersistedSessionMetrics['cache'];
  }>;
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null) return 'n/a';
  return `${(ratio * 100).toFixed(1)}%`;
}

function fmtUsd(usd: number | null | undefined): string {
  if (usd == null) return 'n/a';
  return `$${usd.toFixed(4)}`;
}

function renderMarkdown(report: AggregateReport): string {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push(`# Context Engineering Baseline — ${report.stage}`);
  lines.push('');
  lines.push(`Captured: \`${report.capturedAt}\` (window: last ${report.sinceMins} min)`);
  lines.push(`Source: \`${report.metricsDir}\``);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| sessions | ${a.sessionCount} |`);
  lines.push(`| sessions with cache data | ${a.cacheCapableCount} |`);
  lines.push(`| total turns | ${a.totalTurns} |`);
  lines.push(`| total tool calls | ${a.totalToolCalls} |`);
  lines.push(`| total duration | ${fmtMs(a.totalDurationMs)} |`);
  lines.push(`| mean duration | ${a.meanDurationMs == null ? 'n/a' : fmtMs(a.meanDurationMs)} |`);
  lines.push(`| mean turns | ${a.meanTurns == null ? 'n/a' : a.meanTurns.toFixed(1)} |`);
  lines.push(`| **mean cache hit rate** | **${fmtPct(a.meanCacheHitRate)}** |`);
  lines.push(`| total input tokens | ${a.totalInputTokens.toLocaleString()} |`);
  lines.push(`| total cache-read tokens | ${a.totalCacheReadInputTokens.toLocaleString()} |`);
  lines.push(`| total cache-creation tokens | ${a.totalCacheCreationInputTokens.toLocaleString()} |`);
  lines.push(`| **total cost** | **${fmtUsd(a.totalCostUsd)}** |`);
  lines.push('');

  if (report.sessions.length === 0) {
    lines.push('_(no sessions in window)_');
  } else {
    lines.push('## Sessions');
    lines.push('');
    lines.push('| sessionId | mode | turns | tool calls | duration | cache hit | cost |');
    lines.push('|-----------|------|------:|-----------:|---------:|----------:|-----:|');
    for (const s of report.sessions) {
      lines.push(
        `| \`${s.sessionId}\` | ${s.analysisMode ?? '—'} | ${s.turns} | ${s.totalToolCalls} | ${fmtMs(s.durationMs)} | ${fmtPct(s.cache?.cacheHitRate ?? null)} | ${fmtUsd(s.cache?.totalCostUsd ?? null)} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  printUsage();
  process.exit(1);
}
