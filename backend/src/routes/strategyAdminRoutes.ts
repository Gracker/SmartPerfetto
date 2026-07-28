// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Strategy admin endpoints.
 *
 * Exposes a hot-reload endpoint so strategy auto-patches can take effect on
 * a running production backend without a restart. In dev mode strategies are
 * read on every access (DEV_MODE skip cache), so this endpoint is essentially
 * a no-op there — it still provides an explicit signal that future runs
 * should re-parse from disk.
 *
 * See docs/architecture/self-improving-design.md "组件级 Review 与 Patch 边界".
 */

import express from 'express';
import { invalidateStrategyCache } from '../agentv3/strategyLoader';
import { collectSelfImproveMetrics } from '../agentv3/selfImprove/metricsAggregator';
import { collectCaseEvolutionMetrics } from '../services/caseEvolution/caseEvolutionMetricsAggregator';
import {authenticate, requireRequestContext} from '../middleware/auth';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';

const router = express.Router();

router.use(authenticate);

/**
 * POST /api/admin/strategies/reload
 *
 * Drops the in-process strategy / template / phase-hints cache so the next
 * `analyze()` re-reads `.strategy.md` and `.template.md` from disk.
 *
 * Safe to call any time — already-running analyses snapshot their strategy
 * version at start and are not retroactively affected.
 */
router.post('/strategies/reload', (_req, res) => {
  try {
    invalidateStrategyCache();
    res.json({ success: true, reloadedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[StrategyAdmin] Reload failed:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to reload strategy cache' });
  }
});

/**
 * GET /api/admin/self-improve/metrics
 *
 * Read-only snapshot of every self-improving subsystem (pattern memory,
 * supersede markers, review outbox, skill notes, feedback). The dashboard
 * polls this and the trend regression suite snapshots it. Aggregation is
 * best-effort — a corrupt subsystem shows up in `warnings` rather than
 * taking the whole endpoint down.
 */
router.get('/self-improve/metrics', (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'audit:read')) {
      return sendForbidden(res, 'Self-improvement metrics require audit:read');
    }
    const metrics = collectSelfImproveMetrics({
      knowledgeScope: knowledgeScopeFromRequestContext(context),
    });
    res.json(metrics);
  } catch (err) {
    console.error('[SelfImproveMetrics] Aggregation failed:', (err as Error).message);
    res.status(500).json({ success: false, error: 'Failed to aggregate metrics' });
  }
});

/**
 * GET /api/admin/case-evolution/metrics
 *
 * Read-only snapshot of the Case Knowledge Self-Evolution shadow pipeline.
 * Aggregation is best-effort: corrupt DB/log artifacts are surfaced in
 * `warnings` instead of failing the whole dashboard request.
 */
router.get('/case-evolution/metrics', (req, res) => {
  try {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'audit:read')) {
      return sendForbidden(res, 'Case evolution metrics require audit:read');
    }
    res.json(collectCaseEvolutionMetrics({
      knowledgeScope: knowledgeScopeFromRequestContext(context),
    }));
  } catch (err) {
    console.error('[CaseEvolutionMetrics] Aggregation failed:', (err as Error).message);
    res.status(500).json({success: false, error: 'Failed to aggregate case evolution metrics'});
  }
});

export default router;
