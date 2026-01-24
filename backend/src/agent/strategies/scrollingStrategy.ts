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
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
        scrollSessions.push(...helpers.payloadToObjectRows(data.scroll_sessions));
      }
      if (data.session_jank) {
        sessionJankList.push(...helpers.payloadToObjectRows(data.session_jank));
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
    if (!startTs || !endTs || startTs === '0' || endTs === '0') continue;

    try {
      if (BigInt(endTs) <= BigInt(startTs)) continue;
    } catch {
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
        const frames = helpers.payloadToObjectRows(data.get_app_jank_frames);
        for (const f of frames) {
          const startTs = String(f.start_ts ?? f.ts ?? '');
          const endTs = String(f.end_ts ?? '');
          const processName = String(f.process_name ?? '');
          const frameId = toFiniteNumber(f.frame_id);
          const sessionId = toFiniteNumber(f.session_id);
          const vsyncMissed = toFiniteNumber(f.vsync_missed);

          if (!startTs || startTs === '0') continue;

          // If end_ts is not available, estimate from dur_ms or use start_ts + 2*vsync_period
          let resolvedEndTs = endTs;
          if (!resolvedEndTs || resolvedEndTs === '0') {
            const durMs = toFiniteNumber(f.dur_ms);
            if (durMs > 0) {
              try {
                resolvedEndTs = String(BigInt(startTs) + BigInt(Math.round(durMs * 1e6)));
              } catch {
                continue;
              }
            } else {
              // Fallback: assume ~33ms (2 vsync at 60Hz)
              try {
                resolvedEndTs = String(BigInt(startTs) + 33000000n);
              } catch {
                continue;
              }
            }
          }

          // Validate timestamps
          try {
            if (BigInt(resolvedEndTs) <= BigInt(startTs)) continue;
          } catch {
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
          });
        }
      }
    }
  }

  if (rawFrames.length === 0) return [];

  // Sort by severity: vsyncMissed descending
  rawFrames.sort((a, b) => b.vsyncMissed - a.vsyncMissed);

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
      skillParams: { enable_frame_details: false },
      descriptionTemplate: '阶段 2/3：在 {{scopeLabel}} 内统计帧率和掉帧列表（不做逐帧详情，仅需帧的时间戳列表）。',
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
 * Detailed analysis on each individual jank frame using the janky_frame_analysis
 * composite skill. This skill internally parallelizes CPU + scheduling + binder
 * analysis, then applies rule-based diagnostics (ai_assist disabled to avoid N×LLM overhead).
 *
 * Performance: Was 3 agents × N frames = 3N agent tasks (each with full LLM cycle).
 * Now: 1 direct skill call × N frames = N deterministic SQL executions (0 LLM calls).
 * For 63 frames: ~12-30 seconds total (pure SQL + rule evaluation).
 */
const frameAnalysisStage: StageDefinition = {
  name: 'frame_analysis',
  description: 'Per-jank-frame deep dive via direct skill execution (CPU/Binder/scheduling)',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：逐帧分析 CPU/Binder/调度（直接 Skill 执行）',
  tasks: [
    {
      agentId: 'frame_agent',   // Attribution only — no actual agent dispatch
      domain: 'frame',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'janky_frame_analysis',
      paramMapping: {
        frame_ts: 'startTs',
        frame_dur: 'duration',
        package: 'processName',
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
