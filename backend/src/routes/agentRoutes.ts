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
  // Agent-Driven Architecture (Phase 2-4)
  AgentDrivenOrchestrator,
  createAgentDrivenOrchestrator,
  AgentDrivenAnalysisResult,
  ModelRouter,
  Hypothesis,
} from '../agent';
import {
  deriveConclusionContract,
  normalizeConclusionOutput,
  shouldNormalizeConclusionOutput,
} from '../agent/core/conclusionGenerator';
import { sanitizeNarrativeForClient } from './narrativeSanitizer';
// Agent-Driven Architecture v2.0 - Intervention & Focus
import type { UserDecision, AnalysisDirective } from '../agent/core/interventionController';
import type { FocusInteraction } from '../agent/context/focusStore';
// DataEnvelope types for v2.0 data contract
import {
  generateEventId,
  isDataEvent,
  isLegacySkillEvent,
  type DataEnvelope,
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
// Teaching Module Types & Config (v2.0 - centralized)
import {
  validateActiveProcesses,
  validateConfidence,
  parseCandidates,
  parseFeatures,
  transformPinInstruction,
  transformTeachingContent,
  type ActiveProcess,
  type PinInstructionResponse,
  type RawPinInstruction,
} from '../types/teaching.types';
import {
  TEACHING_CONFIG,
  TEACHING_DEFAULTS,
  TEACHING_LIMITS,
  TEACHING_STEP_IDS,
  TEACHING_FEATURES,
} from '../config/teaching.config';

const router = express.Router();

// ============================================================================
// Session Tracking (Agent-Driven)
// ============================================================================

interface AnalysisSession {
  orchestrator: AgentDrivenOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
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
  // Optional scene reconstruction artifacts (unified into agent-driven sessions)
  scenes?: DetectedScene[];
  trackEvents?: TrackEvent[];
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

// =============================================================================
// Scene Reconstruction Types (kept for backward-compatible API responses)
// =============================================================================

type SceneCategory =
  | 'cold_start'
  | 'warm_start'
  | 'hot_start'
  | 'scroll'
  | 'inertial_scroll'
  | 'navigation'
  | 'app_switch'
  | 'screen_unlock'
  | 'notification'
  | 'split_screen'
  | 'tap'
  | 'long_press'
  | 'idle'
  | 'jank_region';  // Fallback: regions with performance issues (derived from jank_events)

interface DetectedScene {
  type: SceneCategory;
  startTs: string;
  endTs: string;
  durationMs: number;
  confidence: number;
  appPackage?: string;
  metadata?: Record<string, any>;
}

interface TrackEvent {
  ts: string;
  dur: string;
  name: string;
  category: 'scene' | 'action' | 'performance' | 'finding';
  colorScheme: 'scroll' | 'tap' | 'launch' | 'system' | 'jank' | 'navigation';
  details?: Record<string, any>;
}

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
    const conclusion = normalizeNarrativeForClient(session.result.conclusion);
    const conclusionContract =
      session.result.conclusionContract ||
      deriveConclusionContract(conclusion, {
        mode: session.result.rounds > 1 ? 'focused_answer' : 'initial_report',
      }) ||
      undefined;
    response.result = {
      conclusion,
      conclusionContract,
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

// =============================================================================
// Agent-Driven Architecture v2.0 - Intervention & Focus Endpoints
// =============================================================================

/**
 * POST /api/agent/:sessionId/intervene
 *
 * Handle user intervention response during analysis.
 * Called when the frontend receives an 'intervention_required' event and
 * the user selects an option.
 *
 * Request body:
 * {
 *   interventionId: string,    // ID from intervention_required event
 *   action: 'continue' | 'focus' | 'abort' | 'custom' | 'select_option',
 *   selectedOptionId?: string, // ID of selected option
 *   customInput?: string,      // User's custom input (for action='custom')
 *   params?: Record<string, any> // Additional parameters
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   directive?: AnalysisDirective  // How analysis should proceed
 * }
 */
router.post('/:sessionId/intervene', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const { interventionId, action, selectedOptionId, customInput, params } = req.body;

  // Validate required fields
  if (!interventionId || typeof interventionId !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'interventionId is required',
    });
  }

  const allowedActions = new Set(['continue', 'focus', 'abort', 'custom', 'select_option']);
  if (!action || !allowedActions.has(action)) {
    return res.status(400).json({
      success: false,
      error: `Invalid action: ${String(action)}. Allowed: ${Array.from(allowedActions).join(', ')}`,
    });
  }

  try {
    const interventionController = session.orchestrator.getInterventionController();

    // Check if there's a pending intervention
    if (!interventionController.hasPendingIntervention(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'No pending intervention for this session',
      });
    }

    // Build user decision
    const decision: UserDecision = {
      interventionId,
      action,
      selectedOptionId,
      customInput,
      params,
    };

    // Process the decision (interventionId is used internally to find the session)
    const directive = interventionController.handleUserDecision(decision);

    // Update session status if needed
    if (directive.action === 'abort') {
      session.status = 'failed';
      session.error = 'Aborted by user intervention';
    } else if (session.status === 'awaiting_user') {
      session.status = 'running';
    }

    return res.json({
      success: true,
      sessionId,
      directive,
    });
  } catch (error: any) {
    console.error(`[Intervene] Error processing intervention for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process intervention',
    });
  }
});

/**
 * POST /api/agent/:sessionId/interaction
 *
 * Record user interaction from the frontend.
 * Used to update the FocusStore for incremental analysis support.
 *
 * Request body:
 * {
 *   type: 'click' | 'query' | 'drill_down' | 'compare' | 'extend' | 'explicit',
 *   target: {
 *     entityType?: 'frame' | 'process' | 'thread' | 'session',
 *     entityId?: string,
 *     timeRange?: { start: string, end: string },  // ns as string
 *     metricName?: string,
 *     question?: string
 *   },
 *   context?: Record<string, any>  // Additional context
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   focusCount: number  // Current number of tracked focuses
 * }
 */
router.post('/:sessionId/interaction', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const { type, target, context } = req.body;

  // Validate type
  const allowedTypes = new Set(['click', 'query', 'drill_down', 'compare', 'extend', 'explicit']);
  if (!type || !allowedTypes.has(type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid interaction type: ${String(type)}. Allowed: ${Array.from(allowedTypes).join(', ')}`,
    });
  }

  // Validate target
  if (!target || typeof target !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'target is required and must be an object',
    });
  }

  try {
    // Convert timeRange strings to BigInt if present
    const processedTarget = { ...target };
    if (target.timeRange) {
      processedTarget.timeRange = {
        start: BigInt(target.timeRange.start),
        end: BigInt(target.timeRange.end),
      };
    }

    // Build interaction
    const interaction: FocusInteraction = {
      type,
      target: processedTarget,
      source: 'ui',
      timestamp: Date.now(),
      context,
    };

    // Record the interaction
    session.orchestrator.recordUserInteraction(interaction);

    // Get current focus count
    const focusStore = session.orchestrator.getFocusStore();
    const focusCount = focusStore.getTopFocuses(100).length;

    return res.json({
      success: true,
      sessionId,
      focusCount,
    });
  } catch (error: any) {
    console.error(`[Interaction] Error recording interaction for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to record interaction',
    });
  }
});

/**
 * GET /api/agent/:sessionId/focus
 *
 * Get current user focus state for a session.
 * Useful for debugging and displaying focus indicators in the UI.
 *
 * Query params:
 * - limit: Max number of focuses to return (default: 10)
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   focuses: UserFocus[],
 *   context: string  // LLM-ready focus context summary
 * }
 */
router.get('/:sessionId/focus', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const focusStore = session.orchestrator.getFocusStore();

    // Get top focuses
    const focuses = focusStore.getTopFocuses(limit).map(f => ({
      id: f.id,
      type: f.type,
      target: {
        ...f.target,
        // Convert BigInt to string for JSON serialization
        ...(f.target.timeRange && {
          timeRange: {
            start: String(f.target.timeRange.start),
            end: String(f.target.timeRange.end),
          },
        }),
      },
      weight: f.weight,
      lastInteractionTime: f.lastInteractionTime,
      interactionCount: f.interactionHistory.length,
    }));

    // Get LLM-ready context
    const context = focusStore.buildFocusContext();

    return res.json({
      success: true,
      sessionId,
      focuses,
      context,
    });
  } catch (error: any) {
    console.error(`[Focus] Error getting focus for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get focus state',
    });
  }
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

    // Security/consistency: long-term memory is scoped to the same trace.
    // Reject attempts to resume a session against a different trace.
    if (traceId && traceId !== persistedSession.traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId mismatch for resume',
        hint: `This session was created for traceId=${persistedSession.traceId}. Upload/choose that trace to resume.`,
        code: 'TRACE_ID_MISMATCH',
      });
    }

    // Use persisted traceId (or request-provided when identical).
    const effectiveTraceId = persistedSession.traceId;

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

	    // Inject the restored context into the session context manager (preserves internal state)
	    sessionContextManager.set(sessionId, effectiveTraceId, restoredContext);

	    // Create a new orchestrator for this session
	    const modelRouter = getModelRouter();
	    const orchestrator = createAgentDrivenOrchestrator(modelRouter, {
	      enableLogging: true,
	    });

	    // Restore FocusStore (if present) so focus-aware incremental planning survives restarts
	    const focusSnapshot = persistenceService.loadFocusStore(sessionId);
	    if (focusSnapshot) {
	      orchestrator.getFocusStore().loadSnapshot(focusSnapshot);
	      orchestrator.getFocusStore().syncWithEntityStore(restoredContext.getEntityStore());
	    }

	    // Restore TraceAgentState (if present) for goal-driven continuity across restarts.
	    const traceAgentStateSnapshot = persistenceService.loadTraceAgentState(sessionId);
	    if (traceAgentStateSnapshot) {
	      restoredContext.setTraceAgentState(traceAgentStateSnapshot);
	    }

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

	    return res.json({
	      success: true,
	      sessionId,
	      traceId: effectiveTraceId,
	      status: 'completed',
	      message: 'Session restored from persistence',
	      restored: true,
	      restoredStats: {
	        turnCount: restoredContext.getAllTurns().length,
	        entityStore: restoredContext.getEntityStore().getStats(),
	        focusStore: focusSnapshot ? orchestrator.getFocusStore().getStats() : null,
	        traceAgentState: traceAgentStateSnapshot
	          ? {
	              version: traceAgentStateSnapshot.version,
	              updatedAt: traceAgentStateSnapshot.updatedAt,
	              turns: Array.isArray(traceAgentStateSnapshot.turnLog) ? traceAgentStateSnapshot.turnLog.length : 0,
	              goal: traceAgentStateSnapshot.goal?.normalizedGoal || traceAgentStateSnapshot.goal?.userGoal || '',
	            }
	          : null,
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

    const deepAnalysis = options.deepAnalysis ?? true;
    const generateTracks = options.generateTracks ?? true;

    // Scene reconstruction always uses the agent-driven orchestrator (unified architecture).
    // Use a query string that triggers the scene reconstruction strategy.
    const query = deepAnalysis ? '场景还原' : '场景还原 仅检测';

    // Generate analysis ID (also used as agent-driven sessionId for compatibility)
    const analysisId = `scene-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const modelRouter = getModelRouter();
    const orchestrator = createAgentDrivenOrchestrator(modelRouter, {
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

    sessions.set(analysisId, {
      orchestrator,
      sessionId: analysisId,
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
      scenes: [],
      trackEvents: [],
    });

    // Start analysis in background
    runAgentDrivenAnalysis(analysisId, query, traceId, {
      ...options,
      generateTracks,
      traceProcessorService,
    }).catch((error) => {
      console.error(`[AgentRoutes] Scene reconstruction (agent-driven) error for ${analysisId}:`, error);
      const session = sessions.get(analysisId);
      if (session) {
        session.logger.error('AgentRoutes', 'Scene reconstruction failed', error);
        session.status = 'failed';
        session.error = error.message;
        broadcastToAgentDrivenClients(analysisId, {
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

/**
 * GET /api/agent/scene-reconstruct/:analysisId/stream
 *
 * SSE endpoint for real-time scene reconstruction updates
 */
router.get('/scene-reconstruct/:analysisId/stream', (req, res) => {
  const { analysisId } = req.params;

  const session = sessions.get(analysisId);
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
  res.write(`data: ${JSON.stringify({
    analysisId,
    sessionId: analysisId,
    status: session.status,
    traceId: session.traceId,
    query: session.query,
    architecture: 'agent-driven',
    timestamp: Date.now(),
  })}\n\n`);

  // Add client to session
  session.sseClients.push(res);
  console.log(`[AgentRoutes] Scene SSE client connected for ${analysisId}`);

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

  const session = sessions.get(analysisId);
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

  const session = sessions.get(analysisId);
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
    const narrative = normalizeNarrativeForClient(session.result.conclusion);
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

/**
 * DELETE /api/agent/scene-reconstruct/:analysisId
 *
 * Clean up a scene reconstruction session
 */
router.delete('/scene-reconstruct/:analysisId', (req, res) => {
  const { analysisId } = req.params;

  const session = sessions.get(analysisId);
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

  session.orchestrator.reset();
  sessions.delete(analysisId);

  res.json({ success: true });
});

// ============================================================================
// Quick Scene Detection Endpoint (Phase 1 only)
// ============================================================================

/**
 * POST /api/agent/scene-detect-quick
 *
 * Quick scene detection - only runs Phase 1 (scene detection) without deep analysis.
 * Used for scene navigation bar that auto-appears on trace load.
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "scenes": DetectedScene[]
 * }
 */
router.post('/scene-detect-quick', async (req, res) => {
  try {
    const { traceId } = req.body;

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

    console.log('[AgentRoutes] Quick scene detection for traceId:', traceId);

    // Execute quick scene detection SQL queries directly
    const scenes = await detectScenesQuick(traceProcessorService, traceId);

    console.log('[AgentRoutes] Quick scene detection complete:', scenes.length, 'scenes');

    res.json({
      success: true,
      scenes,
    });
  } catch (error: any) {
    console.error('[AgentRoutes] Quick scene detection error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Quick scene detection failed',
    });
  }
});

// ============================================================================
// Scene Detection Cache + Parallel Helpers
// ============================================================================

const sceneCache = new Map<string, { scenes: DetectedScene[]; timestamp: number }>();
const SCENE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/** Detect app startups from android_startups stdlib view */
async function detectStartups(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const result = await tps.query(traceId, `
    SELECT
      ts,
      dur,
      package,
      startup_type,
      CAST(dur / 1000000 AS INT) AS dur_ms
    FROM android_startups
    WHERE dur > 0
    ORDER BY ts
  `);

  const scenes: DetectedScene[] = [];
  if (result.rows) {
    for (const row of result.rows) {
      const [ts, dur, pkg, startupType, durMs] = row;
      let sceneType: SceneCategory = 'cold_start';
      if (startupType === 'warm') sceneType = 'warm_start';
      else if (startupType === 'hot') sceneType = 'hot_start';

      scenes.push({
        type: sceneType,
        startTs: String(ts),
        endTs: String(BigInt(ts) + BigInt(dur)),
        durationMs: Number(durMs),
        confidence: 0.95,
        appPackage: pkg,
        metadata: { startupType },
      });
    }
  }
  return scenes;
}

/** Detect scroll sessions from input events + frame timeline */
async function detectScrollSessions(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const scrollResult = await tps.query(traceId, `
    WITH
    input_exists AS (
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'android_input_events'
      )
    ),
    motion_events AS (
      SELECT
        read_time AS ts,
        event_action
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND EXISTS (SELECT ok FROM input_exists)
    ),
    gesture_markers AS (
      SELECT
        ts,
        event_action,
        SUM(CASE WHEN event_action = 'DOWN' THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS gesture_id
      FROM motion_events
    ),
    gestures AS (
      SELECT
        gesture_id,
        MIN(ts) AS down_ts,
        MAX(CASE WHEN event_action = 'UP' THEN ts ELSE NULL END) AS up_ts,
        COUNT(*) AS event_count
      FROM gesture_markers
      WHERE gesture_id > 0
      GROUP BY gesture_id
      HAVING COUNT(*) >= 4
    ),
    frame_with_stats AS (
      SELECT
        ts,
        dur,
        ts + dur AS frame_end,
        jank_type,
        COALESCE(LEAD(ts) OVER (ORDER BY ts) - (ts + dur), 999999999) AS gap_to_next
      FROM actual_frame_timeline_slice
      WHERE surface_frame_token IS NOT NULL AND dur > 0
    ),
    scroll_sessions AS (
      SELECT
        g.gesture_id,
        g.down_ts AS start_ts,
        COALESCE(
          (SELECT MIN(f.frame_end)
           FROM frame_with_stats f
           WHERE f.ts >= g.up_ts AND f.gap_to_next > 100000000),
          g.up_ts + 500000000
        ) AS end_ts
      FROM gestures g
      WHERE g.up_ts IS NOT NULL
    )
    SELECT
      s.start_ts,
      s.end_ts,
      CAST((s.end_ts - s.start_ts) / 1000000 AS INT) AS dur_ms,
      (SELECT COUNT(*) FROM frame_with_stats f WHERE f.ts >= s.start_ts AND f.frame_end <= s.end_ts) AS frame_count
    FROM scroll_sessions s
    WHERE s.end_ts > s.start_ts + 100000000
    ORDER BY s.start_ts
  `);

  const scenes: DetectedScene[] = [];
  if (scrollResult.rows) {
    for (const row of scrollResult.rows) {
      const [startTs, endTs, durMs, frameCount] = row;
      if (Number(frameCount) >= 3) {
        const fps = (Number(frameCount) * 1000) / Math.max(Number(durMs), 1);
        scenes.push({
          type: 'scroll',
          startTs: String(startTs),
          endTs: String(endTs),
          durationMs: Number(durMs),
          confidence: 0.85,
          metadata: {
            frameCount: Number(frameCount),
            averageFps: Math.round(fps * 10) / 10,
          },
        });
      }
    }
  }
  return scenes;
}

/** Detect tap/click events from input events */
async function detectTapEvents(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const tapResult = await tps.query(traceId, `
    WITH
    input_exists AS (
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'android_input_events'
      )
    ),
    motion_events AS (
      SELECT
        read_time AS ts,
        event_action
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND EXISTS (SELECT ok FROM input_exists)
    ),
    tap_events AS (
      SELECT
        ts AS down_ts,
        LEAD(ts) OVER (ORDER BY ts) AS up_ts,
        event_action
      FROM motion_events
      WHERE event_action IN ('DOWN', 'UP')
    )
    SELECT
      down_ts AS start_ts,
      up_ts AS end_ts,
      CAST((up_ts - down_ts) / 1000000 AS INT) AS dur_ms
    FROM tap_events
    WHERE event_action = 'DOWN'
      AND up_ts IS NOT NULL
      AND (up_ts - down_ts) < 300000000
    ORDER BY down_ts
    LIMIT 50
  `);

  const scenes: DetectedScene[] = [];
  if (tapResult.rows) {
    for (const row of tapResult.rows) {
      const [startTs, endTs, durMs] = row;
      scenes.push({
        type: 'tap',
        startTs: String(startTs),
        endTs: String(endTs),
        durationMs: Number(durMs),
        confidence: 0.75,
      });
    }
  }
  return scenes;
}

/**
 * Quick scene detection function - executes minimal SQL queries to detect scenes
 * without full agent overhead. Uses parallel queries and result caching.
 */
async function detectScenesQuick(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string
): Promise<DetectedScene[]> {
  // Check cache first
  const cached = sceneCache.get(traceId);
  if (cached && Date.now() - cached.timestamp < SCENE_CACHE_TTL) {
    console.log('[QuickSceneDetect] Cache hit for traceId:', traceId);
    return cached.scenes;
  }

  const t0 = Date.now();

  // =========================================================================
  // Pre-load Perfetto stdlib modules (parallel)
  // =========================================================================
  // `android_input_events` and `android_startups` are stdlib VIEWS, not
  // intrinsic tables. They only exist after loading the corresponding modules.
  const REQUIRED_MODULES = [
    'android.input',            // Creates android_input_events, android_key_events
    'android.startup.startups', // Creates android_startups
  ];

  await Promise.all(
    REQUIRED_MODULES.map(module =>
      traceProcessorService.query(traceId, `INCLUDE PERFETTO MODULE ${module};`)
        .catch(e => console.warn(`[QuickSceneDetect] Module not available: ${module}`, e))
    )
  );

  // =========================================================================
  // Run all 3 detection queries in parallel
  // =========================================================================
  const [startupResult, scrollResult, tapResult] = await Promise.allSettled([
    detectStartups(traceProcessorService, traceId),
    detectScrollSessions(traceProcessorService, traceId),
    detectTapEvents(traceProcessorService, traceId),
  ]);

  // Merge results from fulfilled promises
  const scenes: DetectedScene[] = [];
  if (startupResult.status === 'fulfilled') {
    scenes.push(...startupResult.value);
  } else {
    console.warn('[QuickSceneDetect] Startup detection failed:', startupResult.reason);
  }
  if (scrollResult.status === 'fulfilled') {
    scenes.push(...scrollResult.value);
  } else {
    console.warn('[QuickSceneDetect] Scroll detection failed:', scrollResult.reason);
  }
  if (tapResult.status === 'fulfilled') {
    scenes.push(...tapResult.value);
  } else {
    console.warn('[QuickSceneDetect] Tap detection failed:', tapResult.reason);
  }

  // Sort scenes by start timestamp
  scenes.sort((a, b) => {
    const aTs = BigInt(a.startTs);
    const bTs = BigInt(b.startTs);
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  console.log(`[QuickSceneDetect] Completed in ${Date.now() - t0}ms, ${scenes.length} scenes`);

  // Store in cache
  sceneCache.set(traceId, { scenes, timestamp: Date.now() });

  return scenes;
}

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
    const pipelineRow =
      Array.isArray(pipelineStepResult?.data) && pipelineStepResult.data.length > 0
        ? (pipelineStepResult.data[0] as Record<string, any>)
        : null;
    const pipelineResult = pipelineRow
      ? {
          primary_pipeline_id: String(pipelineRow.primary_pipeline_id ?? ''),
          primary_confidence: pipelineRow.primary_confidence,
          candidates_list: pipelineRow.candidates_list,
          features_list: pipelineRow.features_list,
          doc_path: pipelineRow.doc_path,
        }
      : null;

    // Get subvariants (from 'subvariants' step)
    // SQL returns: buffer_mode, flutter_engine, webview_mode, game_engine
    const subvariantsStepResult = rawResults['subvariants'];
    const subvariantsRow =
      Array.isArray(subvariantsStepResult?.data) && subvariantsStepResult.data.length > 0
        ? (subvariantsStepResult.data[0] as Record<string, any>)
        : null;
    const subvariants = subvariantsRow
      ? {
          buffer_mode: String(subvariantsRow.buffer_mode ?? 'UNKNOWN'),
          flutter_engine: String(subvariantsRow.flutter_engine ?? 'N/A'),
          webview_mode: String(subvariantsRow.webview_mode ?? 'N/A'),
          game_engine: String(subvariantsRow.game_engine ?? 'N/A'),
        }
      : null;

    // Get pin instructions (from 'pin_instructions' step)
    const pinInstructionsStepResult = rawResults['pin_instructions'];
    const pinInstructionsData = Array.isArray(pinInstructionsStepResult?.data) ? pinInstructionsStepResult.data : [];

    // Get trace requirements (from 'trace_requirements' step)
    const traceReqStepResult = rawResults['trace_requirements'];
    const traceReqRow =
      Array.isArray(traceReqStepResult?.data) && traceReqStepResult.data.length > 0
        ? (traceReqStepResult.data[0] as Record<string, any>)
        : null;
    const traceRequirementsMissing = traceReqRow
      ? Object.values(traceReqRow).filter((v: any) => typeof v === 'string' && v.trim())
      : [];

    // Get active rendering processes (from 'active_rendering_processes' step - v3 smart pin)
    // v2.0: Use validated extraction with column name mapping instead of positional access
    const activeProcessesStepResult = rawResults[TEACHING_STEP_IDS.activeProcesses];
    const activeRenderingProcesses: ActiveProcess[] = TEACHING_FEATURES.useSqlValidation
      ? validateActiveProcesses(activeProcessesStepResult)
      : (Array.isArray(activeProcessesStepResult?.data)
          ? activeProcessesStepResult.data
              .map((row: any) => ({
                upid: typeof row?.upid === 'number' ? row.upid : parseInt(String(row?.upid ?? ''), 10) || 0,
                processName: String(row?.process_name ?? row?.processName ?? row?.name ?? ''),
                frameCount:
                  typeof row?.frame_count === 'number'
                    ? row.frame_count
                    : parseInt(String(row?.frame_count ?? row?.frameCount ?? row?.count ?? ''), 10) || 0,
                renderThreadTid:
                  typeof row?.render_thread_tid === 'number'
                    ? row.render_thread_tid
                    : parseInt(String(row?.render_thread_tid ?? row?.renderThreadTid ?? row?.tid ?? ''), 10) || 0,
              }))
              .filter((p) => p.processName)
          : (activeProcessesStepResult?.data?.rows?.map((row: unknown[]) => ({
              upid: row[0] as number,
              processName: row[1] as string,
              frameCount: row[2] as number,
              renderThreadTid: row[3] as number,
            })) || []));

    if (TEACHING_FEATURES.debugLogging) {
      console.log('[AgentRoutes] Active rendering processes:', activeRenderingProcesses.map((p) => `${p.processName} (${p.frameCount} frames)`));
    }

    // Default values from centralized config if skill output is incomplete
    const primaryPipelineId = pipelineResult?.primary_pipeline_id || TEACHING_DEFAULTS.pipelineId;
    const primaryConfidence = validateConfidence(pipelineResult?.primary_confidence, TEACHING_DEFAULTS.confidence);
    const candidatesList = pipelineResult?.candidates_list || '';
    const featuresList = pipelineResult?.features_list || '';
    const docPath = pipelineResult?.doc_path || TEACHING_DEFAULTS.docPath;

    // Parse candidates and features using validated utilities
    const candidates = candidatesList
      ? parseCandidates(candidatesList, TEACHING_LIMITS.maxCandidates)
      : [{ id: primaryPipelineId, confidence: primaryConfidence }];

    const features = parseFeatures(featuresList);

    // Get base pin instructions from PipelineSkillLoader (new data-driven approach)
    // Ensure pipeline skills are loaded
    await ensurePipelineSkillsInitialized();

    // Unified Teaching Content: prioritize YAML skill, fallback to .md documentation
    // YAML provides structured data; .md provides richer content from full documentation
    const yamlTeaching = pipelineSkillLoader.getTeachingContent(primaryPipelineId);
    const pipelineDocService = getPipelineDocService();
    const mdTeaching = pipelineDocService.getTeachingContent(primaryPipelineId);

    // Transform teaching content to frontend-compatible format (camelCase)
    // Priority: YAML > .md > default fallback
    const teachingContent = yamlTeaching
      ? {
          title: yamlTeaching.title,
          summary: yamlTeaching.summary,
          // YAML uses single 'mermaid' string, convert to array for frontend
          mermaidBlocks: yamlTeaching.mermaid ? [yamlTeaching.mermaid] : [],
          // YAML uses snake_case with different structure, convert to frontend format
          threadRoles: yamlTeaching.thread_roles.map(role => ({
            thread: role.thread,
            responsibility: role.role + (role.description ? `: ${role.description}` : ''),
            traceTag: role.trace_tags,
          })),
          // YAML key_slices has name/thread/description, extract names for simple display
          keySlices: yamlTeaching.key_slices.map(slice => slice.name),
          docPath: pipelineSkillLoader.getPipelineMeta(primaryPipelineId)?.doc_path || '',
        }
      : mdTeaching;

    // Get pin instructions from pipeline skill YAML
    const basePinInstructions = pipelineSkillLoader.getAutoPinInstructions(primaryPipelineId);

    // Get smart filter configurations from pipeline skill
    const smartFilterConfigs = pipelineSkillLoader.getSmartFilterConfigs(primaryPipelineId);

    // v4 Smart Pin Enhancement: YAML-driven smart pin based on pipeline skill configuration
    // Each pin instruction can enable smart_filter to request process-filtered pinning.
    // Today SmartPerfetto uses a centralized "active_rendering_processes" query (from
    // rendering_pipeline_detection) and does NOT execute per-instruction detection_sql.
    // If smart_filter.enabled is true, we attach activeProcessNames for frontend filtering.
    //
    // Decision logic per instruction:
    // 1. Check if instruction has smart_filter.enabled = true
    // 2. If smart filter enabled and activeRenderingProcesses has data → smartPin
    // 3. If smart filter enabled and activeRenderingProcesses is empty → skipPin
    // 4. If smart filter not enabled → normal pin

    // v2.0: Use centralized transformation function with type safety
    // Transform pin instructions: convert snake_case to camelCase for frontend compatibility
    const smartPinInstructions: PinInstructionResponse[] = TEACHING_FEATURES.useTypeTransforms
      ? basePinInstructions.map((inst: PinInstruction) => {
          // Check if this instruction has smart_filter enabled (from YAML config)
          // Use single source of truth: smart_filter property on instruction
          const hasSmartFilter = inst.smart_filter?.enabled ?? smartFilterConfigs.has(inst.pattern);

          // Convert to RawPinInstruction format for transformation
          const rawInst: RawPinInstruction = {
            pattern: inst.pattern,
            match_by: inst.match_by,
            priority: inst.priority,
            reason: inst.reason,
            expand: inst.expand,
            main_thread_only: inst.main_thread_only,
            smart_filter: hasSmartFilter ? inst.smart_filter : undefined,
          };

          // Use centralized transformation
          const transformed = transformPinInstruction(rawInst, activeRenderingProcesses);

          // Add active process count to reason for smart pins
          if (transformed.smartPin && !transformed.skipPin) {
            transformed.reason = `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`;
          }

          return transformed;
        })
      : basePinInstructions.map((inst: PinInstruction): PinInstructionResponse => {
          // Legacy transformation (fallback when feature flag is disabled)
          const hasSmartFilter = smartFilterConfigs.has(inst.pattern) || inst.smart_filter?.enabled;
          const hasActiveRenderingData = activeRenderingProcesses.length > 0;
          const activeProcessNames = new Set(activeRenderingProcesses.map((p) => p.processName));

          const baseInstruction: PinInstructionResponse = {
            pattern: inst.pattern,
            matchBy: inst.match_by,
            priority: inst.priority,
            reason: inst.reason,
            expand: inst.expand,
            mainThreadOnly: inst.main_thread_only,
          };

          if (hasSmartFilter) {
            if (hasActiveRenderingData) {
              return {
                ...baseInstruction,
                activeProcessNames: Array.from(activeProcessNames),
                smartPin: true,
                reason: `${inst.reason} (${activeRenderingProcesses.length} 活跃进程)`,
              };
            } else {
              return {
                ...baseInstruction,
                reason: `${inst.reason} (未检测到活跃渲染进程，使用默认 Pin)`,
              };
            }
          }
          return baseInstruction;
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
        trace_requirements_missing: traceRequirementsMissing,
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
  const conclusion = normalizeNarrativeForClient(result.conclusion);
  // Generate simplified report data
  const report = {
    sessionId,
    traceId: session.traceId,
    query: session.query,
    createdAt: session.createdAt,
    completedAt: Date.now(),

    summary: {
      conclusion,
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

  // Track generation is a lightweight derivation step from DataEnvelopes.
  // Enable by default (unless explicitly disabled) so `/api/agent/analyze` can
  // also produce TrackEvent(s) when the scene reconstruction skill runs.
  const shouldGenerateTracks = options.generateTracks !== false;

  // Capture LLM call telemetry into session logs (privacy-safe: hashes + params only)
  const modelRouter = getModelRouter();
  const onLlmTelemetry = (event: any) => {
    if (!event || event.sessionId !== sessionId) return;
    logger.debug('LLM', 'llmTelemetry', event);
  };
  modelRouter.on('llmTelemetry', onLlmTelemetry);

  // Set up streaming via event listener on orchestrator
  const handleUpdate = (update: StreamingUpdate) => {
    console.log(`[AgentRoutes.AgentDriven] Received event: ${update.type}`, update.content?.phase);
    logger.debug('Stream', `Update: ${update.type}`, update.content);

    // Derive TrackEvent(s) for scene reconstruction sessions from emitted DataEnvelopes.
    // This keeps the TrackEvent feature while unifying on the agent-driven architecture.
    if (shouldGenerateTracks && update.type === 'data') {
      const envelopes = (Array.isArray(update.content) ? update.content : [update.content])
        .filter((e): e is DataEnvelope => !!e && typeof e === 'object');
      const changed = updateSceneReconstructionArtifactsFromEnvelopes(session, envelopes);
      if (changed) {
        broadcastToAgentDrivenClients(sessionId, {
          type: 'track_data',
          content: {
            tracks: session.trackEvents || [],
            scenes: session.scenes || [],
          },
          timestamp: update.timestamp,
          id: generateEventId('track_data', sessionId),
        });
      }
    }

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
  if (session.orchestratorUpdateHandler) {
    session.orchestrator.off('update', session.orchestratorUpdateHandler);
  }
  session.orchestratorUpdateHandler = handleUpdate;
  session.orchestrator.on('update', handleUpdate);

  try {
    console.log('[AgentRoutes.AgentDriven] Starting orchestrator.analyze...');
    const result = await logger.timed('AgentDrivenAnalysis', 'analyze', async () => {
      return session.orchestrator.analyze(query, sessionId, traceId, {
        traceProcessorService: options.traceProcessorService,
        packageName: options.packageName,
        timeRange: options.timeRange,
        adb: options.adb,
      });
    });
    console.log('[AgentRoutes.AgentDriven] analyze completed, success:', result.success);

    session.result = result;
    session.hypotheses = result.hypotheses;
    session.status = result.success ? 'completed' : 'failed';

    // Ensure trackEvents/scenes are computed for completed sessions (even without SSE clients)
    if (shouldGenerateTracks) {
      updateSceneReconstructionArtifactsFromEnvelopes(session, session.dataEnvelopes as DataEnvelope[]);
    }

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

	        // Persist FocusStore so focus-aware incremental planning can survive restarts
	        const focusSaved = persistenceService.saveFocusStore(sessionId, session.orchestrator.getFocusStore());
	        if (focusSaved) {
	          logger.info('AgentDrivenAnalysis', 'FocusStore persisted to DB', {
	            sessionId,
	            focusStats: session.orchestrator.getFocusStore().getStats(),
	          });
	        }

	        // Persist TraceAgentState (goal-driven agent scaffold) for cross-restart continuity.
	        const traceAgentState = sessionContext.getTraceAgentState();
	        if (traceAgentState) {
	          const stateSaved = persistenceService.saveTraceAgentState(sessionId, traceAgentState);
	          if (stateSaved) {
	            logger.info('AgentDrivenAnalysis', 'TraceAgentState persisted to DB', {
	              sessionId,
	              version: traceAgentState.version,
	              updatedAt: traceAgentState.updatedAt,
	            });
	          }
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
  } finally {
    // Prevent listener accumulation across multi-turn requests in the same session.
    if (session.orchestratorUpdateHandler) {
      session.orchestrator.off('update', session.orchestratorUpdateHandler);
      if (session.orchestratorUpdateHandler === handleUpdate) {
        session.orchestratorUpdateHandler = undefined;
      }
    }
    modelRouter.off('llmTelemetry', onLlmTelemetry);
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

// =============================================================================
// Scene Reconstruction: Derive scenes + TrackEvent(s) from DataEnvelopes
// =============================================================================

const SCENE_DISPLAY_NAMES: Record<SceneCategory, string> = {
  cold_start: '冷启动',
  warm_start: '温启动',
  hot_start: '热启动',
  scroll: '滑动',
  inertial_scroll: '惯性滑动',
  navigation: '跳转',
  app_switch: '应用切换',
  screen_unlock: '解锁屏幕',
  notification: '通知操作',
  split_screen: '分屏操作',
  tap: '点击',
  long_press: '长按',
  idle: '空闲',
  jank_region: '性能问题区间',
};

const SCENE_COLOR_SCHEMES: Record<SceneCategory, TrackEvent['colorScheme']> = {
  cold_start: 'launch',
  warm_start: 'launch',
  hot_start: 'launch',
  scroll: 'scroll',
  inertial_scroll: 'scroll',
  navigation: 'navigation',
  app_switch: 'system',
  screen_unlock: 'system',
  notification: 'system',
  split_screen: 'system',
  tap: 'tap',
  long_press: 'tap',
  idle: 'system',
  jank_region: 'jank',  // Use jank color to highlight performance issues
};

function updateSceneReconstructionArtifactsFromEnvelopes(
  session: AnalysisSession,
  envelopes: DataEnvelope[]
): boolean {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return false;

  const extractedScenes = extractDetectedScenesFromEnvelopes(envelopes);
  if (extractedScenes.length === 0) return false;

  const mergedScenes = mergeDetectedScenes(session.scenes || [], extractedScenes);
  const mergedTracks = buildTrackEventsFromScenes(mergedScenes);

  const prevFingerprint = fingerprintTrackEvents(session.trackEvents || []);
  const nextFingerprint = fingerprintTrackEvents(mergedTracks);

  session.scenes = mergedScenes;
  session.trackEvents = mergedTracks;

  return prevFingerprint !== nextFingerprint;
}

function extractDetectedScenesFromEnvelopes(envelopes: DataEnvelope[]): DetectedScene[] {
  const scenes: DetectedScene[] = [];
  const jankRowsForFallback: Array<Record<string, any>> = [];

  for (const env of envelopes) {
    if (!env || env.meta?.skillId !== 'scene_reconstruction') continue;

    const stepId = env.meta.stepId || '';
    const rows = payloadToObjectRowsLocal(env.data);
    if (rows.length === 0) continue;

    // Step: app_launches (startup events)
    if (stepId === 'app_launches') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startupType = String(row.startup_type || '').toLowerCase();
        const type: SceneCategory =
          startupType === 'warm' ? 'warm_start'
          : startupType === 'hot' ? 'hot_start'
          : 'cold_start';

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.95,
          appPackage: extractRowAppPackage(row, ['package']),
          metadata: {
            source: 'scene_reconstruction:app_launches',
            startupType: startupType || undefined,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: user_gestures (tap/scroll/long_press)
    if (stepId === 'user_gestures') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const gestureType = String(row.gesture_type || '').toLowerCase();
        const type: SceneCategory =
          gestureType === 'scroll' ? 'scroll'
          : gestureType === 'long_press' ? 'long_press'
          : 'tap';

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: confidenceToScore(row.confidence),
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:user_gestures',
            moveCount: row.move_count,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: inertial_scrolls (fling inertia region after finger up)
    if (stepId === 'inertial_scrolls') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);
        const frameCount = Number(row.frame_count || 0);

        scenes.push({
          type: 'inertial_scroll',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: frameCount >= 12 ? 0.9 : frameCount >= 8 ? 0.8 : 0.7,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:inertial_scrolls',
            frameCount,
            jankFrames: Number(row.jank_frames || 0),
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: idle_periods (no obvious operation gap)
    if (stepId === 'idle_periods') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'idle',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: confidenceToScore(row.confidence),
          metadata: {
            source: 'scene_reconstruction:idle_periods',
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: top_app_changes (app switches)
    if (stepId === 'top_app_changes') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'app_switch',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:top_app_changes',
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: system_events (unlock/notification/split screen)
    if (stepId === 'system_events') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const eventText = String(row.event || '');
        const type = mapSystemEventToSceneType(eventText);
        if (!type) continue;
        // Guardrail: ignore very short unlock slices (usually render/mutex noise).
        if (type === 'screen_unlock' && durNs < 100_000_000n) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.85,
          metadata: {
            source: 'scene_reconstruction:system_events',
            event: eventText,
          },
        });
      }
      continue;
    }

    // Step: jank_events (performance issue regions) - FALLBACK
    // Collected first; only used if no gesture-like scenes are found.
    if (stepId === 'jank_events') {
      jankRowsForFallback.push(...rows);
      continue;
    }
  }

  const hasGestureLikeScene = scenes.some((scene) => (
    scene.type === 'tap' ||
    scene.type === 'scroll' ||
    scene.type === 'long_press' ||
    scene.type === 'inertial_scroll'
  ));

  if (!hasGestureLikeScene && jankRowsForFallback.length > 0) {
    const jankIntervals = aggregateJankFramesToIntervals(jankRowsForFallback);
    for (const interval of jankIntervals) {
      if (interval.jankCount < 3) continue;
      scenes.push({
        type: 'jank_region',
        startTs: interval.startTs,
        endTs: interval.endTs,
        durationMs: interval.durationMs,
        confidence: 0.8,
        metadata: {
          source: 'scene_reconstruction:jank_events',
          jankCount: interval.jankCount,
          severity: interval.severity,
        },
      });
    }
  }

  scenes.sort((a, b) => (BigInt(a.startTs) > BigInt(b.startTs) ? 1 : -1));
  return scenes;
}

// =============================================================================
// Jank Frame Aggregation Helper
// =============================================================================

interface JankInterval {
  startTs: string;
  endTs: string;
  durationMs: number;
  jankCount: number;
  severity: 'severe' | 'mild';
}

/**
 * Aggregates consecutive jank frames into intervals.
 * Adjacent jank frames within 500ms gap are merged into one interval.
 * This creates meaningful analysis targets from scattered jank events.
 */
function aggregateJankFramesToIntervals(rows: Array<Record<string, any>>): JankInterval[] {
  if (!rows.length) return [];

  const MERGE_GAP_NS = 500_000_000n; // 500ms
  const intervals: JankInterval[] = [];

  // Sort by timestamp first
  const sortedRows = [...rows].sort((a, b) => {
    const aTs = toBigInt(a.ts);
    const bTs = toBigInt(b.ts);
    if (aTs === null || bTs === null) return 0;
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  let currentStart = toBigInt(sortedRows[0].ts);
  let currentEnd = currentStart !== null
    ? currentStart + (toBigInt(sortedRows[0].dur) || 0n)
    : null;
  let jankCount = 1;
  let severities: string[] = [String(sortedRows[0].jank_severity_type || '')];

  if (currentStart === null || currentEnd === null) {
    return []; // Invalid first row
  }

  for (let i = 1; i < sortedRows.length; i++) {
    const rowTs = toBigInt(sortedRows[i].ts);
    const rowDur = toBigInt(sortedRows[i].dur) || 0n;

    if (rowTs === null) continue;

    if (rowTs - currentEnd! < MERGE_GAP_NS) {
      // Merge into current interval
      const rowEnd = rowTs + rowDur;
      if (rowEnd > currentEnd!) {
        currentEnd = rowEnd;
      }
      jankCount++;
      severities.push(String(sortedRows[i].jank_severity_type || ''));
    } else {
      // Save current interval and start a new one
      intervals.push({
        startTs: currentStart!.toString(),
        endTs: currentEnd!.toString(),
        durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
        jankCount,
        severity: severities.includes('Full') ? 'severe' : 'mild',
      });
      currentStart = rowTs;
      currentEnd = rowTs + rowDur;
      jankCount = 1;
      severities = [String(sortedRows[i].jank_severity_type || '')];
    }
  }

  // Save the last interval
  intervals.push({
    startTs: currentStart!.toString(),
    endTs: currentEnd!.toString(),
    durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
    jankCount,
    severity: severities.includes('Full') ? 'severe' : 'mild',
  });

  return intervals;
}

function mergeDetectedScenes(existing: DetectedScene[], incoming: DetectedScene[]): DetectedScene[] {
  const merged = new Map<string, DetectedScene>();

  for (const s of existing) merged.set(sceneKey(s), s);
  for (const s of incoming) merged.set(sceneKey(s), s);

  const out = Array.from(merged.values());
  out.sort((a, b) => (BigInt(a.startTs) > BigInt(b.startTs) ? 1 : -1));
  return out;
}

function sceneKey(scene: DetectedScene): string {
  return `${scene.type}:${scene.startTs}:${scene.endTs}:${scene.appPackage || ''}`;
}

function buildTrackEventsFromScenes(scenes: DetectedScene[]): TrackEvent[] {
  return scenes.map((scene) => {
    const displayName = SCENE_DISPLAY_NAMES[scene.type] || scene.type;
    const colorScheme = SCENE_COLOR_SCHEMES[scene.type] || 'system';

    const appName = scene.appPackage
      ? scene.appPackage.replace('com.', '').replace('android.', '')
      : '';

    let name = displayName;
    if (appName) name += ` [${appName}]`;
    if (Number.isFinite(scene.durationMs) && scene.durationMs > 0) name += ` ${scene.durationMs}ms`;

    let dur = '0';
    try {
      dur = (BigInt(scene.endTs) - BigInt(scene.startTs)).toString();
    } catch {}

    return {
      ts: scene.startTs,
      dur,
      name,
      category: 'scene',
      colorScheme,
      details: {
        sceneType: scene.type,
        appPackage: scene.appPackage,
        durationMs: scene.durationMs,
        confidence: scene.confidence,
        ...scene.metadata,
      },
    };
  });
}

function fingerprintTrackEvents(events: TrackEvent[]): string {
  return events.map(e => `${e.ts}:${e.dur}:${e.name}:${e.colorScheme}`).join('|');
}

function payloadToObjectRowsLocal(payload: any): Array<Record<string, any>> {
  if (!payload || typeof payload !== 'object') return [];
  const cols = (payload as any).columns;
  const rows = (payload as any).rows;
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];

  const out: Array<Record<string, any>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const obj: Record<string, any> = {};
    for (let i = 0; i < cols.length; i++) {
      obj[String(cols[i])] = row[i];
    }
    out.push(obj);
  }
  return out;
}

function normalizeNs(value: any): string | null {
  const n = toBigInt(value);
  return n === null ? null : n.toString();
}

function toBigInt(value: any): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (!/^-?\d+$/.test(s)) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function confidenceToScore(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const s = String(value || '').trim();
  if (!s) return 0.85;
  if (s === '高') return 0.9;
  if (s === '中') return 0.7;
  if (s === '低') return 0.5;
  return 0.8;
}

function extractRowAppPackage(row: Record<string, any>, extraFields: string[] = []): string | undefined {
  const candidateFields = ['app_package', 'appPackage', ...extraFields];
  for (const field of candidateFields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const eventApp = extractBracketContent(String(row.event || ''));
  if (eventApp) return eventApp;
  return undefined;
}

function extractBracketContent(text: string): string | null {
  const m = text.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : null;
}

function mapSystemEventToSceneType(eventText: string): SceneCategory | null {
  const e = eventText.trim();
  if (!e) return null;
  // Keep unlock mapping strict; broad substring matching causes false positives.
  if (e === '解锁屏幕' || e.includes('锁屏解锁')) return 'screen_unlock';
  if (e.includes('通知栏') || e.includes('通知')) return 'notification';
  if (e.includes('分屏')) return 'split_screen';
  if (e.includes('Activity')) return 'navigation';
  return null;
}

type ClientFindingPayload = {
  id: string;
  category?: string;
  severity?: string;
  title?: string;
  description?: string;
  timestampsNs?: any;
  evidence?: any;
  details?: any;
  recommendations?: any;
  confidence?: number;
};

function buildClientFindings(
  findings: AgentDrivenAnalysisResult['findings'],
  scenes: DetectedScene[]
): ClientFindingPayload[] {
  const base: ClientFindingPayload[] = (findings || []).map((f: any) => ({
    id: String(f?.id || `finding_${Date.now()}`),
    category: f?.category,
    severity: f?.severity,
    title: f?.title,
    description: f?.description,
    timestampsNs: f?.timestampsNs,
    evidence: f?.evidence,
    details: f?.details,
    recommendations: f?.recommendations,
    confidence: f?.confidence,
  }));

  const hasIssueLikeFinding = base.some((f) => {
    const severity = String(f.severity || '').toLowerCase();
    if (severity === 'critical' || severity === 'high' || severity === 'warning') return true;
    return hasIssueSignalText(`${f.title || ''} ${f.description || ''}`);
  });

  const filtered = hasIssueLikeFinding
    ? base.filter((f) => !isNoIssueText(`${f.title || ''} ${f.description || ''}`))
    : base;

  const derived = deriveSceneIssueFindings(scenes);
  const merged = [...filtered, ...derived];

  const dedup = new Map<string, ClientFindingPayload>();
  for (const f of merged) {
    const key = `${String(f.title || '').trim()}::${String(f.description || '').trim()}`;
    if (!key || key === '::') {
      dedup.set(f.id, f);
      continue;
    }
    if (!dedup.has(key)) dedup.set(key, f);
  }

  return Array.from(dedup.values());
}

function deriveSceneIssueFindings(scenes: DetectedScene[]): ClientFindingPayload[] {
  if (!Array.isArray(scenes) || scenes.length === 0) return [];
  const scrollScenes = scenes.filter((s) => s.type === 'scroll');

  const inertialCandidates = scenes
    .filter((s) => s.type === 'inertial_scroll')
    .map((s) => ({
      scene: s,
      jankFrames: Number((s.metadata as any)?.jankFrames || 0),
    }))
    .filter((item) => item.jankFrames > 0)
    .sort((a, b) => b.jankFrames - a.jankFrames)
    .slice(0, 3);

  const derived: ClientFindingPayload[] = [];
  for (const item of inertialCandidates) {
    const s = item.scene;
    const severity =
      item.jankFrames >= 100 ? 'critical'
        : item.jankFrames >= 40 ? 'warning'
          : 'info';
    const app = s.appPackage || 'unknown';
    const inertialStartNs = toBigInt(s.startTs);
    const inertialEndNs = toBigInt(s.endTs);
    let totalScrollDurationMs = s.durationMs;
    if (inertialStartNs !== null && inertialEndNs !== null) {
      let parentScroll: DetectedScene | null = null;
      let parentStartNs: bigint | null = null;
      for (const scroll of scrollScenes) {
        const startNs = toBigInt(scroll.startTs);
        const endNs = toBigInt(scroll.endTs);
        if (startNs === null || endNs === null) continue;
        if (startNs <= inertialStartNs && endNs >= inertialStartNs) {
          if (!parentScroll || (parentStartNs !== null && startNs > parentStartNs)) {
            parentScroll = scroll;
            parentStartNs = startNs;
          }
        }
      }
      if (parentStartNs !== null && inertialEndNs > parentStartNs) {
        totalScrollDurationMs = Number((inertialEndNs - parentStartNs) / 1_000_000n);
      }
    }

    derived.push({
      id: `scene_inertial_${s.startTs}`,
      category: 'scroll',
      severity,
      title: `惯性滑动卡顿：${item.jankFrames} 帧异常`,
      description: `惯性 ${s.durationMs}ms，总滑动约 ${totalScrollDurationMs}ms，应用 ${app}，建议重点排查滑动后渲染路径`,
      details: {
        sceneType: s.type,
        startTs: s.startTs,
        endTs: s.endTs,
        durationMs: s.durationMs,
        totalScrollDurationMs,
        jankFrames: item.jankFrames,
        source: 'scene_reconstruction:derived',
      },
      confidence: 0.85,
    });
  }

  return derived;
}

function isNoIssueText(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('未发现明显性能问题') ||
    t.includes('整体流畅度良好') ||
    t.includes('分析未发现明显问题')
  );
}

function hasIssueSignalText(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('卡顿') ||
    t.includes('掉帧') ||
    t.includes('缓冲区积压') ||
    t.includes('jank') ||
    t.includes('stutter') ||
    t.includes('deadline missed') ||
    t.includes('renderthread') ||
    t.includes('主线程阻塞')
  );
}

function normalizeNarrativeForClient(narrative: string): string {
  const raw = String(narrative || '');
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  let normalized = raw;
  if (shouldNormalizeConclusionOutput(trimmed)) {
    try {
      normalized = normalizeConclusionOutput(trimmed).trim() || raw;
    } catch {
      normalized = raw;
    }
  }

  return sanitizeNarrativeForClient(normalized) || normalized;
}

/**
 * Send agent-driven analysis result to SSE client
 */
function sendAgentDrivenResult(res: express.Response, session: AnalysisSession) {
  const result = session.result;
  if (!result) return;
  const normalizedConclusion = normalizeNarrativeForClient(result.conclusion);
  // Fallback: re-derive contract if the orchestrator didn't populate it.
  // Note: mode heuristic uses rounds (available here) as proxy for turnCount
  // (which only the orchestrator knows). Both signal "multi-interaction" analysis.
  const normalizedConclusionContract =
    result.conclusionContract ||
    deriveConclusionContract(normalizedConclusion, {
      mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
    }) ||
    undefined;
  const resultForClient =
    normalizedConclusion === result.conclusion && normalizedConclusionContract === result.conclusionContract
      ? result
      : { ...result, conclusion: normalizedConclusion, conclusionContract: normalizedConclusionContract };
  const clientFindings = buildClientFindings(result.findings, session.scenes || []);

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
      result: resultForClient,
      hypotheses: session.hypotheses,
      dialogue: session.agentDialogue,
      dataEnvelopes: session.dataEnvelopes,
      agentResponses: session.agentResponses,
      timestamp: Date.now(),
    };
    console.log(`[AgentRoutes] Generating HTML report, data keys:`, {
      hasResult: !!result,
      conclusionLength: normalizedConclusion.length || 0,
      hasConclusionContract: !!normalizedConclusionContract,
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
      conclusion: normalizedConclusion,
      conclusionContract: normalizedConclusionContract,
      confidence: result.confidence,
      rounds: result.rounds,
      totalDurationMs: result.totalDurationMs,
      findings: clientFindings,
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

  // Backward-compatible scene reconstruction payload (used by the legacy /scene-reconstruct clients).
  if ((session.scenes?.length || 0) > 0 || (session.trackEvents?.length || 0) > 0) {
    res.write(`event: scene_reconstruction_completed\n`);
    res.write(`data: ${JSON.stringify({
      type: 'scene_reconstruction_completed',
      data: {
        narrative: normalizedConclusion,
        confidence: result.confidence,
        executionTimeMs: result.totalDurationMs,
        scenes: (session.scenes || []).map((s) => ({
          type: s.type,
          startTs: s.startTs,
          endTs: s.endTs,
          durationMs: s.durationMs,
          confidence: s.confidence,
          appPackage: s.appPackage,
        })),
        trackEvents: session.trackEvents || [],
        findings: clientFindings.map((f) => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
          title: f.title,
          description: f.description,
          timestampsNs: f.timestampsNs,
        })),
        suggestions: [],
      },
      timestamp: Date.now(),
    })}\n\n`);
  }
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
const sessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  // Clean up stale sessions (agent-driven)
  for (const [id, session] of sessions.entries()) {
    const age = now - session.createdAt;
    if (age > maxAge && (session.status === 'completed' || session.status === 'failed')) {
      console.log(`[AgentRoutes] Cleaning up stale session: ${id}`);
      session.sseClients.forEach((client) => {
        try {
          client.end();
        } catch {}
      });
      session.orchestrator.reset();
      sessions.delete(id);
    }
  }
}, 30 * 60 * 1000);
sessionCleanupInterval.unref?.();

export default router;
