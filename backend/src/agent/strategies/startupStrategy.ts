/**
 * Startup Analysis Strategy
 *
 * Deterministic 3-stage pipeline for app launch performance:
 * 1) startup_overview: discover startup events (cold/warm/hot)
 * 2) launch_event_overview: normalize/filter per startup event
 * 3) launch_event_detail: deep drill-down on each startup event
 */

import { AgentResponse } from '../types/agentProtocol';
import {
  StagedAnalysisStrategy,
  StageDefinition,
  FocusInterval,
  IntervalHelpers,
} from './types';
import { unwrapStepResult } from './helpers';

const STARTUP_DURATION_THRESHOLDS_MS: Record<string, number> = {
  cold: 1000,
  warm: 600,
  hot: 200,
};

const STARTUP_TYPE_PRIORITY: Record<string, number> = {
  cold: 3,
  warm: 2,
  hot: 1,
};

const STARTUP_DURATION_MISMATCH_ABS_MS = 1;
const STARTUP_DURATION_MISMATCH_RATIO = 0.01;
const STARTUP_SMALL_TTID_WARN_THRESHOLD_MS = 10;

type StartupQualityLevel = 'blocker' | 'warning';

interface StartupQualityIssue {
  code: string;
  level: StartupQualityLevel;
  message: string;
}

function isStartupQuery(query: string): boolean {
  const q = (query || '').toLowerCase();
  return (
    q.includes('启动') ||
    q.includes('冷启动') ||
    q.includes('温启动') ||
    q.includes('热启动') ||
    q.includes('startup') ||
    q.includes('launch') ||
    q.includes('cold start') ||
    q.includes('warm start') ||
    q.includes('hot start') ||
    q.includes('ttid') ||
    q.includes('ttfd')
  );
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toPositiveFiniteNumber(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseNsBigInt(value: any): bigint | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

function isDurationMismatch(observedMs: number, expectedMs: number): boolean {
  const delta = Math.abs(observedMs - expectedMs);
  const tolerance = Math.max(
    STARTUP_DURATION_MISMATCH_ABS_MS,
    Math.abs(expectedMs) * STARTUP_DURATION_MISMATCH_RATIO
  );
  return delta > tolerance;
}

function inferQualityStatus(issues: StartupQualityIssue[]): 'PASS' | 'WARN' | 'BLOCKER' {
  if (issues.some((issue) => issue.level === 'blocker')) return 'BLOCKER';
  if (issues.some((issue) => issue.level === 'warning')) return 'WARN';
  return 'PASS';
}

function intervalQualityBlockerCount(interval: FocusInterval): number {
  const raw = interval.metadata?.qualityBlockerCount ?? interval.metadata?.quality_blocker_count ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function normalizeStartupType(value: any): 'cold' | 'warm' | 'hot' | 'unknown' {
  const s = String(value || '').trim().toLowerCase();
  if (s === 'cold' || s === 'warm' || s === 'hot') return s;
  return 'unknown';
}

function resolveStartupEndTs(startTs: string, endTs: string, durNs: any, durMs: any): string | null {
  if (startTs && endTs) {
    try {
      if (BigInt(endTs) > BigInt(startTs)) return endTs;
    } catch {
      // ignore
    }
  }

  try {
    if (durNs !== undefined && durNs !== null) {
      const ns = BigInt(String(durNs));
      if (ns > 0n) return String(BigInt(startTs) + ns);
    }
  } catch {
    // ignore
  }

  const ms = toFiniteNumber(durMs);
  if (ms > 0) {
    try {
      return String(BigInt(startTs) + BigInt(Math.round(ms * 1e6)));
    } catch {
      // ignore
    }
  }

  return null;
}

function collectStartupRows(
  responses: AgentResponse[],
  helpers: IntervalHelpers
): Array<Record<string, any>> {
  const rows: Array<Record<string, any>> = [];

  for (const resp of responses) {
    if (!resp.success) continue;

    for (const toolResult of resp.toolResults || []) {
      const data = toolResult.data as any;
      if (data && typeof data === 'object') {
        // rawResults keys: step IDs (get_startups) and save_as aliases (startups)
        if (data.startups) {
          rows.push(...helpers.payloadToObjectRows(unwrapStepResult(data.startups)));
        }
        if (data.get_startups) {
          rows.push(...helpers.payloadToObjectRows(unwrapStepResult(data.get_startups)));
        }
      }

      const envelopes = (toolResult.dataEnvelopes || [])
        .filter((env: any) => env?.meta?.skillId === 'startup_analysis' && env?.meta?.stepId === 'get_startups');

      for (const env of envelopes) {
        rows.push(...helpers.payloadToObjectRows(env.data));
      }
    }
  }

  return rows;
}

function extractStartupIntervals(
  responses: AgentResponse[],
  helpers: IntervalHelpers
): FocusInterval[] {
  const rows = collectStartupRows(responses, helpers);
  if (rows.length === 0) return [];

  const unique = new Map<string, FocusInterval>();

  for (const row of rows) {
    const startupId = toFiniteNumber(row.startup_id || row.startupId);
    const startTs = String(row.start_ts || row.ts || '').trim();
    if (!startTs || startTs === '0') continue;

    const qualityIssues: StartupQualityIssue[] = [];
    const durMsRaw = toPositiveFiniteNumber(row.dur_ms ?? row.duration_ms);
    const durNsValue = parseNsBigInt(row.dur_ns ?? row.dur);
    const durMsFromDurNs = durNsValue && durNsValue > 0n ? nsToMs(durNsValue) : null;

    const endTs = resolveStartupEndTs(
      startTs,
      String(row.end_ts || '').trim(),
      row.dur_ns ?? row.dur,
      durMsRaw ?? undefined
    );

    if (!endTs) continue;

    const startNsValue = parseNsBigInt(startTs);
    const endNsValue = parseNsBigInt(endTs);

    try {
      if (BigInt(endTs) <= BigInt(startTs)) continue;
    } catch {
      continue;
    }

    const durMsFromStartEnd =
      startNsValue !== null && endNsValue !== null && endNsValue > startNsValue
        ? nsToMs(endNsValue - startNsValue)
        : null;

    let durMs = durMsRaw ?? durMsFromStartEnd ?? durMsFromDurNs ?? 0;

    if (durMsRaw !== null && durMsFromStartEnd !== null && isDurationMismatch(durMsRaw, durMsFromStartEnd)) {
      qualityIssues.push({
        code: 'R001_DURATION_MISMATCH_START_END',
        level: 'blocker',
        message: `dur_ms(${durMsRaw.toFixed(2)}ms) 与 end-start(${durMsFromStartEnd.toFixed(2)}ms) 不一致`,
      });
      durMs = durMsFromStartEnd;
    }

    if (durMsRaw !== null && durMsFromDurNs !== null && isDurationMismatch(durMsRaw, durMsFromDurNs)) {
      qualityIssues.push({
        code: 'R001_DURATION_MISMATCH_DUR_NS',
        level: 'blocker',
        message: `dur_ms(${durMsRaw.toFixed(2)}ms) 与 dur_ns(${durMsFromDurNs.toFixed(2)}ms) 不一致`,
      });
      if (durMsFromStartEnd !== null) {
        durMs = durMsFromStartEnd;
      } else {
        durMs = durMsFromDurNs;
      }
    }

    if (
      durMsRaw !== null &&
      durMsFromStartEnd !== null &&
      durMsFromStartEnd >= 100 &&
      durMsRaw > 0 &&
      durMsFromStartEnd / durMsRaw >= 50
    ) {
      qualityIssues.push({
        code: 'R002_DURATION_UNIT_SUSPICIOUS',
        level: 'blocker',
        message: `dur_ms(${durMsRaw.toFixed(4)}ms) 相对区间时长(${durMsFromStartEnd.toFixed(2)}ms)异常偏小，疑似单位错配`,
      });
      durMs = durMsFromStartEnd;
    }

    const startupType = normalizeStartupType(row.startup_type || row.startupType);
    const thresholdMs = STARTUP_DURATION_THRESHOLDS_MS[startupType] || 0;
    const isProblem = thresholdMs > 0 && durMs > thresholdMs;
    const typePriority = STARTUP_TYPE_PRIORITY[startupType] || 0;

    const startupIdForDisplay = startupId > 0 ? startupId : toFiniteNumber(row.id);
    const processName = String(row.package || row.process_name || row.processName || '').trim() || 'unknown';
    const ttidMsRaw = toPositiveFiniteNumber(row.ttid_ms ?? row.ttidMs);
    const ttfdMsRaw = toPositiveFiniteNumber(row.ttfd_ms ?? row.ttfdMs);
    let ttidMs = ttidMsRaw ?? 0;
    let ttfdMs = ttfdMsRaw ?? 0;

    if (ttidMsRaw !== null && durMs >= 200 && ttidMsRaw < STARTUP_SMALL_TTID_WARN_THRESHOLD_MS) {
      qualityIssues.push({
        code: 'R008_TTID_SUSPICIOUSLY_SMALL',
        level: 'warning',
        message: `TTID=${ttidMsRaw.toFixed(2)}ms 相对启动时长 ${durMs.toFixed(2)}ms 偏小，建议复核单位`,
      });
    }

    if (ttfdMsRaw !== null && durMs >= 200 && ttfdMsRaw < STARTUP_SMALL_TTID_WARN_THRESHOLD_MS) {
      qualityIssues.push({
        code: 'R008_TTFD_SUSPICIOUSLY_SMALL',
        level: 'warning',
        message: `TTFD=${ttfdMsRaw.toFixed(2)}ms 相对启动时长 ${durMs.toFixed(2)}ms 偏小，建议复核单位`,
      });
    }

    if (ttidMsRaw !== null && ttidMsRaw > durMs + 50) {
      qualityIssues.push({
        code: 'R008_TTID_GT_DUR',
        level: 'warning',
        message: `TTID=${ttidMsRaw.toFixed(2)}ms 超过启动时长 ${durMs.toFixed(2)}ms`,
      });
    }

    if (ttfdMsRaw !== null && ttfdMsRaw > durMs + 50) {
      qualityIssues.push({
        code: 'R008_TTFD_GT_DUR',
        level: 'warning',
        message: `TTFD=${ttfdMsRaw.toFixed(2)}ms 超过启动时长 ${durMs.toFixed(2)}ms`,
      });
    }

    if (ttidMsRaw !== null && ttfdMsRaw !== null && ttfdMsRaw < ttidMsRaw) {
      qualityIssues.push({
        code: 'R008_TTFD_LT_TTID',
        level: 'warning',
        message: `TTFD=${ttfdMsRaw.toFixed(2)}ms 小于 TTID=${ttidMsRaw.toFixed(2)}ms`,
      });
      ttfdMs = 0;
    }

    const typeLabel = startupType === 'cold'
      ? '冷启动'
      : startupType === 'warm'
        ? '温启动'
        : startupType === 'hot'
          ? '热启动'
          : '启动';

    const priority = (isProblem ? 1000 : 0) + Math.round(durMs) + typePriority * 10;
    const dedupeKey = `${startupIdForDisplay || 'unknown'}|${startTs}|${endTs}|${processName}`;
    const qualityStatus = inferQualityStatus(qualityIssues);
    const qualityBlockerCount = qualityIssues.filter((issue) => issue.level === 'blocker').length;
    const qualityWarningCount = qualityIssues.filter((issue) => issue.level === 'warning').length;

    unique.set(dedupeKey, {
      id: startupIdForDisplay > 0 ? startupIdForDisplay : unique.size + 1,
      processName,
      startTs,
      endTs,
      priority,
      label: `${typeLabel} #${startupIdForDisplay > 0 ? startupIdForDisplay : unique.size + 1}`,
      metadata: {
        sourceEntityType: 'startup',
        sourceEntityId: startupIdForDisplay > 0 ? startupIdForDisplay : unique.size + 1,
        startupId: startupIdForDisplay > 0 ? startupIdForDisplay : unique.size + 1,
        startup_id: startupIdForDisplay > 0 ? startupIdForDisplay : unique.size + 1,
        startupType,
        startup_type: startupType,
        durMs,
        dur_ms: durMs,
        ttidMs: ttidMs > 0 ? ttidMs : undefined,
        ttid_ms: ttidMs > 0 ? ttidMs : undefined,
        ttfdMs: ttfdMs > 0 ? ttfdMs : undefined,
        ttfd_ms: ttfdMs > 0 ? ttfdMs : undefined,
        perfettoStart: String(row.perfetto_start || '').trim() || undefined,
        perfetto_start: String(row.perfetto_start || '').trim() || undefined,
        perfettoEnd: String(row.perfetto_end || '').trim() || undefined,
        perfetto_end: String(row.perfetto_end || '').trim() || undefined,
        qualityStatus,
        quality_status: qualityStatus,
        qualityBlockerCount,
        quality_blocker_count: qualityBlockerCount,
        qualityWarningCount,
        quality_warning_count: qualityWarningCount,
        qualityIssues,
        quality_issues: qualityIssues.map((issue) => issue.code),
        thresholdMs,
        isProblem,
      },
    });
  }

  const intervals = Array.from(unique.values());
  intervals.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    try {
      const aStart = BigInt(a.startTs);
      const bStart = BigInt(b.startTs);
      if (aStart < bStart) return -1;
      if (aStart > bStart) return 1;
    } catch {
      // ignore
    }
    return 0;
  });

  let referenceNs: string | undefined;
  try {
    referenceNs = intervals.reduce((min, cur) =>
      BigInt(cur.startTs) < BigInt(min) ? cur.startTs : min,
    intervals[0].startTs);
  } catch {
    // ignore
  }

  return intervals.map((interval) => {
    const startupId = interval.metadata?.startupId || interval.id;
    const startupType = interval.metadata?.startupType || 'unknown';
    const typeLabel = startupType === 'cold'
      ? '冷启动'
      : startupType === 'warm'
        ? '温启动'
        : startupType === 'hot'
          ? '热启动'
          : '启动';

    return {
      ...interval,
      label: `${typeLabel} #${startupId} · ${helpers.formatNsRangeLabel(interval.startTs, interval.endTs, referenceNs)} · ${interval.metadata?.durMs || 0}ms`,
    };
  });
}

const stage0_startupOverview: StageDefinition = {
  name: 'startup_overview',
  description: '检测启动事件并识别冷/温/热启动分布',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：定位启动事件',
  tasks: [
    {
      agentId: 'startup_agent',
      domain: 'startup',
      scope: 'global',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'startup_analysis',
      skillParams: {
        analysis_mode: 'overview',
        enable_startup_details: false,
      },
      descriptionTemplate: '分析启动概览（冷/温/热启动分布与慢启动事件）',
    },
  ],
  extractIntervals: extractStartupIntervals,
  shouldStop: (intervals) => {
    if (intervals.length === 0) {
      return {
        stop: true,
        reason: '未检测到启动事件，无法继续启动深度分析',
      };
    }
    return { stop: false, reason: '' };
  },
};

const stage1_launchEventOverview: StageDefinition = {
  name: 'launch_event_overview',
  description: '按启动事件归一化概览信息',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：按事件聚焦启动问题',
  tasks: [
    {
      agentId: 'startup_agent',
      domain: 'startup',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'startup_analysis',
      paramMapping: {
        package: 'processName',
        start_ts: 'startTs',
        end_ts: 'endTs',
        startup_id: 'startupId',
        startup_type: 'startupType',
      },
      skillParams: {
        analysis_mode: 'overview',
        enable_startup_details: false,
      },
      descriptionTemplate: '归一化启动事件：{{scopeLabel}}',
    },
  ],
  extractIntervals: extractStartupIntervals,
  shouldStop: (intervals) => {
    if (intervals.length === 0) {
      return {
        stop: true,
        reason: '启动事件概览未提取到有效区间，终止后续深挖',
      };
    }
    const hasActionable = intervals.some((interval) => intervalQualityBlockerCount(interval) === 0);
    if (!hasActionable) {
      return {
        stop: true,
        reason: '启动数据质量门禁未通过（存在阻断级问题），终止后续深挖',
      };
    }
    return { stop: false, reason: '' };
  },
};

const stage2_launchEventDetail: StageDefinition = {
  name: 'launch_event_detail',
  description: '逐个启动事件深度分析根因',
  progressMessageTemplate: '阶段 {{stageIndex}}/{{totalStages}}：启动事件根因分析',
  tasks: [
    {
      agentId: 'startup_agent',
      domain: 'startup',
      scope: 'per_interval',
      priority: 1,
      executionMode: 'direct_skill',
      directSkillId: 'startup_detail',
      intervalFilter: (interval) => intervalQualityBlockerCount(interval) === 0,
      paramMapping: {
        startup_id: 'startupId',
        start_ts: 'startTs',
        end_ts: 'endTs',
        dur_ms: 'durMs',
        package: 'processName',
        startup_type: 'startupType',
        ttid_ms: 'ttidMs',
        ttfd_ms: 'ttfdMs',
        perfetto_start: 'perfettoStart',
        perfetto_end: 'perfettoEnd',
      },
      descriptionTemplate: '启动事件深挖：{{scopeLabel}}',
    },
  ],
};

export const startupStrategy: StagedAnalysisStrategy = {
  id: 'startup',
  name: 'Startup Analysis',
  trigger: isStartupQuery,
  stages: [stage0_startupOverview, stage1_launchEventOverview, stage2_launchEventDetail],
  defaults: {
    maxStartupsPerStage: 8,
  },
};
