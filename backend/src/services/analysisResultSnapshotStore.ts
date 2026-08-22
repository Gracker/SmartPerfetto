// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type {
  AnalysisResultSceneType,
  AnalysisResultSnapshot,
  AnalysisResultSnapshotStatus,
  AnalysisResultVisibility,
  AnalysisSummary,
  ComparisonMetricKey,
  EvidenceRef,
  EvidenceRefType,
  NormalizedMetricAggregation,
  NormalizedMetricDirection,
  NormalizedMetricSource,
  NormalizedMetricUnit,
  NormalizedMetricValue,
  TraceComparisonMetadata,
} from '../types/multiTraceComparison';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';
import { recordEnterpriseAuditEvent } from './enterpriseAuditService';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface SnapshotRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  trace_id: string;
  session_id: string;
  run_id: string;
  report_id: string | null;
  created_by: string | null;
  visibility: AnalysisResultVisibility;
  scene_type: AnalysisResultSceneType;
  title: string;
  user_query: string;
  trace_label: string;
  trace_metadata_json: string;
  summary_json: string;
  conclusion_contract_json: string | null;
  claim_support_json: string | null;
  claim_verification_json: string | null;
  identity_resolutions_json: string | null;
  capability_manifest_json: string | null;
  status: AnalysisResultSnapshotStatus;
  schema_version: AnalysisResultSnapshot['schemaVersion'];
  created_at: number;
  expires_at: number | null;
}

interface MetricRow {
  metric_key: ComparisonMetricKey;
  metric_group: string;
  label: string;
  value_json: string | null;
  numeric_value: number | null;
  unit: NormalizedMetricUnit | null;
  direction: NormalizedMetricDirection | null;
  aggregation: NormalizedMetricAggregation | null;
  confidence: number;
  missing_reason: string | null;
  source_json: string;
}

interface EvidenceRow {
  id: string;
  ref_type: EvidenceRefType;
  ref_json: string;
}

export interface AnalysisResultSnapshotListFilters {
  traceId?: string;
  sceneType?: AnalysisResultSceneType;
  visibility?: AnalysisResultVisibility;
  createdBy?: string;
  includeExpired?: boolean;
  includeConclusionContract?: boolean;
  limit?: number;
}

export interface SnapshotAccessScope extends EnterpriseRepositoryScope {
  auditActorUserId?: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function snapshotSelectColumns(alias = 's', includeConclusionContract = true): string {
  const conclusionContractColumn = includeConclusionContract
    ? `${alias}.conclusion_contract_json`
    : `NULL AS conclusion_contract_json`;
  const claimSupportColumn = includeConclusionContract
    ? `${alias}.claim_support_json`
    : `NULL AS claim_support_json`;
  const claimVerificationColumn = includeConclusionContract
    ? `${alias}.claim_verification_json`
    : `NULL AS claim_verification_json`;
  const identityResolutionsColumn = includeConclusionContract
    ? `${alias}.identity_resolutions_json`
    : `NULL AS identity_resolutions_json`;
  return [
    `${alias}.id`,
    `${alias}.tenant_id`,
    `${alias}.workspace_id`,
    `${alias}.trace_id`,
    `${alias}.session_id`,
    `${alias}.run_id`,
    `${alias}.report_id`,
    `${alias}.created_by`,
    `${alias}.visibility`,
    `${alias}.scene_type`,
    `${alias}.title`,
    `${alias}.user_query`,
    `${alias}.trace_label`,
    `${alias}.trace_metadata_json`,
    `${alias}.summary_json`,
    conclusionContractColumn,
    claimSupportColumn,
    claimVerificationColumn,
    identityResolutionsColumn,
    `${alias}.capability_manifest_json`,
    `${alias}.status`,
    `${alias}.schema_version`,
    `${alias}.created_at`,
    `${alias}.expires_at`,
  ].join(', ');
}

function metricNumericValue(metric: NormalizedMetricValue): number | null {
  return typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('limit must be an integer between 1 and 500');
  }
  return limit;
}

function readableClause(scope: SnapshotAccessScope, alias = 's'): {
  sql: string;
  params: Record<string, string | number | null>;
} {
  const params: Record<string, string | number | null> = {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    userId: scope.userId ?? null,
  };
  const ownerClause = scope.userId
    ? `${alias}.created_by = @userId`
    : `${alias}.created_by IS NULL`;
  return {
    sql: [
      `${alias}.tenant_id = @tenantId`,
      `${alias}.workspace_id = @workspaceId`,
      `(${alias}.visibility = 'workspace' OR ${alias}.created_by IS NULL OR ${ownerClause})`,
    ].join(' AND '),
    params,
  };
}

function writableOwnerClause(scope: SnapshotAccessScope, alias = 's'): {
  sql: string;
  params: Record<string, string | number | null>;
} {
  return {
    sql: [
      `${alias}.tenant_id = @tenantId`,
      `${alias}.workspace_id = @workspaceId`,
      scope.userId ? `${alias}.created_by = @userId` : `${alias}.created_by IS NULL`,
    ].join(' AND '),
    params: {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      userId: scope.userId ?? null,
    },
  };
}

function mapSnapshot(row: SnapshotRow, metrics: NormalizedMetricValue[], evidenceRefs: EvidenceRef[]): AnalysisResultSnapshot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    traceId: row.trace_id,
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.report_id ? { reportId: row.report_id } : {}),
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    visibility: row.visibility,
    sceneType: row.scene_type,
    title: row.title,
    userQuery: row.user_query,
    traceLabel: row.trace_label,
    traceMetadata: parseJson<TraceComparisonMetadata>(row.trace_metadata_json, {}),
    summary: parseJson<AnalysisSummary>(row.summary_json, { headline: '' }),
    ...(row.conclusion_contract_json
      ? { conclusionContract: parseJson<unknown>(row.conclusion_contract_json, undefined) }
      : {}),
    ...(row.claim_support_json
      ? { claimSupport: parseJson<AnalysisResultSnapshot['claimSupport']>(row.claim_support_json, undefined) }
      : {}),
    ...(row.claim_verification_json
      ? { claimVerificationResult: parseJson<AnalysisResultSnapshot['claimVerificationResult']>(row.claim_verification_json, undefined) }
      : {}),
    ...(row.identity_resolutions_json
      ? { identityResolutions: parseJson<AnalysisResultSnapshot['identityResolutions']>(row.identity_resolutions_json, undefined) }
      : {}),
    ...(row.capability_manifest_json
      ? {capabilityManifest: parseJson<AnalysisResultSnapshot['capabilityManifest']>(row.capability_manifest_json, undefined)}
      : {}),
    metrics,
    evidenceRefs,
    status: row.status,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

function mapMetric(row: MetricRow): NormalizedMetricValue {
  return {
    key: row.metric_key,
    label: row.label,
    group: row.metric_group,
    value: row.value_json === null ? null : parseJson<number | string | null>(row.value_json, null),
    ...(row.unit ? { unit: row.unit } : {}),
    ...(row.direction ? { direction: row.direction } : {}),
    ...(row.aggregation ? { aggregation: row.aggregation } : {}),
    confidence: row.confidence,
    ...(row.missing_reason ? { missingReason: row.missing_reason } : {}),
    source: parseJson<NormalizedMetricSource>(row.source_json, { type: 'manual' }),
  };
}

function mapEvidence(row: EvidenceRow): EvidenceRef {
  const ref = parseJson<EvidenceRef>(row.ref_json, { id: row.id, type: row.ref_type });
  return {
    ...ref,
    id: ref.id || row.id,
    type: ref.type || row.ref_type,
  };
}

function evidenceStorageId(
  snapshotId: string,
  evidence: EvidenceRef,
  seen: Map<string, number>,
): string {
  const base = evidence.id
    ? `${snapshotId}:${evidence.id}`
    : `${snapshotId}:evidence:${crypto.randomUUID()}`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}:${count}`;
}

export class AnalysisResultSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  createSnapshot(snapshot: AnalysisResultSnapshot): AnalysisResultSnapshot {
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO analysis_result_snapshots
          (id, tenant_id, workspace_id, trace_id, session_id, run_id, report_id, created_by,
           visibility, scene_type, title, user_query, trace_label, trace_metadata_json,
           summary_json, conclusion_contract_json, claim_support_json, claim_verification_json,
           identity_resolutions_json, capability_manifest_json, status, schema_version, created_at, expires_at)
        VALUES
          (@id, @tenantId, @workspaceId, @traceId, @sessionId, @runId, @reportId, @createdBy,
           @visibility, @sceneType, @title, @userQuery, @traceLabel, @traceMetadataJson,
           @summaryJson, @conclusionContractJson, @claimSupportJson, @claimVerificationJson,
           @identityResolutionsJson, @capabilityManifestJson, @status, @schemaVersion, @createdAt, @expiresAt)
      `).run({
        id: snapshot.id,
        tenantId: snapshot.tenantId,
        workspaceId: snapshot.workspaceId,
        traceId: snapshot.traceId,
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        reportId: snapshot.reportId ?? null,
        createdBy: snapshot.createdBy ?? null,
        visibility: snapshot.visibility,
        sceneType: snapshot.sceneType,
        title: snapshot.title,
        userQuery: snapshot.userQuery,
        traceLabel: snapshot.traceLabel,
        traceMetadataJson: stringifyJson(snapshot.traceMetadata),
        summaryJson: stringifyJson(snapshot.summary),
        conclusionContractJson: snapshot.conclusionContract === undefined
          ? null
          : stringifyJson(snapshot.conclusionContract),
        claimSupportJson: snapshot.claimSupport === undefined
          ? null
          : stringifyJson(snapshot.claimSupport),
        claimVerificationJson: snapshot.claimVerificationResult === undefined
          ? null
          : stringifyJson(snapshot.claimVerificationResult),
        identityResolutionsJson: snapshot.identityResolutions === undefined
          ? null
          : stringifyJson(snapshot.identityResolutions),
        capabilityManifestJson: snapshot.capabilityManifest === undefined
          ? null
          : stringifyJson(snapshot.capabilityManifest),
        status: snapshot.status,
        schemaVersion: snapshot.schemaVersion,
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt ?? null,
      });

      const insertMetric = this.db.prepare(`
        INSERT INTO analysis_result_metrics
          (id, snapshot_id, metric_key, metric_group, label, value_json, numeric_value, unit,
           direction, aggregation, confidence, missing_reason, source_json)
        VALUES
          (@id, @snapshotId, @metricKey, @metricGroup, @label, @valueJson, @numericValue, @unit,
           @direction, @aggregation, @confidence, @missingReason, @sourceJson)
      `);
      for (const metric of snapshot.metrics) {
        insertMetric.run({
          id: crypto.randomUUID(),
          snapshotId: snapshot.id,
          metricKey: metric.key,
          metricGroup: metric.group,
          label: metric.label,
          valueJson: stringifyJson(metric.value),
          numericValue: metricNumericValue(metric),
          unit: metric.unit ?? null,
          direction: metric.direction ?? null,
          aggregation: metric.aggregation ?? null,
          confidence: metric.confidence,
          missingReason: metric.missingReason ?? null,
          sourceJson: stringifyJson(metric.source),
        });
      }

      const insertEvidence = this.db.prepare(`
        INSERT INTO analysis_result_evidence_refs
          (id, snapshot_id, ref_type, ref_json, created_at)
        VALUES
          (@id, @snapshotId, @refType, @refJson, @createdAt)
      `);
      const evidenceIds = new Map<string, number>();
      for (const evidence of snapshot.evidenceRefs) {
        insertEvidence.run({
          id: evidenceStorageId(snapshot.id, evidence, evidenceIds),
          snapshotId: snapshot.id,
          refType: evidence.type,
          refJson: stringifyJson(evidence),
          createdAt: snapshot.createdAt,
        });
      }

      recordEnterpriseAuditEvent(this.db, {
        tenantId: snapshot.tenantId,
        workspaceId: snapshot.workspaceId,
        actorUserId: snapshot.createdBy,
        action: 'analysis_result.created',
        resourceType: 'analysis_result_snapshot',
        resourceId: snapshot.id,
        metadata: {
          traceId: snapshot.traceId,
          sessionId: snapshot.sessionId,
          runId: snapshot.runId,
          visibility: snapshot.visibility,
          sceneType: snapshot.sceneType,
          metricCount: snapshot.metrics.length,
        },
      });
    });
    write();
    return snapshot;
  }

  getSnapshot(scope: SnapshotAccessScope, snapshotId: string): AnalysisResultSnapshot | null {
    const where = readableClause(scope);
    const row = this.db.prepare<unknown[], SnapshotRow>(`
      SELECT ${snapshotSelectColumns('s', true)}
      FROM analysis_result_snapshots s
      WHERE ${where.sql}
        AND s.id = @snapshotId
        AND (s.expires_at IS NULL OR s.expires_at > @now)
      LIMIT 1
    `).get({
      ...where.params,
      snapshotId,
      now: Date.now(),
    });
    if (!row) return null;
    const snapshot = this.hydrateSnapshot(row);
    this.recordReadAudit(scope, snapshot.id, 'analysis_result.read');
    return snapshot;
  }

  listSnapshots(
    scope: SnapshotAccessScope,
    filters: AnalysisResultSnapshotListFilters = {},
  ): AnalysisResultSnapshot[] {
    const where = readableClause(scope);
    const clauses = [where.sql];
    const params: Record<string, string | number | null> = {
      ...where.params,
      now: Date.now(),
      limit: boundedLimit(filters.limit),
    };
    if (!filters.includeExpired) {
      clauses.push('(s.expires_at IS NULL OR s.expires_at > @now)');
    }
    if (filters.traceId) {
      clauses.push('s.trace_id = @traceId');
      params.traceId = filters.traceId;
    }
    if (filters.sceneType) {
      clauses.push('s.scene_type = @sceneType');
      params.sceneType = filters.sceneType;
    }
    if (filters.visibility) {
      clauses.push('s.visibility = @visibility');
      params.visibility = filters.visibility;
    }
    if (filters.createdBy) {
      clauses.push('s.created_by = @createdBy');
      params.createdBy = filters.createdBy;
    }

    const rows = this.db.prepare<unknown[], SnapshotRow>(`
      SELECT ${snapshotSelectColumns('s', Boolean(filters.includeConclusionContract))}
      FROM analysis_result_snapshots s
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT @limit
    `).all(params);
    if (rows.length > 0) {
      this.recordReadAudit(scope, undefined, 'analysis_result.listed', { count: rows.length });
    }
    return rows.map(row => this.hydrateSnapshot(row));
  }

  updateVisibility(
    scope: SnapshotAccessScope,
    snapshotId: string,
    visibility: AnalysisResultVisibility,
  ): AnalysisResultSnapshot | null {
    const where = writableOwnerClause(scope);
    const result = this.db.prepare(`
      UPDATE analysis_result_snapshots AS s
      SET visibility = @visibility
      WHERE ${where.sql}
        AND s.id = @snapshotId
        AND (s.expires_at IS NULL OR s.expires_at > @now)
    `).run({
      ...where.params,
      snapshotId,
      visibility,
      now: Date.now(),
    });
    if (result.changes === 0) return null;
    this.recordReadAudit(scope, snapshotId, 'analysis_result.visibility_updated', { visibility });
    return this.getSnapshot(scope, snapshotId);
  }

  upsertMetrics(
    scope: SnapshotAccessScope,
    snapshotId: string,
    metrics: NormalizedMetricValue[],
    evidenceRefs: EvidenceRef[] = [],
  ): AnalysisResultSnapshot | null {
    if (metrics.length === 0 && evidenceRefs.length === 0) {
      return this.getSnapshot(scope, snapshotId);
    }
    const where = readableClause(scope);
    const snapshot = this.db.prepare<unknown[], { id: string }>(`
      SELECT s.id
      FROM analysis_result_snapshots s
      WHERE ${where.sql}
        AND s.id = @snapshotId
        AND (s.expires_at IS NULL OR s.expires_at > @now)
      LIMIT 1
    `).get({
      ...where.params,
      snapshotId,
      now: Date.now(),
    });
    if (!snapshot) return null;

    const write = this.db.transaction(() => {
      const upsertMetric = this.db.prepare(`
        INSERT INTO analysis_result_metrics
          (id, snapshot_id, metric_key, metric_group, label, value_json, numeric_value, unit,
           direction, aggregation, confidence, missing_reason, source_json)
        VALUES
          (@id, @snapshotId, @metricKey, @metricGroup, @label, @valueJson, @numericValue, @unit,
           @direction, @aggregation, @confidence, @missingReason, @sourceJson)
        ON CONFLICT(snapshot_id, metric_key) DO UPDATE SET
          metric_group = excluded.metric_group,
          label = excluded.label,
          value_json = excluded.value_json,
          numeric_value = excluded.numeric_value,
          unit = excluded.unit,
          direction = excluded.direction,
          aggregation = excluded.aggregation,
          confidence = excluded.confidence,
          missing_reason = excluded.missing_reason,
          source_json = excluded.source_json
      `);
      for (const metric of metrics) {
        upsertMetric.run({
          id: crypto.randomUUID(),
          snapshotId,
          metricKey: metric.key,
          metricGroup: metric.group,
          label: metric.label,
          valueJson: stringifyJson(metric.value),
          numericValue: metricNumericValue(metric),
          unit: metric.unit ?? null,
          direction: metric.direction ?? null,
          aggregation: metric.aggregation ?? null,
          confidence: metric.confidence,
          missingReason: metric.missingReason ?? null,
          sourceJson: stringifyJson(metric.source),
        });
      }

      const insertEvidence = this.db.prepare(`
        INSERT OR REPLACE INTO analysis_result_evidence_refs
          (id, snapshot_id, ref_type, ref_json, created_at)
        VALUES
          (@id, @snapshotId, @refType, @refJson, @createdAt)
      `);
      const evidenceIds = new Map<string, number>();
      for (const evidence of evidenceRefs) {
        insertEvidence.run({
          id: evidenceStorageId(snapshotId, evidence, evidenceIds),
          snapshotId,
          refType: evidence.type,
          refJson: stringifyJson(evidence),
          createdAt: Date.now(),
        });
      }

      this.recordReadAudit(scope, snapshotId, 'analysis_result.metrics_backfilled', {
        metricCount: metrics.length,
        evidenceCount: evidenceRefs.length,
      });
    });
    write();
    return this.getSnapshot(scope, snapshotId);
  }

  deleteSnapshot(scope: SnapshotAccessScope, snapshotId: string): boolean {
    const where = writableOwnerClause(scope);
    const result = this.db.prepare(`
      DELETE FROM analysis_result_snapshots AS s
      WHERE ${where.sql}
        AND s.id = @snapshotId
    `).run({
      ...where.params,
      snapshotId,
    });
    if (result.changes > 0) {
      this.recordReadAudit(scope, snapshotId, 'analysis_result.deleted');
    }
    return result.changes > 0;
  }

  private hydrateSnapshot(row: SnapshotRow): AnalysisResultSnapshot {
    const metrics = this.db.prepare<unknown[], MetricRow>(`
      SELECT metric_key, metric_group, label, value_json, numeric_value, unit,
             direction, aggregation, confidence, missing_reason, source_json
      FROM analysis_result_metrics
      WHERE snapshot_id = ?
      ORDER BY metric_group ASC, metric_key ASC
    `).all(row.id).map(mapMetric);
    const evidenceRefs = this.db.prepare<unknown[], EvidenceRow>(`
      SELECT id, ref_type, ref_json
      FROM analysis_result_evidence_refs
      WHERE snapshot_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(row.id).map(mapEvidence);
    return mapSnapshot(row, metrics, evidenceRefs);
  }

  private recordReadAudit(
    scope: SnapshotAccessScope,
    snapshotId: string | undefined,
    action: string,
    metadata: Record<string, JsonValue> = {},
  ): void {
    recordEnterpriseAuditEvent(this.db, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.auditActorUserId ?? scope.userId,
      action,
      resourceType: 'analysis_result_snapshot',
      resourceId: snapshotId,
      metadata,
    });
  }
}

export function createAnalysisResultSnapshotRepository(
  db: Database.Database,
): AnalysisResultSnapshotRepository {
  return new AnalysisResultSnapshotRepository(db);
}
