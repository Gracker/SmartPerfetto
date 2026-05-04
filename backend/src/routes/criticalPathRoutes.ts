// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { summarizeCriticalPathWithAi } from '../services/criticalPathAiSummary';
import { analyzeCriticalPath, type CriticalPathAnalyzeOptions } from '../services/criticalPathAnalyzer';
import { getTraceProcessorService } from '../services/traceProcessorService';

const router = express.Router();
const traceProcessorService = getTraceProcessorService();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function ensureTrace(traceId: string): Promise<boolean> {
  const trace = await traceProcessorService.getOrLoadTrace(traceId);
  return !!trace;
}

router.post('/:traceId/analyze', async (req, res) => {
  try {
    const { traceId } = req.params;
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'traceId is required' });
    }
    if (!(await ensureTrace(traceId))) {
      return res.status(404).json({ success: false, error: `Trace ${traceId} not found` });
    }

    const options = (req.body || {}) as CriticalPathAnalyzeOptions & {
      includeAi?: boolean;
      question?: string;
    };
    const analysis = await analyzeCriticalPath(
      traceProcessorService,
      traceId,
      options
    );
    const aiSummary =
      options.includeAi === false ? undefined : await summarizeCriticalPathWithAi(analysis, options.question);
    res.json({ success: true, analysis, aiSummary });
  } catch (error: unknown) {
    console.error('[CriticalPath] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error, 'Critical path analysis failed'),
    });
  }
});

export default router;
