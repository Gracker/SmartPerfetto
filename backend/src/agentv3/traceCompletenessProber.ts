// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace Data Completeness Prober
 *
 * Probes key Perfetto stdlib tables to determine which analysis capabilities
 * are available for a given trace. Cross-references with architecture detection
 * to distinguish "config not enabled" from "not applicable".
 *
 * Two-layer probing:
 *   1. Schema existence — sqlite_master check (which tables/views exist)
 *   2. Data existence — EXISTS(SELECT 1 FROM table) for tables that exist in schema
 *
 * Result categories:
 *   - available: data present, analysis possible
 *   - missing_config_suspected: schema missing or empty, likely trace config issue
 *   - not_applicable: architecture/version mismatch, not a config issue
 *   - insufficient_or_scene_absent: sparse data, ambiguous cause
 */

import type { RenderingArchitectureType } from '../agent/detectors/types';
import {buildCapabilityManifest} from '../services/capabilityManifest';
import {
  resolveCapabilityTraceIdentity,
  resolveCapabilityTraceProcessorIdentity,
  sanitizeCapabilityTraceProcessorReportedVersion,
  type CapabilityTraceIdentityResolution,
} from '../services/capabilityManifestRuntimeIdentity';
import type { TraceProcessorService } from '../services/traceProcessorService';
import type {
  BuildCapabilityManifestInput,
  CapabilityManifestResolutionV1,
  CapabilityManifestTraceProcessorIdentityV1,
  CapabilityManifestV1,
} from '../types/capabilityManifest';
import type { CapabilityProbeResult, CapabilityStatus, TraceCompleteness } from './types';

/** Minimum row count below which data is considered "insufficient". */
const INSUFFICIENT_THRESHOLD = 3;
const CAPABILITY_METADATA_QUERY_OPTIONS = {
  priority: 'p1',
  timeoutMs: 2000,
  maxRows: 1,
  maxResponseBytes: 4096,
  suppressErrorLog: true,
} as const;
const TRACE_PROCESSOR_VERSION_SQL = [
  'SELECT str_value AS reported_version',
  'FROM metadata',
  "WHERE name = 'trace_processor_version'",
  'LIMIT 1',
].join('\n');
const TRACE_BOUNDS_SQL = [
  'SELECT CAST(start_ts AS TEXT) AS start_ns,',
  '       CAST(end_ts AS TEXT) AS end_ns',
  'FROM trace_bounds',
  'LIMIT 1',
].join('\n');
const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;
const SAFE_DETAIL_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface TraceCompletenessManifestDependencies {
  resolveTraceIdentity?: typeof resolveCapabilityTraceIdentity;
  resolveTraceProcessorIdentity?: typeof resolveCapabilityTraceProcessorIdentity;
  buildManifest?: (input: BuildCapabilityManifestInput) => CapabilityManifestV1;
}

/** Capability definition — maps an analysis domain to its primary detection table. */
interface CapabilityDef {
  id: string;
  displayName: string;
  /** Primary table to probe for data existence */
  primaryTable: string;
  /** Stdlib modules that must be included before probing this table. */
  requiredModules?: string[];
  /** Capture guidance appended when the table is missing or empty. */
  captureHint?: string;
  /** Architectures where this capability is relevant (empty = all) */
  applicableArchs?: RenderingArchitectureType[];
  /** Architectures where this capability is explicitly NOT relevant */
  excludedArchs?: RenderingArchitectureType[];
  /** Priority for reporting: CRITICAL capabilities are flagged prominently when missing */
  priority: 'critical' | 'recommended' | 'optional';
}

/**
 * Capability registry — the authoritative list of probed capabilities.
 * Order determines output order. Each entry maps to a section in
 * knowledge-data-sources.template.md for detailed capture guidance.
 */
const CAPABILITY_REGISTRY: CapabilityDef[] = [
  // ── Frame rendering (core for scrolling/jank analysis) ──
  {
    id: 'frame_rendering',
    displayName: '帧渲染/滑动分析',
    primaryTable: 'actual_frame_timeline_slice',
    excludedArchs: ['FLUTTER', 'WEBVIEW', 'GAME_ENGINE'],
    priority: 'critical',
  },
  {
    id: 'flutter_rendering',
    displayName: 'Flutter 渲染分析',
    // Flutter engine slices (1.ui, 1.raster, GPURasterizer) are in the generic slice table.
    // We use android_frames as the primary probe — it's populated when frame timeline + Flutter
    // pipeline detection succeeds. Falls back to architecture detection for flutter-specific analysis.
    primaryTable: 'android_frames',
    applicableArchs: ['FLUTTER'],
    priority: 'critical',
  },

  // ── Startup ──
  {
    id: 'startup',
    displayName: '启动性能分析',
    primaryTable: 'android_startups',
    priority: 'critical',
  },

  // ── IPC / synchronization ──
  {
    id: 'binder_ipc',
    displayName: 'Binder/IPC 分析',
    primaryTable: 'android_binder_txns',
    priority: 'recommended',
  },
  {
    id: 'lock_contention',
    displayName: '锁竞争分析',
    primaryTable: 'android_monitor_contention',
    priority: 'recommended',
  },

  // ── Memory ──
  {
    id: 'gc_memory',
    displayName: 'GC/内存分析',
    primaryTable: 'android_garbage_collection_events',
    priority: 'recommended',
  },
  {
    id: 'memory_pressure',
    displayName: '内存压力/LMK',
    primaryTable: 'android_oom_adj_intervals',
    priority: 'recommended',
  },

  // ── CPU ──
  {
    id: 'cpu_scheduling',
    displayName: 'CPU 调度分析',
    primaryTable: 'sched_slice',
    priority: 'critical',
  },
  {
    id: 'thermal_throttling',
    displayName: '热降频分析',
    primaryTable: 'android_dvfs_counters',
    priority: 'recommended',
  },

  // ── I/O ──
  {
    id: 'disk_io',
    displayName: 'I/O 分析',
    primaryTable: 'linux_active_block_io_operations_by_device',
    priority: 'optional',
  },

  // ── Network ──
  {
    id: 'network_packets',
    displayName: '网络包/流量分析',
    primaryTable: 'android_network_packets',
    requiredModules: ['android.network_packets'],
    captureHint: '需要 android.network_packets 数据源；该能力只证明包收发/接口/协议/流量，不能直接证明 DNS/TCP/TLS/TTFB 阶段耗时',
    priority: 'optional',
  },

  // ── GPU ──
  {
    id: 'gpu',
    displayName: 'GPU 分析',
    primaryTable: 'gpu_slice',
    priority: 'optional',
  },

  // ── Profiling ──
  {
    id: 'cpu_profiling',
    displayName: 'CPU Profiling',
    primaryTable: 'linux_perf_samples_summary_tree',
    priority: 'optional',
  },

  // ── Input ──
  {
    id: 'input_latency',
    displayName: '输入延迟分析',
    primaryTable: 'android_input_events',
    priority: 'recommended',
  },

  // ── Display pipeline ──
  {
    id: 'surfaceflinger',
    displayName: 'SurfaceFlinger/Display 管线',
    primaryTable: 'android_surfaceflinger_workloads',
    priority: 'recommended',
  },

  // ── System state ──
  {
    id: 'device_state',
    displayName: '设备状态',
    primaryTable: 'android_screen_state',
    priority: 'optional',
  },
  {
    id: 'battery_power',
    displayName: '电池/功耗分析',
    primaryTable: 'android_battery_stats_state',
    priority: 'optional',
  },

  // ── IRQ ──
  {
    id: 'interrupts',
    displayName: 'IRQ/中断分析',
    primaryTable: 'linux_hard_irqs',
    priority: 'optional',
  },

  // ── ANR ──
  {
    id: 'anr',
    displayName: 'ANR 分析',
    primaryTable: 'android_anrs',
    priority: 'optional',
  },

  // ── Wattson power-modeling prerequisites; see docs/reference/skill-system.md for Skill validation policy. ──
  // Power skills require specific capture sources. Most production traces don't enable them,
  // so the prompt must surface gaps before Claude trusts empty tables.
  // These entries explicitly INCLUDE their stdlib modules before probing; otherwise sqlite_master
  // reports the tables as missing even when the trace data would support them.
  {
    id: 'power_rails',
    displayName: '功耗 Rails 实测（ODPM / PowerStats）',
    primaryTable: 'android_power_rails_counters',
    requiredModules: ['android.power_rails'],
    captureHint: '需要 android.power collect_power_rails，且设备硬件支持 power rails',
    priority: 'optional',
  },
  {
    id: 'battery_counters',
    displayName: '电池电量/电流采样（功耗前置）',
    primaryTable: 'android_battery_charge',
    requiredModules: ['android.battery'],
    captureHint: '需要 android.power battery_poll_ms 采样',
    priority: 'optional',
  },
  {
    id: 'cpu_freq_idle',
    displayName: 'CPU 频率/Idle 状态（Wattson 前置）',
    primaryTable: 'cpu_idle_counters',
    requiredModules: ['linux.cpu.idle'],
    captureHint: '需要 ftrace cpu_idle/cpu_frequency 相关事件；只有频率没有 idle 时 Wattson 估算不完整',
    priority: 'optional',
  },
  {
    id: 'gpu_work_period',
    displayName: 'GPU Work Period（Wattson GPU 前置）',
    primaryTable: 'android_gpu_work_period_track',
    requiredModules: ['android.gpu.work_period'],
    captureHint: '需要 android.gpu.work_period 数据源；否则无法做 GPU active region/能耗归因',
    priority: 'optional',
  },
];

async function loadProbeModules(
  tps: TraceProcessorService,
  traceId: string,
): Promise<void> {
  const modules = Array.from(new Set(
    CAPABILITY_REGISTRY.flatMap(cap => cap.requiredModules ?? []),
  ));
  if (modules.length === 0) return;

  for (const module of modules) {
    try {
      const result = await tps.query(traceId, `INCLUDE PERFETTO MODULE ${module};`);
      if ((result as any)?.error) {
        console.warn(`[TraceCompleteness] Failed to load probe module ${module}: ${(result as any).error}`);
      }
    } catch (err) {
      console.warn(`[TraceCompleteness] Failed to load probe module ${module}:`, (err as Error).message);
    }
  }
}

function appendCaptureHint(reason: string, cap: CapabilityDef): string {
  return cap.captureHint ? `${reason}；${cap.captureHint}` : reason;
}

function hasExactColumns(
  columns: readonly string[],
  expected: readonly string[],
): boolean {
  return columns.length === expected.length &&
    columns.every((column, index) => column === expected[index]);
}

async function probeReportedVersion(
  tps: TraceProcessorService,
  traceId: string,
): Promise<string | undefined> {
  try {
    const result = await tps.queryBounded(
      traceId,
      TRACE_PROCESSOR_VERSION_SQL,
      CAPABILITY_METADATA_QUERY_OPTIONS,
    );
    if (
      result.error ||
      !hasExactColumns(result.columns, ['reported_version']) ||
      result.rows.length > 1
    ) {
      return undefined;
    }
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    if (!Array.isArray(row) || row.length !== 1) return undefined;
    return sanitizeCapabilityTraceProcessorReportedVersion(row[0]);
  } catch {
    return undefined;
  }
}

async function probeClockRange(
  tps: TraceProcessorService,
  traceId: string,
): Promise<{startNs: string; endNs: string} | undefined> {
  try {
    const result = await tps.queryBounded(
      traceId,
      TRACE_BOUNDS_SQL,
      CAPABILITY_METADATA_QUERY_OPTIONS,
    );
    if (
      result.error ||
      !hasExactColumns(result.columns, ['start_ns', 'end_ns']) ||
      result.rows.length !== 1
    ) {
      return undefined;
    }
    const row = result.rows[0];
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== 'string' ||
      typeof row[1] !== 'string' ||
      !CANONICAL_NON_NEGATIVE_INTEGER.test(row[0]) ||
      !CANONICAL_NON_NEGATIVE_INTEGER.test(row[1])
    ) {
      return undefined;
    }
    const [startNs, endNs] = row;
    if (BigInt(startNs) > BigInt(endNs)) return undefined;
    return {startNs, endNs};
  } catch {
    return undefined;
  }
}

function unavailableTraceResolution(
  resolution: Extract<CapabilityTraceIdentityResolution, {status: 'unavailable'}>,
): CapabilityManifestResolutionV1 {
  const detailCode = typeof resolution.detail === 'string' &&
    SAFE_DETAIL_CODE.test(resolution.detail)
    ? resolution.detail
    : undefined;
  return {
    status: 'unavailable',
    reason: resolution.reason,
    ...(detailCode === undefined ? {} : {detailCode}),
  };
}

async function resolveCapabilityManifestShadow(
  tps: TraceProcessorService,
  traceId: string,
  legacyResult: Omit<TraceCompleteness, 'capabilityManifestResolution'>,
  dependencies: TraceCompletenessManifestDependencies,
): Promise<CapabilityManifestResolutionV1> {
  const traceResolver = dependencies.resolveTraceIdentity ??
    resolveCapabilityTraceIdentity;
  const traceProcessorResolver = dependencies.resolveTraceProcessorIdentity ??
    resolveCapabilityTraceProcessorIdentity;
  const manifestBuilder = dependencies.buildManifest ?? buildCapabilityManifest;

  let traceSource: 'local_file' | 'external_rpc' | undefined;
  try {
    traceSource = tps.getTraceSourceKind(traceId);
  } catch {
    return {status: 'unavailable', reason: 'trace_source_unavailable'};
  }
  if (traceSource === undefined) {
    return {status: 'unavailable', reason: 'trace_source_unavailable'};
  }

  if (traceSource === 'external_rpc') {
    try {
      const traceResolution = await traceResolver({
        source: 'external_rpc',
        traceSide: 'current',
      });
      return traceResolution.status === 'unavailable'
        ? unavailableTraceResolution(traceResolution)
        : {status: 'unavailable', reason: 'identity_resolution_failed'};
    } catch {
      return {status: 'unavailable', reason: 'identity_resolution_failed'};
    }
  }

  let traceFilePath: string | undefined;
  try {
    traceFilePath = tps.getTrace(traceId)?.filePath;
  } catch {
    return {status: 'unavailable', reason: 'trace_source_unavailable'};
  }
  if (!traceFilePath) {
    return {status: 'unavailable', reason: 'trace_file_unavailable'};
  }

  const [reportedVersion, clockRangeNs] = await Promise.all([
    probeReportedVersion(tps, traceId),
    probeClockRange(tps, traceId),
  ]);

  let traceResolution: CapabilityTraceIdentityResolution;
  try {
    traceResolution = await traceResolver({
      source: 'local_file',
      filePath: traceFilePath,
      traceSide: 'current',
      ...(clockRangeNs === undefined ? {} : {clockRangeNs}),
    });
  } catch {
    return {status: 'unavailable', reason: 'identity_resolution_failed'};
  }
  if (traceResolution.status === 'unavailable') {
    return unavailableTraceResolution(traceResolution);
  }

  let traceProcessor: CapabilityManifestTraceProcessorIdentityV1 = {
    source: 'unknown',
    unavailableReason: 'identity_resolution_failed',
  };
  try {
    const input = tps.getRunningCapabilityTraceProcessorInput(traceId);
    if (input) {
      try {
        traceProcessor = await traceProcessorResolver(input);
      } catch {
        traceProcessor = {
          source: 'unknown',
          unavailableReason: 'identity_resolution_failed',
        };
      }
    }
  } catch {
    traceProcessor = {
      source: 'unknown',
      unavailableReason: 'identity_resolution_failed',
    };
  }
  if (reportedVersion !== undefined) {
    traceProcessor = {...traceProcessor, reportedVersion};
  }

  try {
    return {
      status: 'ready',
      manifest: manifestBuilder({
        definitions: CAPABILITY_REGISTRY.map(capability => ({
          id: capability.id,
          displayName: capability.displayName,
          primaryTable: capability.primaryTable,
          ...(capability.requiredModules === undefined
            ? {}
            : {requiredModules: [...capability.requiredModules]}),
        })),
        legacyProbe: legacyResult,
        traceProcessor,
        trace: traceResolution.identity,
        provenance: {traceId},
        generatedAt: Date.now(),
      }),
    };
  } catch {
    return {status: 'failed', reason: 'capability_manifest_build_failed'};
  }
}

/**
 * Probe trace data completeness.
 *
 * @param tps TraceProcessorService instance
 * @param traceId Active trace ID
 * @param architectureType Detected architecture (used for not_applicable filtering)
 * @returns TraceCompleteness diagnosis
 */
export async function probeTraceCompleteness(
  tps: TraceProcessorService,
  traceId: string,
  architectureType?: RenderingArchitectureType,
  manifestDependencies: TraceCompletenessManifestDependencies = {},
): Promise<TraceCompleteness> {
  const t0 = Date.now();

  await loadProbeModules(tps, traceId);

  // ── Layer 1: Schema existence check ──────────────────────────────────────
  // Query sqlite_master for all table/view names relevant to our capabilities.
  const schemaResult = await tps.query(
    traceId,
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
  ).catch(() => null);

  const existingTables = new Set<string>();
  if (schemaResult?.rows) {
    for (const row of schemaResult.rows) {
      existingTables.add(row[0] as string);
    }
  }

  // ── Layer 2: Data existence check (only for tables that exist in schema) ──
  // Build a single UNION ALL query for efficiency.
  const tablesToProbe = CAPABILITY_REGISTRY
    .filter(cap => existingTables.has(cap.primaryTable))
    .map(cap => cap.primaryTable);

  const dataPresence = new Map<string, number>(); // table → approximate row count

  if (tablesToProbe.length > 0) {
    // COUNT with LIMIT ${INSUFFICIENT_THRESHOLD} — only need to distinguish: 0 / 1..threshold / >threshold.
    const unionParts = tablesToProbe.map(
      t => `SELECT '${t}' AS tbl, COUNT(*) AS cnt FROM (SELECT 1 FROM ${t} LIMIT ${INSUFFICIENT_THRESHOLD})`,
    );
    const countSql = unionParts.join(' UNION ALL ');

    try {
      const countResult = await tps.query(traceId, countSql);
      if (countResult?.rows) {
        for (const row of countResult.rows) {
          dataPresence.set(row[0] as string, row[1] as number);
        }
      }
    } catch (err) {
      // If the batch query fails (rare — e.g., one table has incompatible schema),
      // fall back to individual probes.
      console.warn('[TraceCompleteness] Batch count failed, falling back to individual probes:', (err as Error).message);
      await Promise.all(tablesToProbe.map(async (t) => {
        try {
          const r = await tps.query(traceId, `SELECT COUNT(*) FROM (SELECT 1 FROM ${t} LIMIT ${INSUFFICIENT_THRESHOLD})`);
          dataPresence.set(t, r?.rows?.[0]?.[0] as number ?? 0);
        } catch {
          dataPresence.set(t, 0);
        }
      }));
    }
  }

  // ── Classify each capability ─────────────────────────────────────────────
  const available: CapabilityProbeResult[] = [];
  const missingConfig: CapabilityProbeResult[] = [];
  const notApplicable: CapabilityProbeResult[] = [];
  const insufficient: CapabilityProbeResult[] = [];

  for (const cap of CAPABILITY_REGISTRY) {
    // Architecture applicability check
    if (architectureType) {
      if (cap.applicableArchs && !cap.applicableArchs.includes(architectureType)) {
        notApplicable.push({
          id: cap.id,
          displayName: cap.displayName,
          status: 'not_applicable',
          primaryTable: cap.primaryTable,
          reason: `当前架构 ${architectureType} 不适用`,
        });
        continue;
      }
      if (cap.excludedArchs?.includes(architectureType)) {
        notApplicable.push({
          id: cap.id,
          displayName: cap.displayName,
          status: 'not_applicable',
          primaryTable: cap.primaryTable,
          reason: `${architectureType} 架构使用专用分析管线`,
        });
        continue;
      }
    }

    // Schema existence
    if (!existingTables.has(cap.primaryTable)) {
      missingConfig.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'missing_config_suspected',
        primaryTable: cap.primaryTable,
        reason: appendCaptureHint(`表 ${cap.primaryTable} 不存在 — 可能未开启所需 trace 配置`, cap),
      });
      continue;
    }

    // Data existence
    const rowCount = dataPresence.get(cap.primaryTable) ?? 0;
    if (rowCount === 0) {
      missingConfig.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'missing_config_suspected',
        primaryTable: cap.primaryTable,
        rowEstimate: 0,
        reason: appendCaptureHint(`表 ${cap.primaryTable} 存在但无数据 — 可能未开启所需 atrace/ftrace 配置，或场景未发生`, cap),
      });
    } else if (rowCount < INSUFFICIENT_THRESHOLD) {
      insufficient.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'insufficient_or_scene_absent',
        primaryTable: cap.primaryTable,
        rowEstimate: rowCount,
        reason: `仅 ${rowCount} 行数据 — trace 时长可能不够或场景未充分发生`,
      });
    } else {
      available.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'available',
        primaryTable: cap.primaryTable,
        rowEstimate: rowCount,
      });
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[TraceCompleteness] Probed ${CAPABILITY_REGISTRY.length} capabilities in ${elapsed}ms: ` +
    `available=${available.length}, missing=${missingConfig.length}, ` +
    `n/a=${notApplicable.length}, insufficient=${insufficient.length}`,
  );

  const legacyResult: Omit<TraceCompleteness, 'capabilityManifestResolution'> = {
    available,
    missingConfig,
    notApplicable,
    insufficient,
    diagnosedAt: Date.now(),
  };
  let capabilityManifestResolution: CapabilityManifestResolutionV1;
  try {
    capabilityManifestResolution = await resolveCapabilityManifestShadow(
      tps,
      traceId,
      legacyResult,
      manifestDependencies,
    );
  } catch {
    capabilityManifestResolution = {
      status: 'failed',
      reason: 'capability_manifest_build_failed',
    };
  }
  return {...legacyResult, capabilityManifestResolution};
}

/** Export the registry for use by comparison mode's capability dictionary. */
export { CAPABILITY_REGISTRY };
export type { CapabilityDef };
