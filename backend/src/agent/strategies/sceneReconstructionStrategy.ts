/**
 * Scene Reconstruction Strategy
 *
 * A multi-stage strategy for analyzing traces by first detecting what happened
 * (scene reconstruction) and then focusing analysis on problem scenes.
 *
 * Triggered by overview-type queries like:
 * - "发生了什么" / "有什么问题" / "概览" / "整体分析"
 * - "what happened" / "overview" / "analyze the trace"
 *
 * Stages:
 * 1. Scene Detection: Identify user operation scenes (startups, scrolls, taps, etc.)
 * 2. Problem Scene Analysis: Deep dive into scenes with performance issues
 */

import { AgentResponse } from '../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StageDefinition,
  FocusInterval,
  IntervalHelpers,
  StageTaskTemplate,
} from './types';
import {
  getSceneReconstructionRoutes,
  matchesSceneReconstructionRoute,
  type SceneReconstructionRouteRule,
} from '../config/domainManifest';

// =============================================================================
// Scene Types (matches backend SceneCategory)
// =============================================================================

type SceneCategory =
  | 'cold_start'
  | 'warm_start'
  | 'hot_start'
  | 'scroll'
  | 'inertial_scroll'
  | 'navigation'
  | 'app_switch'
  | 'tap'
  | 'long_press'
  | 'idle'
  | 'jank_region';  // Fallback: performance issue regions

// Performance thresholds for determining "problem" scenes
const PROBLEM_THRESHOLDS: Record<string, { durationMs?: number; fps?: number }> = {
  cold_start: { durationMs: 1000 },
  warm_start: { durationMs: 600 },
  hot_start: { durationMs: 200 },
  scroll: { fps: 50 },
  inertial_scroll: { fps: 50 },
  tap: { durationMs: 200 },
  long_press: { durationMs: 500 },
  navigation: { durationMs: 500 },
};

// =============================================================================
// Trigger
// =============================================================================

/**
 * Determines if this is an overview/scene reconstruction query.
 */
function isOverviewQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    // Chinese overview queries
    q.includes('发生了什么') ||
    q.includes('有什么问题') ||
    q.includes('概览') ||
    q.includes('整体分析') ||
    q.includes('整体') && q.includes('分析') ||
    q.includes('场景还原') ||
    q.includes('场景分析') ||
    // English overview queries
    q.includes('what happened') ||
    q.includes('overview') ||
    q.includes('analyze the trace') ||
    q.includes('what is in') && q.includes('trace') ||
    q.includes('scene reconstruction') ||
    // Generic analysis without specific domain
    (q.includes('分析') && !q.includes('滑动') && !q.includes('启动') && !q.includes('内存') && !q.includes('cpu'))
  );
}

function isQuickOverviewQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    isOverviewQuery(query) &&
    (q.includes('仅检测') || q.includes('只检测') || q.includes('quick'))
  );
}

// =============================================================================
// Stage 1: Scene Detection
// =============================================================================

/**
 * Extract scenes from the scene detection response and convert to FocusIntervals.
 * Prioritizes scenes with performance issues.
 */
function extractScenesAsIntervals(
  responses: AgentResponse[],
  helpers: IntervalHelpers
): FocusInterval[] {
  const intervals: FocusInterval[] = [];
  const jankRowsForFallback: Array<Record<string, any>> = [];
  let hasGestureLikeInterval = false;

  for (const resp of responses) {
    if (!resp.success) continue;

    for (const toolResult of resp.toolResults || []) {
      const envelopes = (toolResult.dataEnvelopes || [])
        .filter((e: any) => e?.meta?.skillId === 'scene_reconstruction');

      for (const env of envelopes) {
        const stepId = env.meta?.stepId;
        const rows = helpers.payloadToObjectRows(env.data);
        if (!Array.isArray(rows) || rows.length === 0) continue;

        // From scene_reconstruction.skill.yaml:
        // - app_launches: ts, dur, startup_type, package
        // - user_gestures: ts, dur, gesture_type, event (may contain [app])
        // - top_app_changes: ts, dur, app_package
        if (stepId === 'app_launches') {
          for (const row of rows) {
            const startTs = String(row.ts || '');
            const dur = String(row.dur || '');
            if (!startTs || !dur) continue;

            const endTs = safeAddNs(startTs, dur);
            if (!endTs) continue;

            const startupType = String(row.startup_type || '').toLowerCase();
            const sceneType =
              startupType === 'warm' ? 'warm_start'
              : startupType === 'hot' ? 'hot_start'
              : 'cold_start';

            const durationMs = nsToMs(dur);
            const priority = computeScenePriority(sceneType, durationMs, row);
            const startupId = Number(row.startup_id || row.startupId || intervals.length + 1);
            const normalizedStartupId = Number.isFinite(startupId) && startupId > 0
              ? startupId
              : intervals.length + 1;
            const ttidMs = Number(row.ttid_ms || row.ttidMs);
            const ttfdMs = Number(row.ttfd_ms || row.ttfdMs);

            intervals.push({
              id: intervals.length,
              processName: String(row.package || '') || 'unknown',
              startTs,
              endTs,
              priority,
              label: `${getSceneDisplayName(sceneType)} (${durationMs}ms)`,
              metadata: {
                sceneType,
                durationMs,
                startupId: normalizedStartupId,
                startup_id: normalizedStartupId,
                startupType: startupType || undefined,
                startup_type: startupType || undefined,
                ttidMs: Number.isFinite(ttidMs) ? ttidMs : undefined,
                ttid_ms: Number.isFinite(ttidMs) ? ttidMs : undefined,
                ttfdMs: Number.isFinite(ttfdMs) ? ttfdMs : undefined,
                ttfd_ms: Number.isFinite(ttfdMs) ? ttfdMs : undefined,
                sourceStepId: stepId,
              },
            });
          }
        } else if (stepId === 'user_gestures') {
          for (const row of rows) {
            const startTs = String(row.ts || '');
            const dur = String(row.dur || '');
            if (!startTs || !dur) continue;

            const endTs = safeAddNs(startTs, dur);
            if (!endTs) continue;

            const gestureType = String(row.gesture_type || '').toLowerCase();
            const sceneType =
              gestureType === 'scroll' ? 'scroll'
              : gestureType === 'long_press' ? 'long_press'
              : 'tap';

            const durationMs = nsToMs(dur);
            const priority = computeScenePriority(sceneType, durationMs, row);

            const processName = resolveSceneProcessName(row);

            intervals.push({
              id: intervals.length,
              processName,
              startTs,
              endTs,
              priority,
              label: `${getSceneDisplayName(sceneType)} (${durationMs}ms)`,
              metadata: {
                sceneType,
                durationMs,
                confidence: row.confidence,
                moveCount: row.move_count,
                sourceStepId: stepId,
              },
            });
            hasGestureLikeInterval = true;
          }
        } else if (stepId === 'inertial_scrolls') {
          for (const row of rows) {
            const startTs = String(row.ts || '');
            const dur = String(row.dur || '');
            if (!startTs || !dur) continue;

            const endTs = safeAddNs(startTs, dur);
            if (!endTs) continue;

            const durationMs = nsToMs(dur);
            const sceneType: SceneCategory = 'inertial_scroll';
            const priority = computeScenePriority(sceneType, durationMs, row);

            intervals.push({
              id: intervals.length,
              processName: resolveSceneProcessName(row),
              startTs,
              endTs,
              priority,
              label: `${getSceneDisplayName(sceneType)} (${durationMs}ms)`,
              metadata: {
                sceneType,
                durationMs,
                frameCount: row.frame_count,
                jankFrames: row.jank_frames,
                sourceStepId: stepId,
              },
            });
            hasGestureLikeInterval = true;
          }
        } else if (stepId === 'idle_periods') {
          for (const row of rows) {
            const startTs = String(row.ts || '');
            const dur = String(row.dur || '');
            if (!startTs || !dur) continue;

            const endTs = safeAddNs(startTs, dur);
            if (!endTs) continue;

            const durationMs = nsToMs(dur);
            const sceneType: SceneCategory = 'idle';
            const priority = computeScenePriority(sceneType, durationMs, row);

            intervals.push({
              id: intervals.length,
              processName: 'system',
              startTs,
              endTs,
              priority,
              label: `${getSceneDisplayName(sceneType)} (${durationMs}ms)`,
              metadata: {
                sceneType,
                durationMs,
                confidence: row.confidence,
                sourceStepId: stepId,
              },
            });
          }
        } else if (stepId === 'top_app_changes') {
          for (const row of rows) {
            const startTs = String(row.ts || '');
            const dur = String(row.dur || '');
            if (!startTs || !dur) continue;

            const endTs = safeAddNs(startTs, dur);
            if (!endTs) continue;

            const sceneType = 'app_switch';
            const durationMs = nsToMs(dur);
            const priority = computeScenePriority(sceneType, durationMs, row);

            intervals.push({
              id: intervals.length,
              processName: String(row.app_package || '') || 'unknown',
              startTs,
              endTs,
              priority,
              label: `${getSceneDisplayName(sceneType)} (${durationMs}ms)`,
              metadata: {
                sceneType,
                durationMs,
                sourceStepId: stepId,
              },
            });
          }
        } else if (stepId === 'jank_events') {
          jankRowsForFallback.push(...rows);
        }
      }
    }
  }

  // ===================================================================
  // FALLBACK: jank_events
  // Only used when no gesture-like scene (tap/scroll/long_press/inertial)
  // is detected.
  // ===================================================================
  if (!hasGestureLikeInterval && jankRowsForFallback.length > 0) {
    const jankIntervals = aggregateJankFramesToIntervals(jankRowsForFallback);
    for (const interval of jankIntervals) {
      if (interval.jankCount >= 3) {
        intervals.push({
          id: intervals.length,
          processName: 'jank_region',
          startTs: interval.startTs,
          endTs: interval.endTs,
          priority: interval.severity === 'severe' ? 75 : 60,
          label: `${getSceneDisplayName('jank_region')} (${interval.jankCount} 帧掉帧)`,
          metadata: {
            sceneType: 'jank_region',
            jankCount: interval.jankCount,
            severity: interval.severity,
            durationMs: interval.durationMs,
            sourceStepId: 'jank_events',
          },
        });
      }
    }
  }

  // Sort by priority (higher first)
  intervals.sort((a, b) => b.priority - a.priority);

  // Guardrail: scene reconstruction can detect many gestures; only deep dive the top N.
  return intervals.slice(0, 5);
}

// =============================================================================
// Jank Frame Aggregation Helper
// =============================================================================

interface JankInterval {
  startTs: string;
  endTs: string;
  durationMs: number;
  jankCount: number;
  severity: 'severe' | 'mild';
}

/**
 * Aggregates consecutive jank frames into intervals.
 * Adjacent jank frames within 500ms gap are merged into one interval.
 * This creates meaningful analysis targets from scattered jank events.
 */
function aggregateJankFramesToIntervals(rows: Array<Record<string, any>>): JankInterval[] {
  if (!rows.length) return [];

  const MERGE_GAP_NS = 500_000_000n; // 500ms
  const intervals: JankInterval[] = [];

  // Sort by timestamp first
  const sortedRows = [...rows].sort((a, b) => {
    const aTs = safeBigInt(a.ts);
    const bTs = safeBigInt(b.ts);
    if (aTs === null || bTs === null) return 0;
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  let currentStart = safeBigInt(sortedRows[0].ts);
  let currentEnd = currentStart !== null
    ? currentStart + (safeBigInt(sortedRows[0].dur) || 0n)
    : null;
  let jankCount = 1;
  let severities: string[] = [String(sortedRows[0].jank_severity_type || '')];

  if (currentStart === null || currentEnd === null) {
    return []; // Invalid first row
  }

  for (let i = 1; i < sortedRows.length; i++) {
    const rowTs = safeBigInt(sortedRows[i].ts);
    const rowDur = safeBigInt(sortedRows[i].dur) || 0n;

    if (rowTs === null) continue;

    if (rowTs - currentEnd! < MERGE_GAP_NS) {
      // Merge into current interval
      const rowEnd = rowTs + rowDur;
      if (rowEnd > currentEnd!) {
        currentEnd = rowEnd;
      }
      jankCount++;
      severities.push(String(sortedRows[i].jank_severity_type || ''));
    } else {
      // Save current interval and start a new one
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
      severities = [String(sortedRows[i].jank_severity_type || '')];
    }
  }

  // Save the last interval
  intervals.push({
    startTs: currentStart!.toString(),
    endTs: currentEnd!.toString(),
    durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
    jankCount,
    severity: severities.includes('Full') ? 'severe' : 'mild',
  });

  return intervals;
}

/**
 * Safe conversion to bigint
 */
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

function getSceneDisplayName(type: string): string {
  const names: Record<string, string> = {
    cold_start: '冷启动',
    warm_start: '温启动',
    hot_start: '热启动',
    scroll: '滑动',
    inertial_scroll: '惯性滑动',
    navigation: '跳转',
    app_switch: '应用切换',
    tap: '点击',
    long_press: '长按',
    idle: '空闲',
    jank_region: '性能问题区间',
  };
  return names[type] || type;
}

function nsToMs(ns: string): number {
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return 0;
  }
}

function safeAddNs(startTs: string, durNs: string): string | null {
  try {
    return (BigInt(startTs) + BigInt(durNs)).toString();
  } catch {
    return null;
  }
}

function extractBracketAppName(eventText: string): string | null {
  const m = eventText.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : null;
}

function resolveSceneProcessName(row: Record<string, any>): string {
  const appPackage = String(row.app_package || '').trim();
  if (appPackage) return appPackage;

  const eventApp = extractBracketAppName(String(row.event || ''));
  if (eventApp) return eventApp;

  return 'unknown';
}

function computeScenePriority(sceneType: string, durationMs: number, row: any): number {
  let priority = 50;
  const thresholds = PROBLEM_THRESHOLDS[sceneType];
  if (thresholds?.durationMs && durationMs > thresholds.durationMs) {
    priority = 90;
  }
  // Placeholder: fps thresholds may be present if upstream detection adds averageFps
  if (thresholds?.fps && row?.averageFps && Number(row.averageFps) < thresholds.fps) {
    priority = 90;
  }
  return priority;
}

function isStartupSceneInterval(interval: FocusInterval): boolean {
  const sceneType = String(interval.metadata?.sceneType || '').toLowerCase();
  return sceneType === 'cold_start' || sceneType === 'warm_start' || sceneType === 'hot_start';
}

function createRouteDrivenTaskTemplate(route: SceneReconstructionRouteRule): StageTaskTemplate {
  return {
    agentId: route.agentId,
    domain: route.domain,
    scope: 'per_interval',
    priority: route.priority ?? 1,
    executionMode: 'direct_skill',
    directSkillId: route.directSkillId,
    intervalFilter: (interval) => {
      const sceneType = String(interval.metadata?.sceneType || '');
      return matchesSceneReconstructionRoute(sceneType, route);
    },
    paramMapping: { ...(route.paramMapping || {}) },
    ...(route.skillParams ? { skillParams: route.skillParams } : {}),
    descriptionTemplate: route.descriptionTemplate || '分析场景: {{scopeLabel}}',
  };
}

function buildLegacySceneAnalysisTasks(): StageTaskTemplate[] {
  return [
    {
      agentId: 'startup_agent',
      domain: 'startup',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'startup_detail',
      intervalFilter: isStartupSceneInterval,
      paramMapping: {
        startup_id: 'startupId',
        start_ts: 'startTs',
        end_ts: 'endTs',
        dur_ms: 'durationMs',
        package: 'processName',
        startup_type: 'startupType',
        ttid_ms: 'ttidMs',
        ttfd_ms: 'ttfdMs',
      },
      descriptionTemplate: '分析启动场景: {{scopeLabel}}',
    },
    {
      agentId: 'frame_agent',
      domain: 'scroll',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'scrolling_analysis',
      intervalFilter: (interval) => !isStartupSceneInterval(interval),
      paramMapping: {
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
      },
      skillParams: {
        enable_frame_details: false,
      },
      descriptionTemplate: '分析帧性能: {{scopeLabel}}',
    },
  ];
}

function buildSceneAnalysisTasksFromManifest(): StageTaskTemplate[] {
  const routes = getSceneReconstructionRoutes();
  const tasks = routes
    .filter(route => (
      route
      && route.agentId
      && route.domain
      && route.directSkillId
      && typeof route.descriptionTemplate === 'string'
      && route.paramMapping
      && typeof route.paramMapping === 'object'
    ))
    .map(route => createRouteDrivenTaskTemplate(route));

  if (tasks.length > 0) return tasks;
  return buildLegacySceneAnalysisTasks();
}

// =============================================================================
// Stage Definitions
// =============================================================================

const stage1_sceneDetectionOnly: StageDefinition = {
  name: 'scene_detection',
  description: '检测 Trace 中的用户操作场景',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}: 场景检测',
  tasks: [
    {
      agentId: 'frame_agent',
      domain: 'scene',
      scope: 'global',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'scene_reconstruction',
      descriptionTemplate: '检测用户操作场景（启动、滑动、点击等）',
    },
  ],
};

const stage1_sceneDetection: StageDefinition = {
  name: 'scene_detection',
  description: '检测 Trace 中的用户操作场景',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}: 场景检测',
  tasks: [
    {
      agentId: 'frame_agent',
      domain: 'scene',
      scope: 'global',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'scene_reconstruction',
      descriptionTemplate: '检测用户操作场景（启动、滑动、点击等）',
    },
  ],
  extractIntervals: extractScenesAsIntervals,
  shouldStop: (intervals) => {
    if (intervals.length === 0) {
      return {
        stop: true,
        reason: '未检测到用户操作场景，无法进行深入分析',
      };
    }
    return { stop: false, reason: '' };
  },
};

const stage2_problemSceneAnalysis: StageDefinition = {
  name: 'problem_scene_analysis',
  description: '分析性能问题场景',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}: 分析问题场景',
  tasks: buildSceneAnalysisTasksFromManifest(),
};

// =============================================================================
// Strategy Export
// =============================================================================

export const sceneReconstructionQuickStrategy: StagedAnalysisStrategy = {
  id: 'scene_reconstruction_quick',
  name: '场景还原（仅检测）',
  trigger: isQuickOverviewQuery,
  stages: [stage1_sceneDetectionOnly],
};

export const sceneReconstructionStrategy: StagedAnalysisStrategy = {
  id: 'scene_reconstruction',
  name: '场景还原分析',
  trigger: isOverviewQuery,
  stages: [stage1_sceneDetection, stage2_problemSceneAnalysis],
  defaults: {
    maxScenesPerStage: 5,
    priorityThreshold: 50,
  },
};
