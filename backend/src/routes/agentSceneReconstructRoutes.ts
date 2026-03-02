import express from 'express';
import {
  type AgentRuntime,
  type AgentRuntimeAnalysisResult,
  createAgentRuntime,
  type Hypothesis,
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
  orchestrator: AgentRuntime;
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
      const trace = traceProcessorService.getTrace(traceId);
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

      const orchestrator = isClaudeCodeEnabled()
        ? createClaudeRuntime(getTraceProcessorService()) as unknown as AgentRuntime
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
      } as unknown as TSession;
      deps.assistantAppService.setSession(analysisId, session);

      deps.runAgentDrivenAnalysis(analysisId, query, traceId, {
        ...options,
        generateTracks,
        traceProcessorService,
      }).catch((error) => {
        console.error(`[AgentRoutes] Scene reconstruction (agent-driven) error for ${analysisId}:`, error);
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

    deps.assistantAppService.addSseClient(analysisId, res);
    console.log(`[AgentRoutes] Scene SSE client connected for ${analysisId}`);

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
