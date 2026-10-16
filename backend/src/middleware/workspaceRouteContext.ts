// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { NextFunction, Request, Response } from 'express';
import { getRequestContext } from './auth';
import { sanitizeContextId } from '../utils/contextId';
import { sendResourceNotFound } from '../services/resourceOwnership';

type WorkspaceScopedRequest = Request & {
  workspaceRouteContext?: {
    workspaceId: string;
  };
};

export function bindWorkspaceRouteContext(req: Request, res: Response, next: NextFunction): void {
  const workspaceId = sanitizeContextId(req.params.workspaceId);
  if (!workspaceId) {
    res.status(400).json({
      success: false,
      error: 'workspaceId is required',
    });
    return;
  }

  (req as WorkspaceScopedRequest).workspaceRouteContext = { workspaceId };
  req.headers['x-workspace-id'] = workspaceId;
  next();
}

export function requireWorkspaceRouteContext(req: Request, res: Response, next: NextFunction): void {
  const expectedWorkspaceId = (req as WorkspaceScopedRequest).workspaceRouteContext?.workspaceId;
  if (!expectedWorkspaceId) {
    res.status(400).json({
      success: false,
      error: 'workspace route context is missing',
    });
    return;
  }

  const context = getRequestContext(req);
  if (!context || context.workspaceId !== expectedWorkspaceId) {
    sendResourceNotFound(res);
    return;
  }

  next();
}
