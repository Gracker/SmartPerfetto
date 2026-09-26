// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Request, Response } from 'express';
import { recordLegacyApiUsage } from '../services/legacyApiTelemetry';

export interface RemovedApiOptions {
  error: string;
  /** Successor for a path relative to the mount point, when one exists. */
  successorFor: (path: string) => string | undefined;
  /** Where to go when the path has no direct successor. */
  fallback: string;
}

/**
 * Answers every request under a removed API with 410. Unlike the deprecation
 * helpers in legacyAgentApi.ts there is no Sunset header: the removal has
 * already happened.
 */
export function rejectRemovedApi({ error, successorFor, fallback }: RemovedApiOptions) {
  return (req: Request, res: Response): void => {
    recordLegacyApiUsage(req);
    const successor = successorFor(req.path);
    res.setHeader('Deprecation', 'true');
    if (successor) {
      res.setHeader('Link', `<${successor}>; rel="successor-version"`);
    }
    res.status(410).json({
      success: false,
      error,
      message: successor
        ? `Please migrate this request to ${successor}`
        : `This endpoint has no direct successor; use ${fallback}`,
      migration: { successor: successor ?? null, fallback },
    });
  };
}

export const PERFETTO_SQL_SKILL_IDS: Readonly<Record<string, string>> = {
  '/startup': 'startup_analysis',
  '/scrolling': 'scrolling_analysis',
  '/memory': 'memory_analysis',
  '/cpu': 'cpu_analysis',
  '/binder': 'binder_analysis',
  '/surfaceflinger': 'surfaceflinger_analysis',
  '/navigation': 'navigation_analysis',
  '/click-response': 'click_response_analysis',
};

/**
 * `/api/perfetto-sql`: the scene endpoints map to the Skill that takes the same
 * `{traceId, packageName}` body. Matching is case-insensitive like the router
 * it replaces.
 */
export const rejectRemovedPerfettoSqlApi = rejectRemovedApi({
  error: 'Perfetto SQL API has been removed',
  successorFor: (path) => {
    const skillId = PERFETTO_SQL_SKILL_IDS[path.replace(/\/+$/, '').toLowerCase()];
    return skillId ? `/api/skills/execute/${skillId}` : undefined;
  },
  fallback: '/api/workspaces/:workspaceId/agent',
});
