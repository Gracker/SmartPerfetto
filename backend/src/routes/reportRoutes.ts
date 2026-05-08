// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Report Routes
 *
 * API endpoints for generating and serving HTML analysis reports.
 * Reports are persisted to disk (`logs/reports/`) and cached in memory.
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { attachRequestContext, requireRequestContext } from '../middleware/auth';
import { REPORT_CAUSAL_MAP_CSS, REPORT_CAUSAL_MAP_SCRIPT } from '../services/reportCausalMapAssets';
import { localize, parseOutputLanguage } from '../agentv3/outputLanguage';
import {
  isOwnedByContext,
  sendResourceNotFound,
  type ResourceOwnerFields,
} from '../services/resourceOwnership';

const router = express.Router();

const REPORTS_DIR = path.resolve(__dirname, '../../logs/reports');

// Ensure reports directory exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

router.use(attachRequestContext);

// In-memory cache backed by disk persistence
type PersistedReport = ResourceOwnerFields & {
  html: string;
  generatedAt: number;
  sessionId: string;
};

export const reportStore = new Map<string, PersistedReport>();

const LEGACY_MERMAID_UPGRADE_CSS = REPORT_CAUSAL_MAP_CSS;

const LEGACY_MERMAID_UPGRADE_SCRIPT = REPORT_CAUSAL_MAP_SCRIPT;

export function upgradeLegacyReportHtml(html: string): string {
  if (!html || !html.includes('<pre class="mermaid">')) return html;
  if (html.includes('parseMermaidFlowSource(') || html.includes('class="causal-map"')) return html;

  let upgraded = html;
  upgraded = upgraded.replace(
    '</style>',
    `${LEGACY_MERMAID_UPGRADE_CSS}\n</style>`,
  );
  upgraded = upgraded.replace(
    /<pre class="mermaid">([\s\S]*?)<\/pre>/g,
    '<div class="mermaid-wrapper"><pre class="mermaid">$1</pre></div>',
  );
  upgraded = upgraded.replace(
    /if \(typeof mermaid !== 'undefined'\) \{[\s\S]*?mermaid\.run\(\{ querySelector: 'pre\.mermaid' \}\);\s*\}/,
    LEGACY_MERMAID_UPGRADE_SCRIPT.trim(),
  );
  return upgraded;
}

/** Save a report to disk. Called externally when reports are generated. */
export function persistReport(reportId: string, entry: PersistedReport): void {
  reportStore.set(reportId, entry);
  try {
    const filePath = path.join(REPORTS_DIR, `${reportId}.html`);
    fs.writeFileSync(filePath, entry.html, 'utf-8');
    // Write metadata alongside
    const metaPath = path.join(REPORTS_DIR, `${reportId}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      generatedAt: entry.generatedAt,
      sessionId: entry.sessionId,
      tenantId: entry.tenantId,
      workspaceId: entry.workspaceId,
      userId: entry.userId,
    }));
  } catch (err) {
    console.warn('[ReportRoutes] Failed to persist report to disk:', (err as Error).message);
  }
}

/** Load a report from disk if not in memory cache. */
function loadReportFromDisk(reportId: string): PersistedReport | null {
  try {
    const filePath = path.join(REPORTS_DIR, `${reportId}.html`);
    if (!fs.existsSync(filePath)) return null;

    const html = fs.readFileSync(filePath, 'utf-8');
    const metaPath = path.join(REPORTS_DIR, `${reportId}.meta.json`);
    let generatedAt = Date.now();
    let sessionId = '';
    let owner: ResourceOwnerFields = {};
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      generatedAt = meta.generatedAt || generatedAt;
      sessionId = meta.sessionId || '';
      owner = {
        tenantId: meta.tenantId,
        workspaceId: meta.workspaceId,
        userId: meta.userId,
        ownerUserId: meta.ownerUserId,
      };
    }

    const entry = { html: upgradeLegacyReportHtml(html), generatedAt, sessionId, ...owner };
    // Cache in memory for subsequent access
    reportStore.set(reportId, entry);
    return entry;
  } catch {
    return null;
  }
}

function getReportForContext(reportId: string, req: express.Request): PersistedReport | null {
  const context = requireRequestContext(req);
  const report = reportStore.get(reportId) || loadReportFromDisk(reportId);
  if (!report || !isOwnedByContext(report, context)) {
    return null;
  }
  return report;
}

// Clean up old reports every 30 minutes (both memory and disk)
const reportCleanupInterval = setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  // Clean memory cache
  for (const [reportId, report] of reportStore.entries()) {
    if (now - report.generatedAt > maxAge) {
      reportStore.delete(reportId);
    }
  }

  // Clean disk files
  try {
    const files = fs.readdirSync(REPORTS_DIR);
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      const metaPath = path.join(REPORTS_DIR, file);
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.generatedAt && now - meta.generatedAt > maxAge) {
          const reportId = file.replace('.meta.json', '');
          fs.unlinkSync(metaPath);
          const htmlPath = path.join(REPORTS_DIR, `${reportId}.html`);
          if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
        }
      } catch { /* skip individual file errors */ }
    }
  } catch { /* non-fatal */ }
}, 30 * 60 * 1000);
reportCleanupInterval.unref?.();

/**
 * GET /api/reports/:reportId/export
 *
 * Download the persisted HTML report artifact. The frontend/report page uses this
 * endpoint together with the File System Access API so the user can choose the
 * local destination and filename.
 */
router.get('/:reportId/export', (req, res) => {
  try {
    const { reportId } = req.params;

    const report = getReportForContext(reportId, req);
    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found',
      });
    }

    const filename = `smartperfetto-${reportId}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(upgradeLegacyReportHtml(report.html));
  } catch (error: any) {
    console.error('[ReportRoutes] Export report error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to export report',
    });
  }
});

/**
 * GET /api/reports/:reportId
 *
 * Get HTML report by ID (memory cache → disk fallback)
 */
router.get('/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;

    // Try memory cache first, then disk
    let report = getReportForContext(reportId, req);
    if (!report) {
      const outputLanguage = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="${outputLanguage === 'en' ? 'en' : 'zh-CN'}">
        <head>
          <meta charset="UTF-8">
          <title>${localize(outputLanguage, '报告未找到', 'Report Not Found')}</title>
          <style>
            body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f7fa; }
            .error { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
            h1 { color: #ef4444; margin-bottom: 10px; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>${localize(outputLanguage, '报告未找到', 'Report Not Found')}</h1>
            <p>${localize(outputLanguage, '该报告可能已过期或不存在。请重新生成分析报告。', 'This report may have expired or may not exist. Generate the analysis report again.')}</p>
          </div>
        </body>
        </html>
      `);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(upgradeLegacyReportHtml(report.html));
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
 * Delete a report from memory and disk
 */
router.delete('/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;

    const report = getReportForContext(reportId, req);
    if (!report) {
      return sendResourceNotFound(res, 'Report not found');
    }

    const deleted = reportStore.delete(reportId);

    // Also clean disk files
    try {
      const htmlPath = path.join(REPORTS_DIR, `${reportId}.html`);
      const metaPath = path.join(REPORTS_DIR, `${reportId}.meta.json`);
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch { /* non-fatal */ }

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
