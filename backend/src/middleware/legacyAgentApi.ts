// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { NextFunction, Request, Response } from 'express';
import { recordLegacyApiUsage } from '../services/legacyApiTelemetry';

export const AGENT_API_V1_BASE = '/api/agent/v1';
export const LEGACY_AGENT_API_BASE = '/api/agent';
export const LEGACY_AGENT_API_SUNSET = 'Wed, 30 Jun 2027 00:00:00 GMT';

export function markLegacyApi(successor: string, message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    recordLegacyApiUsage(req);
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', LEGACY_AGENT_API_SUNSET);
    res.setHeader('Link', `<${successor}>; rel="successor-version"`);
    res.setHeader('Warning', `299 - "${message}"`);
    next();
  };
}

function mapLegacyPathToSuccessor(req: Request): string {
  const fullPath = String(req.originalUrl || req.url || '').split('?')[0] || LEGACY_AGENT_API_BASE;

  if (fullPath.startsWith('/api/agent/llm')) {
    return `${AGENT_API_V1_BASE}/analyze`;
  }

  if (fullPath.startsWith(LEGACY_AGENT_API_BASE)) {
    return `${AGENT_API_V1_BASE}${fullPath.slice(LEGACY_AGENT_API_BASE.length)}`;
  }

  return AGENT_API_V1_BASE;
}

export function rejectLegacyAgentApi(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/v1' || req.path.startsWith('/v1/')) {
    next();
    return;
  }

  recordLegacyApiUsage(req);

  const successorPath = mapLegacyPathToSuccessor(req);
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', LEGACY_AGENT_API_SUNSET);
  res.setHeader('Link', `<${AGENT_API_V1_BASE}>; rel="successor-version"`);
  res.setHeader('Warning', '299 - "Legacy agent API has been removed. Use /api/agent/v1"');

  res.status(410).json({
    success: false,
    error: 'Legacy agent API has been removed',
    message: `Please migrate this request to ${successorPath}`,
    migration: {
      successor: successorPath,
      root: AGENT_API_V1_BASE,
      analyze: `${AGENT_API_V1_BASE}/analyze`,
    },
  });
}
