// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneIntervalBuilder — pure helpers that turn scene_reconstruction skill
 * envelopes into the two-layer scene model used by the Story pipeline.
 *
 * buildDisplayedScenes() returns the FULL list of detected scenes covering
 * the user-visible scene timeline — app_launches / user_gestures /
 * inertial_scrolls / idle_periods / screen_state_changes / system_events /
 * scroll_initiation / top_app_changes, with clean_timeline as a deterministic
 * backfill source and jank_events as a fallback when no gesture-like scene was
 * found. Android runtime rows (operation_chain / activity_lifecycle /
 * app_state_tracking / device_state) enrich scenes as context instead of
 * becoming deep-dive targets by default.
 *
 * buildAnalysisIntervals() takes that full list and selects the priority-
 * truncated subset that should run through SceneAnalysisJobRunner, applying
 * each manifest route's paramMapping to produce concrete skill parameters.
 *
 * Both functions are pure: no I/O, no globals, no side effects.
 */

import { DataEnvelope } from '../../types/dataContract';
import {
  DEFAULT_DOMAIN_MANIFEST,
  DomainManifest,
  SceneRouteProfile,
  SceneReconstructionRouteRule,
  findSceneReconstructionRoute,
  getSceneReconstructionRoutes,
} from '../config/domainManifest';
import {
  AnalysisInterval,
  DisplayedScene,
  SceneConflict,
  SceneEvidenceRef,
  SceneAnalysisSelection,
} from './types';
import {displaySceneType, isKnownSceneType} from './scenePresentation';
import {rowObject} from '../../utils/traceProcessorRowUtils';

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
  navigation: { durationMs: 500 },
  anr: { durationMs: 5000 },
  window_transition: { durationMs: 500 },
};

const SCROLL_CHAIN_TOLERANCE_NS = 250_000_000n;
const CONTEXT_WINDOW_NS = 750_000_000n;
const MAX_CONTEXT_ROWS_PER_GROUP = 6;

/** Known launcher / home-screen package patterns */
const LAUNCHER_PATTERNS = [
  'miui.home', 'launcher', 'trebuchet', 'lawnchair',
  'nexuslauncher', 'home', 'oneplus.launcher',
];

function isLauncherPackage(pkg: string): boolean {
  const lower = pkg.toLowerCase();
  return LAUNCHER_PATTERNS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// buildDisplayedScenes — full timeline list, no truncation
// ---------------------------------------------------------------------------

export interface BuildDisplayedScenesResult {
  scenes: DisplayedScene[];
  /** From the trace_time_range step, used by callers to size the analysis cap. */
  traceDurationSec: number;
  traceBounds?: {startTs: string; endTs: string};
  inputCoverage?: Record<string, unknown>;
}

export function buildDisplayedScenes(envelopes: DataEnvelope[]): BuildDisplayedScenesResult {
  const scenes: DisplayedScene[] = [];
  const jankRowsForFallback: Array<Record<string, any>> = [];
  const rowsByStep = new Map<string, Array<Record<string, any>>>();
  let hasGestureLikeScene = false;
  let traceDurationSec = 0;
  let traceBounds: BuildDisplayedScenesResult['traceBounds'];
  let inputCoverage: BuildDisplayedScenesResult['inputCoverage'];

  for (const env of envelopes) {
    if (env?.meta?.skillId !== 'scene_reconstruction') continue;
    const stepId = env.meta?.stepId;
    if (!stepId) continue;

    const rows = payloadToObjectRows(env.data);
    rowsByStep.set(stepId, rows);

    if (stepId === 'trace_time_range') {
      const first = rows[0];
      if (first?.duration_sec) traceDurationSec = Number(first.duration_sec) || 0;
      const start = safeBigInt(first?.start_ts_str ?? first?.start_ts);
      const end = safeBigInt(first?.end_ts_str ?? first?.end_ts);
      if (start !== null && end !== null && start >= 0n && end >= start) {
        traceBounds = {startTs: start.toString(), endTs: end.toString()};
      }
      continue;
    }
    if (stepId === 'input_coverage') {
      inputCoverage = rows[0];
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
    } else if (stepId === 'system_events') {
      for (const row of rows) {
        const scene = sceneFromSystemEvent(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'navigation_keys' || stepId === 'gesture_navigation') {
      for (const row of rows) {
        const scene = sceneFromNavigationKey(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'anr_events') {
      for (const row of rows) {
        const scene = sceneFromAnrEvent(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'ime_events') {
      for (const row of rows) {
        const scene = sceneFromImeEvent(row, scenes.length);
        if (scene) scenes.push(scene);
      }
    } else if (stepId === 'window_transitions') {
      for (const row of rows) {
        const scene = sceneFromWindowTransition(row, scenes.length);
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

  enrichDisplayedScenes(scenes, rowsByStep);

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

  return { scenes, traceDurationSec, traceBounds, inputCoverage };
}

// ---------------------------------------------------------------------------
// buildAnalysisIntervals — priority-truncated subset for Agent deep-dive
// ---------------------------------------------------------------------------

export interface BuildAnalysisIntervalsOptions {
  /** Hard upper bound on intervals returned. */
  cap: number;
  /** Defaults to DEFAULT_DOMAIN_MANIFEST. */
  manifest?: DomainManifest;
  /** Route profile for Stage 2. Defaults to legacy /scene-reconstruct behavior. */
  routeProfile?: SceneRouteProfile;
}

export function buildAnalysisIntervals(
  scenes: DisplayedScene[],
  options: BuildAnalysisIntervalsOptions,
): AnalysisInterval[] {
  const manifest = options.manifest ?? DEFAULT_DOMAIN_MANIFEST;
  const routes = getSceneReconstructionRoutes(options.routeProfile ?? 'legacy', manifest);
  if (routes.length === 0 || scenes.length === 0) return [];

  // Score each scene then pick a matching route in priority order.
  const scored = scenes
    .filter(isAnalysisEligibleScene)
    .map((scene) => ({ scene, priority: computePriority(scene) }))
    .sort((a, b) => b.priority - a.priority);

  const intervals: AnalysisInterval[] = [];
  for (const { scene, priority } of scored) {
    if (intervals.length >= options.cap) break;
    const route = findSceneReconstructionRoute(scene.sceneType, routes);
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

export function isAnalysisEligibleScene(scene: DisplayedScene): boolean {
  return scene.analysisEligible !== false &&
    scene.sceneRole !== 'marker' &&
    scene.sceneRole !== 'context';
}

export function selectAnalysisEligibleScenes(
  scenes: DisplayedScene[],
  selection?: SceneAnalysisSelection,
): DisplayedScene[] {
  return filterDisplayedScenesForSelection(scenes, selection)
    .filter(isAnalysisEligibleScene);
}

export function filterDisplayedScenesForSelection(
  scenes: DisplayedScene[],
  selection?: SceneAnalysisSelection,
): DisplayedScene[] {
  if (!selection || selection.scope === 'all') return scenes;

  if (selection.scope === 'scene_types') {
    const selectedTypes = new Set(selection.sceneTypes ?? []);
    if (selectedTypes.size === 0) return [];
    return scenes.filter((scene) => selectedTypes.has(scene.sceneType));
  }

  if (selection.scope === 'scene_ids') {
    const selectedIds = new Set(selection.sceneIds ?? []);
    if (selectedIds.size === 0) return [];
    return scenes.filter((scene) => selectedIds.has(scene.id));
  }

  return [];
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
  const sceneType = isKnownSceneType(gestureType) ? gestureType : 'input_unknown';

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
      ...row,
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
      ...row,
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
  const sceneType = row.category === 'unknown' || row.source_status === 'unknown'
    ? 'input_unknown' : 'idle';

  return {
    id: `idle_periods-${index}`,
    sceneType,
    sourceStepId: 'idle_periods',
    startTs,
    endTs,
    durationMs,
    processName: 'system',
    label: `${displayNameOf(sceneType)} (${durationMs}ms)`,
    metadata: {
      ...row,
      confidence: row.confidence,
    },
    sceneRole: 'context',
    severity: 'unknown',
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

  const pkg = String(row.app_package ?? '') || 'unknown';
  const isLauncher = isLauncherPackage(pkg);
  const sceneType = isLauncher ? 'home_screen' : 'app_foreground';
  const label = isLauncher
    ? `${displayNameOf('home_screen')} (${formatDuration(durationMs)})`
    : `${displayNameOf('app_foreground')} (${formatDuration(durationMs)})`;

  return {
    id: `top_app_changes-${index}`,
    sceneType,
    sourceStepId: 'top_app_changes',
    startTs,
    endTs,
    durationMs,
    processName: pkg,
    label,
    metadata: {},
    severity: 'good',
    analysisState: 'not_planned',
  };
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function sceneFromScrollInitiation(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  if (!startTs) return null;
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;
  const sceneType = row.event_type === 'scroll_processing' ? 'scroll_processing' : 'scroll_start';

  return {
    id: `scroll_initiation-${index}`,
    sceneType,
    sourceStepId: 'scroll_initiation',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: resolveProcessName(row),
    label: `${displayNameOf(sceneType)} (${safeDurationMs}ms)`,
    metadata: {
      ...row,
      latencyMs: numericOrUndefined(row.latency_ms ?? row.latencyMs),
    },
    sceneRole: 'marker',
    analysisEligible: false,
    severity: 'unknown',
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

  const eventText = String(row.event ?? row.state ?? row.screen_state ?? '').trim();
  const state = String(row.simple_screen_state ?? row.state ?? '').toLowerCase();
  const sceneType: string | null =
    state === 'on' || eventText.includes('点亮') ? 'screen_on'
    : state === 'off' || eventText.includes('熄灭') ? 'screen_off'
    : state === 'doze' || eventText.includes('休眠') ? 'screen_sleep'
    : state === 'unknown' ? 'screen_unknown'
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
      ...row,
      event: eventText,
    },
    severity: 'unknown',
    analysisState: 'not_planned',
  };
}

function sceneFromSystemEvent(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  if (!startTs) return null;
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;

  const rawType = String(row.event_type ?? '').trim();
  const sceneType =
    rawType === 'screen_unlock' ? 'screen_unlock'
    : rawType === 'notification' ? 'notification'
    : rawType === 'split_screen' ? 'split_screen'
    : rawType === 'pip' ? 'pip'
    : null;
  if (!sceneType) return null;

  const eventText = String(row.event ?? '').trim();
  return {
    id: `system_events-${index}`,
    sceneType,
    sourceStepId: 'system_events',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: 'system',
    label: `${displayNameOf(sceneType)} (${formatDuration(safeDurationMs)})`,
    metadata: {
      event: eventText,
      eventType: rawType,
    },
    severity: 'good',
    analysisState: 'not_planned',
  };
}

// ---------------------------------------------------------------------------
// New scene factories: navigation keys, ANR, IME, window transitions
// ---------------------------------------------------------------------------

function sceneFromNavigationKey(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  if (!startTs) return null;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;

  const keyName = String(row.key_name ?? '').trim();
  if (keyName !== 'back_key' && keyName !== 'home_key' && keyName !== 'recents_key') return null;

  return {
    id: `navigation_keys-${index}`,
    sceneType: keyName,
    sourceStepId: 'navigation_keys',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: 'system',
    label: `${displayNameOf(keyName)} (${formatDuration(safeDurationMs)})`,
    metadata: { keyName },
    severity: 'good',
    analysisState: 'not_planned',
  };
}

function sceneFromAnrEvent(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '5000000000');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  if (!startTs) return null;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 5000;

  return {
    id: `anr_events-${index}`,
    sceneType: 'anr',
    sourceStepId: 'anr_events',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: String(row.process_name ?? '') || 'unknown',
    label: `ANR (${formatDuration(safeDurationMs)})`,
    metadata: {
      processName: row.process_name,
      anrType: row.anr_type,
    },
    severity: 'bad',
    analysisState: 'not_planned',
  };
}

function sceneFromImeEvent(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  if (!startTs) return null;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;

  const action = String(row.ime_action ?? '').trim();
  if (action !== 'ime_show' && action !== 'ime_hide') return null;
  const sceneType = action;

  return {
    id: `ime_events-${index}`,
    sceneType,
    sourceStepId: 'ime_events',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName: 'system',
    label: `${displayNameOf(sceneType)} (${formatDuration(safeDurationMs)})`,
    metadata: {},
    severity: 'good',
    analysisState: 'not_planned',
  };
}

function sceneFromWindowTransition(row: Record<string, any>, index: number): DisplayedScene | null {
  const startTs = String(row.ts ?? '');
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  if (!startTs || !dur) return null;
  const durationMs = nsToMs(dur);
  if (!Number.isFinite(durationMs)) return null;

  return {
    id: `window_transitions-${index}`,
    sceneType: 'window_transition',
    sourceStepId: 'window_transitions',
    startTs,
    endTs,
    durationMs,
    processName: 'system_server',
    label: `${displayNameOf('window_transition')} (${formatDuration(durationMs)})`,
    metadata: {
      transitionType: row.transition_type,
    },
    severity: severityFor('window_transition', durationMs),
    analysisState: 'not_planned',
  };
}

// ---------------------------------------------------------------------------
// Scene contract enrichment and deterministic fusion
// ---------------------------------------------------------------------------

function enrichDisplayedScenes(
  scenes: DisplayedScene[],
  rowsByStep: Map<string, Array<Record<string, any>>>,
): void {
  seedSceneContracts(scenes);
  mergeCleanTimelineRows(scenes, getRows(rowsByStep, 'clean_timeline'));
  attachRuntimeContext(scenes, rowsByStep);
  linkScrollMarkersAndFling(scenes);
  finalizeSceneContracts(scenes);
}

function seedSceneContracts(scenes: DisplayedScene[]): void {
  for (const scene of scenes) {
    const primaryRef = evidenceRefForScene(scene, 'primary');
    scene.sceneRole ??= defaultSceneRole(scene);
    scene.analysisEligible ??= scene.sceneRole === 'action';
    scene.evidenceRefs = mergeEvidenceRefs(scene.evidenceRefs, [primaryRef]);
    scene.confidenceReasons = uniqueStrings([
      ...(scene.confidenceReasons ?? []),
      `primary:${scene.sourceStepId}`,
    ]);
    scene.conflicts ??= [];
  }
}

function mergeCleanTimelineRows(
  scenes: DisplayedScene[],
  rows: Array<Record<string, any>>,
): void {
  rows.forEach((row, index) => {
    const sceneType = normalizeCleanTimelineSceneType(row.event_type);
    if (!sceneType) return;
    const ref = evidenceRefForRow('clean_timeline', row, index, 'supporting');
    const existing = findMatchingSceneForRow(scenes, sceneType, row);
    if (existing) {
      addSupportingEvidence(existing, ref, row, 'clean_timeline');
      return;
    }

    const scene = sceneFromCleanTimeline(row, index);
    if (!scene) return;
    scene.evidenceRefs = mergeEvidenceRefs(scene.evidenceRefs, [ref]);
    scene.confidenceReasons = uniqueStrings([
      ...(scene.confidenceReasons ?? []),
      'derived:clean_timeline',
    ]);
    scenes.push(scene);
  });
}

function sceneFromCleanTimeline(row: Record<string, any>, index: number): DisplayedScene | null {
  const sceneType = normalizeCleanTimelineSceneType(row.event_type);
  if (!sceneType) return null;
  const startTs = String(row.ts ?? '');
  if (!startTs) return null;
  const dur = String(row.dur ?? '0');
  const endTs = safeAddNs(startTs, dur) ?? startTs;
  const durationMs = nsToMs(dur);
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs : 0;
  const eventId = String(row.event_id ?? '').trim();
  const processName = String(row.app_package ?? '').trim() || defaultProcessNameForSceneType(sceneType);
  const sceneRole = defaultSceneRoleForType(sceneType);

  return {
    id: eventId ? `clean_timeline-${eventId}` : `clean_timeline-${sceneType}-${startTs}-${index}`,
    sceneType,
    sourceStepId: 'clean_timeline',
    startTs,
    endTs,
    durationMs: safeDurationMs,
    processName,
    label: `${displayNameOf(sceneType)} (${formatDuration(safeDurationMs)})`,
    metadata: {
      eventId: eventId || undefined,
      event: row.event,
      eventType: row.event_type,
      timeOffset: row.time_offset,
      rating: row.rating,
    },
    severity: severityFor(sceneType, safeDurationMs, row),
    sceneRole,
    analysisEligible: sceneRole === 'action',
    analysisState: 'not_planned',
  };
}

function normalizeCleanTimelineSceneType(value: any): string | null {
  const sceneType = String(value ?? '').trim();
  if (!sceneType) return null;
  if (sceneType === 'system') return null;
  return isKnownSceneType(sceneType) ? sceneType : null;
}

function findMatchingSceneForRow(
  scenes: DisplayedScene[],
  sceneType: string,
  row: Record<string, any>,
): DisplayedScene | null {
  const rowStart = safeBigInt(row.ts);
  if (rowStart === null) return null;
  const rowEnd = rowStart + (safeBigInt(row.dur) ?? 0n);
  return scenes.find((scene) => {
    if (!areSceneTypesEquivalent(scene.sceneType, sceneType)) return false;
    const rowProcess = String(row.app_package ?? '').trim();
    if (rowProcess !== (scene.processName ?? '') &&
      (isMeaningfulProcess(rowProcess) || isMeaningfulProcess(scene.processName))) return false;
    const sceneStart = safeBigInt(scene.startTs);
    const sceneEnd = safeBigInt(scene.endTs);
    if (sceneStart === null || sceneEnd === null) return false;
    // Similar time ranges are not event identity: two taps can be very close.
    return sceneStart === rowStart && sceneEnd === rowEnd;
  }) ?? null;
}

function areSceneTypesEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  const appContext = new Set(['app_foreground', 'home_screen']);
  if (appContext.has(left) && appContext.has(right)) return true;
  return false;
}

function addSupportingEvidence(
  scene: DisplayedScene,
  ref: SceneEvidenceRef,
  row: Record<string, any>,
  reason: string,
): void {
  scene.evidenceRefs = mergeEvidenceRefs(scene.evidenceRefs, [ref]);
  scene.confidenceReasons = uniqueStrings([...(scene.confidenceReasons ?? []), `support:${reason}`]);
  scene.context = {
    ...(scene.context ?? {}),
    cleanTimeline: appendBoundedContext(scene.context?.cleanTimeline, compactContextRow(row)),
  };

  const supportingApp = String(row.app_package ?? '').trim();
  if (supportingApp && isMeaningfulProcess(scene.processName) && scene.processName !== supportingApp) {
    scene.conflicts = [
      ...(scene.conflicts ?? []),
      {
        type: 'app_mismatch',
        severity: 'warning',
        message: `scene app ${scene.processName} differs from ${reason} app ${supportingApp}`,
        evidenceRefs: [evidenceRefForScene(scene, 'primary'), ref],
      },
    ];
  }
}

function attachRuntimeContext(
  scenes: DisplayedScene[],
  rowsByStep: Map<string, Array<Record<string, any>>>,
): void {
  const operationRows = getRows(rowsByStep, 'operation_chain');
  const activityRows = getRows(rowsByStep, 'activity_lifecycle');
  const appStateRows = [
    ...getRows(rowsByStep, 'app_state_tracking'),
    ...getRows(rowsByStep, 'app_states'),
  ];
  const deviceRows = getRows(rowsByStep, 'device_state');

  for (const scene of scenes) {
    const operationChain = contextRowsNearScene(operationRows, scene, CONTEXT_WINDOW_NS);
    const activityLifecycle = contextRowsNearScene(activityRows, scene, CONTEXT_WINDOW_NS);
    const appState = contextRowsNearScene(appStateRows, scene, CONTEXT_WINDOW_NS, (row) =>
      sameMeaningfulProcess(scene.processName, row.app_package),
    );
    const deviceState = contextRowsNearScene(deviceRows, scene, CONTEXT_WINDOW_NS);

    const context = {
      ...(scene.context ?? {}),
      ...(operationChain.length > 0 ? { operationChain } : {}),
      ...(activityLifecycle.length > 0 ? { activityLifecycle } : {}),
      ...(appState.length > 0 ? { appState } : {}),
      ...(deviceState.length > 0 ? { deviceState } : {}),
    };
    if (Object.keys(context).length > 0) {
      scene.context = context;
    }
    if (operationChain.length > 0) {
      scene.evidenceRefs = mergeEvidenceRefs(scene.evidenceRefs, [
        evidenceRefForContext('operation_chain', operationChain[0]),
      ]);
      scene.confidenceReasons = uniqueStrings([...(scene.confidenceReasons ?? []), 'context:operation_chain']);
    }
  }
}

function contextRowsNearScene(
  rows: Array<Record<string, any>>,
  scene: DisplayedScene,
  windowNs: bigint,
  predicate?: (row: Record<string, any>) => boolean,
): Array<Record<string, unknown>> {
  const sceneStart = safeBigInt(scene.startTs);
  const sceneEnd = safeBigInt(scene.endTs);
  if (sceneStart === null || sceneEnd === null) return [];
  const start = sceneStart - windowNs;
  const end = sceneEnd + windowNs;

  const selected: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (predicate && !predicate(row)) continue;
    const rowTs = safeBigInt(row.ts);
    if (rowTs === null || rowTs < start || rowTs > end) continue;
    selected.push(compactContextRow(row));
    if (selected.length >= MAX_CONTEXT_ROWS_PER_GROUP) break;
  }
  return selected;
}

function linkScrollMarkersAndFling(scenes: DisplayedScene[]): void {
  const scrolls = scenes.filter(scene => scene.sceneType === 'scroll');
  const flings = scenes.filter(scene => scene.sceneType === 'inertial_scroll');
  const markers = scenes.filter(scene => scene.sceneType === 'scroll_start');

  for (const marker of markers) {
    marker.sceneRole = 'marker';
    marker.analysisEligible = false;
    const parent = findContainingOrNearestScene(marker, scrolls, SCROLL_CHAIN_TOLERANCE_NS);
    if (!parent) continue;
    linkParentChild(parent, marker);
    marker.confidenceReasons = uniqueStrings([...(marker.confidenceReasons ?? []), 'linked:scroll_start']);
  }

  for (const fling of flings) {
    const parent = findContainingOrNearestScene(fling, scrolls, SCROLL_CHAIN_TOLERANCE_NS, true);
    if (!parent) continue;
    linkParentChild(parent, fling);
    parent.confidenceReasons = uniqueStrings([...(parent.confidenceReasons ?? []), 'linked:inertial_scroll']);
    fling.confidenceReasons = uniqueStrings([...(fling.confidenceReasons ?? []), 'linked:active_scroll']);
  }
}

function findContainingOrNearestScene(
  target: DisplayedScene,
  candidates: DisplayedScene[],
  toleranceNs: bigint,
  requireSameProcess = false,
): DisplayedScene | null {
  const targetStart = safeBigInt(target.startTs);
  const targetEnd = safeBigInt(target.endTs);
  if (targetStart === null || targetEnd === null) return null;

  let best: { scene: DisplayedScene; distance: bigint } | null = null;
  for (const scene of candidates) {
    if (scene.id === target.id) continue;
    if (requireSameProcess && !sameMeaningfulProcess(scene.processName, target.processName)) continue;
    const sceneStart = safeBigInt(scene.startTs);
    const sceneEnd = safeBigInt(scene.endTs);
    if (sceneStart === null || sceneEnd === null) continue;
    if (!rangesOverlapOrClose(sceneStart, sceneEnd, targetStart, targetEnd, toleranceNs)) continue;

    const distance =
      targetStart >= sceneStart && targetStart <= sceneEnd
        ? 0n
        : minBigInt(absBigInt(targetStart - sceneEnd), absBigInt(sceneStart - targetEnd));
    if (!best || distance < best.distance) {
      best = { scene, distance };
    }
  }
  return best?.scene ?? null;
}

function linkParentChild(parent: DisplayedScene, child: DisplayedScene): void {
  child.parentSceneId = parent.id;
  parent.childSceneIds = uniqueStrings([...(parent.childSceneIds ?? []), child.id]);
}

function finalizeSceneContracts(scenes: DisplayedScene[]): void {
  for (const scene of scenes) {
    scene.sceneRole ??= defaultSceneRole(scene);
    scene.analysisEligible ??= scene.sceneRole === 'action';
    scene.evidenceRefs = mergeEvidenceRefs(scene.evidenceRefs, [evidenceRefForScene(scene, 'primary')]);
    scene.conflicts = dedupeConflicts(scene.conflicts ?? []);

    const score = computeConfidenceScore(scene);
    scene.confidenceScore = score;
    scene.confidenceLevel = confidenceLevelForScore(score);
    scene.confidenceReasons = uniqueStrings(scene.confidenceReasons ?? []);
  }
}

function computeConfidenceScore(scene: DisplayedScene): number {
  const sourceBase = baseConfidenceForSource(scene.sourceStepId);
  const metadataScore = confidenceScoreFromMetadata(scene.metadata?.confidence);
  const conflictPenalty = Math.min(0.25, (scene.conflicts ?? []).length * 0.08);
  const rolePenalty = scene.sceneRole === 'marker' ? 0.08 : scene.sceneRole === 'context' ? 0.05 : 0;
  // Derived rows/context may repeat the same input. Their count is not
  // independent corroboration, and a source default must not raise a low score.
  const raw = Math.min(sourceBase, metadataScore ?? sourceBase) - conflictPenalty - rolePenalty;
  return Math.max(0, Math.min(0.95, Number(raw.toFixed(2))));
}

function baseConfidenceForSource(sourceStepId: string): number {
  if (sourceStepId === 'app_launches') return 0.9;
  if (sourceStepId === 'user_gestures') return 0.78;
  if (sourceStepId === 'inertial_scrolls') return 0.76;
  if (sourceStepId === 'scroll_initiation') return 0.64;
  if (sourceStepId === 'system_events') return 0.72;
  if (sourceStepId === 'screen_state_changes') return 0.78;
  if (sourceStepId === 'top_app_changes') return 0.72;
  if (sourceStepId === 'idle_periods') return 0.62;
  if (sourceStepId === 'clean_timeline') return 0.68;
  if (sourceStepId === 'jank_events') return 0.58;
  return 0.7;
}

function confidenceScoreFromMetadata(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1) return Math.min(0.95, value / 100);
    return Math.max(0, Math.min(0.95, value));
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === '高' || text === 'high') return 0.86;
  if (text === '中' || text === 'medium') return 0.74;
  if (text === '低' || text === 'low') return 0.58;
  return null;
}

function confidenceLevelForScore(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.82) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

function defaultSceneRole(scene: DisplayedScene): 'action' | 'marker' | 'context' {
  return defaultSceneRoleForType(scene.sceneType);
}

function defaultSceneRoleForType(sceneType: string): 'action' | 'marker' | 'context' {
  if (sceneType === 'scroll_start') return 'marker';
  if (sceneType === 'app_foreground' || sceneType === 'home_screen' || sceneType === 'idle') {
    return 'context';
  }
  return 'action';
}

function defaultProcessNameForSceneType(sceneType: string): string {
  if (
    sceneType === 'screen_unlock'
    || sceneType === 'notification'
    || sceneType === 'split_screen'
    || sceneType === 'pip'
    || sceneType === 'screen_on'
    || sceneType === 'screen_off'
    || sceneType === 'screen_sleep'
    || sceneType === 'ime_show'
    || sceneType === 'ime_hide'
    || sceneType === 'window_transition'
  ) {
    return 'system';
  }
  return 'unknown';
}

function evidenceRefForScene(
  scene: DisplayedScene,
  role: SceneEvidenceRef['role'],
): SceneEvidenceRef {
  return {
    sourceStepId: scene.sourceStepId,
    role,
    rowSelector: {
      ts: scene.startTs,
      sceneType: scene.sceneType,
    },
  };
}

function evidenceRefForRow(
  sourceStepId: string,
  row: Record<string, any>,
  rowIndex: number,
  role: SceneEvidenceRef['role'],
): SceneEvidenceRef {
  const ref: SceneEvidenceRef = {
    sourceStepId,
    rowIndex,
    role,
  };
  const eventId = String(row.event_id ?? '').trim();
  if (eventId) ref.eventId = eventId;
  const selector: Record<string, string | number | boolean> = {};
  if (row.ts !== undefined && row.ts !== null) selector.ts = String(row.ts);
  const eventType = row.event_type ?? row.gesture_type ?? row.key_name ?? row.ime_action;
  if (eventType !== undefined && eventType !== null) selector.eventType = String(eventType);
  if (Object.keys(selector).length > 0) ref.rowSelector = selector;
  return ref;
}

function evidenceRefForContext(
  sourceStepId: string,
  row: Record<string, unknown>,
): SceneEvidenceRef {
  const selector: Record<string, string | number | boolean> = {};
  if (row.ts !== undefined && row.ts !== null) selector.ts = String(row.ts);
  if (row.event !== undefined && row.event !== null) selector.event = String(row.event);
  if (row.category !== undefined && row.category !== null) selector.category = String(row.category);
  return {
    sourceStepId,
    role: 'context',
    ...(Object.keys(selector).length > 0 ? { rowSelector: selector } : {}),
  };
}

function mergeEvidenceRefs(
  existing: SceneEvidenceRef[] | undefined,
  next: SceneEvidenceRef[],
): SceneEvidenceRef[] {
  const merged = [...(existing ?? [])];
  for (const ref of next) {
    const key = evidenceRefKey(ref);
    if (merged.some(item => evidenceRefKey(item) === key)) continue;
    merged.push(ref);
  }
  return merged;
}

function evidenceRefKey(ref: SceneEvidenceRef): string {
  const selector = ref.rowSelector ? JSON.stringify(ref.rowSelector) : '';
  return `${ref.sourceStepId}:${ref.eventId ?? ''}:${ref.rowIndex ?? ''}:${ref.role ?? ''}:${selector}`;
}

function dedupeConflicts(conflicts: SceneConflict[]): SceneConflict[] {
  const seen = new Set<string>();
  const result: SceneConflict[] = [];
  for (const conflict of conflicts) {
    const key = `${conflict.type}:${conflict.severity}:${conflict.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(conflict);
  }
  return result;
}

function getRows(
  rowsByStep: Map<string, Array<Record<string, any>>>,
  stepId: string,
): Array<Record<string, any>> {
  return rowsByStep.get(stepId) ?? [];
}

function compactContextRow(row: Record<string, any>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const key of [
    'event_id',
    'time_offset',
    'ts',
    'dur',
    'dur_ms',
    'event_type',
    'event',
    'category',
    'priority',
    'app_package',
    'activity_name',
    'lifecycle_event',
    'oom_adj',
    'state_label',
    'value',
  ]) {
    if (row[key] !== undefined && row[key] !== null) compact[key] = row[key];
  }
  return compact;
}

function appendBoundedContext(
  existing: Array<Record<string, unknown>> | undefined,
  next: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rows = [...(existing ?? [])];
  const key = JSON.stringify(next);
  if (!rows.some(row => JSON.stringify(row) === key)) rows.push(next);
  return rows.slice(0, MAX_CONTEXT_ROWS_PER_GROUP);
}

function rangesOverlapOrClose(
  aStart: bigint,
  aEnd: bigint,
  bStart: bigint,
  bEnd: bigint,
  toleranceNs: bigint,
): boolean {
  if (aEnd + toleranceNs < bStart) return false;
  if (bEnd + toleranceNs < aStart) return false;
  return true;
}

function sameMeaningfulProcess(left?: string, right?: any): boolean {
  const l = String(left ?? '').trim();
  const r = String(right ?? '').trim();
  if (!isMeaningfulProcess(l) || !isMeaningfulProcess(r)) return false;
  return l === r;
}

function isMeaningfulProcess(value?: string): value is string {
  const text = String(value ?? '').trim();
  return !!text && text !== 'unknown' && text !== 'system';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
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
    const frames = numericOrUndefined(row.frame_count);
    const janks = numericOrUndefined(row.jank_frames);
    if (frames !== undefined && frames > 0 && janks !== undefined && janks > 0 && janks <= frames) return 'bad';
    const avgFps = numericOrUndefined(row.averageFps ?? row.average_fps);
    if (avgFps !== undefined && avgFps < threshold.fps) return 'bad';
    return row.frame_coverage_complete === 1 && frames !== undefined && frames > 0 && janks === 0
      ? 'good' : 'unknown';
  }
  if (threshold.fps != null) return 'unknown';
  return 'good';
}

function displayNameOf(sceneType: string): string {
  return displaySceneType(sceneType, 'zh-CN');
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/**
 * Convert columnar payload ({ columns, rows }) or array-of-objects to
 * a normalized array of row objects.
 *
 * Handles three formats:
 * 1. Already an array of objects → passthrough
 * 2. { columns: string[], rows: any[][] } → zip into objects
 * 3. Anything else → empty array
 */
function payloadToObjectRows(payload: any): Array<Record<string, any>> {
  if (!payload) return [];

  // Already array of objects
  if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === 'object' && !Array.isArray(payload[0])) {
    return payload as Array<Record<string, any>>;
  }

  // Columnar format
  const columns: string[] | undefined = payload.columns;
  const rows: any[][] | undefined = payload.rows;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return [];

  return rows.map((row) => rowObject(columns, row));
}

// ---------------------------------------------------------------------------
// Numeric / BigInt helpers
// ---------------------------------------------------------------------------

function nsToMs(ns: string): number {
  try {
    const value = BigInt(ns);
    return Number(value / 1_000_000n) + Number(value % 1_000_000n) / 1_000_000;
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
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    try {
      return BigInt(value);
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
  if (value === null || value === undefined || value === '') return undefined;
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
