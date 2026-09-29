// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Memory Routes — admin / inspection surface for the Plan 44
 * project + world memory store.
 *
 * Endpoints (all under `/api/memory`):
 *   GET    /                   list project + world entries
 *   GET    /audit              read-only promotion audit log
 *   POST   /sweep-confirm      manually auto-confirm ripe analysis patterns
 *   POST   /promote            advance an entry across scopes
 *                              (the `consolidate_to_world_memory`
 *                              admin function from §4.5 lives here)
 *   DELETE /:entryId           remove an entry
 *
 * Notes:
 * - Recall is NOT exposed here — agents use the
 *   `recall_project_memory` MCP tool instead. This route is for
 *   operator-side inspection and promotion only.
 * - `POST /promote` enforces all `projectMemory.promoteEntry`
 *   invariants (auto-promotion forbidden, world requires
 *   reviewer_approval + reviewer name, etc.) and surfaces them
 *   as 400 with a descriptive error.
 *
 * @module memoryRoutes
 */

import {Router, type Router as ExpressRouter} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {ProjectMemory} from '../agentv3/projectMemory';
import {sweepAutoConfirm} from '../agentv3/analysisPatternMemory';
import {recordEnterpriseAuditEventForContext} from '../services/enterpriseAuditService';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import type {MemoryPromotionPolicy} from '../types/sparkContracts';
import {backendLogPath} from '../runtimePaths';

let cachedMemory: ProjectMemory | null = null;
function getDefaultMemory(): ProjectMemory {
  if (!cachedMemory) cachedMemory = new ProjectMemory(backendLogPath('analysis_project_memory.json'));
  return cachedMemory;
}

/** Test/factory hook — pass an explicit ProjectMemory, otherwise use
 * the default singleton. */
export function createMemoryRoutes(memory?: ProjectMemory): ExpressRouter {
  const m = memory ?? getDefaultMemory();
  const router = Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'audit:read')) {
      sendForbidden(res, 'Memory administration requires audit:read permission');
      return;
    }
    next();
  });

  /**
   * GET /api/memory
   *
   * Query: optional `?scope=project|world`, `?projectKey=`, `?tag=`.
   * Lists entries deterministically; returns the count alongside.
   */
  router.get('/', (req, res) => {
    const storageScope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const {scope, projectKey, tag} = req.query as {
      scope?: string;
      projectKey?: string;
      tag?: string;
    };
    const filterScope =
      scope === 'project' || scope === 'world' ? scope : undefined;
    const entries = m.listProjectMemoryEntries({
      scope: filterScope,
      projectKey,
      anyOfTags: tag ? [tag] : undefined,
    }, storageScope);
    res.json({success: true, entries, count: entries.length});
  });

  /**
   * GET /api/memory/audit
   *
   * Read-only view of the promotion audit log. Survives entry
   * removal so the reviewer trail stays permanent.
   */
  router.get('/audit', (_req, res) => {
    requireRequestContext(_req);
    const audit = m.getPromotionAudit();
    res.json({success: true, audit, count: audit.length});
  });

  /**
   * POST /api/memory/sweep-confirm
   *
   * Operator-triggered sweep for provisional analysis patterns that aged past
   * the no-negative-feedback confirmation window. The background process runs
   * this hourly; this endpoint exists for admin repair and verification.
   */
  router.post('/sweep-confirm', async (req, res) => {
    const storageScope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const result = await sweepAutoConfirm(Date.now(), storageScope);
      return res.status(200).json({
        success: true,
        promoted: result.totalPromoted,
        result,
      });
    } catch (err) {
      console.error('[MemoryRoutes] sweep-confirm failed:', err);
      return res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /api/memory/promote
   *
   * Body: `{entryId, policy: MemoryPromotionPolicy}`. The policy must
   * carry a `trigger` from the canonical enum
   * (user_feedback / reviewer_approval / skill_eval_pass);
   * auto_inferred is rejected.
   *
   * This is the operator-side `consolidate_to_world_memory` admin
   * surface from §4.5. Not exposed to the agent.
   */
  router.post('/promote', (req, res) => {
    const storageScope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const {entryId, policy} = (req.body ?? {}) as {
      entryId?: string;
      policy?: MemoryPromotionPolicy;
    };
    if (!entryId || !policy) {
      return res.status(400).json({
        success: false,
        error: '`entryId` and `policy` are required',
      });
    }
    try {
      m.promoteEntry(entryId, policy, storageScope);
      const entry = m.getProjectMemoryEntry(entryId, storageScope);
      recordEnterpriseAuditEventForContext(requireRequestContext(req), {
        action: 'memory.promoted',
        resourceType: 'memory',
        resourceId: entryId,
        metadata: {
          fromScope: policy.fromScope,
          toScope: policy.toScope,
          trigger: policy.trigger,
          reviewer: policy.reviewer,
        },
      });
      return res.status(200).json({success: true, entry});
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** DELETE /api/memory/:entryId */
  router.delete('/:entryId', (req, res) => {
    const storageScope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const removed = m.removeProjectMemoryEntry(req.params.entryId, storageScope);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Entry '${req.params.entryId}' not found`,
      });
    }
    recordEnterpriseAuditEventForContext(requireRequestContext(req), {
      action: 'memory.deleted',
      resourceType: 'memory',
      resourceId: req.params.entryId,
    });
    res.json({success: true});
  });

  return router;
}

const memoryRoutes = createMemoryRoutes();
export default memoryRoutes;
