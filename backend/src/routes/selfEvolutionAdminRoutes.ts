// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {
  getSelfEvolutionAdminService,
} from '../services/selfEvolution/selfEvolutionAdminRuntime';
import type {
  SelfEvolutionAdminService,
  SelfEvolutionOperationEvent,
} from '../services/selfEvolution/selfEvolutionAdminService';
import {
  hasRbacPermission,
  sendForbidden,
  type RbacPermission,
} from '../services/rbac';

function requirePermission(permission: RbacPermission): RequestHandler {
  return (req, res, next) => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, permission)) {
      sendForbidden(
        res,
        `Self-evolution route requires ${permission} permission`,
      );
      return;
    }
    next();
  };
}

function requestScope(req: Request): {
  tenantId: string;
  workspaceId: string;
} {
  const context = requireRequestContext(req);
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
  };
}

function requestActor(req: Request): {userId: string} {
  return {userId: requireRequestContext(req).userId};
}

function proposalId(req: Request): string {
  const value = routeParam(req.params.proposalId);
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(value)) {
    throw new Error('curation_proposal_not_found');
  }
  return value;
}

function routeParam(value: string | string[]): string {
  if (typeof value !== 'string') {
    throw new Error('self_evolution_route_parameter_invalid');
  }
  return value;
}

function actionId(req: Request): string {
  const value = req.body?.actionId;
  if (typeof value !== 'string') {
    throw new Error('self_evolution_action_id_invalid');
  }
  return value;
}

function sendSseEvent(
  response: Response,
  event: SelfEvolutionOperationEvent,
): void {
  response.write(`id: ${event.sequence}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function terminal(event: SelfEvolutionOperationEvent): boolean {
  return event.type === 'completed' || event.type === 'failed';
}

function sendError(response: Response, error: unknown): void {
  const rawCode = error instanceof Error
    ? error.message
    : 'self_evolution_request_failed';
  const code = /^[a-z0-9_:-]{1,160}$/.test(rawCode)
    ? rawCode
    : 'self_evolution_request_failed';
  const status = errorStatus(code);
  response.status(status).json({
    success: false,
    error: code,
  });
}

function errorStatus(code: string): number {
  if (
    code === 'self_evolution_operation_capacity_exceeded'
    || code === 'self_evolution_operation_scope_capacity_exceeded'
  ) {
    return 429;
  }
  if (
    code === 'curation_proposal_not_found'
    || code === 'self_evolution_operation_not_found'
  ) {
    return 404;
  }
  if (
    code === 'self_evolution_disabled'
    || code === 'self_evolution_apply_disabled'
    || code === 'self_evolution_persistence_unavailable'
  ) {
    return 503;
  }
  if (
    code.includes('not_eligible')
    || code.includes('not_gateable')
    || code.includes('revision_conflict')
    || code.includes('inconclusive')
    || code.includes('qualification_missing')
    || code.includes('runner_unavailable')
  ) {
    return 409;
  }
  if (
    code.includes('invalid')
    || code.includes('mismatch')
    || code.includes('required')
  ) {
    return 400;
  }
  return 500;
}

export function createSelfEvolutionAdminRoutes(
  service?: SelfEvolutionAdminService,
): Router {
  const router = Router();
  const resolveService = () => service ?? getSelfEvolutionAdminService();
  router.use(authenticate);

  router.get(
    '/overview',
    requirePermission('self_evolution:read'),
    (req, res) => {
      try {
        res.json(resolveService().overview(requestScope(req)));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(
    '/proposals',
    requirePermission('self_evolution:read'),
    (req, res) => {
      try {
        res.json({
          proposals: resolveService().listProposals(requestScope(req)),
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(
    '/proposals/:proposalId',
    requirePermission('self_evolution:read'),
    (req, res) => {
      try {
        res.json(resolveService().proposal(
          requestScope(req),
          proposalId(req),
        ));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/operations/curation',
    requirePermission('self_evolution:curate'),
    (req, res) => {
      try {
        res.status(202).json(
          resolveService().startCuration(requestScope(req)),
        );
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(
    '/operations/:operationId/events',
    requirePermission('self_evolution:curate'),
    (req, res) => {
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const scope = requestScope(req);
        const operationId = routeParam(req.params.operationId);
        const currentService = resolveService();
        unsubscribe = currentService.subscribe(
          scope,
          operationId,
          event => {
            sendSseEvent(res, event);
            if (terminal(event)) end();
          },
        );
        const snapshot = currentService.operation(scope, operationId);
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const end = () => {
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          if (!res.writableEnded) res.end();
        };
        for (const event of snapshot.events) sendSseEvent(res, event);
        if (snapshot.state !== 'running') {
          end();
          return;
        }
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': heartbeat\n\n');
        }, 15_000);
        heartbeat.unref();
        req.on('close', end);
      } catch (error) {
        if (res.headersSent) {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          if (!res.writableEnded) {
            sendSseEvent(res, {
              sequence: 0,
              type: 'failed',
              stage: 'failed',
              message: 'operation_stream_failed',
              errorCode: error instanceof Error
                ? error.message
                : 'self_evolution_request_failed',
              createdAt: Date.now(),
            });
            res.end();
          }
        } else {
          sendError(res, error);
        }
      }
    },
  );

  router.post(
    '/proposals/:proposalId/gate',
    requirePermission('self_evolution:curate'),
    async (req, res) => {
      try {
        res.json(await resolveService().gate(
          requestScope(req),
          proposalId(req),
          requestActor(req),
        ));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/proposals/:proposalId/accept',
    requirePermission('self_evolution:curate'),
    (req, res) => {
      try {
        res.json(resolveService().accept(
          requestScope(req),
          proposalId(req),
        ));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/proposals/:proposalId/reject',
    requirePermission('self_evolution:curate'),
    (req, res) => {
      try {
        res.json(resolveService().reject(
          requestScope(req),
          proposalId(req),
        ));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/proposals/:proposalId/export',
    requirePermission('self_evolution:export'),
    async (req, res) => {
      try {
        const artifact = await resolveService().exportContribution(
          requestScope(req),
          proposalId(req),
          requestActor(req),
        );
        res.json({
          artifactId: artifact.artifactId,
          proposalId: artifact.proposalId,
          archiveContentHash: artifact.archiveContentHash,
          contentHash: artifact.contentHash,
          deidentified: artifact.deidentified,
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/proposals/:proposalId/apply',
    requirePermission('self_evolution:apply'),
    async (req, res) => {
      try {
        res.json(await resolveService().apply(
          requestScope(req),
          proposalId(req),
          actionId(req),
          requestActor(req),
        ));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/proposals/:proposalId/revert',
    requirePermission('self_evolution:revert'),
    async (req, res) => {
      try {
        res.json(await resolveService().revert(
          requestScope(req),
          proposalId(req),
          actionId(req),
          requestActor(req),
        ));
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(
    '/overlays',
    requirePermission('self_evolution:read'),
    (req, res) => {
      try {
        res.json({
          overlays: resolveService().overlays(requestScope(req)),
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(
    '/reconciliation',
    requirePermission('self_evolution:read'),
    (req, res) => {
      try {
        res.json({
          report: resolveService().reconciliation(requestScope(req)),
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  return router;
}

export default createSelfEvolutionAdminRoutes();
