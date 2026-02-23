/**
 * Scrolling/Jank Analysis Strategy
 *
 * A 3-stage deterministic pipeline for analyzing scrolling performance issues:
 * 1. Overview: Locate jank intervals and jank frames (FPS, drop rate, frame list)
 * 2. Session Overview: Lightweight session stats + extract per-frame intervals
 * 3. Frame Analysis: Per-jank-frame deep dive (CPU/Binder/Rendering per frame)
 *
 * Key architectural decision: detailed metrics (CPU核心分布, 频率, Binder调用等)
 * run at FRAME level (each ~16-33ms), not session level (2-3s).
 * Session-level overview only shows aggregate stats (帧率, 掉帧数, 大小核占比).
 *
 * This strategy is triggered by queries mentioning scrolling, jank, frame drops,
 * stutter, FPS, or related Chinese terms.
 */

import { AgentResponse } from '../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StageDefinition,
  FocusInterval,
  IntervalHelpers,
} from './types';
import { unwrapStepResult } from './helpers';
import {
  inferVsyncPeriodNs,
  DEFAULT_VSYNC_PERIODS_FOR_FRAME_ESTIMATION,
  DEFAULT_CLUSTERING_MAX_FRAMES_PER_SESSION,
} from '../../config/thresholds';

// =============================================================================
// Internal Types
// =============================================================================

interface RawInterval {
  sessionId: number;
  processName: string;
  startTs: string;
  endTs: string;
  jankFrameCount: number;
  maxVsyncMissed: number;
}

interface RawFrame {
  frameId: number;
  sessionId: number;
  processName: string;
  startTs: string;
  endTs: string;
  vsyncMissed: number;
  // Extended fields for jank_frame_detail skill
  mainStartTs: string;
  mainEndTs: string;
  renderStartTs: string;
  renderEndTs: string;
  durMs: number;
  jankType: string;
  layerName: string;
  pid: number;
  tokenGap: number;
  jankResponsibility: string;
  frameIndex: number;
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasValidTimeRange(startTs: string, endTs: string): boolean {
  if (!startTs || !endTs || startTs === '0' || endTs === '0') {
    return false;
  }

  try {
    return BigInt(endTs) > BigInt(startTs);
  } catch {
    return false;
  }
}

function resolveFrameEndTs(startTs: string, endTs: string, durMs: number): string | undefined {
  if (hasValidTimeRange(startTs, endTs)) {
    return endTs;
  }

  try {
    if (durMs > 0) {
      return String(BigInt(startTs) + BigInt(Math.round(durMs * 1e6)));
    }

    // Fallback: use configurable vsync period × default multiplier
    const vsyncPeriodNs = inferVsyncPeriodNs();
    const estimatedDuration = vsyncPeriodNs * BigInt(DEFAULT_VSYNC_PERIODS_FOR_FRAME_ESTIMATION);
    return String(BigInt(startTs) + estimatedDuration);
  } catch {
    return undefined;
  }
}

// =============================================================================
// Trigger
// =============================================================================

function isScrollingOrJankQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    q.includes('滑动') ||
    q.includes('scroll') ||
    q.includes('jank') ||
    q.includes('掉帧') ||
    q.includes('丢帧') ||
    q.includes('卡顿') ||
    q.includes('stutter') ||
    q.includes('fps')
  );
}

// =============================================================================
// Interval Extraction: Session Level (Stage 0 → Stage 1)
// =============================================================================

/**
 * Extract session-level focus intervals from overview stage responses.
 * Parses scroll_sessions and get_app_jank_frames data to identify
 * the most problematic scrolling sessions.
 */
function extractScrollingIntervals(
  responses: AgentResponse[],
  helpers: IntervalHelpers
): FocusInterval[] {
  const frameResponses = responses.filter(
    r => r.agentId === 'frame_agent' && r.toolResults && r.toolResults.length > 0
  );

  const scrollSessions: Array<Record<string, any>> = [];
  const sessionJankList: Array<Record<string, any>> = [];

  for (const resp of frameResponses) {
    for (const toolResult of resp.toolResults || []) {
      const data = toolResult.data as any;
      if (!data || typeof data !== 'object') continue;

      if (data.scroll_sessions) {
        scrollSessions.push(...helpers.payloadToObjectRows(unwrapStepResult(data.scroll_sessions)));
      }
      if (data.session_jank) {
        sessionJankList.push(...helpers.payloadToObjectRows(unwrapStepResult(data.session_jank)));
      }
    }
  }

  if (scrollSessions.length === 0) return [];

  // Index session jank stats by session_id
  const jankBySessionId = new Map<number, Record<string, any>>();
  for (const sj of sessionJankList) {
    jankBySessionId.set(toFiniteNumber(sj.session_id), sj);
  }

  const rawIntervals: RawInterval[] = [];
  for (const session of scrollSessions) {
    const processName = String(session.process_name ?? '');
    if (!helpers.isLikelyAppProcessName(processName)) continue;

    const sessionId = toFiniteNumber(session.session_id);
    const startTs = String(session.start_ts ?? '');
    const endTs = String(session.end_ts ?? '');
    if (!hasValidTimeRange(startTs, endTs)) {
      continue;
    }

    // Get jank stats from session_jank step
    const jankInfo = jankBySessionId.get(sessionId);
    const jankFrameCount = toFiniteNumber(jankInfo?.janky_count ?? 0);
    const maxVsyncMissed = toFiniteNumber(jankInfo?.max_vsync_missed ?? 0);

    // Only include sessions that have jank
    if (jankFrameCount === 0) continue;

    rawIntervals.push({
      sessionId,
      processName,
      startTs,
      endTs,
      jankFrameCount,
      maxVsyncMissed,
    });
  }

  // Sort by severity: maxVsyncMissed > jankFrameCount > duration
  rawIntervals.sort((a, b) => {
    if (b.maxVsyncMissed !== a.maxVsyncMissed) return b.maxVsyncMissed - a.maxVsyncMissed;
    if (b.jankFrameCount !== a.jankFrameCount) return b.jankFrameCount - a.jankFrameCount;
    try {
      const durA = BigInt(a.endTs) - BigInt(a.startTs);
      const durB = BigInt(b.endTs) - BigInt(b.startTs);
      if (durB > durA) return 1;
      if (durB < durA) return -1;
    } catch { /* fallback: equal */ }
    return 0;
  });

  // Compute reference time (earliest session start) for relative labels
  let referenceNs: string | undefined;
  if (rawIntervals.length > 0) {
    try {
      referenceNs = rawIntervals.reduce((min, cur) => {
        return BigInt(cur.startTs) < BigInt(min) ? cur.startTs : min;
      }, rawIntervals[0].startTs);
    } catch { /* use absolute if BigInt fails */ }
  }

  // Every session with jank deserves analysis
  return rawIntervals.map((raw, index) => ({
    id: raw.sessionId,
    processName: raw.processName,
    startTs: raw.startTs,
    endTs: raw.endTs,
    priority: rawIntervals.length - index, // Higher priority for more severe
    label: `区间${raw.sessionId} · ${helpers.formatNsRangeLabel(raw.startTs, raw.endTs, referenceNs)}`,
    metadata: {
      jankFrameCount: raw.jankFrameCount,
      maxVsyncMissed: raw.maxVsyncMissed,
    },
  }));
}

// =============================================================================
// Interval Extraction: Frame Level (Stage 1 → Stage 2)
// =============================================================================

/**
 * Extract frame-level intervals from session overview stage responses.
 * Finds individual jank frames from frame_agent responses and creates
 * per-frame FocusIntervals for the next stage's detailed analysis.
 *
 * Each jank frame becomes a separate FocusInterval with tight time bounds,
 * so Stage 2 agents run on individual frame windows (~16-50ms).
 */
function extractFrameIntervals(
  responses: AgentResponse[],
  helpers: IntervalHelpers
): FocusInterval[] {
  const frameResponses = responses.filter(
    r => r.agentId === 'frame_agent' && r.toolResults && r.toolResults.length > 0
  );

  const rawFrames: RawFrame[] = [];

  for (const resp of frameResponses) {
    for (const toolResult of resp.toolResults || []) {
      const data = toolResult.data as any;
      if (!data || typeof data !== 'object') continue;

      // Parse jank frames from response data
      if (data.get_app_jank_frames) {
        const frames = helpers.payloadToObjectRows(unwrapStepResult(data.get_app_jank_frames));
        for (const f of frames) {
          const startTs = String(f.start_ts ?? f.ts ?? '');
          const endTs = String(f.end_ts ?? '');
          const processName = String(f.process_name ?? '');
          const frameId = toFiniteNumber(f.frame_id);
          const sessionId = toFiniteNumber(f.session_id);
          const vsyncMissed = toFiniteNumber(f.vsync_missed);

          // Extended fields for jank_frame_detail
          const mainStartTs = String(f.main_start_ts ?? '');
          const mainEndTs = String(f.main_end_ts ?? '');
          const renderStartTs = String(f.render_start_ts ?? '');
          const renderEndTs = String(f.render_end_ts ?? '');
          const durMs = toFiniteNumber(f.dur_ms);
          const jankType = String(f.jank_type ?? '');
          const layerName = String(f.layer_name ?? '');
          const pid = toFiniteNumber(f.pid);
          const tokenGap = toFiniteNumber(f.token_gap);
          const jankResponsibility = String(f.jank_responsibility ?? '');
          const frameIndex = toFiniteNumber(f.frame_index);

          if (!startTs || startTs === '0') continue;

          // If end_ts is not available/invalid, estimate from dur_ms or vsync period.
          const resolvedEndTs = resolveFrameEndTs(startTs, endTs, durMs);
          if (!resolvedEndTs || !hasValidTimeRange(startTs, resolvedEndTs)) {
            continue;
          }

          if (!helpers.isLikelyAppProcessName(processName)) continue;

          rawFrames.push({
            frameId,
            sessionId,
            processName,
            startTs,
            endTs: resolvedEndTs,
            vsyncMissed,
            mainStartTs,
            mainEndTs,
            renderStartTs,
            renderEndTs,
            durMs,
            jankType,
            layerName,
            pid,
            tokenGap,
            jankResponsibility,
            frameIndex,
          });
        }
      }
    }
  }

  if (rawFrames.length === 0) return [];

  // Sort by: sessionId ascending (区间1 before 区间2), then by startTs ascending (time order within session)
  // This ensures frames are displayed in logical order: all frames from session 1, then session 2, etc.
  rawFrames.sort((a, b) => {
    // Primary: sessionId ascending
    if (a.sessionId !== b.sessionId) {
      return a.sessionId - b.sessionId;
    }
    // Secondary: startTs ascending (chronological within session)
    try {
      const tsA = BigInt(a.startTs);
      const tsB = BigInt(b.startTs);
      if (tsA < tsB) return -1;
      if (tsA > tsB) return 1;
    } catch { /* fallback to frameIndex */ }
    // Tertiary: frameIndex ascending
    if (a.frameIndex !== undefined && b.frameIndex !== undefined) {
      return a.frameIndex - b.frameIndex;
    }
    return 0;
  });

  // Compute reference time (earliest frame start) for relative labels
  let frameReferenceNs: string | undefined;
  try {
    frameReferenceNs = rawFrames.reduce((min, cur) => {
      return BigInt(cur.startTs) < BigInt(min) ? cur.startTs : min;
    }, rawFrames[0].startTs);
  } catch { /* use absolute if BigInt fails */ }

  // Every jank frame deserves analysis to find its root cause.
  // The SQL in get_app_jank_frames already filters to only real jank frames.
  const result: FocusInterval[] = rawFrames.map(frame => {
    const timeLabel = helpers.formatNsRangeLabel(frame.startTs, frame.endTs, frameReferenceNs);
    return {
      id: frame.frameId,
      processName: frame.processName,
      startTs: frame.startTs,
      endTs: frame.endTs,
      priority: frame.vsyncMissed,
      label: `区间${frame.sessionId} · 帧${frame.frameId} · ${timeLabel}`,
      metadata: {
        sessionId: frame.sessionId,
        frameId: frame.frameId,
        vsyncMissed: frame.vsyncMissed,
        // Extended fields for jank_frame_detail paramMapping
        mainStartTs: frame.mainStartTs || undefined,
        mainEndTs: frame.mainEndTs || undefined,
        renderStartTs: frame.renderStartTs || undefined,
        renderEndTs: frame.renderEndTs || undefined,
        durMs: frame.durMs || undefined,
        jankType: frame.jankType || undefined,
        layerName: frame.layerName || undefined,
        pid: frame.pid || undefined,
        tokenGap: frame.tokenGap || undefined,
        jankResponsibility: frame.jankResponsibility || undefined,
        frameIndex: frame.frameIndex || undefined,
      },
    };
  });

  return result;
}

// =============================================================================
// Stage Definitions
// =============================================================================

const overviewStage: StageDefinition = {
  name: 'overview',
  description: 'Locate jank intervals and jank frame distribution',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：先定位掉帧区间与掉帧点',
  tasks: [
    {
      agentId: 'frame_agent',
      domain: 'frame',
      scope: 'global',
      priority: 1,
      evidenceNeeded: ['scroll sessions', 'fps', 'jank types distribution', 'session jank stats'],
      focusTools: ['analyze_scrolling'],
      skillParams: { enable_frame_details: false },
      descriptionTemplate: '阶段 1/3：先定位滑动区间与掉帧概况（输出 FPS/掉帧率/区间掉帧统计；不需要逐帧列表和逐帧详情）。',
    },
  ],
  extractIntervals: extractScrollingIntervals,
  shouldStop: (intervals) => {
    if (intervals.length === 0) {
      return { stop: true, reason: '未检测到可用于深入分析的掉帧区间' };
    }
    return { stop: false, reason: '' };
  },
};

/**
 * Stage 1: Session Overview
 *
 * Lightweight per-session analysis that produces:
 * - Session-level stats (帧率, 掉帧数)
 * - Jank frame list for each session (used by extractFrameIntervals)
 *
 * After execution, extractFrameIntervals creates per-frame FocusIntervals
 * so Stage 2 runs on individual frame windows.
 */
const sessionOverviewStage: StageDefinition = {
  name: 'session_overview',
  description: 'Lightweight session stats and frame-level interval extraction',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：区间概览并定位掉帧帧',
  tasks: [
    {
      agentId: 'frame_agent',
      domain: 'frame',
      scope: 'per_interval',
      priority: 1,
      evidenceNeeded: ['session frame rate', 'jank frame count', 'jank frame list with timestamps'],
      focusTools: ['analyze_scrolling'],
      skillParams: {
        enable_frame_details: false,
        max_frames_per_session: DEFAULT_CLUSTERING_MAX_FRAMES_PER_SESSION,
      },
      descriptionTemplate: '阶段 2/3：在 {{scopeLabel}} 内统计帧率和掉帧列表（不做逐帧详情，仅需帧的时间戳列表）。',
    },
    {
      agentId: 'system_agent',
      domain: 'system',
      scope: 'per_interval',
      priority: 3,
      executionMode: 'direct_skill',
      directSkillId: 'io_pressure',
      paramMapping: {
        package: 'processName',
        start_ts: 'startTs',
        end_ts: 'endTs',
      },
      descriptionTemplate: '阶段 2/3：补充 {{scopeLabel}} 的 IO 压力上下文',
    },
    {
      agentId: 'system_agent',
      domain: 'network',
      scope: 'per_interval',
      priority: 4,
      executionMode: 'direct_skill',
      directSkillId: 'network_analysis',
      paramMapping: {
        package: 'processName',
        start_ts: 'startTs',
        end_ts: 'endTs',
      },
      descriptionTemplate: '阶段 2/3：补充 {{scopeLabel}} 的网络活动上下文',
    },
    {
      agentId: 'system_agent',
      domain: 'thermal',
      scope: 'per_interval',
      priority: 5,
      executionMode: 'direct_skill',
      directSkillId: 'thermal_throttling',
      paramMapping: {
        package: 'processName',
        start_ts: 'startTs',
        end_ts: 'endTs',
      },
      skillParams: {
        enable_expert_probes: false,
      },
      descriptionTemplate: '阶段 2/3：补充 {{scopeLabel}} 的热节流上下文',
    },
  ],
  extractIntervals: extractFrameIntervals,
  shouldStop: (intervals) => {
    if (intervals.length === 0) {
      return { stop: true, reason: '未从区间中提取到可分析的掉帧帧' };
    }
    return { stop: false, reason: '' };
  },
};

/**
 * Stage 2: Per-Frame Analysis (Direct Skill Execution)
 *
 * Comprehensive per-frame analysis using the jank_frame_detail composite skill.
 * Covers: 四象限分析, Binder, CPU频率, 主线程/RenderThread耗时操作, 锁竞争, GC, IO阻塞, 根因分析.
 * All steps use optional: true for graceful degradation when tables are missing.
 *
 * Performance: N deterministic SQL executions per frame (0 LLM calls).
 * For 63 frames: ~15-30 seconds total (pure SQL + rule evaluation).
 */
const frameAnalysisStage: StageDefinition = {
  name: 'frame_analysis',
  description: 'Per-jank-frame deep dive via direct skill execution (quadrant/Binder/CPU/slices/GC/IO)',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：逐帧分析（四象限/Binder/CPU/锁/GC/IO）',
  tasks: [
    {
      agentId: 'frame_agent',   // Attribution only — no actual agent dispatch
      domain: 'frame',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'jank_frame_detail',
      paramMapping: {
        // Known sources (resolved via switch-case in DirectSkillExecutor)
        start_ts: 'startTs',
        end_ts: 'endTs',
        package: 'processName',
        // Metadata sources (resolved via interval.metadata[key] fallback)
        frame_id: 'frameId',
        jank_type: 'jankType',
        dur_ms: 'durMs',
        main_start_ts: 'mainStartTs',
        main_end_ts: 'mainEndTs',
        render_start_ts: 'renderStartTs',
        render_end_ts: 'renderEndTs',
        pid: 'pid',
        session_id: 'sessionId',
        layer_name: 'layerName',
        token_gap: 'tokenGap',
        vsync_missed: 'vsyncMissed',
        jank_responsibility: 'jankResponsibility',
        frame_index: 'frameIndex',
      },
      descriptionTemplate: '逐帧综合分析：{{scopeLabel}}',
    },
  ],
};

// =============================================================================
// Strategy Export
// =============================================================================

export const scrollingStrategy: StagedAnalysisStrategy = {
  id: 'scrolling',
  name: 'Scrolling/Jank Analysis',
  trigger: isScrollingOrJankQuery,
  stages: [overviewStage, sessionOverviewStage, frameAnalysisStage],
};
