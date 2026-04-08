// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneIntervalBuilder — pure helpers that turn scene_reconstruction skill
 * envelopes into the two-layer scene model used by the Story pipeline.
 *
 * buildDisplayedScenes() returns the FULL list of detected scenes covering
 * every step the skill emits — app_launches / user_gestures / inertial_scrolls
 * / idle_periods / screen_state_changes / scroll_initiation / top_app_changes,
 * with jank_events as a fallback when no gesture-like scene was found.
 *
 * buildAnalysisIntervals() takes that full list and selects the priority-
 * truncated subset that should run through SceneAnalysisJobRunner, applying
 * each manifest route's paramMapping to produce concrete skill parameters.
 *
 * Both functions are pure: no I/O, no globals, no side effects.
 */

import { DataEnvelope } from '../../types/dataContract';
import { payloadToObjectRows } from '../strategies/helpers';
import {
  DEFAULT_DOMAIN_MANIFEST,
  DomainManifest,
  SceneReconstructionRouteRule,
  getSceneReconstructionRoutes,
  matchesSceneReconstructionRoute,
} from '../config/domainManifest';
import {
  AnalysisInterval,
  DisplayedScene,
} from './types';

// ---------------------------------------------------------------------------
// Threshold table — drives priority and severity for each scene category.
// Mirrors the older PROBLEM_THRESHOLDS table from sceneReconstructionStrategy.
// ---------------------------------------------------------------------------

interface SceneThreshold {
  durationMs?: number;
  fps?: number;
}

const PROBLEM_THRESHOLDS: Record<string, SceneThreshold> = {
  cold_start: { durationMs: 1000 },
  warm_start: { durationMs: 600 },
  hot_start: { durationMs: 200 },
  scroll: { fps: 50 },
  inertial_scroll: { fps: 50 },
  tap: { durationMs: 200 },
  long_press: { durationMs: 500 },
  navigation: { durationMs: 500 },
};

const SCENE_DISPLAY_NAMES: Record<string, string> = {
  cold_start: '冷启动',
  warm_start: '温启动',
  hot_start: '热启动',
  scroll_start: '滑动启动',
  scroll: '滑动浏览',
  inertial_scroll: '惯性滑动',
  navigation: '页面跳转',
  app_switch: '应用切换',
  screen_on: '屏幕点亮',
  screen_off: '屏幕熄灭',
  screen_sleep: '屏幕休眠',
  screen_unlock: '解锁屏幕',
  notification: '通知操作',
  split_screen: '分屏操作',
  tap: '点击',
  long_press: '长按',
  idle: '空闲',
  jank_region: '性能问题区间',
};

// ---------------------------------------------------------------------------
// buildDisplayedScenes — full timeline list, no truncation
// ---------------------------------------------------------------------------

export interface BuildDisplayedScenesResult {
  scenes: DisplayedScene[];
  /** From the trace_time_range step, used by callers to size the analysis cap. */
  traceDurationSec: number;
}

export function buildDisplayedScenes(envelopes: DataEnvelope[]): BuildDisplayedScenesResult {
  const scenes: DisplayedScene[] = [];
  const jankRowsForFallback: Array<Record<string, any>> = [];
  let hasGestureLikeScene = false;
  let traceDurationSec = 0;

  for (const env of envelopes) {
    if (env?.meta?.skillId !== 'scene_reconstruction') continue;
    const stepId = env.meta?.stepId;
    if (!stepId) continue;

    const rows = payloadToObjectRows(env.data);

    if (stepId === 'trace_time_range') {
      const first = rows[0];
      if (first?.duration_sec) traceDurationSec = Number(first.duration_sec) || 0;
      continue;
    }

    if (rows.length === 0) continue;

    if (stepId === 'app_launches') {
      for (const row of rows) {
        const scene = sceneFromAppLaunch(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'user_gestures') {
      for (const row of rows) {
        const scene = sceneFromUserGesture(row, scenes.length);
        if (scene) {
          scenes.push(scene);
          hasGestureLikeScene = true;
        }
      }
    } else if (stepId === 'inertial_scrolls') {
      for (const row of rows) {
        const scene = sceneFromInertialScroll(row, scenes.length);
        if (scene) {
          scenes.push(scene);
          hasGestureLikeScene = true;
        }
      }
    } else if (stepId === 'idle_periods') {
      for (const row of rows) {
        const scene = sceneFromIdlePeriod(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'top_app_changes') {
      for (const row of rows) {
        const scene = sceneFromTopAppChange(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'scroll_initiation') {
      // Previously missing from the legacy extractor's handled step list.
      for (const row of rows) {
        const scene = sceneFromScrollInitiation(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'screen_state_changes') {
      // Previously missing from the legacy extractor's handled step list.
      for (const row of rows) {
        const scene = sceneFromScreenStateChange(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'jank_events') {
      jankRowsForFallback.push(...rows);
    }
  }

  if (!hasGestureLikeScene && jankRowsForFallback.length > 0) {
    const intervals = aggregateJankFramesToIntervals(jankRowsForFallback);
    for (const interval of intervals) {
      if (interval.jankCount < 3) continue;
      scenes.push({
        id: `jank_events-${scenes.length}`,
        sceneType: 'jank_region',
        sourceStepId: 'jank_events',
        startTs: interval.startTs,
        endTs: interval.endTs,
        durationMs: interval.durationMs,
        processName: 'jank_region',
        label: `${displayNameOf('jank_region')} (${interval.jankCount} 帧掉帧)`,
        metadata: {
          jankCount: interval.jankCount,
          severity: interval.severity,
          fallback: true,
        },
        severity: interval.severity === 'severe' ? 'bad' : 'warning',
        analysisState: 'not_planned',
      });
    }
  }

  // Sort by startTs so the timeline rendering and Stage 3 prompt see scenes
  // in chronological order regardless of which skill step produced them
  // (the scene_reconstruction skill's step order is structural, not temporal).
  // Pre-compute BigInt keys once to avoid O(N log N) string→BigInt re-parsing.
  const sortKeys = new Map<string, bigint | null>(
    scenes.map((s) => [s.id, safeBigInt(s.startTs)]),
  );
  scenes.sort((a, b) => {
    const ai = sortKeys.get(a.id) ?? null;
    const bi = sortKeys.get(b.id) ?? null;
    if (ai === null || bi === null) return 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });

  return { scenes, traceDurationSec };
}

// ---------------------------------------------------------------------------
// buildAnalysisIntervals — priority-truncated subset for Agent deep-dive
// ---------------------------------------------------------------------------

export interface BuildAnalysisIntervalsOptions {
  /** Hard upper bound on intervals returned. */
  cap: number;
  /** Defaults to DEFAULT_DOMAIN_MANIFEST. */
  manifest?: DomainManifest;
}

export function buildAnalysisIntervals(
  scenes: DisplayedScene[],
  options: BuildAnalysisIntervalsOptions,
): AnalysisInterval[] {
  const manifest = options.manifest ?? DEFAULT_DOMAIN_MANIFEST;
  const routes = getSceneReconstructionRoutes(manifest);
  if (routes.length === 0 || scenes.length === 0) return [];

  // Score each scene then pick a matching route in priority order.
  const scored = scenes
    .map((scene) => ({ scene, priority: computePriority(scene) }))
    .sort((a, b) => b.priority - a.priority);

  const intervals: AnalysisInterval[] = [];
  for (const { scene, priority } of scored) {
    if (intervals.length >= options.cap) break;
    const route = findMatchingRoute(scene.sceneType, routes);
    if (!route) continue;
    intervals.push({
      displayedSceneId: scene.id,
      priority,
      routeRuleId: route.id,
      skillId: route.directSkillId,
      params: resolveParams(route, scene),
    });
  }

  return intervals;
}

/**
 * Compute the same numeric priority the legacy strategy used: 90 when the
 * scene exceeds its threshold (a "problem" scene), 50 otherwise.
 */
export function computePriority(scene: DisplayedScene): number {
  const threshold = PROBLEM_THRESHOLDS[scene.sceneType];
  if (!threshold) return 50;
  if (threshold.durationMs != null && scene.durationMs > threshold.durationMs) {
    return 90;
  }
  if (threshold.fps != null) {
    const avgFps = Number(scene.metadata?.averageFps);
    if (Number.isFinite(avgFps) && avgFps < threshold.fps) return 90;
  }
  return 50;
}

// ---------------------------------------------------------------------------
// Per-step factories
// ---------------------------------------------------------------------------

function sceneFromAppLaunch(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '');
  const endTs = safeAddNs(startTs, dur);
  if (!startTs || !dur || !endTs) return null;
  const durationMs = nsToMs(dur);
  if (!Number.isFinite(durationMs)) return null;

  const startupType = String(row.startup_type ?? '').toLowerCase();
  const sceneType =
    startupType === 'warm' ? 'warm_start'
    : startupType === 'hot' ? 'hot_start'
    : 'cold_start';

  const startupIdRaw = Number(row.startup_id ?? row.startupId);
  const startupId = Number.isFinite(startupIdRaw) && startupIdRaw > 0 ? startupIdRaw : index + 1;
  const ttidMs = numericOrUndefined(row.ttid_ms ?? row.ttidMs);
  const ttfdMs = numericOrUndefined(row.ttfd_ms ?? row.ttfdMs);

  return {
    id: `app_launches-${index}`,
    sceneType,
    sourceStepId: 'app_launches',
    startTs,
    endTs,
    durationMs,
    processName: String(row.package ?? '') || 'unknown',
    label: `${displayNameOf(sceneType)} (${durationMs}ms)`,
    metadata: {
      startupId,
      startupType: startupType || undefined,
      startup_id: startupId,
      startup_type: startupType || undefined,
      ttidMs,
      ttfdMs,
      ttid_ms: ttidMs,
      ttfd_ms: ttfdMs,
    },
    severity: severityFor(sceneType, durationMs),
    analysisState: 'not_planned',
  };
}

function sceneFromUserGesture(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '');
  const endTs = safeAddNs(startTs, dur);
  if (!startTs || !dur || !endTs) return null;
  const durationMs = nsToMs(dur);
  if (!Number.isFinite(durationMs)) return null;

  const gestureType = String(row.gesture_type ?? '').toLowerCase();
  const sceneType =
    gestureType === 'scroll' ? 'scroll'
    : gestureType === 'long_press' ? 'long_press'
    : 'tap';

  return {
    id: `user_gestures-${index}`,
    sceneType,
    sourceStepId: 'user_gestures',
    startTs,
    endTs,
    durationMs,
    processName: resolveProcessName(row),
    label: `${displayNameOf(sceneType)} (${durationMs}ms)`,
    metadata: {
      confidence: row.confidence,
      moveCount: row.move_count,
    },
    severity: severityFor(sceneType, durationMs, row),
    analysisState: 'not_planned',
  };
}

function sceneFromInertialScroll(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '');
  const endTs = safeAddNs(startTs, dur);
  if (!startTs || !dur || !endTs) return null;
  const durationMs = nsToMs(dur);
  if (!Number.isFinite(durationMs)) return null;

  return {
    id: `inertial_scrolls-${index}`,
    sceneType: 'inertial_scroll',
    sourceStepId: 'inertial_scrolls',
    startTs,
    endTs,
    durationMs,
    processName: resolveProcessName(row),
    label: `${displayNameOf('inertial_scroll')} (${durationMs}ms)`,
    metadata: {
      frameCount: row.frame_count,
      jankFrames: row.jank_frames,
    },
    severity: severityFor('inertial_scroll', durationMs, row),
    analysisState: 'not_planned',
  };
}

function sceneFromIdlePeriod(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '');
  const endTs = safeAddNs(startTs, dur);
  if (!startTs || !dur || !endTs) return null;
  const durationMs = nsToMs(dur);
  if (!Number.isFinite(durationMs)) return null;

  return {
    id: `idle_periods-${index}`,
    sceneType: 'idle',
    sourceStepId: 'idle_periods',
    startTs,
    endTs,
    durationMs,
    processName: 'system',
    label: `${displayNameOf('idle')} (${durationMs}ms)`,
    metadata: {
      confidence: row.confidence,
    },
    severity: 'good',
    analysisState: 'not_planned',
  };
}

function sceneFromTopAppChange(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '');
  const endTs = safeAddNs(startTs, dur);
  if (!startTs || !dur || !endTs) return null;
  const durationMs = nsToMs(dur);
  if (!Number.isFinite(durationMs)) return null;

  return {
    id: `top_app_changes-${index}`,
    sceneType: 'app_switch',
    sourceStepId: 'top_app_changes',
    startTs,
    endTs,
    durationMs,
    processName: String(row.app_package ?? '') || 'unknown',
    label: `${displayNameOf('app_switch')} (${durationMs}ms)`,
    metadata: {},
    severity: 'good',
    analysisState: 'not_planned',
  };
}

function sceneFromScrollInitiation(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  if (!startTs) return null;
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;

  return {
    id: `scroll_initiation-${index}`,
    sceneType: 'scroll_start',
    sourceStepId: 'scroll_initiation',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: resolveProcessName(row),
    label: `${displayNameOf('scroll_start')} (${safeDurationMs}ms)`,
    metadata: {
      latencyMs: numericOrUndefined(row.latency_ms ?? row.latencyMs),
    },
    severity: 'good',
    analysisState: 'not_planned',
  };
}

function sceneFromScreenStateChange(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  if (!startTs) return null;
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;

  // The skill emits Chinese event labels (`点亮` / `熄灭` / `休眠`) on the
  // `event` column; mirror agentRoutes.ts:mapScreenStateEventToSceneType so
  // we map them to the same scene types.
  const eventText = String(row.event ?? row.state ?? row.screen_state ?? '').trim();
  const sceneType: string | null =
    eventText.includes('点亮') ? 'screen_on'
    : eventText.includes('熄灭') ? 'screen_off'
    : eventText.includes('休眠') ? 'screen_sleep'
    : null;
  if (!sceneType) return null;

  return {
    id: `screen_state_changes-${index}`,
    sceneType,
    sourceStepId: 'screen_state_changes',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: 'system',
    label: displayNameOf(sceneType),
    metadata: {
      event: eventText,
    },
    severity: 'good',
    analysisState: 'not_planned',
  };
}

// ---------------------------------------------------------------------------
// Jank fallback aggregation — copied verbatim from the legacy strategy so the
// existing trace regression behaviour is preserved.
// ---------------------------------------------------------------------------

interface JankInterval {
  startTs: string;
  endTs: string;
  durationMs: number;
  jankCount: number;
  severity: 'severe' | 'mild';
}

function aggregateJankFramesToIntervals(rows: Array<Record<string, any>>): JankInterval[] {
  if (rows.length === 0) return [];

  const MERGE_GAP_NS = 500_000_000n; // 500ms
  const intervals: JankInterval[] = [];

  const sortedRows = [...rows].sort((a, b) => {
    const aTs = safeBigInt(a.ts);
    const bTs = safeBigInt(b.ts);
    if (aTs === null || bTs === null) return 0;
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  let currentStart = safeBigInt(sortedRows[0].ts);
  let currentEnd = currentStart !== null
    ? currentStart + (safeBigInt(sortedRows[0].dur) ?? 0n)
    : null;
  if (currentStart === null || currentEnd === null) return [];

  let jankCount = 1;
  let severities: string[] = [String(sortedRows[0].jank_severity_type ?? '')];

  for (let i = 1; i < sortedRows.length; i++) {
    const rowTs = safeBigInt(sortedRows[i].ts);
    const rowDur = safeBigInt(sortedRows[i].dur) ?? 0n;
    if (rowTs === null) continue;

    if (rowTs - currentEnd! < MERGE_GAP_NS) {
      const rowEnd = rowTs + rowDur;
      if (rowEnd > currentEnd!) currentEnd = rowEnd;
      jankCount++;
      severities.push(String(sortedRows[i].jank_severity_type ?? ''));
    } else {
      intervals.push({
        startTs: currentStart!.toString(),
        endTs: currentEnd!.toString(),
        durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
        jankCount,
        severity: severities.includes('Full') ? 'severe' : 'mild',
      });
      currentStart = rowTs;
      currentEnd = rowTs + rowDur;
      jankCount = 1;
      severities = [String(sortedRows[i].jank_severity_type ?? '')];
    }
  }

  intervals.push({
    startTs: currentStart!.toString(),
    endTs: currentEnd!.toString(),
    durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
    jankCount,
    severity: severities.includes('Full') ? 'severe' : 'mild',
  });

  return intervals;
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

function findMatchingRoute(
  sceneType: string,
  routes: SceneReconstructionRouteRule[],
): SceneReconstructionRouteRule | null {
  for (const route of routes) {
    if (matchesSceneReconstructionRoute(sceneType, route)) return route;
  }
  return null;
}

function resolveParams(
  route: SceneReconstructionRouteRule,
  scene: DisplayedScene,
): Record<string, any> {
  const params: Record<string, any> = { ...(route.skillParams ?? {}) };
  for (const [paramKey, fieldPath] of Object.entries(route.paramMapping ?? {})) {
    const value = readSceneField(scene, fieldPath);
    if (value !== undefined && value !== null) {
      params[paramKey] = value;
    }
  }
  return params;
}

function readSceneField(scene: DisplayedScene, fieldPath: string): any {
  // Top-level scene field aliases used historically by the manifest's
  // paramMapping (e.g. 'startTs', 'endTs', 'durationMs', 'processName').
  const sceneAny = scene as Record<string, any>;
  if (fieldPath in sceneAny) return sceneAny[fieldPath];

  // Dot-path into metadata, e.g. 'metadata.startupId' or just 'startupId'.
  if (fieldPath.includes('.')) {
    return getNestedField(scene, fieldPath);
  }
  if (scene.metadata && fieldPath in scene.metadata) {
    return scene.metadata[fieldPath];
  }
  return undefined;
}

function getNestedField(obj: any, path: string): any {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function severityFor(
  sceneType: string,
  durationMs: number,
  row?: Record<string, any>,
): DisplayedScene['severity'] {
  const threshold = PROBLEM_THRESHOLDS[sceneType];
  if (!threshold) return 'unknown';
  if (threshold.durationMs != null && durationMs > threshold.durationMs) return 'bad';
  if (threshold.fps != null && row) {
    const avgFps = Number(row.averageFps ?? row.average_fps);
    if (Number.isFinite(avgFps) && avgFps < threshold.fps) return 'bad';
  }
  return 'good';
}

function displayNameOf(sceneType: string): string {
  return SCENE_DISPLAY_NAMES[sceneType] ?? sceneType;
}

// ---------------------------------------------------------------------------
// Numeric / BigInt helpers
// ---------------------------------------------------------------------------

function nsToMs(ns: string): number {
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return NaN;
  }
}

function safeAddNs(startTs: string, durNs: string): string | null {
  try {
    return (BigInt(startTs) + BigInt(durNs)).toString();
  } catch {
    return null;
  }
}

function safeBigInt(value: any): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || !/^-?\d+$/.test(s)) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function numericOrUndefined(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function resolveProcessName(row: Record<string, any>): string {
  const appPackage = String(row.app_package ?? '').trim();
  if (appPackage) return appPackage;
  const eventText = String(row.event ?? '');
  const m = eventText.match(/\[([^\]]+)\]\s*$/);
  if (m) return m[1];
  return 'unknown';
}
