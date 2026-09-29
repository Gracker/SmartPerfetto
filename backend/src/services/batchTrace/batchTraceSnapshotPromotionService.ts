// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSceneType,
  type AnalysisResultSnapshot,
  type EvidenceRef,
  type NormalizedMetricValue,
} from '../../types/multiTraceComparison';
import type { EnterpriseRepositoryScope } from '../enterpriseRepository';
import type { AnalysisResultSnapshotRepository } from '../analysisResultSnapshotStore';
import { insertAnalysisRunIfMissing } from '../analysisRunStore';
import { NO_PRIVATE_CONTEXT } from '../security/analysisPrivateContext';
import { toPromotableNormalizedMetrics } from './batchTraceMetricExtractor';
import type {
  BatchTraceResultV1,
  BatchTraceRunV1,
  PromotedBatchSnapshot,
} from './batchTraceTypes';

export interface PromoteBatchTraceSnapshotsInput {
  scope: EnterpriseRepositoryScope;
  run: BatchTraceRunV1;
  ordinals: number[];
  snapshotRepository: AnalysisResultSnapshotRepository;
  db?: Database.Database;
}

function inferSceneType(skillId: string): AnalysisResultSceneType {
  const normalized = skillId.toLowerCase();
  if (normalized.includes('startup') || normalized.includes('launch')) return 'startup';
  if (normalized.includes('scroll') || normalized.includes('jank') || normalized.includes('frame')) return 'scrolling';
  if (normalized.includes('memory') || normalized.includes('heap')) return 'memory';
  if (normalized.includes('cpu') || normalized.includes('sched')) return 'cpu';
  return 'general';
}

function selectedCompletedResults(run: BatchTraceRunV1, ordinals: number[]): BatchTraceResultV1[] {
  const selected = new Set(ordinals);
  return run.perTrace
    .filter(result => selected.has(result.ordinal))
    .filter(result => result.status === 'completed' && result.traceId);
}

function partialReasons(result: BatchTraceResultV1, metrics: NormalizedMetricValue[]): string[] {
  return [
    ...result.diagnostics.map(item => `${item.severity}: ${item.message}`),
    ...metrics
      .filter(metric => metric.missingReason)
      .map(metric => `${metric.key}: ${metric.missingReason}`),
  ];
}

function evidenceRefs(run: BatchTraceRunV1, result: BatchTraceResultV1): EvidenceRef[] {
  const refs: EvidenceRef[] = result.evidenceEnvelopeIds.map(id => ({
    id,
    type: 'data_envelope',
    dataEnvelopeId: id,
    runId: run.id,
    label: `Batch trace ${result.ordinal} evidence`,
    metadata: {
      batchRunId: run.id,
      ordinal: result.ordinal,
      skillId: run.input.skillId,
    },
  }));
  refs.push({
    id: `${run.id}:${result.ordinal}:skill`,
    type: 'skill_step',
    runId: run.id,
    label: `Batch Skill ${run.input.skillId}`,
    metadata: {
      batchRunId: run.id,
      ordinal: result.ordinal,
      skillId: run.input.skillId,
      localMetricCount: result.metrics.filter(metric => !metric.promotableMetricKey).length,
    },
  });
  return refs;
}

function ensureBatchSnapshotSession(input: {
  db: Database.Database;
  scope: EnterpriseRepositoryScope;
  run: BatchTraceRunV1;
  result: BatchTraceResultV1;
  sessionId: string;
  analysisRunId: string;
  now: number;
}): void {
  if (!input.result.traceId) return;
  input.db.prepare(`
    INSERT OR IGNORE INTO analysis_sessions
      (id, tenant_id, workspace_id, trace_id, created_by, provider_snapshot_id,
       title, visibility, status, created_at, updated_at)
    VALUES
      (@sessionId, @tenantId, @workspaceId, @traceId, @createdBy, NULL,
       @title, 'workspace', 'completed', @now, @now)
  `).run({
    sessionId: input.sessionId,
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    traceId: input.result.traceId,
    createdBy: input.scope.userId ?? null,
    title: `Batch Skill ${input.run.input.skillId}`,
    now: input.now,
  });
  insertAnalysisRunIfMissing(input.db, {
    id: input.analysisRunId,
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    sessionId: input.sessionId,
    mode: 'batch_skill',
    status: 'completed',
    question: `Batch Skill ${input.run.input.skillId}`,
    startedAt: input.now,
    completedAt: input.now,
    heartbeatAt: input.now,
    updatedAt: input.now,
    // A batch runs one Skill over traces and never reads source or knowledge.
    privateContext: NO_PRIVATE_CONTEXT,
  });
}

function createSnapshot(input: {
  scope: EnterpriseRepositoryScope;
  run: BatchTraceRunV1;
  result: BatchTraceResultV1;
  metrics: NormalizedMetricValue[];
  sessionId: string;
  analysisRunId: string;
  now: number;
}): AnalysisResultSnapshot {
  const traceLabel = input.result.input.label
    ?? input.result.input.traceId
    ?? input.result.input.tracePath
    ?? `trace-${input.result.ordinal}`;
  const reasons = partialReasons(input.result, input.metrics);
  return {
    id: crypto.randomUUID(),
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    traceId: input.result.traceId ?? '',
    sessionId: input.sessionId,
    runId: input.analysisRunId,
    createdBy: input.scope.userId,
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: inferSceneType(input.run.input.skillId),
    title: `Batch Skill result for ${traceLabel}`,
    userQuery: `Batch Skill ${input.run.input.skillId}`,
    traceLabel,
    traceMetadata: {
      traceSizeBytes: input.result.input.sizeBytes,
      batchRunId: input.run.id,
      batchOrdinal: input.result.ordinal,
      skillId: input.run.input.skillId,
    },
    summary: {
      headline: `Batch Skill result for ${traceLabel}`,
      details: [
        `Skill ID: ${input.run.input.skillId}`,
        `Batch run ID: ${input.run.id}`,
        `Trace ordinal: ${input.result.ordinal}`,
        `Promotable metric count: ${input.metrics.length}`,
      ],
      ...(reasons.length > 0 ? { partialReasons: reasons } : {}),
    },
    metrics: input.metrics,
    evidenceRefs: evidenceRefs(input.run, input.result),
    status: reasons.length === 0 ? 'ready' : 'partial',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: input.now,
  };
}

export function promoteBatchTraceSnapshots(
  input: PromoteBatchTraceSnapshotsInput,
): PromotedBatchSnapshot[] {
  const completedResults = selectedCompletedResults(input.run, input.ordinals);
  const promoted: PromotedBatchSnapshot[] = [];
  const now = Date.now();
  for (const result of completedResults) {
    const metrics = toPromotableNormalizedMetrics(result.metrics);
    const sessionId = `batch-session-${input.run.id}-${result.ordinal}`;
    const analysisRunId = `batch-run-${input.run.id}-${result.ordinal}`;
    if (input.db) {
      ensureBatchSnapshotSession({
        db: input.db,
        scope: input.scope,
        run: input.run,
        result,
        sessionId,
        analysisRunId,
        now,
      });
    }
    const snapshot = createSnapshot({
      scope: input.scope,
      run: input.run,
      result,
      metrics,
      sessionId,
      analysisRunId,
      now,
    });
    input.snapshotRepository.createSnapshot(snapshot);
    result.promotedSnapshotId = snapshot.id;
    promoted.push({ ordinal: result.ordinal, snapshotId: snapshot.id, metrics });
  }
  return promoted;
}
