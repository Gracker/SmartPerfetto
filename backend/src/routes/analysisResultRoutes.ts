// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { requireRequestContext } from '../middleware/auth';
import { backendLogPath } from '../runtimePaths';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { repositoryScopeFromRequestContext } from '../services/enterpriseRepository';
import { createAnalysisResultSnapshotRepository } from '../services/analysisResultSnapshotStore';
import { CaseLibrary } from '../services/caseLibrary';
import { getDefaultRagStore } from '../services/ragStore';
import {
  canShareAnalysisResultResource,
  hasRbacPermission,
  sendForbidden,
} from '../services/rbac';
import { knowledgeScopeFromRequestContext } from '../services/scopedKnowledgeStore';
import { createTraceSimilarityService } from '../services/similarity/similarityService';
import type {
  AnalysisResultSceneType,
  AnalysisResultVisibility,
} from '../types/multiTraceComparison';

import {getRegisteredScenes} from '../agentv3/strategyLoader';

const VALID_VISIBILITIES = new Set<AnalysisResultVisibility>(['private', 'workspace']);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('limit must be an integer between 1 and 500');
  }
  return parsed;
}

function parseSimilarityLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('limit must be an integer between 1 and 20');
  }
  return parsed;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('includeCases must be a boolean');
}

const router = express.Router();

router.get('/', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const sceneType = optionalString(req.query.sceneType);
  // CPU is retained for snapshots written before registry scene IDs were stored.
  if (sceneType && sceneType !== 'cpu' && !getRegisteredScenes().some(scene => scene.scene === sceneType)) {
    res.status(400).json({
      success: false,
      error: 'Invalid sceneType',
    });
    return;
  }

  const visibility = optionalString(req.query.visibility);
  if (visibility && !VALID_VISIBILITIES.has(visibility as AnalysisResultVisibility)) {
    res.status(400).json({
      success: false,
      error: 'Invalid visibility',
    });
    return;
  }

  let limit: number | undefined;
  try {
    limit = parseLimit(req.query.limit);
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Invalid limit',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const results = repository.listSnapshots(
      repositoryScopeFromRequestContext(context),
      {
        traceId: optionalString(req.query.traceId),
        sceneType: sceneType as AnalysisResultSceneType | undefined,
        visibility: visibility as AnalysisResultVisibility | undefined,
        createdBy: optionalString(req.query.createdBy),
        limit,
      },
    );
    res.json({
      success: true,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to list analysis results:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list analysis results',
    });
  } finally {
    db.close();
  }
});

router.post('/:snapshotId/similarity', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const snapshotId = optionalString(req.params.snapshotId);
  if (!snapshotId) {
    res.status(400).json({
      success: false,
      error: 'snapshotId is required',
    });
    return;
  }

  let limit: number | undefined;
  let includeCases = false;
  try {
    limit = parseSimilarityLimit(req.body?.limit ?? req.query.limit);
    includeCases = optionalBoolean(req.body?.includeCases ?? req.query.includeCases) ?? false;
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Invalid similarity request',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const service = createTraceSimilarityService({
      snapshotRepository: repository,
      ...(includeCases
        ? {
          caseLibrary: new CaseLibrary(backendLogPath('case_library.json')),
          ragStore: getDefaultRagStore(),
        }
        : {}),
    });
    const result = service.findSimilarAnalysisResult({
      scope: repositoryScopeFromRequestContext(context),
      knowledgeScope: knowledgeScopeFromRequestContext(context),
      snapshotId,
      includeCases,
      limit,
    });
    if (!result) {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to find similar analysis results:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to find similar analysis results',
    });
  } finally {
    db.close();
  }
});

router.get('/:snapshotId', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const snapshotId = optionalString(req.params.snapshotId);
  if (!snapshotId) {
    res.status(400).json({
      success: false,
      error: 'snapshotId is required',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const snapshot = repository.getSnapshot(
      repositoryScopeFromRequestContext(context),
      snapshotId,
    );
    if (!snapshot) {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    res.json({
      success: true,
      snapshot,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to read analysis result:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read analysis result',
    });
  } finally {
    db.close();
  }
});

router.patch('/:snapshotId', (req, res) => {
  const context = requireRequestContext(req);
  const snapshotId = optionalString(req.params.snapshotId);
  if (!snapshotId) {
    res.status(400).json({
      success: false,
      error: 'snapshotId is required',
    });
    return;
  }

  const visibility = optionalString(req.body?.visibility);
  if (!visibility || !VALID_VISIBILITIES.has(visibility as AnalysisResultVisibility)) {
    res.status(400).json({
      success: false,
      error: 'Invalid visibility',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultSnapshotRepository(db);
    const scope = repositoryScopeFromRequestContext(context);
    const existing = repository.getSnapshot(scope, snapshotId);
    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    if (!canShareAnalysisResultResource({
      tenantId: existing.tenantId,
      workspaceId: existing.workspaceId,
      userId: existing.createdBy,
    }, context)) {
      sendForbidden(res, 'analysis_result:share permission is required');
      return;
    }

    const updated = repository.updateVisibility(scope, snapshotId, visibility as AnalysisResultVisibility);
    if (updated.status === 'private_context_not_shareable') {
      res.status(409).json({
        success: false,
        code: 'PRIVATE_CONTEXT_NOT_SHAREABLE',
        error: 'An analysis that read private source or knowledge stays with its creator',
      });
      return;
    }
    if (updated.status === 'not_found') {
      res.status(404).json({
        success: false,
        error: 'Analysis result snapshot not found',
      });
      return;
    }

    res.json({
      success: true,
      snapshot: updated.snapshot,
    });
  } catch (error) {
    console.error('[AnalysisResultRoutes] Failed to update analysis result:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update analysis result',
    });
  } finally {
    db.close();
  }
});

export default router;
