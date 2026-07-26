// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {Router} from 'express';
import {requireRequestContext} from '../middleware/auth';
import {
  getApplicationUpdateService,
  type ApplicationUpdateService,
} from '../services/applicationUpdate/applicationUpdateService';
import {resolveApplicationBuildIdentity} from '../services/applicationUpdate/buildIdentity';
import type {ApplicationBuildIdentity} from '../services/applicationUpdate/types';
import {hasRbacPermission, sendForbidden} from '../services/rbac';

export interface ApplicationUpdateRoutesOptions {
  identity?: ApplicationBuildIdentity;
  service?: Pick<ApplicationUpdateService, 'getStatus' | 'checkNow'>;
}

export function createApplicationUpdateRoutes(
  options: ApplicationUpdateRoutesOptions = {},
): Router {
  const router = Router();
  const service = options.service ?? getApplicationUpdateService();
  const identity = options.identity ?? resolveApplicationBuildIdentity();

  router.use((req, res, next) => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, 'runtime:manage')) {
      sendForbidden(
        res,
        'Application update checks require runtime:manage permission',
      );
      return;
    }
    next();
  });

  router.get('/status', (_req, res) => {
    res.json(service.getStatus(identity));
  });
  router.post('/check', async (_req, res, next) => {
    try {
      res.json(await service.checkNow(identity, {force: true}));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export default createApplicationUpdateRoutes();
