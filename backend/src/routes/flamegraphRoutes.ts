// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import { summarizeFlamegraphWithAi } from '../services/flamegraphAiSummary';
import { analyzeFlamegraph, getFlamegraphAvailability } from '../services/flamegraphAnalyzer';
import type { FlamegraphAnalysis, FlamegraphAnalyzeOptions } from '../services/flamegraphTypes';
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

router.get('/:traceId/availability', async (req, res) => {
  try {
    const { traceId } = req.params;
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'traceId is required' });
    }
    if (!(await ensureTrace(traceId))) {
      return res.status(404).json({ success: false, error: `Trace ${traceId} not found` });
    }

    const availability = await getFlamegraphAvailability(traceProcessorService, traceId);
    res.json({ success: true, ...availability });
  } catch (error: unknown) {
    console.error('[Flamegraph] Availability error:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error, 'Failed to check flamegraph availability'),
    });
  }
});

router.post('/:traceId/analyze', async (req, res) => {
  try {
    const { traceId } = req.params;
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'traceId is required' });
    }
    if (!(await ensureTrace(traceId))) {
      return res.status(404).json({ success: false, error: `Trace ${traceId} not found` });
    }

    const options = (req.body || {}) as FlamegraphAnalyzeOptions;
    const analysis = await analyzeFlamegraph(traceProcessorService, traceId, options);
    const aiSummary =
      options.includeAi === false ? undefined : await summarizeFlamegraphWithAi(analysis, options.question);

    res.json({
      success: true,
      analysis,
      aiSummary,
    });
  } catch (error: unknown) {
    console.error('[Flamegraph] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error, 'Flamegraph analysis failed'),
    });
  }
});

router.post('/:traceId/summarize', async (req, res) => {
  try {
    const { traceId } = req.params;
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'traceId is required' });
    }

    const body = req.body || {};
    const analysis = body.analysis as FlamegraphAnalysis | undefined;
    if (!analysis) {
      if (!(await ensureTrace(traceId))) {
        return res.status(404).json({ success: false, error: `Trace ${traceId} not found` });
      }
      const generatedAnalysis = await analyzeFlamegraph(traceProcessorService, traceId, {
        ...(body.options || {}),
        includeAi: false,
      });
      const aiSummary = await summarizeFlamegraphWithAi(generatedAnalysis, body.question);
      return res.json({ success: true, analysis: generatedAnalysis, aiSummary });
    }

    const aiSummary = await summarizeFlamegraphWithAi(analysis, body.question);
    res.json({ success: true, aiSummary });
  } catch (error: unknown) {
    console.error('[Flamegraph] Summarize error:', error);
    res.status(500).json({
      success: false,
      error: errorMessage(error, 'Flamegraph summarization failed'),
    });
  }
});

export default router;
