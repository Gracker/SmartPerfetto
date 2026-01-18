/**
 * Trace Analysis Routes
 *
 * API endpoints for AI-powered trace analysis with SSE support
 */

import express from 'express';
import { AnalysisSessionService, getSessionService } from '../services/analysisSessionService';
import { PerfettoAnalysisOrchestrator } from '../services/perfettoAnalysisOrchestrator';
import { PerfettoSqlSkill } from '../services/perfettoSqlSkill';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { OrchestratorBridge, createOrchestratorBridge } from '../services/orchestratorBridge';
import {
  CreateAnalysisRequest,
  FollowupRequest,
  AnalysisSSEEvent,
  AnalysisState,
} from '../types/analysis';

// Environment flag to enable MasterOrchestrator with enhanced features
const USE_MASTER_ORCHESTRATOR = process.env.USE_MASTER_ORCHESTRATOR === 'true';

const router = express.Router();

// Lazy initialization of services - create only when first used
let _traceProcessorService: any = null;
let _sessionService: any = null;
let _perfettoSqlSkill: any = null;
let _orchestrator: any = null;
let _orchestratorBridge: OrchestratorBridge | null = null;

function getServices() {
  if (!_orchestrator) {
    console.log('[TraceAnalysisRoutes] Initializing services...');
    console.log('[TraceAnalysisRoutes] DEEPSEEK_API_KEY exists:', !!process.env.DEEPSEEK_API_KEY);
    console.log('[TraceAnalysisRoutes] USE_MASTER_ORCHESTRATOR:', USE_MASTER_ORCHESTRATOR);
    _traceProcessorService = getTraceProcessorService();
    _sessionService = getSessionService();
    _perfettoSqlSkill = new PerfettoSqlSkill(_traceProcessorService);
    _orchestrator = new PerfettoAnalysisOrchestrator(
      _traceProcessorService,
      _sessionService,
      undefined,
      _perfettoSqlSkill
    );
    console.log('[TraceAnalysisRoutes] Services initialized, AI configured:', _orchestrator.isConfigured);

    // Create OrchestratorBridge if MasterOrchestrator is enabled
    if (USE_MASTER_ORCHESTRATOR) {
      _orchestratorBridge = createOrchestratorBridge(_sessionService, _traceProcessorService, {
        enableHooks: true,
        enableContextIsolation: true,
        enableContextCompaction: true,
        enableSessionFork: false,  // Fork is experimental
      });
      console.log('[TraceAnalysisRoutes] OrchestratorBridge initialized with enhanced features');
    }
  }
  return {
    traceProcessorService: _traceProcessorService,
    sessionService: _sessionService,
    orchestrator: _orchestrator,
    perfettoSqlSkill: _perfettoSqlSkill,
    orchestratorBridge: _orchestratorBridge,
  };
}

// Smart cleanup: run every 15 minutes
// Only cleans traces that are BOTH:
// - Older than 2 hours (maxAge)
// - Idle for more than 30 minutes (idleTimeout)
// This prevents active traces from being cleaned up while still
// removing truly abandoned traces.
setInterval(() => {
  const { traceProcessorService } = getServices();
  if (traceProcessorService) {
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const THIRTY_MINUTES = 30 * 60 * 1000;
    traceProcessorService.cleanup(TWO_HOURS, THIRTY_MINUTES);
  }
}, 15 * 60 * 1000); // Run every 15 minutes

// Helper to get services for use in route handlers
const s = () => getServices();

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/trace-analysis/create
 *
 * Create a new analysis session
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "question": "What is the app startup time?",
 *   "userId": "optional-user-id",
 *   "maxIterations": 10
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "sessionId": "session-xxx",
 *   "status": "idle"
 * }
 */
router.post('/create', async (req, res) => {
  try {
    const { traceId, question, userId, maxIterations }: CreateAnalysisRequest = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    if (!question) {
      return res.status(400).json({
        success: false,
        error: 'question is required',
      });
    }

    // Verify trace exists - try to load from disk if not in memory
    let trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      // Try to load from disk (e.g., after server restart)
      trace = await s().traceProcessorService.loadTraceFromDisk(traceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: `Trace ${traceId} not found`,
        });
      }
    }

    // Create session
    const sessionId = s().sessionService.createSession({
      traceId,
      question,
      userId,
      maxIterations,
    });

    res.json({
      success: true,
      sessionId,
      status: 'idle',
      traceId,
      question,
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Create error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create analysis session',
    });
  }
});

/**
 * POST /api/trace-analysis/:sessionId/start
 *
 * Start analysis for a session (non-blocking)
 *
 * Response:
 * {
 *   "success": true,
 *   "sessionId": "session-xxx",
 *   "status": "running"
 * }
 */
router.post('/:sessionId/start', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = s().sessionService.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    // Start analysis in background
    // Use OrchestratorBridge (MasterOrchestrator) if enabled
    const services = s();
    const bridge = services.orchestratorBridge;
    if (USE_MASTER_ORCHESTRATOR && bridge) {
      bridge.startAnalysis(sessionId).catch((error: any) => {
        console.error(`[TraceAnalysis] MasterOrchestrator error for session ${sessionId}:`, error);
      });
    } else {
      services.orchestrator.startAnalysis(sessionId).catch((error: any) => {
        console.error(`[TraceAnalysis] Start error for session ${sessionId}:`, error);
      });
    }

    res.json({
      success: true,
      sessionId,
      status: 'running',
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Start error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start analysis',
    });
  }
});

/**
 * GET /api/trace-analysis/:sessionId/status
 *
 * Get session status (for polling)
 *
 * Response:
 * {
 *   "sessionId": "session-xxx",
 *   "status": "generating_sql",
 *   "currentIteration": 2,
 *   "maxIterations": 10,
 *   "currentStep": "Generating SQL query...",
 *   "progress": { "current": 2, "total": 10 },
 *   "messages": [],
 *   "finalAnswer": null,
 *   "error": null
 * }
 */
router.get('/:sessionId/status', (req, res) => {
  try {
    const { sessionId } = req.params;

    const status = s().sessionService.getSessionStatus(sessionId);
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    res.json(status);
  } catch (error: any) {
    console.error('[TraceAnalysis] Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get session status',
    });
  }
});

/**
 * GET /api/trace-analysis/:sessionId/stream
 *
 * SSE endpoint for real-time updates
 *
 * Events:
 * - sql_generated: AI generated SQL
 * - sql_executed: SQL execution result
 * - step_completed: Step completed
 * - analysis_completed: Analysis finished with final answer
 * - error: Error occurred
 * - progress: Progress update
 */
router.get('/:sessionId/stream', (req, res) => {
  const { sessionId } = req.params;

  // Verify session exists
  const session = s().sessionService.getSession(sessionId);
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
  res.write(`data: ${JSON.stringify({ sessionId, timestamp: Date.now() })}\n\n`);

  // Subscribe to SSE events
  console.log(`[SSE] Subscribed to events for session ${sessionId}`);
  const unsubscribe = s().sessionService.subscribeToSSE(sessionId, (event: AnalysisSSEEvent) => {
    console.log(`[SSE] Received event: ${event.type} for session ${sessionId}`);
    try {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      console.log(`[SSE] Event ${event.type} written to response`);
    } catch (err) {
      console.error(`[SSE] Failed to write event ${event.type}:`, err);
    }

    // Close connection if analysis is completed or failed
    if (event.type === 'analysis_completed' || (event.type === 'error' && !event.data.recoverable)) {
      console.log(`[SSE] Closing connection for session ${sessionId}`);
      res.write(`event: end\n`);
      res.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
      setTimeout(() => {
        unsubscribe();
        res.end();
      }, 100);
    }
  });

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[SSE] Client disconnected for session ${sessionId}`);
    unsubscribe();
  });

  // Send periodic keep-alive
  const keepAlive = setInterval(() => {
    try {
      res.write(`: keep-alive\n\n`);
    } catch {
      clearInterval(keepAlive);
      unsubscribe();
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/**
 * POST /api/trace-analysis/:sessionId/followup
 *
 * Add a follow-up question to the session
 *
 * Body:
 * {
 *   "question": "What about memory usage?"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "status": "running"
 * }
 */
router.post('/:sessionId/followup', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { question }: FollowupRequest = req.body;

    if (!question) {
      return res.status(400).json({
        success: false,
        error: 'question is required',
      });
    }

    const session = s().sessionService.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    // Add follow-up message
    s().sessionService.addMessage(sessionId, {
      role: 'user',
      content: question,
    });

    // Reset iteration counter for new analysis
    s().sessionService.updateState(sessionId, 'idle' as any, {
      currentIteration: 0,
      collectedResults: [],
    });

    // Start analysis in background
    // Use OrchestratorBridge (MasterOrchestrator) if enabled
    const followupServices = s();
    const followupBridge = followupServices.orchestratorBridge;
    if (USE_MASTER_ORCHESTRATOR && followupBridge) {
      followupBridge.startAnalysis(sessionId).catch((error: any) => {
        console.error(`[TraceAnalysis] MasterOrchestrator followup error for session ${sessionId}:`, error);
      });
    } else {
      followupServices.orchestrator.startAnalysis(sessionId).catch((error: any) => {
        console.error(`[TraceAnalysis] Followup error for session ${sessionId}:`, error);
      });
    }

    res.json({
      success: true,
      status: 'running',
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Followup error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process follow-up',
    });
  }
});

/**
 * GET /api/trace-analysis/:sessionId/result
 *
 * Get final analysis result (for completed sessions)
 *
 * Response:
 * {
 *   "sessionId": "session-xxx",
 *   "answer": "Final answer text...",
 *   "sqlQueries": [...],
 *   "steps": [...],
 *   "metrics": {...}
 * }
 */
router.get('/:sessionId/result', (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = s().sessionService.getAnalysisResult(sessionId);
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Result not found or analysis not completed',
      });
    }

    res.json(result);
  } catch (error: any) {
    console.error('[TraceAnalysis] Result error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get result',
    });
  }
});

/**
 * DELETE /api/trace-analysis/:sessionId
 *
 * Delete a session and cleanup resources
 *
 * Response:
 * {
 *   "success": true
 * }
 */
router.delete('/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    const deleted = s().sessionService.deleteSession(sessionId);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[TraceAnalysis] Delete error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete session',
    });
  }
});

/**
 * POST /api/trace-analysis/analyze
 *
 * Main analysis endpoint - all traces must be uploaded to backend first
 *
 * Body: { traceId, question, packageName?, timeRange?, maxIterations? }
 * Response: { success: true, analysisId: string }
 */
router.post('/analyze', async (req, res) => {
  try {
    const { traceId, question, packageName, timeRange, maxIterations = 10 } = req.body;

    console.error('[TraceAnalysis] ========================================');
    console.error('[TraceAnalysis] New analysis request received');
    console.error('[TraceAnalysis] traceId:', traceId);
    console.error('[TraceAnalysis] question:', question);
    console.error('[TraceAnalysis] packageName:', packageName);
    console.error('[TraceAnalysis] timeRange:', timeRange);
    console.error('[TraceAnalysis] maxIterations:', maxIterations);

    if (!traceId) {
      console.log('[TraceAnalysis] ERROR: Missing traceId');
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    if (!question) {
      console.log('[TraceAnalysis] ERROR: Missing question');
      return res.status(400).json({
        success: false,
        error: 'question is required',
      });
    }

    // Verify trace exists in backend
    console.log('[TraceAnalysis] Checking if trace exists in backend...');
    const trace = s().traceProcessorService.getTrace(traceId);
    console.log('[TraceAnalysis] Trace found:', !!trace, trace ? `status: ${trace.status}` : 'not found');
    if (!trace) {
      console.log('[TraceAnalysis] ERROR: Trace not found in backend');
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Create session
    console.log('[TraceAnalysis] Creating session...');
    s().sessionService.createSession({
      traceId,
      question,
      userId: undefined,
      maxIterations,
    });

    // Get the created session
    const sessions = s().sessionService.getAllSessions();
    const createdSession = sessions.find((session: any) => session.traceId === traceId && session.question === question);
    console.log('[TraceAnalysis] Session created:', createdSession ? createdSession.id : 'FAILED');

    if (!createdSession) {
      console.log('[TraceAnalysis] ERROR: Failed to create session');
      return res.status(500).json({
        success: false,
        error: 'Failed to create analysis session',
      });
    }

    // Start analysis in background
    // Use OrchestratorBridge (MasterOrchestrator) if enabled, otherwise use PerfettoAnalysisOrchestrator
    console.log('[TraceAnalysis] Starting analysis for session:', createdSession.id);
    console.log('[TraceAnalysis] Using MasterOrchestrator:', USE_MASTER_ORCHESTRATOR);

    const analyzeServices = s();
    const analyzeBridge = analyzeServices.orchestratorBridge;
    if (USE_MASTER_ORCHESTRATOR && analyzeBridge) {
      analyzeBridge.startAnalysis(createdSession.id).catch((error: any) => {
        console.error(`[TraceAnalysis] MasterOrchestrator error for session ${createdSession.id}:`, error);
        analyzeServices.sessionService.updateState(createdSession.id, AnalysisState.FAILED, {
          error: error.message,
        });
      });
    } else {
      analyzeServices.orchestrator.startAnalysis(createdSession.id).catch((error: any) => {
        console.error(`[TraceAnalysis] Start error for session ${createdSession.id}:`, error);
        analyzeServices.sessionService.updateState(createdSession.id, AnalysisState.FAILED, {
          error: error.message,
        });
      });
    }

    // Return analysisId (same as sessionId)
    res.json({
      success: true,
      analysisId: createdSession.id,
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Analysis failed',
    });
  }
});

/**
 * GET /api/trace-analysis/status/:analysisId
 *
 * Poll for analysis status (plugin-compatible endpoint)
 *
 * Response: { success: true, analysis: { status, steps, answer, error } }
 */
router.get('/status/:analysisId', (req, res) => {
  try {
    const { analysisId } = req.params;

    const session = s().sessionService.getSession(analysisId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Analysis not found',
      });
    }

    // Map internal status to plugin-compatible status
    let status = 'running';
    if (session.status === 'completed') {
      status = 'completed';
    } else if (session.status === 'failed') {
      status = 'failed';
    }

    // Build analysis response matching plugin expectations
    const analysis: any = {
      status,
      analysisId,
      steps: [],
    };

    // Convert messages to steps format expected by plugin
    if (session.messages && session.messages.length > 0) {
      analysis.steps = session.messages.map((msg: any) => {
        const step: any = {
          type: msg.role === 'assistant' ? 'analysis' : 'thinking',
          content: msg.content,
          timestamp: msg.timestamp,
        };

        // Include SQL and results if available
        if (msg.sql) {
          step.type = 'sql_success';
          step.sql = msg.sql;
        }
        if (msg.result) {
          step.result = msg.result;
        }

        return step;
      });
    }

    // Include final answer if completed
    if (session.status === 'completed' && session.finalAnswer) {
      analysis.answer = session.finalAnswer;
    }

    // Include error if failed
    if (session.status === 'failed') {
      analysis.error = session.error || 'Analysis failed';
    }

    res.json({
      success: true,
      analysis,
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get status',
    });
  }
});

/**
 * POST /api/trace-analysis/analyze/slow
 *
 * Slow function detection endpoint
 * Detects functions > 16ms (missed frame threshold)
 *
 * Body: { traceId, packageName? }
 * Response: { success: true, result: { ... } }
 */
router.post('/analyze/slow', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Run slow functions analysis
    const result = await s().perfettoSqlSkill.analyzeSlowFunctions(traceId, packageName);

    res.json({
      success: true,
      result: {
        analysisType: result.analysisType,
        sql: result.sql,
        rows: result.rows,
        rowCount: result.rowCount,
        summary: result.summary,
        metrics: result.metrics,
        details: result.details,
      },
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Slow functions analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Slow functions analysis failed',
    });
  }
});

/**
 * POST /api/trace-analysis/analyze/memory
 *
 * Memory analysis endpoint
 * Analyzes heap usage, GC events, and allocations
 *
 * Body: { traceId, packageName? }
 * Response: { success: true, result: { ... } }
 */
router.post('/analyze/memory', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Run memory analysis
    const result = await s().perfettoSqlSkill.analyzeMemory(traceId, packageName);

    res.json({
      success: true,
      result: {
        analysisType: result.analysisType,
        sql: result.sql,
        rows: result.rows,
        rowCount: result.rowCount,
        summary: result.summary,
        metrics: result.metrics,
        details: result.details,
      },
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Memory analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Memory analysis failed',
    });
  }
});

/**
 * POST /api/trace-analysis/analyze/network
 *
 * Network analysis endpoint
 * Analyzes network traffic and HTTP requests
 *
 * Body: { traceId, packageName? }
 * Response: { success: true, result: { ... } }
 */
router.post('/analyze/network', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Run network analysis
    const result = await s().perfettoSqlSkill.analyzeNetwork(traceId, packageName);

    res.json({
      success: true,
      result: {
        analysisType: result.analysisType,
        sql: result.sql,
        rows: result.rows,
        rowCount: result.rowCount,
        summary: result.summary,
        metrics: result.metrics,
        details: result.details,
      },
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Network analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Network analysis failed',
    });
  }
});

/**
 * POST /api/trace-analysis/analyze/database
 *
 * Database analysis endpoint
 * Analyzes SQLite/Room query performance
 *
 * Body: { traceId, packageName? }
 * Response: { success: true, result: { ... } }
 */
router.post('/analyze/database', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Run database analysis
    const result = await s().perfettoSqlSkill.analyzeDatabase(traceId, packageName);

    res.json({
      success: true,
      result: {
        analysisType: result.analysisType,
        sql: result.sql,
        rows: result.rows,
        rowCount: result.rowCount,
        summary: result.summary,
        metrics: result.metrics,
        details: result.details,
      },
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] Database analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Database analysis failed',
    });
  }
});

/**
 * POST /api/trace-analysis/analyze/file-io
 *
 * File I/O analysis endpoint
 * Analyzes read/write operations and file system performance
 *
 * Body: { traceId, packageName? }
 * Response: { success: true, result: { ... } }
 */
router.post('/analyze/file-io', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    // Verify trace exists
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Run file I/O analysis
    const result = await s().perfettoSqlSkill.analyzeFileIO(traceId, packageName);

    res.json({
      success: true,
      result: {
        analysisType: result.analysisType,
        sql: result.sql,
        rows: result.rows,
        rowCount: result.rowCount,
        summary: result.summary,
        metrics: result.metrics,
        details: result.details,
      },
    });
  } catch (error: any) {
    console.error('[TraceAnalysis] File I/O analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'File I/O analysis failed',
    });
  }
});


// Export for use in other parts of the app
export { s, getServices };

export default router;
