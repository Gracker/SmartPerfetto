// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {
  type AgentRuntimeAnalysisResult,
  type Hypothesis,
  type IOrchestrator,
  type StreamingUpdate,
} from '../agent';
import { createAgentOrchestrator } from '../agentRuntime';
import { featureFlagsConfig } from '../config';
import {
  AssistantApplicationService,
  type ManagedAssistantSession,
} from '../assistant/application/assistantApplicationService';
import { StreamProjector } from '../assistant/stream/streamProjector';
import { createSessionLogger, type SessionLogger } from '../services/sessionLogger';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import { getSceneDeepDiveRoute } from '../agent/config/domainManifest';
import { SceneStoryService } from '../agent/scene/sceneStoryService';
import type { SceneReport } from '../agent/scene/types';
import { requireRequestContext } from '../middleware/auth';
import {
  isOwnedByContext,
  ownerFieldsFromContext,
  sendResourceNotFound,
} from '../services/resourceOwnership';
import { readTraceMetadataForContext } from '../services/traceMetadataStore';

export interface SceneReconstructConversationStep {
  eventId: string;
  ordinal: number;
  phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
  role: 'agent' | 'system';
  text: string;
  timestamp: number;
  sourceEventType?: string;
}

export interface SceneReconstructSession extends ManagedAssistantSession {
  orchestrator: IOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  traceId: string;
  query: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  logger: SessionLogger;
  result?: AgentRuntimeAnalysisResult;
  /** Set by SceneStoryService once the pipeline completes (fresh or cached). */
  sceneStoryReport?: SceneReport;
  hypotheses: Hypothesis[];
  scenes?: any[];
  trackEvents?: any[];
  agentDialogue: Array<{
    agentId: string;
    type: 'task' | 'response' | 'question';
    content: any;
    timestamp: number;
  }>;
  dataEnvelopes: any[];
  agentResponses: Array<{
    taskId: string;
    agentId: string;
    response: any;
    timestamp: number;
  }>;
  conversationOrdinal: number;
  conversationSteps: SceneReconstructConversationStep[];
}

async function ensureTraceAccessible(
  req: express.Request,
  res: express.Response,
  traceId: string,
): Promise<boolean> {
  if (!await readTraceMetadataForContext(traceId, requireRequestContext(req))) {
    sendResourceNotFound(res, 'Trace not found in backend');
    return false;
  }
  return true;
}

function getAuthorizedSceneSession<TSession extends SceneReconstructSession>(
  req: express.Request,
  res: express.Response,
  deps: RegisterSceneReconstructRoutesDeps<TSession>,
  analysisId: string,
): TSession | null {
  const session = deps.assistantAppService.getSession(analysisId);
  if (!session || !isOwnedByContext(session, requireRequestContext(req))) {
    sendResourceNotFound(res, 'Scene reconstruction session not found');
    return null;
  }
  return session;
}

interface RegisterSceneReconstructRoutesDeps<TSession extends SceneReconstructSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  streamProjector: StreamProjector;
  ensureToolsRegistered: () => void;
  /**
   * Legacy `/analyze`-style runner. Kept here for backward compatibility with
   * the keyword-triggered path; the primary `/scene-reconstruct` POST handler
   * now uses sceneStoryService.start() instead.
   */
  runAgentDrivenAnalysis: (
    sessionId: string,
    query: string,
    traceId: string,
    options?: any
  ) => Promise<void>;
  broadcastToAgentDrivenClients: (sessionId: string, update: StreamingUpdate) => void;
  sendAgentDrivenResult: (res: express.Response, session: TSession) => void;
  isSceneReplayOnlyQuery: (query: string) => boolean;
  buildSceneReplayNarrative: (scenes: any[]) => string;
  normalizeNarrativeForClient: (narrative: string) => string;
  /** Scene-specific pipeline. Replaces runAgentDrivenAnalysis for /scene-reconstruct. */
  sceneStoryService: SceneStoryService;
}

export function registerSceneReconstructRoutes<TSession extends SceneReconstructSession>(
  router: express.Router,
  deps: RegisterSceneReconstructRoutesDeps<TSession>
): void {
  router.use('/scene-reconstruct', (_req, res, next) => {
    if (!featureFlagsConfig.enableAgentSceneReconstruct) {
      return res.status(503).json({
        success: false,
        error: 'Scene reconstruction feature is disabled by FEATURE_AGENT_SCENE_RECONSTRUCT',
        code: 'FEATURE_DISABLED',
      });
    }
    next();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Preview — cheap cache lookup + cost estimate.
  //
  // Always returns within ~50ms when there's nothing on disk to hash, and
  // within seconds even for multi-GB traces (sha256 streaming). Never
  // starts the heavy pipeline; the response either contains a cached
  // SceneReport (so the client can short-circuit straight to "show me
  // this") or just an estimate the client can use to decide whether to
  // POST /scene-reconstruct.
  // ────────────────────────────────────────────────────────────────────────
  router.post('/scene-reconstruct/preview', async (req, res) => {
    try {
      const { traceId } = req.body ?? {};
      if (!traceId || typeof traceId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
      }

      if (!await ensureTraceAccessible(req, res, traceId)) {
        return;
      }

      // 404 fast if the trace isn't known to the backend, mirroring the
      // primary POST /scene-reconstruct handler so callers see a consistent
      // error shape.
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

      const preview = await deps.sceneStoryService.previewOnly({
        traceId,
        owner: ownerFieldsFromContext(requireRequestContext(req)),
      });

      return res.json({
        success: true,
        traceDurationSec: preview.traceDurationSec,
        estimate: preview.estimate,
        // Only include the cached report's identity here — the full body is
        // available via GET /report/:id so we don't bloat the preview
        // response with potentially-large payloads.
        cached: preview.cached
          ? {
              reportId: preview.cached.reportId,
              createdAt: preview.cached.createdAt,
              expiresAt: preview.cached.expiresAt,
              cachePolicy: preview.cached.cachePolicy,
              partialReport: preview.cached.partialReport,
              sceneCount: preview.cached.displayedScenes.length,
              jobCount: preview.cached.jobs.length,
            }
          : null,
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Scene reconstruction preview error:', error);
      return res.status(500).json({
        success: false,
        error: error?.message ?? 'Failed to compute scene reconstruction preview',
      });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET a previously persisted SceneReport by reportId.
  //
  // Returns the FULL SceneReport so the client can rebuild the entire UI
  // (lane overlays via cachedDataEnvelopes, scene list, jobs, summary).
  // 404s when the report has expired or never existed.
  // ────────────────────────────────────────────────────────────────────────
  router.get('/scene-reconstruct/report/:reportId', async (req, res) => {
    try {
      const { reportId } = req.params;
      const report = await deps.sceneStoryService.getReport(reportId);
      if (!report || !await readTraceMetadataForContext(report.traceId, requireRequestContext(req))) {
        return sendResourceNotFound(res, 'Report not found or expired');
      }
      return res.json({ success: true, report });
    } catch (error: any) {
      console.error('[AgentRoutes] getReport error:', error);
      return res.status(500).json({
        success: false,
        error: error?.message ?? 'Failed to load scene reconstruction report',
      });
    }
  });

  router.post('/scene-reconstruct', async (req, res) => {
    try {
      const { traceId, options = {} } = req.body;

      if (!traceId) {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
      }

      if (!await ensureTraceAccessible(req, res, traceId)) {
        return;
      }

      const traceProcessorService = getTraceProcessorService();
      // Fall back to disk restore so traces evicted from the in-memory registry
      // (but still on disk) don't produce spurious 404s on this endpoint.
      const trace = await traceProcessorService.getOrLoadTrace(traceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: 'Trace not found in backend',
          hint: 'Please upload the trace to the backend first',
          code: 'TRACE_NOT_UPLOADED',
        });
      }

      deps.ensureToolsRegistered();

      const deepAnalysis = false;
      const generateTracks = options.generateTracks ?? true;
      const query = deepAnalysis ? '场景还原' : '场景还原 仅检测';
      const analysisId = `scene-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const owner = ownerFieldsFromContext(requireRequestContext(req));

      const orchestrator: IOrchestrator = createAgentOrchestrator({
        traceProcessorService: getTraceProcessorService(),
      });

      const logger = createSessionLogger(analysisId);
      logger.setMetadata({ traceId, query, architecture: 'agent-driven', feature: 'scene-reconstruct' });
      logger.info('AgentRoutes', 'Scene reconstruction session created (agent-driven)', { options });

      const session = {
        orchestrator,
        sessionId: analysisId,
        sseClients: [],
        status: 'pending',
        traceId,
        query,
        ...owner,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        logger,
        hypotheses: [],
        agentDialogue: [],
        dataEnvelopes: [],
        agentResponses: [],
        scenes: [],
        trackEvents: [],
        conversationOrdinal: 0,
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        sseEventSeq: 0,
        sseEventBuffer: [],
      } as unknown as TSession;
      deps.assistantAppService.setSession(analysisId, session);

      // Drive scene reconstruction through the dedicated SceneStoryService
      // instead of runAgentDrivenAnalysis. The SkillExecutor is created
      // per-request because there's no module-level async init point in
      // this codebase for the skill registry.
      void (async () => {
        await ensureSkillRegistryInitialized();
        const skillExecutor = new SkillExecutor(traceProcessorService);
        skillExecutor.registerSkills(skillRegistry.getAllSkills());
        await deps.sceneStoryService.start({
          sessionId: analysisId,
          traceId,
          skillExecutor,
          owner,
          options: {
            forceRefresh: options.forceRefresh ?? false,
          },
        });
      })().catch((error) => {
        console.error(`[AgentRoutes] Scene reconstruction (story pipeline) error for ${analysisId}:`, error);
        const currentSession = deps.assistantAppService.getSession(analysisId);
        if (currentSession) {
          currentSession.logger.error('AgentRoutes', 'Scene reconstruction failed', error);
          currentSession.status = 'failed';
          currentSession.error = error.message;
          deps.broadcastToAgentDrivenClients(analysisId, {
            type: 'error',
            content: { message: error.message },
            timestamp: Date.now(),
          });
        }
      });
      // generateTracks is intentionally unused by the new pipeline; track
      // lanes flow through the existing `data` SSE events emitted by
      // SceneStoryService during Stage 1.
      void generateTracks;

      res.json({
        success: true,
        analysisId,
        sessionId: analysisId,
        architecture: 'agent-driven',
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Scene reconstruction start error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to start scene reconstruction',
      });
    }
  });

  router.get('/scene-reconstruct/:analysisId/stream', (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;

    deps.streamProjector.setSseHeaders(res);
    deps.streamProjector.sendConnected(res, {
      analysisId,
      sessionId: analysisId,
      status: session.status,
      traceId: session.traceId,
      query: session.query,
      architecture: 'agent-driven',
      timestamp: Date.now(),
    });

    // Replay buffered events BEFORE registering as live client — ensures events
    // broadcast before SSE connect (e.g., state_timeline) are delivered exactly once.
    // This matches the ordering in the primary agent SSE endpoint (agentRoutes.ts).
    const eventBuffer = (session as any).sseEventBuffer as Array<{seqId: number; eventType: string; eventData: string}> | undefined;
    const bufLen = eventBuffer?.length ?? 0;
    session.logger?.info('SSE', 'Scene SSE connect', { buffer: bufLen, sseClients: session.sseClients.length, status: session.status });
    if (eventBuffer && eventBuffer.length > 0) {
      const lastEventId = parseInt(req.headers['last-event-id'] as string, 10) || 0;
      const eventTypes = eventBuffer.map(e => e.eventType).join(',');
      session.logger?.info('SSE', 'Replaying buffer', { count: eventBuffer.length, lastEventId, eventTypes });
      const replayed = deps.streamProjector.replayBufferedEvents(res, eventBuffer, lastEventId);
      session.logger?.info('SSE', 'Replay complete', { replayed, total: eventBuffer.length });
    }

    deps.assistantAppService.addSseClient(analysisId, res);
    session.logger?.info('SSE', 'Client registered', {});

    // Late-connect terminal handling. Two paths:
    //  - Legacy agent-driven runs: session.result is set; send the legacy
    //    payload then close.
    //  - Scene Story runs (including cache hits): scene_story_report_ready
    //    is already in sseEventBuffer above, replayed for the late client.
    //    We just need to close the stream so the connection doesn't hang
    //    open forever waiting for events that already fired.
    const sceneStoryReport = session.sceneStoryReport;
    if (session.status === 'completed' && (session.result || sceneStoryReport)) {
      if (session.result) {
        deps.sendAgentDrivenResult(res, session);
      }
      deps.streamProjector.sendEnd(res);
      res.end();
      return;
    }

    if (session.status === 'failed') {
      deps.streamProjector.sendError(res, session.error);
      deps.streamProjector.sendEnd(res);
      res.end();
      return;
    }

    req.on('close', () => {
      console.log(`[AgentRoutes] Scene SSE client disconnected for ${analysisId}`);
      deps.assistantAppService.removeSseClient(analysisId, res);
    });

    deps.streamProjector.bindKeepAlive(req, res);
  });

  router.get('/scene-reconstruct/:analysisId/tracks', (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;

    if (session.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Analysis not yet completed',
        status: session.status,
      });
    }

    res.json({
      success: true,
      tracks: session.trackEvents || [],
      scenes: session.scenes || [],
    });
  });

  router.get('/scene-reconstruct/:analysisId/status', (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;

    const response: any = {
      success: true,
      analysisId,
      status: session.status,
    };

    // Two completion shapes — legacy agent-driven (session.result) and the
    // new Scene Story pipeline (session.sceneStoryReport). Surface whichever
    // is present so polling clients can see "done" for both flows.
    if (session.status === 'completed') {
      if (session.result) {
        const narrative = deps.isSceneReplayOnlyQuery(session.query)
          ? deps.buildSceneReplayNarrative(session.scenes || [])
          : deps.normalizeNarrativeForClient(session.result.conclusion);
        response.result = {
          narrative,
          confidence: session.result.confidence,
          executionTimeMs: session.result.totalDurationMs,
          scenesCount: session.scenes?.length || 0,
          tracksCount: session.trackEvents?.length || 0,
        };
      } else {
        const sceneStoryReport = session.sceneStoryReport;
        if (sceneStoryReport) {
          response.result = {
            reportId: sceneStoryReport.reportId,
            summary: sceneStoryReport.summary,
            scenesCount: sceneStoryReport.displayedScenes.length,
            jobCount: sceneStoryReport.jobs.length,
            partialReport: sceneStoryReport.partialReport,
            executionTimeMs: sceneStoryReport.totalDurationMs,
            cachePolicy: sceneStoryReport.cachePolicy,
          };
        }
      }
    }

    if (session.status === 'failed') {
      response.error = session.error;
    }

    res.json(response);
  });

  // Deep-dive: execute a skill scoped to a specific event.
  // Route resolution lives in domainManifest.sceneDeepDiveRoutes — see
  // getSceneDeepDiveRoute() for the lookup implementation.
  router.post('/scene-reconstruct/:analysisId/deep-dive', async (req, res) => {
    try {
      const { analysisId } = req.params;
      const { eventId, eventType, startTs, endTs, appPackage } = req.body;

      const session = getAuthorizedSceneSession(req, res, deps, analysisId);
      if (!session) return;

      const route = getSceneDeepDiveRoute(eventType);
      if (!route) {
        return res.status(400).json({
          success: false,
          error: `No deep-dive route for event type: ${eventType}`,
        });
      }

      await ensureSkillRegistryInitialized();
      const traceProcessorService = getTraceProcessorService();
      const skillExecutor = new SkillExecutor(traceProcessorService);
      skillExecutor.registerSkills(skillRegistry.getAllSkills());

      // Params built from the flat request body for now; the manifest's
      // paramMapping will start being exercised once the frontend sends
      // full scene context instead of {startTs,endTs,appPackage}.
      const params: Record<string, any> = {
        start_ts: startTs,
        end_ts: endTs,
      };
      if (appPackage) params.package = appPackage;

      const result = await skillExecutor.execute(route.skillId, session.traceId, params);

      res.json({
        success: true,
        eventId,
        skillId: route.skillId,
        description: route.description,
        result: result.displayResults,
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Deep-dive error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Deep-dive analysis failed',
      });
    }
  });

  // User-requested cancel for an in-flight Scene Story run. Distinct from
  // DELETE which tears down the whole session — cancel keeps the session
  // and any partial results so the frontend can render whatever jobs
  // already completed before the cancel landed.
  router.post('/scene-reconstruct/:analysisId/cancel', (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;
    const cancelled = deps.sceneStoryService.cancel(analysisId);
    res.json({
      success: true,
      cancelled,
      sessionStatus: session.status,
    });
  });

  router.delete('/scene-reconstruct/:analysisId', (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;

    session.sseClients.forEach((client) => {
      try {
        client.end();
      } catch {
        // Ignore closed sockets.
      }
    });

    session.orchestrator.reset();
    deps.assistantAppService.deleteSession(analysisId);

    res.json({ success: true });
  });
}
