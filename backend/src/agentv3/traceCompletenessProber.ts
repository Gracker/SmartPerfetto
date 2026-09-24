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
 *
 * Separately, `dataLoss` reads trace_processor's data-loss stats and recovery
 * metadata. It qualifies what the present data can prove (absence is not proof
 * on a lossy trace) and never moves a capability between the buckets above,
 * so it stays out of the capability manifest.
 */

import type { RenderingArchitectureType } from '../agent/detectors/types';
import {
  buildCapabilityManifest,
  isSingleSelectProbeSql,
  projectCapabilityManifestAttribution,
} from '../services/capabilityManifest';
import {
  resolveCapabilityTraceIdentity,
  resolveCapabilityTraceProcessorIdentity,
  sanitizeCapabilityTraceProcessorReportedVersion,
  type CapabilityTraceIdentityResolution,
} from '../services/capabilityManifestRuntimeIdentity';
import type { TraceProcessorService } from '../services/traceProcessorService';
import {currentRunManifestAttributionSink} from '../services/selfEvolution/runManifestLifecycle';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from '../services/selfEvolution/canonicalJson';
import type {
  BuildCapabilityManifestInput,
  CapabilityManifestProbeCacheObservationV1,
  CapabilityManifestResolutionV1,
  CapabilityManifestTraceContentIdentityV1,
  CapabilityManifestTraceProcessorIdentityV1,
  CapabilityManifestV1,
} from '../types/capabilityManifest';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import type {
  CapabilityProbeResult,
  CapabilityStatus,
  TraceCompleteness,
  TraceDataLossDiagnosis,
  TraceDataLossStat,
} from './types';

/** Minimum row count below which data is considered "insufficient". */
const INSUFFICIENT_THRESHOLD = 3;
/** Table names, capability ids and SQL literals the probe builder may interpolate. */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
/**
 * Data-loss stats are read by trace_processor severity, not by name, so stats
 * added by newer runtimes (e.g. long_trace_mode_bytes_overwritten) are picked
 * up without a registry change and older runtimes simply report fewer names.
 * global_trace_sanity_check's data_loss_stats step shows the same rows as
 * evidence; keep the two filters aligned.
 */
const DATA_LOSS_STAT_LIMIT = 16;
const DATA_LOSS_STATS_SQL = [
  'SELECT name, idx, value, COUNT(*) OVER () AS matching_rows',
  'FROM stats',
  "WHERE severity = 'data_loss' AND value > 0",
  'ORDER BY value DESC, name, idx',
  `LIMIT ${DATA_LOSS_STAT_LIMIT}`,
].join('\n');
const DATA_LOSS_QUERY_OPTIONS = {
  ...CAPABILITY_METADATA_QUERY_OPTIONS,
  maxRows: DATA_LOSS_STAT_LIMIT,
  maxResponseBytes: 8192,
} as const;
// A metadata key unknown to an older runtime just yields no row.
const TRACE_RECOVERY_REASON_SQL = [
  'SELECT str_value AS recovery_reason',
  'FROM metadata',
  "WHERE name = 'trace_recovery_reason'",
  'LIMIT 1',
].join('\n');
const STAT_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const RECOVERY_REASON_MAX_CHARS = 200;
const SAFE_DETAIL_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface TraceCompletenessManifestDependencies {
  resolveTraceIdentity?: typeof resolveCapabilityTraceIdentity;
  resolveTraceProcessorIdentity?: typeof resolveCapabilityTraceProcessorIdentity;
  buildManifest?: (input: BuildCapabilityManifestInput) => CapabilityManifestV1;
  projectAttribution?: typeof projectCapabilityManifestAttribution;
  attributionSink?: RunManifestAttributionSink;
}

type TimelessCapabilityManifest = Omit<CapabilityManifestV1, 'provenance'> & {
  provenance: Omit<
    CapabilityManifestV1['provenance'],
    'diagnosedAt' | 'generatedAt'
  >;
};

type TimelessCapabilityManifestResolution =
  | {status: 'ready'; manifest: TimelessCapabilityManifest}
  | Exclude<CapabilityManifestResolutionV1, {status: 'ready'}>;

interface TimelessTraceCompleteness {
  available: CapabilityProbeResult[];
  missingConfig: CapabilityProbeResult[];
  notApplicable: CapabilityProbeResult[];
  insufficient: CapabilityProbeResult[];
  dataLoss: TraceDataLossDiagnosis;
  capabilityManifestResolution: TimelessCapabilityManifestResolution;
}

type CapabilityManifestIdentityPreparation =
  | {
      status: 'ready';
      trace: CapabilityManifestTraceContentIdentityV1;
      traceProcessor: CapabilityManifestTraceProcessorIdentityV1;
    }
  | {
      status: 'unavailable';
      resolution: Extract<CapabilityManifestResolutionV1, {status: 'unavailable'}>;
    };

const TRACE_COMPLETENESS_PROBE_CACHE_LIMIT = 32;
const traceCompletenessProbeCache = new Map<
  string,
  Promise<TimelessTraceCompleteness>
>();

/** Capability definition — maps an analysis domain to its primary detection table. */
interface CapabilityDef {
  id: string;
  displayName: string;
  /** Primary table to probe for data existence */
  primaryTable: string;
  /**
   * Bounded count query replacing the plain `primaryTable` row count. Use it
   * when the capability lives inside a shared table and only some of its rows
   * count — typed counter tracks, for example. `primaryTable` stays the
   * reported label and the schema-existence gate. Build it with
   * {@link boundedProbeCountSql} so the threshold stays defined once.
   */
  probeSql?: string;
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
 * Bound a row-producing SELECT to the insufficiency threshold and turn it into
 * the single-integer-count contract `probeSql` carries. Keeping the bound here
 * leaves `INSUFFICIENT_THRESHOLD` as the one definition of "sparse", and the
 * resulting string embeds the threshold, so changing it changes the manifest
 * identity rather than silently reclassifying old traces.
 */
function boundedProbeCountSql(rowSource: string): string {
  return `SELECT COUNT(*) AS cnt FROM (${rowSource} LIMIT ${INSUFFICIENT_THRESHOLD})`;
}

/**
 * Count `counter` samples carried by Perfetto's typed counter tracks. The types
 * are assigned by the trace_processor ftrace parsers, so they appear on every
 * platform that enables the events — unlike the Pixel-only `android_dvfs_counters`
 * stdlib view this replaced.
 */
function typedCounterTrackProbeSql(trackTypes: readonly string[]): string {
  // These reach SQL as string literals with no escaping. They are authored
  // constants, so a violation is a programming error: fail at module load,
  // where any test run catches it, rather than emitting a broken probe.
  for (const type of trackTypes) {
    if (!SQL_IDENTIFIER.test(type)) {
      throw new Error(`invalid_counter_track_type:${type}`);
    }
  }
  const typeList = trackTypes.map(type => `'${type}'`).join(', ');
  // Drive the scan from the (tiny) track table rather than joining every
  // counter row: when the types are absent a join never reaches its LIMIT and
  // walks the whole counter table at session start.
  return boundedProbeCountSql(
    'SELECT 1 FROM counter ' +
    'WHERE track_id IN (SELECT counter_track.id FROM counter_track ' +
    `WHERE counter_track.type IN (${typeList}))`,
  );
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
    displayName: '热区温度 / 散热设备',
    // ftrace thermal/thermal_temperature and thermal/cdev_update land on typed
    // counter tracks on every platform. The previous probe used the Pixel-only
    // android_dvfs_counters stdlib view, which reported "missing" on every
    // Qualcomm/MTK/OEM trace — and on Pixel too, because the registry never
    // included the android.dvfs module that defines it.
    primaryTable: 'counter',
    probeSql: typedCounterTrackProbeSql([
      'thermal_temperature',
      'cooling_device_counter',
    ]),
    captureHint: '需要 ftrace thermal/thermal_temperature 与 thermal/cdev_update 事件；部分设备/内核不暴露这两个 tracepoint',
    priority: 'recommended',
  },
  {
    id: 'cpu_freq_limits',
    displayName: 'CPU 频率上下限（限频）',
    primaryTable: 'counter',
    probeSql: typedCounterTrackProbeSql([
      'cpu_max_frequency_limit',
      'cpu_min_frequency_limit',
    ]),
    captureHint: '需要 ftrace power/cpu_frequency_limits 事件；只有 power/cpu_frequency 时能看到实际频率，看不到限频上下限',
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
    // A stdlib table, not intrinsic: without the include it looks absent on
    // every trace until some Skill happens to load the module first.
    primaryTable: 'android_input_events',
    requiredModules: ['android.input'],
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

/**
 * One row-count probe. `key` discriminates the batched UNION ALL rows: a plain
 * table probe keys on its table, a `probeSql` probe on its capability, because
 * several capabilities can read different slices of one shared table.
 */
interface CapabilityProbeUnit {
  key: string;
  selectSql: string;
}

export function capabilityProbeKey(
  cap: {id: string; primaryTable: string; probeSql?: string},
): string {
  return cap.probeSql === undefined ? cap.primaryTable : `cap:${cap.id}`;
}

/**
 * Every value this interpolates comes from the authored registry, so the checks
 * below are a backstop against a bad registry edit, not a sanitizer for
 * untrusted input. They are the only gate that runs *before* the probe executes:
 * the manifest's own `probeSql` validation happens afterwards, when the query
 * has already been sent.
 */
function isInterpolatableProbe(cap: CapabilityDef): boolean {
  if (!SQL_IDENTIFIER.test(cap.id) || !SQL_IDENTIFIER.test(cap.primaryTable)) {
    return false;
  }
  return cap.probeSql === undefined || isSingleSelectProbeSql(cap.probeSql);
}

/**
 * Plan one probe per capability whose primary table exists, deduplicated by
 * key so capabilities sharing a table are still counted once.
 */
function planCapabilityProbes(
  existingTables: ReadonlySet<string>,
): CapabilityProbeUnit[] {
  const units = new Map<string, CapabilityProbeUnit>();
  for (const cap of CAPABILITY_REGISTRY) {
    if (!existingTables.has(cap.primaryTable)) continue;
    const key = capabilityProbeKey(cap);
    if (units.has(key)) continue;
    if (!isInterpolatableProbe(cap)) {
      console.warn(
        `[TraceCompleteness] Skipping capability whose probe cannot be built safely: ${cap.id}`,
      );
      continue;
    }
    units.set(key, {
      key,
      selectSql: cap.probeSql === undefined
        ? `SELECT '${key}' AS tbl, (${boundedProbeCountSql(`SELECT 1 FROM ${cap.primaryTable}`)}) AS cnt`
        : `SELECT '${key}' AS tbl, (${cap.probeSql}) AS cnt`,
    });
  }
  return [...units.values()];
}

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

/** Read one string metadata value; any malformed or failed read yields undefined. */
async function probeMetadataString<T>(
  tps: TraceProcessorService,
  traceId: string,
  sql: string,
  column: string,
  sanitize: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  try {
    const result = await tps.queryBounded(traceId, sql, CAPABILITY_METADATA_QUERY_OPTIONS);
    if (result.error || !hasExactColumns(result.columns, [column]) || result.rows.length !== 1) {
      return undefined;
    }
    const row = result.rows[0];
    if (!Array.isArray(row) || row.length !== 1) return undefined;
    return sanitize(row[0]);
  } catch {
    return undefined;
  }
}

function probeReportedVersion(
  tps: TraceProcessorService,
  traceId: string,
): Promise<string | undefined> {
  return probeMetadataString(
    tps, traceId, TRACE_PROCESSOR_VERSION_SQL, 'reported_version',
    sanitizeCapabilityTraceProcessorReportedVersion,
  );
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

function readDataLossStats(
  result: {columns: string[]; rows: unknown[]; error?: string},
): {stats: TraceDataLossStat[]; rowCount: number} | undefined {
  if (
    result.error ||
    !hasExactColumns(result.columns, ['name', 'idx', 'value', 'matching_rows']) ||
    result.rows.length > DATA_LOSS_STAT_LIMIT
  ) {
    return undefined;
  }
  const stats: TraceDataLossStat[] = [];
  let rowCount = 0;
  for (const row of result.rows) {
    if (!Array.isArray(row) || row.length !== 4) return undefined;
    const [name, idx, value, matchingRows] = row;
    if (
      typeof name !== 'string' || !STAT_NAME.test(name) ||
      !(idx === null || Number.isSafeInteger(idx)) ||
      typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
      !Number.isSafeInteger(matchingRows)
    ) {
      return undefined;
    }
    stats.push({name, idx: idx as number | null, value});
    rowCount = matchingRows as number;
  }
  return {stats, rowCount};
}

// Trace-authored text reaches the prompt as data: strip control characters and
// bound it rather than trusting the producer.
function sanitizeRecoveryReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const reason = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    .slice(0, RECOVERY_REASON_MAX_CHARS);
  return reason.length > 0 ? reason : undefined;
}

/**
 * Read capture loss recorded by trace_processor. A trace without data loss is
 * the only one where "the event is absent" can be read as "it did not happen".
 */
async function probeDataLoss(
  tps: TraceProcessorService,
  traceId: string,
): Promise<TraceDataLossDiagnosis> {
  const [loss, recoveryReason] = await Promise.all([
    tps.queryBounded(traceId, DATA_LOSS_STATS_SQL, DATA_LOSS_QUERY_OPTIONS)
      .then(readDataLossStats, () => undefined),
    probeMetadataString(
      tps, traceId, TRACE_RECOVERY_REASON_SQL, 'recovery_reason', sanitizeRecoveryReason,
    ),
  ]);
  const lossStats = loss?.rowCount ? loss : undefined;
  if (!lossStats && recoveryReason === undefined) {
    // Unreadable stats are not a clean bill of health.
    return {status: loss === undefined ? 'unknown' : 'none_detected'};
  }
  // A recovered trace was not finalized cleanly, so it is lossy even when the
  // stats themselves could not be read.
  return {
    status: 'data_loss_detected',
    absenceEvidence: 'not_proof',
    ...(lossStats ? {lossStats: lossStats.stats, lossStatRowCount: lossStats.rowCount} : {}),
    ...(recoveryReason === undefined ? {} : {recoveryReason}),
  };
}

function unavailableTraceResolution(
  resolution: Extract<CapabilityTraceIdentityResolution, {status: 'unavailable'}>,
): Extract<CapabilityManifestResolutionV1, {status: 'unavailable'}> {
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
  identity: CapabilityManifestIdentityPreparation,
): Promise<TimelessCapabilityManifestResolution> {
  if (identity.status === 'unavailable') return identity.resolution;

  const [reportedVersion, clockRangeNs] = await Promise.all([
    probeReportedVersion(tps, traceId),
    probeClockRange(tps, traceId),
  ]);
  const traceProcessor = reportedVersion === undefined
    ? identity.traceProcessor
    : {...identity.traceProcessor, reportedVersion};
  const trace = clockRangeNs === undefined
    ? identity.trace
    : {...identity.trace, clockRangeNs};
  const manifestBuilder = dependencies.buildManifest ?? buildCapabilityManifest;

  try {
    const manifest = manifestBuilder({
      definitions: CAPABILITY_REGISTRY.map(capability => ({
        id: capability.id,
        displayName: capability.displayName,
        primaryTable: capability.primaryTable,
        ...(capability.requiredModules === undefined
          ? {}
          : {requiredModules: [...capability.requiredModules]}),
        ...(capability.probeSql === undefined
          ? {}
          : {probeSql: capability.probeSql}),
      })),
      legacyProbe: legacyResult,
      traceProcessor,
      trace,
      provenance: {traceId},
      generatedAt: 0,
    });
    const {diagnosedAt: _diagnosedAt, generatedAt: _generatedAt, ...provenance} =
      manifest.provenance;
    return {
      status: 'ready',
      manifest: immutableCanonicalSnapshot({
        content: manifest.content,
        provenance,
        manifestId: manifest.manifestId,
        contentHash: manifest.contentHash,
      }),
    };
  } catch {
    return {status: 'failed', reason: 'capability_manifest_build_failed'};
  }
}

async function prepareCapabilityManifestIdentity(
  tps: TraceProcessorService,
  traceId: string,
  dependencies: TraceCompletenessManifestDependencies,
): Promise<CapabilityManifestIdentityPreparation> {
  const traceResolver = dependencies.resolveTraceIdentity ??
    resolveCapabilityTraceIdentity;
  const traceProcessorResolver = dependencies.resolveTraceProcessorIdentity ??
    resolveCapabilityTraceProcessorIdentity;

  let traceSource: 'local_file' | 'external_rpc' | undefined;
  try {
    traceSource = tps.getTraceSourceKind(traceId);
  } catch {
    return {
      status: 'unavailable',
      resolution: {status: 'unavailable', reason: 'trace_source_unavailable'},
    };
  }
  if (traceSource === undefined) {
    return {
      status: 'unavailable',
      resolution: {status: 'unavailable', reason: 'trace_source_unavailable'},
    };
  }

  if (traceSource === 'external_rpc') {
    try {
      const traceResolution = await traceResolver({
        source: 'external_rpc',
        traceSide: 'current',
      });
      return {
        status: 'unavailable',
        resolution: traceResolution.status === 'unavailable'
          ? unavailableTraceResolution(traceResolution)
          : {status: 'unavailable', reason: 'identity_resolution_failed'},
      };
    } catch {
      return {
        status: 'unavailable',
        resolution: {status: 'unavailable', reason: 'identity_resolution_failed'},
      };
    }
  }

  let traceFilePath: string | undefined;
  try {
    traceFilePath = tps.getTrace(traceId)?.filePath;
  } catch {
    return {
      status: 'unavailable',
      resolution: {status: 'unavailable', reason: 'trace_source_unavailable'},
    };
  }
  if (!traceFilePath) {
    return {
      status: 'unavailable',
      resolution: {status: 'unavailable', reason: 'trace_file_unavailable'},
    };
  }

  let traceResolution: CapabilityTraceIdentityResolution;
  try {
    traceResolution = await traceResolver({
      source: 'local_file',
      filePath: traceFilePath,
      traceSide: 'current',
    });
  } catch {
    return {
      status: 'unavailable',
      resolution: {status: 'unavailable', reason: 'identity_resolution_failed'},
    };
  }
  if (traceResolution.status === 'unavailable') {
    return {
      status: 'unavailable',
      resolution: unavailableTraceResolution(traceResolution),
    };
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
  return {
    status: 'ready',
    trace: traceResolution.identity,
    traceProcessor,
  };
}

/**
 * Probe trace data completeness.
 *
 * @param tps TraceProcessorService instance
 * @param traceId Active trace ID
 * @param architectureType Detected architecture (used for not_applicable filtering)
 * @returns TraceCompleteness diagnosis
 */
async function probeTimelessTraceCompleteness(
  tps: TraceProcessorService,
  traceId: string,
  architectureType: RenderingArchitectureType | undefined,
  manifestDependencies: TraceCompletenessManifestDependencies,
  manifestIdentity: CapabilityManifestIdentityPreparation,
): Promise<TimelessTraceCompleteness> {
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
  const probeUnits = planCapabilityProbes(existingTables);

  const dataPresence = new Map<string, number>(); // probe key → approximate row count

  if (probeUnits.length > 0) {
    // COUNT with LIMIT ${INSUFFICIENT_THRESHOLD} — only need to distinguish: 0 / 1..threshold / >threshold.
    const countSql = probeUnits.map(unit => unit.selectSql).join(' UNION ALL ');

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
      await Promise.all(probeUnits.map(async (unit) => {
        try {
          const r = await tps.query(traceId, unit.selectSql);
          dataPresence.set(unit.key, r?.rows?.[0]?.[1] as number ?? 0);
        } catch {
          dataPresence.set(unit.key, 0);
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
    const rowCount = dataPresence.get(capabilityProbeKey(cap)) ?? 0;
    if (rowCount === 0) {
      missingConfig.push({
        id: cap.id,
        displayName: cap.displayName,
        status: 'missing_config_suspected',
        primaryTable: cap.primaryTable,
        rowEstimate: 0,
        // A probeSql capability reads a slice of a shared table, so "the table
        // is empty" would be false; only its own rows are missing.
        reason: appendCaptureHint(
          cap.probeSql === undefined
            ? `表 ${cap.primaryTable} 存在但无数据 — 可能未开启所需 atrace/ftrace 配置，或场景未发生`
            : `表 ${cap.primaryTable} 中没有该能力所需的数据 — 可能未开启所需 atrace/ftrace 配置，或场景未发生`,
          cap,
        ),
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

  const dataLoss = await probeDataLoss(tps, traceId);

  const elapsed = Date.now() - t0;
  console.log(
    `[TraceCompleteness] Probed ${CAPABILITY_REGISTRY.length} capabilities in ${elapsed}ms: ` +
    `available=${available.length}, missing=${missingConfig.length}, ` +
    `n/a=${notApplicable.length}, insufficient=${insufficient.length}, ` +
    `dataLoss=${dataLoss.status}`,
  );

  const legacyResult: Omit<TraceCompleteness, 'capabilityManifestResolution'> = {
    available,
    missingConfig,
    notApplicable,
    insufficient,
    diagnosedAt: 0,
  };
  let capabilityManifestResolution: TimelessCapabilityManifestResolution;
  try {
    capabilityManifestResolution = await resolveCapabilityManifestShadow(
      tps,
      traceId,
      legacyResult,
      manifestDependencies,
      manifestIdentity,
    );
  } catch {
    capabilityManifestResolution = {
      status: 'failed',
      reason: 'capability_manifest_build_failed',
    };
  }
  return immutableCanonicalSnapshot({
    available,
    missingConfig,
    notApplicable,
    insufficient,
    dataLoss,
    capabilityManifestResolution,
  });
}

function hasInjectedManifestDependencies(
  dependencies: TraceCompletenessManifestDependencies,
): boolean {
  return dependencies.resolveTraceIdentity !== undefined ||
    dependencies.resolveTraceProcessorIdentity !== undefined ||
    dependencies.buildManifest !== undefined ||
    dependencies.projectAttribution !== undefined ||
    dependencies.attributionSink !== undefined;
}

function productionCacheKeyHash(
  traceId: string,
  architectureType: RenderingArchitectureType | undefined,
  identity: CapabilityManifestIdentityPreparation,
  dependencies: TraceCompletenessManifestDependencies,
): string | undefined {
  if (
    hasInjectedManifestDependencies(dependencies) ||
    architectureType === undefined ||
    identity.status !== 'ready' ||
    identity.traceProcessor.source === 'unknown'
  ) {
    return undefined;
  }
  return canonicalContentHash({
    schemaVersion: 1,
    traceId,
    architectureType,
    traceFingerprintSha256: identity.trace.fingerprintSha256,
    traceProcessor: identity.traceProcessor,
  });
}

function materializeTraceCompleteness(
  template: TimelessTraceCompleteness,
): TraceCompleteness {
  const diagnosedAt = Date.now();
  const resolution = template.capabilityManifestResolution;
  const capabilityManifestResolution: CapabilityManifestResolutionV1 =
    resolution.status !== 'ready'
      ? resolution
      : {
          status: 'ready',
          manifest: immutableCanonicalSnapshot({
            ...resolution.manifest,
            provenance: {
              ...resolution.manifest.provenance,
              diagnosedAt,
              generatedAt: Date.now(),
            },
          }),
        };
  const cloneResults = (results: readonly CapabilityProbeResult[]) =>
    results.map(result => ({...result}));
  return {
    available: cloneResults(template.available),
    missingConfig: cloneResults(template.missingConfig),
    notApplicable: cloneResults(template.notApplicable),
    insufficient: cloneResults(template.insufficient),
    diagnosedAt,
    dataLoss: structuredClone(template.dataLoss),
    capabilityManifestResolution,
  };
}

function recordCapabilityManifestAttribution(
  resolution: CapabilityManifestResolutionV1,
  observation: CapabilityManifestProbeCacheObservationV1,
  dependencies: TraceCompletenessManifestDependencies,
): void {
  let attribution;
  try {
    attribution = (dependencies.projectAttribution ??
      projectCapabilityManifestAttribution)(resolution, observation);
  } catch {
    console.warn(
      '[TraceCompleteness] capability_manifest_attribution_projection_failed',
    );
    return;
  }

  try {
    const sink = dependencies.attributionSink ??
      currentRunManifestAttributionSink();
    sink?.recordCapabilityManifest(attribution);
  } catch {
    console.warn('[TraceCompleteness] capability_manifest_attribution_sink_failed');
  }
}

export function clearTraceCompletenessProbeCache(): void {
  traceCompletenessProbeCache.clear();
}

export async function probeTraceCompleteness(
  tps: TraceProcessorService,
  traceId: string,
  architectureType?: RenderingArchitectureType,
  manifestDependencies: TraceCompletenessManifestDependencies = {},
): Promise<TraceCompleteness> {
  let manifestIdentity: CapabilityManifestIdentityPreparation;
  try {
    manifestIdentity = await prepareCapabilityManifestIdentity(
      tps,
      traceId,
      manifestDependencies,
    );
  } catch {
    manifestIdentity = {
      status: 'unavailable',
      resolution: {status: 'unavailable', reason: 'identity_resolution_failed'},
    };
  }

  const keyHash = productionCacheKeyHash(
    traceId,
    architectureType,
    manifestIdentity,
    manifestDependencies,
  );
  let outcome: CapabilityManifestProbeCacheObservationV1['outcome'];
  let templatePromise: Promise<TimelessTraceCompleteness>;
  if (keyHash === undefined) {
    outcome = 'bypass';
    templatePromise = probeTimelessTraceCompleteness(
      tps,
      traceId,
      architectureType,
      manifestDependencies,
      manifestIdentity,
    );
  } else {
    const cached = traceCompletenessProbeCache.get(keyHash);
    if (cached) {
      outcome = 'hit';
      traceCompletenessProbeCache.delete(keyHash);
      traceCompletenessProbeCache.set(keyHash, cached);
      templatePromise = cached;
    } else {
      outcome = 'miss';
      const created = probeTimelessTraceCompleteness(
        tps,
        traceId,
        architectureType,
        manifestDependencies,
        manifestIdentity,
      );
      traceCompletenessProbeCache.set(keyHash, created);
      while (traceCompletenessProbeCache.size > TRACE_COMPLETENESS_PROBE_CACHE_LIMIT) {
        const oldest = traceCompletenessProbeCache.keys().next().value;
        if (oldest === undefined) break;
        traceCompletenessProbeCache.delete(oldest);
      }
      void created.catch(() => {
        if (traceCompletenessProbeCache.get(keyHash) === created) {
          traceCompletenessProbeCache.delete(keyHash);
        }
      });
      templatePromise = created;
    }
  }

  const result = materializeTraceCompleteness(await templatePromise);
  recordCapabilityManifestAttribution(
    result.capabilityManifestResolution!,
    {outcome, ...(keyHash === undefined ? {} : {keyHash})},
    manifestDependencies,
  );
  return result;
}

/** Export the registry for use by comparison mode's capability dictionary. */
export { CAPABILITY_REGISTRY };
export type { CapabilityDef };
