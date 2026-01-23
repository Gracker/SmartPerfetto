/**
 * Report Routes
 *
 * API endpoints for generating and serving HTML analysis reports
 */

import express from 'express';

const router = express.Router();

// Store generated reports in memory (in production, use persistent storage)
export const reportStore = new Map<string, {
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

// Note: Report generation is handled by agent-driven analysis routes.

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
