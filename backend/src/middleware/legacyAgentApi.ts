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
