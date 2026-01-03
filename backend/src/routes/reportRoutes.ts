/**
 * Report Routes
 *
 * API endpoints for generating and serving HTML analysis reports
 */

import express from 'express';
import { getSessionService } from '../services/analysisSessionService';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';

const router = express.Router();

// Store generated reports in memory (in production, use persistent storage)
const reportStore = new Map<string, {
  html: string;
  generatedAt: number;
  sessionId: string;
}>();

// Clean up old reports every 30 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  for (const [reportId, report] of reportStore.entries()) {
    if (now - report.generatedAt > maxAge) {
      reportStore.delete(reportId);
    }
  }
}, 30 * 60 * 1000);

/**
 * GET /api/reports/:reportId
 *
 * Get HTML report by ID
 */
router.get('/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;

    const report = reportStore.get(reportId);
    if (!report) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>报告未找到</title>
          <style>
            body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f7fa; }
            .error { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
            h1 { color: #ef4444; margin-bottom: 10px; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>报告未找到</h1>
            <p>该报告可能已过期或不存在。请重新生成分析报告。</p>
          </div>
        </body>
        </html>
      `);
    }

    // Set HTML content type
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(report.html);
  } catch (error: any) {
    console.error('[ReportRoutes] Get report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get report',
    });
  }
});

/**
 * POST /api/reports/generate/:sessionId
 *
 * Generate HTML report from a completed session
 * Returns: { success: true, reportId: string, reportUrl: string }
 */
router.post('/generate/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    const sessionService = getSessionService();
    const session = sessionService.getSession(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
      });
    }

    if (session.status !== 'completed' || !session.finalAnswer) {
      return res.status(400).json({
        success: false,
        error: 'Session is not completed yet',
      });
    }

    // Generate HTML report
    const generator = getHTMLReportGenerator();
    const html = generator.generateFromSession(session, session.finalAnswer);

    // Store report
    const reportId = `report-${sessionId}`;
    reportStore.set(reportId, {
      html,
      generatedAt: Date.now(),
      sessionId,
    });

    // Return report URL
    const reportUrl = `${req.protocol}://${req.get('host')}/api/reports/${reportId}`;

    res.json({
      success: true,
      reportId,
      reportUrl,
    });
  } catch (error: any) {
    console.error('[ReportRoutes] Generate report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate report',
    });
  }
});

/**
 * GET /api/reports/view/:sessionId
 *
 * Direct view endpoint - generates and displays HTML report in one request
 */
router.get('/view/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    const sessionService = getSessionService();
    const session = sessionService.getSession(sessionId);

    if (!session) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>会话未找到</title></head>
        <body><h1>会话未找到</h1></body>
        </html>
      `);
    }

    if (!session.finalAnswer) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>分析进行中</title>
          <style>
            body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f7fa; }
            .loading { text-align: center; }
            .spinner { width: 40px; height: 40px; border: 4px solid #eaeaea; border-top-color: #667eea; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { to { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="loading">
            <div class="spinner"></div>
            <p>分析仍在进行中，请稍后再试...</p>
          </div>
        </body>
        </html>
      `);
    }

    // Generate and serve HTML directly
    const generator = getHTMLReportGenerator();
    const html = generator.generateFromSession(session, session.finalAnswer);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    console.error('[ReportRoutes] View report error:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>错误</title></head>
      <body><h1>生成报告时出错</h1></body>
      </html>
    `);
  }
});

/**
 * DELETE /api/reports/:reportId
 *
 * Delete a report from memory
 */
router.delete('/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;

    const deleted = reportStore.delete(reportId);

    res.json({
      success: deleted,
      error: deleted ? undefined : 'Report not found',
    });
  } catch (error: any) {
    console.error('[ReportRoutes] Delete report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete report',
    });
  }
});

export default router;
