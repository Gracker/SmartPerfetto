// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * 分析模板 API 路由
 * 提供预定义的分析模板接口
 */

import express from 'express';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { AnalysisTemplateManager } from '../services/analysisTemplates/templateManager';

const router = express.Router();

/**
 * POST /api/template-analysis/auto
 * 自动选择并执行分析模板
 *
 * Body:
 * {
 *   traceId: string;
 *   question: string;
 * }
 */
router.post('/auto', async (req, res) => {
  try {
    const { traceId, question } = req.body;

    if (!traceId || !question) {
      return res.status(400).json({
        error: 'Missing required fields: traceId, question',
      });
    }

    const traceProcessor = getTraceProcessorService();
    const templateManager = new AnalysisTemplateManager(traceProcessor);

    const result = await templateManager.analyzeWithAutoTemplate({
      traceId,
      question,
    });

    if (!result) {
      return res.json({
        success: true,
        templateUsed: false,
        message: 'No suitable template found, use custom SQL instead',
      });
    }

    res.json({
      success: true,
      templateUsed: true,
      templateName: result.templateName,
      summary: result.summary,
      data: result.data,
    });
  } catch (error: any) {
    console.error('Template analysis error:', error);
    res.status(500).json({
      error: 'Template analysis failed',
      message: error.message,
    });
  }
});

/**
 * POST /api/template-analysis/four-quadrant
 * 执行四大象限分析
 *
 * Body:
 * {
 *   traceId: string;
 *   startTs?: number;
 *   endTs?: number;
 *   threadId?: number;
 * }
 */
router.post('/four-quadrant', async (req, res) => {
  try {
    const { traceId, startTs, endTs, threadId } = req.body;

    if (!traceId) {
      return res.status(400).json({
        error: 'Missing required field: traceId',
      });
    }

    const traceProcessor = getTraceProcessorService();
    const templateManager = new AnalysisTemplateManager(traceProcessor);

    const result = await (templateManager as any).fourQuadrantAnalyzer.analyze(
      traceId,
      startTs,
      endTs,
      threadId
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Four quadrant analysis error:', error);
    res.status(500).json({
      error: 'Four quadrant analysis failed',
      message: error.message,
    });
  }
});

/**
 * POST /api/template-analysis/cpu-core
 * 执行 CPU 核心分布分析
 *
 * Body:
 * {
 *   traceId: string;
 *   threadId: number;
 *   startTs?: number;
 *   endTs?: number;
 * }
 */
router.post('/cpu-core', async (req, res) => {
  try {
    const { traceId, threadId, startTs, endTs } = req.body;

    if (!traceId || !threadId) {
      return res.status(400).json({
        error: 'Missing required fields: traceId, threadId',
      });
    }

    const traceProcessor = getTraceProcessorService();
    const templateManager = new AnalysisTemplateManager(traceProcessor);

    const result = await (templateManager as any).cpuCoreAnalyzer.analyze(
      traceId,
      threadId,
      startTs,
      endTs
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('CPU core analysis error:', error);
    res.status(500).json({
      error: 'CPU core analysis failed',
      message: error.message,
    });
  }
});

/**
 * POST /api/template-analysis/frame-stats
 * 执行帧率统计分析
 *
 * Body:
 * {
 *   traceId: string;
 *   packageName?: string;
 *   startTs?: number;
 *   endTs?: number;
 * }
 */
router.post('/frame-stats', async (req, res) => {
  try {
    const { traceId, packageName, startTs, endTs } = req.body;

    if (!traceId) {
      return res.status(400).json({
        error: 'Missing required field: traceId',
      });
    }

    const traceProcessor = getTraceProcessorService();
    const templateManager = new AnalysisTemplateManager(traceProcessor);

    const result = await (templateManager as any).frameStatsAnalyzer.analyze(
      traceId,
      packageName,
      startTs,
      endTs
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Frame stats analysis error:', error);
    res.status(500).json({
      error: 'Frame stats analysis failed',
      message: error.message,
    });
  }
});

export default router;