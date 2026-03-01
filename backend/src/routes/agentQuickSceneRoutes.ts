import express from 'express';
import { getTraceProcessorService, type TraceProcessorService } from '../services/traceProcessorService';

type DetectScenesQuickFn = (
  traceProcessorService: TraceProcessorService,
  traceId: string
) => Promise<any[]>;

export interface AgentQuickSceneRoutesDeps {
  detectScenesQuick: DetectScenesQuickFn;
}

export function registerAgentQuickSceneRoutes(
  router: express.Router,
  deps: AgentQuickSceneRoutesDeps
): void {
  router.post('/scene-detect-quick', async (req, res) => {
    try {
      const { traceId } = req.body;

      if (!traceId) {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
      }

      const traceProcessorService = getTraceProcessorService();
      const trace = await traceProcessorService.getOrLoadTrace(traceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: 'Trace not found in backend',
          hint: 'Please upload the trace to the backend first',
          code: 'TRACE_NOT_UPLOADED',
        });
      }

      console.log('[AgentRoutes] Quick scene detection for traceId:', traceId);
      const scenes = await deps.detectScenesQuick(traceProcessorService, traceId);
      console.log('[AgentRoutes] Quick scene detection complete:', scenes.length, 'scenes');

      return res.json({
        success: true,
        scenes,
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Quick scene detection error:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Quick scene detection failed',
      });
    }
  });
}
