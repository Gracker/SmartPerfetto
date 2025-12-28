/**
 * Perfetto SQL Routes
 *
 * API endpoints for Perfetto SQL-based trace analysis.
 * All SQL patterns are based on official Perfetto documentation.
 */

import express from 'express';
import { PerfettoSqlSkill } from '../services/perfettoSqlSkill';
import { PerfettoSkillType } from '../types/perfettoSql';
import type { PerfettoSqlRequest } from '../types/perfettoSql';

const router = express.Router();

// Shared TraceProcessorService instance (same as in other route modules)
let _sharedTraceProcessorService: any = null;
const getSharedTraceProcessorService = () => {
  if (!_sharedTraceProcessorService) {
    const { TraceProcessorService } = require('../services/traceProcessorService');
    _sharedTraceProcessorService = new TraceProcessorService();
  }
  return _sharedTraceProcessorService;
};

// Initialize services
const traceProcessorService = getSharedTraceProcessorService();
const perfettoSqlSkill = new PerfettoSqlSkill(traceProcessorService);

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/perfetto-sql/analyze
 *
 * Main analysis endpoint - auto-detects skill type from question
 *
 * Body: { traceId, question, packageName?, timeRange? }
 * Response: PerfettoSqlResponse
 */
router.post('/analyze', async (req, res) => {
  try {
    const { traceId, question, packageName, timeRange }: PerfettoSqlRequest = req.body;

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
    const trace = traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: `Trace ${traceId} not found`,
      });
    }

    const result = await perfettoSqlSkill.analyze({
      traceId,
      question,
      packageName,
      timeRange,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/startup
 *
 * Analyze app startup performance (cold/warm/hot)
 *
 * Body: { traceId, packageName? }
 * Response: Startup analysis results
 */
router.post('/startup', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeStartup(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Startup analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Startup analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/scrolling
 *
 * Analyze scrolling performance and jank
 *
 * Body: { traceId, packageName? }
 * Response: Scrolling analysis results
 */
router.post('/scrolling', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeScrolling(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Scrolling analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Scrolling analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/memory
 *
 * Analyze memory usage (GC, allocations, OOM)
 *
 * Body: { traceId, packageName? }
 * Response: Memory analysis results
 */
router.post('/memory', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeMemory(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Memory analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Memory analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/cpu
 *
 * Analyze CPU utilization
 *
 * Body: { traceId, packageName? }
 * Response: CPU analysis results
 */
router.post('/cpu', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeCpu(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] CPU analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'CPU analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/surfaceflinger
 *
 * Analyze SurfaceFlinger performance
 *
 * Body: { traceId }
 * Response: SurfaceFlinger analysis results
 */
router.post('/surfaceflinger', async (req, res) => {
  try {
    const { traceId } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeSurfaceFlinger(traceId);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] SurfaceFlinger analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'SurfaceFlinger analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/binder
 *
 * Analyze Binder transaction performance
 *
 * Body: { traceId, packageName? }
 * Response: Binder analysis results
 */
router.post('/binder', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeBinder(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Binder analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Binder analysis failed',
    });
  }
});

/**
 * GET /api/perfetto-sql/tables
 *
 * Get list of available Perfetto SQL tables
 *
 * Response: { tables: TableSchema[] }
 */
router.get('/tables', (_req, res) => {
  try {
    const knowledgeBase = perfettoSqlSkill.getKnowledgeBase();
    const tableNames = knowledgeBase.getTableNames();
    const tables = tableNames.map((name) => knowledgeBase.getTableSchema(name));

    res.json({
      success: true,
      tables,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Tables error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get tables',
    });
  }
});

/**
 * GET /api/perfetto-sql/tables/:tableName
 *
 * Get schema for a specific table
 *
 * Response: { table: TableSchema }
 */
router.get('/tables/:tableName', (req, res) => {
  try {
    const { tableName } = req.params;
    const knowledgeBase = perfettoSqlSkill.getKnowledgeBase();
    const table = knowledgeBase.getTableSchema(tableName);

    if (!table) {
      return res.status(404).json({
        success: false,
        error: `Table ${tableName} not found`,
      });
    }

    res.json({
      success: true,
      table,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Table schema error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get table schema',
    });
  }
});

/**
 * GET /api/perfetto-sql/functions
 *
 * Get list of available Perfetto SQL functions
 *
 * Query params:
 * - category: Filter by function category
 *
 * Response: { functions: FunctionSignature[] }
 */
router.get('/functions', (req, res) => {
  try {
    const { category } = req.query;
    const knowledgeBase = perfettoSqlSkill.getKnowledgeBase();

    let functions;
    if (category && typeof category === 'string') {
      functions = knowledgeBase.getFunctionsByCategory(category);
    } else {
      functions = knowledgeBase.getFunctions();
    }

    res.json({
      success: true,
      functions,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Functions error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get functions',
    });
  }
});

/**
 * GET /api/perfetto-sql/skills
 *
 * Get list of available analysis skills
 *
 * Response: { skills: PerfettoSkillType[] }
 */
router.get('/skills', (_req, res) => {
  try {
    const skills = perfettoSqlSkill.getAvailableSkills();

    res.json({
      success: true,
      skills,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Skills error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get skills',
    });
  }
});

/**
 * POST /api/perfetto-sql/sql
 *
 * Execute raw SQL query on a trace
 *
 * Body: { traceId, sql }
 * Response: { rows, rowCount, columns }
 */
router.post('/sql', async (req, res) => {
  try {
    const { traceId, sql } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    if (!sql) {
      return res.status(400).json({
        success: false,
        error: 'sql is required',
      });
    }

    // Verify trace exists
    const trace = traceProcessorService.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({
        success: false,
        error: `Trace ${traceId} not found`,
      });
    }

    const result = await traceProcessorService.query(traceId, sql);

    if (result.error) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      rows: result.rows,
      rowCount: result.rows.length,
      columns: result.columns,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] SQL execution error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'SQL execution failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/navigation
 *
 * Analyze navigation/activity switching performance
 *
 * Body: { traceId, packageName? }
 * Response: Navigation analysis results
 */
router.post('/navigation', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeNavigation(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Navigation analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Navigation analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/click-response
 *
 * Analyze click/tap response performance
 *
 * Body: { traceId, packageName? }
 * Response: Click response analysis results
 */
router.post('/click-response', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeClickResponse(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Click response analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Click response analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/input
 *
 * Analyze input events and latency
 *
 * Body: { traceId, packageName? }
 * Response: Input analysis results
 */
router.post('/input', async (req, res) => {
  try {
    const { traceId, packageName } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeInput(traceId, packageName);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Input analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Input analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/buffer-flow
 *
 * Analyze buffer flow and queue
 *
 * Body: { traceId }
 * Response: Buffer flow analysis results
 */
router.post('/buffer-flow', async (req, res) => {
  try {
    const { traceId } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeBufferFlow(traceId);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] Buffer flow analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Buffer flow analysis failed',
    });
  }
});

/**
 * POST /api/perfetto-sql/systemserver
 *
 * Analyze SystemServer performance
 *
 * Body: { traceId }
 * Response: SystemServer analysis results
 */
router.post('/systemserver', async (req, res) => {
  try {
    const { traceId } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    const result = await perfettoSqlSkill.analyzeSystemServer(traceId);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('[PerfettoSql] SystemServer analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'SystemServer analysis failed',
    });
  }
});

// Export services for use in other parts of the app
export { perfettoSqlSkill, traceProcessorService };

export default router;
