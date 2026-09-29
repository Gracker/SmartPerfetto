// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Baseline Routes — REST CRUD over the durable App/Device/Build/CUJ
 * baseline store (Plan 50 M0).
 *
 * Endpoints:
 *   POST   /api/baselines          add or replace a baseline
 *   GET    /api/baselines/:id      fetch one
 *   DELETE /api/baselines/:id      remove
 *   GET    /api/baselines          list (optional ?status=, ?keyPrefix=)
 *
 * Out of scope here: diff/gate computation lives in `baselineDiffer.ts`; MCP
 * read tools are `lookup_baseline` and `compare_baselines`. A future
 * trace-vs-baseline tool remains separate from this CRUD route.
 *
 * Construction is factory-style so tests can inject a fresh store
 * pointing at a tmp path — the production app entry calls
 * `createBaselineRoutes()` with no args and gets the default singleton.
 */

import {Router, type Router as ExpressRouter} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {BaselineStore} from '../services/baselineStore';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import type {BaselineRecord} from '../types/sparkContracts';
import {backendLogPath} from '../runtimePaths';

/** Default store lives under the backend log root next to the other
 * long-lived agent-state JSON files. */
let cachedStore: BaselineStore | null = null;
function getDefaultStore(): BaselineStore {
  if (!cachedStore) cachedStore = new BaselineStore(backendLogPath('baselines.json'));
  return cachedStore;
}

/** Test/factory hook — pass an explicit store, otherwise the default
 * singleton is used. Returns a fresh Express Router. */
export function createBaselineRoutes(store?: BaselineStore): ExpressRouter {
  const s = store ?? getDefaultStore();
  const router = Router();
  router.use(authenticate);

  /**
   * POST /api/baselines
   *
   * Body: a full `BaselineRecord`. The service-layer publish invariants
   * (sampleCount ≥ 3, redactionState='redacted' when key carries
   * identifiable info) surface as 400 with a descriptive `error`.
   */
  router.post('/', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const record = req.body as BaselineRecord | undefined;
    if (!record || typeof record !== 'object') {
      return res
        .status(400)
        .json({success: false, error: 'Body must be a BaselineRecord'});
    }
    if (!record.baselineId || !record.key || !record.status) {
      return res.status(400).json({
        success: false,
        error: 'baselineId, key, and status are required',
      });
    }
    try {
      s.addBaseline(record, scope);
      return res.status(201).json({success: true, baseline: record});
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** GET /api/baselines/:id */
  router.get('/:id', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const baseline = s.getBaseline(req.params.id, scope);
    if (!baseline) {
      return res
        .status(404)
        .json({success: false, error: `Baseline '${req.params.id}' not found`});
    }
    return res.json({success: true, baseline});
  });

  /** DELETE /api/baselines/:id */
  router.delete('/:id', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const id = req.params.id as string;
    const removed = s.removeBaseline(id, scope);
    if (!removed) {
      return res
        .status(404)
        .json({success: false, error: `Baseline '${id}' not found`});
    }
    return res.json({success: true});
  });

  /**
   * GET /api/baselines
   *
   * Query params (all optional):
   *   status     — restrict by status string (draft|reviewed|published|private)
   *   keyPrefix  — restrict by baselineId prefix, e.g. `appId/deviceId`
   */
  router.get('/', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const {status, keyPrefix} = req.query as {
      status?: string;
      keyPrefix?: string;
    };
    const list = s.listBaselines({
      status: status as BaselineRecord['status'] | undefined,
      keyPrefix,
    }, scope);
    return res.json({success: true, baselines: list, count: list.length});
  });

  return router;
}

/** Production-side default router. Keeps `app.use('/api/baselines',
 * baselineRoutes)` ergonomic in `index.ts`. */
const baselineRoutes = createBaselineRoutes();
export default baselineRoutes;
