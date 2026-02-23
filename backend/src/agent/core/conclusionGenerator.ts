/**
 * Conclusion Generator
 *
 * Generates analysis conclusions from accumulated findings and hypotheses.
 * Uses LLM for intelligent root-cause synthesis, with markdown fallback.
 */

import { Finding, Intent } from '../types';
import type { FrameMechanismRecord } from '../types/jankCause';
import { SharedAgentContext } from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { ProgressEmitter } from './orchestratorTypes';
import { formatJankSummaryForPrompt } from './jankCauseSummarizer';
import type { JankCauseSummary, JankCluster } from './jankCauseSummarizer';
import type {
  ConclusionClusterFrameListMode,
  ConclusionClusterOutputMode,
  ConclusionContract,
  ConclusionContractClusterItem,
  ConclusionContractClusterPolicy,
  ConclusionContractConclusionItem,
  ConclusionContractEvidenceItem,
  ConclusionContractMetadata,
  ConclusionOutputMode,
} from './conclusionContract';
import {
  AMPLIFICATION_UNKNOWN_CURRENT_FRAME_TEXT,
  buildTriadStatement,
  DEEP_REASON_ALIASES,
  DEEP_REASON_LABEL,
  hasTriadRoleText,
  normalizeLegacyTriadTerms,
  OPTIMIZATION_LABEL,
  parseTriadParts,
  stripTriadPrefix,
  SUPPLY_NONE_CURRENT_FRAME_TEXT,
  SUPPLY_WORKLOAD_WEAK_TEXT,
  TRIAD_EVIDENCE_LABELS,
  TRIAD_HEADING,
  TRIAD_LABELS,
} from '../../utils/analysisNarrative';
import {
  buildConclusionScenePromptHints,
  type ConclusionScenePromptHints,
} from './conclusionSceneTemplates';

export interface ConclusionGenerationOptions {
  /**
   * Number of previous turns in this session (0-based).
   * Example: 0 means this is the first user query of the session.
   */
  turnCount?: number;
  /**
   * Optional multi-turn context summary (compact, prompt-friendly).
   */
  historyContext?: string;
}

interface ContractRenderOptions {
  singleFrameDrillDown: boolean;
  scenePromptHints?: ConclusionScenePromptHints;
}

const DISABLED_FLAG_VALUES = new Set(['0', 'false', 'off', 'no']);
const ENABLED_FLAG_VALUES = new Set(['1', 'true', 'on', 'yes']);

type EvidenceObject = {
  evidenceId?: unknown;
  evidence_id?: unknown;
  title?: unknown;
  kind?: unknown;
  description?: unknown;
  summary?: unknown;
};

type FindingWithEvidence = Finding & {
  evidence?: unknown;
};

const PROMPT_FINDING_LIMIT = 8;
const PROMPT_FINDING_OTHER_FIELDS_LIMIT = 8;
const PROMPT_FINDING_OTHER_FIELD_MAX_CHARS = 90;
const PROMPT_FINDING_PRIORITY_FIELD_MAX_CHARS = 140;
const PROMPT_FINDING_EVIDENCE_ITEMS_LIMIT = 4;
const PROMPT_FINDING_EVIDENCE_MAX_CHARS = 120;
const STARTUP_WRAPPER_SLICE_RE = /\b(clientTransactionExecuted|activityStart|bindApplication|performCreate:)/i;
const STARTUP_ACTIONABLE_HINT_RE = /\b(LoadSimulator_|ChaosTask|SimulateInflation|RealInflation|AppInit|ActivityInit)\b/i;
const DEFAULT_TOP_CLUSTER_FRAME_RENDER_LIMIT = 5;
const DEFAULT_FULL_CLUSTER_FRAME_RENDER_LIMIT = 120;
const STRUCTURED_ACTION_ITEM_RE = /(?=.*(?:owner|责任人)\s*[:：=])(?=.*(?:priority|优先级)\s*[:：=])(?=.*(?:verification|验证)\s*[:：=])/i;

const SYSTEM_CONTEXT_SKILL_HINTS: Record<string, { owner: string; verification: string }> = {
  io_pressure: {
    owner: '存储/内核团队',
    verification: '复跑同时间窗 trace，确认 total_io_wait_ms 与长 IO 事件数下降，且关键卡顿帧无回归',
  },
  network_analysis: {
    owner: '网络/接入团队',
    verification: '复跑同时间窗 trace，确认 total_mb 与 active_periods 下降，并验证关键交互帧无新增掉帧',
  },
  thermal_throttling: {
    owner: '热管理/性能团队',
    verification: '复跑同时间窗 trace，确认峰值温度与降频占比下降，并验证 jank_rate 改善',
  },
};

function isJankSceneId(sceneId?: string): boolean {
  return String(sceneId || '').trim().toLowerCase() === 'jank';
}

function resolveClusterSectionHeading(sceneId?: string): string {
  return isJankSceneId(sceneId)
    ? '## 掉帧聚类（先看大头）'
    : '## 聚类（先看大头）';
}

function normalizeFindingTitleKey(title: string): string {
  return String(title || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function dedupeFindingsForConclusion(findings: Finding[]): Finding[] {
  const merged = new Map<string, Finding>();

  for (const finding of findings) {
    const key = normalizeFindingTitleKey(finding.title || '');
    if (!key) continue;

    if (!merged.has(key)) {
      merged.set(key, finding);
      continue;
    }

    const existing = merged.get(key)!;
    const existingScore = Number(existing.confidence || 0.5);
    const candidateScore = Number(finding.confidence || 0.5);
    if (candidateScore > existingScore) {
      merged.set(key, finding);
    }
  }

  return Array.from(merged.values());
}

function isStartupDetailFinding(finding: Finding): boolean {
  const src = String(finding.source || '').toLowerCase();
  if (src.includes('startup_detail')) return true;
  const title = String(finding.title || '');
  return title.includes('启动') || title.includes('温启动') || title.includes('冷启动') || title.includes('热启动');
}

function isStartupFrameworkWrapperFinding(finding: Finding): boolean {
  if (!isStartupDetailFinding(finding)) return false;
  const text = `${String(finding.title || '')}\n${String(finding.description || '')}`;
  return STARTUP_WRAPPER_SLICE_RE.test(text);
}

function hasStartupActionableFinding(findings: Finding[]): boolean {
  return findings.some((finding) => {
    if (!isStartupDetailFinding(finding)) return false;
    const text = `${String(finding.title || '')}\n${String(finding.description || '')}`;
    if (text.includes('主线程可操作热点')) return true;
    return STARTUP_ACTIONABLE_HINT_RE.test(text);
  });
}

function sanitizeFindingsForConclusion(allFindings: Finding[]): Finding[] {
  const deduped = dedupeFindingsForConclusion(allFindings);
  if (deduped.length === 0) return deduped;

  const actionableStartupExists = hasStartupActionableFinding(deduped);
  if (!actionableStartupExists) return deduped;

  return deduped.filter((finding) => !isStartupFrameworkWrapperFinding(finding));
}

function toEvidenceArray(evidence: unknown): unknown[] {
  if (Array.isArray(evidence)) {
    return evidence;
  }

  return evidence ? [evidence] : [];
}

function asEvidenceObject(value: unknown): EvidenceObject | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as EvidenceObject;
}

function stringifyValue(value: unknown, maxLength: number): string {
  if (value && typeof value === 'object') {
    return JSON.stringify(value).slice(0, maxLength);
  }

  return String(value);
}

function normalizeOptionalFlagValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isFollowUpConclusionTurn(turnCount: number, intent: Intent): boolean {
  return turnCount >= 1 || Boolean(intent.followUpType && intent.followUpType !== 'initial');
}

function collectEntityIds(intent: Intent, entityType: 'frame' | 'session'): string[] {
  const ids = new Set<string>();
  const params = intent.extractedParams || {};

  if (entityType === 'frame') {
    const frameId = (params as Record<string, unknown>).frame_id ?? (params as Record<string, unknown>).frameId;
    if (frameId !== undefined && frameId !== null) ids.add(String(frameId));
  } else {
    const sessionId = (params as Record<string, unknown>).session_id ?? (params as Record<string, unknown>).sessionId;
    if (sessionId !== undefined && sessionId !== null) ids.add(String(sessionId));
  }

  for (const entity of intent.referencedEntities || []) {
    if (entity.type !== entityType) continue;
    const raw = entity.value !== undefined ? entity.value : entity.id;
    if (raw !== undefined && raw !== null) ids.add(String(raw));
  }

  return Array.from(ids).map(id => id.trim()).filter(id => id.length > 0);
}

function isSingleFrameDrillDown(intent: Intent): boolean {
  if (intent.followUpType !== 'drill_down') return false;
  const frameIds = collectEntityIds(intent, 'frame');
  return frameIds.length === 1;
}

function isInsightConclusionEnabled(): boolean {
  // Default ON (per user request). Allow disabling for rollback.
  const override =
    process.env.SMARTPERFETTO_CONCLUSION_V2 ??
    process.env.SMARTPERFETTO_INSIGHT_CONCLUSION;

  const normalized = normalizeOptionalFlagValue(override);
  if (!normalized) {
    return true;
  }

  if (DISABLED_FLAG_VALUES.has(normalized)) return false;
  if (ENABLED_FLAG_VALUES.has(normalized)) return true;
  return true;
}

function selectConclusionOutputMode(params: {
  turnCount: number;
  intent: Intent;
  findingsCount: number;
  confirmedHypothesesCount: number;
  hasJankSummary: boolean;
}): ConclusionOutputMode {
  const {
    turnCount,
    intent,
    findingsCount,
    confirmedHypothesesCount,
    hasJankSummary,
  } = params;
  const isFollowUp = isFollowUpConclusionTurn(turnCount, intent);
  const hasAnyEvidence = findingsCount > 0 || confirmedHypothesesCount > 0 || hasJankSummary;

  if (!hasAnyEvidence) {
    return 'need_input';
  }

  if (!isFollowUp) {
    return 'initial_report';
  }

  return 'focused_answer';
}

function resolveConclusionOutputMode(params: {
  insightEnabled: boolean;
  turnCount: number;
  intent: Intent;
  findingsCount: number;
  confirmedHypothesesCount: number;
  hasJankSummary: boolean;
}): ConclusionOutputMode {
  const {
    insightEnabled,
    turnCount,
    intent,
    findingsCount,
    confirmedHypothesesCount,
    hasJankSummary,
  } = params;

  if (!insightEnabled) {
    return isFollowUpConclusionTurn(turnCount, intent) ? 'focused_answer' : 'initial_report';
  }

  return selectConclusionOutputMode({
    turnCount,
    intent,
    findingsCount,
    confirmedHypothesesCount,
    hasJankSummary,
  });
}

/**
 * Format a finding with its evidence data for LLM consumption.
 * Includes title, description, and key data entries from details.
 *
 * Key design decisions:
 * - Priority fields (root_cause, primary_cause, cause_type) are preserved fully
 * - Other details are truncated to manage token usage
 * - Evidence is preserved with reasonable limits
 */
function formatFindingWithEvidence(f: Finding): string {
  let result = `- [${f.severity}] ${f.title}`;
  if (f.description) {
    result += `\n  描述: ${f.description}`;
  }

  if (f.details && typeof f.details === 'object' && Object.keys(f.details).length > 0) {
    // Priority fields that should be preserved in full
    const priorityFields = [
      'root_cause',
      'primary_cause',
      'deep_reason',
      'reason_code',
      'optimization_hint',
      'cause_type',
      'supply_constraint',
      'trigger_layer',
      'amplification_path',
      'owner',
      'priority',
      'action',
      'verification',
      'system_context',
      'systemContext',
      'confidence',
      'jank_type',
    ];
    const details = f.details as Record<string, unknown>;

    // First, output priority fields without truncation
    const priorityEntries: string[] = [];
    for (const field of priorityFields) {
      if (details[field] !== undefined) {
        const val = stringifyValue(details[field], PROMPT_FINDING_PRIORITY_FIELD_MAX_CHARS);
        priorityEntries.push(`${field}: ${val}`);
      }
    }

    // Then, output other fields with truncation
    const otherEntries = Object.entries(details)
      .filter(([k]) => !priorityFields.includes(k))
      .slice(0, PROMPT_FINDING_OTHER_FIELDS_LIMIT)
      .map(([k, v]) => `${k}: ${stringifyValue(v, PROMPT_FINDING_OTHER_FIELD_MAX_CHARS)}`);

    const allEntries = [...priorityEntries, ...otherEntries];
    if (allEntries.length > 0) {
      result += `\n  数据: { ${allEntries.join(', ')} }`;
    }
  }

  // Preserve evidence with compact limits to avoid prompt bloat on large traces
  if (f.evidence && Array.isArray(f.evidence) && f.evidence.length > 0) {
    const evidenceStr = f.evidence
      .slice(0, PROMPT_FINDING_EVIDENCE_ITEMS_LIMIT)
      .map(e => stringifyValue(e, PROMPT_FINDING_EVIDENCE_MAX_CHARS))
      .join('; ');
    result += `\n  证据: ${evidenceStr}`;
  }

  return result;
}

type AttributionVerdict = 'APP_TRIGGER' | 'SF_CONSUMER' | 'MIXED' | 'INSUFFICIENT';

interface AttributionAssessment {
  verdict: AttributionVerdict;
  confidence: number;
  frameSample: number;
  appLikePct: number;
  sfLikePct: number;
  sfRespSample: number;
  sfRespPct: number;
  appRespSample: number;
  appRespPct: number;
  consumerFrames: number;
  consumerRate: number;
  rationale: string[];
}

interface MechanismTriad {
  trigger: string;
  supply: string;
  amplification: string;
  triggerEvidence: string;
  supplyEvidence: string;
  amplificationEvidence: string;
}

const APP_LIKE_CAUSE_TYPES = new Set([
  'slice',
  'blocking',
  'io_blocking',
  'cpu_contention',
  'cpu_overload',
  'sched_latency',
  'small_core',
  'freq_limit',
]);

const SF_LIKE_CAUSE_TYPES = new Set([
  'gpu_fence',
  'render_wait',
]);

const TRIGGER_CAUSE_TYPES = new Set([
  'slice',
  'blocking',
  'io_blocking',
]);

const SUPPLY_CAUSE_TYPES = new Set([
  'cpu_overload',
  'freq_limit',
  'sched_latency',
  'small_core',
  'cpu_contention',
]);

const AMPLIFICATION_CAUSE_TYPES = new Set([
  'gpu_fence',
  'render_wait',
]);

function toFiniteNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function collectFindingTextSources(finding: Finding): string {
  const textParts: string[] = [
    String(finding.title || ''),
    String(finding.description || ''),
  ];

  const evidence = (finding as FindingWithEvidence).evidence;
  const evidenceItems = Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []);
  for (const item of evidenceItems) {
    if (typeof item === 'string') {
      textParts.push(item);
      continue;
    }

    if (item && typeof item === 'object') {
      textParts.push(JSON.stringify(item).slice(0, 500));
    }
  }

  return textParts.join('\n');
}

function extractResponsibilityDistributionFromFindings(findings: Finding[]): {
  sfCount: number;
  sfPct: number;
  appCount: number;
  appPct: number;
} {
  let sfCount = 0;
  let sfPct = 0;
  let appCount = 0;
  let appPct = 0;

  const pairRe = /(SF|APP)\s+(\d+)\s*\((\d+(?:\.\d+)?)%\)/ig;

  for (const f of findings) {
    const text = collectFindingTextSources(f);
    for (const m of text.matchAll(pairRe)) {
      const side = String(m[1] || '').toUpperCase();
      const count = toFiniteNumber(m[2]);
      const pct = toFiniteNumber(m[3]);

      if (side === 'SF') {
        if (count > sfCount || (count === sfCount && pct > sfPct)) {
          sfCount = count;
          sfPct = pct;
        }
      } else if (side === 'APP') {
        if (count > appCount || (count === appCount && pct > appPct)) {
          appCount = count;
          appPct = pct;
        }
      }
    }
  }

  return { sfCount, sfPct, appCount, appPct };
}

function extractConsumerStatsFromFindings(findings: Finding[]): { frames: number; rate: number } {
  let frames = 0;
  let rate = 0;

  const textRe = /消费端\s*[:：]\s*(\d+)\s*帧\s*\((\d+(?:\.\d+)?)%\)/ig;

  for (const f of findings) {
    const details = (f.details && typeof f.details === 'object') ? f.details as Record<string, unknown> : {};
    const allSources = (details.allSources && typeof details.allSources === 'object')
      ? details.allSources as Record<string, unknown>
      : {};
    const consumer = allSources.consumer && typeof allSources.consumer === 'object'
      ? allSources.consumer as Record<string, unknown>
      : {};
    if (consumer.count !== undefined || consumer.rate !== undefined) {
      const c = toFiniteNumber(consumer.count);
      const r = toFiniteNumber(consumer.rate);
      if (c > frames || (c === frames && r > rate)) {
        frames = c;
        rate = r;
      }
    }

    const text = collectFindingTextSources(f);
    for (const m of text.matchAll(textRe)) {
      const c = toFiniteNumber(m[1]);
      const r = toFiniteNumber(m[2]);
      if (c > frames || (c === frames && r > rate)) {
        frames = c;
        rate = r;
      }
    }
  }

  return { frames, rate };
}

function deriveAttributionAssessment(
  findings: Finding[],
  jankSummary?: JankCauseSummary
): AttributionAssessment {
  const rationale: string[] = [];

  const frameSample = toFiniteNumber(jankSummary?.totalJankFrames);
  const allCauses = Array.isArray(jankSummary?.allCauses) ? jankSummary!.allCauses : [];

  let appLikePct = 0;
  let sfLikePct = 0;
  for (const c of allCauses) {
    const ct = String(c.causeType || '').toLowerCase();
    const pct = toFiniteNumber(c.percentage);
    if (APP_LIKE_CAUSE_TYPES.has(ct)) appLikePct += pct;
    if (SF_LIKE_CAUSE_TYPES.has(ct)) sfLikePct += pct;
  }

  const resp = extractResponsibilityDistributionFromFindings(findings);
  const consumer = extractConsumerStatsFromFindings(findings);

  let appScore = 0;
  let sfScore = 0;

  if (frameSample >= 3) {
    if (appLikePct >= 70) {
      appScore += 4;
      rationale.push(`逐帧根因中 APP/主线程侧占比 ${appLikePct.toFixed(1)}%`);
    } else if (appLikePct >= 50) {
      appScore += 3;
      rationale.push(`逐帧根因中 APP/主线程侧占比 ${appLikePct.toFixed(1)}%`);
    } else if (appLikePct > 0) {
      appScore += 1;
    }

    if (sfLikePct >= 70) {
      sfScore += 4;
      rationale.push(`逐帧根因中 SF/GPU 侧占比 ${sfLikePct.toFixed(1)}%`);
    } else if (sfLikePct >= 50) {
      sfScore += 3;
      rationale.push(`逐帧根因中 SF/GPU 侧占比 ${sfLikePct.toFixed(1)}%`);
    } else if (sfLikePct > 0) {
      sfScore += 1;
    }

    if (frameSample >= 10) {
      appScore += 1;
      sfScore += 1;
    } else {
      rationale.push(`逐帧样本量偏小（${frameSample} 帧）`);
    }
  } else if (frameSample > 0) {
    rationale.push(`逐帧样本不足（${frameSample} 帧）`);
  }

  if (resp.sfCount >= 20 && resp.sfPct >= 80) {
    sfScore += 2;
    rationale.push(`责任分布显示 SF ${resp.sfCount} 帧 (${resp.sfPct.toFixed(1)}%)`);
  } else if (resp.sfCount > 0) {
    rationale.push(`责任分布样本较小（SF ${resp.sfCount} 帧）`);
  }

  if (resp.appCount >= 5 && resp.appPct >= 30) {
    appScore += 1;
  }

  if (consumer.frames >= 100 && consumer.rate >= 50) {
    sfScore += 1;
    rationale.push(`全局消费端掉帧 ${consumer.frames} 帧 (${consumer.rate.toFixed(1)}%)`);
  } else if (consumer.frames > 0) {
    rationale.push(`消费端统计样本 ${consumer.frames} 帧 (${consumer.rate.toFixed(1)}%)`);
  }

  let verdict: AttributionVerdict = 'INSUFFICIENT';
  if (frameSample === 0 && resp.sfCount === 0 && consumer.frames === 0) {
    verdict = 'INSUFFICIENT';
  } else if (
    frameSample >= 3 &&
    appLikePct >= 60 &&
    (resp.sfPct >= 70 || consumer.rate >= 50)
  ) {
    verdict = 'MIXED';
  } else if (appScore >= sfScore + 2) {
    verdict = 'APP_TRIGGER';
  } else if (sfScore >= appScore + 2) {
    verdict = 'SF_CONSUMER';
  } else if (appScore > 0 && sfScore > 0) {
    verdict = 'MIXED';
  } else {
    verdict = 'INSUFFICIENT';
  }

  let confidence = 0.35;
  if (verdict !== 'INSUFFICIENT') {
    const sampleBoost = frameSample >= 10 ? 0.15 : frameSample >= 3 ? 0.08 : 0;
    const respBoost = resp.sfCount >= 20 ? 0.08 : 0;
    const consumerBoost = consumer.frames >= 100 ? 0.05 : 0;
    const scoreGapBoost = Math.min(0.15, Math.abs(appScore - sfScore) * 0.03);
    confidence = Math.min(0.9, 0.5 + sampleBoost + respBoost + consumerBoost + scoreGapBoost);
  }

  return {
    verdict,
    confidence,
    frameSample,
    appLikePct,
    sfLikePct,
    sfRespSample: resp.sfCount,
    sfRespPct: resp.sfPct,
    appRespSample: resp.appCount,
    appRespPct: resp.appPct,
    consumerFrames: consumer.frames,
    consumerRate: consumer.rate,
    rationale,
  };
}

function getAllCauses(
  jankSummary?: JankCauseSummary
): Array<{ causeType: string; label: string; percentage: number; frameCount: number }> {
  if (!jankSummary || !Array.isArray(jankSummary.allCauses)) {
    return [];
  }
  return jankSummary.allCauses.map(c => ({
    causeType: String(c.causeType || '').toLowerCase(),
    label: String(c.label || c.causeType || 'unknown'),
    percentage: toFiniteNumber(c.percentage),
    frameCount: toFiniteNumber(c.frameCount),
  }));
}

function getCausePercentage(
  allCauses: Array<{ causeType: string; percentage: number }>,
  causeType: string
): number {
  const row = allCauses.find(c => c.causeType === causeType);
  return row ? row.percentage : 0;
}

function getTopCauseByGroup(
  allCauses: Array<{ causeType: string; label: string; percentage: number; frameCount: number }>,
  group: Set<string>
): { causeType: string; label: string; percentage: number; frameCount: number } | null {
  const candidates = allCauses.filter(c => group.has(c.causeType));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.percentage - a.percentage);
  return candidates[0];
}

function getTopClusterHints(
  jankSummary?: JankCauseSummary
): string[] {
  const clusters = jankSummary?.clusters;
  if (!Array.isArray(clusters) || clusters.length === 0) {
    return [];
  }

  return clusters.slice(0, 3).map((cluster: JankCluster) => {
    const id = String(cluster.clusterId || 'K?');
    const trigger = String(cluster.triggerFactor || 'unknown');
    const supply = String(cluster.supplyConstraint || 'unknown');
    const amp = String(cluster.amplificationPath || 'unknown');
    const count = toFiniteNumber(cluster.frameCount);
    const pct = toFiniteNumber(cluster.percentage).toFixed(1);
    return `${id}: ${trigger} / ${supply} / ${amp}（${count}帧, ${pct}%）`;
  });
}

function getWorkloadDominantCluster(
  jankSummary?: JankCauseSummary
): {
  clusterId: string;
  frameCount: number;
  percentage: number;
  frameIds: string[];
  samplePrimaryCauses: string[];
} | null {
  const clusters = jankSummary?.clusters;
  if (!Array.isArray(clusters) || clusters.length === 0) {
    return null;
  }

  const dominant = clusters.find((cluster: JankCluster) => {
    const supply = String(cluster?.supplyConstraint || '').trim();
    return supply === SUPPLY_WORKLOAD_WEAK_TEXT;
  });

  if (!dominant) {
    return null;
  }

  return {
    clusterId: String(dominant.clusterId || 'K?'),
    frameCount: toFiniteNumber(dominant.frameCount),
    percentage: toFiniteNumber(dominant.percentage),
    frameIds: readClusterFrameIds(dominant),
    samplePrimaryCauses: Array.isArray(dominant.samplePrimaryCauses)
      ? dominant.samplePrimaryCauses.map((v: unknown) => String(v)).filter(Boolean).slice(0, 2)
      : [],
  };
}

function readClusterFrameIds(cluster: Pick<JankCluster, 'representativeFrames'> & { frameIds?: unknown }): string[] {
  const rawFrameIds = Array.isArray(cluster.frameIds)
    ? cluster.frameIds
    : (Array.isArray(cluster.representativeFrames) ? cluster.representativeFrames : []);
  return Array.from(new Set(rawFrameIds.map((v: unknown) => String(v)).filter(Boolean)));
}

function resolveClusterFrameLimit(
  mode: ConclusionClusterFrameListMode,
  maxFramesPerCluster?: number
): number {
  if (mode === 'none') return 0;
  if (Number.isFinite(maxFramesPerCluster) && (maxFramesPerCluster || 0) > 0) {
    return Math.round(maxFramesPerCluster as number);
  }
  return mode === 'top'
    ? DEFAULT_TOP_CLUSTER_FRAME_RENDER_LIMIT
    : DEFAULT_FULL_CLUSTER_FRAME_RENDER_LIMIT;
}

function applyClusterFrameListMode(
  frameIds: string[],
  mode: ConclusionClusterFrameListMode,
  maxFramesPerCluster?: number
): { frameIds: string[]; omittedCount: number } {
  if (mode === 'none') return { frameIds: [], omittedCount: 0 };
  const limit = resolveClusterFrameLimit(mode, maxFramesPerCluster);
  const selected = frameIds.slice(0, limit);
  return {
    frameIds: selected,
    omittedCount: Math.max(0, frameIds.length - selected.length),
  };
}

function buildClusterFrameAggregationLines(
  jankSummary: JankCauseSummary | undefined,
  frameListMode: ConclusionClusterFrameListMode,
  maxFramesPerCluster?: number
): string[] {
  if (frameListMode === 'none') {
    return [];
  }
  const clusters = jankSummary?.clusters;
  if (!Array.isArray(clusters) || clusters.length === 0) {
    return [];
  }

  const totalFrames = toFiniteNumber(jankSummary?.totalJankFrames);
  const lines: string[] = [];
  const modeLabel = frameListMode === 'full' ? '全量帧' : 'Top帧';
  lines.push(`- 聚类帧聚合（${modeLabel}，覆盖 ${totalFrames} 帧）`);

  for (const cluster of clusters) {
    const clusterId = String(cluster.clusterId || 'K?');
    const clusterFrameCount = toFiniteNumber(cluster.frameCount);
    const selection = applyClusterFrameListMode(
      readClusterFrameIds(cluster),
      frameListMode,
      maxFramesPerCluster
    );
    const frameList = selection.frameIds.length > 0 ? selection.frameIds.join(' / ') : '无可用帧ID';
    const omissionHint = selection.omittedCount > 0
      ? `（其余 ${selection.omittedCount} 帧省略）`
      : '';
    lines.push(`- ${clusterId}（${clusterFrameCount}帧）: ${frameList}${omissionHint}`);
  }

  return lines;
}

function injectAllJankFrameAggregation(
  markdown: string,
  jankSummary: JankCauseSummary | undefined,
  frameListMode: ConclusionClusterFrameListMode,
  maxFramesPerCluster?: number
): string {
  if (/聚类帧聚合（/.test(markdown)) {
    return markdown;
  }

  const aggregationLines = buildClusterFrameAggregationLines(
    jankSummary,
    frameListMode,
    maxFramesPerCluster
  );
  if (aggregationLines.length === 0) {
    return markdown;
  }

  const clusterSection = findMarkdownSection(
    String(markdown || ''),
    /^##\s*(?:掉帧聚类（先看大头）|掉帧聚类|聚类（先看大头）|聚类)\s*$/m
  );
  if (!clusterSection) {
    return markdown;
  }

  const originalBody = clusterSection.body;
  const trimmedBody = originalBody.trimStart();
  const nextBody = `${aggregationLines.join('\n')}\n${trimmedBody}`;
  return `${markdown.slice(0, clusterSection.bodyStart)}${nextBody}${markdown.slice(clusterSection.bodyEnd)}`;
}

function injectWorkloadDominantClusterMarker(
  markdown: string,
  jankSummary?: JankCauseSummary
): string {
  const cluster = getWorkloadDominantCluster(jankSummary);
  if (!cluster) {
    return markdown;
  }

  if (/负载主导簇:/.test(markdown)) {
    return markdown;
  }

  const repFramesText = cluster.frameIds.length > 0
    ? `；聚合帧: ${cluster.frameIds.join(' / ')}`
    : '';
  const sampleCauseText = cluster.samplePrimaryCauses.length > 0
    ? `；关键切片: ${cluster.samplePrimaryCauses.join('；')}`
    : '';
  const marker = `- 负载主导簇: ${cluster.clusterId}（${cluster.frameCount}帧, ${cluster.percentage.toFixed(1)}%），该簇以 APP 侧工作负载触发为主，资源问题信号较弱${repFramesText}${sampleCauseText}。`;
  const lines = String(markdown || '').split('\n');

  const headingPatterns = [
    /^##\s*结论（按可能性排序）\s*$/,
    /^##\s*结论\s*$/,
    /^结论\s*[:：]\s*$/,
    /^\*\*conclusion:\*\*\s*$/i,
    /^conclusion\s*:\s*$/i,
  ];

  for (let i = 0; i < lines.length; i += 1) {
    if (headingPatterns.some(re => re.test(lines[i] || ''))) {
      let insertAt = i + 1;
      while (insertAt < lines.length && (lines[insertAt] || '').trim() === '') {
        insertAt += 1;
      }
      lines.splice(insertAt, 0, marker);
      return lines.join('\n');
    }
  }

  return markdown;
}

function summarizeSupplyConstraintsFromRecords(
  frameMechanismRecords: FrameMechanismRecord[]
): {
  breakdown: Array<{ constraint: string; count: number; percentage: number }>;
  totalFrames: number;
  constrainedFrames: number;
} {
  if (!Array.isArray(frameMechanismRecords) || frameMechanismRecords.length === 0) {
    return {
      breakdown: [],
      totalFrames: 0,
      constrainedFrames: 0,
    };
  }

  const counter = new Map<string, number>();
  const totalFrames = frameMechanismRecords.length;
  for (const record of frameMechanismRecords) {
    const raw = typeof record.supplyConstraint === 'string' ? record.supplyConstraint.trim() : '';
    if (!raw || raw === 'none') continue;
    counter.set(raw, (counter.get(raw) || 0) + 1);
  }

  const constrainedFrames = Array.from(counter.values()).reduce((sum, v) => sum + v, 0);
  if (constrainedFrames === 0) {
    return {
      breakdown: [],
      totalFrames,
      constrainedFrames,
    };
  }

  return {
    breakdown: Array.from(counter.entries())
      .map(([constraint, count]) => ({
        constraint,
        count,
        percentage: Math.round((count / totalFrames) * 1000) / 10,
      }))
      .sort((a, b) => b.count - a.count),
    totalFrames,
    constrainedFrames,
  };
}

function supplyConstraintLabel(constraint: string): string {
  switch (constraint) {
    case 'load_high': return '负载偏高';
    case 'frequency_insufficient': return '频率不足';
    case 'scheduling_delay': return '调度延迟';
    case 'core_placement': return '核心摆放偏小核';
    case 'blocking_wait': return '阻塞等待';
    default: return constraint;
  }
}

function buildSupplyEvidence(params: {
  recordSupplyParts: string[];
  supplyFromRecords: {
    totalFrames: number;
    constrainedFrames: number;
  };
  supplyParts: string[];
  supplyTop: { causeType: string; percentage: number } | null;
  frameSample: number;
}): string {
  const {
    recordSupplyParts,
    supplyFromRecords,
    supplyParts,
    supplyTop,
    frameSample,
  } = params;

  if (recordSupplyParts.length > 0) {
    return `逐帧结构化资源问题: ${recordSupplyParts.join('；')}（命中 ${supplyFromRecords.constrainedFrames}/${supplyFromRecords.totalFrames} 帧）`;
  }

  if (supplyFromRecords.totalFrames > 0) {
    return `逐帧结构化资源问题命中较低（${supplyFromRecords.constrainedFrames}/${supplyFromRecords.totalFrames} 帧）`;
  }

  if (supplyParts.length > 0) {
    return `资源问题信号: ${supplyParts.join('；')}`;
  }

  if (supplyTop) {
    return `逐帧资源问题主因=${supplyTop.causeType}，占比 ${supplyTop.percentage.toFixed(1)}%`;
  }

  return `资源问题样本不足（逐帧样本 ${frameSample}）`;
}

function deriveMechanismTriad(
  assessment: AttributionAssessment,
  jankSummary?: JankCauseSummary,
  frameMechanismRecords: FrameMechanismRecord[] = []
): MechanismTriad {
  const allCauses = getAllCauses(jankSummary);
  const triggerTop = getTopCauseByGroup(allCauses, TRIGGER_CAUSE_TYPES);
  const supplyTop = getTopCauseByGroup(allCauses, SUPPLY_CAUSE_TYPES);
  const amplificationTop = getTopCauseByGroup(allCauses, AMPLIFICATION_CAUSE_TYPES);
  const supplyFromRecords = summarizeSupplyConstraintsFromRecords(frameMechanismRecords);

  const freqPct = getCausePercentage(allCauses, 'freq_limit');
  const smallCorePct = getCausePercentage(allCauses, 'small_core');
  const schedPct = getCausePercentage(allCauses, 'sched_latency');
  const contentionPct = getCausePercentage(allCauses, 'cpu_contention');
  const overloadPct = getCausePercentage(allCauses, 'cpu_overload');

  let trigger = '未形成稳定触发证据';
  if (triggerTop) {
    trigger = `${triggerTop.label}（占比 ${triggerTop.percentage.toFixed(1)}%）`;
  } else if (assessment.appLikePct >= 30) {
    trigger = `APP/主线程侧信号存在（占比 ${assessment.appLikePct.toFixed(1)}%）`;
  }

  const supplyParts: string[] = [];
  if (overloadPct >= 10) supplyParts.push(`负载偏高 ${overloadPct.toFixed(1)}%`);
  if (freqPct >= 10) supplyParts.push(`频率不足 ${freqPct.toFixed(1)}%`);
  if (schedPct >= 10) supplyParts.push(`调度延迟 ${schedPct.toFixed(1)}%`);
  if (smallCorePct >= 10) supplyParts.push(`核心摆放偏小核 ${smallCorePct.toFixed(1)}%`);
  if (contentionPct >= 10) supplyParts.push(`CPU 争抢 ${contentionPct.toFixed(1)}%`);
  const recordSupplyParts = supplyFromRecords.breakdown.slice(0, 2)
    .map(s => `${supplyConstraintLabel(s.constraint)} ${s.percentage.toFixed(1)}%`);
  let supply = '暂无明显资源问题证据';
  if (recordSupplyParts.length > 0) {
    supply = recordSupplyParts.join('；');
    if (supplyFromRecords.constrainedFrames < supplyFromRecords.totalFrames) {
      supply += `（覆盖 ${supplyFromRecords.constrainedFrames}/${supplyFromRecords.totalFrames} 帧）`;
    }
  } else if (supplyFromRecords.totalFrames > 0) {
    supply = `资源问题不明显（命中 ${supplyFromRecords.constrainedFrames}/${supplyFromRecords.totalFrames} 帧）`;
  } else if (supplyParts.length > 0) {
    supply = supplyParts.join('；');
  } else if (supplyTop) {
    supply = `${supplyTop.label}（占比 ${supplyTop.percentage.toFixed(1)}%）`;
  } else if (assessment.frameSample > 0) {
    supply = '资源问题信号较弱或样本不足';
  }

  let amplification = '未观察到稳定放大因素证据';
  if (amplificationTop) {
    amplification = `${amplificationTop.label}（逐帧占比 ${amplificationTop.percentage.toFixed(1)}%）`;
  } else if (assessment.sfRespPct >= 50 || assessment.consumerRate >= 30) {
    amplification = `SF/消费端放大信号存在（责任分布 SF ${assessment.sfRespPct.toFixed(1)}%，消费端 ${assessment.consumerRate.toFixed(1)}%）`;
  }

  const triggerEvidence = triggerTop
    ? `逐帧 cause_type=${triggerTop.causeType}，样本占比 ${triggerTop.percentage.toFixed(1)}%`
    : `逐帧 APP/主线程侧累计占比 ${assessment.appLikePct.toFixed(1)}%`;

  const supplyEvidence = buildSupplyEvidence({
    recordSupplyParts,
    supplyFromRecords,
    supplyParts,
    supplyTop,
    frameSample: assessment.frameSample,
  });

  const amplificationEvidence = amplificationTop
    ? `逐帧放大因素主因=${amplificationTop.causeType}，占比 ${amplificationTop.percentage.toFixed(1)}%`
    : `责任分布 SF ${assessment.sfRespSample} 帧 (${assessment.sfRespPct.toFixed(1)}%)，消费端 ${assessment.consumerFrames} 帧 (${assessment.consumerRate.toFixed(1)}%)`;

  return {
    trigger,
    supply,
    amplification,
    triggerEvidence,
    supplyEvidence,
    amplificationEvidence,
  };
}

function buildMechanismTriadPromptSection(
  assessment: AttributionAssessment,
  jankSummary?: JankCauseSummary,
  frameMechanismRecords: FrameMechanismRecord[] = []
): string {
  const triad = deriveMechanismTriad(assessment, jankSummary, frameMechanismRecords);
  const clusterHints = getTopClusterHints(jankSummary);
  const lines: string[] = [];

  lines.push(`## ${TRIAD_HEADING}`);
  lines.push(`- ${TRIAD_LABELS.trigger}: ${triad.trigger}`);
  lines.push(`- ${TRIAD_LABELS.supply}: ${triad.supply}`);
  lines.push(`- ${TRIAD_LABELS.amplification}: ${triad.amplification}`);
  if (clusterHints.length > 0) {
    lines.push('- 聚类优先级（先治大头）:');
    for (const hint of clusterHints) {
      lines.push(`  - ${hint}`);
    }
  }
  lines.push('- 回答要求: 明确区分“APP 触发层”与“SF 消费放大层”，不要只给“主线程100%”结论。');

  return lines.join('\n');
}

function verdictToChinese(verdict: AttributionVerdict): string {
  switch (verdict) {
    case 'APP_TRIGGER': return 'APP/主线程触发主导';
    case 'SF_CONSUMER': return 'SF/消费端主导';
    case 'MIXED': return '混合型（APP 触发 + SF 放大）';
    default: return '证据不足';
  }
}

function buildAttributionAssessmentPromptSection(a: AttributionAssessment): string {
  const lines: string[] = [];
  lines.push('## 掉帧归因裁决（规则预判）');
  lines.push(`- 预判结论: ${verdictToChinese(a.verdict)}（置信度 ${Math.round(a.confidence * 100)}%）`);
  lines.push(`- 逐帧根因样本: ${a.frameSample} 帧，APP/主线程侧 ${a.appLikePct.toFixed(1)}%，SF/GPU 侧 ${a.sfLikePct.toFixed(1)}%`);
  lines.push(`- 责任分布样本: SF ${a.sfRespSample} 帧 (${a.sfRespPct.toFixed(1)}%)，APP ${a.appRespSample} 帧 (${a.appRespPct.toFixed(1)}%)`);
  lines.push(`- 消费端统计: ${a.consumerFrames} 帧 (${a.consumerRate.toFixed(1)}%)`);
  if (a.rationale.length > 0) {
    for (const r of a.rationale.slice(0, 4)) lines.push(`- 依据: ${r}`);
  }
  lines.push('- 结论约束: 必须与预判一致；若存在冲突，优先保守表述为“混合型/证据不足”。');
  return lines.join('\n');
}

function isConclusionContradictingAttributionVerdict(
  conclusion: string,
  assessment: AttributionAssessment
): boolean {
  const t = String(conclusion || '');
  if (!t.trim()) return false;

  const sfOverclaimPatterns = [
    /主要由\s*SF.*导致.*而非\s*App主线程/i,
    /主要由\s*SurfaceFlinger.*导致.*而非\s*App主线程/i,
    /问题主要在\s*SurfaceFlinger.*而非\s*App/i,
    /非\s*App主线程.*根因/i,
  ];

  const appOverclaimPatterns = [
    /主要由\s*主线程.*导致/i,
    /主线程.*是主要根因/i,
    /APP.*主因.*占主导/i,
  ];

  if (assessment.verdict === 'APP_TRIGGER' || assessment.verdict === 'MIXED') {
    return sfOverclaimPatterns.some(re => re.test(t));
  }

  if (assessment.verdict === 'SF_CONSUMER') {
    return appOverclaimPatterns.some(re => re.test(t));
  }

  return false;
}

function generateAttributionSafeFallback(
  assessment: AttributionAssessment,
  findings: Finding[],
  contradictionReasons: string[],
  stopReason?: string,
  jankSummary?: JankCauseSummary,
  frameMechanismRecords: FrameMechanismRecord[] = []
): string {
  const usableFindings = findings.filter(f => !f.details?._contradicted);
  const evidenceCandidates = usableFindings
    .map(f => ({ finding: f, evIds: extractEvidenceIdsFromFinding(f) }))
    .filter(c => c.evIds.length > 0);
  const usedEv = new Set<string>();
  const takeEvidenceTag = (preferredIndex: number): string => {
    if (evidenceCandidates.length === 0) return '';
    const ordered = [
      preferredIndex,
      ...evidenceCandidates.map((_, i) => i).filter(i => i !== preferredIndex),
    ].filter(i => i >= 0 && i < evidenceCandidates.length);

    for (const idx of ordered) {
      const c = evidenceCandidates[idx];
      if (!c) continue;
      const fresh = c.evIds.filter(id => !usedEv.has(id)).slice(0, 2);
      const finalIds = fresh.length > 0 ? fresh : c.evIds.slice(0, 1);
      if (finalIds.length > 0) {
        for (const id of finalIds) usedEv.add(id);
        return `（${finalIds.join('|')}）`;
      }
    }
    return '';
  };
  const c1EvTag = takeEvidenceTag(0);
  const c2EvTag = takeEvidenceTag(1);
  const c3EvTag = takeEvidenceTag(2);
  const mechanismTriad = deriveMechanismTriad(assessment, jankSummary, frameMechanismRecords);
  const clusterHints = getTopClusterHints(jankSummary);

  const lines: string[] = [];
  const topFinding = usableFindings[0] || findings[0];
  const topTitle = topFinding?.title ? String(topFinding.title) : '当前证据摘要';

  lines.push('## 结论（按可能性排序）');
  if (assessment.verdict === 'APP_TRIGGER') {
    lines.push(`1. 更可能是 APP/主线程侧触发掉帧，消费端表现为放大层（置信度: ${Math.round(assessment.confidence * 100)}%）。`);
    lines.push('2. SF/消费端异常仍可能参与，但当前不是唯一主因（置信度: 55%）。');
  } else if (assessment.verdict === 'SF_CONSUMER') {
    lines.push(`1. 更可能是 SF/消费端侧主导，APP 侧证据不足以证明主因（置信度: ${Math.round(assessment.confidence * 100)}%）。`);
    lines.push('2. 仍需排查少量 APP 侧长耗时帧是否触发了局部异常（置信度: 45%）。');
  } else if (assessment.verdict === 'MIXED') {
    lines.push(`1. 这是混合型掉帧：APP/主线程触发与 SF/消费端放大同时存在（置信度: ${Math.round(assessment.confidence * 100)}%）。`);
    lines.push('2. 不能仅用“SF 主因”或“APP 主因”单侧表述覆盖全链路（置信度: 60%）。');
  } else {
    lines.push('1. 当前证据不足以给出单一主因结论（置信度: 35%）。');
  }
  lines.push(`- ${TRIAD_LABELS.trigger}: ${mechanismTriad.trigger}`);
  lines.push(`- ${TRIAD_LABELS.supply}: ${mechanismTriad.supply}`);
  lines.push(`- ${TRIAD_LABELS.amplification}: ${mechanismTriad.amplification}`);
  lines.push('');

  lines.push('## 聚类（先看大头）');
  if (clusterHints.length > 0) {
    for (const hint of clusterHints) {
      lines.push(`- ${hint}`);
    }
  } else {
    lines.push('- 当前缺少可用聚类结果，建议先补足逐帧样本（>=20 帧）。');
  }
  lines.push('');

  lines.push('## 证据链（对应上述结论）');
  lines.push(`- C1: ${TRIAD_EVIDENCE_LABELS.trigger}：${mechanismTriad.triggerEvidence}${c1EvTag ? ` ${c1EvTag}` : ''}`);
  lines.push(`- C2: ${TRIAD_EVIDENCE_LABELS.supply}：${mechanismTriad.supplyEvidence}${c2EvTag ? ` ${c2EvTag}` : ''}`);
  lines.push(`- C3: ${TRIAD_EVIDENCE_LABELS.amplification}：${mechanismTriad.amplificationEvidence}；Finding=${topTitle}${c3EvTag ? ` ${c3EvTag}` : ''}`);
  lines.push('');

  lines.push('## 不确定性与反例');
  if (assessment.rationale.length > 0) {
    for (const r of assessment.rationale.slice(0, 3)) lines.push(`- ${r}`);
  } else {
    lines.push('- 当前缺少同口径、同时间窗的补充证据。');
  }
  if (contradictionReasons.length > 0) {
    lines.push(`- 检测到矛盾: ${contradictionReasons.slice(0, 2).join('；')}`);
  }
  if (stopReason) {
    lines.push(`- 备注：本轮提前结束（${stopReason}）。`);
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  lines.push('- 在同一时间窗扩大逐帧样本（建议 >= 20 帧），重新计算 cause_type 占比。');
  lines.push('- 对主线程长耗时帧与消费端 token_gap/vsync_missed 做时间重叠验证。');

  return lines.join('\n');
}

function finalizeConclusionMarkdown(
  markdown: string,
  findings: Finding[],
  jankSummary?: JankCauseSummary,
  options: { singleFrameDrillDown?: boolean; scenePromptHints?: ConclusionScenePromptHints } = {}
): string {
  const withPerConclusionMapping = injectPerConclusionEvidenceMapping(markdown, findings);
  const withEvidenceIndex = injectEvidenceIndexIntoEvidenceChain(withPerConclusionMapping, findings);
  const withTriadAligned = options.singleFrameDrillDown
    ? injectSingleFrameRootCauseTriad(withEvidenceIndex, findings)
    : withEvidenceIndex;
  const withEvidenceAligned = options.singleFrameDrillDown
    ? injectSingleFrameRootCauseEvidenceChain(withTriadAligned, findings)
    : withTriadAligned;
  const withHumanReadable = options.singleFrameDrillDown
    ? injectSingleFrameHumanReadableConclusion(withEvidenceAligned, findings)
    : withEvidenceAligned;
  const withDeepReason = injectDeepReasonIntoConclusionSection(withHumanReadable, findings);
  const shouldInjectClusterAggregation = Boolean(options.scenePromptHints?.clusterPolicy.injectClusterFrameAggregation);
  const withClusterAggregation = shouldInjectClusterAggregation
    ? injectAllJankFrameAggregation(
      withDeepReason,
      jankSummary,
      options.scenePromptHints?.clusterPolicy.frameListMode || 'none',
      options.scenePromptHints?.clusterPolicy.maxFramesPerCluster
    )
    : withDeepReason;
  const shouldInjectWorkloadDominant = Boolean(options.scenePromptHints?.clusterPolicy.injectWorkloadDominantMarker);
  const withWorkloadDominant = shouldInjectWorkloadDominant
    ? injectWorkloadDominantClusterMarker(withClusterAggregation, jankSummary)
    : withClusterAggregation;
  return injectSystemContextActionItems(withWorkloadDominant, findings);
}

interface SystemContextActionItem {
  owner: string;
  priority: 'P0' | 'P1' | 'P2';
  action: string;
  verification: string;
}

function extractDirectSkillIdFromFindingSource(source?: string): string | null {
  const match = String(source || '').trim().match(/^direct_skill:([a-zA-Z0-9_.-]+)/i);
  return match ? String(match[1]).toLowerCase() : null;
}

function severityToActionPriority(severity: Finding['severity'] | undefined): 'P0' | 'P1' | 'P2' {
  const normalized = String(severity || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'high') return 'P0';
  if (normalized === 'warning' || normalized === 'medium') return 'P1';
  return 'P2';
}

function normalizeActionPriority(raw: unknown, fallbackSeverity: Finding['severity'] | undefined): 'P0' | 'P1' | 'P2' {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 1) return 'P0';
    if (raw <= 3) return 'P1';
    return 'P2';
  }

  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return severityToActionPriority(fallbackSeverity);

  if (/p0\b|critical|urgent|highest|高优|紧急|严重/.test(normalized)) return 'P0';
  if (/p1\b|warning|medium|中优|中等|警告/.test(normalized)) return 'P1';
  if (/p2\b|info|low|低优|低风险/.test(normalized)) return 'P2';

  const asNumber = Number(normalized);
  if (Number.isFinite(asNumber)) {
    if (asNumber <= 1) return 'P0';
    if (asNumber <= 3) return 'P1';
    return 'P2';
  }

  return severityToActionPriority(fallbackSeverity);
}

function readFirstStringFromRecord(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function truncateActionItemText(text: string, maxLength = 120): string {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeActionLineForDedupe(line: string): string {
  return String(line || '')
    .toLowerCase()
    .replace(/[\s;；:：,，()（）\[\]{}"'`]/g, '')
    .trim();
}

function isActionableSystemFinding(finding: Finding): boolean {
  const details = (finding.details && typeof finding.details === 'object')
    ? finding.details as Record<string, unknown>
    : null;
  const hasExplicitSystemContext = Boolean(
    (details && (details.system_context || details.systemContext))
    || readFirstStringFromRecord(details, ['owner', 'priority', 'verification', 'action'])
  );
  const directSkillId = extractDirectSkillIdFromFindingSource(finding.source);
  const hasSystemSkillHint = Boolean(directSkillId && SYSTEM_CONTEXT_SKILL_HINTS[directSkillId]);
  if (!hasExplicitSystemContext && !hasSystemSkillHint) return false;

  const severity = String(finding.severity || '').toLowerCase();
  if (severity === 'critical' || severity === 'warning' || severity === 'high' || severity === 'medium') {
    return true;
  }

  const text = `${String(finding.title || '')}\n${String(finding.description || '')}`;
  if (/严重|偏高|风险|瓶颈|阻塞|过大|节流|异常/i.test(text)) {
    return true;
  }
  if (/正常|良好|无明显|未检测到/i.test(text)) {
    return false;
  }

  return severity !== 'info' && severity !== 'low';
}

function buildSystemContextActionItem(finding: Finding): SystemContextActionItem | null {
  if (!isActionableSystemFinding(finding)) {
    return null;
  }

  const details = (finding.details && typeof finding.details === 'object')
    ? finding.details as Record<string, unknown>
    : null;
  const systemContextRecord = (() => {
    if (!details) return null;
    if (details.system_context && typeof details.system_context === 'object' && !Array.isArray(details.system_context)) {
      return details.system_context as Record<string, unknown>;
    }
    if (details.systemContext && typeof details.systemContext === 'object' && !Array.isArray(details.systemContext)) {
      return details.systemContext as Record<string, unknown>;
    }
    return null;
  })();

  const directSkillId = extractDirectSkillIdFromFindingSource(finding.source);
  const hint = directSkillId ? SYSTEM_CONTEXT_SKILL_HINTS[directSkillId] : undefined;

  const owner = readFirstStringFromRecord(systemContextRecord, ['owner', '责任人'])
    || readFirstStringFromRecord(details, ['owner', '责任人'])
    || hint?.owner
    || '性能优化负责人';

  const priorityRaw = readFirstStringFromRecord(systemContextRecord, ['priority', '优先级'])
    || readFirstStringFromRecord(details, ['priority', '优先级']);
  const priority = normalizeActionPriority(priorityRaw, finding.severity);

  const actionRaw = readFirstStringFromRecord(systemContextRecord, ['action', 'next_action', 'nextStep', '建议'])
    || readFirstStringFromRecord(details, ['action', 'next_action', 'nextStep', '建议']);
  const fallbackAction = String(finding.title || finding.description || '推进系统性能优化动作')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim();
  const action = truncateActionItemText(actionRaw || fallbackAction || '推进系统性能优化动作');

  const verification = readFirstStringFromRecord(systemContextRecord, ['verification', 'verify', '验收标准', '验证'])
    || readFirstStringFromRecord(details, ['verification', 'verify', '验收标准', '验证'])
    || hint?.verification
    || '复跑同时间窗 trace，确认对应指标改善且无回归';

  return { owner, priority, action, verification: truncateActionItemText(verification, 140) };
}

function buildSystemContextActionItems(findings: Finding[]): string[] {
  const candidates = findings
    .map(buildSystemContextActionItem)
    .filter((item): item is SystemContextActionItem => Boolean(item));
  if (candidates.length === 0) return [];

  const priorityRank: Record<'P0' | 'P1' | 'P2', number> = { P0: 0, P1: 1, P2: 2 };
  candidates.sort((a, b) => {
    const pa = priorityRank[a.priority];
    const pb = priorityRank[b.priority];
    if (pa !== pb) return pa - pb;
    return a.action.localeCompare(b.action, 'zh-CN');
  });

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const line = `owner: ${item.owner}; priority: ${item.priority}; action: ${item.action}; verification: ${item.verification}`;
    const key = normalizeActionLineForDedupe(line);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }

  return deduped.slice(0, 3);
}

function injectSystemContextActionItems(markdown: string, findings: Finding[]): string {
  const text = String(markdown || '');
  if (!text.trim()) return text;

  const nextStepSection = findMarkdownSection(text, /^##\s*下一步[（(]最高信息增益[）)]\s*$/m);
  if (!nextStepSection) return text;

  const actionItems = buildSystemContextActionItems(findings);
  if (actionItems.length === 0) return text;

  const existingEntries = extractListEntriesFromSectionBody(nextStepSection.body);
  if (existingEntries.some(entry => STRUCTURED_ACTION_ITEM_RE.test(entry))) {
    return text;
  }

  const existingKeys = new Set(existingEntries.map(normalizeActionLineForDedupe));
  const injectedLines = actionItems
    .filter(item => !existingKeys.has(normalizeActionLineForDedupe(item)))
    .map(item => `- ${item}`);

  if (injectedLines.length === 0) return text;

  const existingBodyLines = String(nextStepSection.body || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\s*(?:-\s*)?暂无\s*$/i.test(line));

  const mergedBody = [...injectedLines, ...existingBodyLines];
  const replacement = `${mergedBody.join('\n')}\n`;
  return `${text.slice(0, nextStepSection.bodyStart)}${replacement}${text.slice(nextStepSection.bodyEnd)}`;
}

function normalizeHintText(text: string): string {
  const deepReasonPrefix = new RegExp(`^(?:${DEEP_REASON_ALIASES.join('|')})\\s*[:：]\\s*`, 'i');
  return String(text || '')
    .trim()
    .replace(new RegExp(`^${OPTIMIZATION_LABEL}\\s*[:：]\\s*`, 'i'), '')
    .replace(deepReasonPrefix, '')
    .trim();
}

function extractDeepReasonHints(findings: Finding[]): { deepReason?: string; optimizationHint?: string } {
  for (const finding of findings) {
    if (!finding?.details || typeof finding.details !== 'object') continue;
    const details = finding.details as Record<string, unknown>;
    const deepReasonRaw = typeof details.deep_reason === 'string'
      ? details.deep_reason
      : (typeof details.secondary_info === 'string' ? details.secondary_info : '');
    const optimizationRaw = typeof details.optimization_hint === 'string' ? details.optimization_hint : '';

    const deepReason = normalizeHintText(deepReasonRaw);
    const optimizationHint = normalizeHintText(optimizationRaw);

    if (deepReason || optimizationHint) {
      return {
        ...(deepReason ? { deepReason } : {}),
        ...(optimizationHint ? { optimizationHint } : {}),
      };
    }
  }

  return {};
}

function injectDeepReasonIntoConclusionSection(markdown: string, findings: Finding[]): string {
  const hints = extractDeepReasonHints(findings);
  if (!hints.deepReason && !hints.optimizationHint) {
    return markdown;
  }

  const lines = String(markdown || '').split('\n');
  const headerIdx = lines.findIndex(line => /^##\s*结论（按可能性排序）\s*$/.test(line.trim()));
  if (headerIdx < 0) {
    return markdown;
  }

  let nextHeaderIdx = -1;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      nextHeaderIdx = i;
      break;
    }
  }

  const sectionEnd = nextHeaderIdx >= 0 ? nextHeaderIdx : lines.length;
  const sectionLines = lines.slice(headerIdx + 1, sectionEnd);
  const hasDeepReasonLine = sectionLines.some(line => new RegExp(`(?:${DEEP_REASON_ALIASES.join('|')})\\s*[:：]`).test(line));
  const hasOptimizationLine = sectionLines.some(line => new RegExp(`${OPTIMIZATION_LABEL}\\s*[:：]`).test(line));

  const inserts: string[] = [];
  if (hints.deepReason && !hasDeepReasonLine) {
    inserts.push(`- ${DEEP_REASON_LABEL}: ${hints.deepReason}`);
  }
  if (hints.optimizationHint && !hasOptimizationLine) {
    inserts.push(`- ${OPTIMIZATION_LABEL}: ${hints.optimizationHint}`);
  }
  if (inserts.length === 0) {
    return markdown;
  }

  if (sectionEnd > 0 && lines[sectionEnd - 1].trim() !== '') {
    inserts.push('');
  }
  lines.splice(sectionEnd, 0, ...inserts);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function supplyConstraintToConclusionText(constraintRaw: unknown, secondaryInfoRaw: unknown): string {
  const constraint = String(constraintRaw || '').trim();
  const secondaryInfo = normalizeMechanismPlainText(String(secondaryInfoRaw || '').trim());
  switch (constraint) {
    case 'blocking_wait':
      return secondaryInfo || '阻塞等待';
    case 'frequency_insufficient':
      return secondaryInfo || '频率不足';
    case 'scheduling_delay':
      return secondaryInfo || '调度延迟';
    case 'core_placement':
      return secondaryInfo || '核心摆放偏小核';
    case 'load_high':
      return secondaryInfo || 'CPU 负载偏高';
    case 'none':
      return SUPPLY_NONE_CURRENT_FRAME_TEXT;
    default:
      return secondaryInfo || (constraint ? constraint : SUPPLY_NONE_CURRENT_FRAME_TEXT);
  }
}

function amplificationPathToConclusionText(pathRaw: unknown): string {
  const path = normalizeMechanismPlainText(String(pathRaw || '').trim());
  switch (path) {
    case 'gpu_fence_wait':
      return 'GPU Fence 等待放大';
    case 'render_pipeline_wait':
      return 'RenderThread/RenderPipeline 等待放大';
    case 'sf_consumer_backpressure':
      return 'SF 消费端背压';
    case 'app_deadline_miss':
      return 'APP 截止超时';
    case 'unknown':
    default:
      return AMPLIFICATION_UNKNOWN_CURRENT_FRAME_TEXT;
  }
}

function parseOptionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function roundStr(value: number | undefined, digits = 2): string {
  if (value === undefined) return '-';
  return Number(value.toFixed(digits)).toString();
}

function confidenceToPercent(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    if (raw > 0 && raw <= 1) return Math.round(raw * 100);
    if (raw > 1 && raw <= 100) return Math.round(raw);
  }
  const text = String(raw || '').trim();
  if (!text) return undefined;
  if (/^高$/.test(text)) return 85;
  if (/^中$/.test(text)) return 70;
  if (/^低$/.test(text)) return 55;
  const n = Number(text.replace(/[%％]/g, ''));
  if (Number.isFinite(n)) return Math.round(n <= 1 ? n * 100 : n);
  return undefined;
}

function parsePrimaryCauseMetrics(primaryCauseRaw: unknown): {
  sliceName?: string;
  sliceDurMs?: number;
  frameBudgetMs?: number;
} {
  const text = String(primaryCauseRaw || '');
  const m = text.match(/主线程耗时操作\s+"([^"]+)"\s+占用\s+([0-9.]+)ms\s+\(帧预算\s+([0-9.]+)ms\)/);
  if (!m) return {};
  return {
    sliceName: m[1],
    sliceDurMs: parseOptionalNumber(m[2]),
    frameBudgetMs: parseOptionalNumber(m[3]),
  };
}

function collectSingleFrameFacts(details: Record<string, unknown>): {
  sliceName?: string;
  sliceDurMs?: number;
  frameBudgetMs?: number;
  mainQ3Pct?: number;
  mainQ4Pct?: number;
  gpuFenceMs?: number;
  confidencePct?: number;
  supplyText: string;
  amplificationText: string;
  triggerText: string;
} {
  const parsed = parsePrimaryCauseMetrics(details.primary_cause);
  const sliceName = String(details.slice_name || parsed.sliceName || '').trim() || undefined;
  const sliceDurMs = parseOptionalNumber(details.slice_dur) ?? parsed.sliceDurMs;
  const frameBudgetMs = parseOptionalNumber(details.frame_budget_ms) ?? parsed.frameBudgetMs;
  const mainQ3Pct = parseOptionalNumber(details.main_q3_pct);
  const mainQ4Pct = parseOptionalNumber(details.main_q4_pct);
  const gpuFenceMs = parseOptionalNumber(details.gpu_fence_ms);
  const confidencePct = confidenceToPercent(details.confidence_level ?? details.confidence);
  const triggerText = normalizeMechanismPlainText(String(details.primary_cause || '').trim());
  const supplyText = supplyConstraintToConclusionText(details.supply_constraint, details.secondary_info);
  const amplificationText = amplificationPathToConclusionText(details.amplification_path);

  return {
    sliceName,
    sliceDurMs,
    frameBudgetMs,
    mainQ3Pct,
    mainQ4Pct,
    gpuFenceMs,
    confidencePct,
    supplyText,
    amplificationText,
    triggerText,
  };
}

function normalizeMechanismPlainText(text: string): string {
  return normalizeLegacyTriadTerms(stripTriadPrefix(String(text || '').trim()))
    .replace(/\s+/g, ' ')
    .trim();
}

function pickBestRootCauseDetails(findings: Finding[]): Record<string, unknown> | null {
  const candidates = findings
    .filter(f => f?.details && typeof f.details === 'object' && typeof (f.details as Record<string, unknown>).primary_cause === 'string')
    .map(f => {
      const details = f.details as Record<string, unknown>;
      const primary = String(details.primary_cause || '');
      const title = String(f.title || '');
      let score = 0;
      if (primary && title.includes(primary)) score += 4;
      if (f.severity === 'critical') score += 2;
      if (Array.isArray(f.evidence) && f.evidence.length > 0) score += 1;
      return { details, score };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.details || null;
}

function injectSingleFrameRootCauseTriad(markdown: string, findings: Finding[]): string {
  const details = pickBestRootCauseDetails(findings);
  if (!details) return markdown;

  const trigger = normalizeMechanismPlainText(String(details.primary_cause || '').trim());
  if (!trigger) return markdown;
  const supply = supplyConstraintToConclusionText(details.supply_constraint, details.secondary_info);
  const amplification = amplificationPathToConclusionText(details.amplification_path);
  const triad = buildTriadStatement({ trigger, supply, amplification });

  const lines = String(markdown || '').split('\n');
  const headerIdx = lines.findIndex(line => /^##\s*结论（按可能性排序）\s*$/.test(line.trim()));
  if (headerIdx < 0) return markdown;

  let nextHeaderIdx = -1;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      nextHeaderIdx = i;
      break;
    }
  }
  const sectionEnd = nextHeaderIdx >= 0 ? nextHeaderIdx : lines.length;

  let replaced = false;
  for (let i = headerIdx + 1; i < sectionEnd; i += 1) {
    const raw = lines[i];
    if (
      !hasTriadRoleText(raw, 'trigger') ||
      !hasTriadRoleText(raw, 'supply') ||
      !hasTriadRoleText(raw, 'amplification')
    ) continue;
    const numbered = raw.match(/^(\s*\d+\.\s*)(.*)$/);
    const bullet = raw.match(/^(\s*-\s*)(.*)$/);
    const prefix = numbered?.[1] || bullet?.[1] || '';
    const content = numbered?.[2] || bullet?.[2] || raw.trim();
    const conf = content.match(/（置信度\s*[:：]?\s*\d+(?:\.\d+)?%?\）/)?.[0] || '';
    lines[i] = `${prefix}${triad}${conf}`.trimEnd();
    replaced = true;
    break;
  }

  if (!replaced) {
    let insertAt = headerIdx + 1;
    for (let i = headerIdx + 1; i < sectionEnd; i += 1) {
      if (/^\s*\d+\.\s+/.test(lines[i])) {
        insertAt = i + 1;
        break;
      }
    }
    lines.splice(insertAt, 0, `- ${triad}`);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function getSingleFrameEvidenceTag(findings: Finding[]): string {
  const evIds = findings
    .flatMap(f => extractEvidenceIdsFromFinding(f))
    .filter(Boolean);
  const deduped = [...new Set(evIds)].slice(0, 2);
  if (deduped.length === 0) {
    return '（证据ID缺失）';
  }
  return `（${deduped.join('|')}）`;
}

function injectSingleFrameRootCauseEvidenceChain(markdown: string, findings: Finding[]): string {
  const details = pickBestRootCauseDetails(findings);
  if (!details) return markdown;

  const facts = collectSingleFrameFacts(details);
  if (!facts.triggerText) return markdown;
  const evTag = getSingleFrameEvidenceTag(findings);

  const section = findMarkdownSection(markdown, /^##\s*证据链[（(]对应上述结论[）)]\s*$/m);
  if (!section) return markdown;

  const c1 = facts.sliceName && facts.sliceDurMs !== undefined && facts.frameBudgetMs !== undefined
    ? `主线程 ${facts.sliceName} 执行 ${roundStr(facts.sliceDurMs)}ms，超过帧预算 ${roundStr(facts.frameBudgetMs)}ms ${evTag}`
    : `${facts.triggerText} ${evTag}`;
  const q3Text = facts.mainQ3Pct !== undefined ? `Q3=${roundStr(facts.mainQ3Pct, 1)}%` : '';
  const q4Text = facts.mainQ4Pct !== undefined ? `Q4=${roundStr(facts.mainQ4Pct, 1)}%` : '';
  const supplyBasis = [q3Text, q4Text].filter(Boolean).join('，');
  const c2 = supplyBasis
    ? `${supplyBasis}，结论：${facts.supplyText} ${evTag}`
    : `${facts.supplyText} ${evTag}`;
  const c3 = facts.gpuFenceMs !== undefined
    ? `GPU Fence=${roundStr(facts.gpuFenceMs)}ms，结论：${facts.amplificationText} ${evTag}`
    : `${facts.amplificationText} ${evTag}`;

  const normalizedLines = [
    `- C1: ${TRIAD_EVIDENCE_LABELS.trigger}：${c1}`,
    `- C2: ${TRIAD_EVIDENCE_LABELS.supply}：${c2}`,
    `- C3: ${TRIAD_EVIDENCE_LABELS.amplification}：${c3}`,
  ];

  return `${markdown.slice(0, section.bodyStart)}${normalizedLines.join('\n')}\n${markdown.slice(section.bodyEnd)}`;
}

function injectSingleFrameHumanReadableConclusion(markdown: string, findings: Finding[]): string {
  const details = pickBestRootCauseDetails(findings);
  if (!details) return markdown;
  const facts = collectSingleFrameFacts(details);
  if (!facts.triggerText) return markdown;

  const lines = String(markdown || '').split('\n');
  const headerIdx = lines.findIndex(line => /^##\s*结论（按可能性排序）\s*$/.test(line.trim()));
  if (headerIdx < 0) return markdown;

  let nextHeaderIdx = -1;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      nextHeaderIdx = i;
      break;
    }
  }
  const sectionEnd = nextHeaderIdx >= 0 ? nextHeaderIdx : lines.length;

  const summary = facts.sliceName && facts.sliceDurMs !== undefined && facts.frameBudgetMs !== undefined
    ? `这帧主要卡在主线程 ${facts.sliceName}：单次 ${roundStr(facts.sliceDurMs)}ms，超过帧预算 ${roundStr(facts.frameBudgetMs)}ms。`
    : `这帧主要卡在主线程长耗时：${facts.triggerText}。`;
  const confSuffix = facts.confidencePct !== undefined ? `（置信度: ${facts.confidencePct}%）` : '';
  const triggerLine = `- ${TRIAD_LABELS.trigger}: ${facts.triggerText}`;
  const supplyLine = facts.mainQ3Pct !== undefined || facts.mainQ4Pct !== undefined
    ? `- ${TRIAD_LABELS.supply}: ${facts.supplyText}（主线程 Q3=${facts.mainQ3Pct !== undefined ? `${roundStr(facts.mainQ3Pct, 1)}%` : '未知'}，Q4=${facts.mainQ4Pct !== undefined ? `${roundStr(facts.mainQ4Pct, 1)}%` : '未知'}）`
    : `- ${TRIAD_LABELS.supply}: ${facts.supplyText}`;
  const amplificationLine = facts.gpuFenceMs !== undefined
    ? `- ${TRIAD_LABELS.amplification}: ${facts.amplificationText}（GPU Fence=${roundStr(facts.gpuFenceMs)}ms）`
    : `- ${TRIAD_LABELS.amplification}: ${facts.amplificationText}`;

  let firstItemIdx = -1;
  for (let i = headerIdx + 1; i < sectionEnd; i += 1) {
    if (/^\s*1\.\s+/.test(lines[i])) {
      firstItemIdx = i;
      break;
    }
  }
  if (firstItemIdx >= 0) {
    lines[firstItemIdx] = `1. ${summary}${confSuffix}`;
  }

  const cleanedSection = lines
    .slice(headerIdx + 1, sectionEnd)
    .filter(line => {
      const t = line.trim();
      if (!t) return true;
      if (/^(?:-|\d+\.)\s*/.test(t)) {
        const noPrefix = t.replace(/^(?:-|\d+\.)\s*/, '');
        if (hasTriadRoleText(noPrefix, 'trigger')) return false;
        if (hasTriadRoleText(noPrefix, 'supply')) return false;
        if (hasTriadRoleText(noPrefix, 'amplification')) return false;
      }
      if (/抢不到CPU|阻塞型卡顿|渲染端放大/.test(t)) return false;
      return true;
    });

  const rebuilt = [...cleanedSection];
  const hasTriadBullets = rebuilt.some(line =>
    hasTriadRoleText(line, 'trigger') ||
    hasTriadRoleText(line, 'supply') ||
    hasTriadRoleText(line, 'amplification')
  );
  if (!hasTriadBullets) {
    let insertAt = firstItemIdx >= 0 ? (firstItemIdx - (headerIdx + 1) + 1) : 0;
    rebuilt.splice(
      insertAt,
      0,
      triggerLine,
      supplyLine,
      amplificationLine
    );
  }

  return `${lines.slice(0, headerIdx + 1).join('\n')}\n${rebuilt.join('\n')}\n${lines.slice(sectionEnd).join('\n')}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseNumberFromUnknown(raw: unknown): number | undefined {
  const value = readNumberValue(raw);
  return Number.isFinite(value) ? value : undefined;
}

function clampPercent(raw: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  // Use strict < 1 so that exactly 1 is treated as "1%" not "100%".
  // LLM may output confidence on 0-1 scale (e.g. 0.85) or 0-100 scale (e.g. 85).
  if (raw > 0 && raw < 1) return Math.max(0, Math.min(100, raw * 100));
  return Math.max(0, Math.min(100, raw));
}

function normalizeConclusionId(id: string, fallbackRank: number): string {
  const text = String(id || '').trim();
  if (!text) return `C${fallbackRank}`;
  const m = text.match(/C?\s*(\d+)/i);
  if (m) return `C${Math.max(1, Number(m[1]))}`;
  return `C${fallbackRank}`;
}

function stripJsonCodeFence(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(v => stripBulletPrefix(String(v || '').trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const line = stripBulletPrefix(value.trim());
    return line ? [line] : [];
  }
  return [];
}

function parseConclusionItemFromRecord(
  record: Record<string, unknown>,
  fallbackRank: number
): ConclusionContractConclusionItem | null {
  const trigger = readSemanticText(record, 'trigger');
  const supply = readSemanticText(record, 'supply');
  const amplification = readSemanticText(record, 'amplification');
  const statement = readSemanticText(record, 'statement');
  const rank = Math.round(parseNumberFromUnknown(readValueFromAliases(record, ['rank', 'order', 'index', '序号', '编号'])) || fallbackRank);
  const confidencePercent = clampPercent(readSemanticNumber(record, 'confidence'));

  let resolvedStatement = statement;
  if (!resolvedStatement && (trigger || supply || amplification)) {
    resolvedStatement = buildTriadStatement({
      ...(trigger ? { trigger } : {}),
      ...(supply ? { supply } : {}),
      ...(amplification ? { amplification } : {}),
    });
  }

  if (!resolvedStatement) return null;

  return {
    rank: Number.isFinite(rank) && rank > 0 ? rank : fallbackRank,
    statement: resolvedStatement,
    confidencePercent,
    trigger: trigger || undefined,
    supply: supply || undefined,
    amplification: amplification || undefined,
  };
}

function parseClusterItemFromRecord(record: Record<string, unknown>): ConclusionContractClusterItem | null {
  const cluster = readSemanticText(record, 'cluster_label');
  const description = readSemanticText(record, 'cluster_description');
  const rank = readSemanticNumber(record, 'cluster_rank');
  const rankPrefix = typeof rank === 'number' && rank > 0 ? `K${Math.round(rank)}` : '';
  const frames = parseNumberFromUnknown(readSemanticNumber(record, 'cluster_frames'));
  const percentage = parseNumberFromUnknown(readSemanticNumber(record, 'cluster_percentage'));
  const frameRefs = parseClusterFrameRefs(record);

  let resolvedCluster = cluster;
  if (!resolvedCluster && rankPrefix) resolvedCluster = rankPrefix;
  if (!resolvedCluster && !description) return null;
  if (!resolvedCluster && description) resolvedCluster = description;
  if (resolvedCluster && rankPrefix && !new RegExp(`^${rankPrefix}\\b`, 'i').test(resolvedCluster)) {
    resolvedCluster = `${rankPrefix}: ${resolvedCluster}`;
  }

  return {
    cluster: resolvedCluster || '',
    description: description || undefined,
    frames: typeof frames === 'number' && frames > 0 ? frames : undefined,
    percentage: typeof percentage === 'number' ? percentage : undefined,
    frameRefs: frameRefs.length > 0 ? frameRefs : undefined,
  };
}

function parseFrameRefsFromUnknown(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((v: unknown) => String(v).trim()).filter(Boolean)));
  }
  if (typeof raw !== 'string') {
    return [];
  }
  const text = raw.trim();
  if (!text) return [];
  const normalized = text.replace(/[（(]\s*其余\s*\d+\s*帧省略\s*[）)]/g, '').trim();
  const tokens = normalized.split(/[\/|,，;；\s]+/g)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => /^\d{3,}$/.test(t));
  return Array.from(new Set(tokens));
}

function parseClusterFrameRefs(record: Record<string, unknown>): string[] {
  const direct = readValueFromAliases(record, [
    'frameRefs',
    'frame_refs',
    'frameIds',
    'frame_ids',
    'cluster_frame_refs',
    'clusterFrameRefs',
    'cluster_frames_list',
    'clusterFramesList',
    '聚合帧',
    '帧列表',
    '帧ID列表',
  ]);
  const directRefs = parseFrameRefsFromUnknown(direct);
  if (directRefs.length > 0) return directRefs;

  const clusterDescription = readSemanticText(record, 'cluster_description');
  return parseFrameRefsFromUnknown(clusterDescription);
}

function parseEvidenceItemsFromRecord(record: Record<string, unknown>, fallbackRank: number): ConclusionContractEvidenceItem[] {
  const conclusionId = normalizeConclusionId(readSemanticText(record, 'conclusion_id'), fallbackRank);
  const evidenceTexts = extractEvidenceTextsFromJsonLikeObject(record);
  if (evidenceTexts.length === 0) return [];
  return evidenceTexts.map(text => ({ conclusionId, text }));
}

function extractListEntriesFromSectionBody(body: string): string[] {
  const entries: string[] = [];
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const bullet = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const text = stripBulletPrefix(bullet[1].trim());
      if (text) entries.push(text);
      continue;
    }
    entries.push(stripBulletPrefix(line));
  }
  return entries.filter(Boolean);
}

function parseConclusionConfidenceFromStatement(statement: string): { statement: string; confidencePercent?: number } {
  const raw = String(statement || '')
    .trim()
    .replace(/[·]\s*$/, '')
    .trim();
  if (!raw) return { statement: raw };

  const m = raw.match(/[（(]\s*置信度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%?\s*[）)]/i);
  if (!m) return { statement: raw };

  const confidence = clampPercent(Number(m[1]));
  const cleaned = raw.replace(m[0], '').trim();
  return { statement: cleaned || raw, confidencePercent: confidence };
}

function parseConclusionItemsFromMarkdownSection(sectionBody: string): ConclusionContractConclusionItem[] {
  const numberedItems: Array<{ index: number; text: string }> = [];
  const bulletFallback: string[] = [];
  const lines = String(sectionBody || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const mNum = line.match(/^([1-3])\s*[.)、]\s*(.+)$/);
    if (mNum) {
      numberedItems.push({ index: Number(mNum[1]), text: mNum[2].trim() });
      continue;
    }

    const mC = line.match(/^C([1-3])\s*[:：]\s*(.+)$/i);
    if (mC) {
      numberedItems.push({ index: Number(mC[1]), text: mC[2].trim() });
      continue;
    }

    const mBullet = line.match(/^-\s+(.+)$/);
    if (mBullet) {
      bulletFallback.push(mBullet[1].trim());
    }
  }

  const baseItems = numberedItems.length > 0
    ? numberedItems
    : bulletFallback.slice(0, 3).map((text, idx) => ({ index: idx + 1, text }));

  const triadParts = parseTriadParts(sectionBody || '');

  const items = baseItems.map((item, idx) => {
    const rank = item.index || idx + 1;
    const parsed = parseConclusionConfidenceFromStatement(item.text);
    return {
      rank,
      statement: parsed.statement,
      confidencePercent: parsed.confidencePercent,
    };
  });

  if (triadParts.trigger || triadParts.supply || triadParts.amplification) {
    const triadStatement = buildTriadStatement(triadParts);
    const alreadyCovered = items.some(item =>
      hasTriadRoleText(item.statement, 'trigger') &&
      hasTriadRoleText(item.statement, 'supply') &&
      hasTriadRoleText(item.statement, 'amplification')
    );
    if (!alreadyCovered) {
      items.push({
        rank: items.length + 1,
        statement: triadStatement,
        confidencePercent: undefined,
      });
    }
  }

  return items;
}

function parseClusterItemsFromMarkdownSection(sectionBody: string): ConclusionContractClusterItem[] {
  const entries = extractListEntriesFromSectionBody(sectionBody);
  const clusters: ConclusionContractClusterItem[] = [];
  for (const entry of entries) {
    const metricMatch = entry.match(/[（(]\s*(\d+(?:\.\d+)?)\s*帧\s*,\s*(\d+(?:\.\d+)?)\s*%\s*[）)]/);
    let clusterText = entry;
    let frames: number | undefined;
    let percentage: number | undefined;
    if (metricMatch) {
      clusterText = entry.replace(metricMatch[0], '').trim();
      frames = Number(metricMatch[1]);
      percentage = Number(metricMatch[2]);
    }
    if (!clusterText) continue;
    const m = clusterText.match(/^(K\d+)\s*[:：]\s*(.+)$/i);
    const description = m ? m[2] : undefined;
    const frameRefs = parseFrameRefsFromUnknown(description);
    clusters.push({
      cluster: m ? m[1] : clusterText,
      description,
      frames: Number.isFinite(frames) ? frames : undefined,
      percentage: Number.isFinite(percentage) ? percentage : undefined,
      frameRefs: frameRefs.length > 0 ? frameRefs : undefined,
    });
  }
  return clusters;
}

function parseEvidenceItemsFromMarkdownSection(sectionBody: string): ConclusionContractEvidenceItem[] {
  const entries = extractListEntriesFromSectionBody(sectionBody);
  const evidenceItems: ConclusionContractEvidenceItem[] = [];
  entries.forEach((entry, idx) => {
    const m = entry.match(/^(C\d+)\s*[:：]\s*(.+)$/i);
    if (m) {
      evidenceItems.push({
        conclusionId: normalizeConclusionId(m[1], idx + 1),
        text: m[2].trim(),
      });
    } else {
      evidenceItems.push({
        conclusionId: normalizeConclusionId('', idx + 1),
        text: entry,
      });
    }
  });
  return evidenceItems;
}

function parseMetadataFromMarkdownSection(sectionBody: string): ConclusionContractMetadata | undefined {
  const entries = extractListEntriesFromSectionBody(sectionBody);
  let confidencePercent: number | undefined;
  let rounds: number | undefined;

  for (const entry of entries) {
    const confidenceMatch = entry.match(/置信度\s*[:：]\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (confidenceMatch && confidencePercent === undefined) {
      confidencePercent = clampPercent(Number(confidenceMatch[1]));
      continue;
    }
    const roundsMatch = entry.match(/分析轮次\s*[:：]\s*(\d+(?:\.\d+)?)/i);
    if (roundsMatch && rounds === undefined) {
      rounds = Number(roundsMatch[1]);
    }
  }

  if (confidencePercent === undefined && rounds === undefined) return undefined;
  return {
    confidencePercent,
    rounds: typeof rounds === 'number' && Number.isFinite(rounds) ? Math.max(1, Math.round(rounds)) : undefined,
  };
}

function normalizeSceneId(raw: unknown, fallback?: string): string | undefined {
  const direct = String(raw || '').trim().toLowerCase();
  if (direct) return direct;
  const fallbackText = String(fallback || '').trim().toLowerCase();
  return fallbackText || undefined;
}

function normalizeClusterOutputMode(
  raw: unknown,
  fallback: ConclusionClusterOutputMode = 'optional'
): ConclusionClusterOutputMode {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'required' || text === 'optional' || text === 'none') return text;
  return fallback;
}

function normalizeClusterFrameListMode(
  raw: unknown,
  fallback: ConclusionClusterFrameListMode = 'none'
): ConclusionClusterFrameListMode {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'full' || text === 'top' || text === 'none') return text;
  return fallback;
}

function normalizeClusterPolicy(
  raw: unknown,
  fallback?: ConclusionContractClusterPolicy
): ConclusionContractClusterPolicy | undefined {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const outputMode = normalizeClusterOutputMode(
    readValueFromAliases(source, ['outputMode', 'output_mode']),
    fallback?.outputMode || 'optional'
  );
  const frameListMode = normalizeClusterFrameListMode(
    readValueFromAliases(source, ['frameListMode', 'frame_list_mode']),
    fallback?.frameListMode || 'none'
  );
  const maxFramesPerCluster = parseNumberFromUnknown(
    readValueFromAliases(source, ['maxFramesPerCluster', 'max_frames_per_cluster'])
  );
  const resolvedMax = Number.isFinite(maxFramesPerCluster) && (maxFramesPerCluster || 0) > 0
    ? Math.round(maxFramesPerCluster as number)
    : fallback?.maxFramesPerCluster;

  const hasSignal = Boolean(raw) || Boolean(fallback);
  if (!hasSignal) return undefined;

  return {
    outputMode,
    frameListMode,
    maxFramesPerCluster: resolvedMax,
  };
}

function sanitizeConclusionContract(
  contract: ConclusionContract,
  options: ContractRenderOptions
): ConclusionContract {
  const sanitizeText = (text: string): string => stripBulletPrefix(String(text || '').trim())
    .replace(/[·]\s*$/, '')
    .trim();
  const dedupe = (items: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items) {
      const item = sanitizeText(raw);
      if (!item || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  };

  const conclusions = contract.conclusions
    .map((item, idx) => {
      const rank = Number.isFinite(item.rank) && item.rank > 0 ? Math.round(item.rank) : idx + 1;
      const parsed = parseConclusionConfidenceFromStatement(item.statement);
      const statement = sanitizeText(parsed.statement);
      const confidencePercent = clampPercent(item.confidencePercent ?? parsed.confidencePercent);
      return {
        rank,
        statement,
        confidencePercent,
        trigger: sanitizeText(item.trigger || ''),
        supply: sanitizeText(item.supply || ''),
        amplification: sanitizeText(item.amplification || ''),
      };
    })
    .filter(item => item.statement || item.trigger || item.supply || item.amplification)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
    .map((item, idx) => {
      let statement = item.statement;
      if (!statement) {
        statement = buildTriadStatement({
          ...(item.trigger ? { trigger: item.trigger } : {}),
          ...(item.supply ? { supply: item.supply } : {}),
          ...(item.amplification ? { amplification: item.amplification } : {}),
        });
      }
      return {
        rank: idx + 1,
        statement: statement || '结论信息缺失（证据不足）',
        confidencePercent: item.confidencePercent,
        trigger: item.trigger || undefined,
        supply: item.supply || undefined,
        amplification: item.amplification || undefined,
      };
    });

  const scenePolicy = options.scenePromptHints
    ? {
        outputMode: options.scenePromptHints.clusterPolicy.outputMode,
        frameListMode: options.scenePromptHints.clusterPolicy.frameListMode,
        maxFramesPerCluster: options.scenePromptHints.clusterPolicy.maxFramesPerCluster,
      }
    : undefined;
  const clusterPolicy = normalizeClusterPolicy(contract.metadata?.clusterPolicy, scenePolicy);
  const sceneId = normalizeSceneId(contract.metadata?.sceneId, options.scenePromptHints?.sceneId);

  const clusters = options.singleFrameDrillDown
    ? []
    : contract.clusters
        .map(item => ({
          cluster: sanitizeText(item.cluster),
          description: sanitizeText(item.description || '') || undefined,
          frames: typeof item.frames === 'number' && Number.isFinite(item.frames) && item.frames > 0
            ? Math.round(item.frames)
            : undefined,
          percentage: clampPercent(item.percentage),
          frameRefs: parseFrameRefsFromUnknown(item.frameRefs),
        }))
        .filter(item => item.cluster)
        .map(item => {
          const selection = applyClusterFrameListMode(
            item.frameRefs,
            clusterPolicy?.frameListMode || 'top',
            clusterPolicy?.maxFramesPerCluster
          );
          return {
            cluster: item.cluster,
            description: item.description,
            frames: item.frames,
            percentage: item.percentage,
            frameRefs: selection.frameIds.length > 0 ? selection.frameIds : undefined,
            omittedFrameRefs: selection.omittedCount > 0 ? selection.omittedCount : undefined,
          };
        })
        .slice(0, 5);

  const evidenceChain = contract.evidenceChain
    .map((item, idx) => ({
      conclusionId: normalizeConclusionId(item.conclusionId, idx + 1),
      text: sanitizeText(item.text),
    }))
    .filter(item => item.text)
    .slice(0, 12);

  const uncertainties = dedupe(contract.uncertainties).slice(0, 6);
  const nextSteps = dedupe(contract.nextSteps).slice(0, 6);

  const metadata = contract.metadata
    ? {
        confidencePercent: clampPercent(contract.metadata.confidencePercent),
        rounds: typeof contract.metadata.rounds === 'number' && Number.isFinite(contract.metadata.rounds)
          ? Math.max(1, Math.round(contract.metadata.rounds))
          : undefined,
        clusterPolicy,
        sceneId,
      }
    : ((clusterPolicy || sceneId) ? { ...(clusterPolicy ? { clusterPolicy } : {}), ...(sceneId ? { sceneId } : {}) } : undefined);

  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: contract.mode,
    conclusions: conclusions.length > 0 ? conclusions : [{
      rank: 1,
      statement: '结论信息缺失（证据不足）',
      confidencePercent: 40,
    }],
    clusters,
    evidenceChain,
    uncertainties,
    nextSteps,
    metadata: metadata && (
      metadata.confidencePercent !== undefined ||
      metadata.rounds !== undefined ||
      metadata.clusterPolicy !== undefined ||
      metadata.sceneId !== undefined
    )
      ? metadata
      : undefined,
  };
}

function renderConclusionContract(
  contract: ConclusionContract,
  options: ContractRenderOptions
): string {
  const lines: string[] = [];

  lines.push('## 结论（按可能性排序）');
  contract.conclusions.forEach((item, idx) => {
    const confidenceSuffix = typeof item.confidencePercent === 'number'
      ? `（置信度: ${Math.round(item.confidencePercent)}%）`
      : '';
    lines.push(`${idx + 1}. ${item.statement}${confidenceSuffix}`);
  });
  lines.push('');

  if (!options.singleFrameDrillDown) {
    const sceneId = options.scenePromptHints?.sceneId || contract.metadata?.sceneId;
    lines.push(resolveClusterSectionHeading(sceneId));
    if (contract.clusters.length === 0) {
      lines.push('- 暂无');
    } else {
      contract.clusters.forEach((cluster) => {
        const prefix = cluster.description
          ? `${cluster.cluster}: ${cluster.description}`
          : cluster.cluster;
        const metrics: string[] = [];
        if (typeof cluster.frames === 'number') metrics.push(`${Math.round(cluster.frames)}帧`);
        if (typeof cluster.percentage === 'number') metrics.push(`${cluster.percentage.toFixed(1)}%`);
        const frameRefs = parseFrameRefsFromUnknown(cluster.frameRefs);
        const frameRefText = frameRefs.length > 0 ? `；帧: ${frameRefs.join(' / ')}` : '';
        const omissionHint = typeof cluster.omittedFrameRefs === 'number' && cluster.omittedFrameRefs > 0
          ? `（其余 ${Math.round(cluster.omittedFrameRefs)} 帧省略）`
          : '';
        lines.push(`- ${prefix}${metrics.length > 0 ? `（${metrics.join(', ')}）` : ''}${frameRefText}${omissionHint}`);
      });
    }
    lines.push('');
  }

  lines.push('## 证据链（对应上述结论）');
  if (contract.evidenceChain.length === 0) {
    lines.push('- 证据链信息缺失');
  } else {
    contract.evidenceChain.forEach((item) => lines.push(`- ${item.conclusionId}: ${item.text}`));
  }
  lines.push('');

  lines.push('## 不确定性与反例');
  if (contract.uncertainties.length === 0) {
    lines.push('- 暂无');
  } else {
    contract.uncertainties.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  if (contract.nextSteps.length === 0) {
    lines.push('- 暂无');
  } else {
    contract.nextSteps.forEach((item) => lines.push(`- ${item}`));
  }

  if (contract.metadata && (contract.metadata.confidencePercent !== undefined || contract.metadata.rounds !== undefined)) {
    lines.push('');
    lines.push('## 分析元数据');
    if (contract.metadata.confidencePercent !== undefined) {
      lines.push(`- 置信度: ${Math.round(contract.metadata.confidencePercent)}%`);
    }
    if (contract.metadata.rounds !== undefined) {
      lines.push(`- 分析轮次: ${Math.round(contract.metadata.rounds)}`);
    }
  }

  return lines.join('\n');
}

function parseMarkdownToConclusionContract(
  markdown: string,
  mode: ConclusionOutputMode,
  options: ContractRenderOptions
): ConclusionContract | null {
  const text = String(markdown || '').trim();
  if (!text) return null;

  const conclusionSection =
    findMarkdownSection(text, /^##\s*结论[（(]按可能性排序[）)]\s*$/m) ||
    findMarkdownSection(text, /^##\s*分析结论\s*$/m);
  const clusterSection =
    findMarkdownSection(text, /^##\s*掉帧聚类[（(]先看大头[）)]\s*$/m)
    || findMarkdownSection(text, /^##\s*聚类[（(]先看大头[）)]\s*$/m)
    || findMarkdownSection(text, /^##\s*聚类\s*$/m);
  const evidenceSection = findMarkdownSection(text, /^##\s*证据链[（(]对应上述结论[）)]\s*$/m);
  const uncertaintySection = findMarkdownSection(text, /^##\s*不确定性与反例\s*$/m);
  const nextStepSection = findMarkdownSection(text, /^##\s*下一步[（(]最高信息增益[）)]\s*$/m);
  const metadataSection = findMarkdownSection(text, /^##\s*分析元数据\s*$/m);

  const hasSignal = Boolean(
    conclusionSection || clusterSection || evidenceSection || uncertaintySection || nextStepSection || metadataSection
  );
  if (!hasSignal) return null;

  const clusterHeader = clusterSection
    ? text.slice(clusterSection.headerStart, clusterSection.headerEnd)
    : '';
  const inferredSceneId = /掉帧聚类/.test(clusterHeader) ? 'jank' : undefined;
  const parsedMetadata = metadataSection ? parseMetadataFromMarkdownSection(metadataSection.body) : undefined;
  const metadata = inferredSceneId
    ? { ...(parsedMetadata || {}), sceneId: inferredSceneId }
    : parsedMetadata;

  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode,
    conclusions: conclusionSection ? parseConclusionItemsFromMarkdownSection(conclusionSection.body) : [],
    clusters: clusterSection ? parseClusterItemsFromMarkdownSection(clusterSection.body) : [],
    evidenceChain: evidenceSection ? parseEvidenceItemsFromMarkdownSection(evidenceSection.body) : [],
    uncertainties: uncertaintySection
      ? extractListEntriesFromSectionBody(uncertaintySection.body).map(normalizeUncertaintyWording)
      : [],
    nextSteps: nextStepSection
      ? extractListEntriesFromSectionBody(nextStepSection.body).map(normalizeNextStepWording)
      : [],
    metadata,
  };

  return sanitizeConclusionContract(contract, options);
}

function parseJsonToConclusionContract(
  rawText: string,
  mode: ConclusionOutputMode,
  options: ContractRenderOptions
): ConclusionContract | null {
  const cleaned = stripJsonCodeFence(rawText);
  if (!cleaned) return null;
  if (!cleaned.startsWith('{')) return null;

  let parsed: unknown = null;
  const candidate = cleaned.endsWith('}') ? cleaned : extractFirstJsonObject(cleaned);
  if (!candidate) return null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const root = toRecord(parsed);
  if (!root) return null;

  const conclusionSource = readValueFromAliases(root, ['conclusion', 'conclusions', '结论']);
  const clusterSource = readValueFromAliases(root, ['clusters', 'jank_clusters', '掉帧聚类', 'cluster']);
  const evidenceSource = readValueFromAliases(root, ['evidence_chain', 'evidenceChain', '证据链']);
  const uncertaintySource = readValueFromAliases(root, ['uncertainties', 'uncertainty', '不确定性与反例', '不确定性']);
  const nextStepSource = readValueFromAliases(root, ['next_steps', 'nextStep', 'next_step', '下一步']);
  const metadataSource = readValueFromAliases(root, ['metadata', 'analysis_metadata', '分析元数据']);

  const conclusions: ConclusionContractConclusionItem[] = [];
  if (Array.isArray(conclusionSource)) {
    conclusionSource.forEach((item, idx) => {
      if (typeof item === 'string') {
        const parsedItem = parseConclusionConfidenceFromStatement(item);
        conclusions.push({
          rank: idx + 1,
          statement: parsedItem.statement,
          confidencePercent: parsedItem.confidencePercent,
        });
        return;
      }
      const record = toRecord(item);
      if (!record) return;
      const parsedItem = parseConclusionItemFromRecord(record, idx + 1);
      if (parsedItem) conclusions.push(parsedItem);
    });
  } else if (typeof conclusionSource === 'string') {
    const parsedItem = parseConclusionConfidenceFromStatement(conclusionSource);
    if (parsedItem.statement) {
      conclusions.push({
        rank: 1,
        statement: parsedItem.statement,
        confidencePercent: parsedItem.confidencePercent,
      });
    }
  } else {
    const fallbackItem = parseConclusionItemFromRecord(root, 1);
    if (fallbackItem) conclusions.push(fallbackItem);
  }

  const clusters: ConclusionContractClusterItem[] = [];
  if (Array.isArray(clusterSource)) {
    for (const item of clusterSource) {
      const record = toRecord(item);
      if (!record) continue;
      const parsedItem = parseClusterItemFromRecord(record);
      if (parsedItem) clusters.push(parsedItem);
    }
  } else {
    const record = toRecord(clusterSource);
    if (record) {
      const parsedItem = parseClusterItemFromRecord(record);
      if (parsedItem) clusters.push(parsedItem);
    }
  }

  const evidenceChain: ConclusionContractEvidenceItem[] = [];
  if (Array.isArray(evidenceSource)) {
    evidenceSource.forEach((item, idx) => {
      if (typeof item === 'string') {
        const m = item.match(/^(C\d+)\s*[:：]\s*(.+)$/i);
        evidenceChain.push({
          conclusionId: normalizeConclusionId(m?.[1] || '', idx + 1),
          text: stripBulletPrefix(m?.[2] || item),
        });
        return;
      }
      const record = toRecord(item);
      if (!record) return;
      evidenceChain.push(...parseEvidenceItemsFromRecord(record, idx + 1));
    });
  } else {
    const record = toRecord(evidenceSource);
    if (record) {
      evidenceChain.push(...parseEvidenceItemsFromRecord(record, 1));
    }
  }

  const uncertainties = toStringArray(uncertaintySource).map(normalizeUncertaintyWording);
  const nextSteps = toStringArray(nextStepSource).map(normalizeNextStepWording);

  const metadataRecord = toRecord(metadataSource);
  const metadataClusterPolicy = normalizeClusterPolicy(
    metadataRecord ? readValueFromAliases(metadataRecord, ['clusterPolicy', 'cluster_policy']) : undefined
  );
  const rootClusterPolicy = normalizeClusterPolicy(readValueFromAliases(root, ['clusterPolicy', 'cluster_policy']));
  const metadataSceneId = normalizeSceneId(
    metadataRecord ? readValueFromAliases(metadataRecord, ['sceneId', 'scene_id', 'scene']) : undefined
  );
  const rootSceneId = normalizeSceneId(readValueFromAliases(root, ['sceneId', 'scene_id', 'scene']));
  const metadata: ConclusionContractMetadata | undefined = metadataRecord
    ? {
        confidencePercent: clampPercent(readSemanticNumber(metadataRecord, 'confidence')),
        rounds: (() => {
          const rounds = readSemanticNumber(metadataRecord, 'rounds');
          return typeof rounds === 'number' && Number.isFinite(rounds) ? Math.round(rounds) : undefined;
        })(),
        clusterPolicy: metadataClusterPolicy || rootClusterPolicy,
        sceneId: metadataSceneId || rootSceneId,
      }
    : {
        confidencePercent: clampPercent(readSemanticNumber(root, 'confidence')),
        rounds: (() => {
          const rounds = readSemanticNumber(root, 'rounds');
          return typeof rounds === 'number' && Number.isFinite(rounds) ? Math.round(rounds) : undefined;
        })(),
        clusterPolicy: rootClusterPolicy,
        sceneId: rootSceneId,
      };

  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1',
    mode,
    conclusions,
    clusters,
    evidenceChain,
    uncertainties,
    nextSteps,
    metadata,
  };

  return sanitizeConclusionContract(contract, options);
}

function toDeterministicConclusionMarkdown(
  rawText: string,
  mode: ConclusionOutputMode,
  options: ContractRenderOptions,
  emitter: ProgressEmitter
): string {
  const text = String(rawText || '').trim();
  if (!text) return text;

  const contractFromJson = parseJsonToConclusionContract(text, mode, options);
  if (contractFromJson) {
    emitter.log('[conclusionGenerator] Rendered conclusion via structured contract JSON');
    return renderConclusionContract(contractFromJson, options);
  }

  let markdownCandidate = text;
  if (shouldNormalizeConclusionOutput(text)) {
    emitter.log('[conclusionGenerator] LLM returned non-markdown output, applying legacy normalizer before contract render');
    markdownCandidate = normalizeConclusionOutput(text);
  }

  const contractFromMarkdown = parseMarkdownToConclusionContract(markdownCandidate, mode, options);
  if (contractFromMarkdown) {
    emitter.log('[conclusionGenerator] Rendered conclusion via markdown->contract pipeline');
    return renderConclusionContract(contractFromMarkdown, options);
  }

  return markdownCandidate;
}

export function deriveConclusionContract(
  rawText: string,
  options: {
    mode?: ConclusionOutputMode;
    singleFrameDrillDown?: boolean;
    sceneId?: string;
  } = {}
): ConclusionContract | null {
  const mode = options.mode || 'initial_report';
  const renderOptions: ContractRenderOptions = {
    singleFrameDrillDown: Boolean(options.singleFrameDrillDown),
  };
  const sceneIdHint = normalizeSceneId(options.sceneId);
  const text = String(rawText || '').trim();
  if (!text) return null;

  const applySceneIdHint = (contract: ConclusionContract): ConclusionContract => {
    if (!sceneIdHint || contract.metadata?.sceneId) return contract;
    return {
      ...contract,
      metadata: {
        ...(contract.metadata || {}),
        sceneId: sceneIdHint,
      },
    };
  };

  const contractFromJson = parseJsonToConclusionContract(text, mode, renderOptions);
  if (contractFromJson) return applySceneIdHint(contractFromJson);

  const markdownCandidates: string[] = [text];
  const normalizedJsonLike = convertJsonLikeSectionsToMarkdown(text, renderOptions);
  if (normalizedJsonLike) {
    markdownCandidates.push(normalizedJsonLike);
  }

  const normalizedJson = convertJsonToMarkdown(text);
  if (normalizedJson && normalizedJson !== text) {
    markdownCandidates.push(normalizedJson);
  }

  for (const candidate of markdownCandidates) {
    const contract = parseMarkdownToConclusionContract(candidate, mode, renderOptions);
    if (contract) return applySceneIdHint(contract);
  }

  return null;
}

export function renderConclusionContractMarkdown(
  contract: ConclusionContract,
  options: { singleFrameDrillDown?: boolean } = {}
): string {
  return renderConclusionContract(contract, {
    singleFrameDrillDown: Boolean(options.singleFrameDrillDown),
  });
}

const ANSWER_STREAM_MAX_CHARS_PER_CHUNK = 18;
const ANSWER_STREAM_BOUNDARY_RE = /[\n。！？!?；;：:,，]/;
const ANSWER_STREAM_TOKEN_RE = /(\n+|[。！？!?；;：:,，]|[^\s。！？!?；;：:,，\n]+|\s+)/g;

function tokenizeConclusionForStreaming(content: string): string[] {
  const normalized = String(content || '');
  if (!normalized) return [];

  const rawTokens = normalized.match(ANSWER_STREAM_TOKEN_RE) || [normalized];
  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    chunks.push(buffer);
    buffer = '';
  };

  for (const token of rawTokens) {
    if (!token) continue;

    // Split oversized "word" tokens to keep UI refresh granular and stable.
    if (
      token.length > ANSWER_STREAM_MAX_CHARS_PER_CHUNK * 2 &&
      !ANSWER_STREAM_BOUNDARY_RE.test(token) &&
      !/\s/.test(token)
    ) {
      for (let i = 0; i < token.length; i += ANSWER_STREAM_MAX_CHARS_PER_CHUNK) {
        const piece = token.slice(i, i + ANSWER_STREAM_MAX_CHARS_PER_CHUNK);
        if (buffer && buffer.length + piece.length > ANSWER_STREAM_MAX_CHARS_PER_CHUNK) {
          flush();
        }
        buffer += piece;
        flush();
      }
      continue;
    }

    if (buffer && buffer.length + token.length > ANSWER_STREAM_MAX_CHARS_PER_CHUNK) {
      flush();
    }
    buffer += token;

    if (ANSWER_STREAM_BOUNDARY_RE.test(token) || buffer.length >= ANSWER_STREAM_MAX_CHARS_PER_CHUNK) {
      flush();
    }
  }

  flush();
  return chunks;
}

function emitConclusionAsAnswerTokens(
  emitter: ProgressEmitter,
  conclusion: string,
  options: { emitTokens?: boolean } = {}
): string {
  const text = String(conclusion || '');
  const shouldEmitTokens = options.emitTokens !== false;
  const chunks = shouldEmitTokens ? tokenizeConclusionForStreaming(text) : [];

  for (const token of chunks) {
    emitter.emitUpdate('answer_token', { token });
  }

  emitter.emitUpdate('answer_token', {
    done: true,
    totalChars: text.length,
  });

  return text;
}

/**
 * Generate an AI-powered conclusion from analysis results.
 * Falls back to a simple markdown summary if LLM fails.
 */
export async function generateConclusion(
  sharedContext: SharedAgentContext,
  allFindings: Finding[],
  intent: Intent,
  modelRouter: ModelRouter,
  emitter: ProgressEmitter,
  stopReason?: string,
  options: ConclusionGenerationOptions = {}
): Promise<string> {
  let hasModelTokenStream = false;
  const onModelToken = (token: string) => {
    if (!token) return;
    hasModelTokenStream = true;
    emitter.emitUpdate('answer_token', { token });
  };

  const streamConclusionAndReturn = (text: string): string =>
    emitConclusionAsAnswerTokens(emitter, text, {
      emitTokens: !hasModelTokenStream,
    });

  const sanitizedFindings = sanitizeFindingsForConclusion(allFindings);
  const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
    .filter(h => h.status === 'confirmed' || h.confidence >= 0.85);

  const turnCount = Number.isFinite(options.turnCount) ? Number(options.turnCount) : 0;
  const singleFrameDrillDown = isSingleFrameDrillDown(intent);
  const historyContext = singleFrameDrillDown ? '' : (options.historyContext || '');
  const frameMechanismRecords = sharedContext.frameMechanismRecords || [];
  const scopedJankSummary = singleFrameDrillDown ? undefined : sharedContext.jankCauseSummary;

  // Collect contradicted findings for explicit mention in prompt
  // Instead of filtering them out, we let LLM resolve contradictions with guidance
  const contradictedFindings = sanitizedFindings.filter(f => f.details?._contradicted);
  const contradictionReasons = contradictedFindings
    .map(f => f.details?._contradictionReason)
    .filter((r): r is string => typeof r === 'string');

  // Sort findings by confidence (highest first) for better LLM processing
  const sortedFindings = [...sanitizedFindings].sort((a, b) => (b.confidence || 0.5) - (a.confidence || 0.5));

  // Filter out contradicted findings to prevent LLM from generating conflicting conclusions
  const findingsForPrompt = sortedFindings.filter(f => !f.details?._contradicted);
  // If all findings were filtered, keep top 5 by confidence as fallback
  const finalFindings = findingsForPrompt.length > 0
    ? findingsForPrompt
    : sortedFindings.slice(0, 5);
  const promptFindings = finalFindings.slice(0, PROMPT_FINDING_LIMIT);
  const attributionAssessment = deriveAttributionAssessment(
    finalFindings,
    scopedJankSummary
  );

  const insightEnabled = isInsightConclusionEnabled();
  const outputMode = resolveConclusionOutputMode({
    insightEnabled,
    turnCount,
    intent,
    findingsCount: sortedFindings.length,
    confirmedHypothesesCount: confirmedHypotheses.length,
    hasJankSummary: Boolean(scopedJankSummary && scopedJankSummary.totalJankFrames > 0),
  });
  const scenePromptHints = buildConclusionScenePromptHints({
    intent,
    findings: promptFindings,
    deepReasonLabel: DEEP_REASON_LABEL,
  });

  // Build contradiction section for prompt if any exist
  const contradictionSection = contradictionReasons.length > 0
    ? `\n⚠️ 数据矛盾提示:\n${contradictionReasons.map(r => `- ${r}`).join('\n')}\n`
    : '';

  // Build structured jank summary section (from per-frame analysis)
  const jankSummarySection = formatJankSummaryForPrompt(scopedJankSummary);
  const includeAttributionPrompt = isJankSceneId(scenePromptHints.sceneId);
  const attributionAssessmentSection = includeAttributionPrompt
    ? buildAttributionAssessmentPromptSection(attributionAssessment)
    : '';
  const mechanismTriadSection = includeAttributionPrompt
    ? buildMechanismTriadPromptSection(
      attributionAssessment,
      scopedJankSummary,
      frameMechanismRecords
    )
    : '';
  const sceneFocusPromptSection = [
    '## 场景化分析焦点',
    `- 当前场景: ${scenePromptHints.sceneName}`,
    ...scenePromptHints.focusLines,
  ].join('\n');
  const sceneOutputRequirementSection = [
    ...scenePromptHints.outputRequirementLines,
    scenePromptHints.nextStepLine,
  ].join('\n');
  const nonInsightClusterGoalLine = scenePromptHints.clusterPolicy.outputMode === 'required'
    ? '6. 聚类/分组 Top3（按样本规模降序，先给 K1 大头）'
    : (scenePromptHints.clusterPolicy.outputMode === 'none'
      ? '6. 当前场景无需聚类分组，请省略 clusters 并说明原因'
      : '6. 若有分组证据可给出 Top 分组；若无可省略聚类并说明原因');
  const nonInsightClusterConstraint = scenePromptHints.clusterPolicy.outputMode === 'required'
    ? '- 必须输出 clusters（K1/K2/K3），并给出每类样本数和占比'
    : (scenePromptHints.clusterPolicy.outputMode === 'none'
      ? '- 当前场景 clusters 必须传空数组，不要虚构聚类'
      : '- 当前场景 clusters 可按时间阶段/样本分组给出；若无聚类证据可传空数组');
  const nonInsightConflictRulesSection = buildNonInsightConflictRulesSection(
    scenePromptHints,
    sharedContext.traceConfig
  );

  // Debug: Log whether jank summary is being included
  if (scopedJankSummary) {
    console.log(`[ConclusionGenerator] Using jankCauseSummary: ${scopedJankSummary.totalJankFrames} frames, primary=${scopedJankSummary.primaryCause?.label}`);
  } else if (singleFrameDrillDown) {
    console.log('[ConclusionGenerator] Single-frame drill-down: jankCauseSummary suppressed to avoid cross-turn cluster carry-over');
  } else {
    console.log(`[ConclusionGenerator] No jankCauseSummary available in sharedContext`);
  }

  const prompt = insightEnabled
    ? buildInsightFirstPrompt({
        mode: outputMode,
        turnCount,
        historyContext,
        intent,
        stopReason,
        confirmedHypotheses: confirmedHypotheses.map(h => ({
          description: h.description,
          confidence: h.confidence,
          status: h.status,
        })),
        findings: promptFindings,
        contradictionSection,
        jankSummary: scopedJankSummary,
        frameMechanismRecords,
        attributionAssessment,
        scenePromptHints,
        traceConfig: sharedContext.traceConfig,
        investigationPath: sharedContext.investigationPath,
      })
    : `基于以下分析结果生成诊断结论：

用户目标: ${intent.primaryGoal}
${stopReason ? `提前终止原因: ${stopReason}` : ''}
${jankSummarySection}
${attributionAssessmentSection}
${mechanismTriadSection}
${sceneFocusPromptSection}
已确认的假设:
${confirmedHypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

发现的问题（含数据证据）:
${promptFindings.map(f => formatFindingWithEvidence(f)).join('\n\n') || '无'}
${contradictionSection}
调查路径:
${sharedContext.investigationPath.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n')}

请生成:
1. 根因分析（最可能的原因）
2. 证据支撑（每个结论的依据）
3. 置信度评估
4. 下一步最有信息增益的分析动作
5. 机制分层说明：直接原因 / 资源问题 / 放大因素
${nonInsightClusterGoalLine}

重要约束：
- 只基于上述提供的数据和证据得出结论，不要推测未提供的信息
- 如果数据不足以得出某个结论，明确标注"证据不足"
- 每个结论必须引用具体的数据来源（Finding 的标题或数据值）
${sceneOutputRequirementSection}
- “下一步”至少包含 1 条行动项，使用 owner/priority/verification 明确责任与验收标准
- 可给出最多 2 条与“${DEEP_REASON_LABEL}”一一对应的优化方向，避免泛化建议
- ${nonInsightClusterConstraint}
${nonInsightConflictRulesSection}

## 输出格式要求（必须严格遵守）
- **只输出 Markdown 格式的纯文本**，方便人类阅读
- **禁止输出 JSON**，不要用 {} 或 [] 包装内容
- **禁止输出代码块**，不要用 \`\`\` 包装
- 使用 ## 作为标题，使用 - 作为列表项
- 示例格式：
  ## 根因分析
  主要问题是 XXX，置信度 85%。

	  ## 证据支撑
	  - 发现1：XXX
	  - 发现2：XXX`;

  const contractRenderOptions: ContractRenderOptions = {
    singleFrameDrillDown,
    scenePromptHints,
  };

  try {
    const response = await modelRouter.callWithFallback(prompt, 'synthesis', {
      jsonMode: insightEnabled,
      onToken: onModelToken,
      sessionId: sharedContext.sessionId,
      traceId: sharedContext.traceId,
      maxTokens: insightEnabled ? 3000 : 2000,
      promptId: insightEnabled
        ? `agent.conclusionGenerator.insight.${outputMode}`
        : (turnCount >= 1 ? 'agent.conclusionGenerator.dialogue' : 'agent.conclusionGenerator'),
      promptVersion: '2.0.0',
      contractVersion: insightEnabled
        ? 'conclusion_contract_json@1.0.0'
        : (turnCount >= 1 ? 'conclusion_dialogue_text@1.0.0' : 'conclusion_text@1.0.0'),
    });

    let conclusion = toDeterministicConclusionMarkdown(
      response.response,
      outputMode,
      contractRenderOptions,
      emitter
    );

    // Ensure evidence IDs appear in the evidence-chain section when available.
    // This makes the output auditable even if the LLM forgets to cite.
    conclusion = finalizeConclusionMarkdown(
      conclusion,
      finalFindings,
      scopedJankSummary,
      { singleFrameDrillDown, scenePromptHints }
    );

    if (isConclusionContradictingAttributionVerdict(conclusion, attributionAssessment)) {
      emitter.log('[conclusionGenerator] LLM conclusion contradicts attribution verdict, switching to rule-based safe fallback');
      emitter.emitUpdate('degraded', {
        module: 'conclusionGenerator',
        fallback: 'rule-based attribution-safe conclusion',
      });
      const safeFallback = generateAttributionSafeFallback(
        attributionAssessment,
        finalFindings,
        contradictionReasons,
        stopReason,
        scopedJankSummary,
        frameMechanismRecords
      );
      const deterministicFallback = toDeterministicConclusionMarkdown(
        safeFallback,
        outputMode,
        contractRenderOptions,
        emitter
      );
      const finalizedFallback = finalizeConclusionMarkdown(
        deterministicFallback,
        finalFindings,
        scopedJankSummary,
        { singleFrameDrillDown, scenePromptHints }
      );
      return streamConclusionAndReturn(finalizedFallback);
    }

    return streamConclusionAndReturn(conclusion);
  } catch (error) {
    emitter.log(`Failed to generate conclusion: ${error}`);
    emitter.emitUpdate('degraded', {
      module: 'conclusionGenerator',
      fallback: insightEnabled ? `rule-based insight (${outputMode})` : (turnCount >= 1 ? 'rule-based dialogue' : 'rule-based summary'),
    });
  }

  if (insightEnabled) {
    const fallbackEvidenceFindings = outputMode === 'need_input' ? sortedFindings : finalFindings;
    const fallback = outputMode === 'need_input'
      ? generateInsightFallback(
          outputMode,
          sortedFindings,
          confirmedHypotheses.map(h => h.description),
          stopReason,
          historyContext,
          contradictionReasons
        )
      : generateAttributionSafeFallback(
          attributionAssessment,
          finalFindings,
          contradictionReasons,
          stopReason,
          scopedJankSummary,
          frameMechanismRecords
        );
    const deterministicFallback = toDeterministicConclusionMarkdown(
      fallback,
      outputMode,
      contractRenderOptions,
      emitter
    );
    const finalizedFallback = finalizeConclusionMarkdown(
      deterministicFallback,
      fallbackEvidenceFindings,
      scopedJankSummary,
      { singleFrameDrillDown, scenePromptHints }
    );
    return streamConclusionAndReturn(finalizedFallback);
  }

  const plainFallback = turnCount >= 1
    ? generateDialogueFallback(sortedFindings, intent, stopReason, historyContext)
    : generateSimpleConclusion(sortedFindings, stopReason);
  return streamConclusionAndReturn(plainFallback);
}

function buildJankFrameBudgetSection(traceConfig?: SharedAgentContext['traceConfig']): string {
  const content = traceConfig
    ? (traceConfig.isVRR
      ? `- **VRR/LTPO 模式: ${traceConfig.vrrMode}**
- **主导刷新率: ${traceConfig.refreshRateHz}Hz**（用于大部分帧的判断）
- **帧预算范围: ${traceConfig.minFrameBudgetMs || traceConfig.vsyncPeriodMs}ms - ${traceConfig.maxFrameBudgetMs || traceConfig.vsyncPeriodMs}ms**
- ⚠️ VRR 设备帧预算动态变化，使用最严格标准（${traceConfig.minFrameBudgetMs || traceConfig.vsyncPeriodMs}ms）判断 jank`
      : `- **检测到的刷新率: ${traceConfig.refreshRateHz}Hz**
- **帧预算: ${traceConfig.vsyncPeriodMs}ms**
- 数据来源: ${traceConfig.vsyncSource}`)
    : '- 刷新率未检测到，默认使用 120Hz（8.33ms）作为帧预算';

  return `## 刷新率与帧预算
${content}`;
}

function buildNonInsightConflictRulesSection(
  scenePromptHints: ConclusionScenePromptHints,
  traceConfig?: SharedAgentContext['traceConfig']
): string {
  if (!isJankSceneId(scenePromptHints.sceneId)) {
    return `## 矛盾数据处理规则
如果发现多个 findings 之间存在矛盾，请按以下规则处理：

1. 同口径 + 同时间窗 + 同对象（进程/线程/实体）冲突，才标记为真实矛盾。
2. 若统计口径或时间窗不同，先解释差异来源，不要直接下“互相否定”结论。
3. 优先采信置信度更高且证据链更完整的 Finding，并明确说明取舍理由。`;
  }

  return `${buildJankFrameBudgetSection(traceConfig)}

## 矛盾数据处理规则
如果发现多个 findings 之间存在矛盾，请按以下规则处理：

1. **Q4（休眠/阻塞）占比高** vs **主线程耗时操作**：
   - 需要同时满足两个条件才判定为"阻塞/等待"问题：
     a) Q4 占比 > 30%
     b) Q4 绝对耗时 > 帧预算的 50%（如 120Hz 下 > 4ms）
   - 如果 Q4 占比高但绝对耗时很短（如 2ms），可能只是正常的 Binder/IPC 开销
   - 只有当 Q1+Q2（Running 状态）耗时超过帧预算时，才判定为"主线程耗时操作"

2. **RenderThread 阻塞** vs **GPU 瓶颈**：
   - RenderThread 的 Q4 高可能是等待 GPU Fence 信号，而非 CPU 阻塞
   - 如果同时存在 GPU 频率/负载数据，应综合判断是 GPU 能力不足还是 CPU 等待
   - GPU Fence > 3ms 通常表示 GPU 瓶颈

3. **App 侧正常** vs **消费端掉帧**：
   - App 帧生产正常但消费端掉帧，说明问题在 SurfaceFlinger/HWC 层
   - 此时不应归因于 App，而应指出系统合成层的瓶颈
   - 常见原因：SF 合成延迟、HWC 提交延迟、GPU 合成耗时

4. **掉帧数量不一致**（如 "25 个卡顿帧" vs "38 个卡顿帧"）：
   - 不同统计口径可能导致数量差异：
     - App 报告：App 自己统计的掉帧（可能漏报消费端问题）
     - 消费端检测：用户实际感知的掉帧（包含系统层问题）
     - 帧列表：逐帧分析的结果
   - 如果来自不同 session_id 或不同时间窗（例如区间1 vs 区间2），属于区间差异，不应判定为矛盾
   - 仅当“同口径 + 同时间窗 + 同进程”下出现冲突，才标记为矛盾
   - 应说明使用的是哪个口径，并引用具体 Finding 来源

5. **CPU 频率低** vs **主线程耗时**：
   - 大核频率 < 1.2GHz 时，耗时问题可能是功耗策略导致
   - 此时应指出"CPU 调度/频率不足"而非"代码耗时"

6. **优先采信置信度更高的 Finding**，但必须说明理由`;
}

/**
 * Generate a simple markdown-formatted conclusion without LLM.
 */
export function generateSimpleConclusion(findings: Finding[], stopReason?: string): string {
  const critical = findings.filter(f => f.severity === 'critical');
  const warnings = findings.filter(f => f.severity === 'warning');

  let conclusion = '## 分析结论\n\n';

  if (critical.length > 0) {
    conclusion += `### 严重问题 (${critical.length})\n`;
    for (const f of critical) {
      conclusion += `- **${f.title}**\n`;
    }
    conclusion += '\n';
  }

  if (warnings.length > 0) {
    conclusion += `### 需要关注 (${warnings.length})\n`;
    for (const f of warnings) {
      conclusion += `- ${f.title}\n`;
    }
    conclusion += '\n';
  }

  if (findings.length === 0) {
    conclusion += '未发现明显的性能问题。\n';
  }

  if (stopReason) {
    conclusion += `\n> 备注：分析提前结束（${stopReason}）。\n`;
  }

  return conclusion;
}

function buildInsightFirstPrompt(params: {
  mode: ConclusionOutputMode;
  turnCount: number;
  historyContext: string;
  intent: Intent;
  stopReason?: string;
  confirmedHypotheses: Array<{ description: string; confidence: number; status: string }>;
  findings: Finding[];
  contradictionSection: string;
  jankSummary?: JankCauseSummary;
  frameMechanismRecords: FrameMechanismRecord[];
  attributionAssessment: AttributionAssessment;
  scenePromptHints: ConclusionScenePromptHints;
  traceConfig?: SharedAgentContext['traceConfig'];
  investigationPath: Array<{ stepNumber: number; agentId: string; summary: string }>;
}): string {
  const parts: string[] = [];
  const singleFrameDrillDown = isSingleFrameDrillDown(params.intent);

  parts.push(`你是 SmartPerfetto 的 AI 性能分析助手，正在进行多轮对话（当前第 ${params.turnCount + 1} 轮）。`);
  parts.push('你的目标：给出“洞见优先”的结论，而不是套模板。');
  parts.push('');

  parts.push('## 用户本轮输入');
  parts.push(params.intent.primaryGoal);
  parts.push('');

  if (params.intent.followUpType && params.intent.followUpType !== 'initial') {
    parts.push(`Follow-up 类型: ${params.intent.followUpType}`);
    if (params.intent.referencedEntities && params.intent.referencedEntities.length > 0) {
      parts.push(`引用实体: ${params.intent.referencedEntities.map(e => `${e.type}:${String(e.value ?? e.id)}`).join(', ')}`);
    }
    parts.push('');
  }

  if (params.stopReason) {
    parts.push('## 本轮停止原因');
    parts.push(params.stopReason);
    parts.push('');
  }

  if (params.historyContext) {
    parts.push('## 对话历史摘要（用于承接上下文）');
    parts.push(params.historyContext);
    parts.push('');
  }

  if (singleFrameDrillDown) {
    parts.push('## 单帧 Drill-Down 范围约束');
    parts.push('- 本轮只允许使用目标帧或同一时间窗的直接证据。');
    parts.push('- 禁止沿用历史轮次的聚类帧数/占比（如 K1/K2/K3 百分比）。');
    parts.push('- 若识别到主线程长 slice，必须解释“为什么这个 slice 慢”，并给出可执行优化方向。');
    parts.push('');
  }

  // Trace config summary (keep short)
  if (params.traceConfig) {
    try {
      const hz = params.traceConfig.refreshRateHz;
      const vsync = params.traceConfig.vsyncPeriodMs;
      const isVRR = params.traceConfig.isVRR;
      parts.push('## Trace 配置摘要');
      if (hz) parts.push(`- 刷新率: ${hz}Hz`);
      if (vsync) parts.push(`- 帧预算: ${vsync}ms`);
      if (typeof isVRR === 'boolean') parts.push(`- VRR: ${isVRR ? '是' : '否'}`);
      parts.push('');
    } catch {
      // best-effort only
    }
  }

  // Include jank cause summary if available
  if (params.jankSummary && params.jankSummary.totalJankFrames > 0) {
    parts.push(formatJankSummaryForPrompt(params.jankSummary));
    parts.push('');
  }

  if (params.confirmedHypotheses.length > 0) {
    parts.push('## 已确认假设（摘要）');
    for (const h of params.confirmedHypotheses.slice(0, 5)) {
      parts.push(`- ${h.description} (confidence: ${Number(h.confidence).toFixed(2)}, status: ${h.status})`);
    }
    parts.push('');
  }

  parts.push('## 关键发现（含数据证据）');
  if (params.findings.length === 0) {
    parts.push('无可用 findings。');
  } else {
    parts.push(params.findings.slice(0, PROMPT_FINDING_LIMIT).map(f => formatFindingWithEvidence(f)).join('\n\n'));
  }
  parts.push('');

  // Keep investigation path short for token efficiency
  if (Array.isArray(params.investigationPath) && params.investigationPath.length > 0) {
    parts.push('## 调查路径（摘要）');
    const tail = params.investigationPath.slice(-8);
    parts.push(tail.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n'));
    parts.push('');
  }

  if (params.contradictionSection) {
    parts.push(params.contradictionSection.trim());
    parts.push('');
  }

  const includeAttributionPrompt = isJankSceneId(params.scenePromptHints.sceneId);
  if (includeAttributionPrompt) {
    parts.push(buildAttributionAssessmentPromptSection(params.attributionAssessment));
    parts.push('');

    parts.push(buildMechanismTriadPromptSection(
      params.attributionAssessment,
      params.jankSummary,
      params.frameMechanismRecords
    ));
    parts.push('');
  }

  parts.push('## 场景化分析焦点');
  parts.push(`- 当前场景: ${params.scenePromptHints.sceneName}`);
  parts.push(...params.scenePromptHints.focusLines);
  parts.push('');

  if (
    includeAttributionPrompt &&
    (params.attributionAssessment.verdict === 'APP_TRIGGER' || params.attributionAssessment.verdict === 'MIXED')
  ) {
    parts.push('## 归因提示');
    parts.push('- 逐帧根因显示主线程/APP 侧耗时信号占主导（例如 cause_type=slice）。');
    parts.push('- 若同时看到“消费端掉帧”，请区分：消费端是症状层，主线程长耗时是潜在触发层。');
    parts.push('');
  }

  if (includeAttributionPrompt && params.attributionAssessment.verdict === 'SF_CONSUMER') {
    parts.push('## 归因护栏');
    parts.push('- 当前证据显示 SF/消费端责任占主导。');
    parts.push('- 在该前提下，不要直接给出“主线程/Choreographer 是主要根因”的高置信度结论。');
    parts.push('- 若判定 App 主因，必须引用同一时间窗/同一帧的直接证据链（App Deadline Missed + 主线程耗时切片）。');
    parts.push('');
  } else if (includeAttributionPrompt && params.attributionAssessment.verdict === 'INSUFFICIENT') {
    parts.push('## 归因护栏');
    parts.push('- 当前证据不足以形成单侧归因，禁止输出“唯一根因”式结论。');
    parts.push('- 若需要给出方向，必须明确“证据不足”并说明待补数据。');
    parts.push('');
  }

  parts.push('## 输出要求（必须严格遵守）');
  parts.push('- 只输出合法 JSON；禁止输出 Markdown、代码块、SQL 或额外解释。');
  parts.push('- 只基于已提供的数据与证据；不允许编造未提供的数据。');
  parts.push('- 优先用通俗表达：先说现象和影响；若必须用术语，在术语后补一句人话解释。');
  parts.push(...params.scenePromptHints.outputRequirementLines);
  parts.push(params.scenePromptHints.nextStepLine);
  parts.push('- next_steps 至少 1 条使用固定格式：owner: <负责人>; priority: P0/P1/P2; action: <具体动作>; verification: <验收方式>。');
  parts.push(`- 可给出最多 2 条与“${DEEP_REASON_LABEL}”一一对应的优化方向，避免泛化建议。`);
  parts.push('- JSON 顶层字段固定为：schema_version, mode, conclusion, clusters, evidence_chain, uncertainties, next_steps, metadata。');
  parts.push(`- mode 必须是 "${params.mode}"。schema_version 必须是 "conclusion_contract_v1"。`);
  parts.push('- 结论最终会渲染为“## 结论（按可能性排序）/## 聚类（先看大头）/## 证据链（对应上述结论）/## 不确定性与反例/## 下一步（最高信息增益）”。');
  parts.push('- conclusion 数组最多 3 项，每项包含：rank, statement, confidence, trigger, supply, amplification。');
  parts.push('- clusters 每项包含：cluster, description, frames, percentage；若有帧级证据可额外提供 frame_refs(string[])。');
  parts.push(`- trigger/supply/amplification 需要能映射为：${TRIAD_LABELS.trigger}/${TRIAD_LABELS.supply}/${TRIAD_LABELS.amplification}。`);
  parts.push(`- statement 建议包含可读三元组短句，例如：${TRIAD_LABELS.trigger}: ...；${TRIAD_LABELS.supply}: ...；${TRIAD_LABELS.amplification}: ...`);
  if (!singleFrameDrillDown && params.scenePromptHints.clusterPolicy.outputMode === 'required') {
    parts.push('- clusters 必须按样本数降序列出 Top3（K1/K2/K3），并标注样本数与占比。');
  } else if (!singleFrameDrillDown && params.scenePromptHints.clusterPolicy.outputMode === 'optional') {
    parts.push('- 当前场景 clusters 可按时间阶段/样本分组给出；若无聚类证据可传空数组。');
  } else if (!singleFrameDrillDown) {
    parts.push('- 当前场景 clusters 必须传空数组，不要虚构聚类。');
  } else {
    parts.push('- 单帧 drill-down 禁止复用历史 K1/K2/K3；clusters 传空数组。');
  }
  parts.push('- evidence_chain 必须按 C1/C2/C3 对齐（C1=结论1）：每项包含 conclusion_id 和 evidence 文本，且包含至少 1 个 evidence id（ev_xxxxxxxxxxxx）。');
  parts.push('- metadata 可包含 confidence（0-100 或 0-1）与 rounds（正整数）。');
  parts.push('- metadata 可包含 cluster_policy 对象：{ output_mode: required|optional|none, frame_list_mode: none|top|full, max_frames_per_cluster?: number }。');
  parts.push('- metadata 可包含 scene_id（例如 jank/startup），用于前端场景化标题渲染。');

  if (params.mode === 'focused_answer') {
    parts.push('- 本轮是 follow-up：优先直接回答用户本轮焦点，不要复述历史长文；总长度尽量控制在 25 行以内。');
    parts.push('- 如果证据不足以回答本轮问题：在“不确定性与反例”里说明缺口，并在“下一步”里给出 1-2 个最关键的问题或动作。');
  } else if (params.mode === 'need_input') {
    parts.push('- 当前证据不足：可以给出低置信度的方向，但必须明确“证据不足”。');
    parts.push('- 在“下一步”里给出最多 2 个必须回答的问题（每行以 "Q:" 开头），并给出 2-3 个可选动作（以 "A."/"B."/"C." 开头）。');
  } else {
    parts.push('- 首轮报告：允许更完整，但避免无关的长篇背景科普；引用具体 findings 数据。');
  }

  parts.push('- 全部中文。');

  return parts.join('\n');
}

function generateInsightFallback(
  mode: ConclusionOutputMode,
  findings: Finding[],
  hypothesisDescriptions: string[],
  stopReason?: string,
  historyContext?: string,
  contradictionReasons?: string[]
): string {
  const lines: string[] = [];

  const topFindings = findings.slice(0, 5);
  const topFindingTitles = topFindings
    .filter(f => typeof f.title === 'string' && f.title.trim().length > 0)
    .map(f => `[${f.severity}] ${f.title}`);

  lines.push('## 结论（按可能性排序）');
  if (topFindingTitles.length > 0) {
    lines.push(`1. 最可能的问题与本轮证据一致（置信度: 60%）。`);
    lines.push(`2. 仍存在其他可能方向需要排除（置信度: 40%）。`);
  } else if (hypothesisDescriptions.length > 0) {
    lines.push(`1. 当前仅有假设线索，尚缺少直接证据（置信度: 40%）。`);
  } else {
    lines.push('1. 当前证据不足，无法给出可靠诊断结论（置信度: 20%）。');
  }
  lines.push('');

  lines.push('## 证据链（对应上述结论）');
  if (topFindingTitles.length > 0) {
    const conclusionCount = 2;
    for (let i = 0; i < Math.min(conclusionCount, 3); i += 1) {
      const f = topFindings[i] || topFindings[0];
      const evIds = extractEvidenceIdsFromFinding(f).slice(0, 2);
      const evStr = evIds.length > 0 ? ` (${evIds.join('|')})` : '';
      lines.push(`- C${i + 1}: [${f.severity}] ${f.title}${evStr}`.trim());
    }
  } else if (hypothesisDescriptions.length > 0) {
    const combined = hypothesisDescriptions.slice(0, 2).join('；');
    lines.push(`- C1: 假设线索（证据不足，无 ev_ id）：${combined}`);
  } else if (historyContext) {
    lines.push('- C1: 可用上下文来自对话历史摘要，但缺少结构化证据（findings/ev_）。');
  } else {
    lines.push('- C1: 暂无可引用的 findings/hypotheses。');
  }
  lines.push('');

  lines.push('## 不确定性与反例');
  if (Array.isArray(contradictionReasons) && contradictionReasons.length > 0) {
    lines.push(`- 当前存在数据矛盾：${contradictionReasons.slice(0, 2).join('；')}`);
  } else {
    lines.push('- 缺少关键证据或时间范围/实体引用，结论可能被后续数据推翻。');
  }
  if (stopReason) {
    lines.push(`- 备注：本轮提前结束（${stopReason}）。`);
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  if (mode === 'need_input') {
    lines.push('Q: 你希望我聚焦在哪个对象？（frame_id / session_id / 时间范围 / 进程名 任选其一即可）');
    lines.push('A. 指定一个卡顿帧（例如：frame_id=123）');
    lines.push('B. 指定一个滑动会话（例如：session_id=2）');
    lines.push('C. 指定一个时间范围（例如：1.2s~1.5s）');
  } else {
    lines.push('- 指定一个可 drill-down 的实体或时间范围（frame_id / session_id / 时间范围），我将只对该范围补证据并更新结论。');
    lines.push('- 如果你想“比较”，请同时给出两个实体（例如：frame_id=123 vs frame_id=456）。');
  }

  return lines.join('\n');
}

const EVIDENCE_ID_RE = /^ev_[0-9a-f]{12}$/;

function readEvidenceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return EVIDENCE_ID_RE.test(trimmed) ? trimmed : null;
}

function extractEvidenceIdsFromFinding(f: Finding): string[] {
  const ids: string[] = [];
  const arr = toEvidenceArray((f as FindingWithEvidence).evidence);
  for (const e of arr) {
    if (!e) continue;
    if (typeof e === 'string') {
      const id = readEvidenceId(e);
      if (id) ids.push(id);
      continue;
    }
    const evidenceObject = asEvidenceObject(e);
    if (evidenceObject) {
      const id = readEvidenceId(evidenceObject.evidenceId || evidenceObject.evidence_id);
      if (id) ids.push(id);
    }
  }
  const seen = new Set<string>();
  return ids.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function extractEvidenceRefsFromFindings(findings: Finding[]): Array<{ evidenceId: string; title?: string; kind?: string }> {
  const out: Array<{ evidenceId: string; title?: string; kind?: string }> = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const arr = toEvidenceArray((f as FindingWithEvidence).evidence);
    for (const e of arr) {
      if (!e) continue;
      const evidenceObject = asEvidenceObject(e);
      if (evidenceObject) {
        const evidenceId = readEvidenceId(evidenceObject.evidenceId || evidenceObject.evidence_id);
        if (!evidenceId || seen.has(evidenceId)) continue;
        seen.add(evidenceId);
        out.push({
          evidenceId,
          title: typeof evidenceObject.title === 'string' ? String(evidenceObject.title) : undefined,
          kind: typeof evidenceObject.kind === 'string' ? String(evidenceObject.kind) : undefined,
        });
      } else if (typeof e === 'string') {
        const evidenceId = readEvidenceId(e);
        if (evidenceId && !seen.has(evidenceId)) {
          seen.add(evidenceId);
          out.push({ evidenceId });
        }
      }
    }
  }

  return out;
}

function findMarkdownSection(
  text: string,
  headerRe: RegExp
): null | { headerStart: number; headerEnd: number; bodyStart: number; bodyEnd: number; body: string } {
  const m = headerRe.exec(text);
  if (!m) return null;

  const headerStart = m.index;
  const headerEnd = headerStart + m[0].length;

  let bodyStart = headerEnd;
  if (text[bodyStart] === '\r' && text[bodyStart + 1] === '\n') bodyStart += 2;
  else if (text[bodyStart] === '\n') bodyStart += 1;

  const nextHeaderRe = /^##\s+/gm;
  nextHeaderRe.lastIndex = bodyStart;
  const next = nextHeaderRe.exec(text);
  const bodyEnd = next ? next.index : text.length;
  const body = text.slice(bodyStart, bodyEnd);

  return { headerStart, headerEnd, bodyStart, bodyEnd, body };
}

function extractConclusionItemsFromSection(sectionBody: string): Array<{ index: number; text: string }> {
  const lines = String(sectionBody || '').split(/\r?\n/);
  const items: Array<{ index: number; text: string }> = [];

  let autoIndex = 1;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const mNum = /^([1-3])\s*[.)、]\s*(.+)$/.exec(line);
    if (mNum) {
      const idx = Number(mNum[1]);
      const text = mNum[2].trim();
      if (text) items.push({ index: idx, text });
      continue;
    }

    const mC = /^C([1-3])\s*[:：]\s*(.+)$/.exec(line);
    if (mC) {
      const idx = Number(mC[1]);
      const text = mC[2].trim();
      if (text) items.push({ index: idx, text });
      continue;
    }

    const mBullet = /^-\s+(.+)$/.exec(line);
    if (mBullet && autoIndex <= 3) {
      const text = mBullet[1].trim();
      if (text) items.push({ index: autoIndex, text });
      autoIndex += 1;
    }
  }

  // Ensure order by index and keep at most 3.
  const byIndex = new Map<number, string>();
  for (const it of items) {
    if (it.index < 1 || it.index > 3) continue;
    if (!byIndex.has(it.index)) byIndex.set(it.index, it.text);
  }

  const out: Array<{ index: number; text: string }> = [];
  for (const i of [1, 2, 3]) {
    const t = byIndex.get(i);
    if (t) out.push({ index: i, text: t });
  }
  return out;
}

function scoreConclusionToFinding(conclusionText: string, f: Finding): number {
  const c = String(conclusionText || '').toLowerCase();
  const t = String(f.title || '').toLowerCase();
  const d = String(f.description || '').toLowerCase();
  const hay = `${t}\n${d}`;

  if (!c.trim() || !hay.trim()) return 0;

  // Lightweight keyword overlap for CN/EN mixed strings (no tokenization needed).
  const keywords = [
    'jank', 'fps', 'frame', 'vsync', 'budget', 'refresh',
    'gpu', 'renderthread', 'surfaceflinger', 'sf', 'hwc',
    'cpu', 'sched', 'freq', 'cluster',
    'binder', 'ipc',
    'io', 'block', 'irq',
    'lmk', 'oom',
    'gc', 'thermal', 'throttle', 'vrr', 'ltpo',
    '主线程', 'ui', '渲染', '合成', '掉帧', '卡顿', '滑动', '启动', '交互', 'anr',
  ];

  let score = 0;
  for (const k of keywords) {
    const kk = k.toLowerCase();
    if (c.includes(kk) && hay.includes(kk)) score += 3;
  }

  // Bonus for direct substring hints.
  if (t && c.includes(t)) score += 6;
  if (t && t.includes(c)) score += 4;

  // Severity / confidence as a soft prior.
  const sevBoost = f.severity === 'critical' ? 3 : (f.severity === 'warning' ? 2 : 1);
  score += sevBoost;
  score += Math.round(((f.confidence ?? 0.5) * 10));

  return score;
}

function injectPerConclusionEvidenceMapping(markdown: string, findings: Finding[]): string {
  const text = String(markdown || '');
  if (!text.trim()) return text;

  const conclusionSection = findMarkdownSection(text, /^##\s*结论[（(]按可能性排序[）)]\s*$/m);
  const evidenceSection = findMarkdownSection(text, /^##\s*证据链[（(]对应上述结论[）)]\s*$/m);
  if (!evidenceSection) return text;

  const conclusions = conclusionSection
    ? extractConclusionItemsFromSection(conclusionSection.body).slice(0, 3)
    : [];
  const conclusionCount = conclusions.length > 0 ? conclusions.length : 1;

  const body = evidenceSection.body;
  const missing: number[] = [];
  for (let i = 1; i <= conclusionCount; i += 1) {
    const hasLineWithEv = new RegExp(`^\\s*-?\\s*C${i}\\b.*\\bev_[0-9a-f]{12}\\b`, 'm').test(body);
    if (!hasLineWithEv) missing.push(i);
  }
  if (missing.length === 0) return text;

  const usableFindings = findings.filter(f => !f.details?._contradicted);
  const candidates = usableFindings
    .map(f => ({ finding: f, evIds: extractEvidenceIdsFromFinding(f) }))
    .filter(c => c.evIds.length > 0);
  if (candidates.length === 0) return text;

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const usedEv = new Set<string>();
  const usedFindingIds = new Set<string>();

  const injectedLines: string[] = [];
  for (const idx of missing.slice(0, 3)) {
    const conclusionText = conclusions.find(c => c.index === idx)?.text || '';

    // Pick best matching finding; fall back to highest confidence.
    const scored = candidates
      .filter(c => !usedFindingIds.has(String(c.finding.id || '')))
      .map(c => ({ ...c, score: scoreConclusionToFinding(conclusionText, c.finding) }))
      .sort((a, b) => b.score - a.score);

    const picked = scored[0] || candidates[0];
    if (!picked) continue;

    const evIds = picked.evIds.filter(id => !usedEv.has(id)).slice(0, 2);
    const finalEvIds = evIds.length > 0 ? evIds : picked.evIds.slice(0, 1);
    for (const id of finalEvIds) usedEv.add(id);
    if (picked.finding.id) usedFindingIds.add(String(picked.finding.id));

    const evStr = finalEvIds.length > 0 ? `(${finalEvIds.join('|')})` : '';
    const cStr = conclusionText ? truncate(conclusionText, 56) : `对应结论 ${idx}`;
    const fStr = truncate(String(picked.finding.title || picked.finding.description || ''), 56);
    const attachFindingTitle = picked.score >= 16;
    injectedLines.push(`- C${idx}（自动补全）: ${cStr} ← ${evStr}${attachFindingTitle && fStr ? ` ${fStr}` : ''}`.trim());
  }

  if (injectedLines.length === 0) return text;

  // If we are injecting evidence lines, remove placeholder "证据链信息缺失"
  // to avoid contradictory output ("auto-filled" + "missing" at the same time).
  const evidenceBody = String(evidenceSection.body || '');
  const sanitizedBody = evidenceBody
    .split('\n')
    .filter(line => !/^\s*-\s*证据链信息缺失\s*$/.test(line))
    .join('\n');

  return `${text.slice(0, evidenceSection.bodyStart)}${injectedLines.join('\n')}\n${sanitizedBody}${text.slice(evidenceSection.bodyEnd)}`;
}

function injectEvidenceIndexIntoEvidenceChain(markdown: string, findings: Finding[]): string {
  const text = String(markdown || '');
  if (!text.trim()) return text;

  const refs = extractEvidenceRefsFromFindings(findings).slice(0, 4);
  if (refs.length === 0) return text;

  const headerRe = /^##\s*证据链（对应上述结论）\s*$/m;
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return text;

  const headerIdx = headerMatch.index;
  const afterHeaderIdx = headerIdx + headerMatch[0].length;

  // Find next "##" heading after evidence section header.
  const nextHeaderRe = /^##\s+/gm;
  nextHeaderRe.lastIndex = afterHeaderIdx;
  const next = nextHeaderRe.exec(text);
  const sectionEnd = next ? next.index : text.length;

  const sectionBody = text.slice(afterHeaderIdx, sectionEnd);
  if (/\bev_[0-9a-f]{12}\b/.test(sectionBody)) return text;

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const items = refs
    .map(r => `(${r.evidenceId}) ${truncate(String(r.title || r.kind || ''), 48)}`.trim())
    .join('；');
  const line = `- 证据索引（自动补全）: ${items}`;

  return `${text.slice(0, sectionEnd).trimEnd()}\n${line}\n${text.slice(sectionEnd).trimStart()}`;
}



function generateDialogueFallback(
  findings: Finding[],
  intent: Intent,
  stopReason?: string,
  historyContext?: string
): string {
  const lines: string[] = [];

  // 1) Minimal acknowledgement of the user request
  lines.push(`我理解你想继续推进：${intent.primaryGoal}`);

  // 2) Keep it short: surface what we have (if any)
  const topTitles = findings
    .filter(f => typeof f.title === 'string' && f.title.trim().length > 0)
    .slice(0, 3)
    .map(f => f.title.trim());
  if (topTitles.length > 0) {
    lines.push(`目前可承接的线索：${topTitles.join('；')}`);
  } else if (historyContext) {
    lines.push('目前我会基于已有对话上下文继续推进。');
  }

  if (stopReason) {
    lines.push(`备注：本轮提前结束（${stopReason}）。`);
  }

  // 3) Ask the minimal next question(s)
  lines.push('Q: 你希望我下一步聚焦在哪里？（给出 frame_id / session_id / 时间范围 / 进程名之一即可）');
  lines.push('A. 深入某个卡顿帧（例如：frame_id=123）');
  lines.push('B. 深入某个滑动会话（例如：session_id=2）');
  lines.push('C. 重新指定一个时间范围（例如：1.2s~1.5s）');

  return lines.join('\n');
}

export function shouldNormalizeConclusionOutput(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;

  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('```')) {
    return true;
  }

  const sectioned = parseJsonLikeSections(t);
  if (sectioned) {
    const signalCount =
      sectioned.conclusion.length +
      sectioned.evidence_chain.length +
      sectioned.uncertainties.length +
      sectioned.next_steps.length;
    if (signalCount > 0) return true;
  }

  return false;
}

export function normalizeConclusionOutput(rawText: string): string {
  const contractOptions: ContractRenderOptions = { singleFrameDrillDown: false };
  const directContract = parseJsonToConclusionContract(rawText, 'initial_report', contractOptions);
  if (directContract) {
    return renderConclusionContract(directContract, contractOptions);
  }

  const converted = convertJsonToMarkdown(rawText);
  const fromJsonLike = convertJsonLikeSectionsToMarkdown(rawText, contractOptions);
  const preferredMarkdown = looksLikeMarkdownConclusion(converted)
    ? converted
    : (fromJsonLike || converted);
  const markdownContract = parseMarkdownToConclusionContract(
    preferredMarkdown,
    'initial_report',
    contractOptions
  );
  if (markdownContract) {
    return renderConclusionContract(markdownContract, contractOptions);
  }

  return preferredMarkdown;
}

function looksLikeMarkdownConclusion(text: string): boolean {
  const t = String(text || '');
  return /^##\s*结论/m.test(t) || /^##\s*分析结论/m.test(t);
}

function convertJsonLikeSectionsToMarkdown(
  rawText: string,
  options: ContractRenderOptions = { singleFrameDrillDown: false }
): string | null {
  const sections = parseJsonLikeSections(rawText);
  if (!sections) return null;

  const lines: string[] = [];
  const conclusions: Array<{ statement: string; confidence?: number }> = [];
  const clusterLines: string[] = [];
  const evidenceLines: string[] = [];
  const uncertainties: string[] = [];
  const nextSteps: string[] = [];
  const metadataLines: string[] = [];

  for (const line of sections.conclusion) {
    const obj = parseJsonLine(line);
    if (obj) {
      const statement = readSemanticText(obj, 'statement');
      const confidence = normalizeConfidencePercent(readSemanticNumber(obj, 'confidence'));
      if (statement) {
        conclusions.push({
          statement,
          confidence,
        });
        continue;
      }

      const trigger = readSemanticText(obj, 'trigger');
      const supply = readSemanticText(obj, 'supply');
      const amp = readSemanticText(obj, 'amplification');
      if (trigger || supply || amp) {
        const triadStatement = buildTriadStatement({
          ...(trigger ? { trigger } : {}),
          ...(supply ? { supply } : {}),
          ...(amp ? { amplification: amp } : {}),
        });
        conclusions.push({
          statement: triadStatement,
          confidence,
        });
        continue;
      }
    }
    const plain = stripBulletPrefix(line.trim());
    if (plain) conclusions.push({ statement: plain });
  }

  for (const line of sections.clusters) {
    const obj = parseJsonLine(line);
    if (obj) {
      const formatted = formatClusterLineFromJsonLikeObject(obj);
      if (formatted) {
        clusterLines.push(formatted);
        continue;
      }
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) clusterLines.push(`- ${plain}`);
  }

  for (const line of sections.evidence_chain) {
    const obj = parseJsonLine(line);
    if (obj) {
      const cid =
        readSemanticText(obj, 'conclusion_id') ||
        'C1';
      const evidenceTexts = extractEvidenceTextsFromJsonLikeObject(obj);
      for (const evText of evidenceTexts) {
        if (/^C\d+[:：]/i.test(evText)) {
          evidenceLines.push(`- ${evText}`);
        } else {
          evidenceLines.push(`- ${cid}: ${evText}`);
        }
      }
      if (evidenceTexts.length === 0) {
        evidenceLines.push(`- ${cid}: 原始证据项缺少可展示文本（需补充数据说明）`);
      }
      continue;
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) evidenceLines.push(`- ${plain}`);
  }

  for (const line of sections.uncertainties) {
    const obj = parseJsonLine(line);
    if (obj) {
      const point = readSemanticText(obj, 'uncertainty_point');
      const explanation = readSemanticText(obj, 'uncertainty_reason');
      if (point && explanation) {
        uncertainties.push(normalizeUncertaintyWording(`${point}：${explanation}`));
        continue;
      }
      if (point) {
        uncertainties.push(normalizeUncertaintyWording(point));
        continue;
      }
      if (explanation) {
        uncertainties.push(normalizeUncertaintyWording(explanation));
        continue;
      }
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) uncertainties.push(normalizeUncertaintyWording(plain));
  }

  for (const line of sections.next_steps) {
    const obj = parseJsonLine(line);
    if (obj) {
      const action = readSemanticText(obj, 'next_action');
      const reason = readSemanticText(obj, 'next_reason');
      if (action && reason) {
        nextSteps.push(normalizeNextStepWording(`${action}（原因：${reason}）`));
        continue;
      }
      if (action) {
        nextSteps.push(normalizeNextStepWording(action));
        continue;
      }
      if (reason) {
        nextSteps.push(normalizeNextStepWording(reason));
        continue;
      }
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) nextSteps.push(normalizeNextStepWording(plain));
  }

  for (const line of sections.metadata) {
    const obj = parseJsonLine(line);
    if (obj) {
      const confidence = normalizeConfidencePercent(readSemanticNumber(obj, 'confidence'));
      if (typeof confidence === 'number') {
        metadataLines.push(`- 置信度: ${Math.round(confidence)}%`);
      }
      const rounds = readSemanticNumber(obj, 'rounds');
      if (typeof rounds === 'number' && rounds > 0) {
        metadataLines.push(`- 分析轮次: ${Math.round(rounds)}`);
      }
      continue;
    }

    const plain = stripBulletPrefix(line.trim());
    if (plain) metadataLines.push(`- ${plain}`);
  }

  const normalizedNextSteps = [...new Set(nextSteps.filter(Boolean))];

  lines.push('## 结论（按可能性排序）');
  if (conclusions.length === 0) {
    lines.push('1. 结论信息缺失（置信度: 40%）');
  } else {
    conclusions.slice(0, 3).forEach((item, idx) => {
      const conf = Number.isFinite(item.confidence) ? `（置信度: ${Math.round(item.confidence!)}%）` : '';
      lines.push(`${idx + 1}. ${item.statement}${conf}`);
    });
  }
  lines.push('');

  lines.push(resolveClusterSectionHeading(options.scenePromptHints?.sceneId));
  if (clusterLines.length === 0) {
    lines.push('- 暂无');
  } else {
    lines.push(...clusterLines.slice(0, 5));
  }
  lines.push('');

  lines.push('## 证据链（对应上述结论）');
  if (evidenceLines.length === 0) {
    lines.push('- 证据链信息缺失');
  } else {
    lines.push(...evidenceLines);
  }
  lines.push('');

  lines.push('## 不确定性与反例');
  if (uncertainties.length === 0) {
    lines.push('- 暂无');
  } else {
    uncertainties.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  if (normalizedNextSteps.length === 0) {
    lines.push('- 暂无');
  } else {
    normalizedNextSteps.forEach((item) => lines.push(`- ${item}`));
  }

  if (metadataLines.length > 0) {
    lines.push('');
    lines.push('## 分析元数据');
    lines.push(...metadataLines);
  }

  return lines.join('\n');
}

type JsonLikeSection = 'conclusion' | 'clusters' | 'evidence_chain' | 'uncertainties' | 'next_steps' | 'metadata';

function parseJsonLikeSections(rawText: string): Record<JsonLikeSection, string[]> | null {
  const sectionAlias: Record<string, JsonLikeSection> = {
    conclusion: 'conclusion',
    结论: 'conclusion',
    jank_clusters: 'clusters',
    jank_cluster: 'clusters',
    clusters: 'clusters',
    cluster: 'clusters',
    掉帧聚类: 'clusters',
    聚类: 'clusters',
    evidence_chain: 'evidence_chain',
    证据链: 'evidence_chain',
    uncertainties: 'uncertainties',
    uncertainty: 'uncertainties',
    uncertainty_and_counterexamples: 'uncertainties',
    uncertainty_and_counterexample: 'uncertainties',
    不确定性与反例: 'uncertainties',
    不确定性: 'uncertainties',
    反例: 'uncertainties',
    next_steps: 'next_steps',
    next_step: 'next_steps',
    下一步: 'next_steps',
    analysis_metadata: 'metadata',
    analysis_meta: 'metadata',
    metadata: 'metadata',
    meta: 'metadata',
    分析元数据: 'metadata',
    元数据: 'metadata',
  };

  const out = {
    conclusion: [] as string[],
    clusters: [] as string[],
    evidence_chain: [] as string[],
    uncertainties: [] as string[],
    next_steps: [] as string[],
    metadata: [] as string[],
  };

  let current: keyof typeof out | null = null;
  let hitHeader = false;
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const headerMatch = line.match(/^([A-Za-z_\u4e00-\u9fa5]+)\s*[:：]\s*(.*)$/);
    if (headerMatch) {
      const mapped = sectionAlias[String(headerMatch[1] || '').toLowerCase()];
      if (mapped) {
        current = mapped;
        hitHeader = true;
        const inlineContent = String(headerMatch[2] || '').trim();
        if (inlineContent) out[current].push(inlineContent);
        continue;
      }
      if (current && line) {
        out[current].push(line);
      }
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (line) out[current].push(line);
  }

  if (!hitHeader) return null;

  const hasSignal =
    out.conclusion.length > 0 ||
    out.clusters.length > 0 ||
    out.evidence_chain.length > 0 ||
    out.uncertainties.length > 0 ||
    out.next_steps.length > 0 ||
    out.metadata.length > 0;
  return hasSignal ? out : null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const s = String(line || '')
    .trim()
    .replace(/[·。]\s*$/, '')
    .replace(/,\s*$/, '');
  if (!(s.startsWith('{') && s.endsWith('}'))) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

type SemanticTextField =
  | 'statement'
  | 'trigger'
  | 'supply'
  | 'amplification'
  | 'conclusion_id'
  | 'uncertainty_point'
  | 'uncertainty_reason'
  | 'next_action'
  | 'next_reason'
  | 'source'
  | 'cluster_label'
  | 'cluster_description';

type SemanticNumberField =
  | 'confidence'
  | 'rounds'
  | 'cluster_rank'
  | 'cluster_frames'
  | 'cluster_percentage';

type SemanticRule = {
  aliases: string[];
  patterns: RegExp[];
};

const SEMANTIC_TEXT_RULES: Record<SemanticTextField, SemanticRule> = {
  statement: {
    aliases: ['statement', 'summary', 'conclusion', '结论', '描述', '说明'],
    patterns: [/statement|summary|conclusion|结论|描述|说明/i],
  },
  trigger: {
    aliases: ['trigger', 'trigger_factor', 'triggerFactor', '触发因子', '直接原因'],
    patterns: [/trigger|触发|直接原因/i],
  },
  supply: {
    aliases: ['supply', 'supply_constraint', 'supplyConstraint', '供给约束', '资源瓶颈', '资源问题'],
    patterns: [/supply|constraint|bottleneck|供给约束|资源瓶颈|资源问题|瓶颈/i],
  },
  amplification: {
    aliases: ['amplification', 'amplification_path', 'amplificationPath', '放大路径', '放大环节', '放大因素'],
    patterns: [/amplification|amplify|path|放大路径|放大环节|放大因素|放大/i],
  },
  conclusion_id: {
    aliases: ['conclusion_id', 'conclusionId', 'conclusion', '结论编号', '结论ID'],
    patterns: [/conclusionid|conclusion|结论编号|结论id|cid/i],
  },
  uncertainty_point: {
    aliases: ['point', 'title', 'statement', 'topic', '问题', '标题', '结论'],
    patterns: [/point|title|statement|topic|问题|标题|结论/i],
  },
  uncertainty_reason: {
    aliases: ['explanation', 'reason', 'detail', '说明', '原因', '描述'],
    patterns: [/explanation|reason|detail|说明|原因|描述/i],
  },
  next_action: {
    aliases: ['action', 'step', 'title', 'next_step', '下一步', '动作', '步骤', '建议'],
    patterns: [/action|step|title|nextstep|下一步|动作|步骤|建议/i],
  },
  next_reason: {
    aliases: ['reason', 'explanation', 'detail', '原因', '说明'],
    patterns: [/reason|explanation|detail|原因|说明/i],
  },
  source: {
    aliases: ['source', 'skill', '来源'],
    patterns: [/source|skill|来源/i],
  },
  cluster_label: {
    aliases: ['cluster', 'name', 'pattern', '聚类', '簇', 'clusterId', 'cluster_id'],
    patterns: [/cluster|name|pattern|聚类|簇/i],
  },
  cluster_description: {
    aliases: ['description', 'desc', '描述', '特征'],
    patterns: [/description|desc|描述|特征/i],
  },
};

const SEMANTIC_NUMBER_RULES: Record<SemanticNumberField, SemanticRule> = {
  confidence: {
    aliases: ['confidence', 'overall_confidence', '置信度'],
    patterns: [/confidence|overallconfidence|置信度/i],
  },
  rounds: {
    aliases: ['rounds', 'analysis_rounds', 'iterations', '分析轮次', '轮次'],
    patterns: [/rounds|analysisrounds|iterations|分析轮次|轮次/i],
  },
  cluster_rank: {
    aliases: ['rank', '排序', '序号'],
    patterns: [/rank|排序|序号/i],
  },
  cluster_frames: {
    aliases: ['frames', 'frameCount', 'frame_count', '帧数'],
    patterns: [/frames|framecount|帧数/i],
  },
  cluster_percentage: {
    aliases: ['percentage', 'pct', 'ratio', '占比', '比例'],
    patterns: [/percentage|pct|ratio|占比|比例/i],
  },
};

function normalizeJsonLikeKey(key: string): string {
  return String(key || '')
    .trim()
    .replace(/[\s_\-]/g, '')
    .toLowerCase();
}

function buildNormalizedAliasSet(aliases: string[]): Set<string> {
  return new Set(aliases.map((alias) => normalizeJsonLikeKey(alias)));
}

function readTextByRule(obj: Record<string, unknown>, rule: SemanticRule): string {
  const aliasSet = buildNormalizedAliasSet(rule.aliases);
  let fuzzyMatch = '';

  for (const [rawKey, rawValue] of Object.entries(obj)) {
    if (typeof rawValue !== 'string') continue;
    const text = stripBulletPrefix(rawValue.trim());
    if (!text) continue;

    const normalizedKey = normalizeJsonLikeKey(rawKey);
    if (aliasSet.has(normalizedKey)) {
      return text;
    }
    if (!fuzzyMatch && rule.patterns.some((pattern) => pattern.test(normalizedKey))) {
      fuzzyMatch = text;
    }
  }

  return fuzzyMatch;
}

function readSemanticText(obj: Record<string, unknown>, field: SemanticTextField): string {
  return readTextByRule(obj, SEMANTIC_TEXT_RULES[field]);
}

function readNumberValue(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const normalized = raw.trim().replace(/[%％]/g, '');
  if (!normalized) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function readNumberByRule(obj: Record<string, unknown>, rule: SemanticRule): number | undefined {
  const aliasSet = buildNormalizedAliasSet(rule.aliases);
  let fuzzyMatch: number | undefined;

  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const value = readNumberValue(rawValue);
    if (!Number.isFinite(value)) continue;

    const normalizedKey = normalizeJsonLikeKey(rawKey);
    if (aliasSet.has(normalizedKey)) {
      return value;
    }
    if (fuzzyMatch === undefined && rule.patterns.some((pattern) => pattern.test(normalizedKey))) {
      fuzzyMatch = value;
    }
  }

  return fuzzyMatch;
}

function readSemanticNumber(obj: Record<string, unknown>, field: SemanticNumberField): number | undefined {
  return readNumberByRule(obj, SEMANTIC_NUMBER_RULES[field]);
}

function readValueFromAliases(obj: Record<string, unknown>, aliases: string[]): unknown {
  const aliasSet = buildNormalizedAliasSet(aliases);
  for (const [rawKey, value] of Object.entries(obj)) {
    if (aliasSet.has(normalizeJsonLikeKey(rawKey))) {
      return value;
    }
  }
  return undefined;
}

function normalizeConfidencePercent(raw?: number): number | undefined {
  if (!Number.isFinite(raw)) return undefined;
  if ((raw as number) <= 1) return (raw as number) * 100;
  return raw;
}

function extractEvidenceTextsFromJsonLikeObject(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pushIfUseful = (raw: unknown) => {
    const text = stripBulletPrefix(String(raw || '').trim())
      .replace(/[（(]\s*证据\s*[:：]\s*[）)]/g, '')
      .replace(/[（(]\s*证据\s*ID\s*[:：]\s*[）)]/gi, '')
      .replace(/证据\s*ID\s*[:：]\s*和\s*$/gi, '')
      .trim();
    if (!text) return;
    if (/^ev_[0-9a-f]{12}$/i.test(text)) return;
    if (!out.includes(text)) out.push(text);
  };

  const preferredFields = [
    'data', 'description', 'detail', 'statement', 'observation', 'metric', 'reason',
    '数据', '描述', '详情', '说明', '观察', '指标', '原因',
  ];
  for (const key of preferredFields) {
    pushIfUseful(obj[key]);
  }

  const evidence = readValueFromAliases(obj, ['evidence', '证据']);
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (typeof item === 'string') {
        pushIfUseful(item);
        continue;
      }
      const evidenceObject = asEvidenceObject(item);
      if (evidenceObject) {
        pushIfUseful(evidenceObject.title);
        pushIfUseful(evidenceObject.description);
        pushIfUseful(evidenceObject.summary);
      }
    }
  } else if (typeof evidence === 'string') {
    pushIfUseful(evidence);
  }

  const source = readSemanticText(obj, 'source');
  if (source && out.length > 0) {
    const last = out[out.length - 1];
    if (!last.includes('来源:')) {
      out[out.length - 1] = `${last}（来源: ${source}）`;
    }
  }

  return out.slice(0, 4);
}

function normalizeUncertaintyWording(text: string): string {
  const line = String(text || '').trim();
  if (!line) return line;

  const isContradiction = /矛盾|不一致|冲突/.test(line);
  const hasPercentSignals = /\d+(?:\.\d+)?%/.test(line);
  const hasDefinitionContext = /口径|分母|定义|时间窗|统计方式/.test(line);
  if (isContradiction && hasPercentSignals && !hasDefinitionContext) {
    return `${line}（可能由统计口径/分母差异导致，需统一时间窗与分母定义后再比较）`;
  }

  return line;
}

function normalizeNextStepWording(text: string): string {
  const line = String(text || '').trim();
  if (!line) return line;

  const asksMoreData = /补充/.test(line) && /数据/.test(line);
  const mentionsContradiction = /矛盾|冲突|不一致/.test(line);
  if (asksMoreData && mentionsContradiction) {
    const subject = line
      .replace(/^补充/, '')
      .replace(/的?矛盾数据.*/, '')
      .replace(/矛盾数据.*/, '')
      .replace(/数据.*/, '')
      .trim();
    if (subject) {
      return `在同一帧同一时间窗统一统计口径，复核${subject}的分母与计算方式`;
    }
    return '在同一帧同一时间窗统一统计口径，复核矛盾指标的分母与计算方式';
  }

  return line;
}

function formatClusterLineFromJsonLikeObject(obj: Record<string, unknown>): string | null {
  const clusterRaw = readSemanticText(obj, 'cluster_label');
  const description = readSemanticText(obj, 'cluster_description');
  const rankNum = readSemanticNumber(obj, 'cluster_rank');
  const rankPrefix = typeof rankNum === 'number' && rankNum > 0 ? `K${Math.round(rankNum)}` : '';

  let clusterLabel = clusterRaw;
  if (!clusterLabel && description) {
    clusterLabel = description;
  } else if (clusterLabel && description && !clusterLabel.includes(description)) {
    if (/^K\d+\b/i.test(clusterLabel) || !/[:：]/.test(clusterLabel)) {
      clusterLabel = `${clusterLabel}: ${description}`;
    }
  }

  if (rankPrefix) {
    if (!clusterLabel) {
      clusterLabel = rankPrefix;
    } else if (!new RegExp(`^${rankPrefix}\\b`, 'i').test(clusterLabel)) {
      clusterLabel = `${rankPrefix}: ${clusterLabel}`;
    }
  }
  if (!clusterLabel) {
    return null;
  }

  const frames = readSemanticNumber(obj, 'cluster_frames');
  const percentage = readSemanticNumber(obj, 'cluster_percentage');
  const metrics: string[] = [];
  if (typeof frames === 'number' && frames > 0) {
    metrics.push(`${Math.round(frames)}帧`);
  }
  if (typeof percentage === 'number') {
    metrics.push(`${percentage.toFixed(1)}%`);
  }

  const frameRefs = parseClusterFrameRefs(obj);
  const frameRefText = frameRefs.length > 0 ? `；帧: ${frameRefs.join(' / ')}` : '';

  return `- ${clusterLabel}${metrics.length > 0 ? `（${metrics.join(', ')}）` : ''}${frameRefText}`;
}

function stripBulletPrefix(text: string): string {
  return String(text || '').replace(/^\s*-\s*/, '').trim();
}

/**
 * Convert JSON response to Markdown when LLM ignores format instructions.
 * This is a fallback to ensure human-readable output.
 */
function convertJsonToMarkdown(jsonStr: string): string {
  // 1. Remove code block markers if present
  let cleaned = jsonStr
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // 2. Try to parse as JSON
  try {
    const parsed = JSON.parse(cleaned);
    const lines: string[] = [];

    // Extract root cause analysis
    if (parsed.rootCauseAnalysis && Array.isArray(parsed.rootCauseAnalysis)) {
      lines.push('## 根因分析\n');
      for (const item of parsed.rootCauseAnalysis) {
        const conclusion = item.conclusion || item.title || '结论';
        const confidence = item.confidence ? ` (置信度: ${item.confidence})` : '';
        lines.push(`### ${conclusion}${confidence}\n`);

        if (item.evidence && Array.isArray(item.evidence)) {
          lines.push('**证据:**');
          for (const e of item.evidence) {
            lines.push(`- ${typeof e === 'object' ? JSON.stringify(e) : e}`);
          }
          lines.push('');
        }
      }
    }

    // Extract conclusion field if present
    if (parsed.conclusion && typeof parsed.conclusion === 'string') {
      if (lines.length === 0) {
        lines.push('## 分析结论\n');
      }
      lines.push(parsed.conclusion);
      lines.push('');
    }

    // Extract summary if present
    if (parsed.summary && typeof parsed.summary === 'string') {
      lines.push('## 总结\n');
      lines.push(parsed.summary);
      lines.push('');
    }

    // Extract findings array if present
    if (parsed.findings && Array.isArray(parsed.findings)) {
      lines.push('## 发现\n');
      for (const f of parsed.findings) {
        const title = f.title || f.name || '发现';
        const severity = f.severity ? `[${f.severity}] ` : '';
        lines.push(`- ${severity}${title}`);
        if (f.description) {
          lines.push(`  ${f.description}`);
        }
      }
      lines.push('');
    }

    // If we extracted anything, return it
    if (lines.length > 0) {
      return lines.join('\n');
    }

    // Otherwise, format the entire object as a simple list
    return formatObjectAsMarkdown(parsed);
  } catch {
    // JSON parse failed, return cleaned string as-is
    return cleaned;
  }
}

/**
 * Format an arbitrary object as Markdown list.
 */
function formatObjectAsMarkdown(obj: Record<string, unknown>, indent = ''): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      lines.push(`${indent}**${key}:**`);
      for (const item of value) {
        if (typeof item === 'object') {
          lines.push(`${indent}- ${JSON.stringify(item).slice(0, 200)}`);
        } else {
          lines.push(`${indent}- ${item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${indent}**${key}:**`);
      lines.push(formatObjectAsMarkdown(value as Record<string, unknown>, indent + '  '));
    } else {
      lines.push(`${indent}- **${key}:** ${value}`);
    }
  }

  return lines.join('\n');
}
