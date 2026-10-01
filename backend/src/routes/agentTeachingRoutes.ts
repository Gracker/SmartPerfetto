// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {parseOutputLanguage} from '../agentv3/outputLanguage';
import { requireRequestContext } from '../middleware/auth';
import { sendResourceNotFound } from '../services/resourceOwnership';
import { RenderingPipelineTeachingService } from '../services/renderingPipelineTeachingService';
import {localizeTeachingPipelineResponse} from '../services/teachingLocalization';
import { readTraceMetadataForContext } from '../services/traceMetadataStore';
import { getTraceProcessorService } from '../services/traceProcessorService';

export function registerTeachingRoutes(router: express.Router): void {
  router.post('/teaching/pipeline', async (req, res) => {
    try {
      const {
        traceId,
        packageName,
        processName,
        selectionContext,
        visibleWindow,
        startTs,
        endTs,
        outputLanguage,
      } = req.body;
      const resolvedOutputLanguage = parseOutputLanguage(
        outputLanguage ||
        req.header('accept-language') ||
        process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
      );

      if (!traceId) {
        return res.status(400).json({
          success: false,
          error: resolvedOutputLanguage === 'en'
            ? 'traceId is required'
            : '必须提供 traceId',
        });
      }

      if (!await readTraceMetadataForContext(traceId, requireRequestContext(req))) {
        return sendResourceNotFound(
          res,
          resolvedOutputLanguage === 'en'
            ? 'Trace not found in backend'
            : '后端未找到该 Trace',
        );
      }

      const traceProcessorService = getTraceProcessorService();
      const trace = traceProcessorService.getTrace(traceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: resolvedOutputLanguage === 'en'
            ? 'Trace not found in backend'
            : '后端未找到该 Trace',
          hint: resolvedOutputLanguage === 'en'
            ? 'Upload the trace to the backend first'
            : '请先将 Trace 上传到后端',
          code: 'TRACE_NOT_UPLOADED',
        });
      }

      console.log(`[AgentRoutes] Teaching pipeline request for trace: ${traceId}`);
      const service = new RenderingPipelineTeachingService(traceProcessorService);
      const response = await service.analyze({
        traceId,
        packageName,
        processName,
        selectionContext,
        visibleWindow,
        startTs,
        endTs,
      });

      console.log(
        `[AgentRoutes] Teaching pipeline detected: ${response.detection.primaryPipelineId} ` +
        `(${(response.detection.primaryConfidence * 100).toFixed(1)}%), ` +
        `${response.observedFlow?.events.length || 0} observed events`
      );
      res.json(
        localizeTeachingPipelineResponse(response, resolvedOutputLanguage),
      );
    } catch (error: any) {
      console.error('[AgentRoutes] Teaching pipeline error:', error);
      res.status(500).json({
        success: false,
        error:
          error.message ||
          (parseOutputLanguage(
            req.body?.outputLanguage ||
            req.header('accept-language') ||
            process.env.SMARTPERFETTO_OUTPUT_LANGUAGE,
          ) === 'en'
            ? 'Failed to detect pipeline'
            : '渲染管线检测失败'),
      });
    }
  });
}
