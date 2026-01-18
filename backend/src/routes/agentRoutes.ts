/**
 * Agent Analysis Routes
 *
 * API endpoints for Agent-based trace analysis using the new architecture:
 * - MasterOrchestrator with Pipeline + Circuit Breaker
 * - State Machine for session persistence and recovery
 * - Multi-model routing
 * - Evaluator-Optimizer loop
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
import {
  registerCoreTools,
  StreamingUpdate,
  // New architecture imports
  createMasterOrchestrator,
  MasterOrchestrator,
  SessionStore,
  MasterOrchestratorResult,
  Finding,
  // Scene reconstruction (separate feature)
  createLLMClient,
  createSceneReconstructionAgent,
  SceneReconstructionResult,
  DetectedScene,
  TrackEvent,
} from '../agent';

// Helper to extract findings from MasterOrchestratorResult
function extractFindings(result: MasterOrchestratorResult): Finding[] {
  const findings: Finding[] = [];
  for (const stage of result.stageResults || []) {
    findings.push(...(stage.findings || []));
  }
  return findings;
}

// Helper to extract suggestions from evaluation
function extractSuggestions(result: MasterOrchestratorResult): string[] {
  return result.evaluation?.feedback?.improvementSuggestions || [];
}

const router = express.Router();

// ============================================================================
// Session Tracking
// ============================================================================

interface AnalysisSession {
  orchestrator: MasterOrchestrator;
  sessionId: string;
  sseClients: express.Response[];
  result?: MasterOrchestratorResult;
  status: 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed';
  error?: string;
  traceId: string;
  query: string;
  createdAt: number;
  logger: SessionLogger;
}

const sessions = new Map<string, AnalysisSession>();

// Session store for persistence and recovery
let sessionStore: SessionStore | null = null;

function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = new SessionStore();
  }
  return sessionStore;
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
 * Start analysis using MasterOrchestrator architecture
 *
 * Features:
 * - Pipeline execution with checkpoints
 * - Circuit breaker protection
 * - Multi-model routing
 * - Session persistence and recovery
 * - Evaluator-Optimizer loop
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "query": "分析这个 trace 的滑动性能",
 *   "options": {
 *     "maxIterations": 5,
 *     "qualityThreshold": 0.7,
 *     "enableEvaluation": true
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
    let orchestrator: MasterOrchestrator;
    let logger: ReturnType<typeof createSessionLogger>;
    let isNewSession = true;

    if (requestedSessionId) {
      const existingSession = sessions.get(requestedSessionId);
      if (existingSession && existingSession.traceId === traceId) {
        // Reuse existing session for multi-turn dialogue
        sessionId = requestedSessionId;
        orchestrator = existingSession.orchestrator;
        logger = existingSession.logger;
        isNewSession = false;
        logger.info('AgentRoutes', 'Continuing multi-turn dialogue', {
          turnQuery: query,
          previousQuery: existingSession.query,
        });
        // Update the query for this turn
        existingSession.query = query;
        existingSession.status = 'pending';
        console.log(`[AgentRoutes] Reusing session ${sessionId} for multi-turn dialogue`);
      } else {
        // Session not found or different trace, create new session
        console.log(`[AgentRoutes] Requested session ${requestedSessionId} not found or trace mismatch, creating new session`);
        sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
      }
    } else {
      // Generate new session ID
      sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    }

    if (isNewSession) {
      // Create new MasterOrchestrator with configuration
      orchestrator = createMasterOrchestrator({
        maxTotalIterations: options.maxIterations || 5,
        stateMachineConfig: { sessionId, traceId },
        evaluationCriteria: {
          minQualityScore: options.qualityThreshold || 0.7,
          minCompletenessScore: 0.6,
          maxContradictions: 0,
          requiredAspects: [],
        },
        enableTraceRecording: true,
      });

      // Create logger for this session
      logger = createSessionLogger(sessionId);
      logger.setMetadata({ traceId, query });
      logger.info('AgentRoutes', 'Analysis session created', { options });

      sessions.set(sessionId, {
        orchestrator,
        sessionId,
        sseClients: [],
        status: 'pending',
        traceId,
        query,
        createdAt: Date.now(),
        logger,
      });
    }

    // Start analysis in background - pass traceProcessorService for Skill execution
    runAnalysis(sessionId, query, traceId, { ...options, traceProcessorService }).catch((error) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.logger.error('AgentRoutes', 'Analysis failed', error);
        session.status = 'failed';
        session.error = error.message;
        broadcastToClients(sessionId, {
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
 * - phase_change: Pipeline phase changed
 * - stage_start: Pipeline stage started
 * - stage_complete: Pipeline stage completed
 * - finding: Analysis finding discovered
 * - thought: Agent reasoning
 * - evaluation: Evaluator feedback
 * - circuit_breaker: Circuit breaker tripped (needs user input)
 * - conclusion: Final answer
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
    timestamp: Date.now(),
  })}\n\n`);

  // Add client to session
  session.sseClients.push(res);
  console.log(`[AgentRoutes] SSE client connected for ${sessionId}`);

  // If analysis is already completed, send the result
  if (session.status === 'completed' && session.result) {
    sendResult(res, session.result, {
      sessionId: session.sessionId,
      traceId: session.traceId,
      query: session.query,
    });
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
    const findings = extractFindings(session.result);
    response.result = {
      answer: session.result.synthesizedAnswer,
      confidence: session.result.confidence,
      executionTimeMs: session.result.totalDuration,
      iterationsUsed: session.result.iterationCount,
      findingsCount: findings.length,
      evaluationPassed: session.result.evaluation?.passed,
    };
  }

  if (session.status === 'awaiting_user') {
    // Pending action info is now in evaluation.suggestedActions
    response.pendingAction = session.result?.evaluation?.suggestedActions?.[0];
  }

  if (session.status === 'failed') {
    response.error = session.error;
  }

  res.json(response);
});

/**
 * POST /api/agent/:sessionId/respond
 *
 * Respond to a pending user action (circuit breaker trip, clarification, etc.)
 *
 * Body:
 * {
 *   "action": "continue" | "abort" | "retry",
 *   "input": "optional user input"
 * }
 */
router.post('/:sessionId/respond', async (req, res) => {
  const { sessionId } = req.params;
  const { action, input } = req.body;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  if (session.status !== 'awaiting_user') {
    return res.status(400).json({
      success: false,
      error: 'Session is not awaiting user input',
      currentStatus: session.status,
    });
  }

  if (!['continue', 'abort', 'retry'].includes(action)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid action. Must be: continue, abort, or retry',
    });
  }

  try {
    // Resume the orchestrator with user response
    session.status = 'running';

    if (action === 'abort') {
      session.status = 'failed';
      session.error = 'User aborted the analysis';
      broadcastToClients(sessionId, {
        type: 'error',
        content: { message: 'Analysis aborted by user' },
        timestamp: Date.now(),
      });
    } else {
      // Continue or retry - resume from checkpoint
      // Note: User input is currently not passed through as the MasterOrchestrator
      // resumes from the last checkpoint. Future enhancement could pass context.
      const traceProcessorService = getTraceProcessorService();
      resumeAnalysis(sessionId, session.traceId, traceProcessorService).catch((err) => {
        session.logger.error('Respond', 'Resume after user response failed', err);
      });
    }

    res.json({
      success: true,
      sessionId,
      status: session.status,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
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

  sessions.delete(sessionId);

  // Also clean up from session store
  getSessionStore().deleteSession(sessionId);

  res.json({ success: true });
});

/**
 * GET /api/agent/sessions
 *
 * List all active and recoverable sessions
 */
router.get('/sessions', async (req, res) => {
  try {
    const store = getSessionStore();

    // Get all sessions from store
    const allSessions = await store.listSessions();

    // Get active in-memory sessions
    const activeSessions: any[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      activeSessions.push({
        sessionId,
        status: session.status,
        traceId: session.traceId,
        query: session.query,
        createdAt: session.createdAt,
        isActive: true,
      });
    }

    // Get recoverable sessions from store
    const recoverableSessions = allSessions
      .filter((s: any) => s.phase !== 'completed' && s.phase !== 'failed')
      .filter((s: any) => !sessions.has(s.sessionId))
      .map((s: any) => ({
        sessionId: s.sessionId,
        status: s.phase,
        traceId: s.metadata?.traceId,
        query: s.metadata?.query,
        createdAt: s.startedAt,
        isActive: false,
        canResume: true,
      }));

    res.json({
      success: true,
      activeSessions,
      recoverableSessions,
      totalActive: activeSessions.length,
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
 * Resume a session from checkpoint
 *
 * Body:
 * {
 *   "sessionId": "session-xxx"
 * }
 */
router.post('/resume', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    // Check if session is already active
    if (sessions.has(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'Session is already active',
        hint: 'Use the stream endpoint to monitor progress',
      });
    }

    // Try to recover session from store
    const store = getSessionStore();
    const sessionData = await store.getSession(sessionId);

    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: 'Session not found in store',
      });
    }

    const traceId = sessionData.metadata?.traceId;
    const query = sessionData.metadata?.query;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'Session metadata missing traceId',
      });
    }

    // Verify trace still exists
    const traceProcessorService = getTraceProcessorService();
    const trace = traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace no longer available',
        hint: 'Please re-upload the trace and start a new analysis',
      });
    }

    // Initialize tools
    ensureToolsRegistered();

    // Create new orchestrator and resume
    const orchestrator = createMasterOrchestrator({
      maxTotalIterations: 5,
      stateMachineConfig: { sessionId, traceId }, // Reuse the same session ID
      evaluationCriteria: {
        minQualityScore: 0.7,
        minCompletenessScore: 0.6,
        maxContradictions: 0,
        requiredAspects: [],
      },
      enableTraceRecording: true,
    });

    // Create logger for resumed session
    const logger = createSessionLogger(sessionId);
    logger.setMetadata({ traceId, query, resumed: true });
    logger.info('AgentRoutes', 'Resuming session from checkpoint');

    // Store session
    sessions.set(sessionId, {
      orchestrator,
      sessionId,
      sseClients: [],
      status: 'pending',
      traceId,
      query: query || 'Resumed analysis',
      createdAt: Date.now(),
      logger,
    });

    // Resume analysis in background - pass traceProcessorService for Skill execution
    resumeAnalysis(sessionId, traceId, traceProcessorService).catch((error) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.logger.error('AgentRoutes', 'Resume failed', error);
        session.status = 'failed';
        session.error = error.message;
        broadcastToClients(sessionId, {
          type: 'error',
          content: { message: error.message },
          timestamp: Date.now(),
        });
      }
    });

    res.json({
      success: true,
      sessionId,
      message: 'Resuming analysis from checkpoint',
    });
  } catch (error: any) {
    console.error('[AgentRoutes] Resume error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to resume session',
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
  const findings = extractFindings(result);
  const suggestions = extractSuggestions(result);

  // Generate simplified report data
  const report = {
    sessionId,
    traceId: session.traceId,
    query: session.query,
    createdAt: session.createdAt,
    completedAt: Date.now(),

    summary: {
      answer: result.synthesizedAnswer,
      confidence: result.confidence,
      executionTimeMs: result.totalDuration,
      iterationsUsed: result.iterationCount,
    },

    findings: findings.map((f) => ({
      id: f.id,
      category: f.category,
      severity: f.severity,
      title: f.title,
      description: f.description,
    })),

    suggestions,

    evaluation: result.evaluation ? {
      passed: result.evaluation.passed,
      qualityScore: result.evaluation.qualityScore,
      completenessScore: result.evaluation.completenessScore,
    } : null,

    pipeline: {
      stagesCompleted: result.stageResults?.length || 0,
      totalStages: result.plan?.tasks?.length || 0,
    },

    // Log file path for debugging
    logFile: session.logger.getLogFilePath(),
  };

  res.json({
    success: true,
    report,
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

async function runAnalysis(
  sessionId: string,
  query: string,
  traceId: string,
  options: any = {}
) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const { logger } = session;
  session.status = 'running';
  logger.info('Analysis', 'Starting analysis', { query, traceId, options });

  // Set up streaming via event listener on orchestrator
  const handleUpdate = (update: StreamingUpdate) => {
    console.log(`[AgentRoutes.handleUpdate] Received event: ${update.type}`);
    logger.debug('Stream', `Update: ${update.type}`, update.content);
    broadcastToClients(sessionId, update);

    // Check for error type with awaiting_user context
    if (update.type === 'error' && update.content?.type === 'circuit_tripped') {
      session.status = 'awaiting_user';
      logger.warn('Analysis', 'Awaiting user input (circuit breaker)', update.content);
    }
  };

  // Listen to orchestrator events
  session.orchestrator.on('update', handleUpdate);

  try {
    console.log('[AgentRoutes] Starting orchestrator.handleQuery...');
    const result = await logger.timed('Analysis', 'handleQuery', async () => {
      return session.orchestrator.handleQuery(query, traceId, options);
    });
    console.log('[AgentRoutes] handleQuery completed, result sessionId:', result?.sessionId);

    session.result = result;

    // Check if result indicates awaiting user input
    if (result.canResume && result.evaluation?.suggestedActions?.length > 0) {
      session.status = 'awaiting_user';
    } else {
      session.status = 'completed';
    }

    const findings = extractFindings(result);

    // Log completion details
    logger.info('Analysis', 'Analysis completed', {
      confidence: result.confidence,
      iterationsUsed: result.iterationCount,
      findingsCount: findings.length,
      evaluationPassed: result.evaluation?.passed,
    });

    // Send final result
    const clientCount = session.sseClients.length;
    logger.info('AgentRoutes', 'Sending final result', { clientCount, hasResult: !!result });
    console.log('[AgentRoutes] Preparing to send final result to', clientCount, 'clients');

    if (clientCount === 0) {
      logger.warn('AgentRoutes', 'No SSE clients connected - result will not be sent!', {
        sessionId,
        status: session.status,
      });
    }

    const sendContext = {
      sessionId: session.sessionId,
      traceId: session.traceId,
      query: session.query,
    };
    session.sseClients.forEach((client, index) => {
      try {
        logger.info('AgentRoutes', `Sending result to client ${index + 1}/${clientCount}`);
        console.log('[AgentRoutes] Calling sendResult for client...');
        sendResult(client, result, sendContext);
        client.write(`event: end\n`);
        client.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
        logger.info('AgentRoutes', `Result sent successfully to client ${index + 1}`);
        console.log('[AgentRoutes] sendResult completed');
      } catch (e: any) {
        logger.error('AgentRoutes', `Error sending result to client ${index + 1}`, e);
        console.error('[AgentRoutes] Error sending result to client:', e);
      }
    });

    logger.close();
  } catch (error: any) {
    session.status = 'failed';
    session.error = error.message;
    logger.error('Analysis', 'Analysis failed', error);

    broadcastToClients(sessionId, {
      type: 'error',
      content: { message: error.message },
      timestamp: Date.now(),
    });

    logger.close();
    throw error;
  }
}

async function resumeAnalysis(sessionId: string, traceId: string, traceProcessorService?: any) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const { logger } = session;
  session.status = 'running';
  logger.info('Analysis', 'Resuming analysis from checkpoint', { traceId });

  // Set up streaming via event listener on orchestrator
  const handleUpdate = (update: StreamingUpdate) => {
    logger.debug('Stream', `Resume update: ${update.type}`, update.content);
    broadcastToClients(sessionId, update);

    if (update.type === 'error' && update.content?.type === 'circuit_tripped') {
      session.status = 'awaiting_user';
      logger.warn('Analysis', 'Awaiting user input during resume', update.content);
    }
  };

  session.orchestrator.on('update', handleUpdate);

  try {
    const result = await logger.timed('Analysis', 'resumeFromCheckpoint', async () => {
      return session.orchestrator.resumeFromCheckpoint(sessionId, { traceProcessorService });
    });

    session.result = result;

    // Check if result indicates awaiting user input
    if (result.canResume && result.evaluation?.suggestedActions?.length > 0) {
      session.status = 'awaiting_user';
    } else {
      session.status = 'completed';
    }

    const findings = extractFindings(result);

    logger.info('Analysis', 'Resumed analysis completed', {
      confidence: result.confidence,
      iterationsUsed: result.iterationCount,
      findingsCount: findings.length,
    });

    const sendContext = {
      sessionId: session.sessionId,
      traceId: session.traceId,
      query: session.query,
    };
    session.sseClients.forEach((client) => {
      try {
        sendResult(client, result, sendContext);
        client.write(`event: end\n`);
        client.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
      } catch {}
    });

    logger.close();
  } catch (error: any) {
    session.status = 'failed';
    session.error = error.message;
    logger.error('Analysis', 'Resume failed', error);

    broadcastToClients(sessionId, {
      type: 'error',
      content: { message: error.message },
      timestamp: Date.now(),
    });

    logger.close();
    throw error;
  }
}

function broadcastToClients(sessionId: string, update: StreamingUpdate) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const eventType = update.type;
  const eventData = JSON.stringify({
    type: update.type,
    data: update.content,
    timestamp: update.timestamp,
  });

  // Debug logging for skill_data events
  if (eventType === 'skill_data') {
    console.log(`[AgentRoutes.broadcastToClients] Broadcasting skill_data event:`, {
      sessionId,
      clientCount: session.sseClients.length,
      contentKeys: update.content ? Object.keys(update.content) : [],
      hasLayers: !!(update.content as any)?.layers,
      overviewKeys: (update.content as any)?.layers?.overview ? Object.keys((update.content as any).layers.overview) : [],
      listKeys: (update.content as any)?.layers?.list ? Object.keys((update.content as any).layers.list) : [],
      deepKeys: (update.content as any)?.layers?.deep ? Object.keys((update.content as any).layers.deep) : [],
    });
  }

  session.sseClients.forEach((client) => {
    try {
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${eventData}\n\n`);
    } catch {}
  });
}

interface SendResultContext {
  sessionId: string;
  traceId: string;
  query: string;
}

function sendResult(res: express.Response, result: MasterOrchestratorResult, context: SendResultContext) {
  console.log('[AgentRoutes.sendResult] Starting, sessionId:', context.sessionId);
  const findings = extractFindings(result);
  const suggestions = extractSuggestions(result);
  console.log('[AgentRoutes.sendResult] Extracted', findings.length, 'findings and', suggestions.length, 'suggestions');

  // Generate HTML report
  let reportUrl: string | undefined;
  try {
    console.log('[AgentRoutes.sendResult] Generating HTML report...');
    const generator = getHTMLReportGenerator();
    const html = generator.generateMasterAgentHTML({
      traceId: context.traceId,
      query: context.query,
      result,
      timestamp: Date.now(),
    });

    // Store report
    const reportId = `agent-report-${context.sessionId}`;
    reportStore.set(reportId, {
      html,
      generatedAt: Date.now(),
      sessionId: context.sessionId,
    });

    // Generate report URL (relative path that works with any host)
    reportUrl = `/api/reports/${reportId}`;
    console.log(`[AgentRoutes] Generated HTML report: ${reportId}`);
  } catch (error) {
    console.error('[AgentRoutes] Failed to generate HTML report:', error);
  }

  // Send analysis_completed event with full result
  res.write(`event: analysis_completed\n`);
  res.write(`data: ${JSON.stringify({
    type: 'analysis_completed',
    data: {
      answer: result.synthesizedAnswer,
      confidence: result.confidence,
      executionTimeMs: result.totalDuration,
      iterationsUsed: result.iterationCount,
      findings: findings.map((f) => ({
        id: f.id,
        category: f.category,
        severity: f.severity,
        title: f.title,
        description: f.description,
        // Include full data for timeline navigation
        timestampsNs: f.timestampsNs,
        evidence: f.evidence,
        details: f.details,
        recommendations: f.recommendations,
        confidence: f.confidence,
      })),
      suggestions,
      evaluation: result.evaluation ? {
        passed: result.evaluation.passed,
        qualityScore: result.evaluation.qualityScore,
        completenessScore: result.evaluation.completenessScore,
      } : null,
      pipeline: {
        stagesCompleted: result.stageResults?.length || 0,
        totalStages: result.plan?.tasks?.length || 0,
      },
      reportUrl,
    },
    timestamp: Date.now(),
  })}\n\n`);
  console.log('[AgentRoutes.sendResult] Wrote analysis_completed event with reportUrl:', reportUrl);
}

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
