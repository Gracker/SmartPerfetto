// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getLruCacheEntry, setLruCacheEntry } from '../agentRuntime/runtimeCache';
import type { TraceProcessorService } from '../services/traceProcessorService';
import { assertQuerySucceeded, toNumber, toNullableNumber } from '../utils/traceProcessorRowUtils';

/**
 * Signal class that contributed most to an app's score. `sched_activity` is
 * the activity-only fallback for traces without oom_adj, FrameTimeline or
 * battery data.
 */
export type FocusAppDetectionMethod =
  | 'battery_stats'
  | 'oom_adj'
  | 'frame_timeline'
  | 'sched_activity'
  | 'none';

/**
 * `ambiguous` means the ranking could not separate the best candidate from the
 * runner-up; the result then carries candidates but no `primaryApp`.
 */
export type FocusAppConfidence = 'high' | 'medium' | 'ambiguous';

export type FocusAppPenalty = 'system_uid' | 'persistent_only' | 'subprocess';

/** Raw per-app evidence, all measured inside the analysis window. */
export interface FocusAppSignals {
  batteryTopNs: number;
  launchCount: number;
  frameCount: number;
  /** Time at oom score 0 (foreground app); persistent/system scores do not count. */
  foregroundNs: number;
  /** CPU running time of every thread of the process. */
  runningNs: number;
  mainThreadRunningNs: number;
  threadSliceCount: number;
}

export interface DetectedFocusApp {
  packageName: string;
  /**
   * Duration measured by the result-level `method`: battery top time,
   * foreground (oom score 0) time, or CPU running time for `sched_activity`.
   */
  totalDurationNs: number;
  /** Count measured by the result-level `method` (frames for FrameTimeline). */
  switchCount: number;
  upid?: number;
  pid?: number;
  processName?: string;
  signals?: FocusAppSignals;
  penalties?: FocusAppPenalty[];
  /** Relative ranking score; only comparable inside one detection result. */
  score?: number;
  scopeStartNs?: number;
  scopeEndNs?: number;
  evidenceRefId?: string;
  evidenceRowIndex?: number;
}

/** A process that looked foreground-like but did nothing observable in the window. */
export interface FocusAppExcludedProcess {
  packageName: string;
  processName?: string;
  upid?: number;
  pid?: number;
  reason: 'no_activity';
  foregroundNs: number;
  maxOomScore?: number;
}

export interface FocusAppDetectionResult {
  /** Ranked candidates (best first), at most FOCUS_APP_CANDIDATE_LIMIT. */
  apps: DetectedFocusApp[];
  /** Set only when confidence is `high` or `medium`. */
  primaryApp?: string;
  method: FocusAppDetectionMethod;
  confidence?: FocusAppConfidence;
  excludedNoActivity?: FocusAppExcludedProcess[];
  timeRange?: FocusAppTimeRange;
}

export interface FocusAppTimeRange {
  startNs: number;
  endNs: number;
}

export interface FocusAppDetectionOptions {
  timeRange?: FocusAppTimeRange;
}

// Ranking weights. A signal contributes weight × (value / best eligible value);
// launch is binary. Penalties multiply the whole score.
const FOCUS_APP_WEIGHTS = Object.freeze({
  batteryTop: 35,
  launch: 15,
  frames: 25,
  foreground: 15,
  running: 10,
});
/** An app whose activity start overlaps the window outranks one without. */
const LAUNCH_TIER_BONUS = 100;
const SYSTEM_OR_PERSISTENT_FACTOR = 0.3;
const SUBPROCESS_FACTOR = 0.5;
const HIGH_CONFIDENCE_RATIO = 2;
const MEDIUM_CONFIDENCE_RATIO = 1.25;
/** A signal counts toward confidence only at >= 10% of the best eligible value. */
const SUBSTANTIVE_SHARE = 0.1;
const FIRST_APPLICATION_APPID = 10000;
/** app-zygote isolated (90000-98999) and isolated (99000-99999) uids. */
const ISOLATED_APPID_START = 90000;
const ISOLATED_APPID_END = 99999;
/** Scores in (-900, 0] were read as "foreground" by the historical ladder. */
const PERSISTENT_SCORE_FLOOR = -900;
const FOCUS_APP_CANDIDATE_LIMIT = 5;
const EXCLUDED_REPORT_LIMIT = 5;

const SYSTEM_PROCESS_EXACT = new Set([
  'init',
  'surfaceflinger',
  'system_server',
  'zygote',
  'zygote64',
  'webview_zygote',
  'app_process',
]);

const SYSTEM_PROCESS_PREFIXES = [
  '/',
  'vendor.',
  'com.google.android.providers.',
];

const SYSTEM_PACKAGE_PREFIXES = [
  'com.android.systemui',
  'com.android.launcher',
  'com.android.launcher3',            // AOSP Launcher3 (used by several OEMs)
  'com.android.phone',
  'com.android.providers',
  // Google system apps that frequently appear in foreground but are rarely analysis targets
  'com.google.android.inputmethod',   // Gboard
  'com.google.android.apps.nexuslauncher', // Pixel Launcher
  'com.android.inputmethod',          // AOSP keyboard
  'com.google.android.apps.wallpaper', // Wallpaper picker
  'com.miui.home',                    // Xiaomi launcher
  'com.huawei.android.launcher',       // Huawei launcher
  'com.oppo.launcher',                // OPPO launcher
  'com.vivo.launcher',                // Vivo launcher
  'com.sec.android.app.launcher',      // Samsung launcher
];

function isSystemProcess(name: string): boolean {
  const lower = name.toLowerCase();
  return SYSTEM_PROCESS_EXACT.has(lower) ||
    SYSTEM_PROCESS_PREFIXES.some(prefix => lower.startsWith(prefix)) ||
    SYSTEM_PACKAGE_PREFIXES.some(prefix =>
      lower === prefix ||
      lower.startsWith(`${prefix}.`) ||
      lower.startsWith(`${prefix}:`));
}

function isIsolatedAppId(appId: number | undefined): boolean {
  return appId !== undefined && appId >= ISOLATED_APPID_START && appId <= ISOLATED_APPID_END;
}

function normalizeTimeRange(timeRange?: FocusAppTimeRange): FocusAppTimeRange | undefined {
  if (!timeRange) return undefined;
  const startNs = Number(timeRange.startNs);
  const endNs = Number(timeRange.endNs);
  if (!Number.isFinite(startNs) || !Number.isFinite(endNs) || endNs <= startNs) {
    return undefined;
  }
  return { startNs, endNs };
}

export function focusAppTimeRangeFromSelection(input?: {
  kind?: string;
  startNs?: number;
  endNs?: number;
  ts?: number;
  dur?: number;
}): FocusAppTimeRange | undefined {
  if (!input) return undefined;
  if (input.kind === 'area' && input.startNs !== undefined && input.endNs !== undefined) {
    return normalizeTimeRange({ startNs: input.startNs, endNs: input.endNs });
  }
  if (input.kind === 'track_event' && input.ts !== undefined && input.dur !== undefined) {
    return normalizeTimeRange({ startNs: input.ts, endNs: input.ts + input.dur });
  }
  return undefined;
}

function scopedDurationExpr(
  timeRange: FocusAppTimeRange | undefined,
  tsExpr: string,
  durExpr: string,
): string {
  if (!timeRange) return durExpr;
  return `MAX(0, MIN((${tsExpr}) + (${durExpr}), ${timeRange.endNs}) - MAX((${tsExpr}), ${timeRange.startNs}))`;
}

function scopedOverlapWhere(
  timeRange: FocusAppTimeRange | undefined,
  tsExpr: string,
  durExpr: string,
  unscopedWhere: string,
): string {
  if (!timeRange) return unscopedWhere;
  return `${durExpr} > 0 AND (${tsExpr}) < ${timeRange.endNs} AND ((${tsExpr}) + (${durExpr})) > ${timeRange.startNs}`;
}

/** Events (including instants and unfinished slices) that touch the window. */
function scopedEventWhere(
  timeRange: FocusAppTimeRange | undefined,
  tsExpr: string,
  durExpr: string,
): string {
  if (!timeRange) return '1 = 1';
  return `(${tsExpr}) <= ${timeRange.endNs} AND ((${tsExpr}) + MAX((${durExpr}), 0)) >= ${timeRange.startNs}`;
}

/**
 * Per-process activity inside the window. One pass over oom_adj, FrameTimeline,
 * sched and thread slices; the ranking below never trusts a single source.
 */
function buildFocusAppProcessActivitySql(timeRange: FocusAppTimeRange | undefined): string {
  const oomDuration = scopedDurationExpr(timeRange, 'oa.ts', 'oa.dur');
  const oomWhere = scopedOverlapWhere(timeRange, 'oa.ts', 'oa.dur', 'oa.dur > 0');
  const frameWhere = scopedEventWhere(timeRange, 'a.ts', 'a.dur');
  const runDuration = scopedDurationExpr(timeRange, 's.ts', 's.dur');
  const runWhere = scopedOverlapWhere(timeRange, 's.ts', 's.dur', 's.dur > 0');
  const sliceWhere = scopedEventWhere(timeRange, 'sl.ts', 'sl.dur');
  return `
    INCLUDE PERFETTO MODULE android.oom_adjuster;
    INCLUDE PERFETTO MODULE android.process_metadata;
    WITH
    oom AS (
      SELECT
        upid,
        SUM(CASE WHEN score = 0 THEN scoped_dur ELSE 0 END) AS foreground_ns,
        SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) AS foreground_count,
        SUM(CASE WHEN score <= 0 AND score > ${PERSISTENT_SCORE_FLOOR} THEN scoped_dur ELSE 0 END) AS foreground_like_ns,
        MAX(score) AS max_score
      FROM (
        SELECT oa.upid AS upid, oa.score AS score, ${oomDuration} AS scoped_dur
        FROM android_oom_adj_intervals oa
        WHERE ${oomWhere}
      )
      GROUP BY upid
    ),
    frames AS (
      SELECT a.upid AS upid, COUNT(*) AS frame_count
      FROM actual_frame_timeline_slice a
      WHERE a.upid IS NOT NULL AND ${frameWhere}
      GROUP BY a.upid
    ),
    run AS (
      SELECT
        t.upid AS upid,
        SUM(${runDuration}) AS running_ns,
        SUM(CASE WHEN t.is_main_thread = 1 OR t.tid = rp.pid THEN ${runDuration} ELSE 0 END) AS main_running_ns
      FROM sched s
      JOIN thread t ON t.utid = s.utid
      JOIN process rp ON rp.upid = t.upid
      WHERE s.utid != 0 AND ${runWhere}
      GROUP BY t.upid
    ),
    slices AS (
      SELECT t.upid AS upid, COUNT(*) AS slice_count
      FROM slice sl
      JOIN thread_track tt ON sl.track_id = tt.id
      JOIN thread t ON t.utid = tt.utid
      WHERE t.upid IS NOT NULL AND ${sliceWhere}
      GROUP BY t.upid
    )
    SELECT
      p.upid AS upid,
      p.pid AS pid,
      COALESCE(NULLIF(m.package_name, ''), NULLIF(m.process_name, ''), NULLIF(p.cmdline, ''), p.name) AS package_name,
      COALESCE(NULLIF(m.process_name, ''), NULLIF(p.cmdline, ''), p.name) AS process_name,
      COALESCE(p.android_appid, CASE WHEN m.uid IS NOT NULL THEN m.uid % 100000 END) AS app_id,
      COALESCE(o.foreground_ns, 0) AS foreground_ns,
      COALESCE(o.foreground_count, 0) AS foreground_count,
      COALESCE(o.foreground_like_ns, 0) AS foreground_like_ns,
      o.max_score AS max_score,
      COALESCE(f.frame_count, 0) AS frame_count,
      COALESCE(r.running_ns, 0) AS running_ns,
      COALESCE(r.main_running_ns, 0) AS main_running_ns,
      COALESCE(sc.slice_count, 0) AS slice_count
    FROM process p
    LEFT JOIN android_process_metadata m USING(upid)
    LEFT JOIN oom o USING(upid)
    LEFT JOIN frames f USING(upid)
    LEFT JOIN run r USING(upid)
    LEFT JOIN slices sc USING(upid)
    WHERE COALESCE(o.foreground_like_ns, 0) > 0
      OR COALESCE(f.frame_count, 0) > 0
      OR COALESCE(r.running_ns, 0) > 0
      OR COALESCE(sc.slice_count, 0) > 0
  `;
}

function buildFocusAppBatteryTopSql(timeRange: FocusAppTimeRange | undefined): string {
  const batteryDuration = scopedDurationExpr(timeRange, 'ts', 'safe_dur');
  const batteryWhere = scopedOverlapWhere(timeRange, 'ts', 'safe_dur', 'safe_dur > 50000000');
  return `
    INCLUDE PERFETTO MODULE android.battery_stats;
    SELECT
      str_value AS package_name,
      SUM(${batteryDuration}) AS total_duration_ns,
      COUNT(*) AS switch_count
    FROM android_battery_stats_event_slices
    WHERE track_name = 'battery_stats.top'
      AND ${batteryWhere}
    GROUP BY str_value
  `;
}

function buildFocusAppStartupSql(timeRange: FocusAppTimeRange | undefined): string {
  const startupWhere = scopedEventWhere(timeRange, 'ts', 'dur');
  return `
    INCLUDE PERFETTO MODULE android.startup.startups;
    SELECT package AS package_name, COUNT(*) AS launch_count
    FROM android_startups
    WHERE package IS NOT NULL AND package != '' AND ${startupWhere}
    GROUP BY package
  `;
}

/** One row of `buildFocusAppProcessActivitySql`. */
export interface FocusAppProcessActivity {
  upid: number;
  pid?: number;
  packageName: string;
  processName?: string;
  appId?: number;
  foregroundNs: number;
  foregroundCount: number;
  foregroundLikeNs: number;
  maxOomScore?: number;
  frameCount: number;
  runningNs: number;
  mainThreadRunningNs: number;
  threadSliceCount: number;
}

export interface FocusAppPackageTotal {
  durationNs: number;
  count: number;
}

export interface FocusAppRankingInput {
  processes: FocusAppProcessActivity[];
  batteryTop?: Map<string, FocusAppPackageTotal>;
  launches?: Map<string, number>;
  timeRange?: FocusAppTimeRange;
}

type SignalClass = Exclude<FocusAppDetectionMethod, 'none'>;

interface ScoredProcess {
  process: FocusAppProcessActivity;
  signals: FocusAppSignals;
  batteryTopCount: number;
  penalties: FocusAppPenalty[];
  score: number;
  /** Each class's share of the best eligible value, in [0, 1]. */
  shares: Record<SignalClass, number>;
  /** `shares` times the class weight: the class's contribution to `score`. */
  classes: Record<SignalClass, number>;
}

function share(value: number, best: number): number {
  return best > 0 && value > 0 ? Math.min(1, value / best) : 0;
}

function dominantMethod(scored: ScoredProcess): SignalClass {
  const entries = Object.entries(scored.classes) as Array<[SignalClass, number]>;
  const best = entries.reduce((winner, entry) => entry[1] > winner[1] ? entry : winner, entries[0]);
  return best[1] > 0 ? best[0] : 'sched_activity';
}

/**
 * Signal classes that carry a substantive share of the best eligible value.
 * A trace-long foreground interval with a few milliseconds of CPU is one
 * class, not two.
 */
function substantiveClasses(scored: ScoredProcess): {count: number; activity: boolean} {
  const {shares} = scored;
  const launched = scored.signals.launchCount > 0;
  const present = (Object.keys(shares) as SignalClass[])
    .filter(key => shares[key] >= SUBSTANTIVE_SHARE);
  return {
    count: present.length + (launched ? 1 : 0),
    activity: launched || present.includes('frame_timeline') || present.includes('sched_activity'),
  };
}

function compareScored(a: ScoredProcess, b: ScoredProcess): number {
  return b.score - a.score
    || b.signals.runningNs - a.signals.runningNs
    || b.signals.frameCount - a.signals.frameCount
    || a.process.packageName.localeCompare(b.process.packageName);
}

function measureForMethod(
  scored: ScoredProcess,
  method: SignalClass,
): Pick<DetectedFocusApp, 'totalDurationNs' | 'switchCount'> {
  const {signals} = scored;
  switch (method) {
    case 'battery_stats':
      return {totalDurationNs: signals.batteryTopNs, switchCount: scored.batteryTopCount};
    case 'oom_adj':
      return {totalDurationNs: signals.foregroundNs, switchCount: scored.process.foregroundCount};
    case 'frame_timeline':
      return {totalDurationNs: signals.foregroundNs, switchCount: signals.frameCount};
    case 'sched_activity':
      return {totalDurationNs: signals.runningNs, switchCount: 0};
  }
}

function confidenceFor(
  ranked: ScoredProcess[],
  cap: FocusAppConfidence,
): FocusAppConfidence {
  const [best, runnerUp] = ranked;
  if (!best || best.score <= 0) return 'ambiguous';
  const ratio = runnerUp && runnerUp.score > 0 ? best.score / runnerUp.score : Number.POSITIVE_INFINITY;
  const classes = substantiveClasses(best);
  // Without substantive CPU, frames or a launch, a foreground-only process
  // (a home overlay, an idle screen) is a guess, whatever its margin.
  if (!classes.activity) return 'ambiguous';
  let confidence: FocusAppConfidence = 'ambiguous';
  if (ratio >= HIGH_CONFIDENCE_RATIO && classes.count >= 2) confidence = 'high';
  else if (ratio >= MEDIUM_CONFIDENCE_RATIO) confidence = 'medium';
  if (cap === 'medium' && confidence === 'high') return 'medium';
  return confidence;
}

/**
 * Deterministic focus-app ranking. Exported for unit tests; the SQL above
 * supplies its input.
 *
 * - Candidates are processes that look foreground (oom score in (-900, 0]),
 *   render frames, were battery `top`, or launched an activity in the window.
 * - Hard exclusions: system/launcher/IME names, native paths, `vendor.*`,
 *   provider packages and isolated uids.
 * - A candidate with no CPU time, frame or thread slice in the window is
 *   reported in `excludedNoActivity` instead of ranked.
 * - Shares are relative to the best eligible candidate; a zero best is zero.
 *   System uids and persistent-only processes are penalised, never excluded.
 * - A package keeps its best process (multi-user / multi-process never sum).
 * - Without any candidate signal the ranking falls back to CPU activity of
 *   app uids, capped at `medium` confidence.
 */
export function rankFocusAppCandidates(input: FocusAppRankingInput): FocusAppDetectionResult {
  const timeRange = input.timeRange;
  const batteryTop = input.batteryTop ?? new Map<string, FocusAppPackageTotal>();
  const launches = input.launches ?? new Map<string, number>();
  const processes = input.processes.filter(process =>
    process.packageName
    && !isSystemProcess(process.packageName)
    && !(process.processName && isSystemProcess(process.processName))
    && !isIsolatedAppId(process.appId));
  // Traces without sched or thread slices cannot show activity at all; the
  // gate then has nothing to measure and must not exclude every candidate.
  const traceHasActivityData = input.processes.some(process =>
    process.runningNs > 0 || process.threadSliceCount > 0);
  const hasActivity = (process: FocusAppProcessActivity) =>
    !traceHasActivityData
    || process.runningNs > 0 || process.frameCount > 0 || process.threadSliceCount > 0;

  const isCandidate = (process: FocusAppProcessActivity) =>
    process.foregroundLikeNs > 0
    || process.frameCount > 0
    || (batteryTop.get(process.packageName)?.durationNs ?? 0) > 0
    || (launches.get(process.packageName) ?? 0) > 0;

  let eligible: FocusAppProcessActivity[] = [];
  const excluded: FocusAppExcludedProcess[] = [];
  for (const process of processes) {
    if (!isCandidate(process)) continue;
    if (hasActivity(process)) {
      eligible.push(process);
      continue;
    }
    excluded.push({
      packageName: process.packageName,
      ...(process.processName ? {processName: process.processName} : {}),
      upid: process.upid,
      ...(process.pid !== undefined ? {pid: process.pid} : {}),
      reason: 'no_activity',
      foregroundNs: process.foregroundLikeNs,
      ...(process.maxOomScore !== undefined ? {maxOomScore: process.maxOomScore} : {}),
    });
  }
  let confidenceCap: FocusAppConfidence = 'high';
  if (eligible.length === 0) {
    eligible = processes.filter(process =>
      process.appId !== undefined
      && process.appId >= FIRST_APPLICATION_APPID
      && process.runningNs > 0);
    confidenceCap = 'medium';
  }

  const signalsFor = (process: FocusAppProcessActivity): FocusAppSignals => ({
    batteryTopNs: batteryTop.get(process.packageName)?.durationNs ?? 0,
    launchCount: launches.get(process.packageName) ?? 0,
    frameCount: process.frameCount,
    foregroundNs: process.foregroundNs,
    runningNs: process.runningNs,
    mainThreadRunningNs: process.mainThreadRunningNs,
    threadSliceCount: process.threadSliceCount,
  });
  const penaltiesFor = (process: FocusAppProcessActivity): FocusAppPenalty[] => {
    const penalties: FocusAppPenalty[] = [];
    if (process.appId !== undefined && process.appId < FIRST_APPLICATION_APPID) penalties.push('system_uid');
    if (process.maxOomScore !== undefined && process.maxOomScore < 0) penalties.push('persistent_only');
    if ((process.processName ?? '').includes(':')) penalties.push('subprocess');
    return penalties;
  };
  const withSignals = eligible.map(process =>
    ({process, signals: signalsFor(process), penalties: penaltiesFor(process)}));
  // Penalised processes (system uids, persistent services, subprocesses) must
  // not set the scale: a persistent service burning a second of CPU would
  // otherwise shrink every app's activity share to nothing. They set it only
  // when nothing unpenalised is eligible.
  const unpenalised = withSignals.filter(entry => entry.penalties.length === 0);
  const scale = unpenalised.length > 0 ? unpenalised : withSignals;
  const best = (pick: (signals: FocusAppSignals) => number) =>
    scale.reduce((max, entry) => Math.max(max, pick(entry.signals)), 0);
  const bestTop = best(signals => signals.batteryTopNs);
  const bestFrames = best(signals => signals.frameCount);
  const bestForeground = best(signals => signals.foregroundNs);
  const bestRunning = best(signals => signals.runningNs);

  const scored: ScoredProcess[] = withSignals.map(({process, signals, penalties}) => {
    const shares = {
      battery_stats: share(signals.batteryTopNs, bestTop),
      frame_timeline: share(signals.frameCount, bestFrames),
      oom_adj: share(signals.foregroundNs, bestForeground),
      sched_activity: share(signals.runningNs, bestRunning),
    };
    const classes = {
      battery_stats: FOCUS_APP_WEIGHTS.batteryTop * shares.battery_stats,
      frame_timeline: FOCUS_APP_WEIGHTS.frames * shares.frame_timeline,
      oom_adj: FOCUS_APP_WEIGHTS.foreground * shares.oom_adj,
      sched_activity: FOCUS_APP_WEIGHTS.running * shares.sched_activity,
    };
    const launch = signals.launchCount > 0 ? FOCUS_APP_WEIGHTS.launch : 0;
    let factor = 1;
    if (penalties.includes('system_uid') || penalties.includes('persistent_only')) factor *= SYSTEM_OR_PERSISTENT_FACTOR;
    if (penalties.includes('subprocess')) factor *= SUBPROCESS_FACTOR;
    const base = Object.values(classes).reduce((sum, value) => sum + value, 0) + launch;
    // An activity start in the window is the user's own action on that app: a
    // launcher or previous app that owns most of the window cannot outrank it.
    const tier = signals.launchCount > 0 ? LAUNCH_TIER_BONUS : 0;
    return {
      process,
      signals,
      batteryTopCount: batteryTop.get(process.packageName)?.count ?? 0,
      penalties,
      score: (base + tier) * factor,
      shares,
      classes,
    };
  });

  // Collapse per package to its best process: never sum across users or processes.
  const bestByPackage = new Map<string, ScoredProcess>();
  for (const entry of scored.sort(compareScored)) {
    if (!bestByPackage.has(entry.process.packageName)) bestByPackage.set(entry.process.packageName, entry);
  }
  const ranked = [...bestByPackage.values()].filter(entry => entry.score > 0);
  const excludedNoActivity = excluded
    .sort((a, b) => b.foregroundNs - a.foregroundNs || a.packageName.localeCompare(b.packageName))
    .slice(0, EXCLUDED_REPORT_LIMIT);
  if (ranked.length === 0) {
    return {
      apps: [],
      method: 'none',
      ...(excludedNoActivity.length ? {excludedNoActivity} : {}),
      timeRange,
    };
  }

  const confidence = confidenceFor(ranked, confidenceCap);
  const method = confidenceCap === 'medium' ? 'sched_activity' : dominantMethod(ranked[0]);
  const apps = ranked.slice(0, FOCUS_APP_CANDIDATE_LIMIT).map((entry): DetectedFocusApp => ({
    packageName: entry.process.packageName,
    ...measureForMethod(entry, method),
    upid: entry.process.upid,
    ...(entry.process.pid !== undefined ? {pid: entry.process.pid} : {}),
    ...(entry.process.processName ? {processName: entry.process.processName} : {}),
    signals: entry.signals,
    penalties: entry.penalties,
    score: Math.round(entry.score * 100) / 100,
    ...(timeRange ? {scopeStartNs: timeRange.startNs, scopeEndNs: timeRange.endNs} : {}),
  }));
  return {
    apps,
    ...(confidence !== 'ambiguous' ? {primaryApp: apps[0].packageName} : {}),
    method,
    confidence,
    ...(excludedNoActivity.length ? {excludedNoActivity} : {}),
    timeRange,
  };
}

/**
 * Focus detection is several queries with no cheaper form, so a bounded turn
 * that asks two questions about one trace would run them twice. Architecture
 * and vendor already cache per trace; this closes the remaining preflight that
 * did not.
 *
 * The key is the processor service (a different service is a different trace
 * world, and it keeps one test's mock out of the next one), the trace, and the
 * exact scope — a different selected range is a different answer, never a hit.
 * A `none` result is never cached: it cannot tell "this trace has no focus
 * app" from a transient query failure, and caching it would pin that failure
 * to the trace for the life of the process.
 */
const FOCUS_CACHE_ENTRIES = 32;
const focusResultCache = new WeakMap<TraceProcessorService, Map<string, FocusAppDetectionResult>>();

function focusCacheKey(traceId: string, timeRange: FocusAppTimeRange | undefined): string {
  return timeRange ? `${traceId}|${timeRange.startNs}-${timeRange.endNs}` : `${traceId}|full`;
}

export async function detectFocusApps(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: FocusAppDetectionOptions = {},
): Promise<FocusAppDetectionResult> {
  const timeRange = normalizeTimeRange(options.timeRange);
  const cacheKey = focusCacheKey(traceId, timeRange);
  const cache = focusResultCache.get(traceProcessorService);
  const cached = cache && getLruCacheEntry(cache, cacheKey);
  if (cached) return cached;
  const result = await detectFocusAppsUncached(traceProcessorService, traceId, timeRange);
  if (result.method !== 'none') {
    const store = cache ?? new Map<string, FocusAppDetectionResult>();
    if (!cache) focusResultCache.set(traceProcessorService, store);
    setLruCacheEntry(store, cacheKey, result, FOCUS_CACHE_ENTRIES);
  }
  return result;
}

function optionalNumber(value: unknown): number | undefined {
  return toNullableNumber(value) ?? undefined;
}

/** Per-package rows whose first column is the package name; a failed query enriches nothing. */
async function queryPackageRows<T>(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  sql: string,
  label: string,
  read: (row: unknown[]) => T,
): Promise<Map<string, T>> {
  const totals = new Map<string, T>();
  try {
    const result = assertQuerySucceeded(await traceProcessorService.query(traceId, sql));
    for (const row of result.rows) {
      const packageName = String(row[0] ?? '').trim();
      if (!packageName) continue;
      totals.set(packageName, read(row));
    }
  } catch (err) {
    console.warn(`[FocusAppDetector] ${label} enrichment failed:`, (err as Error).message);
  }
  return totals;
}

async function detectFocusAppsUncached(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  timeRange: FocusAppTimeRange | undefined,
): Promise<FocusAppDetectionResult> {
  let processes: FocusAppProcessActivity[];
  try {
    const result = assertQuerySucceeded(
      await traceProcessorService.query(traceId, buildFocusAppProcessActivitySql(timeRange)),
    );
    const index = new Map(result.columns.map((column, position) => [column, position]));
    const cell = (row: unknown[], column: string) => row[index.get(column) ?? -1];
    processes = result.rows.map(row => ({
      upid: toNumber(cell(row, 'upid')),
      pid: optionalNumber(cell(row, 'pid')),
      // Without package metadata the name falls back to the process name;
      // `com.foo:remote` still belongs to package `com.foo`.
      packageName: String(cell(row, 'package_name') ?? '').trim().split(':')[0],
      processName: String(cell(row, 'process_name') ?? '').trim() || undefined,
      appId: optionalNumber(cell(row, 'app_id')),
      foregroundNs: toNumber(cell(row, 'foreground_ns')),
      foregroundCount: toNumber(cell(row, 'foreground_count')),
      foregroundLikeNs: toNumber(cell(row, 'foreground_like_ns')),
      maxOomScore: optionalNumber(cell(row, 'max_score')),
      frameCount: toNumber(cell(row, 'frame_count')),
      runningNs: toNumber(cell(row, 'running_ns')),
      mainThreadRunningNs: toNumber(cell(row, 'main_running_ns')),
      threadSliceCount: toNumber(cell(row, 'slice_count')),
    }));
  } catch (err) {
    console.warn('[FocusAppDetector] process activity query failed:', (err as Error).message);
    return {apps: [], method: 'none', timeRange};
  }

  const batteryTop = await queryPackageRows(
    traceProcessorService, traceId, buildFocusAppBatteryTopSql(timeRange), 'battery_stats.top',
    (row): FocusAppPackageTotal => ({durationNs: toNumber(row[1]), count: toNumber(row[2])}));
  const launches = await queryPackageRows(
    traceProcessorService, traceId, buildFocusAppStartupSql(timeRange), 'android_startups',
    row => toNumber(row[1]));
  return rankFocusAppCandidates({processes, batteryTop, launches, timeRange});
}

/** Human-readable duration for system prompt (e.g. "2.3s", "145ms") */
export function formatDurationNs(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(1)}s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(0)}ms`;
  return `${(ns / 1_000).toFixed(0)}us`;
}
