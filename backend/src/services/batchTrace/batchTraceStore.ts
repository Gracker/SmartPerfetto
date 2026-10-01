// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';
import { recordEnterpriseAuditEvent } from '../enterpriseAuditService';
import type {
  BatchTraceResultV1,
  BatchTraceRunStatus,
  BatchTraceRunV1,
} from './batchTraceTypes';
import { parseStoredJson } from '../../utils/storedData';

interface BatchTraceRunRow {
  run_json: string;
}

export interface BatchTraceListFilters {
  limit?: number;
  status?: BatchTraceRunStatus;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseRun(row: BatchTraceRunRow | undefined): BatchTraceRunV1 | null {
  if (!row) return null;
  return parseStoredJson<BatchTraceRunV1>(row.run_json, 'batch trace run');
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit must be an integer between 1 and 200');
  }
  return limit;
}

export class BatchTraceRunRepository {
  constructor(private readonly db: Database.Database) {}

  createRun(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): BatchTraceRunV1 {
    const scopedRun: BatchTraceRunV1 = {
      ...run,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      ...(scope.userId ? { createdBy: scope.userId } : {}),
    };
    const write = this.db.transaction(() => {
      this.insertRun(scope, scopedRun);
      this.replaceInputs(scope, scopedRun);
      recordEnterpriseAuditEvent(this.db, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        action: 'batch_trace.created',
        resourceType: 'batch_trace_run',
        resourceId: scopedRun.id,
        metadata: {
          skillId: scopedRun.input.skillId,
          traceCount: scopedRun.input.traceInputs.length,
          status: scopedRun.status,
        },
      });
    });
    write();
    return scopedRun;
  }

  updateRunStatus(
    scope: EnterpriseRepositoryScope,
    runId: string,
    status: BatchTraceRunStatus,
    timestamps: { startedAt?: number; completedAt?: number } = {},
  ): BatchTraceRunV1 | null {
    const run = this.getRun(scope, runId);
    if (!run) return null;
    const updated: BatchTraceRunV1 = {
      ...run,
      status,
      ...(timestamps.startedAt !== undefined ? { startedAt: timestamps.startedAt } : {}),
      ...(timestamps.completedAt !== undefined ? { completedAt: timestamps.completedAt } : {}),
    };
    this.upsertRun(scope, updated);
    return updated;
  }

  replaceResults(
    scope: EnterpriseRepositoryScope,
    runId: string,
    results: BatchTraceResultV1[],
    aggregate: BatchTraceRunV1['aggregate'],
  ): BatchTraceRunV1 | null {
    const run = this.getRun(scope, runId);
    if (!run) return null;
    const updated: BatchTraceRunV1 = {
      ...run,
      perTrace: results,
      ...(aggregate ? { aggregate } : {}),
    };
    const write = this.db.transaction(() => {
      this.upsertRun(scope, updated);
      this.replaceResultTables(scope, updated);
    });
    write();
    return updated;
  }

  saveRun(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): BatchTraceRunV1 {
    const scopedRun: BatchTraceRunV1 = {
      ...run,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      ...(scope.userId ? { createdBy: scope.userId } : {}),
    };
    const write = this.db.transaction(() => {
      this.upsertRun(scope, scopedRun);
      this.replaceInputs(scope, scopedRun);
      this.replaceResultTables(scope, scopedRun);
    });
    write();
    return scopedRun;
  }

  getRun(scope: EnterpriseRepositoryScope, runId: string): BatchTraceRunV1 | null {
    const row = this.db.prepare<unknown[], BatchTraceRunRow>(`
      SELECT run_json
      FROM batch_trace_runs
      WHERE tenant_id = @tenantId
        AND workspace_id = @workspaceId
        AND id = @runId
      LIMIT 1
    `).get({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      runId,
    });
    return parseRun(row);
  }

  listRuns(scope: EnterpriseRepositoryScope, filters: BatchTraceListFilters = {}): BatchTraceRunV1[] {
    const params = {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      status: filters.status ?? null,
      limit: boundedLimit(filters.limit),
    };
    const statusClause = filters.status ? 'AND status = @status' : '';
    const rows = this.db.prepare<unknown[], BatchTraceRunRow>(`
      SELECT run_json
      FROM batch_trace_runs
      WHERE tenant_id = @tenantId
        AND workspace_id = @workspaceId
        ${statusClause}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `).all(params);
    return rows.map(row => parseRun(row)).filter((run): run is BatchTraceRunV1 => run !== null);
  }

  private insertRun(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): void {
    this.db.prepare(`
      INSERT INTO batch_trace_runs
        (id, tenant_id, workspace_id, created_by, skill_id, status, schema_version,
         params_json, aggregate_json, report_json, comparison_id, run_json,
         created_at, started_at, completed_at)
      VALUES
        (@id, @tenantId, @workspaceId, @createdBy, @skillId, @status, @schemaVersion,
         @paramsJson, @aggregateJson, @reportJson, @comparisonId, @runJson,
         @createdAt, @startedAt, @completedAt)
    `).run(this.runRow(scope, run));
  }

  private upsertRun(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): void {
    this.db.prepare(`
      INSERT INTO batch_trace_runs
        (id, tenant_id, workspace_id, created_by, skill_id, status, schema_version,
         params_json, aggregate_json, report_json, comparison_id, run_json,
         created_at, started_at, completed_at)
      VALUES
        (@id, @tenantId, @workspaceId, @createdBy, @skillId, @status, @schemaVersion,
         @paramsJson, @aggregateJson, @reportJson, @comparisonId, @runJson,
         @createdAt, @startedAt, @completedAt)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        aggregate_json = excluded.aggregate_json,
        report_json = excluded.report_json,
        comparison_id = excluded.comparison_id,
        run_json = excluded.run_json,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `).run(this.runRow(scope, run));
  }

  private runRow(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): Record<string, unknown> {
    return {
      id: run.id,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      createdBy: scope.userId ?? run.createdBy ?? null,
      skillId: run.input.skillId,
      status: run.status,
      schemaVersion: run.schemaVersion,
      paramsJson: stringifyJson(run.input.params),
      aggregateJson: run.aggregate ? stringifyJson(run.aggregate) : null,
      reportJson: run.report ? stringifyJson(run.report) : null,
      comparisonId: run.comparisonId ?? null,
      runJson: stringifyJson(run),
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
    };
  }

  private replaceInputs(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): void {
    this.db.prepare('DELETE FROM batch_trace_inputs WHERE run_id = ?').run(run.id);
    const insert = this.db.prepare(`
      INSERT INTO batch_trace_inputs
        (run_id, tenant_id, workspace_id, ordinal, source, trace_id, trace_path, label, size_bytes)
      VALUES
        (@runId, @tenantId, @workspaceId, @ordinal, @source, @traceId, @tracePath, @label, @sizeBytes)
    `);
    for (const input of run.input.traceInputs) {
      insert.run({
        runId: run.id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        ordinal: input.ordinal,
        source: input.source,
        traceId: input.traceId ?? null,
        tracePath: input.tracePath ?? null,
        label: input.label ?? null,
        sizeBytes: input.sizeBytes ?? null,
      });
    }
  }

  private replaceResultTables(scope: EnterpriseRepositoryScope, run: BatchTraceRunV1): void {
    this.db.prepare('DELETE FROM batch_trace_results WHERE run_id = ?').run(run.id);
    this.db.prepare('DELETE FROM batch_trace_metrics WHERE run_id = ?').run(run.id);
    const insertResult = this.db.prepare(`
      INSERT INTO batch_trace_results
        (run_id, tenant_id, workspace_id, ordinal, trace_id, status, diagnostics_json,
         evidence_envelope_ids_json, execution_time_ms, error, promoted_snapshot_id)
      VALUES
        (@runId, @tenantId, @workspaceId, @ordinal, @traceId, @status, @diagnosticsJson,
         @evidenceEnvelopeIdsJson, @executionTimeMs, @error, @promotedSnapshotId)
    `);
    const insertMetric = this.db.prepare(`
      INSERT INTO batch_trace_metrics
        (id, run_id, tenant_id, workspace_id, ordinal, metric_key, label, value_json,
         numeric_value, unit, source_json, promotable_metric_key, missing_reason)
      VALUES
        (@id, @runId, @tenantId, @workspaceId, @ordinal, @metricKey, @label, @valueJson,
         @numericValue, @unit, @sourceJson, @promotableMetricKey, @missingReason)
    `);

    for (const result of run.perTrace) {
      insertResult.run({
        runId: run.id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        ordinal: result.ordinal,
        traceId: result.traceId ?? null,
        status: result.status,
        diagnosticsJson: stringifyJson(result.diagnostics),
        evidenceEnvelopeIdsJson: stringifyJson(result.evidenceEnvelopeIds),
        executionTimeMs: result.executionTimeMs,
        error: result.error ?? null,
        promotedSnapshotId: result.promotedSnapshotId ?? null,
      });
      for (const metric of result.metrics) {
        insertMetric.run({
          id: crypto.randomUUID(),
          runId: run.id,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          ordinal: result.ordinal,
          metricKey: metric.key,
          label: metric.label,
          valueJson: stringifyJson(metric.value),
          numericValue: metric.numericValue ?? null,
          unit: metric.unit ?? null,
          sourceJson: stringifyJson(metric.source),
          promotableMetricKey: metric.promotableMetricKey ?? null,
          missingReason: metric.missingReason ?? null,
        });
      }
    }
  }
}
