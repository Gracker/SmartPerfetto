// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type {AnalysisReceipt, DataEnvelope} from '../types/dataContract';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  STANDARD_COMPARISON_METRICS,
  type AnalysisResultSceneType,
  type AnalysisResultSnapshot,
  type EvidenceRef,
  type NormalizedMetricSource,
  type NormalizedMetricValue,
  type StandardComparisonMetricKey,
} from '../types/multiTraceComparison';
import { openEnterpriseDb } from './enterpriseDb';
import { createAnalysisResultSnapshotRepository } from './analysisResultSnapshotStore';
import {sanitizeStoredCapabilityManifestAttribution} from './capabilityManifest';
import {sanitizeStoredTraceSummaryAttribution} from './traceSummaryAttribution';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {
  privateAnalysisQueryMessage,
  projectPrivateAnalysisReceipt,
  projectPrivateClaimSupport,
  projectPrivateClaimVerification,
  projectPrivateConclusion,
  projectPrivateDataEnvelopes,
  projectPrivateIdentityResolutions,
  projectPrivateStructuredValue,
  projectPrivateTerminationMessage,
  projectPrivateTerminationReason,
  projectPrivateUiActionProposals,
} from './security/privateAnalysisProjection';
import type {ConclusionContract} from '../agent/core/conclusionContract';
import type {SourceUseDecisionV1} from './codebase/sourceUseDecision';
import {
  sanitizeConclusionSourceContract,
  verifySourceClaimBindings,
} from './codebase/sourceClaimVerifier';
import {
  collectMatchedTraceEvidenceRefIdsByClaimId,
  collectVerifiedTraceOccurrenceRefIdsByClaimId,
} from './verifier/claimVerificationRunner';

export interface CompletedAnalysisSnapshotInput {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  traceId: string;
  sessionId: string;
  runId?: string;
  reportId?: string;
  query: string;
  traceLabel?: string;
  conclusion?: string;
  conclusionContract?: unknown;
  sourceUseDecision?: SourceUseDecisionV1;
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
  /** Apply the non-resumable private-source persistence projection. */
  privateKnowledge?: boolean;
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

function envelopeTraceValue(
  env: DataEnvelope,
  key: 'traceSide' | 'traceId' | 'paneSide',
): string | undefined {
  const envelopeAny = env as any;
  const metaValue = env.meta?.[key];
  if (typeof metaValue === 'string' && metaValue.length > 0) return metaValue;
  const topLevelValue = envelopeAny?.[key];
  if (typeof topLevelValue === 'string' && topLevelValue.length > 0) return topLevelValue;
  const provenanceValue = envelopeAny?.traceProvenance?.[key];
  return typeof provenanceValue === 'string' && provenanceValue.length > 0
    ? provenanceValue
    : undefined;
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
    const stepId = env.meta?.stepId || 'step';
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
  const data = env.data as any;
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
        .map((row: unknown[]) => {
          const out: Record<string, unknown> = {};
          columns.forEach((column, index) => {
            out[column] = row[index];
          });
          return out;
        });
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

function getRowNumber(row: Record<string, unknown>, candidates: string[]): number | null {
  const byNormalizedName = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    byNormalizedName.set(normalizeFieldName(key), value);
  }
  for (const candidate of candidates) {
    const value = byNormalizedName.get(normalizeFieldName(candidate));
    const parsed = toNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

const METRIC_FIELD_CANDIDATES: Record<StandardComparisonMetricKey, string[]> = {
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
  'cpu.big_core_pct': ['cpu.big_core_pct', 'big_core_pct', 'big_core_percent'],
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

function extractStandardMetrics(envelopes: DataEnvelope[] = []): NormalizedMetricValue[] {
  const byKey = new Map<string, NormalizedMetricValue>();
  for (const env of envelopes) {
    for (const row of payloadRows(env)) {
      for (const definition of STANDARD_COMPARISON_METRICS) {
        const value = getRowNumber(row, METRIC_FIELD_CANDIDATES[definition.key]);
        if (value === null) continue;
        const normalizedValue = definition.key === 'scrolling.jank_rate_pct' && value > 0 && value <= 1
          ? value * 100
          : value;
        if (byKey.has(definition.key)) continue;
        byKey.set(definition.key, {
          key: definition.key,
          label: definition.label,
          group: definition.group,
          value: normalizedValue,
          unit: definition.unit,
          direction: definition.direction,
          aggregation: definition.aggregation,
          confidence: 0.75,
          source: metricSourceFromEnvelope(env),
        });
      }
    }
  }
  return [...byKey.values()];
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
  const metrics = extractStandardMetrics(input.dataEnvelopes);
  const partialReasons: string[] = [];
  if (input.partial) {
    partialReasons.push(input.terminationReason || input.terminationMessage || 'Analysis marked partial by runtime');
  }
  if (metrics.length === 0) {
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
  let conclusionContract = input.conclusionContract;
  if (
    conclusionContract &&
    typeof conclusionContract === 'object' &&
    !Array.isArray(conclusionContract) &&
    (conclusionContract as Record<string, unknown>).schemaVersion === 'conclusion_contract_v1'
  ) {
    const sanitized = sanitizeConclusionSourceContract(conclusionContract as ConclusionContract, {
      actualSourceUseDecision: input.sourceUseDecision ?? null,
    });
    const verification = verifySourceClaimBindings({
      conclusionContract: sanitized,
      actualSourceUseDecision: input.sourceUseDecision,
      matchedTraceEvidenceRefIdsByClaimId: input.claimVerificationResult
        ? collectMatchedTraceEvidenceRefIdsByClaimId(input.claimVerificationResult)
        : {},
      verifiedTraceOccurrenceRefIdsByClaimId: input.claimVerificationResult
        ? collectVerifiedTraceOccurrenceRefIdsByClaimId(input.claimVerificationResult)
        : {},
    });
    conclusionContract = verification.status === 'not_checked'
      ? sanitized
      : {...sanitized, sourceClaimBindings: verification.bindings};
  }

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
    sceneType,
    title: `${sceneType} analysis - ${input.traceLabel || input.traceId}`,
    userQuery: input.query,
    traceLabel: input.traceLabel || input.traceId,
    traceMetadata: {},
    summary: {
      headline,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(partialReasons.length > 0 ? { partialReasons } : {}),
      ...(analysisReceipt ? { analysisReceipt } : {}),
      ...(traceSummary ? {traceSummary} : {}),
      ...(input.uiActionProposals && input.uiActionProposals.length > 0 ? { uiActionProposals: input.uiActionProposals } : {}),
    },
    ...(conclusionContract ? { conclusionContract } : {}),
    ...(input.claimSupport ? { claimSupport: input.claimSupport } : {}),
    ...(input.claimVerificationResult ? { claimVerificationResult: input.claimVerificationResult } : {}),
    ...(input.identityResolutions ? { identityResolutions: input.identityResolutions } : {}),
    ...(capabilityManifest ? {capabilityManifest} : {}),
    metrics,
    evidenceRefs: evidenceRefsFromInput(input),
    status: input.partial || metrics.length === 0 ? 'partial' : 'ready',
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
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
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

  db.prepare(`
    INSERT OR IGNORE INTO analysis_runs
      (id, tenant_id, workspace_id, session_id, mode, status, question, started_at, completed_at, heartbeat_at, updated_at)
    VALUES
      (?, ?, ?, ?, 'agent', 'completed', ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.tenantId,
    input.workspaceId,
    input.sessionId,
    input.query,
    now,
    now,
    now,
    now,
  );
}

export function persistCompletedAnalysisResultSnapshot(
  input: CompletedAnalysisSnapshotInput,
): AnalysisResultSnapshot | null {
  const outputLanguage = input.outputLanguage
    ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const durableInput: CompletedAnalysisSnapshotInput = input.privateKnowledge
    ? {
        ...input,
        query: privateAnalysisQueryMessage(outputLanguage),
        traceLabel: input.traceId,
        conclusion: projectPrivateConclusion({
          sessionId: input.sessionId,
          conclusion: input.conclusion,
          success: true,
          language: outputLanguage,
        }),
        conclusionContract: input.conclusionContract
          ? projectPrivateStructuredValue(input.sessionId, input.conclusionContract)
          : undefined,
        claimSupport: projectPrivateClaimSupport(input.sessionId, input.claimSupport),
        claimVerificationResult: projectPrivateClaimVerification(
          input.sessionId,
          input.claimVerificationResult,
        ),
        identityResolutions: projectPrivateIdentityResolutions(
          input.sessionId,
          input.identityResolutions,
        ),
        terminationReason: projectPrivateTerminationReason(input.terminationReason),
        terminationMessage: projectPrivateTerminationMessage(input.terminationMessage, outputLanguage),
        analysisReceipt: projectPrivateAnalysisReceipt(input.analysisReceipt),
        uiActionProposals: projectPrivateUiActionProposals(
          input.sessionId,
          input.uiActionProposals,
        ),
        dataEnvelopes: projectPrivateDataEnvelopes(input.sessionId, input.dataEnvelopes || []),
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
