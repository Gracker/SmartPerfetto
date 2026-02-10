/**
 * Jank Cause Summarizer
 *
 * Aggregates jank root causes and produces a structured summary for
 * ConclusionGenerator. The preferred data source is per-frame mechanism records
 * captured from direct skill execution. Findings remain a compatibility fallback.
 */

import { Finding } from '../types';
import type { FrameMechanismRecord } from '../types/jankCause';
import {
  AMPLIFICATION_UNKNOWN_TEXT,
  SUPPLY_NONE_TEXT,
  SUPPLY_WORKLOAD_WEAK_TEXT,
  TRIAD_LABELS,
} from '../../utils/analysisNarrative';

// =============================================================================
// Types
// =============================================================================

/**
 * Statistics for a single cause type.
 */
export interface CauseTypeStats {
  /** Cause type key (e.g., 'slice', 'gpu_fence', 'sched_latency') */
  causeType: string;
  /** Human-readable label (e.g., '主线程耗时操作') */
  label: string;
  /** Number of frames with this cause */
  frameCount: number;
  /** Percentage of total jank frames */
  percentage: number;
  /** Highest severity among frames with this cause */
  severity: 'critical' | 'warning' | 'info';
  /** Sample primary_cause descriptions (max 3 unique) */
  exampleCauses: string[];
}

/**
 * Clustered pattern across multiple jank frames.
 *
 * Cluster key is mechanism signature (trigger + supply + amplification),
 * sorted by frameCount so developers can fix the largest bucket first.
 */
export interface JankCluster {
  /** Stable display id (K1, K2, ...), assigned after sorting by size. */
  clusterId: string;
  /** Frame count in this cluster. */
  frameCount: number;
  /** Share among total jank frames (%). */
  percentage: number;
  /** Trigger-side label (usually cause_type label). */
  triggerFactor: string;
  /** Supply-side constraint label. */
  supplyConstraint: string;
  /** Amplification-path label. */
  amplificationPath: string;
  /** Representative cause_type key for this cluster. */
  causeType: string;
  /** Optional representative frame IDs for drill-down. */
  representativeFrames: string[];
  /** Optional short examples from primary_cause. */
  samplePrimaryCauses: string[];
}

/**
 * Complete jank cause summary.
 */
export interface JankCauseSummary {
  /** Total number of analyzed jank frames */
  totalJankFrames: number;
  /** Most common cause (null if no causes found) */
  primaryCause: CauseTypeStats | null;
  /** Other significant causes (>=10% of frames) */
  secondaryCauses: CauseTypeStats[];
  /** Full breakdown of all causes */
  allCauses: CauseTypeStats[];
  /** Clustered patterns, sorted by frame count desc */
  clusters: JankCluster[];
  /** Pre-formatted summary text for LLM prompt */
  summaryText: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Mapping from cause_type to human-readable Chinese labels.
 * These must match the cause_type values in jank_frame_detail.skill.yaml root_cause_summary SQL.
 */
export const CAUSE_TYPE_LABELS: Record<string, string> = {
  slice: '主线程耗时操作',
  gpu_fence: 'GPU Fence 等待',
  sched_latency: '调度延迟',
  cpu_contention: 'CPU 争抢',
  io_blocking: 'IO 阻塞',
  blocking: '主线程阻塞 (Binder/锁)',
  render_wait: 'RenderThread 等待',
  small_core: '小核运行',
  freq_limit: 'CPU 限频',
  cpu_overload: 'CPU 负载过高',
  unknown: '其他原因',
};

const SUPPLY_CONSTRAINT_LABELS: Record<string, string> = {
  load_high: '负载偏高',
  frequency_insufficient: '频率不足',
  scheduling_delay: '调度延迟',
  core_placement: '核心摆放',
  blocking_wait: '阻塞等待',
  none: SUPPLY_NONE_TEXT,
};

const WORKLOAD_DOMINANT_CAUSE_TYPES = new Set([
  'slice',
]);

const AMPLIFICATION_PATH_LABELS: Record<string, string> = {
  gpu_fence_wait: 'GPU Fence 等待放大',
  render_pipeline_wait: 'RenderPipeline 等待放大',
  sf_consumer_backpressure: 'SF 消费端背压',
  app_deadline_miss: 'APP 截止超时',
  unknown: AMPLIFICATION_UNKNOWN_TEXT,
};

/**
 * Threshold for secondary cause classification (percentage).
 */
const SECONDARY_CAUSE_THRESHOLD = 10;

const CLUSTER_TOP_LIMIT = 5;

type CauseSeverity = 'critical' | 'warning' | 'info';

interface CauseSample {
  causeType: string;
  primaryCause?: string;
  severity: CauseSeverity;
}

interface NormalizedFrameRecord {
  frameId: string;
  sessionId: string;
  startTs: string;
  causeType: string;
  primaryCause?: string;
  supplyConstraint: string;
  amplificationPath: string;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Summarize jank causes.
 *
 * Preferred source: frameMechanismRecords (per-frame, dedupe-resistant).
 * Fallback source: findings with details.cause_type.
 */
export function summarizeJankCauses(
  findings: Finding[],
  frameMechanismRecords: FrameMechanismRecord[] = []
): JankCauseSummary {
  const normalizedRecords = normalizeFrameRecords(frameMechanismRecords);
  const samplesFromRecords = extractCauseSamplesFromRecords(normalizedRecords, findings);
  if (samplesFromRecords.length > 0) {
    console.log(
      `[JankCauseSummarizer] Using frame mechanism records: ${samplesFromRecords.length} samples ` +
      `(findings=${findings.length})`
    );
    const clusters = buildClustersFromRecords(normalizedRecords);
    return summarizeFromSamples(samplesFromRecords, clusters);
  }

  const samplesFromFindings = extractCauseSamplesFromFindings(findings);
  const clustersFromFindings = buildClustersFromFindings(findings);
  return summarizeFromSamples(samplesFromFindings, clustersFromFindings);
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a human-readable summary text for LLM prompt inclusion.
 */
function summarizeFromSamples(samples: CauseSample[], clusters: JankCluster[]): JankCauseSummary {
  if (samples.length === 0) {
    return {
      totalJankFrames: 0,
      primaryCause: null,
      secondaryCauses: [],
      allCauses: [],
      clusters: [],
      summaryText: '未检测到可分类的根因数据',
    };
  }

  const causeGroups = new Map<string, CauseSample[]>();
  for (const sample of samples) {
    if (!causeGroups.has(sample.causeType)) {
      causeGroups.set(sample.causeType, []);
    }
    causeGroups.get(sample.causeType)!.push(sample);
  }

  const totalFrames = samples.length;
  const allStats: CauseTypeStats[] = Array.from(causeGroups.entries())
    .map(([causeType, causeSamples]) => {
      const uniqueCauses = [
        ...new Set(
          causeSamples
            .map(s => s.primaryCause)
            .filter((c): c is string => typeof c === 'string' && c.length > 0)
        ),
      ].slice(0, 3);

      return {
        causeType,
        label: CAUSE_TYPE_LABELS[causeType] || causeType,
        frameCount: causeSamples.length,
        percentage: Math.round((causeSamples.length / totalFrames) * 100),
        severity: getHighestSeverity(causeSamples.map(s => s.severity)),
        exampleCauses: uniqueCauses,
      };
    })
    .sort((a, b) => b.frameCount - a.frameCount);

  const primaryCause = allStats[0] || null;
  const secondaryCauses = allStats
    .slice(1)
    .filter(s => s.percentage >= SECONDARY_CAUSE_THRESHOLD);

  return {
    totalJankFrames: totalFrames,
    primaryCause,
    secondaryCauses,
    allCauses: allStats,
    clusters,
    summaryText: generateSummaryText(primaryCause, secondaryCauses, totalFrames, clusters),
  };
}

function extractCauseSamplesFromRecords(
  records: NormalizedFrameRecord[],
  findings: Finding[]
): CauseSample[] {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const severityByCause = buildSeverityByCauseFromFindings(findings);
  const deduped = new Map<string, CauseSample>();

  for (const record of records) {
    const causeType = record.causeType;
    if (!causeType) {
      continue;
    }

    const dedupeKey = [
      record.sessionId,
      record.frameId,
      record.startTs,
      causeType,
    ].join('|');
    if (deduped.has(dedupeKey)) {
      continue;
    }

    deduped.set(dedupeKey, {
      causeType,
      primaryCause: record.primaryCause,
      severity: severityByCause.get(causeType) || 'warning',
    });
  }

  return [...deduped.values()];
}

function normalizeFrameRecords(records: FrameMechanismRecord[]): NormalizedFrameRecord[] {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const deduped = new Map<string, NormalizedFrameRecord>();

  for (const record of records) {
    const causeType = typeof record?.causeType === 'string' ? record.causeType.trim() : '';
    const frameId = String(record?.frameId || '');
    const startTs = String(record?.startTs || '');
    if (!causeType || !frameId || !startTs) {
      continue;
    }

    const sessionId = record?.sessionId ? String(record.sessionId) : 'nosession';
    const supplyConstraint = normalizeEnumValue(record?.supplyConstraint, 'none');
    const amplificationPath = normalizeEnumValue(record?.amplificationPath, 'unknown');

    const key = [sessionId, frameId, startTs, causeType].join('|');
    if (deduped.has(key)) {
      continue;
    }

    deduped.set(key, {
      frameId,
      sessionId,
      startTs,
      causeType,
      primaryCause: typeof record?.primaryCause === 'string' ? record.primaryCause : undefined,
      supplyConstraint,
      amplificationPath,
    });
  }

  return [...deduped.values()];
}

function normalizeEnumValue(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') {
    return fallback;
  }
  const v = raw.trim();
  return v.length > 0 ? v : fallback;
}

function buildClustersFromRecords(records: NormalizedFrameRecord[]): JankCluster[] {
  if (records.length === 0) {
    return [];
  }

  const groups = new Map<string, NormalizedFrameRecord[]>();
  for (const record of records) {
    const key = [record.causeType, record.supplyConstraint, record.amplificationPath].join('|');
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(record);
  }

  const total = records.length;
  const clusters = Array.from(groups.values())
    .map((items) => {
      const first = items[0];
      const representativeFrames = [...new Set(items.map(i => i.frameId))].slice(0, 5);
      const samplePrimaryCauses = [...new Set(items.map(i => i.primaryCause).filter(Boolean) as string[])].slice(0, 2);
      return {
        clusterId: '',
        frameCount: items.length,
        percentage: roundPercent(items.length, total),
        triggerFactor: CAUSE_TYPE_LABELS[first.causeType] || first.causeType,
        supplyConstraint: resolveClusterSupplyLabel(first.causeType, first.supplyConstraint),
        amplificationPath: AMPLIFICATION_PATH_LABELS[first.amplificationPath] || first.amplificationPath,
        causeType: first.causeType,
        representativeFrames,
        samplePrimaryCauses,
      } as JankCluster;
    })
    .sort((a, b) => b.frameCount - a.frameCount);

  return assignClusterIds(clusters);
}

function buildClustersFromFindings(findings: Finding[]): JankCluster[] {
  const grouped = new Map<string, { count: number; samples: string[] }>();

  for (const finding of findings) {
    const causeTypeRaw = finding.details?.cause_type;
    if (typeof causeTypeRaw !== 'string' || causeTypeRaw.trim().length === 0) {
      continue;
    }
    const causeType = causeTypeRaw.trim();
    if (!grouped.has(causeType)) {
      grouped.set(causeType, { count: 0, samples: [] });
    }
    const bucket = grouped.get(causeType)!;
    bucket.count += 1;
    const primary = finding.details?.primary_cause;
    if (typeof primary === 'string' && primary.length > 0 && bucket.samples.length < 2 && !bucket.samples.includes(primary)) {
      bucket.samples.push(primary);
    }
  }

  const total = Array.from(grouped.values()).reduce((sum, b) => sum + b.count, 0);
  if (total === 0) {
    return [];
  }

  const clusters = Array.from(grouped.entries())
    .map(([causeType, bucket]) => ({
      clusterId: '',
      frameCount: bucket.count,
      percentage: roundPercent(bucket.count, total),
      triggerFactor: CAUSE_TYPE_LABELS[causeType] || causeType,
      supplyConstraint: SUPPLY_NONE_TEXT,
      amplificationPath: AMPLIFICATION_UNKNOWN_TEXT,
      causeType,
      representativeFrames: [],
      samplePrimaryCauses: bucket.samples,
    } as JankCluster))
    .sort((a, b) => b.frameCount - a.frameCount);

  return assignClusterIds(clusters);
}

function assignClusterIds(clusters: JankCluster[]): JankCluster[] {
  return clusters.map((cluster, index) => ({
    ...cluster,
    clusterId: `K${index + 1}`,
  }));
}

function resolveClusterSupplyLabel(causeType: string, supplyConstraint: string): string {
  if (supplyConstraint === 'none' && WORKLOAD_DOMINANT_CAUSE_TYPES.has(causeType)) {
    return SUPPLY_WORKLOAD_WEAK_TEXT;
  }
  return SUPPLY_CONSTRAINT_LABELS[supplyConstraint] || supplyConstraint;
}

function roundPercent(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((part / total) * 1000) / 10;
}

function extractCauseSamplesFromFindings(findings: Finding[]): CauseSample[] {
  const causedFindings = findings.filter(f =>
    f.details?.cause_type && typeof f.details.cause_type === 'string'
  );

  const withCauseType = causedFindings.length;
  const withoutCauseType = findings.filter(f => !f.details?.cause_type).length;
  console.log(`[JankCauseSummarizer] ${findings.length} total findings: ${withCauseType} with cause_type, ${withoutCauseType} without`);

  if (causedFindings.length === 0 && findings.length > 0) {
    const sample = findings.slice(0, 3).map(f => ({
      title: f.title?.slice(0, 50),
      detailsKeys: f.details ? Object.keys(f.details) : [],
    }));
    console.log(`[JankCauseSummarizer] Sample findings without cause_type: ${JSON.stringify(sample)}`);
  }

  return causedFindings.map(f => {
    const causeType = String(f.details!.cause_type).trim();
    const primaryCause = typeof f.details?.primary_cause === 'string'
      ? f.details.primary_cause
      : undefined;
    return {
      causeType,
      primaryCause,
      severity: normalizeSeverity(f.severity),
    };
  });
}

function buildSeverityByCauseFromFindings(findings: Finding[]): Map<string, CauseSeverity> {
  const severityMap = new Map<string, CauseSeverity>();

  for (const finding of findings) {
    const causeTypeRaw = finding.details?.cause_type;
    if (typeof causeTypeRaw !== 'string' || causeTypeRaw.trim().length === 0) {
      continue;
    }
    const causeType = causeTypeRaw.trim();
    const current = severityMap.get(causeType);
    const next = normalizeSeverity(finding.severity);
    if (!current || severityRank(next) > severityRank(current)) {
      severityMap.set(causeType, next);
    }
  }

  return severityMap;
}

function normalizeSeverity(value: Finding['severity']): CauseSeverity {
  if (value === 'critical' || value === 'high') {
    return 'critical';
  }
  if (value === 'warning' || value === 'medium') {
    return 'warning';
  }
  return 'info';
}

function severityRank(severity: CauseSeverity): number {
  if (severity === 'critical') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function getHighestSeverity(severities: CauseSeverity[]): CauseSeverity {
  let highest: CauseSeverity = 'info';
  for (const severity of severities) {
    if (severityRank(severity) > severityRank(highest)) {
      highest = severity;
    }
  }
  return highest;
}

function generateSummaryText(
  primaryCause: CauseTypeStats | null,
  secondaryCauses: CauseTypeStats[],
  totalFrames: number,
  clusters: JankCluster[]
): string {
  if (!primaryCause) {
    return '未检测到可分类的根因数据';
  }

  const lines: string[] = [];

  const topClusters = clusters.slice(0, CLUSTER_TOP_LIMIT);
  if (topClusters.length > 0) {
    lines.push(`### 掉帧聚类（优先按大头治理，${totalFrames} 帧）\n`);
    lines.push(`| 聚类 | 帧数 | 占比 | ${TRIAD_LABELS.trigger} | ${TRIAD_LABELS.supply} | ${TRIAD_LABELS.amplification} |`);
    lines.push('|------|------|------|----------|----------|----------|');
    for (const cluster of topClusters) {
      lines.push(
        `| ${cluster.clusterId} | ${cluster.frameCount} | ${cluster.percentage}% | ${cluster.triggerFactor} | ${cluster.supplyConstraint} | ${cluster.amplificationPath} |`
      );
    }
    lines.push('');
  }

  // Header with total count
  lines.push(`### 掉帧根因统计 (${totalFrames} 帧)\n`);

  // Table header
  lines.push('| 原因类型 | 帧数 | 占比 | 级别 |');
  lines.push('|---------|-----|------|------|');

  // Primary cause row
  const primaryLevel = primaryCause.percentage >= 50 ? '**首要原因**' : '首要原因';
  lines.push(
    `| ${primaryCause.label} | ${primaryCause.frameCount} | ${primaryCause.percentage}% | ${primaryLevel} |`
  );

  // Secondary causes
  for (const cause of secondaryCauses) {
    lines.push(
      `| ${cause.label} | ${cause.frameCount} | ${cause.percentage}% | 次要原因 |`
    );
  }

  // Other causes (grouped as "其他")
  const otherCauses = primaryCause
    ? [primaryCause, ...secondaryCauses].reduce(
        (sum, c) => sum + c.frameCount,
        0
      )
    : 0;
  const otherCount = totalFrames - otherCauses;
  if (otherCount > 0 && totalFrames > 0) {
    const otherPct = Math.round((otherCount / totalFrames) * 100);
    lines.push(`| 其他 | ${otherCount} | ${otherPct}% | - |`);
  }

  lines.push('');

  // Add example causes for context
  if (primaryCause.exampleCauses.length > 0) {
    lines.push(`**首要原因示例：**`);
    for (const example of primaryCause.exampleCauses.slice(0, 2)) {
      lines.push(`- ${example}`);
    }
  }

  if (topClusters.length > 0) {
    lines.push('');
    lines.push('**聚类处理顺序建议：** 先处理 K1，再处理 K2/K3。');
  }

  return lines.join('\n');
}

/**
 * Format a JankCauseSummary for inclusion in conclusion generator prompt.
 * Returns empty string if no meaningful summary exists.
 */
export function formatJankSummaryForPrompt(summary: JankCauseSummary | undefined): string {
  if (!summary || summary.totalJankFrames === 0) {
    return '';
  }

  const clusterHints = (summary.clusters || []).slice(0, 3)
    .map(c => `${c.clusterId}:${c.triggerFactor}/${c.supplyConstraint}/${c.amplificationPath}(${c.frameCount}帧,${c.percentage}%)`)
    .join('；');

  return `## 掉帧根因汇总（自动统计）

${summary.summaryText}

> 以上统计基于 ${summary.totalJankFrames} 个掉帧的逐帧分析结果，请在结论中引用这些数据。
${clusterHints ? `> 聚类优先级（按帧数降序）: ${clusterHints}` : ''}
`;
}
