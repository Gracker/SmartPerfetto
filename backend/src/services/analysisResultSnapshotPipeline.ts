// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type {AnalysisReceipt, DataEnvelope, ExpandableRowData} from '../types/dataContract';
import {outsideTargetScopeFields} from '../types/identityContract';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  STANDARD_COMPARISON_METRICS,
  standardMetricDescribesApp,
  type AnalysisResultSceneType,
  type AnalysisResultSnapshot,
  type EvidenceRef,
  type NormalizedMetricDefinition,
  type NormalizedMetricSource,
  type NormalizedMetricValue,
  type StandardComparisonMetricKey,
} from '../types/multiTraceComparison';
import { openEnterpriseDb } from './enterpriseDb';
import {
  COMPARISON_METRIC_PRODUCER_CONTRACTS,
  decideProducerCandidate,
  isWithheldMetric,
  producerContractFor,
  withheldMetricReason,
  type ComparisonMetricProducerContract,
  type ContractedMetricKey,
} from './comparisonMetricProducerContract';
import { createAnalysisResultSnapshotRepository } from './analysisResultSnapshotStore';
import { insertAnalysisRunIfMissing } from './analysisRunStore';
import {
  privateContextRestrictsAudience,
  type AnalysisPrivateContextMarker,
} from './security/analysisPrivateContext';
import {sanitizeStoredCapabilityManifestAttribution} from './capabilityManifest';
import {sanitizeOwnerCodeAwareText} from './security/codeAwareOutputRegistry';
import {sanitizeStoredTraceSummaryAttribution} from './traceSummaryAttribution';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {
  projectOwnerDataEnvelopes,
  projectOwnerTerminationMessage,
  projectPrivateTerminationReason,
  projectOwnerUiActionProposals,
  projectOwnerAnalysisResult,
  copyAnalysisResultForSnapshot,
} from './security/privateAnalysisProjection';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import {
  copyAnalysisDeliveryFields,
  type AnalysisDeliveryFields,
} from './security/analysisDeliveryProjection';
import type {SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {envelopeTraceValue, measuresTrace} from './evidence/envelopeTraceIdentity';
import {rowObject} from '../utils/traceProcessorRowUtils';

export interface CompletedAnalysisSnapshotInput extends AnalysisDeliveryFields {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  traceId: string;
  sessionId: string;
  runId?: string;
  reportId?: string;
  /** Product-issued archive locator, never a copy of the canonical timeline. */
  sceneReport?: AnalysisResult['sceneReport'];
  /** Current finalized timeline revision supplied independently of its archive locator. */
  sceneTimelineRevision?: number;
  query: string;
  traceLabel?: string;
  conclusion?: string;
  conclusionContract?: unknown;
  sourceUseDecision?: SourceUseDecisionV1;
  sourceClaimVerificationResult?: AnalysisResult['sourceClaimVerificationResult'];
  success?: boolean;
  claimSupport?: import('../types/evidenceContract').ClaimSupportV1[];
  claimVerificationResult?: import('../types/claimVerification').ClaimVerificationResult;
  identityResolutions?: import('../types/identityContract').IdentityResolutionV1[];
  confidence?: number;
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
  dataEnvelopes?: DataEnvelope[];
  analysisReceipt?: import('../types/dataContract').AnalysisReceipt;
  capabilityManifest?: import('../types/capabilityManifest').CapabilityManifestAttributionV1;
  traceSummary?: import('../types/traceSummaryAttribution').TraceSummaryAttributionV1;
  uiActionProposals?: import('../types/dataContract').UiActionProposalV1[];
  createdAt?: number;
  /**
   * The run's authorized private material. It is stored with the snapshot and
   * decides both its audience and the non-resumable persistence projection.
   */
  privateContext: AnalysisPrivateContextMarker;
  /** Language pinned to the originating analysis session. */
  outputLanguage?: OutputLanguage;
  /** Canonical scene derived before any private query/evidence projection. */
  sceneType?: AnalysisResultSceneType;
}

export function resolveAnalysisResultSceneType(
  query: string,
  envelopes: DataEnvelope[] = [],
): AnalysisResultSceneType {
  const text = [
    query,
    ...envelopes.flatMap(env => [
      env.meta?.skillId,
      env.meta?.source,
      env.meta?.stepId,
      env.display?.title,
    ]),
  ].filter(Boolean).join(' ').toLowerCase();

  if (/(startup|launch|cold start|warm start|启动|冷启动|热启动)/i.test(text)) return 'startup';
  if (/(scroll|scrolling|fps|jank|frame|帧率|滑动|卡顿|掉帧)/i.test(text)) return 'scrolling';
  if (/(interaction|tap|click|input|响应|交互)/i.test(text)) return 'interaction';
  if (/(memory|rss|oom|内存)/i.test(text)) return 'memory';
  if (/(cpu|thread|core|freq|调度|线程)/i.test(text)) return 'cpu';
  return 'general';
}

function firstNonEmptyLine(text: string | undefined): string | undefined {
  return text
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
}

function stableEnvelopeContentHash(env: DataEnvelope): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      source: env.meta?.source,
      skillId: env.meta?.skillId,
      stepId: env.meta?.stepId,
      title: env.display?.title,
      data: env.data,
    }, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
    .digest('hex')
    .slice(0, 12);
}

function dataEnvelopeRefId(env: DataEnvelope, duplicateEvidenceRefIds: Set<string> = new Set()): string {
  if (env.meta?.evidenceRefId) {
    if (duplicateEvidenceRefIds.has(env.meta.evidenceRefId) && env.meta.sourceToolCallId) {
      return `${env.meta.evidenceRefId}:tool:${env.meta.sourceToolCallId}`;
    }
    return env.meta.evidenceRefId;
  }
  const source = env.meta?.source || env.meta?.skillId || 'data_envelope';
  const stepId = env.meta?.stepId || 'step';
  const timestamp = env.meta?.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
    return `data:${source}:${stepId}:${timestamp}`;
  }
  return `data:${source}:${stepId}:${stableEnvelopeContentHash(env)}`;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readAliasedValue(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (record[alias] !== undefined) return record[alias];
  }
  return undefined;
}

function readAliasedRecordArray(record: Record<string, unknown>, aliases: string[]): Record<string, unknown>[] {
  const value = readAliasedValue(record, aliases);
  return Array.isArray(value)
    ? value.map(toPlainRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function readAliasedString(record: Record<string, unknown>, aliases: string[]): string | undefined {
  const value = readAliasedValue(record, aliases);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeClaimSourceRef(value: string): string {
  const text = String(value || '').trim();
  const chinese = text.match(/^(?:数据)?(表|摘要|指标|图|图表|文本|时间线)\s*([0-9]+)$/);
  if (chinese) {
    const prefixMap: Record<string, string> = {
      表: 'table',
      摘要: 'summary',
      指标: 'metric',
      图: 'chart',
      图表: 'chart',
      文本: 'text',
      时间线: 'timeline',
    };
    return `${prefixMap[chinese[1]]}:${Number(chinese[2])}`;
  }
  const english = text.match(/^(?:data\s*)?(table|summary|metric|chart|figure|text|timeline)\s*([0-9]+)$/i);
  if (english) {
    const kind = english[1].toLowerCase() === 'figure' ? 'chart' : english[1].toLowerCase();
    return `${kind}:${Number(english[2])}`;
  }
  return text.toLowerCase();
}

function dataEnvelopeSourceRefKind(env: DataEnvelope): string {
  const format = env.display?.format;
  if (format === 'summary') return 'summary';
  if (format === 'metric') return 'metric';
  if (format === 'chart') return 'chart';
  if (format === 'text') return 'text';
  if (format === 'timeline') return 'timeline';
  return 'table';
}

function collectClaimReferencePins(contract: unknown): {
  evidenceRefIds: Set<string>;
  sourceToolCallIds: Set<string>;
  sourceRefs: Set<string>;
} {
  const evidenceRefIds = new Set<string>();
  const sourceToolCallIds = new Set<string>();
  const sourceRefs = new Set<string>();
  const root = toPlainRecord(contract);
  if (!root) return { evidenceRefIds, sourceToolCallIds, sourceRefs };

  const claims = readAliasedRecordArray(root, ['claims', 'claim_refs', 'claimRefs', 'claimReferences', '逐句数据引用']);
  for (const claim of claims) {
    const references = readAliasedRecordArray(claim, ['references', 'refs', 'evidenceRefs', 'evidence_refs']);
    for (const ref of references) {
      const evidenceRefId = readAliasedString(ref, ['evidenceRefId', 'evidence_ref_id', 'evidenceId', 'evidence_id']);
      const sourceToolCallId = readAliasedString(ref, [
        'sourceToolCallId', 'source_tool_call_id', 'toolCallId', 'tool_call_id',
      ]);
      const sourceRef = readAliasedString(ref, ['sourceRef', 'source_ref']);
      if (evidenceRefId) evidenceRefIds.add(evidenceRefId);
      if (sourceToolCallId) sourceToolCallIds.add(sourceToolCallId);
      if (sourceRef) sourceRefs.add(normalizeClaimSourceRef(sourceRef));
    }
  }

  return { evidenceRefIds, sourceToolCallIds, sourceRefs };
}

function evidenceRefsFromInput(input: CompletedAnalysisSnapshotInput): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  if (input.reportId) {
    refs.push({
      id: `report:${input.reportId}`,
      type: 'report',
      reportId: input.reportId,
      runId: input.runId,
      label: 'Agent HTML report',
      url: `/api/reports/${input.reportId}`,
    });
  }

  const seen = new Set<string>();
  const claimPins = collectClaimReferencePins(input.conclusionContract);
  const dataEnvelopes = input.dataEnvelopes || [];
  const sourceRefOrdinals: Record<string, number> = {};
  const evidenceRefCounts = new Map<string, number>();
  for (const env of dataEnvelopes) {
    if (!env.meta?.evidenceRefId) continue;
    evidenceRefCounts.set(env.meta.evidenceRefId, (evidenceRefCounts.get(env.meta.evidenceRefId) || 0) + 1);
  }
  const duplicateEvidenceRefIds = new Set(
    [...evidenceRefCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
  );
  for (let index = 0; index < dataEnvelopes.length; index++) {
    const env = dataEnvelopes[index];
    const sourceRefKind = dataEnvelopeSourceRefKind(env);
    sourceRefOrdinals[sourceRefKind] = (sourceRefOrdinals[sourceRefKind] || 0) + 1;
    const sourceRefKey = `${sourceRefKind}:${sourceRefOrdinals[sourceRefKind]}`;
    const source = env.meta?.source || env.meta?.skillId || 'data_envelope';
    const id = dataEnvelopeRefId(env, duplicateEvidenceRefIds);
    const isPinnedClaimRef =
      claimPins.evidenceRefIds.has(id) ||
      (env.meta?.evidenceRefId ? claimPins.evidenceRefIds.has(env.meta.evidenceRefId) : false) ||
      (env.meta?.sourceToolCallId ? claimPins.sourceToolCallIds.has(env.meta.sourceToolCallId) : false) ||
      claimPins.sourceRefs.has(sourceRefKey);
    if (index >= 100 && !isPinnedClaimRef) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      type: 'data_envelope',
      dataEnvelopeId: id,
      runId: input.runId,
      label: env.display?.title || source,
      metadata: {
        source,
        skillId: env.meta?.skillId,
        stepId: env.meta?.stepId,
        evidenceRefId: env.meta?.evidenceRefId,
        traceSide: envelopeTraceValue(env, 'traceSide'),
        paneSide: envelopeTraceValue(env, 'paneSide'),
        traceId: envelopeTraceValue(env, 'traceId'),
        queryHash: env.meta?.queryHash,
        sourceToolCallId: env.meta?.sourceToolCallId,
        paramsHash: env.meta?.paramsHash,
        planPhaseId: env.meta?.planPhaseId,
        planPhaseTitle: env.meta?.planPhaseTitle,
        planPhaseGoal: env.meta?.planPhaseGoal,
        toolNarration: env.meta?.toolNarration,
        producerReason: env.meta?.producerReason,
        displayLayer: env.display?.layer,
        displayFormat: env.display?.format,
      },
    });
  }
  return refs;
}

function payloadRows(env: DataEnvelope): Array<Record<string, unknown>> {
  return dataRows(env.data);
}

/** Rows of a table payload: row objects, or positional rows under `columns`. */
function dataRows(payload: unknown): Array<Record<string, unknown>> {
  const data = payload as any;
  if (!data || typeof data !== 'object') return [];

  if (Array.isArray(data.rows)) {
    if (data.rows.length === 0) return [];
    if (data.rows.every((row: unknown) => row && typeof row === 'object' && !Array.isArray(row))) {
      return data.rows as Array<Record<string, unknown>>;
    }
    const columns: string[] = Array.isArray(data.columns)
      ? data.columns.filter((col: unknown): col is string => typeof col === 'string')
      : [];
    if (columns.length > 0) {
      return data.rows
        .filter((row: unknown): row is unknown[] => Array.isArray(row))
        .map((row: unknown[]) => rowObject(columns, row));
    }
  }

  if (data.summary && typeof data.summary === 'object') {
    const metrics = (data.summary as any).metrics;
    if (Array.isArray(metrics)) {
      return metrics
        .filter((metric: unknown): metric is Record<string, unknown> => !!metric && typeof metric === 'object')
        .map(metric => ({
          label: metric.label,
          value: metric.value,
          unit: metric.unit,
        }));
    }
  }

  return [data as Record<string, unknown>];
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The first candidate field with a numeric value, plus the definition its
 * producer declared for it in a `<field>_definition` string on the same row.
 * Only a producer row declares; a column name alone never implies one.
 */
function getRowMetric(
  byNormalizedName: ReadonlyMap<string, unknown>,
  candidates: string[],
): {value: number; definition?: string} | null {
  for (const candidate of candidates) {
    const field = normalizeFieldName(candidate);
    const value = toNumber(byNormalizedName.get(field));
    if (value === null) continue;
    const definition = byNormalizedName.get(`${field}definition`);
    return typeof definition === 'string' && definition.trim()
      ? {value, definition: definition.trim()}
      : {value};
  }
  return null;
}

/** Column names per metric. A metric with a producer contract is read only through that contract. */
type UncontractedMetricKey = Exclude<StandardComparisonMetricKey, ContractedMetricKey>;
const METRIC_FIELD_CANDIDATES: Record<UncontractedMetricKey, string[]> = {
  'startup.total_ms': ['startup.total_ms', 'startup_total_ms', 'total_ms', 'total_duration_ms', 'duration_ms', 'dur_ms', 'startup_ms'],
  'startup.first_frame_ms': ['startup.first_frame_ms', 'first_frame_ms', 'time_to_first_frame_ms', 'first_frame_duration_ms'],
  'startup.bind_application_ms': ['startup.bind_application_ms', 'bind_application_ms', 'bind_app_ms', 'bindApplicationMs'],
  'startup.activity_start_ms': ['startup.activity_start_ms', 'activity_start_ms', 'activityStartMs', 'activity_launch_ms'],
  'startup.main_thread_blocked_ms': ['startup.main_thread_blocked_ms', 'main_thread_blocked_ms', 'blocked_ms', 'mainThreadBlockedMs'],
  'scrolling.avg_fps': ['scrolling.avg_fps', 'avg_fps', 'average_fps', 'fps'],
  'scrolling.frame_count': ['scrolling.frame_count', 'frame_count', 'frames', 'total_frames'],
  'scrolling.jank_count': ['scrolling.jank_count', 'jank_count', 'janky_count', 'jank_frames', 'janky_frames'],
  'scrolling.jank_rate_pct': ['scrolling.jank_rate_pct', 'jank_rate_pct', 'jank_pct', 'jank_rate', 'janky_rate'],
  'scrolling.p50_frame_ms': ['scrolling.p50_frame_ms', 'p50_frame_ms', 'frame_p50_ms', 'p50_ms'],
  'scrolling.p95_frame_ms': ['scrolling.p95_frame_ms', 'p95_frame_ms', 'frame_p95_ms', 'p95_ms'],
  'scrolling.p99_frame_ms': ['scrolling.p99_frame_ms', 'p99_frame_ms', 'frame_p99_ms', 'p99_ms'],
  'cpu.main_thread_running_ms': ['cpu.main_thread_running_ms', 'main_thread_running_ms', 'running_ms'],
  'cpu.main_thread_runnable_ms': ['cpu.main_thread_runnable_ms', 'main_thread_runnable_ms', 'runnable_ms'],
  'cpu.avg_freq_mhz': ['cpu.avg_freq_mhz', 'avg_freq_mhz', 'average_freq_mhz'],
  'trace.duration_ms': ['trace.duration_ms', 'trace_duration_ms', 'duration_ms'],
  'trace.device_model': ['trace.device_model', 'device_model'],
  'trace.android_version': ['trace.android_version', 'android_version'],
  'trace.capture_config_summary': ['trace.capture_config_summary', 'capture_config_summary'],
};

function metricSourceFromEnvelope(env: DataEnvelope): NormalizedMetricSource {
  const type = env.meta?.type === 'sql_result' ? 'sql' : 'skill';
  return {
    type,
    ...(env.meta?.skillId ? { skillId: env.meta.skillId } : {}),
    ...(env.meta?.stepId ? { stepId: env.meta.stepId } : {}),
    dataEnvelopeId: dataEnvelopeRefId(env),
  };
}

/**
 * Rows of one iterator item's section. The executor stores a section's rows as
 * row objects, although the declared SectionData type is a table payload.
 */
function sectionRows(item: ExpandableRowData, sectionId: string): Array<Record<string, unknown>> {
  const data: unknown = item?.result?.sections?.[sectionId]?.data;
  return Array.isArray(data)
    ? data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    : dataRows(data);
}

interface ProducerUnit {
  rows: Array<Record<string, unknown>>;
  section?: string;
  itemIndex?: number;
}

/** The first admitted producer unit in one envelope that returned rows. */
function firstProducerUnit(contract: ComparisonMetricProducerContract, env: DataEnvelope): ProducerUnit | undefined {
  // Only Skill execution writes skill_result envelopes.
  if (env.meta?.type !== 'skill_result') return undefined;
  const {skillId, stepId} = env.meta;
  for (const producer of contract.producers) {
    if (producer.skillId !== skillId || producer.stepId !== stepId) continue;
    if (!producer.section) {
      const rows = payloadRows(env);
      if (rows.length > 0) return {rows};
      continue;
    }
    const items = env.data?.expandableData ?? [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const rows = sectionRows(items[itemIndex], producer.section);
      if (rows.length > 0) return {rows, section: producer.section, itemIndex};
    }
  }
  return undefined;
}

function standardMetric(
  definition: NormalizedMetricDefinition,
  value: NormalizedMetricValue['value'],
  source: NormalizedMetricSource,
  missingReason?: string,
): NormalizedMetricValue {
  return {
    key: definition.key,
    label: definition.label,
    group: definition.group,
    value,
    unit: definition.unit,
    direction: definition.direction,
    aggregation: definition.aggregation,
    confidence: missingReason ? 0 : 0.75,
    ...(missingReason ? {missingReason} : {}),
    source,
  };
}

/**
 * A contracted metric comes from the first admitted producer unit that
 * returned rows, and from nothing else: when its contract refuses that unit,
 * the metric is stored withheld with the reason, not read from a later row,
 * envelope or iterator item that may describe another thread or window.
 */
function extractContractedMetric(
  contract: ComparisonMetricProducerContract,
  envelopes: DataEnvelope[],
): NormalizedMetricValue | undefined {
  const definition = STANDARD_COMPARISON_METRICS.find(metric => metric.key === contract.metricKey)!;
  for (const env of envelopes) {
    const unit = firstProducerUnit(contract, env);
    if (!unit) continue;
    const decision = decideProducerCandidate(contract, unit.rows);
    const source: NormalizedMetricSource = {
      ...metricSourceFromEnvelope(env),
      ...(unit.section ? {section: unit.section, itemIndex: unit.itemIndex} : {}),
    };
    return decision.admitted
      ? standardMetric(definition, decision.value, {...source, metricDefinition: contract.definition})
      : standardMetric(definition, null, source, withheldMetricReason(decision.reason));
  }
  return undefined;
}

function extractStandardMetrics(traceId: string, envelopes: DataEnvelope[] = []): NormalizedMetricValue[] {
  const ownTraceEnvelopes = envelopes.filter(env => measuresTrace(env, traceId));
  const byKey = new Map<string, NormalizedMetricValue>();
  for (const env of ownTraceEnvelopes) {
    // App metrics never read a field the result declares trace-wide or peer.
    const outsideTarget = outsideTargetScopeFields(env.meta?.scopeProvenance);
    for (const row of payloadRows(env)) {
      const entries = Object.entries(row);
      const byNormalizedName = new Map(entries.map(([key, value]) => [normalizeFieldName(key), value]));
      const targetByNormalizedName = new Map(entries.filter(([key]) => !outsideTarget(key))
        .map(([key, value]) => [normalizeFieldName(key), value]));
      for (const definition of STANDARD_COMPARISON_METRICS) {
        if (producerContractFor(definition.key) || byKey.has(definition.key)) continue;
        const metric = getRowMetric(standardMetricDescribesApp(definition) ? targetByNormalizedName : byNormalizedName,
          METRIC_FIELD_CANDIDATES[definition.key as UncontractedMetricKey]);
        if (metric === null) continue;
        const {value} = metric;
        const normalizedValue = definition.key === 'scrolling.jank_rate_pct' && value > 0 && value <= 1
          ? value * 100
          : value;
        byKey.set(definition.key, standardMetric(definition, normalizedValue, {
          ...metricSourceFromEnvelope(env),
          ...(metric.definition ? {metricDefinition: metric.definition} : {}),
        }));
      }
    }
  }
  for (const contract of COMPARISON_METRIC_PRODUCER_CONTRACTS) {
    const metric = extractContractedMetric(contract, ownTraceEnvelopes);
    if (metric) byKey.set(contract.metricKey, metric);
  }
  return [...byKey.values()];
}

/** Historical identity validation only; a persisted JSON reference grants no live proof or archive access. */
function validatedSceneReportReference(input: CompletedAnalysisSnapshotInput): AnalysisResult['sceneReport'] {
  const ref = input.sceneReport;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
    Object.keys(ref).some(key => !['schemaVersion', 'reportId', 'traceId', 'sessionId', 'runId',
      'revision', 'expiresAt', 'manifestSha256'].includes(key)) ||
    ref.schemaVersion !== 'scene_report_ref@1' || typeof ref.reportId !== 'string' ||
    !/^scene-v3-[A-Za-z0-9_-]+$/.test(ref.reportId) ||
    ref.traceId !== input.traceId || ref.sessionId !== input.sessionId || ref.runId !== input.runId ||
    !Number.isSafeInteger(ref.revision) || ref.revision < 0 || ref.revision !== input.sceneTimelineRevision ||
    !Number.isSafeInteger(ref.expiresAt) || ref.expiresAt <= 0 ||
    typeof ref.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.manifestSha256)) return undefined;
  return {schemaVersion: ref.schemaVersion, reportId: ref.reportId, traceId: ref.traceId,
    sessionId: ref.sessionId, runId: ref.runId, revision: ref.revision,
    expiresAt: ref.expiresAt, manifestSha256: ref.manifestSha256};
}

export function buildCompletedAnalysisResultSnapshot(
  input: CompletedAnalysisSnapshotInput,
): AnalysisResultSnapshot | null {
  if (!input.tenantId || !input.workspaceId || !input.runId) {
    return null;
  }

  const createdAt = input.createdAt ?? Date.now();
  const sceneType = input.sceneType ?? resolveAnalysisResultSceneType(input.query, input.dataEnvelopes);
  const headline = firstNonEmptyLine(input.conclusion)
    || input.terminationMessage
    || 'Analysis completed';
  const metrics = extractStandardMetrics(input.traceId, input.dataEnvelopes);
  const hasComparableMetric = metrics.some(metric => !isWithheldMetric(metric));
  const partialReasons: string[] = [];
  if (input.partial) {
    partialReasons.push(input.terminationReason || input.terminationMessage || 'Analysis marked partial by runtime');
  }
  if (!hasComparableMetric) {
    partialReasons.push('No normalized comparison metrics extracted yet');
  }
  const storedAnalysisReceipt = input.analysisReceipt;
  const storedReceiptCapabilityManifest =
    sanitizeStoredCapabilityManifestAttribution(
      storedAnalysisReceipt?.capabilityManifest,
    );
  let analysisReceipt: AnalysisReceipt | undefined;
  if (storedAnalysisReceipt) {
    const {
      capabilityManifest: _storedCapabilityManifest,
      traceSummary: _storedTraceSummary,
      ...receiptWithoutAttribution
    } = storedAnalysisReceipt;
    const receiptTraceSummary = sanitizeStoredTraceSummaryAttribution(
      storedAnalysisReceipt.traceSummary,
    );
    analysisReceipt = {
      ...receiptWithoutAttribution,
      ...(storedReceiptCapabilityManifest
        ? {capabilityManifest: storedReceiptCapabilityManifest}
        : {}),
      ...(receiptTraceSummary ? {traceSummary: receiptTraceSummary} : {}),
    } as AnalysisReceipt;
  }
  const capabilityManifest = sanitizeStoredCapabilityManifestAttribution(
    input.capabilityManifest !== undefined
      ? input.capabilityManifest
      : storedAnalysisReceipt?.capabilityManifest,
  );
  const traceSummary = sanitizeStoredTraceSummaryAttribution(
    input.traceSummary !== undefined
      ? input.traceSummary
      : storedAnalysisReceipt?.traceSummary,
  );
  // Reuse the session serializer: finalized contracts stay exact; a changed
  // legacy source projection cannot keep positive bindings for its old inputs.
  const storedResult = copyAnalysisResultForSnapshot({
    sessionId: input.sessionId, success: input.success ?? true, findings: [], hypotheses: [],
    conclusion: input.conclusion ?? '', confidence: input.confidence ?? 0, rounds: 0, totalDurationMs: 0,
    turnIntent: input.turnIntent, completion: input.completion, outputOrigin: input.outputOrigin,
    runtimeAppendix: input.runtimeAppendix, reportAssessment: input.reportAssessment, investigationAssessment: input.investigationAssessment, deliveryAssurance: input.deliveryAssurance,
    conclusionContract: input.conclusionContract as AnalysisResult['conclusionContract'],
    claimSupport: input.claimSupport, claimVerificationResult: input.claimVerificationResult,
    sourceUseDecision: input.sourceUseDecision, sourceClaimVerificationResult: input.sourceClaimVerificationResult,
    identityResolutions: input.identityResolutions, analysisReceipt,
    sceneReport: validatedSceneReportReference(input),
  });
  const conclusionContract = storedResult.conclusionContract;

  return {
    id: `analysis-result-${crypto.randomUUID()}`,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.reportId ? { reportId: input.reportId } : {}),
    ...(input.userId ? { createdBy: input.userId } : {}),
    visibility: 'private',
    privateContext: input.privateContext,
    sceneType,
    title: `${sceneType} analysis - ${input.traceLabel || input.traceId}`,
    userQuery: input.query,
    traceLabel: input.traceLabel || input.traceId,
    traceMetadata: {},
    summary: {
      headline,
      ...(storedResult.sceneReport ? {sceneReport: storedResult.sceneReport} : {}),
      ...(input.conclusion !== undefined ? {conclusion: input.conclusion} : {}),
      ...copyAnalysisDeliveryFields(storedResult),
      ...(storedResult.sourceUseDecision ? {sourceUseDecision: storedResult.sourceUseDecision} : {}),
      ...(storedResult.sourceClaimVerificationResult ? {sourceClaimVerificationResult: storedResult.sourceClaimVerificationResult} : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(partialReasons.length > 0 ? { partialReasons } : {}),
      ...(storedResult.analysisReceipt ? {analysisReceipt: storedResult.analysisReceipt} : {}),
      ...(traceSummary ? {traceSummary} : {}),
      ...(input.uiActionProposals && input.uiActionProposals.length > 0 ? { uiActionProposals: input.uiActionProposals } : {}),
    },
    ...(conclusionContract ? { conclusionContract } : {}),
    ...(storedResult.claimSupport ? {claimSupport: storedResult.claimSupport} : {}),
    ...(storedResult.claimVerificationResult ? {claimVerificationResult: storedResult.claimVerificationResult} : {}),
    ...(input.identityResolutions ? { identityResolutions: input.identityResolutions } : {}),
    ...(capabilityManifest ? {capabilityManifest} : {}),
    metrics,
    evidenceRefs: evidenceRefsFromInput(input),
    status: input.success === false ? 'failed' : input.partial || !hasComparableMetric ? 'partial' : 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt,
  };
}

function ensureSnapshotParentGraph(
  db: Database.Database,
  input: CompletedAnalysisSnapshotInput,
  now: number,
): void {
  if (!input.tenantId || !input.workspaceId || !input.runId) return;

  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(input.tenantId, input.tenantId, now, now);

  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.workspaceId, input.tenantId, input.workspaceId, now, now);

  if (input.userId) {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.userId,
      input.tenantId,
      `${input.userId}@analysis-result.local`,
      input.userId,
      `analysis-result:${input.userId}`,
      now,
      now,
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO trace_assets
      (id, tenant_id, workspace_id, owner_user_id, local_path, size_bytes, status, metadata_json, created_at)
    VALUES
      (?, ?, ?, ?, ?, 0, 'metadata_only', ?, ?)
  `).run(
    input.traceId,
    input.tenantId,
    input.workspaceId,
    input.userId ?? null,
    `metadata-only:${input.traceId}`,
    JSON.stringify({ source: 'analysis_result_snapshot', sessionId: input.sessionId, runId: input.runId }),
    now,
  );

  db.prepare(`
    INSERT OR IGNORE INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, title, visibility, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, 'private', 'completed', ?, ?)
  `).run(
    input.sessionId,
    input.tenantId,
    input.workspaceId,
    input.traceId,
    input.userId ?? null,
    `Agent session ${input.sessionId}`,
    now,
    now,
  );

  insertAnalysisRunIfMissing(db, {
    id: input.runId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    mode: 'agent',
    status: 'completed',
    question: input.query,
    startedAt: now,
    completedAt: now,
    heartbeatAt: now,
    updatedAt: now,
    privateContext: input.privateContext,
  });
}

export function persistCompletedAnalysisResultSnapshot(
  input: CompletedAnalysisSnapshotInput,
): AnalysisResultSnapshot | null {
  const outputLanguage = input.outputLanguage
    ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const privateKnowledge = privateContextRestrictsAudience(input.privateContext);
  const privateResult = privateKnowledge ? projectOwnerAnalysisResult(input.sessionId, {
    sessionId: input.sessionId, success: input.success ?? true,
    findings: [], hypotheses: [], conclusion: input.conclusion ?? '',
    confidence: input.confidence ?? 0, rounds: 0, totalDurationMs: 0,
    partial: input.partial, terminationReason: projectPrivateTerminationReason(input.terminationReason), terminationMessage: input.terminationMessage,
    turnIntent: input.turnIntent, completion: input.completion, outputOrigin: input.outputOrigin,
    runtimeAppendix: input.runtimeAppendix, reportAssessment: input.reportAssessment, investigationAssessment: input.investigationAssessment, deliveryAssurance: input.deliveryAssurance,
    conclusionContract: input.conclusionContract as AnalysisResult['conclusionContract'],
    claimSupport: input.claimSupport, claimVerificationResult: input.claimVerificationResult,
    sourceUseDecision: input.sourceUseDecision, sourceClaimVerificationResult: input.sourceClaimVerificationResult,
    identityResolutions: input.identityResolutions,
    analysisReceipt: input.analysisReceipt,
    sceneReport: validatedSceneReportReference(input),
  }, outputLanguage) : undefined;
  const {turnIntent: _intent, completion: _completion, outputOrigin: _origin, runtimeAppendix: _appendix,
    reportAssessment: _assessment, investigationAssessment: _investigation, deliveryAssurance: _assurance, ...inputWithoutDelivery} = input;
  const durableInput: CompletedAnalysisSnapshotInput = privateKnowledge
    ? {
        // The creator's snapshot keeps their question and trace label; the run store keeps none.
        ...inputWithoutDelivery,
        query: sanitizeOwnerCodeAwareText(input.sessionId, input.query),
        ...(input.traceLabel ? {traceLabel: sanitizeOwnerCodeAwareText(input.sessionId, input.traceLabel)} : {}),
        ...copyAnalysisDeliveryFields(privateResult ?? {}),
        conclusion: privateResult?.conclusion,
        conclusionContract: privateResult?.conclusionContract,
        sourceUseDecision: privateResult?.sourceUseDecision,
        sourceClaimVerificationResult: privateResult?.sourceClaimVerificationResult,
        claimSupport: privateResult?.claimSupport,
        claimVerificationResult: privateResult?.claimVerificationResult,
        identityResolutions: privateResult?.identityResolutions,
        terminationReason: projectPrivateTerminationReason(input.terminationReason),
        terminationMessage: projectOwnerTerminationMessage(input.terminationMessage, outputLanguage, privateResult ?? input),
        analysisReceipt: privateResult?.analysisReceipt,
        sceneReport: privateResult?.sceneReport,
        uiActionProposals: projectOwnerUiActionProposals(
          input.sessionId,
          input.uiActionProposals,
        ),
        dataEnvelopes: projectOwnerDataEnvelopes(input.sessionId, input.dataEnvelopes || []),
      }
    : input;
  const snapshot = buildCompletedAnalysisResultSnapshot(durableInput);
  if (!snapshot) return null;

  const db = openEnterpriseDb();
  try {
    ensureSnapshotParentGraph(db, durableInput, snapshot.createdAt);
    return createAnalysisResultSnapshotRepository(db).createSnapshot(snapshot);
  } finally {
    db.close();
  }
}
