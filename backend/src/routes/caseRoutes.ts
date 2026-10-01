// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Case Routes — admin surface for the Plan 54 case library + graph.
 *
 * Endpoints (all under `/api/cases`):
 *   GET    /                   list cases (filters: status, tag, level)
 *   POST   /                   save a case (rejects published; use /publish)
 *   GET    /:caseId            fetch one
 *   DELETE /:caseId            remove
 *   POST   /:caseId/publish    advance to published (double-control gate)
 *   POST   /:caseId/archive    drop trace artifact, keep metadata
 *   GET    /edges              list all edges
 *   POST   /edges              add or replace an edge
 *   GET    /edges/:caseId      get edges from this case (`?direction=in|out|both`)
 *   DELETE /edges/:edgeId      remove an edge
 *
 * Recall (`recall_similar_case`) lives on the MCP side. This route
 * is operator-side only.
 *
 * @module caseRoutes
 */

import {Router, type Router as ExpressRouter} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {CaseLibrary} from '../services/caseLibrary';
import {CaseGraph} from '../services/caseGraph';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import type {
  CaseEdge,
  CaseEducationalLevel,
  CaseNode,
  CurationStatus,
} from '../types/sparkContracts';
import {backendLogPath} from '../runtimePaths';
import {sendRouteError} from '../middleware/routeFailure';
import {KnowledgeCurationError} from '../services/knowledgeCurationError';

let cachedLibrary: CaseLibrary | null = null;
let cachedGraph: CaseGraph | null = null;
function getDefaultLibrary(): CaseLibrary {
  if (!cachedLibrary) cachedLibrary = new CaseLibrary(backendLogPath('case_library.json'));
  return cachedLibrary;
}
function getDefaultGraph(): CaseGraph {
  if (!cachedGraph) cachedGraph = new CaseGraph(backendLogPath('case_graph.json'));
  return cachedGraph;
}

/** Test/factory hook. Pass explicit stores; default singletons
 * point at `backend/logs/case_library.json` + `case_graph.json`. */
export function createCaseRoutes(
  library?: CaseLibrary,
  graph?: CaseGraph,
): ExpressRouter {
  const lib = library ?? getDefaultLibrary();
  const g = graph ?? getDefaultGraph();
  const router = Router();
  router.use(authenticate);

  // -------------------------------------------------------------------
  // Edge endpoints — registered BEFORE the `/:caseId` routes so the
  // literal "edges" path segment isn't captured as a caseId.
  // -------------------------------------------------------------------

  router.get('/edges', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const edges = g.listEdges(scope);
    res.json({success: true, edges, count: edges.length});
  });

  router.post('/edges', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const edge = req.body as CaseEdge | undefined;
    if (
      !edge ||
      !edge.edgeId ||
      !edge.fromCaseId ||
      !edge.toCaseId ||
      !edge.relation
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Body must be a CaseEdge with edgeId, fromCaseId, toCaseId, relation',
      });
    }
    try {
      g.addEdge(edge, scope);
      return res.status(201).json({success: true, edge});
    } catch (err) {
      return sendRouteError(res, err, {
        code: 'case_edge_save_failed',
        error: 'Failed to save case edge',
        logLabel: '[CaseRoutes] Edge save error',
      }, [KnowledgeCurationError]);
    }
  });

  router.get('/edges/:caseId', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const direction = (req.query.direction ?? 'both') as
      | 'in'
      | 'out'
      | 'both';
    const related = g.findRelated(req.params.caseId, {
      direction,
      knowledgeScope: scope,
    });
    res.json({success: true, related, count: related.length});
  });

  router.delete('/edges/:edgeId', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const removed = g.removeEdge(req.params.edgeId, scope);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Edge '${req.params.edgeId}' not found`,
      });
    }
    res.json({success: true});
  });

  // -------------------------------------------------------------------
  // Case endpoints
  // -------------------------------------------------------------------

  router.get('/', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const {status, tag, level} = req.query as {
      status?: string;
      tag?: string;
      level?: string;
    };
    const cases = lib.listCases({
      status: status as CurationStatus | undefined,
      anyOfTags: tag ? [tag] : undefined,
      educationalLevel: level as CaseEducationalLevel | undefined,
    }, scope);
    res.json({success: true, cases, count: cases.length});
  });

  router.post('/', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const c = req.body as CaseNode | undefined;
    if (!c || !c.caseId || !c.title || !c.status) {
      return res.status(400).json({
        success: false,
        error: 'Body must be a CaseNode with caseId, title, status',
      });
    }
    try {
      lib.saveCase(c, scope);
      return res.status(201).json({success: true, case: c});
    } catch (err) {
      return sendRouteError(res, err, {
        code: 'case_save_failed',
        error: 'Failed to save case',
        logLabel: '[CaseRoutes] Save error',
      }, [KnowledgeCurationError]);
    }
  });

  router.get('/:caseId', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const c = lib.getCase(req.params.caseId, scope);
    if (!c) {
      return res.status(404).json({
        success: false,
        error: `Case '${req.params.caseId}' not found`,
      });
    }
    res.json({success: true, case: c});
  });

  router.delete('/:caseId', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const removed = lib.removeCase(req.params.caseId, scope);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Case '${req.params.caseId}' not found`,
      });
    }
    res.json({success: true});
  });

  /** POST /api/cases/:caseId/publish — body `{reviewer}`. */
  router.post('/:caseId/publish', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const reviewer = (req.body?.reviewer ?? '') as string;
    try {
      const published = lib.publishCase(req.params.caseId, {reviewer}, scope);
      return res.json({success: true, case: published});
    } catch (err) {
      return sendRouteError(res, err, {
        code: 'case_publish_failed',
        error: 'Failed to publish case',
        logLabel: '[CaseRoutes] Publish error',
      }, [KnowledgeCurationError]);
    }
  });

  /** POST /api/cases/:caseId/archive — body `{reason}`. */
  router.post('/:caseId/archive', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const reason = (req.body?.reason ?? '') as string;
    try {
      const archived = lib.archiveCase(req.params.caseId, {reason}, scope);
      return res.json({success: true, case: archived});
    } catch (err) {
      return sendRouteError(res, err, {
        code: 'case_archive_failed',
        error: 'Failed to archive case',
        logLabel: '[CaseRoutes] Archive error',
      }, [KnowledgeCurationError]);
    }
  });

  return router;
}

const caseRoutes = createCaseRoutes();
export default caseRoutes;
