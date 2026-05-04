// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {z} from 'zod';
import {summarizeCriticalPathWithAi} from '../services/criticalPathAiSummary';
import {analyzeCriticalPath, type CriticalPathAnalyzeOptions} from '../services/criticalPathAnalyzer';
import {getTraceProcessorService} from '../services/traceProcessorService';

const router = express.Router();
const traceProcessorService = getTraceProcessorService();

// Codex P1-5: this route does NOT pass through agentRoutes' explicit whitelist,
// so input validation has to live here. zod gives us a clamped, schema-checked
// option object — anything not declared here silently never reaches the runtime.
const intLike = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/, 'must be an integer string'),
]);

const AnalyzeBodySchema = z.object({
  threadStateId: intLike.optional(),
  utid: intLike.optional(),
  startTs: intLike.optional(),
  dur: intLike.optional(),
  endTs: intLike.optional(),
  maxSegments: z.number().int().min(20).max(1000).optional(),
  recursionDepth: z.number().int().min(0).max(2).optional(),
  recursionEnabled: z.boolean().optional(),
  segmentBudget: z.number().int().min(4).max(32).optional(),
  includeAi: z.boolean().optional(),
  question: z.string().max(500).optional(),
});

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function ensureTrace(traceId: string): Promise<boolean> {
  const trace = await traceProcessorService.getOrLoadTrace(traceId);
  return !!trace;
}

router.post('/:traceId/analyze', async (req, res) => {
  try {
    const {traceId} = req.params;
    if (!traceId) {
      return res.status(400).json({success: false, error: 'traceId is required'});
    }
    if (!(await ensureTrace(traceId))) {
      return res.status(404).json({success: false, error: `Trace ${traceId} not found`});
    }

    const parsed = AnalyzeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const body = parsed.data;
    const analyzeOptions: CriticalPathAnalyzeOptions = {
      threadStateId: body.threadStateId,
      utid: body.utid,
      startTs: body.startTs,
      dur: body.dur,
      endTs: body.endTs,
      maxSegments: body.maxSegments,
      recursionDepth: body.recursionDepth,
      recursionEnabled: body.recursionEnabled,
      segmentBudget: body.segmentBudget,
    };
    const analysis = await analyzeCriticalPath(traceProcessorService, traceId, analyzeOptions);
    const aiSummary =
      body.includeAi === false ? undefined : await summarizeCriticalPathWithAi(analysis, body.question);
    return res.json({success: true, analysis, aiSummary});
  } catch (error: unknown) {
    console.error('[CriticalPath] Analyze error:', error);
    return res.status(500).json({
      success: false,
      error: errorMessage(error, 'Critical path analysis failed'),
    });
  }
});

export default router;
