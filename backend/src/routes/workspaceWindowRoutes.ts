// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { requireRequestContext } from '../middleware/auth';
import { resolveFeatureConfig } from '../config';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { repositoryScopeFromRequestContext } from '../services/enterpriseRepository';
import { createAnalysisResultWindowStateRepository } from '../services/analysisResultWindowStateStore';
import { sendResourceNotFound } from '../services/resourceOwnership';
import { hasRbacPermission, sendForbidden } from '../services/rbac';
import type { AnalysisResultSceneType } from '../types/multiTraceComparison';

const VALID_SCENE_TYPES = new Set<AnalysisResultSceneType>([
  'startup',
  'scrolling',
  'interaction',
  'memory',
  'cpu',
  'general',
]);

const router = express.Router();

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMetadata(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
      metadata[key] = raw;
    }
  }
  return metadata;
}

router.get('/active', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultWindowStateRepository(db);
    const scope = repositoryScopeFromRequestContext(context);
    if (resolveFeatureConfig().enterprise && !repository.scopeGraphExists(scope)) {
      sendResourceNotFound(res, 'Workspace not found');
      return;
    }

    const activeWindows = repository.listActiveWindowStates(
      scope,
      {
        excludeWindowId: optionalString(req.query.excludeWindowId),
        limit: optionalNumber(req.query.limit),
      },
    );
    res.json({
      success: true,
      activeWindows,
      count: activeWindows.length,
    });
  } catch (error) {
    console.error('[WorkspaceWindowRoutes] Failed to list active windows:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list active windows',
    });
  } finally {
    db.close();
  }
});

router.post('/:windowId/heartbeat', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'analysis_result:read')) {
    sendForbidden(res, 'analysis_result:read permission is required');
    return;
  }

  const windowId = optionalString(req.params.windowId);
  if (!windowId) {
    res.status(400).json({
      success: false,
      error: 'windowId is required',
    });
    return;
  }

  const sceneType = optionalString(req.body?.sceneType);
  if (sceneType && !VALID_SCENE_TYPES.has(sceneType as AnalysisResultSceneType)) {
    res.status(400).json({
      success: false,
      error: 'Invalid sceneType',
    });
    return;
  }

  const db = openEnterpriseDb();
  try {
    const repository = createAnalysisResultWindowStateRepository(db);
    const scope = repositoryScopeFromRequestContext(context);
    const shouldEnsureScopeGraph = !resolveFeatureConfig().enterprise;
    if (!shouldEnsureScopeGraph && !repository.scopeGraphExists(scope)) {
      sendResourceNotFound(res, 'Workspace not found');
      return;
    }

    const windowState = repository.upsertWindowState(
      scope,
      {
        windowId,
        traceId: optionalString(req.body?.traceId),
        backendTraceId: optionalString(req.body?.backendTraceId),
        activeSessionId: optionalString(req.body?.activeSessionId),
        latestSnapshotId: optionalString(req.body?.latestSnapshotId),
        traceTitle: optionalString(req.body?.traceTitle),
        sceneType: sceneType as AnalysisResultSceneType | undefined,
        metadata: parseMetadata(req.body?.metadata),
        ttlMs: optionalNumber(req.body?.ttlMs),
      },
      { ensureScopeGraph: shouldEnsureScopeGraph },
    );
    const activeWindows = repository.listActiveWindowStates(
      scope,
      {
        excludeWindowId: windowId,
        limit: 20,
      },
    );
    res.json({
      success: true,
      windowState,
      activeWindows,
    });
  } catch (error) {
    console.error('[WorkspaceWindowRoutes] Failed to persist heartbeat:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to persist heartbeat',
    });
  } finally {
    db.close();
  }
});

export default router;
