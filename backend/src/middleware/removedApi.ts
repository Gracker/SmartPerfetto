// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { NextFunction, Request, Response } from 'express';
import { recordLegacyApiUsage } from '../services/legacyApiTelemetry';
import {
  AGENT_API_V1_BASE,
  LEGACY_AGENT_API_BASE,
  LEGACY_AGENT_API_SUNSET,
} from './legacyAgentApi';

export interface RemovedApiOptions {
  error: string;
  /** Successor for a request under the mount point; omit when none exists. */
  successorFor?: (req: Request) => string | undefined;
  /** Where to go when the request has no direct successor. */
  fallback: string;
  /** A path under the mount that is still served; such requests continue to the next handler. */
  servedPath?: (path: string) => boolean;
  /**
   * The headers of a deprecation announced before the removal, kept because
   * clients may still key on them. Without it there is no Sunset header: the
   * removal has already happened.
   */
  announcedDeprecation?: { sunset: string; warning: string; successorVersion: string };
  /** The response's `migration` object; defaults to `{successor, fallback}`. */
  migration?: (successor: string | undefined) => Record<string, unknown>;
}

/** Answers every request under a removed API with 410 and records it as legacy usage. */
export function rejectRemovedApi({
  error,
  successorFor,
  fallback,
  servedPath,
  announcedDeprecation,
  migration = (successor) => ({ successor: successor ?? null, fallback }),
}: RemovedApiOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (servedPath?.(req.path)) {
      next();
      return;
    }
    recordLegacyApiUsage(req);
    const successor = successorFor?.(req);
    const successorVersion = announcedDeprecation?.successorVersion ?? successor;
    res.setHeader('Deprecation', 'true');
    if (announcedDeprecation) {
      res.setHeader('Sunset', announcedDeprecation.sunset);
      res.setHeader('Warning', announcedDeprecation.warning);
    }
    if (successorVersion) {
      res.setHeader('Link', `<${successorVersion}>; rel="successor-version"`);
    }
    res.status(410).json({
      success: false,
      error,
      message: successor
        ? `Please migrate this request to ${successor}`
        : `This endpoint has no direct successor; use ${fallback}`,
      migration: migration(successor),
    });
  };
}

export const AGENT_API_FALLBACK = '/api/workspaces/:workspaceId/agent';

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
  successorFor: ({ path }) => {
    const skillId = PERFETTO_SQL_SKILL_IDS[path.replace(/\/+$/, '').toLowerCase()];
    return skillId ? `/api/skills/execute/${skillId}` : undefined;
  },
  fallback: AGENT_API_FALLBACK,
});

/**
 * `/api/sql`: `/tables` returned a fixed five-table excerpt instead of the
 * loaded trace's schema, and `/generate` matched a regex template or returned
 * a canned query without reading any trace. Neither has a route that takes the
 * same body, so every path falls back to the agent, which reads the real schema.
 */
export const rejectRemovedSqlApi = rejectRemovedApi({
  error: 'SQL generation API has been removed',
  fallback: AGENT_API_FALLBACK,
});

/** `/api/template-analysis`: no route takes the same bodies, so every path falls back to the agent. */
export const rejectRemovedTemplateAnalysisApi = rejectRemovedApi({
  error: 'Template analysis API has been removed',
  fallback: AGENT_API_FALLBACK,
});

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * `/api/sessions`: an unscoped store API that returned or deleted any
 * persisted session for any caller, whoever created it and whatever private
 * source or knowledge it read. The agent session routes are its owner-scoped
 * successors.
 */
export const rejectRemovedSessionsApi = rejectRemovedApi({
  error: 'Session API has been removed',
  successorFor: ({ path, method }) => {
    const segment = path.replace(/\/+$/, '').replace(/^\//, '');
    if (segment === '') return '/api/agent/v1/sessions';
    if (segment === 'export' || !SAFE_SESSION_ID_RE.test(segment)) return undefined;
    return method === 'DELETE' ? `/api/agent/v1/${segment}` : `/api/agent/v1/${segment}/turns`;
  },
  fallback: '/api/agent/v1/sessions',
});

function legacyAgentSuccessor(req: Request): string {
  const fullPath = String(req.originalUrl || req.url || '').split('?')[0] || LEGACY_AGENT_API_BASE;
  if (fullPath.startsWith(`${LEGACY_AGENT_API_BASE}/llm`)) return `${AGENT_API_V1_BASE}/analyze`;
  if (fullPath.startsWith(LEGACY_AGENT_API_BASE)) {
    return `${AGENT_API_V1_BASE}${fullPath.slice(LEGACY_AGENT_API_BASE.length)}`;
  }
  return AGENT_API_V1_BASE;
}

/**
 * The pre-v1 `/api/agent` base. It is mounted at the parent of the live
 * `/api/agent/v1` subtree, which passes through. Its deprecation was announced
 * with a Sunset date before removal, so those headers stay.
 */
export const rejectLegacyAgentApi = rejectRemovedApi({
  error: 'Legacy agent API has been removed',
  successorFor: legacyAgentSuccessor,
  fallback: AGENT_API_V1_BASE,
  servedPath: (path) => path === '/v1' || path.startsWith('/v1/'),
  announcedDeprecation: {
    sunset: LEGACY_AGENT_API_SUNSET,
    warning: '299 - "Legacy agent API has been removed. Use /api/agent/v1"',
    successorVersion: AGENT_API_V1_BASE,
  },
  migration: (successor) => ({
    successor,
    root: AGENT_API_V1_BASE,
    analyze: `${AGENT_API_V1_BASE}/analyze`,
  }),
});
