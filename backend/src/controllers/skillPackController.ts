// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Request, Response } from 'express';
import { requireRequestContext } from '../middleware/auth';
import { sendRouteError } from '../middleware/routeFailure';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { repositoryScopeFromRequestContext } from '../services/enterpriseRepository';
import { SkillPackInstallService } from '../services/skillPacks/skillPackInstallService';
import { previewSkillPack } from '../services/skillPacks/skillPackPreviewService';
import { SkillPackRepository } from '../services/skillPacks/skillPackRepository';
import { SkillPackRequestError } from '../services/skillPacks/skillPackRequestError';
import { invalidateWorkspaceSkillRegistry } from '../services/skillPacks/workspaceSkillRegistryProvider';

function sourcePathFromBody(req: Request): string | null {
  const body = req.body as { sourcePath?: unknown } | undefined;
  return typeof body?.sourcePath === 'string' && body.sourcePath.trim()
    ? body.sourcePath.trim()
    : null;
}

function paramString(req: Request, name: string): string | null {
  const value = req.params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Pack rejections (invalid or changed pack, unknown pack, workspace collision)
 * keep their reason; storage and post-install integrity failures get fixed text.
 */
function sendSkillPackError(res: Response, error: unknown, operation: string): void {
  sendRouteError(res, error, {
    code: 'skill_pack_operation_failed',
    error: 'Skill pack operation failed',
    logLabel: `[SkillPacks] ${operation} error`,
  }, [SkillPackRequestError]);
}

function createInstallService(db: ReturnType<typeof openEnterpriseDb>): SkillPackInstallService {
  return new SkillPackInstallService(
    new SkillPackRepository(db),
    { invalidate: invalidateWorkspaceSkillRegistry },
  );
}

export function createSkillPackController() {
  return {
    list(_req: Request, res: Response): void {
      const context = requireRequestContext(_req);
      const scope = repositoryScopeFromRequestContext(context);
      const db = openEnterpriseDb();
      try {
        const repository = new SkillPackRepository(db);
        res.json({ success: true, skillPacks: repository.list(scope) });
      } finally {
        db.close();
      }
    },

    async preview(req: Request, res: Response): Promise<void> {
      const sourcePath = sourcePathFromBody(req);
      if (!sourcePath) {
        res.status(400).json({ success: false, error: 'sourcePath is required' });
        return;
      }
      const preview = await previewSkillPack({ sourcePath });
      res.status(200).json({ success: preview.success, preview });
    },

    async install(req: Request, res: Response): Promise<void> {
      const context = requireRequestContext(req);
      const sourcePath = sourcePathFromBody(req);
      if (!sourcePath) {
        res.status(400).json({ success: false, error: 'sourcePath is required' });
        return;
      }
      const preview = await previewSkillPack({ sourcePath });
      if (!preview.success) {
        res.status(400).json({ success: false, preview });
        return;
      }
      const db = openEnterpriseDb();
      try {
        const service = createInstallService(db);
        const record = await service.installSkillPack(
          repositoryScopeFromRequestContext(context),
          context.userId ?? 'unknown',
          preview,
        );
        res.json({ success: true, skillPack: record });
      } catch (error) {
        sendSkillPackError(res, error, 'Install');
      } finally {
        db.close();
      }
    },

    async setEnabled(req: Request, res: Response): Promise<void> {
      const context = requireRequestContext(req);
      const body = req.body as { enabled?: unknown } | undefined;
      const packId = paramString(req, 'packId');
      if (!packId) {
        res.status(400).json({ success: false, error: 'packId is required' });
        return;
      }
      if (typeof body?.enabled !== 'boolean') {
        res.status(400).json({ success: false, error: 'enabled must be boolean' });
        return;
      }
      const db = openEnterpriseDb();
      try {
        const service = createInstallService(db);
        const record = await service.setSkillPackEnabled(
          repositoryScopeFromRequestContext(context),
          packId,
          body.enabled,
        );
        res.json({ success: true, skillPack: record });
      } catch (error) {
        sendSkillPackError(res, error, 'Enable');
      } finally {
        db.close();
      }
    },

    async remove(req: Request, res: Response): Promise<void> {
      const context = requireRequestContext(req);
      const packId = paramString(req, 'packId');
      if (!packId) {
        res.status(400).json({ success: false, error: 'packId is required' });
        return;
      }
      const db = openEnterpriseDb();
      try {
        const service = createInstallService(db);
        const record = await service.removeSkillPack(
          repositoryScopeFromRequestContext(context),
          packId,
        );
        res.json({ success: true, skillPack: record });
      } catch (error) {
        sendSkillPackError(res, error, 'Remove');
      } finally {
        db.close();
      }
    },
  };
}
