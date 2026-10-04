// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Request, Response, NextFunction} from 'express';

import {requireRequestContext} from '../../middleware/auth';
import {hasRbacPermission, sendForbidden, type RbacPermission} from '../rbac';

export type CodebaseScope = Extract<RbacPermission, 'codebase:read' | 'codebase:manage' | 'codebase:admin'>;

export function requireCodebaseScope(scope: CodebaseScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const context = requireRequestContext(req);
    if (!hasRbacPermission(context, scope)) {
      sendForbidden(res, `${scope} permission is required`);
      return;
    }
    next();
  };
}

