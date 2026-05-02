// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FlamegraphAnalysis,
  FlamegraphAnalyzeOptions,
  FlamegraphAvailability,
  FlamegraphCategoryStat,
  FlamegraphFrameCategory,
  FlamegraphFunctionStat,
  FlamegraphHotPath,
  FlamegraphNode,
  FlamegraphPerfettoSummaryRow,
} from './flamegraphTypes';
import type { TraceProcessorService } from './traceProcessorService';

interface PerfettoSummarySource {
  module: string;
  table: string;
  sampleSource: string;
}

interface RustAnalyzerCommand {
  command: string;
  args: string[];
  label: string;
  cwd: string;
}

interface NormalizedOptions {
  startTs?: string;
  endTs?: string;
  packageName?: string;
  threadName?: string;
  sampleSource?: string;
  maxNodes: number;
  minSampleCount: number;
}

interface SummarySourceStats {
  source: PerfettoSummarySource;
  nodeCount: number;
  sampleCount: number;
  rootSampleCount: number;
}

const PERFETTO_SUMMARY_SOURCES: PerfettoSummarySource[] = [
  {
    module: 'linux.perf.samples',
    table: 'linux_perf_samples_summary_tree',
    sampleSource: 'perf_sample',
  },
  {
    module: 'appleos.instruments.samples',
    table: 'appleos_instruments_samples_summary_tree',
    sampleSource: 'instruments_sample',
  },
];

function toSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return identifier;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeNumericSql(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`${fieldName} must be a numeric timestamp`);
  }
  return raw;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function repoRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === 'backend' ? path.resolve(cwd, '..') : cwd;
}

function normalizeOptions(options: FlamegraphAnalyzeOptions = {}): NormalizedOptions {
  return {
    startTs: normalizeNumericSql(options.startTs, 'startTs'),
    endTs: normalizeNumericSql(options.endTs, 'endTs'),
    packageName: normalizeText(options.packageName),
    threadName: normalizeText(options.threadName),
    sampleSource: normalizeText(options.sampleSource),
    maxNodes: clampInt(options.maxNodes, 3000, 50, 20_000),
    minSampleCount: clampInt(options.minSampleCount, 1, 1, 1_000_000),
  };
}

function rowObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    out[column] = row[index];
  });
  return out;
}

async function queryRows(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  const result = await traceProcessorService.query(traceId, sql);
  return result.rows.map((row) => rowObject(result.columns, row));
}

async function loadPerfettoModule(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  module: string
): Promise<void> {
  await traceProcessorService.query(traceId, `INCLUDE PERFETTO MODULE ${module};`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSummarySourceStatsOnce(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  source: PerfettoSummarySource
): Promise<SummarySourceStats | null> {
  await loadPerfettoModule(traceProcessorService, traceId, source.module);
  const table = toSqlIdentifier(source.table);
  const rows = await queryRows(
    traceProcessorService,
    traceId,
    `
      SELECT
        COUNT(*) AS node_count,
        COALESCE(SUM(self_count), 0) AS sample_count,
        COALESCE(SUM(CASE WHEN parent_id IS NULL THEN cumulative_count ELSE 0 END), 0) AS root_sample_count
      FROM ${table}
    `
  );
  const row = rows[0] ?? {};
  return {
    source,
    nodeCount: Number(row.node_count ?? 0),
    sampleCount: Number(row.sample_count ?? 0),
    rootSampleCount: Number(row.root_sample_count ?? 0),
  };
}

async function getSummarySourceStats(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  source: PerfettoSummarySource
): Promise<SummarySourceStats | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await getSummarySourceStatsOnce(traceProcessorService, traceId, source);
    } catch {
      if (attempt === 0) {
        await sleep(50);
      }
    }
  }
  return null;
}

async function findAvailableSummarySource(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  requested?: string
): Promise<SummarySourceStats | null> {
  const candidates = requested
    ? PERFETTO_SUMMARY_SOURCES.filter((source) => source.table === requested || source.sampleSource === requested)
    : PERFETTO_SUMMARY_SOURCES;

  for (const source of candidates) {
    const stats = await getSummarySourceStats(traceProcessorService, traceId, source);
    if (stats && stats.nodeCount > 0 && stats.sampleCount > 0) {
      return stats;
    }
  }
  return null;
}

export async function getFlamegraphAvailability(
  traceProcessorService: TraceProcessorService,
  traceId: string
): Promise<FlamegraphAvailability> {
  const availableSources: FlamegraphAvailability['availableSources'] = [];
  const warnings: string[] = [];

  let selected: SummarySourceStats | null = null;
  for (const source of PERFETTO_SUMMARY_SOURCES) {
    const stats = await getSummarySourceStats(traceProcessorService, traceId, source);
    if (!stats) {
      continue;
    }
    availableSources.push({
      name: source.table,
      hasCallsiteId: true,
      hasTimestamp: false,
      hasThreadId: false,
    });
    if (stats.nodeCount === 0 || stats.sampleCount === 0) {
      warnings.push(`${source.table} 存在，但没有 CPU 调用栈采样数据。`);
      continue;
    }
    selected ??= stats;
  }

  const missing = selected
    ? []
    : ['Perfetto stdlib summary tree: linux_perf_samples_summary_tree / appleos_instruments_samples_summary_tree'];

  return {
    available: !!selected,
    sampleSource: selected?.source.table,
    availableSources,
    missing,
    warnings,
  };
}

function ignoredFilterWarnings(options: NormalizedOptions): string[] {
  const ignored: string[] = [];
  if (options.startTs || options.endTs) {
    ignored.push('当前火焰图复用 Perfetto 全量 summary tree，暂未应用时间窗口过滤。');
  }
  if (options.packageName) {
    ignored.push('当前火焰图复用 Perfetto 全量 summary tree，暂未应用进程过滤。');
  }
  if (options.threadName) {
    ignored.push('当前火焰图复用 Perfetto 全量 summary tree，暂未应用线程过滤。');
  }
  return ignored;
}

async function loadPerfettoSummaryRows(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  source: PerfettoSummarySource,
  options: NormalizedOptions
): Promise<{
  rows: FlamegraphPerfettoSummaryRow[];
  truncated: boolean;
}> {
  await loadPerfettoModule(traceProcessorService, traceId, source.module);
  const table = toSqlIdentifier(source.table);
  const rows = await queryRows(
    traceProcessorService,
    traceId,
    `
    SELECT
      id,
      parent_id,
      COALESCE(name, '[unknown]') AS name,
      COALESCE(mapping_name, '') AS mapping_name,
      self_count,
      cumulative_count
    FROM ${table}
    WHERE cumulative_count >= ${options.minSampleCount}
    ORDER BY cumulative_count DESC, self_count DESC, name ASC
    LIMIT ${options.maxNodes + 1}
  `
  );

  const truncated = rows.length > options.maxNodes;
  const usedRows = truncated ? rows.slice(0, options.maxNodes) : rows;
  return {
    rows: usedRows
      .map((row) => ({
        id: Number(row.id),
        parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
        name: String(row.name ?? '[unknown]'),
        mappingName: row.mapping_name ? String(row.mapping_name) : null,
        selfCount: Number(row.self_count ?? 0),
        cumulativeCount: Number(row.cumulative_count ?? 0),
      }))
      .filter((row) => Number.isFinite(row.id) && row.cumulativeCount > 0),
    truncated,
  };
}

function emptyRoot(): FlamegraphNode {
  return {
    id: 'root',
    name: '全部采样',
    value: 0,
    selfValue: 0,
    depth: 0,
    children: [],
  };
}

function normalizeFrameName(name: string): string {
  const trimmed = name.trim();
  return trimmed || '[unknown]';
}

function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value * 10_000) / total) / 100;
}

function categoryLabel(category: FlamegraphFrameCategory): string {
  switch (category) {
    case 'app':
      return '业务代码';
    case 'android-framework':
      return 'Android Framework';
    case 'art-runtime':
      return 'ART/JIT 运行时';
    case 'graphics-rendering':
      return '图形渲染';
    case 'native':
      return 'Native 库';
    case 'kernel':
      return 'Kernel';
    case 'unknown':
      return '未知符号';
  }
}

function classifyFrame(name: string, mappingName?: string | null): FlamegraphFrameCategory {
  const frame = normalizeFrameName(name);
  const lowerName = frame.toLowerCase();
  const lowerMapping = (mappingName || '').toLowerCase();
  const combined = `${lowerName} ${lowerMapping}`;

  if (lowerName === '[unknown]' || lowerName === 'unknown') {
    return 'unknown';
  }
  if (
    combined.includes('libhwui') ||
    combined.includes('skia') ||
    combined.includes('surfaceflinger') ||
    combined.includes('renderthread') ||
    combined.includes('vulkan') ||
    combined.includes('opengl') ||
    combined.includes('egl')
  ) {
    return 'graphics-rendering';
  }
  if (
    combined.includes('kernel') ||
    lowerMapping.includes('kallsyms') ||
    /^sys_|^__schedule|^do_syscall|^futex_|^binder_/.test(lowerName)
  ) {
    return 'kernel';
  }
  if (
    combined.includes('libart') ||
    combined.includes('libdexfile') ||
    combined.includes('dalvik') ||
    combined.includes('.oat') ||
    combined.includes('.vdex') ||
    lowerName.startsWith('art::')
  ) {
    return 'art-runtime';
  }
  if (
    lowerName.startsWith('android.') ||
    lowerName.startsWith('androidx.') ||
    lowerName.startsWith('com.android.') ||
    lowerMapping.includes('framework.jar') ||
    lowerMapping.includes('services.jar') ||
    lowerMapping.includes('framework-res')
  ) {
    return 'android-framework';
  }
  if (
    lowerMapping.endsWith('.apk') ||
    lowerMapping.includes('/base.apk') ||
    lowerMapping.includes('split_config') ||
    lowerMapping.includes('.apk!') ||
    (/^(com|org|io|net)\.[a-z0-9_]+/.test(lowerName) && !lowerName.startsWith('com.android.'))
  ) {
    return 'app';
  }
  if (lowerMapping.endsWith('.so') || lowerMapping.includes('.so') || lowerName.includes('.so!')) {
    return 'native';
  }

  return 'unknown';
}

function compressFrames(frames: string[]): string[] {
  if (frames.length <= 10) {
    return frames;
  }

  const head = frames.slice(0, 2);
  const tail = frames.slice(-4);
  const middle = frames
    .slice(2, -4)
    .filter((frame) => {
      const category = classifyFrame(frame);
      return category === 'app' || category === 'android-framework' || category === 'graphics-rendering';
    })
    .slice(-2);

  return [...head, '...', ...middle, '...', ...tail].filter((frame, index, all) => {
    return !(frame === '...' && all[index - 1] === '...');
  });
}

function buildPath(row: FlamegraphPerfettoSummaryRow, rowsById: Map<number, FlamegraphPerfettoSummaryRow>): string[] {
  const frames: string[] = [];
  const seen = new Set<number>();
  let current: FlamegraphPerfettoSummaryRow | undefined = row;

  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    frames.push(normalizeFrameName(current.name));
    current = current.parentId === null ? undefined : rowsById.get(current.parentId);
  }

  return frames.reverse();
}

function buildFunctionStat(row: FlamegraphPerfettoSummaryRow, sampleCount: number): FlamegraphFunctionStat {
  const category = classifyFrame(row.name, row.mappingName);
  const selfPercentage = pct(row.selfCount, sampleCount);
  const cumulativePercentage = pct(row.cumulativeCount, sampleCount);
  return {
    name: normalizeFrameName(row.name),
    mappingName: row.mappingName,
    sampleCount: row.cumulativeCount,
    selfCount: row.selfCount,
    percentage: selfPercentage || cumulativePercentage,
    selfPercentage,
    cumulativePercentage,
    category,
    categoryLabel: categoryLabel(category),
  };
}

function buildCategoryBreakdown(
  rows: Iterable<FlamegraphPerfettoSummaryRow>,
  sampleCount: number
): FlamegraphCategoryStat[] {
  const byCategory = new Map<FlamegraphFrameCategory, { sampleCount: number; selfCount: number }>();
  for (const row of rows) {
    const category = classifyFrame(row.name, row.mappingName);
    const current = byCategory.get(category) ?? { sampleCount: 0, selfCount: 0 };
    current.sampleCount += row.cumulativeCount;
    current.selfCount += row.selfCount;
    byCategory.set(category, current);
  }

  return Array.from(byCategory.entries())
    .map(([category, values]) => ({
      category,
      label: categoryLabel(category),
      sampleCount: values.sampleCount,
      selfCount: values.selfCount,
      percentage: pct(values.selfCount, sampleCount),
    }))
    .sort((a, b) => b.selfCount - a.selfCount || b.sampleCount - a.sampleCount || a.label.localeCompare(b.label));
}

function finalizeTreeDepthAndOrder(node: FlamegraphNode, depth: number): FlamegraphNode {
  node.depth = depth;
  node.children = node.children
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .map((child) => finalizeTreeDepthAndOrder(child, depth + 1));
  return node;
}

export function buildFlamegraphFromPerfettoSummaryRows(
  rows: FlamegraphPerfettoSummaryRow[],
  params: {
    sampleCount?: number;
    sourceTable?: string;
    warnings?: string[];
    truncated?: boolean;
    maxNodes?: number;
    analyzerEngine?: 'rust' | 'typescript-fallback';
    analyzerCommand?: string;
  } = {}
): FlamegraphAnalysis {
  const warnings = [...(params.warnings ?? [])];
  const rowsById = new Map<number, FlamegraphPerfettoSummaryRow>();
  for (const row of rows) {
    if (!rowsById.has(row.id)) {
      rowsById.set(row.id, row);
    }
  }

  const root = emptyRoot();
  const nodesById = new Map<number, FlamegraphNode>();
  for (const row of rowsById.values()) {
    nodesById.set(row.id, {
      id: String(row.id),
      name: normalizeFrameName(row.name),
      value: row.cumulativeCount,
      selfValue: row.selfCount,
      depth: 0,
      mappingName: row.mappingName,
      children: [],
    });
  }

  for (const row of rowsById.values()) {
    const node = nodesById.get(row.id);
    if (!node) continue;
    const parent = row.parentId === null ? undefined : nodesById.get(row.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      root.children.push(node);
    }
  }

  const inferredSampleCount = Array.from(rowsById.values()).reduce((sum, row) => sum + row.selfCount, 0);
  const sampleCount = params.sampleCount ?? inferredSampleCount;
  root.value = sampleCount || root.children.reduce((sum, child) => sum + child.value, 0);
  root.selfValue = 0;
  finalizeTreeDepthAndOrder(root, 0);

  const functionStats = Array.from(rowsById.values()).map((row) => buildFunctionStat(row, sampleCount));

  const topFunctions: FlamegraphFunctionStat[] = functionStats
    .slice()
    .sort((a, b) => b.selfCount - a.selfCount || b.sampleCount - a.sampleCount || a.name.localeCompare(b.name))
    .slice(0, 30);

  const topCumulativeFunctions: FlamegraphFunctionStat[] = functionStats
    .slice()
    .sort((a, b) => b.sampleCount - a.sampleCount || b.selfCount - a.selfCount || a.name.localeCompare(b.name))
    .slice(0, 30);

  const hotPaths: FlamegraphHotPath[] = Array.from(rowsById.values())
    .filter((row) => row.selfCount > 0)
    .map((row) => {
      const frames = buildPath(row, rowsById);
      const leafCategory = classifyFrame(row.name, row.mappingName);
      return {
        frames,
        compressedFrames: compressFrames(frames),
        sampleCount: row.selfCount,
        percentage: pct(row.selfCount, sampleCount),
        leafCategory,
        leafCategoryLabel: categoryLabel(leafCategory),
      };
    })
    .sort((a, b) => b.sampleCount - a.sampleCount)
    .slice(0, 20);

  const categoryBreakdown = buildCategoryBreakdown(rowsById.values(), sampleCount);

  if (rows.length === 0) {
    warnings.push('Perfetto 没有产出 CPU 调用栈 summary tree，火焰图为空。');
  }
  if (params.truncated) {
    warnings.push(`Perfetto summary tree 节点超过 ${params.maxNodes ?? '上限'}，已按累计采样数截断。`);
  }

  return {
    available: sampleCount > 0 && root.children.length > 0,
    sampleCount,
    filteredSampleCount: sampleCount,
    root,
    topFunctions,
    topCumulativeFunctions,
    hotPaths,
    categoryBreakdown,
    threadBreakdown: [],
    warnings,
    analyzer: {
      engine: params.analyzerEngine ?? 'typescript-fallback',
      command: params.analyzerCommand,
    },
    source: {
      sampleTable: params.sourceTable ?? 'perfetto_summary_tree',
      hasThreadInfo: false,
      filtersApplied: [],
      truncated: !!params.truncated,
    },
  };
}

function platformExecutableName(baseName: string): string {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function cargoCommandName(): string {
  return process.platform === 'win32' ? 'cargo.cmd' : 'cargo';
}

function killAnalyzerProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32') {
    child.kill();
    return;
  }
  child.kill('SIGKILL');
}

function rustAnalyzerCommand(): RustAnalyzerCommand | null {
  const root = repoRoot();
  const configured = normalizeText(process.env.FLAMEGRAPH_ANALYZER_BIN);
  if (configured) {
    return {
      command: configured,
      args: [],
      label: configured,
      cwd: root,
    };
  }

  const crateDir = path.join(root, 'rust', 'flamegraph-analyzer');
  const manifestPath = path.join(crateDir, 'Cargo.toml');
  const executableName = platformExecutableName('flamegraph-analyzer');
  const releaseBin = path.join(crateDir, 'target', 'release', executableName);
  const debugBin = path.join(crateDir, 'target', 'debug', executableName);

  if (fs.existsSync(releaseBin)) {
    return { command: releaseBin, args: [], label: releaseBin, cwd: root };
  }
  if (fs.existsSync(debugBin)) {
    return { command: debugBin, args: [], label: debugBin, cwd: root };
  }
  if (fs.existsSync(manifestPath)) {
    return {
      command: cargoCommandName(),
      args: ['run', '--quiet', '--manifest-path', manifestPath, '--'],
      label: `cargo run --manifest-path ${manifestPath}`,
      cwd: root,
    };
  }

  return null;
}

async function analyzePerfettoSummaryRowsWithRust(params: {
  rows: FlamegraphPerfettoSummaryRow[];
  sampleCount: number;
  sourceTable: string;
  warnings: string[];
  truncated: boolean;
  maxNodes: number;
}): Promise<FlamegraphAnalysis> {
  const command = rustAnalyzerCommand();
  if (!command) {
    throw new Error('Rust flamegraph analyzer crate was not found');
  }

  const timeoutMs = clampInt(process.env.FLAMEGRAPH_ANALYZER_TIMEOUT_MS, 60_000, 1_000, 300_000);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      killAnalyzerProcess(child);
    }
  }, timeoutMs);

  const result = new Promise<FlamegraphAnalysis>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 20_000_000) {
        killAnalyzerProcess(child);
        reject(new Error('Rust analyzer stdout exceeded safety limit'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 200_000) {
        stderr = stderr.slice(-200_000);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Rust analyzer exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as FlamegraphAnalysis);
      } catch (error: unknown) {
        reject(new Error(`Rust analyzer returned invalid JSON: ${errorMessage(error)}`));
      }
    });
  });

  child.stdin.end(JSON.stringify(params));
  const analysis = await result;
  return {
    ...analysis,
    analyzer: {
      engine: 'rust',
      command: command.label,
    },
  };
}

export async function analyzeFlamegraph(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  rawOptions: FlamegraphAnalyzeOptions = {}
): Promise<FlamegraphAnalysis> {
  const options = normalizeOptions(rawOptions);
  const stats = await findAvailableSummarySource(traceProcessorService, traceId, options.sampleSource);

  if (!stats) {
    return buildFlamegraphFromPerfettoSummaryRows([], {
      sourceTable: options.sampleSource,
      warnings: ['这个 Trace 没有 CPU 调用栈采样，不能分析火焰图数据。'],
      maxNodes: options.maxNodes,
    });
  }

  const loaded = await loadPerfettoSummaryRows(traceProcessorService, traceId, stats.source, options);
  const warnings = ignoredFilterWarnings(options);
  const sampleCount = stats.sampleCount || stats.rootSampleCount;
  let analysis: FlamegraphAnalysis;

  try {
    analysis = await analyzePerfettoSummaryRowsWithRust({
      rows: loaded.rows,
      sampleCount,
      sourceTable: stats.source.table,
      warnings,
      truncated: loaded.truncated,
      maxNodes: options.maxNodes,
    });
  } catch (error: unknown) {
    analysis = buildFlamegraphFromPerfettoSummaryRows(loaded.rows, {
      sampleCount,
      sourceTable: stats.source.table,
      warnings: [...warnings, `Rust 火焰图分析器暂不可用，已使用 TypeScript 兜底：${errorMessage(error)}`],
      truncated: loaded.truncated,
      maxNodes: options.maxNodes,
      analyzerEngine: 'typescript-fallback',
    });
  }

  analysis.source = {
    sampleTable: stats.source.table,
    hasThreadInfo: false,
    filtersApplied: [],
    truncated: loaded.truncated,
  };

  return analysis;
}
