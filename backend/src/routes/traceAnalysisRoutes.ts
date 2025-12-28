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
import {
  CreateAnalysisRequest,
  FollowupRequest,
  AnalysisSSEEvent,
  AnalysisState,
} from '../types/analysis';

const router = express.Router();

// Lazy initialization of services - create only when first used
let _traceProcessorService: any = null;
let _sessionService: any = null;
let _perfettoSqlSkill: any = null;
let _orchestrator: any = null;

function getServices() {
  if (!_orchestrator) {
    console.log('[TraceAnalysisRoutes] Initializing services...');
    console.log('[TraceAnalysisRoutes] DEEPSEEK_API_KEY exists:', !!process.env.DEEPSEEK_API_KEY);
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
  }
  return {
    traceProcessorService: _traceProcessorService,
    sessionService: _sessionService,
    orchestrator: _orchestrator,
    perfettoSqlSkill: _perfettoSqlSkill,
  };
}

// Clean up old analyses every 10 minutes
setInterval(() => {
  const { traceProcessorService } = getServices();
  if (traceProcessorService) {
    traceProcessorService.cleanup(10 * 60 * 1000);
  }
}, 10 * 60 * 1000);

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

    // Verify trace exists
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: `Trace ${traceId} not found`,
      });
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
    s().orchestrator.startAnalysis(sessionId).catch((error: any) => {
      console.error(`[TraceAnalysis] Start error for session ${sessionId}:`, error);
    });

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
  const unsubscribe = s().sessionService.subscribeToSSE(sessionId, (event: AnalysisSSEEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    // Close connection if analysis is completed or failed
    if (event.type === 'analysis_completed' || (event.type === 'error' && !event.data.recoverable)) {
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
    s().orchestrator.startAnalysis(sessionId).catch((error: any) => {
      console.error(`[TraceAnalysis] Followup error for session ${sessionId}:`, error);
    });

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

    // Verify trace exists in backend
    const trace = s().traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: 'Trace not found in backend',
        hint: 'Please upload the trace to the backend first using the upload button',
        code: 'TRACE_NOT_UPLOADED',
      });
    }

    // Create session
    s().sessionService.createSession({
      traceId,
      question,
      userId: undefined,
      maxIterations,
    });

    // Get the created session
    const sessions = s().sessionService.getAllSessions();
    const createdSession = sessions.find((session: any) => session.traceId === traceId && session.question === question);

    if (!createdSession) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create analysis session',
      });
    }

    // Start analysis in background
    s().orchestrator.startAnalysis(createdSession.id).catch((error: any) => {
      console.error(`[TraceAnalysis] Start error for session ${createdSession.id}:`, error);
      s().sessionService.updateState(createdSession.id, AnalysisState.FAILED, {
        error: error.message,
      });
    });

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
