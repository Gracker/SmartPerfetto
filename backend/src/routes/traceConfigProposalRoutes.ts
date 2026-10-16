// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { requireRequestContext } from '../middleware/auth';
import { hasRbacPermission, sendForbidden } from '../services/rbac';
import { sendRouteError } from '../middleware/routeFailure';
import { buildTraceConfigProposal, TraceConfigProposalInputError } from '../services/traceConfigProposal';

const router = express.Router();

router.post('/proposals', (req, res) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'trace:write')) {
    sendForbidden(res, 'trace:write permission is required');
    return;
  }

  const request = readRequestText(req.body);
  if (!request) {
    res.status(400).json({
      success: false,
      error: 'request is required',
    });
    return;
  }

  try {
    const proposal = buildTraceConfigProposal({
      request,
      app: optionalString(req.body?.app),
      durationSeconds: optionalPositiveNumber(req.body?.durationSeconds),
      categories: optionalStringArray(req.body?.categories),
      cuj: optionalString(req.body?.cuj),
    });
    res.json({
      success: true,
      proposal,
    });
  } catch (error) {
    sendRouteError(res, error, {
      code: 'trace_config_proposal_failed',
      error: 'Failed to build the trace config proposal',
      logLabel: '[TraceConfigProposal] Build error',
    }, [TraceConfigProposalInputError]);
  }
});

function readRequestText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  return optionalString(record.request)
    ?? optionalString(record.query)
    ?? optionalString(record.prompt)
    ?? '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TraceConfigProposalInputError('durationSeconds must be a positive number');
  }
  return parsed;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TraceConfigProposalInputError('categories must be an array of strings');
  }
  return value;
}

export default router;
