// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type {
  ComparisonMetricKey,
  ComparisonResult,
  MultiTraceComparisonRun,
  MultiTraceComparisonRunStatus,
} from '../types/multiTraceComparison';
import {
  MULTI_TRACE_COMPARISON_RUN_SCHEMA_VERSION,
} from '../types/multiTraceComparison';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';
import { recordEnterpriseAuditEvent } from './enterpriseAuditService';
import { restrictableArtifactAudienceParams, restrictableArtifactAudienceSql } from './resourceOwnership';
import {
  decodePrivateContextColumn,
  encodePrivateContextColumn,
  unionPrivateContexts,
} from './security/analysisPrivateContext';

interface ComparisonRunRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  created_by: string | null;
  baseline_snapshot_id: string | null;
  query: string;
  status: MultiTraceComparisonRunStatus;
  result_json: string | null;
  report_id: string | null;
  error: string | null;
  schema_version: typeof MULTI_TRACE_COMPARISON_RUN_SCHEMA_VERSION;
  created_at: number;
  completed_at: number | null;
  private_context: number | null;
}

interface ComparisonInputRow {
  snapshot_id: string;
  role: 'baseline' | 'candidate';
  ordinal: number;
}

export interface CreateComparisonRunInput {
  id?: string;
  baselineSnapshotId?: string;
  candidateSnapshotIds: string[];
  query: string;
  metricKeys?: ComparisonMetricKey[];
  status?: MultiTraceComparisonRunStatus;
}

export interface UpdateComparisonRunInput {
  status: MultiTraceComparisonRunStatus;
  baselineSnapshotId?: string;
  result?: ComparisonResult;
  reportId?: string;
  error?: string;
  completedAt?: number;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRun(row: ComparisonRunRow, inputRows: ComparisonInputRow[]): MultiTraceComparisonRun {
  const orderedInputs = [...inputRows].sort((a, b) => a.ordinal - b.ordinal);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    inputSnapshotIds: orderedInputs.map(input => input.snapshot_id),
    ...(row.baseline_snapshot_id ? { baselineSnapshotId: row.baseline_snapshot_id } : {}),
    privateContext: decodePrivateContextColumn(row.private_context),
    query: row.query,
    status: row.status,
    ...(row.result_json ? { result: parseJson<ComparisonResult | undefined>(row.result_json, undefined) } : {}),
    ...(row.report_id ? { reportId: row.report_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

/** An unowned comparison stays readable only while it is unrestricted. */
const READABLE_RUN_SQL = restrictableArtifactAudienceSql('', 'created_by IS NULL');

function uniqueSnapshotIds(baselineSnapshotId: string | undefined, candidates: string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [baselineSnapshotId, ...candidates]) {
    const normalized = id?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(normalized);
  }
  return ids;
}

export class MultiTraceComparisonRunRepository {
  constructor(private readonly db: Database.Database) {}

  createRun(
    scope: EnterpriseRepositoryScope,
    input: CreateComparisonRunInput,
  ): MultiTraceComparisonRun {
    const now = Date.now();
    const id = input.id || crypto.randomUUID();
    const baselineSnapshotId = input.baselineSnapshotId?.trim() || undefined;
    const inputSnapshotIds = uniqueSnapshotIds(
      baselineSnapshotId,
      input.candidateSnapshotIds,
    );
    if (inputSnapshotIds.length < 2) {
      throw new Error('comparison run requires at least two snapshots');
    }

    const write = this.db.transaction(() => {
      // The result embeds its inputs, so it takes the union of their markers;
      // an input this scope does not hold contributes an unknown one.
      const inputMarkers = new Map(this.db.prepare<unknown[], {id: string; private_context: number | null}>(`
        SELECT id, private_context
        FROM analysis_result_snapshots
        WHERE tenant_id = ? AND workspace_id = ?
          AND id IN (${inputSnapshotIds.map(() => '?').join(', ')})
      `).all(scope.tenantId, scope.workspaceId, ...inputSnapshotIds)
        .map(row => [row.id, decodePrivateContextColumn(row.private_context)]));
      const privateContext = unionPrivateContexts(
        inputSnapshotIds.map(snapshotId => inputMarkers.get(snapshotId) ?? 'unknown'),
      );
      this.db.prepare(`
        INSERT INTO multi_trace_comparison_runs
          (id, tenant_id, workspace_id, created_by, baseline_snapshot_id,
           query, status, result_json, report_id, error, schema_version,
           created_at, completed_at, private_context)
        VALUES
          (@id, @tenantId, @workspaceId, @createdBy, @baselineSnapshotId,
           @query, @status, NULL, NULL, NULL, @schemaVersion, @createdAt, NULL, @privateContext)
      `).run({
        id,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        createdBy: scope.userId ?? null,
        baselineSnapshotId: baselineSnapshotId ?? null,
        query: input.query,
        status: input.status ?? 'pending',
        schemaVersion: MULTI_TRACE_COMPARISON_RUN_SCHEMA_VERSION,
        createdAt: now,
        privateContext: encodePrivateContextColumn(privateContext),
      });

      const insertInput = this.db.prepare(`
        INSERT INTO multi_trace_comparison_inputs
          (comparison_id, snapshot_id, role, ordinal)
        VALUES
          (@comparisonId, @snapshotId, @role, @ordinal)
      `);
      inputSnapshotIds.forEach((snapshotId, ordinal) => {
        insertInput.run({
          comparisonId: id,
          snapshotId,
          role: snapshotId === baselineSnapshotId ? 'baseline' : 'candidate',
          ordinal,
        });
      });

      recordEnterpriseAuditEvent(this.db, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: scope.userId,
        action: 'comparison.created',
        resourceType: 'multi_trace_comparison_run',
        resourceId: id,
        metadata: {
          baselineSnapshotId: baselineSnapshotId ?? null,
          inputSnapshotCount: inputSnapshotIds.length,
          status: input.status ?? 'pending',
        },
      });
    });
    write();

    const run = this.getRun(scope, id);
    if (!run) {
      throw new Error('Failed to persist comparison run');
    }
    return run;
  }

  getRun(scope: EnterpriseRepositoryScope, comparisonId: string): MultiTraceComparisonRun | null {
    const row = this.db.prepare<unknown[], ComparisonRunRow>(`
      SELECT *
      FROM multi_trace_comparison_runs
      WHERE tenant_id = @tenantId
        AND workspace_id = @workspaceId
        AND id = @comparisonId
        AND ${READABLE_RUN_SQL}
      LIMIT 1
    `).get({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      ...restrictableArtifactAudienceParams(scope),
      comparisonId,
    });
    if (!row) return null;
    const inputRows = this.db.prepare<unknown[], ComparisonInputRow>(`
      SELECT snapshot_id, role, ordinal
      FROM multi_trace_comparison_inputs
      WHERE comparison_id = ?
      ORDER BY ordinal ASC
    `).all(row.id);
    return mapRun(row, inputRows);
  }

  updateRun(
    scope: EnterpriseRepositoryScope,
    comparisonId: string,
    input: UpdateComparisonRunInput,
  ): MultiTraceComparisonRun | null {
    const completedAt = input.completedAt
      ?? (['completed', 'failed', 'needs_selection'].includes(input.status)
        ? Date.now()
        : null);
    const resultJson = input.result ? JSON.stringify(input.result) : null;
    const hasBaselineSnapshotId = input.baselineSnapshotId !== undefined;
    const update = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE multi_trace_comparison_runs
        SET status = @status,
            baseline_snapshot_id = CASE
              WHEN @hasBaselineSnapshotId = 1 THEN @baselineSnapshotId
              ELSE baseline_snapshot_id
            END,
            result_json = @resultJson,
            report_id = @reportId,
            error = @error,
            completed_at = @completedAt
        WHERE tenant_id = @tenantId
          AND workspace_id = @workspaceId
          AND id = @comparisonId
          AND ${READABLE_RUN_SQL}
      `).run({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        ...restrictableArtifactAudienceParams(scope),
        comparisonId,
        status: input.status,
        hasBaselineSnapshotId: hasBaselineSnapshotId ? 1 : 0,
        baselineSnapshotId: input.baselineSnapshotId ?? null,
        resultJson,
        reportId: input.reportId ?? null,
        error: input.error ?? null,
        completedAt,
      });

      if (result.changes > 0 && hasBaselineSnapshotId) {
        this.db.prepare(`
          UPDATE multi_trace_comparison_inputs
          SET role = CASE
            WHEN snapshot_id = @baselineSnapshotId THEN 'baseline'
            ELSE 'candidate'
          END
          WHERE comparison_id = @comparisonId
        `).run({
          comparisonId,
          baselineSnapshotId: input.baselineSnapshotId,
        });
      }

      return result;
    })();
    if (update.changes === 0) return null;
    recordEnterpriseAuditEvent(this.db, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.userId,
      action: 'comparison.updated',
      resourceType: 'multi_trace_comparison_run',
      resourceId: comparisonId,
      metadata: {
        status: input.status,
        baselineSnapshotId: input.baselineSnapshotId ?? null,
        reportId: input.reportId ?? null,
      },
    });
    return this.getRun(scope, comparisonId);
  }
}

export function createMultiTraceComparisonRunRepository(
  db: Database.Database,
): MultiTraceComparisonRunRepository {
  return new MultiTraceComparisonRunRepository(db);
}
