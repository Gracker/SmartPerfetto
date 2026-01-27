/**
 * Agent Analysis Routes
 *
 * API endpoints for Agent-based trace analysis using the agent-driven architecture
 */

import express from 'express';
import { getTraceProcessorService } from '../services/traceProcessorService';
import {
  createSessionLogger,
  getSessionLoggerManager,
  SessionLogger,
} from '../services/sessionLogger';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import { reportStore } from './reportRoutes';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import {
  registerCoreTools,
  StreamingUpdate,
  // Scene reconstruction (separate feature)
  createLLMClient,
  createSceneReconstructionAgent,
  SceneReconstructionResult,
  DetectedScene,
  TrackEvent,
  // Agent-Driven Architecture (Phase 2-4)
  AgentDrivenOrchestrator,
  createAgentDrivenOrchestrator,
  AgentDrivenAnalysisResult,
  ModelRouter,
  Hypothesis,
} from '../agent';
// DataEnvelope types for v2.0 data contract
import {
  generateEventId,
  isDataEvent,
  isLegacySkillEvent,
  validateDataEnvelope,
} from '../types/dataContract';
// Pipeline Teaching Services
import { getPipelineDocService } from '../services/pipelineDocService';
import {
  ensurePipelineSkillsInitialized,
  pipelineSkillLoader,
  PinInstruction,
} from '../services/pipelineSkillLoader';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';

const router = express.Router();

// ============================================================================
// Session Tracking (Agent-Driven)
// ============================================================================

interface AnalysisSession {
  orchestrator: AgentDrivenOrchestrator;
  sessionId: string;
  sseClients: express.Response[];
  result?: AgentDrivenAnalysisResult;
  status: 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed';
  error?: string;
  traceId: string;
  query: string;
  createdAt: number;
  logger: SessionLogger;
  hypotheses: Hypothesis[];
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
}
const sessions = new Map<string, AnalysisSession>();

// ModelRouter instance for agent-driven orchestrator
let modelRouterInstance: ModelRouter | null = null;

function getModelRouter(): ModelRouter {
  if (!modelRouterInstance) {
    modelRouterInstance = new ModelRouter();
  }
  return modelRouterInstance;
}

// Scene Reconstruction Sessions (separate feature)
interface SceneReconstructionSession {
  agent: ReturnType<typeof createSceneReconstructionAgent>;
  sseClients: express.Response[];
  result?: SceneReconstructionResult;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  scenes?: DetectedScene[];
  trackEvents?: TrackEvent[];
}

const sceneReconstructionSessions = new Map<string, SceneReconstructionSession>();

// Initialize Agent tools once
let toolsRegistered = false;

function ensureToolsRegistered() {
  if (!toolsRegistered) {
    registerCoreTools();
    toolsRegistered = true;
    console.log('[AgentRoutes] Core tools registered');
  }
}

// ============================================================================
// Main Analysis Endpoints
// ============================================================================

/**
 * POST /api/agent/analyze
 *
 * Start analysis using AgentDrivenOrchestrator
 *
 * Features:
 * - Agent-driven task graph planning
 * - Domain agent evidence collection
 * - Multi-round analysis with strategy planning
 * - DataEnvelope streaming
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "query": "分析这个 trace 的滑动性能",
 *   "options": {
 *     "maxRounds": 5,
 *     "confidenceThreshold": 0.7,
 *     "maxNoProgressRounds": 2,
 *     "maxFailureRounds": 2,
 *     "maxConcurrentTasks": 3
 *   }
 * }
 */
router.post('/analyze', async (req, res) => {
  try {
    const { traceId, query, sessionId: requestedSessionId, options = {} } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'query is required',
      });
    }

    // Verify trace exists
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

    // Initialize tools
    ensureToolsRegistered();

    // Check if we can reuse an existing session (multi-turn dialogue support)
    let sessionId: string;
    let orchestrator: AgentDrivenOrchestrator;
    let logger: ReturnType<typeof createSessionLogger>;
    let isNewSession = true;

    if (requestedSessionId) {
      const existingSession = sessions.get(requestedSessionId);
      if (existingSession && existingSession.traceId === traceId) {
        sessionId = requestedSessionId;
        orchestrator = existingSession.orchestrator;
        logger = existingSession.logger;
        isNewSession = false;
        logger.info('AgentRoutes', 'Continuing multi-turn dialogue', {
          turnQuery: query,
          previousQuery: existingSession.query,
        });
        existingSession.query = query;
        existingSession.status = 'pending';
        console.log(`[AgentRoutes] Reusing agent session ${sessionId} for multi-turn dialogue`);
      } else {
        console.log(`[AgentRoutes] Requested session ${requestedSessionId} not found or trace mismatch, creating new session`);
        sessionId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
      }
    } else {
      sessionId = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    }

    if (isNewSession) {
      const modelRouter = getModelRouter();
      orchestrator = createAgentDrivenOrchestrator(modelRouter, {
        maxRounds: options.maxRounds ?? options.maxIterations ?? 5,
        maxConcurrentTasks: options.maxConcurrentTasks || 3,
        confidenceThreshold: options.confidenceThreshold ?? options.qualityThreshold ?? 0.7,
        maxNoProgressRounds: options.maxNoProgressRounds ?? 2,
        maxFailureRounds: options.maxFailureRounds ?? 2,
        enableLogging: true,
      });

      logger = createSessionLogger(sessionId);
      logger.setMetadata({ traceId, query, architecture: 'agent-driven' });
      logger.info('AgentRoutes', 'Agent-driven analysis session created', { options });

      sessions.set(sessionId, {
        orchestrator,
        sessionId,
        sseClients: [],
        status: 'pending',
        traceId,
        query,
        createdAt: Date.now(),
        logger,
        hypotheses: [],
        agentDialogue: [],
        dataEnvelopes: [],
        agentResponses: [],
      });
    }

    runAgentDrivenAnalysis(sessionId, query, traceId, { ...options, traceProcessorService }).catch((error) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.logger.error('AgentRoutes', 'Agent-driven analysis failed', error);
        session.status = 'failed';
        session.error = error.message;
        broadcastToAgentDrivenClients(sessionId, {
          type: 'error',
          content: { message: error.message },
          timestamp: Date.now(),
        });
      }
    });

    res.json({
      success: true,
      sessionId,
      message: isNewSession ? 'Analysis started' : 'Continuing analysis (multi-turn)',
      isNewSession,
      architecture: 'agent-driven',
    });
  } catch (error: any) {
    console.error('[AgentRoutes] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Agent analysis failed',
    });
  }
});

/**
 * GET /api/agent/:sessionId/stream
 *
 * SSE endpoint for real-time analysis updates
 *
 * Events:
 * - connected: SSE connection established
 * - progress: Progress updates (task graph, rounds, strategy)
 * - data: DataEnvelope(s) from skill execution
 * - agent_task_dispatched: Task sent to domain agent
 * - agent_response: Agent completed task
 * - synthesis_complete: Feedback synthesis complete
 * - strategy_decision: Next iteration strategy decided
 * - analysis_completed: Final analysis result
 * - error: Error occurred
 * - end: Stream ended
 */
router.get('/:sessionId/stream', (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection message
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({
    sessionId,
    status: session.status,
    traceId: session.traceId,
    query: session.query,
    architecture: 'agent-driven',
    timestamp: Date.now(),
  })}\n\n`);

  // Add client to session
  session.sseClients.push(res);
  console.log(`[AgentRoutes] SSE client connected for ${sessionId}`);

  // If analysis is already completed, send the result
  if (session.status === 'completed' && session.result) {
    sendAgentDrivenResult(res, session);
    res.write(`event: end\n`);
    res.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    res.end();
    return;
  }

  // If analysis failed, send error
  if (session.status === 'failed') {
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: session.error, timestamp: Date.now() })}\n\n`);
    res.write(`event: end\n`);
    res.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    res.end();
    return;
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[AgentRoutes] SSE client disconnected for ${sessionId}`);
    const idx = session.sseClients.indexOf(res);
    if (idx !== -1) {
      session.sseClients.splice(idx, 1);
    }
  });

  // Keep-alive ping
  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/**
 * GET /api/agent/:sessionId/status
 *
 * Get analysis status (for polling)
 */
router.get('/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const response: any = {
    success: true,
    sessionId,
    status: session.status,
    traceId: session.traceId,
    query: session.query,
    createdAt: session.createdAt,
  };

  if (session.status === 'completed' && session.result) {
    response.result = {
      conclusion: session.result.conclusion,
      confidence: session.result.confidence,
      totalDurationMs: session.result.totalDurationMs,
      rounds: session.result.rounds,
      findingsCount: session.result.findings.length,
    };
  }

  if (session.status === 'failed') {
    response.error = session.error;
  }

  res.json(response);
});

/**
 * DELETE /api/agent/:sessionId
 *
 * Clean up an analysis session
 */
router.delete('/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  // Close all SSE connections
  session.sseClients.forEach((client) => {
    try {
      client.end();
    } catch {}
  });

  session.orchestrator.reset();
  sessions.delete(sessionId);

  res.json({ success: true });
});

/**
 * POST /api/agent/:sessionId/respond
 *
 * Respond to an interactive session (e.g. continue/abort).
 *
 * Note: AgentDrivenOrchestrator currently does not pause for user input in v2;
 * this endpoint mainly exists for API compatibility and future multi-turn UX.
 */
router.post('/:sessionId/respond', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const action = req.body?.action;
  const allowedActions = new Set(['continue', 'abort']);

  if (!action || typeof action !== 'string' || !allowedActions.has(action)) {
    return res.status(400).json({
      success: false,
      error: `Invalid action: ${String(action)}. Allowed: continue, abort`,
    });
  }

  if (action === 'abort') {
    session.status = 'failed';
    session.error = 'Aborted by user';
    return res.json({ success: true, sessionId, status: session.status });
  }

  // continue
  if (session.status !== 'awaiting_user') {
    return res.status(400).json({
      success: false,
      error: `Session is not awaiting user input (current status: ${session.status})`,
    });
  }

  session.status = 'running';
  return res.json({ success: true, sessionId, status: session.status });
});

/**
 * GET /api/agent/sessions
 *
 * List all active and recoverable sessions
 *
 * Query params:
 * - traceId: Filter by trace ID
 * - limit: Max number of recoverable sessions (default: 20)
 * - includeRecoverable: Include recoverable sessions from persistence (default: true)
 */
router.get('/sessions', async (req, res) => {
  try {
    const { traceId, limit, includeRecoverable } = req.query;
    const parsedLimit = limit ? parseInt(limit as string, 10) : 20;
    const shouldIncludeRecoverable = includeRecoverable !== 'false';

    // Get active sessions from memory
    const activeSessions: any[] = [];
    const activeIds = new Set<string>();

    for (const [sessionId, session] of sessions.entries()) {
      if (traceId && session.traceId !== traceId) continue;

      activeIds.add(sessionId);
      activeSessions.push({
        sessionId,
        status: session.status,
        traceId: session.traceId,
        query: session.query,
        createdAt: session.createdAt,
        isActive: true,
        entityStoreStats: null, // Active sessions have live context
      });
    }

    // Get recoverable sessions from persistence (excluding active ones)
    const recoverableSessions: any[] = [];

    if (shouldIncludeRecoverable) {
      try {
        const persistenceService = SessionPersistenceService.getInstance();
        const persistedResult = persistenceService.listSessions({
          traceId: traceId as string | undefined,
          limit: parsedLimit,
        });

        for (const persistedSession of persistedResult.sessions) {
          // Skip if session is already active
          if (activeIds.has(persistedSession.id)) continue;

          // Check if session has recoverable context
          const hasContext = persistenceService.hasSessionContext(persistedSession.id);
          if (!hasContext) continue;

          // Get EntityStore stats for quick preview
          const storeStats = persistenceService.getEntityStoreStats(persistedSession.id);

          recoverableSessions.push({
            sessionId: persistedSession.id,
            status: 'recoverable',
            traceId: persistedSession.traceId,
            traceName: persistedSession.traceName,
            query: persistedSession.question,
            createdAt: persistedSession.createdAt,
            updatedAt: persistedSession.updatedAt,
            isActive: false,
            entityStoreStats: storeStats,
          });
        }
      } catch (persistError: any) {
        // Don't fail the request if persistence lookup fails
        console.warn('[AgentRoutes] Failed to list recoverable sessions:', persistError.message);
      }
    }

    res.json({
      success: true,
      activeSessions,
      totalActive: activeSessions.length,
      recoverableSessions,
      totalRecoverable: recoverableSessions.length,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/agent/resume
 *
 * Resume a recoverable session from persistence.
 *
 * This endpoint enables cross-restart session recovery by:
 * 1. Loading the persisted session from SQLite
 * 2. Restoring the EnhancedSessionContext (including EntityStore)
 * 3. Re-creating the orchestrator with the restored context
 *
 * Body:
 * {
 *   "sessionId": "agent-xxx",
 *   "traceId": "trace-xxx"  // Required for context restoration
 * }
 */
router.post('/resume', async (req, res) => {
  const { sessionId, traceId } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'sessionId is required',
    });
  }

  // Check if session is already active in memory
  const existingSession = sessions.get(sessionId);
  if (existingSession) {
    return res.json({
      success: true,
      sessionId,
      status: existingSession.status,
      message: 'Session already active',
      restored: false,
    });
  }

  // Try to restore from persistence
  try {
    const persistenceService = SessionPersistenceService.getInstance();

    // Check if session exists in persistence
    if (!persistenceService.hasSessionContext(sessionId)) {
      return res.status(404).json({
        success: false,
        error: 'Session not found in persistence',
        hint: 'Session may have expired or was never persisted',
      });
    }

    // Load persisted session metadata
    const persistedSession = persistenceService.getSession(sessionId);
    if (!persistedSession) {
      return res.status(404).json({
        success: false,
        error: 'Session metadata not found',
      });
    }

    // Use provided traceId or fall back to persisted one
    const effectiveTraceId = traceId || persistedSession.traceId;

    // Verify trace exists
    const traceProcessorService = getTraceProcessorService();
    const trace = traceProcessorService.getTrace(effectiveTraceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace before resuming the session',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Restore the EnhancedSessionContext (includes EntityStore)
    const restoredContext = persistenceService.loadSessionContext(sessionId);
    if (!restoredContext) {
      return res.status(500).json({
        success: false,
        error: 'Failed to deserialize session context',
      });
    }

    // Register the restored context in the session context manager
    // This replaces any stale in-memory context
    const contextManager = sessionContextManager;
    // We need to directly inject the restored context
    // First, get or create will create a new one, so we need to manually set it
    // Let's add the context to the manager by using the internal get method
    // Actually, we need to use the deserialized context directly

    // Create a new orchestrator for this session
    const modelRouter = getModelRouter();
    const orchestrator = createAgentDrivenOrchestrator(modelRouter, {
      enableLogging: true,
    });

    // Create logger
    const logger = createSessionLogger(sessionId);
    logger.setMetadata({
      traceId: effectiveTraceId,
      query: persistedSession.question,
      architecture: 'agent-driven',
      resumed: true,
    });
    logger.info('AgentRoutes', 'Session restored from persistence', {
      entityStoreStats: restoredContext.getEntityStore().getStats(),
      turnCount: restoredContext.getAllTurns().length,
    });

    // Create the session record
    sessions.set(sessionId, {
      orchestrator,
      sessionId,
      sseClients: [],
      status: 'completed', // Previous analysis was completed
      traceId: effectiveTraceId,
      query: persistedSession.question,
      createdAt: persistedSession.createdAt,
      logger,
      hypotheses: [],
      agentDialogue: [],
      dataEnvelopes: [],
      agentResponses: [],
    });

    // Inject the restored context into the session context manager
    // Note: We need to handle this carefully since EnhancedSessionContext
    // uses sessionContextManager internally
    // The cleanest approach is to use getOrCreate and then manually
    // update the internal state
    const freshContext = sessionContextManager.getOrCreate(sessionId, effectiveTraceId);

    // Manually restore EntityStore data from persisted context
    const restoredStore = restoredContext.getEntityStore();
    const freshStore = freshContext.getEntityStore();

    // Transfer all entities from restored store to fresh store
    for (const frame of restoredStore.getAllFrames()) {
      freshStore.upsertFrame(frame);
    }
    for (const session of restoredStore.getAllSessions()) {
      freshStore.upsertSession(session);
    }

    // Transfer candidate and analyzed tracking
    const restoredSnapshot = restoredStore.serialize();
    if (restoredSnapshot.lastCandidateFrameIds) {
      freshStore.setLastCandidateFrames(restoredSnapshot.lastCandidateFrameIds);
    }
    if (restoredSnapshot.lastCandidateSessionIds) {
      freshStore.setLastCandidateSessions(restoredSnapshot.lastCandidateSessionIds);
    }
    if (restoredSnapshot.analyzedFrameIds) {
      for (const id of restoredSnapshot.analyzedFrameIds) {
        freshStore.markFrameAnalyzed(id);
      }
    }
    if (restoredSnapshot.analyzedSessionIds) {
      for (const id of restoredSnapshot.analyzedSessionIds) {
        freshStore.markSessionAnalyzed(id);
      }
    }

    // Restore turns from persisted context
    for (const turn of restoredContext.getAllTurns()) {
      freshContext.addTurn(turn.query, turn.intent, turn.result, turn.findings);
    }

    return res.json({
      success: true,
      sessionId,
      traceId: effectiveTraceId,
      status: 'completed',
      message: 'Session restored from persistence',
      restored: true,
      restoredStats: {
        turnCount: restoredContext.getAllTurns().length,
        entityStore: restoredStore.getStats(),
      },
    });
  } catch (error: any) {
    console.error('[AgentRoutes] Session restore failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to restore session',
    });
  }
});

// ============================================================================
// Scene Reconstruction Endpoints
// ============================================================================

/**
 * POST /api/agent/scene-reconstruct
 *
 * Start Agent-driven scene reconstruction
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "options": {
 *     "deepAnalysis": true,
 *     "generateTracks": true
 *   }
 * }
 */
router.post('/scene-reconstruct', async (req, res) => {
  try {
    const { traceId, options = {} } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
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

    // Initialize tools
    ensureToolsRegistered();

    // Create LLM client and scene reconstruction agent
    const llm = createLLMClient();
    const sceneAgent = createSceneReconstructionAgent(llm);
    sceneAgent.setTraceProcessorService(traceProcessorService, traceId);

    // Generate analysis ID
    const analysisId = `scene-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Store session
    sceneReconstructionSessions.set(analysisId, {
      agent: sceneAgent,
      sseClients: [],
      status: 'pending',
    });

    // Start analysis in background
    runSceneReconstruction(analysisId, traceId, options).catch((error) => {
      console.error(`[AgentRoutes] Scene reconstruction error for ${analysisId}:`, error);
      const session = sceneReconstructionSessions.get(analysisId);
      if (session) {
        session.status = 'failed';
        session.error = error.message;
        broadcastToSceneClients(analysisId, {
          type: 'error',
          content: { message: error.message },
          timestamp: Date.now(),
        });
      }
    });

    res.json({
      success: true,
      analysisId,
    });
  } catch (error: any) {
    console.error('[AgentRoutes] Scene reconstruction start error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start scene reconstruction',
    });
  }
});

/**
 * GET /api/agent/scene-reconstruct/:analysisId/stream
 *
 * SSE endpoint for real-time scene reconstruction updates
 */
router.get('/scene-reconstruct/:analysisId/stream', (req, res) => {
  const { analysisId } = req.params;

  const session = sceneReconstructionSessions.get(analysisId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Scene reconstruction session not found',
    });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection message
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ analysisId, timestamp: Date.now() })}\n\n`);

  // Add client to session
  session.sseClients.push(res);
  console.log(`[AgentRoutes] Scene SSE client connected for ${analysisId}`);

  // If analysis is already completed, send the result
  if (session.status === 'completed' && session.result) {
    sendSceneReconstructionResult(res, session.result);
    res.write(`event: end\n`);
    res.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    res.end();
    return;
  }

  // If analysis failed, send error
  if (session.status === 'failed') {
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error: session.error, timestamp: Date.now() })}\n\n`);
    res.write(`event: end\n`);
    res.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    res.end();
    return;
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[AgentRoutes] Scene SSE client disconnected for ${analysisId}`);
    const idx = session.sseClients.indexOf(res);
    if (idx !== -1) {
      session.sseClients.splice(idx, 1);
    }
  });

  // Keep-alive ping
  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/**
 * GET /api/agent/scene-reconstruct/:analysisId/tracks
 *
 * Get track events for Perfetto timeline
 */
router.get('/scene-reconstruct/:analysisId/tracks', (req, res) => {
  const { analysisId } = req.params;

  const session = sceneReconstructionSessions.get(analysisId);
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

/**
 * GET /api/agent/scene-reconstruct/:analysisId/status
 *
 * Get scene reconstruction status
 */
router.get('/scene-reconstruct/:analysisId/status', (req, res) => {
  const { analysisId } = req.params;

  const session = sceneReconstructionSessions.get(analysisId);
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
    response.result = {
      narrative: session.result.narrative,
      confidence: session.result.confidence,
      executionTimeMs: session.result.executionTimeMs,
      scenesCount: session.scenes?.length || 0,
      tracksCount: session.trackEvents?.length || 0,
    };
  }

  if (session.status === 'failed') {
    response.error = session.error;
  }

  res.json(response);
});

/**
 * DELETE /api/agent/scene-reconstruct/:analysisId
 *
 * Clean up a scene reconstruction session
 */
router.delete('/scene-reconstruct/:analysisId', (req, res) => {
  const { analysisId } = req.params;

  const session = sceneReconstructionSessions.get(analysisId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Scene reconstruction session not found',
    });
  }

  // Close all SSE connections
  session.sseClients.forEach((client) => {
    try {
      client.end();
    } catch {}
  });

  sceneReconstructionSessions.delete(analysisId);

  res.json({ success: true });
});

// ============================================================================
// Teaching Pipeline Endpoints
// ============================================================================

/**
 * POST /api/agent/teaching/pipeline
 *
 * Teaching: Rendering Pipeline Detection and Education
 *
 * Detects the rendering pipeline type of the current trace and returns:
 * - Pipeline type detection results
 * - Teaching content (Mermaid diagrams, thread roles, key slices)
 * - Track pinning instructions
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "packageName": "com.example.app"  // optional
 * }
 */
router.post('/teaching/pipeline', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
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

    console.log(`[AgentRoutes] Teaching pipeline request for trace: ${traceId}`);

    // Ensure skills are loaded
    console.log('[AgentRoutes] Step 1: Initializing skill registry...');
    await ensureSkillRegistryInitialized();
    console.log('[AgentRoutes] Step 2: Skill registry initialized, skills count:', skillRegistry.getAllSkills().length);

    // Execute the rendering_pipeline_detection skill
    console.log('[AgentRoutes] Step 3: Creating SkillExecutor...');
    const skillExecutor = new SkillExecutor(traceProcessorService);
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    console.log('[AgentRoutes] Step 4: Skills registered');

    console.log('[AgentRoutes] Step 5: Executing rendering_pipeline_detection skill...');
    const detectionResult = await skillExecutor.execute(
      'rendering_pipeline_detection',
      traceId,
      { package: packageName || '' }
    );
    console.log('[AgentRoutes] Step 6: Skill execution complete, success:', detectionResult.success);

    if (!detectionResult.success) {
      console.error('[AgentRoutes] Skill execution failed:', detectionResult.error);
      return res.status(500).json({
        success: false,
        error: 'Pipeline detection failed',
        details: detectionResult.error,
      });
    }

    // Extract detection results from skill output via rawResults keyed by step ID
    const rawResults = detectionResult.rawResults || {};

    // Get pipeline determination result (from 'determine_pipeline' step)
    const pipelineStepResult = rawResults['determine_pipeline'];
    const pipelineResult = pipelineStepResult?.data?.rows?.[0]
      ? {
          primary_pipeline_id: pipelineStepResult.data.rows[0][0],
          primary_confidence: pipelineStepResult.data.rows[0][1],
          candidates_list: pipelineStepResult.data.rows[0][2],
          features_list: pipelineStepResult.data.rows[0][3],
          doc_path: pipelineStepResult.data.rows[0][4],
        }
      : null;

    // Get subvariants (from 'subvariants' step)
    // SQL returns: buffer_mode, flutter_engine, webview_mode, game_engine
    const subvariantsStepResult = rawResults['subvariants'];
    const subvariants = subvariantsStepResult?.data?.rows?.[0]
      ? {
          buffer_mode: subvariantsStepResult.data.rows[0][0],
          flutter_engine: subvariantsStepResult.data.rows[0][1],
          webview_mode: subvariantsStepResult.data.rows[0][2],
          game_engine: subvariantsStepResult.data.rows[0][3],
        }
      : null;

    // Get pin instructions (from 'pin_instructions' step)
    const pinInstructionsStepResult = rawResults['pin_instructions'];
    const pinInstructionsData = pinInstructionsStepResult?.data?.rows || [];

    // Get trace requirements (from 'trace_requirements' step)
    const traceReqStepResult = rawResults['trace_requirements'];
    const traceRequirements = traceReqStepResult?.data?.rows || [];

    // Get active rendering processes (from 'active_rendering_processes' step - v3 smart pin)
    // SQL returns: upid, process_name, frame_count, render_thread_tid
    const activeProcessesStepResult = rawResults['active_rendering_processes'];
    const activeRenderingProcesses = activeProcessesStepResult?.data?.rows?.map((row: any[]) => ({
      upid: row[0],
      processName: row[1],
      frameCount: row[2],
      renderThreadTid: row[3],
    })) || [];

    console.log('[AgentRoutes] Active rendering processes:', activeRenderingProcesses.map((p: any) => `${p.processName} (${p.frameCount} frames)`));

    // Default values if skill output is incomplete
    const primaryPipelineId = pipelineResult?.primary_pipeline_id || 'ANDROID_VIEW_STANDARD_BLAST';
    const primaryConfidence = pipelineResult?.primary_confidence || 0.5;
    const candidatesList = pipelineResult?.candidates_list || '';
    const featuresList = pipelineResult?.features_list || '';
    const docPath = pipelineResult?.doc_path || 'rendering_pipelines/android_view_standard.md';

    // Parse candidates and features
    const candidates = candidatesList
      ? candidatesList.split('; ').map((c: string) => {
          const [id, score] = c.split(':');
          return { id, confidence: parseFloat(score) || 0 };
        })
      : [{ id: primaryPipelineId, confidence: primaryConfidence }];

    const features = featuresList
      ? featuresList.split('; ').map((f: string) => {
          const [id, score] = f.split(':');
          return { id, confidence: parseFloat(score) || 0 };
        })
      : [];

    // Get teaching content from documentation
    const pipelineDocService = getPipelineDocService();
    const teachingContent = pipelineDocService.getTeachingContent(primaryPipelineId);

    // Get base pin instructions from PipelineSkillLoader (new data-driven approach)
    // Ensure pipeline skills are loaded
    await ensurePipelineSkillsInitialized();

    // Get pin instructions from pipeline skill YAML
    const basePinInstructions = pipelineSkillLoader.getAutoPinInstructions(primaryPipelineId);

    // Get smart filter configurations from pipeline skill
    const smartFilterConfigs = pipelineSkillLoader.getSmartFilterConfigs(primaryPipelineId);

    // v4 Smart Pin Enhancement: YAML-driven smart pin based on pipeline skill configuration
    // Each pin instruction can have a smart_filter section that defines detection_sql.
    // If smart_filter.enabled is true, we check if activeRenderingProcesses has data for that pattern.
    //
    // Decision logic per instruction:
    // 1. Check if instruction has smart_filter.enabled = true
    // 2. If smart filter enabled and activeRenderingProcesses has data → smartPin
    // 3. If smart filter enabled and activeRenderingProcesses is empty → skipPin
    // 4. If smart filter not enabled → normal pin

    // Build a set of process names with active rendering data (from SQL in skill)
    const activeProcessNames = new Set(activeRenderingProcesses.map((p: any) => p.processName));
    const hasActiveRenderingData = activeRenderingProcesses.length > 0;

    const smartPinInstructions = basePinInstructions.map((inst: PinInstruction) => {
      // Check if this instruction has smart_filter enabled (from YAML config)
      const hasSmartFilter = smartFilterConfigs.has(inst.pattern) || inst.smart_filter?.enabled;

      if (hasSmartFilter) {
        // This instruction requires smart filtering
        if (hasActiveRenderingData) {
          // SQL found active processes → enable smart pin filtering
          return {
            ...inst,
            activeProcessNames: Array.from(activeProcessNames),
            smartPin: true,
            reason: `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`,
          };
        } else {
          // SQL returned empty → skip this pin instruction
          return {
            ...inst,
            skipPin: true,
            reason: `${inst.reason} (无活跃渲染数据，跳过)`,
          };
        }
      }
      // No smart filter configured → normal pin
      return inst;
    });

    // Build response
    const response = {
      success: true,
      detection: {
        primary_pipeline: {
          id: primaryPipelineId,
          confidence: primaryConfidence,
        },
        candidates,
        features,
        subvariants: subvariants || {
          buffer_mode: 'UNKNOWN',
          flutter_engine: 'N/A',
          webview_mode: 'N/A',
          game_engine: 'N/A',
        },
        trace_requirements_missing: traceRequirements
          ? Object.values(traceRequirements).filter((v: any) => v !== null)
          : [],
      },
      teaching: teachingContent
        ? {
            title: teachingContent.title,
            summary: teachingContent.summary,
            mermaidBlocks: teachingContent.mermaidBlocks,
            threadRoles: teachingContent.threadRoles,
            keySlices: teachingContent.keySlices,
            docPath: teachingContent.docPath,
          }
        : {
            title: `渲染管线: ${primaryPipelineId}`,
            summary: '未找到对应的文档内容。',
            mermaidBlocks: [],
            threadRoles: [],
            keySlices: [],
            docPath,
          },
      pinInstructions: smartPinInstructions,
      // v3: Active rendering processes for smart pin filtering
      activeRenderingProcesses: activeRenderingProcesses.map((p: any) => ({
        processName: p.processName,
        frameCount: p.frameCount,
        renderThreadTid: p.renderThreadTid,
      })),
    };

    console.log(`[AgentRoutes] Teaching pipeline detected: ${primaryPipelineId} (${(primaryConfidence * 100).toFixed(1)}%)`);
    console.log(`[AgentRoutes] Smart pin: ${activeRenderingProcesses.length} active rendering processes`);
    res.json(response);
  } catch (error: any) {
    console.error('[AgentRoutes] Teaching pipeline error:', error);
    console.error('[AgentRoutes] Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to detect pipeline',
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    });
  }
});

// ============================================================================
// Report Generation (simplified for new architecture)
// ============================================================================

/**
 * GET /api/agent/:sessionId/report
 *
 * Generate a simple JSON report for the session
 */
router.get('/:sessionId/report', (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  if (session.status !== 'completed' || !session.result) {
    return res.status(400).json({
      success: false,
      error: 'Session is not completed yet',
      status: session.status,
    });
  }

  const result = session.result;
  // Generate simplified report data
  const report = {
    sessionId,
    traceId: session.traceId,
    query: session.query,
    createdAt: session.createdAt,
    completedAt: Date.now(),

    summary: {
      conclusion: result.conclusion,
      confidence: result.confidence,
      totalDurationMs: result.totalDurationMs,
      rounds: result.rounds,
    },

    findings: result.findings.map((f) => ({
      id: f.id,
      category: f.category,
      severity: f.severity,
      title: f.title,
      description: f.description,
    })),

    hypotheses: result.hypotheses.map((h) => ({
      id: h.id,
      description: h.description,
      status: h.status,
      confidence: h.confidence,
    })),

    // Log file path for debugging
    logFile: session.logger.getLogFilePath(),
  };

  res.json({
    success: true,
    report,
  });
});

// ============================================================================
// Scene Reconstruction Helper Functions
// ============================================================================

async function runSceneReconstruction(
  analysisId: string,
  traceId: string,
  options: { deepAnalysis?: boolean; generateTracks?: boolean } = {}
) {
  const session = sceneReconstructionSessions.get(analysisId);
  if (!session) return;

  session.status = 'running';

  // Set up streaming callback for real-time updates
  const streamingCallback = (update: StreamingUpdate) => {
    console.log(`[AgentRoutes] Scene reconstruction update for ${analysisId}:`, update.type);
    broadcastToSceneClients(analysisId, update);
  };

  session.agent.setStreamingCallback(streamingCallback);

  try {
    // Create analysis context
    const context = {
      traceId,
      package: undefined as string | undefined,
    };

    // Run scene reconstruction analysis
    const result = await session.agent.analyze(context);

    // Store results
    session.result = result;
    session.scenes = result.scenes;
    session.trackEvents = result.trackEvents;
    session.status = 'completed';

    // Send final results to all clients
    session.sseClients.forEach((client) => {
      try {
        sendSceneReconstructionResult(client, result);
        client.write(`event: end\n`);
        client.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
      } catch {}
    });

    console.log(`[AgentRoutes] Scene reconstruction completed for ${analysisId}`);
    console.log(`  - Scenes detected: ${result.scenes.length}`);
    console.log(`  - Track events: ${result.trackEvents.length}`);
    console.log(`  - Confidence: ${result.confidence}`);
  } catch (error: any) {
    session.status = 'failed';
    session.error = error.message;

    broadcastToSceneClients(analysisId, {
      type: 'error',
      content: { message: error.message },
      timestamp: Date.now(),
    });

    throw error;
  }
}

function broadcastToSceneClients(analysisId: string, update: StreamingUpdate) {
  const session = sceneReconstructionSessions.get(analysisId);
  if (!session) return;

  const eventType = update.type;
  const eventData = JSON.stringify({
    type: update.type,
    data: update.content,
    timestamp: update.timestamp,
  });

  session.sseClients.forEach((client) => {
    try {
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${eventData}\n\n`);
    } catch {}
  });
}

function sendSceneReconstructionResult(res: express.Response, result: SceneReconstructionResult) {
  // Send scene_reconstruction_completed event with full result
  res.write(`event: scene_reconstruction_completed\n`);
  res.write(`data: ${JSON.stringify({
    type: 'scene_reconstruction_completed',
    data: {
      narrative: result.narrative,
      confidence: result.confidence,
      executionTimeMs: result.executionTimeMs,
      scenes: result.scenes.map((s) => ({
        type: s.type,
        startTs: s.startTs,
        endTs: s.endTs,
        durationMs: s.durationMs,
        confidence: s.confidence,
        appPackage: s.appPackage,
      })),
      trackEvents: result.trackEvents,
      findings: result.findings.map((f) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        title: f.title,
        description: f.description,
        timestampsNs: f.timestampsNs,
      })),
      suggestions: result.suggestions,
    },
    timestamp: Date.now(),
  })}\n\n`);
}

// ============================================================================
// Agent-Driven Analysis Helper Functions (Phase 2-4)
// ============================================================================

async function runAgentDrivenAnalysis(
  sessionId: string,
  query: string,
  traceId: string,
  options: any = {}
) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const { logger } = session;
  session.status = 'running';
  logger.info('AgentDrivenAnalysis', 'Starting agent-driven analysis', { query, traceId });

  // Set up streaming via event listener on orchestrator
  const handleUpdate = (update: StreamingUpdate) => {
    console.log(`[AgentRoutes.AgentDriven] Received event: ${update.type}`, update.content?.phase);
    logger.debug('Stream', `Update: ${update.type}`, update.content);

    // Track agent dialogue events
    if (update.content?.phase === 'task_dispatched' || update.content?.phase === 'task_completed') {
      session.agentDialogue.push({
        agentId: update.content.agentId || 'master',
        type: update.content.phase === 'task_dispatched' ? 'task' : 'response',
        content: update.content,
        timestamp: update.timestamp,
      });

      // Collect full agent responses for HTML report enrichment
      if (update.content.phase === 'task_completed') {
        session.agentResponses.push({
          taskId: update.content.taskId || '',
          agentId: update.content.agentId || 'unknown',
          response: update.content.response || update.content,
          timestamp: update.timestamp,
        });
      }
    }

    // Broadcast specialized events for frontend visualization
    const eventType = mapToAgentDrivenEventType(update);
    broadcastToAgentDrivenClients(sessionId, {
      type: eventType,
      content: update.content,
      timestamp: update.timestamp,
      id: update.id,
    });
  };

  // Listen to orchestrator events
  session.orchestrator.on('update', handleUpdate);

  try {
    console.log('[AgentRoutes.AgentDriven] Starting orchestrator.analyze...');
    const result = await logger.timed('AgentDrivenAnalysis', 'analyze', async () => {
      return session.orchestrator.analyze(query, sessionId, traceId, {
        traceProcessorService: options.traceProcessorService,
        packageName: options.packageName,
        timeRange: options.timeRange,
      });
    });
    console.log('[AgentRoutes.AgentDriven] analyze completed, success:', result.success);

    session.result = result;
    session.hypotheses = result.hypotheses;
    session.status = result.success ? 'completed' : 'failed';

    // Log completion details
    logger.info('AgentDrivenAnalysis', 'Agent-driven analysis completed', {
      confidence: result.confidence,
      rounds: result.rounds,
      findingsCount: result.findings.length,
      hypothesesCount: result.hypotheses.length,
    });

    // Persist session context (including EntityStore) for cross-restart recovery
    try {
      const persistenceService = SessionPersistenceService.getInstance();
      const sessionContext = sessionContextManager.get(sessionId, traceId);
      if (sessionContext) {
        // First, ensure the session exists in persistence
        const existingSession = persistenceService.getSession(sessionId);
        if (!existingSession) {
          // Create a new persisted session record
          persistenceService.saveSession({
            id: sessionId,
            traceId,
            traceName: traceId, // Can be enhanced later
            question: query,
            messages: [],
            createdAt: session.createdAt,
            updatedAt: Date.now(),
          });
        }

        // Save the full session context (includes EntityStore)
        const saved = persistenceService.saveSessionContext(sessionId, sessionContext);
        if (saved) {
          const storeStats = sessionContext.getEntityStore().getStats();
          logger.info('AgentDrivenAnalysis', 'Session context persisted to DB', {
            sessionId,
            entityStoreStats: storeStats,
          });
        }
      }
    } catch (persistError: any) {
      // Don't fail the analysis if persistence fails - just log the error
      logger.warn('AgentDrivenAnalysis', 'Failed to persist session context', {
        error: persistError.message,
      });
    }

    // Send final result
    const clientCount = session.sseClients.length;
    logger.info('AgentRoutes', 'Sending agent-driven result', { clientCount });

    session.sseClients.forEach((client, index) => {
      try {
        logger.info('AgentRoutes', `Sending agent-driven result to client ${index + 1}/${clientCount}`);
        sendAgentDrivenResult(client, session);
        client.write(`event: end\n`);
        client.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
      } catch (e: any) {
        logger.error('AgentRoutes', `Error sending agent-driven result to client ${index + 1}`, e);
      }
    });

    logger.close();
  } catch (error: any) {
    session.status = 'failed';
    session.error = error.message;
    logger.error('AgentDrivenAnalysis', 'Agent-driven analysis failed', error);

    broadcastToAgentDrivenClients(sessionId, {
      type: 'error',
      content: { message: error.message },
      timestamp: Date.now(),
    });

    logger.close();
    throw error;
  }
}

/**
 * Map orchestrator update types to agent-driven SSE event types
 */
function mapToAgentDrivenEventType(update: StreamingUpdate): StreamingUpdate['type'] {
  const phase = update.content?.phase;

  switch (phase) {
    case 'starting':
    case 'understanding':
      return 'progress';
    case 'hypotheses_generated':
      return 'hypothesis_generated';
    case 'round_start':
      return 'round_start';
    case 'tasks_dispatched':
      return 'agent_task_dispatched';
    case 'task_dispatched':
      return 'agent_dialogue';
    case 'task_completed':
      return 'agent_response';
    case 'synthesis_complete':
      return 'synthesis_complete';
    case 'strategy_decision':
      return 'strategy_decision';
    case 'concluding':
      return 'progress';
    default:
      return update.type;
  }
}

/**
 * Broadcast update to all SSE clients for an agent-driven session
 */
function broadcastToAgentDrivenClients(sessionId: string, update: StreamingUpdate) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const eventType = update.type;
  let eventData: string;

  if (isDataEvent(eventType)) {
    const envelopes = Array.isArray(update.content) ? update.content : [update.content];
    for (let i = 0; i < envelopes.length; i++) {
      const envelope = envelopes[i];
      const validationErrors = validateDataEnvelope(envelope);
      if (validationErrors.length > 0) {
        console.warn(`[AgentRoutes.broadcastToAgentDrivenClients] DataEnvelope validation warning (envelope ${i}):`, {
          sessionId,
          errors: validationErrors.slice(0, 5),
          totalErrors: validationErrors.length,
          envelope: {
            metaType: envelope?.meta?.type,
            metaSource: envelope?.meta?.source,
            displayLayer: envelope?.display?.layer,
            displayFormat: envelope?.display?.format,
          },
        });
      }
    }

    console.log(`[AgentRoutes.broadcastToAgentDrivenClients] Sending ${envelopes.length} DataEnvelope(s) for session ${sessionId}`);

    // Collect DataEnvelopes for HTML report generation
    for (const envelope of envelopes) {
      if (envelope && envelope.data) {
        session.dataEnvelopes.push(envelope);
      }
    }

    eventData = JSON.stringify({
      type: 'data',  // Fallback type for SSE chunk boundary resilience
      id: update.id || generateEventId('sse', sessionId),
      envelope: update.content,
      timestamp: update.timestamp,
    });
  } else if (isLegacySkillEvent(eventType)) {
    eventData = JSON.stringify({
      type: update.type,
      data: update.content,
      timestamp: update.timestamp,
    });
  } else {
    eventData = JSON.stringify({
      type: update.type,
      data: update.content,
      timestamp: update.timestamp,
    });
  }

  session.sseClients.forEach((client) => {
    try {
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${eventData}\n\n`);
    } catch {}
  });
}

/**
 * Send agent-driven analysis result to SSE client
 */
function sendAgentDrivenResult(res: express.Response, session: AnalysisSession) {
  const result = session.result;
  if (!result) return;

  // Generate HTML report
  let reportUrl: string | undefined;
  let reportError: string | undefined;
  try {
    const traceInfo = getTraceProcessorService().getTrace(session.traceId);
    const traceStartNs = traceInfo?.metadata?.startTime;

    const generator = getHTMLReportGenerator();
    const reportData = {
      traceId: session.traceId,
      query: session.query,
      traceStartNs: traceStartNs !== undefined && traceStartNs !== null ? String(traceStartNs) : undefined,
      result,
      hypotheses: session.hypotheses,
      dialogue: session.agentDialogue,
      dataEnvelopes: session.dataEnvelopes,
      agentResponses: session.agentResponses,
      timestamp: Date.now(),
    };
    console.log(`[AgentRoutes] Generating HTML report, data keys:`, {
      hasResult: !!result,
      conclusionLength: result.conclusion?.length || 0,
      findingsCount: result.findings?.length || 0,
      hypothesesCount: session.hypotheses?.length || 0,
      dialogueCount: session.agentDialogue?.length || 0,
      dataEnvelopesCount: session.dataEnvelopes?.length || 0,
      agentResponsesCount: session.agentResponses?.length || 0,
    });

    const html = generator.generateAgentDrivenHTML(reportData);

    // Store report
    const reportId = `agent-report-${session.sessionId}`;
    reportStore.set(reportId, {
      html,
      generatedAt: Date.now(),
      sessionId: session.sessionId,
    });

    reportUrl = `/api/reports/${reportId}`;
    console.log(`[AgentRoutes] Generated agent-driven HTML report: ${reportId} (${html.length} bytes)`);
  } catch (error: any) {
    reportError = error.message || 'Unknown error';
    console.error('[AgentRoutes] Failed to generate agent-driven HTML report:', {
      error: reportError,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
  }

  // Send analysis_completed event with full result
  res.write(`event: analysis_completed\n`);
  res.write(`data: ${JSON.stringify({
    type: 'analysis_completed',
    architecture: 'agent-driven',
    data: {
      conclusion: result.conclusion,
      confidence: result.confidence,
      rounds: result.rounds,
      totalDurationMs: result.totalDurationMs,
      findings: result.findings.map((f) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        title: f.title,
        description: f.description,
        timestampsNs: f.timestampsNs,
        evidence: f.evidence,
        details: f.details,
        recommendations: f.recommendations,
        confidence: f.confidence,
      })),
      hypotheses: result.hypotheses.map((h) => ({
        id: h.id,
        description: h.description,
        status: h.status,
        confidence: h.confidence,
        supportingEvidence: h.supportingEvidence,
        contradictingEvidence: h.contradictingEvidence,
      })),
      agentDialogueCount: session.agentDialogue.length,
      reportUrl,
      reportError,
    },
    timestamp: Date.now(),
  })}\n\n`);
}

// ============================================================================
// Session Logs Endpoints (for debugging)
// ============================================================================

/**
 * GET /api/agent/logs
 *
 * List all available session logs
 */
router.get('/logs', (req, res) => {
  try {
    const manager = getSessionLoggerManager();
    const sessions = manager.listSessions();

    res.json({
      success: true,
      logDir: manager.getLogDir(),
      sessions,
      count: sessions.length,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/agent/logs/:sessionId
 *
 * Get logs for a specific session
 *
 * Query params:
 * - level: Filter by level (debug, info, warn, error)
 * - component: Filter by component name
 * - search: Search in message or data
 * - limit: Max number of logs to return
 */
router.get('/logs/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { level, component, search, limit } = req.query;

  try {
    const manager = getSessionLoggerManager();
    const logs = manager.readSessionLogs(sessionId, {
      level: level as any,
      component: component as string,
      search: search as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });

    res.json({
      success: true,
      sessionId,
      logs,
      count: logs.length,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/agent/logs/:sessionId/errors
 *
 * Get only errors and warnings for a session
 */
router.get('/logs/:sessionId/errors', (req, res) => {
  const { sessionId } = req.params;

  try {
    const manager = getSessionLoggerManager();
    const logs = manager.readSessionLogs(sessionId, {
      level: ['error', 'warn'],
    });

    res.json({
      success: true,
      sessionId,
      logs,
      errorCount: logs.filter(l => l.level === 'error').length,
      warnCount: logs.filter(l => l.level === 'warn').length,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/agent/logs/cleanup
 *
 * Clean up old log files
 *
 * Body:
 * {
 *   "maxAgeDays": 7  // optional, default 7 days
 * }
 */
router.post('/logs/cleanup', (req, res) => {
  const { maxAgeDays = 7 } = req.body;

  try {
    const manager = getSessionLoggerManager();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const deletedCount = manager.cleanup(maxAgeMs);

    res.json({
      success: true,
      deletedCount,
      message: `Deleted ${deletedCount} log files older than ${maxAgeDays} days`,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// Cleanup
// ============================================================================

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  // Clean up agent sessions
  for (const [id, session] of sessions.entries()) {
    const age = now - session.createdAt;
    if (age > maxAge && (session.status === 'completed' || session.status === 'failed')) {
      console.log(`[AgentRoutes] Cleaning up stale session: ${id}`);
      session.sseClients.forEach((client) => {
        try {
          client.end();
        } catch {}
      });
      sessions.delete(id);
    }
  }

  // Clean up agent-driven sessions (Phase 2-4)
  for (const [id, session] of sessions.entries()) {
    const age = now - session.createdAt;
    if (age > maxAge && (session.status === 'completed' || session.status === 'failed')) {
      console.log(`[AgentRoutes] Cleaning up stale agent-driven session: ${id}`);
      session.sseClients.forEach((client) => {
        try {
          client.end();
        } catch {}
      });
      session.orchestrator.reset();
      sessions.delete(id);
    }
  }

  // Clean up scene reconstruction sessions
  for (const [id, session] of sceneReconstructionSessions.entries()) {
    const match = id.match(/^scene-(\d+)-/);
    if (match) {
      const createdAt = parseInt(match[1], 10);
      if (now - createdAt > maxAge) {
        console.log(`[AgentRoutes] Cleaning up stale scene session: ${id}`);
        session.sseClients.forEach((client) => {
          try {
            client.end();
          } catch {}
        });
        sceneReconstructionSessions.delete(id);
      }
    }
  }
}, 30 * 60 * 1000);

export default router;
