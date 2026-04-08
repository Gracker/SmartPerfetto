// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {
  type AgentRuntimeAnalysisResult,
  createAgentRuntime,
  type Hypothesis,
  type IOrchestrator,
  type ModelRouter,
  type StreamingUpdate,
} from '../agent';
import { isClaudeCodeEnabled, createClaudeRuntime } from '../agentv3';
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
  logger: SessionLogger;
  result?: AgentRuntimeAnalysisResult;
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

interface RegisterSceneReconstructRoutesDeps<TSession extends SceneReconstructSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  streamProjector: StreamProjector;
  ensureToolsRegistered: () => void;
  getModelRouter: () => ModelRouter;
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

  router.post('/scene-reconstruct', async (req, res) => {
    try {
      const { traceId, options = {} } = req.body;

      if (!traceId) {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
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

      const orchestrator: IOrchestrator = isClaudeCodeEnabled()
        ? createClaudeRuntime(getTraceProcessorService())
        : createAgentRuntime(deps.getModelRouter(), {
            maxRounds: options.maxRounds ?? options.maxIterations ?? 5,
            maxConcurrentTasks: options.maxConcurrentTasks || 3,
            confidenceThreshold: options.confidenceThreshold ?? options.qualityThreshold ?? 0.7,
            maxNoProgressRounds: options.maxNoProgressRounds ?? 2,
            maxFailureRounds: options.maxFailureRounds ?? 2,
            enableLogging: true,
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
    const session = deps.assistantAppService.getSession(analysisId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Scene reconstruction session not found',
      });
    }

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

    if (session.status === 'completed' && session.result) {
      deps.sendAgentDrivenResult(res, session);
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
    const session = deps.assistantAppService.getSession(analysisId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Scene reconstruction session not found',
      });
    }

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
    const session = deps.assistantAppService.getSession(analysisId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Scene reconstruction session not found',
      });
    }

    const response: any = {
      success: true,
      analysisId,
      status: session.status,
    };

    if (session.status === 'completed' && session.result) {
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

      const session = deps.assistantAppService.getSession(analysisId);
      if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

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
    const session = deps.assistantAppService.getSession(analysisId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Scene reconstruction session not found',
      });
    }
    const cancelled = deps.sceneStoryService.cancel(analysisId);
    res.json({
      success: true,
      cancelled,
      sessionStatus: session.status,
    });
  });

  router.delete('/scene-reconstruct/:analysisId', (req, res) => {
    const { analysisId } = req.params;
    const session = deps.assistantAppService.getSession(analysisId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Scene reconstruction session not found',
      });
    }

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