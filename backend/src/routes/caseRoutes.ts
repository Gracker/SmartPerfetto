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

import {Router, type NextFunction, type Request, type Response, type Router as ExpressRouter} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {CaseLibrary} from '../services/caseLibrary';
import {CaseGraph} from '../services/caseGraph';
import {caseCurationGrantForRequest} from '../services/security/caseCuration';
import {knowledgeScopeFromRequestContext} from '../services/scopedKnowledgeStore';
import type {
  CaseEdge,
  CaseEducationalLevel,
  CaseNode,
  CurationStatus,
} from '../types/sparkContracts';
import {backendLogPath} from '../runtimePaths';

let cachedLibrary: CaseLibrary | null = null;
let cachedGraph: CaseGraph | null = null;
function getDefaultLibrary(): CaseLibrary {
  if (!cachedLibrary) cachedLibrary = new CaseLibrary(backendLogPath('case_library.json'));
  return cachedLibrary;
}
function getDefaultGraph(): CaseGraph {
  if (!cachedGraph) cachedGraph = new CaseGraph(backendLogPath('case_graph.json'), getDefaultLibrary());
  return cachedGraph;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cases and their edges reach other users' analyses (background, recall,
 * report recommendations): reading them needs a login, and every other method
 * is curation. Guarding by method keeps a write route added later closed.
 */
function requireCurationForWrites(req: Request, res: Response, next: NextFunction): void {
  if (READ_METHODS.has(req.method) || hasRbacPermission(requireRequestContext(req), 'self_evolution:curate')) {
    next();
    return;
  }
  sendForbidden(res, 'Case curation requires self_evolution:curate permission');
}

/**
 * Test/factory hook. Pass explicit stores; default singletons point at
 * `backend/logs/case_library.json` + `case_graph.json`. Every case these
 * routes return says whether analyses read it and who last vouched for it
 * (`security/caseCuration.ts`).
 */
export function createCaseRoutes(
  library?: CaseLibrary,
  graph?: CaseGraph,
): ExpressRouter {
  const lib = library ?? getDefaultLibrary();
  // A graph made here reads its retired cases from the library these routes serve.
  const g = graph ?? (library ? new CaseGraph(backendLogPath('case_graph.json'), library) : getDefaultGraph());
  const router = Router();
  router.use(authenticate);
  router.use(requireCurationForWrites);

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
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
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
    const cases = lib.listCasesForCuration({
      status: status as CurationStatus | undefined,
      anyOfTags: tag ? [tag] : undefined,
      educationalLevel: level as CaseEducationalLevel | undefined,
    }, scope);
    res.json({success: true, cases, count: cases.length});
  });

  router.post('/', (req, res) => {
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    const body = req.body as CaseNode | undefined;
    if (!body || !body.caseId || !body.title || !body.status) {
      return res.status(400).json({
        success: false,
        error: 'Body must be a CaseNode with caseId, title, status',
      });
    }
    try {
      // The curator is whoever is signed in, never a name the body supplies.
      const saved = lib.saveCase(body, caseCurationGrantForRequest(context), scope);
      return res.status(201).json({success: true, case: saved});
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/:caseId', (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const c = lib.getCaseForCuration(req.params.caseId, scope);
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
    if (lib.retiredCaseIds(scope).has(req.params.caseId)) g.removeEdgesTouching(req.params.caseId, scope);
    const removed = lib.removeCase(req.params.caseId, scope);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Case '${req.params.caseId}' not found`,
      });
    }
    res.json({success: true});
  });

  /**
   * POST /api/cases/:caseId/publish — the signed-in curator is the reviewer
   * and attests the case's current content.
   */
  router.post('/:caseId/publish', (req, res) => {
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    try {
      const published = lib.publishCase(req.params.caseId, {}, caseCurationGrantForRequest(context), scope);
      return res.json({success: true, case: published});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found/.test(msg) ? 404 : 400;
      return res.status(status).json({success: false, error: msg});
    }
  });

  /** POST /api/cases/:caseId/archive — body `{reason}`; never makes analyses read a case they did not. */
  router.post('/:caseId/archive', (req, res) => {
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    const reason = (req.body?.reason ?? '') as string;
    try {
      const archived = lib.archiveCase(req.params.caseId, {reason}, caseCurationGrantForRequest(context), scope);
      return res.json({success: true, case: archived});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /not found/.test(msg) ? 404 : 400;
      return res.status(status).json({success: false, error: msg});
    }
  });

  return router;
}

const caseRoutes = createCaseRoutes();
export default caseRoutes;
