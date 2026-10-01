// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Export Routes
 * Handle result export requests
 */

import { Router } from 'express';
import { authenticate, requireRequestContext, type RequestContext } from '../middleware/auth';
import { sendRouteFailure } from '../middleware/routeFailure';
import { recordEnterpriseAuditEvent } from '../services/enterpriseAuditService';
import { openEnterpriseDb } from '../services/enterpriseDb';
import { buildTenantExportBundle } from '../services/enterpriseTenantExportService';
import { ResultExportService, AnalysisSessionExport } from '../services/resultExportService';
import { sendForbidden } from '../services/rbac';

const router = Router();

function canExportTenant(context: RequestContext): boolean {
  return context.scopes.includes('*')
    || context.scopes.includes('tenant:export')
    || context.roles.includes('org_admin');
}

/**
 * POST /api/export/result
 * Export a single SQL query result
 */
router.post('/result', async (req, res) => {
  try {
    const { result, format = 'json', options = {} } = req.body;

    // Validate format
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({
        success: false,
        error: 'Invalid format. Must be "csv" or "json"'
      });
    }

    // Validate delimiter for CSV format
    if (format === 'csv' && options.delimiter) {
      if (typeof options.delimiter !== 'string' || options.delimiter.length !== 1) {
        return res.status(400).json({
          success: false,
          error: 'Delimiter must be a single character'
        });
      }
    }

    // Validate result structure
    if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid result data. Must include columns (array) and rows (array).'
      });
    }

    const exportService = ResultExportService.getInstance();
    const exportResult = exportService.exportResult(result, { format, ...options });

    res.setHeader('Content-Type', exportResult.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.send(exportResult.data);
  } catch (error: unknown) {
    sendRouteFailure(res, {
      code: 'result_export_failed',
      error: 'Failed to export result',
      logLabel: '[ExportRoutes] Export result error',
    }, error);
  }
});

/**
 * POST /api/export/session
 * Export all results from a session
 */
router.post('/session', async (req, res) => {
  try {
    const { results, format = 'json', options = {} } = req.body;

    // Validate format
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({
        success: false,
        error: 'Invalid format. Must be "csv" or "json"'
      });
    }

    // Validate delimiter for CSV format
    if (format === 'csv' && options.delimiter) {
      if (typeof options.delimiter !== 'string' || options.delimiter.length !== 1) {
        return res.status(400).json({
          success: false,
          error: 'Delimiter must be a single character'
        });
      }
    }

    if (!Array.isArray(results)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid results data. Must be an array.',
      });
    }

    const exportService = ResultExportService.getInstance();
    const exportResult = exportService.exportSession(results, { format, ...options });

    res.setHeader('Content-Type', exportResult.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.send(exportResult.data);
  } catch (error: unknown) {
    sendRouteFailure(res, {
      code: 'export_session_failed',
      error: 'Failed to export session results',
      logLabel: '[ExportRoutes] Export session error',
    }, error);
  }
});

/**
 * POST /api/export/analysis
 * Export agentv3 analysis session (findings, plan, hypotheses, notes, conclusion)
 */
router.post('/analysis', async (req, res) => {
  try {
    const { sessionId, format = 'json', options = {}, ...analysisData } = req.body;

    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ success: false, error: 'Invalid format. Must be "csv" or "json"' });
    }
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    const exportData: AnalysisSessionExport = { sessionId, ...analysisData };
    const exportService = ResultExportService.getInstance();
    const exportResult = exportService.exportAnalysisSession(exportData, { format, ...options });

    res.setHeader('Content-Type', exportResult.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.send(exportResult.data);
  } catch (error: unknown) {
    sendRouteFailure(res, {
      code: 'analysis_export_failed',
      error: 'Failed to export analysis',
      logLabel: '[ExportRoutes] Export analysis error',
    }, error);
  }
});

/**
 * GET /api/export/tenant
 * Export a tenant-scoped compliance bundle without trace file bodies or secrets.
 */
router.get('/tenant', authenticate, async (req, res) => {
  const context = requireRequestContext(req);
  if (!canExportTenant(context)) {
    return sendForbidden(res, 'Tenant export requires org_admin or tenant:export scope');
  }

  const db = openEnterpriseDb();
  try {
    const exportResult = await buildTenantExportBundle(db, context);
    recordEnterpriseAuditEvent(db, {
      tenantId: context.tenantId,
      actorUserId: context.userId,
      action: 'tenant.exported',
      resourceType: 'tenant',
      resourceId: context.tenantId,
      metadata: {
        bundleSha256: exportResult.bundleSha256,
        traceCount: exportResult.bundle.manifest.traceCount,
        reportCount: exportResult.bundle.manifest.reportCount,
        sessionCount: exportResult.bundle.manifest.sessionCount,
        runCount: exportResult.bundle.manifest.runCount,
        memoryRecordCount: exportResult.bundle.manifest.memoryRecordCount,
        requestId: context.requestId,
      },
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.json({
      success: true,
      bundleSha256: exportResult.bundleSha256,
      bundle: exportResult.bundle,
    });
  } catch (error: unknown) {
    sendRouteFailure(res, {
      code: 'tenant_export_failed',
      error: 'Failed to export tenant bundle',
      logLabel: '[ExportRoutes] Export tenant bundle error',
    }, error);
  } finally {
    db.close();
  }
});

/**
 * GET /api/export/formats
 * Get available export formats
 */
router.get('/formats', (_req, res) => {
  res.json({
    success: true,
    formats: [
      { name: 'json', mimeType: 'application/json', description: 'JSON format with metadata' },
      { name: 'csv', mimeType: 'text/csv', description: 'CSV format (RFC 4180)' },
    ],
    options: {
      json: {
        prettyPrint: { type: 'boolean', default: true, description: 'Pretty print JSON output' },
      },
      csv: {
        includeHeaders: { type: 'boolean', default: true, description: 'Include column headers' },
        delimiter: { type: 'string', default: ',', description: 'Field delimiter' },
        nullValue: { type: 'string', default: 'NULL', description: 'Representation of null values' },
      },
    },
  });
});

export default router;
