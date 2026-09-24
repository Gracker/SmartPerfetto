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
 * Probing layers:
 *   0. Architecture applicability — decided before any query
 *   1. Module loading — INCLUDE each applicable capability's stdlib modules
 *      under a total budget (a stdlib view does not exist until included)
 *   2. Schema existence — sqlite_master check (which tables/views exist)
 *   3. Data existence — bounded row count for tables that exist in schema
 *
 * Result categories:
 *   - available: data present, analysis possible
 *   - missing_config_suspected: schema missing or empty, likely trace config
 *     issue — or, with an unprobed reason code (`probe_module_unavailable`,
 *     `probe_query_failed`), a capability this probe could not determine
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
import {
  isCapabilityUnprobedReasonCode,
  type BuildCapabilityManifestInput,
  type CapabilityManifestProbeCacheObservationV1,
  type CapabilityManifestResolutionV1,
  type CapabilityManifestTraceContentIdentityV1,
  type CapabilityManifestTraceProcessorIdentityV1,
  type CapabilityManifestV1,
  type CapabilityUnprobedReasonCode,
} from '../types/capabilityManifest';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import {localize, parseOutputLanguage, type OutputLanguage} from './outputLanguage';
import type {
  CapabilityProbeResult,
  TraceCompleteness,
  TraceDataLossDiagnosis,
  TraceDataLossStat,
} from './types';

/** Minimum row count below which data is considered "insufficient". */
const INSUFFICIENT_THRESHOLD = 3;
/**
 * Probe-time bounds. A JS deadline does not abort the native statement, so each
 * one is a point after which this probe stops waiting and reports the affected
 * capabilities as unprobed, never as missing.
 */
const PROBE_MODULE_TOTAL_BUDGET_MS = 20_000;
const PROBE_MODULE_INCLUDE_TIMEOUT_MS = 10_000;
const PROBE_SCHEMA_QUERY_TIMEOUT_MS = 10_000;
const PROBE_COUNT_QUERY_TIMEOUT_MS = 30_000;
const PROBE_SINGLE_COUNT_QUERY_TIMEOUT_MS = 10_000;
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
  /**
   * Stdlib modules that must be included before probing this table. Every
   * primaryTable the generated stdlib symbol index attributes to a module must
   * list that module here (a registry test enforces it): a stdlib view that was
   * never INCLUDEd is absent from sqlite_master whatever the trace contains.
   */
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
    requiredModules: ['android.frames.timeline'],
    applicableArchs: ['FLUTTER'],
    priority: 'critical',
  },

  // ── Startup ──
  {
    id: 'startup',
    displayName: '启动性能分析',
    primaryTable: 'android_startups',
    requiredModules: ['android.startup.startups'],
    priority: 'critical',
  },

  // ── IPC / synchronization ──
  {
    id: 'binder_ipc',
    displayName: 'Binder/IPC 分析',
    primaryTable: 'android_binder_txns',
    requiredModules: ['android.binder'],
    priority: 'recommended',
  },
  {
    id: 'lock_contention',
    displayName: '锁竞争分析',
    primaryTable: 'android_monitor_contention',
    requiredModules: ['android.monitor_contention'],
    priority: 'recommended',
  },

  // ── Memory ──
  {
    id: 'gc_memory',
    displayName: 'GC/内存分析',
    primaryTable: 'android_garbage_collection_events',
    requiredModules: ['android.garbage_collection'],
    priority: 'recommended',
  },
  {
    id: 'memory_pressure',
    displayName: '内存压力/LMK',
    primaryTable: 'android_oom_adj_intervals',
    requiredModules: ['android.oom_adjuster'],
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
    requiredModules: ['linux.block_io'],
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
    requiredModules: ['linux.perf.samples'],
    priority: 'optional',
  },

  // ── Input ──
  {
    id: 'input_latency',
    displayName: '输入延迟分析',
    primaryTable: 'android_input_events',
    requiredModules: ['android.input'],
    priority: 'recommended',
  },

  // ── Display pipeline ──
  {
    id: 'surfaceflinger',
    displayName: 'SurfaceFlinger/Display 管线',
    primaryTable: 'android_surfaceflinger_workloads',
    requiredModules: ['android.surfaceflinger'],
    priority: 'recommended',
  },

  // ── System state ──
  {
    id: 'device_state',
    displayName: '设备状态',
    primaryTable: 'android_screen_state',
    requiredModules: ['android.screen_state'],
    priority: 'optional',
  },
  {
    id: 'battery_power',
    displayName: '电池/功耗分析',
    primaryTable: 'android_battery_stats_state',
    requiredModules: ['android.battery_stats'],
    priority: 'optional',
  },

  // ── IRQ ──
  {
    id: 'interrupts',
    displayName: 'IRQ/中断分析',
    primaryTable: 'linux_hard_irqs',
    requiredModules: ['linux.irqs'],
    priority: 'optional',
  },

  // ── ANR ──
  {
    id: 'anr',
    displayName: 'ANR 分析',
    primaryTable: 'android_anrs',
    requiredModules: ['android.anrs'],
    priority: 'optional',
  },

  // ── Wattson power-modeling prerequisites; see docs/reference/skill-system.md for Skill validation policy. ──
  // Power skills require specific capture sources. Most production traces don't enable them,
  // so the prompt must surface gaps before Claude trusts empty tables.
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
  capabilities: readonly CapabilityDef[],
  existingTables: ReadonlySet<string>,
): CapabilityProbeUnit[] {
  const units = new Map<string, CapabilityProbeUnit>();
  for (const cap of capabilities) {
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

/**
 * Why a module a capability depends on is not loaded. `error` is an answer
 * from trace_processor; `interrupted` is a thrown query (the JS deadline or the
 * transport), after which the native INCLUDE may still be running and every
 * later statement on this serial processor would queue behind it; `skipped`
 * means the load budget was spent or an earlier load was interrupted.
 */
type ProbeModuleFailure = 'error' | 'interrupted' | 'skipped';

/**
 * Load the stdlib modules the applicable capabilities read, one at a time,
 * under a total budget. Views are cheap to INCLUDE, but modules that build
 * PERFETTO TABLEs are not: on a 95 MB trace `android.garbage_collection` alone
 * took 2.2 s. This is the 9d313df risk (22 preloaded modules hung large traces),
 * so the loader stops at the first interrupted load rather than stacking more
 * statements behind one it can no longer cancel.
 */
async function loadProbeModules(
  tps: TraceProcessorService,
  traceId: string,
  capabilities: readonly CapabilityDef[],
): Promise<Map<string, ProbeModuleFailure>> {
  const failures = new Map<string, ProbeModuleFailure>();
  const modules = Array.from(new Set(
    capabilities.flatMap(cap => cap.requiredModules ?? []),
  ));
  const deadline = Date.now() + PROBE_MODULE_TOTAL_BUDGET_MS;
  let stopped = false;
  for (const module of modules) {
    const remaining = deadline - Date.now();
    if (stopped || remaining <= 0) {
      failures.set(module, 'skipped');
      continue;
    }
    try {
      const result = await tps.query(
        traceId,
        `INCLUDE PERFETTO MODULE ${module};`,
        {timeoutMs: Math.min(PROBE_MODULE_INCLUDE_TIMEOUT_MS, remaining), suppressErrorLog: true},
      );
      if (result?.error) {
        failures.set(module, 'error');
        console.warn(`[TraceCompleteness] Probe module ${module} failed to load`);
      }
    } catch {
      failures.set(module, 'interrupted');
      stopped = true;
      console.warn(`[TraceCompleteness] Probe module ${module} load was interrupted; later modules are left unprobed`);
    }
  }
  return failures;
}

function appendCaptureHint(reason: string, cap: CapabilityDef): string {
  return cap.captureHint ? `${reason}；${cap.captureHint}` : reason;
}

function probeLanguage(): OutputLanguage {
  return parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
}

/**
 * A capability whose presence this probe could not determine. It stays in
 * `missingConfig` (the manifest needs every definition in one bucket) but with
 * an unprobed reason code, and its text says absence is undetermined, so no
 * reader can take it as a successful probe that found nothing.
 */
function unprobedResult(
  cap: CapabilityDef,
  reasonCode: CapabilityUnprobedReasonCode,
  reason: string,
): CapabilityProbeResult {
  return {
    id: cap.id,
    displayName: cap.displayName,
    status: 'missing_config_suspected',
    primaryTable: cap.primaryTable,
    reasonCode,
    reason,
  };
}

function moduleUnavailableReason(module: string, failure: ProbeModuleFailure): string {
  const language = probeLanguage();
  const cause = {
    error: localize(language, `stdlib 模块 ${module} 加载失败`, `stdlib module ${module} failed to load`),
    interrupted: localize(language,
      `stdlib 模块 ${module} 加载超时或被中断`,
      `loading stdlib module ${module} timed out or was interrupted`),
    skipped: localize(language,
      `探测预算内未加载 stdlib 模块 ${module}`,
      `stdlib module ${module} was not loaded within the probe budget`),
  }[failure];
  return localize(language,
    `${cause}，未能探测该能力；不能据此判断 trace 缺少这类数据`,
    `${cause}, so this capability was not probed; this does not show the trace lacks the data`);
}

function probeQueryFailedReason(cap: CapabilityDef): string {
  return localize(probeLanguage(),
    `能力探测查询未完成，未能判断 ${cap.primaryTable} 是否有数据；不能据此判断 trace 缺少这类数据`,
    `the capability probe query did not complete, so whether ${cap.primaryTable} has data is undetermined; this does not show the trace lacks the data`);
}

function hasUnprobedResult(template: TimelessTraceCompleteness): boolean {
  return template.missingConfig.some(result =>
    isCapabilityUnprobedReasonCode(result.reasonCode));
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

  // ── Classify each capability ─────────────────────────────────────────────
  const available: CapabilityProbeResult[] = [];
  const missingConfig: CapabilityProbeResult[] = [];
  const notApplicable: CapabilityProbeResult[] = [];
  const insufficient: CapabilityProbeResult[] = [];

  // ── Layer 0: Architecture applicability ──────────────────────────────────
  // Decided before any query, so an inapplicable capability loads no module.
  const applicable: CapabilityDef[] = [];
  for (const cap of CAPABILITY_REGISTRY) {
    const notApplicableReason = !architectureType ? undefined
      : cap.applicableArchs && !cap.applicableArchs.includes(architectureType) ? `当前架构 ${architectureType} 不适用`
      : cap.excludedArchs?.includes(architectureType) ? `${architectureType} 架构使用专用分析管线`
      : undefined;
    if (notApplicableReason === undefined) {
      applicable.push(cap);
      continue;
    }
    notApplicable.push({
      id: cap.id,
      displayName: cap.displayName,
      status: 'not_applicable',
      primaryTable: cap.primaryTable,
      reason: notApplicableReason,
    });
  }

  // ── Layer 1: Module loading ──────────────────────────────────────────────
  // A stdlib view is absent from sqlite_master until its module is included,
  // so a capability whose module did not load was not probed at all.
  const moduleFailures = await loadProbeModules(tps, traceId, applicable);
  const unprobed = new Map<string, CapabilityProbeResult>();
  for (const cap of applicable) {
    const failedModule = cap.requiredModules?.find(module => moduleFailures.has(module));
    if (failedModule !== undefined) {
      unprobed.set(cap.id, unprobedResult(
        cap,
        'probe_module_unavailable',
        moduleUnavailableReason(failedModule, moduleFailures.get(failedModule)!),
      ));
    }
  }
  const probeable = applicable.filter(cap => !unprobed.has(cap.id));

  // ── Layer 2: Schema existence check ──────────────────────────────────────
  // trace_processor answers a failed statement with `error` rather than a
  // throw; either way no schema was read, and nothing may be called missing.
  const existingTables = new Set<string>();
  let schemaRead = false;
  if (probeable.length > 0) {
    try {
      const schemaResult = await tps.query(
        traceId,
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
        {timeoutMs: PROBE_SCHEMA_QUERY_TIMEOUT_MS, suppressErrorLog: true},
      );
      if (!schemaResult?.error && Array.isArray(schemaResult?.rows)) {
        schemaRead = true;
        for (const row of schemaResult.rows) {
          existingTables.add(row[0] as string);
        }
      }
    } catch {
      // Thrown (deadline or transport): no schema was read.
    }
  }
  if (!schemaRead) {
    for (const cap of probeable) {
      unprobed.set(cap.id, unprobedResult(cap, 'probe_query_failed', probeQueryFailedReason(cap)));
    }
  }

  // ── Layer 3: Data existence check (only for tables that exist in schema) ──
  // Build a single UNION ALL query for efficiency.
  const probeUnits = schemaRead ? planCapabilityProbes(probeable, existingTables) : [];

  const dataPresence = new Map<string, number>(); // probe key → approximate row count

  if (probeUnits.length > 0) {
    // COUNT with LIMIT ${INSUFFICIENT_THRESHOLD} — only need to distinguish: 0 / 1..threshold / >threshold.
    const countSql = probeUnits.map(unit => unit.selectSql).join(' UNION ALL ');
    const readCounts = (rows: unknown[][] | undefined) => {
      for (const row of rows ?? []) {
        if (typeof row[0] === 'string' && typeof row[1] === 'number') {
          dataPresence.set(row[0], row[1]);
        }
      }
    };

    // Only an `{error}` answer is worth splitting: one table with an
    // incompatible schema fails the whole batch, so the units are counted one
    // at a time and only that capability stays unprobed. A thrown batch (the JS
    // deadline or the transport) may still be running on this serial
    // processor, and every per-unit query would queue behind it, so every unit
    // stays unprobed instead — the same rule `loadProbeModules` follows.
    let splitBatch = false;
    try {
      const countResult = await tps.query(
        traceId,
        countSql,
        {timeoutMs: PROBE_COUNT_QUERY_TIMEOUT_MS, suppressErrorLog: true},
      );
      if (countResult?.error) splitBatch = true;
      else readCounts(countResult?.rows);
    } catch {
      console.warn('[TraceCompleteness] Batch count was interrupted; its capabilities are left unprobed');
    }
    if (splitBatch) {
      console.warn('[TraceCompleteness] Batch count failed, falling back to individual probes');
      for (const unit of probeUnits) {
        try {
          const result = await tps.query(
            traceId,
            unit.selectSql,
            {timeoutMs: PROBE_SINGLE_COUNT_QUERY_TIMEOUT_MS, suppressErrorLog: true},
          );
          if (!result?.error) readCounts(result?.rows);
        } catch {
          // Interrupted: this and every later unit are reported as unprobed below.
          console.warn('[TraceCompleteness] Individual count was interrupted; later capabilities are left unprobed');
          break;
        }
      }
    }
  }

  for (const cap of applicable) {
    const unprobedEntry = unprobed.get(cap.id);
    if (unprobedEntry) {
      missingConfig.push(unprobedEntry);
      continue;
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
    const rowCount = dataPresence.get(capabilityProbeKey(cap));
    if (rowCount === undefined) {
      missingConfig.push(unprobedResult(cap, 'probe_query_failed', probeQueryFailedReason(cap)));
    } else if (rowCount === 0) {
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
      // A rejected probe, or one that left capabilities unprobed (a module or
      // query did not finish), describes this attempt rather than the trace:
      // callers already waiting share it, the next run probes again.
      const evict = () => {
        if (traceCompletenessProbeCache.get(keyHash) === created) {
          traceCompletenessProbeCache.delete(keyHash);
        }
      };
      void created.then(template => {
        if (hasUnprobedResult(template)) evict();
      }, evict);
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
