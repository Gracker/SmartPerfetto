// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Request, Response } from 'express';
import { requireRequestContext } from '../middleware/auth';
import { sendRouteError } from '../middleware/routeFailure';
import { BatchTraceRequestError, invalidBatchTraceRequest } from '../services/batchTrace/batchTraceRequestError';
import { SkillPackRequestError } from '../services/skillPacks/skillPackRequestError';
import { SkillRegistryRejectionError } from '../services/skillEngine/skillLoader';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { repositoryScopeFromRequestContext } from '../services/enterpriseRepository';
import { createAnalysisResultSnapshotRepository } from '../services/analysisResultSnapshotStore';
import { createMultiTraceComparisonRunRepository } from '../services/multiTraceComparisonStore';
import { buildDeterministicComparisonResult, resolveComparisonMetricKeys } from '../services/comparisonResultService';
import { getWorkspaceSkillRegistry } from '../services/skillPacks/workspaceSkillRegistryProvider';
import { runBatchSkill } from '../services/batchTrace/batchTraceRunner';
import {
  assertBatchTraceApiSyncTraceCount,
  resolveBatchTraceApiExecutionLimits,
  tryAcquireBatchTraceApiRun,
} from '../services/batchTrace/batchTraceLimits';
import { BatchTraceRunRepository } from '../services/batchTrace/batchTraceStore';
import { renderBatchTraceHtmlReport } from '../services/batchTrace/batchTraceReportService';
import { promoteBatchTraceSnapshots } from '../services/batchTrace/batchTraceSnapshotPromotionService';
import type { BatchTraceInputV1, BatchTraceRunV1 } from '../services/batchTrace/batchTraceTypes';
import type { ComparisonMetricKey } from '../types/multiTraceComparison';

function stringBody(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw invalidBatchTraceRequest(`${name} is required`);
}

function objectBody(value: unknown): Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'number' ? item : Number(item))
    .filter(item => Number.isInteger(item) && item >= 0);
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw invalidBatchTraceRequest('maxConcurrency must be a positive integer');
  }
  return parsed;
}

function traceInputs(traceIds: string[]): BatchTraceInputV1[] {
  const seen = new Set<string>();
  const unique = traceIds.filter(traceId => {
    if (seen.has(traceId)) return false;
    seen.add(traceId);
    return true;
  });
  return unique.map((traceId, index) => ({
    ordinal: index,
    source: 'workspace_trace',
    traceId,
    label: traceId,
  }));
}

function allCompletedOrdinals(run: BatchTraceRunV1): number[] {
  return run.perTrace
    .filter(result => result.status === 'completed')
    .map(result => result.ordinal);
}

function selectedSnapshotIds(run: BatchTraceRunV1, ordinals: number[]): string[] {
  const selected = new Set(ordinals);
  return run.perTrace
    .filter(result => selected.has(result.ordinal))
    .map(result => result.promotedSnapshotId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Batch request errors and workspace skill pack collisions keep their text;
 * anything else (stores, Skill definitions, trace processing) gets fixed text.
 */
function errorResponse(res: Response, error: unknown): void {
  sendRouteError(res, error, {
    code: 'batch_trace_request_failed',
    error: 'Batch trace request failed',
    logLabel: '[BatchTrace] Request error',
  }, [BatchTraceRequestError, SkillPackRequestError, SkillRegistryRejectionError]);
}

export function createBatchTraceController() {
  return {
    async create(req: Request, res: Response): Promise<void> {
      const context = requireRequestContext(req);
      const scope = repositoryScopeFromRequestContext(context);
      const body = objectBody(req.body);
      const skillId = stringBody(body.skillId);
      const traceIds = stringArray(body.traceIds);
      if (!skillId) {
        res.status(400).json({ success: false, error: 'skillId is required' });
        return;
      }
      if (traceIds.length === 0) {
        res.status(400).json({ success: false, error: 'traceIds must contain at least one trace ID' });
        return;
      }

      let slot: ReturnType<typeof tryAcquireBatchTraceApiRun> | undefined;
      try {
        const apiLimits = resolveBatchTraceApiExecutionLimits();
        assertBatchTraceApiSyncTraceCount(traceIds.length, apiLimits);
        slot = tryAcquireBatchTraceApiRun(apiLimits);
        if (!slot.acquired) {
          res.status(429).json({
            success: false,
            error: 'batch_trace_api_busy',
            retryable: true,
            activeRuns: slot.activeRuns,
            maxInFlightRuns: slot.maxInFlightRuns,
          });
          return;
        }
      } catch (error) {
        errorResponse(res, error);
        return;
      }

      const db = openEnterpriseDb();
      try {
        const registryHandle = await getWorkspaceSkillRegistry(scope, { db });
        const run = await runBatchSkill({
          scope,
          surface: 'api',
          skillId,
          params: objectBody(body.params),
          traceInputs: traceInputs(traceIds),
          maxConcurrency: optionalInteger(body.maxConcurrency),
        }, { registry: registryHandle.registry });
        const stored = new BatchTraceRunRepository(db).saveRun(scope, run);
        res.json({ success: true, run: stored });
      } catch (error) {
        errorResponse(res, error);
      } finally {
        if (slot?.acquired) slot.release();
        db.close();
      }
    },

    list(req: Request, res: Response): void {
      const context = requireRequestContext(req);
      const scope = repositoryScopeFromRequestContext(context);
      const db = openEnterpriseDb();
      try {
        const repository = new BatchTraceRunRepository(db);
        res.json({ success: true, runs: repository.listRuns(scope) });
      } finally {
        db.close();
      }
    },

    get(req: Request, res: Response): void {
      const context = requireRequestContext(req);
      const scope = repositoryScopeFromRequestContext(context);
      const db = openEnterpriseDb();
      try {
        const run = new BatchTraceRunRepository(db).getRun(scope, routeParam(req, 'runId'));
        if (!run) {
          res.status(404).json({ success: false, error: 'batch_trace_run_not_found' });
          return;
        }
        res.json({ success: true, run });
      } finally {
        db.close();
      }
    },

    exportReport(req: Request, res: Response): void {
      const context = requireRequestContext(req);
      const scope = repositoryScopeFromRequestContext(context);
      const db = openEnterpriseDb();
      try {
        const run = new BatchTraceRunRepository(db).getRun(scope, routeParam(req, 'runId'));
        if (!run) {
          res.status(404).json({ success: false, error: 'batch_trace_run_not_found' });
          return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="smartperfetto-batch-${run.id}.html"`);
        res.send(renderBatchTraceHtmlReport(run));
      } finally {
        db.close();
      }
    },

    promoteSnapshots(req: Request, res: Response): void {
      const context = requireRequestContext(req);
      const scope = repositoryScopeFromRequestContext(context);
      const db = openEnterpriseDb();
      try {
        const repository = new BatchTraceRunRepository(db);
        const run = repository.getRun(scope, routeParam(req, 'runId'));
        if (!run) {
          res.status(404).json({ success: false, error: 'batch_trace_run_not_found' });
          return;
        }
        const ordinals = numberArray(objectBody(req.body).ordinals);
        const selectedOrdinals = ordinals.length > 0 ? ordinals : allCompletedOrdinals(run);
        const promoted = promoteBatchTraceSnapshots({
          scope,
          run,
          ordinals: selectedOrdinals,
          snapshotRepository: createAnalysisResultSnapshotRepository(db),
          db,
        });
        const stored = repository.saveRun(scope, run);
        res.json({ success: true, promotedSnapshots: promoted, run: stored });
      } catch (error) {
        errorResponse(res, error);
      } finally {
        db.close();
      }
    },

    createComparison(req: Request, res: Response): void {
      const context = requireRequestContext(req);
      const scope = repositoryScopeFromRequestContext(context);
      const db = openEnterpriseDb();
      try {
        const repository = new BatchTraceRunRepository(db);
        const run = repository.getRun(scope, routeParam(req, 'runId'));
        if (!run) {
          res.status(404).json({ success: false, error: 'batch_trace_run_not_found' });
          return;
        }
        const body = objectBody(req.body);
        const ordinals = numberArray(body.ordinals);
        const selectedOrdinals = ordinals.length > 0 ? ordinals : allCompletedOrdinals(run);
        const snapshotRepository = createAnalysisResultSnapshotRepository(db);
        const alreadyPromoted = selectedSnapshotIds(run, selectedOrdinals);
        const promoted = promoteBatchTraceSnapshots({
          scope,
          run,
          ordinals: selectedOrdinals.filter(ordinal =>
            !run.perTrace.find(result => result.ordinal === ordinal)?.promotedSnapshotId),
          snapshotRepository,
          db,
        });
        const snapshotIds = [...alreadyPromoted, ...promoted.map(item => item.snapshotId)];
        if (snapshotIds.length < 2) {
          res.status(400).json({ success: false, error: 'comparison requires at least two promoted snapshots' });
          return;
        }
        const baselineSnapshotId = stringBody(body.baselineSnapshotId) ?? snapshotIds[0];
        const snapshots = snapshotIds
          .map(snapshotId => snapshotRepository.getSnapshot(scope, snapshotId))
          .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
        const metricKeys = resolveComparisonMetricKeys(stringArray(body.metricKeys) as ComparisonMetricKey[]);
        const comparisonRepository = createMultiTraceComparisonRunRepository(db);
        const comparison = comparisonRepository.createRun(scope, {
          baselineSnapshotId,
          candidateSnapshotIds: snapshotIds.filter(snapshotId => snapshotId !== baselineSnapshotId),
          query: `Batch Skill ${run.input.skillId}`,
          metricKeys,
          status: 'running',
        });
        const result = buildDeterministicComparisonResult(snapshots, { baselineSnapshotId, metricKeys });
        const completed = comparisonRepository.updateRun(scope, comparison.id, {
          status: 'completed',
          result,
          baselineSnapshotId,
        }) ?? comparison;
        const stored = repository.saveRun(scope, { ...run, comparisonId: completed.id });
        res.json({ success: true, comparison: completed, promotedSnapshots: promoted, run: stored });
      } catch (error) {
        errorResponse(res, error);
      } finally {
        db.close();
      }
    },
  };
}
