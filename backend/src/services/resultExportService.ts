// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Result Export Service
 * Handles exporting SQL query results to CSV and JSON formats
 */

import { SqlQueryResult } from '../models/sessionSchema';
import type { Finding } from '../agent/types';
import type { AnalysisPlanV3, AnalysisNote, Hypothesis, UncertaintyFlag } from '../agentv3/types';

export interface ExportOptions {
  format: 'csv' | 'json';
  includeHeaders?: boolean;
  delimiter?: string;
  nullValue?: string;
  prettyPrint?: boolean;
}

export interface ExportResult {
  data: string;
  mimeType: string;
  filename: string;
  rowCount: number;
}

export class ResultExportService {
  private static instance: ResultExportService;

  private constructor() {}

  static getInstance(): ResultExportService {
    if (!ResultExportService.instance) {
      ResultExportService.instance = new ResultExportService();
    }
    return ResultExportService.instance;
  }

  /**
   * Export SQL result to CSV or JSON
   */
  exportResult(result: SqlQueryResult, options: ExportOptions = { format: 'json' }): ExportResult {
    const { format } = options;

    switch (format) {
      case 'csv':
        return this.exportToCSV(result, options);
      case 'json':
        return this.exportToJSON(result, options);
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Export to CSV format
   */
  private exportToCSV(result: SqlQueryResult, options: ExportOptions): ExportResult {
    const {
      includeHeaders = true,
      delimiter = ',',
      nullValue = 'NULL',
    } = options;

    const lines: string[] = [];

    // Add header row
    if (includeHeaders) {
      const header = this.escapeCSVFields(result.columns, delimiter);
      lines.push(header.join(delimiter));
    }

    // Add data rows
    for (const row of result.rows) {
      const values = row.map(v =>
        v === null || v === undefined ? nullValue : String(v)
      );
      const escaped = this.escapeCSVFields(values, delimiter);
      lines.push(escaped.join(delimiter));
    }

    const data = lines.join('\n');

    return {
      data,
      mimeType: 'text/csv',
      filename: `query-result-${Date.now()}.csv`,
      rowCount: result.rowCount,
    };
  }

  /**
   * Escape CSV fields according to RFC 4180
   */
  private escapeCSVFields(fields: string[], delimiter: string): string[] {
    return fields.map(field => {
      const str = String(field);
      // If field contains delimiter, quotes, or newlines, wrap in quotes and escape quotes
      if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
  }

  /**
   * Export to JSON format
   */
  private exportToJSON(result: SqlQueryResult, options: ExportOptions): ExportResult {
    const { prettyPrint = true } = options;

    const jsonData = {
      exportedAt: new Date().toISOString(),
      rowCount: result.rowCount,
      columns: result.columns,
      rows: result.rows,
      query: result.query || null,
    };

    const data = JSON.stringify(jsonData, null, prettyPrint ? 2 : 0);

    return {
      data,
      mimeType: 'application/json',
      filename: `query-result-${Date.now()}.json`,
      rowCount: result.rowCount,
    };
  }

  /**
   * Export multiple results (for session export)
   */
  exportSession(results: Array<{ name: string; result: SqlQueryResult }>, options: ExportOptions = { format: 'json' }): ExportResult {
    if (options.format === 'csv') {
      // For CSV, combine all results into one file with sheet separators
      const lines: string[] = [];

      for (const { name, result } of results) {
        lines.push(`=== ${name} ===`);
        const csvResult = this.exportToCSV(result, options);
        lines.push(csvResult.data);
        lines.push(''); // Empty line between results
      }

      return {
        data: lines.join('\n'),
        mimeType: 'text/csv',
        filename: `session-export-${Date.now()}.csv`,
        rowCount: results.reduce((sum, r) => sum + r.result.rowCount, 0),
      };
    }

    // JSON format - structured export
    const jsonData = {
      exportedAt: new Date().toISOString(),
      totalResults: results.length,
      totalRows: results.reduce((sum, r) => sum + r.result.rowCount, 0),
      results: results.map(({ name, result }) => ({
        name,
        columns: result.columns,
        rowCount: result.rowCount,
        query: result.query,
        rows: result.rows,
      })),
    };

    const data = JSON.stringify(jsonData, null, options.prettyPrint ? 2 : 0);

    return {
      data,
      mimeType: 'application/json',
      filename: `session-export-${Date.now()}.json`,
      rowCount: results.reduce((sum, r) => sum + r.result.rowCount, 0),
    };
  }
  /**
   * Export agentv3 analysis session data (findings, plan, hypotheses, notes, conclusion)
   */
  exportAnalysisSession(data: AnalysisSessionExport, options: ExportOptions = { format: 'json' }): ExportResult {
    if (options.format === 'csv') {
      // Flatten findings into CSV rows
      const columns = ['id', 'severity', 'category', 'title', 'description', 'source'];
      const rows = (data.findings || []).map(f => [
        f.id, f.severity, f.category || '', f.title, f.description, f.source || '',
      ]);
      return this.exportToCSV({ columns, rows, rowCount: rows.length }, options);
    }

    const jsonData = {
      exportedAt: new Date().toISOString(),
      sessionId: data.sessionId,
      traceId: data.traceId,
      sceneType: data.sceneType,
      turnCount: data.turnCount,
      conclusion: data.conclusion,
      findings: data.findings,
      plan: data.plan ? {
        phases: data.plan.phases.map(p => ({
          id: p.id, name: p.name, goal: p.goal, status: p.status, summary: p.summary,
        })),
        successCriteria: data.plan.successCriteria,
        submittedAt: data.plan.submittedAt,
      } : undefined,
      hypotheses: data.hypotheses,
      notes: data.notes,
      uncertaintyFlags: data.uncertaintyFlags,
    };

    const pretty = options.prettyPrint !== false;
    return {
      data: JSON.stringify(jsonData, null, pretty ? 2 : 0),
      mimeType: 'application/json',
      filename: `analysis-${data.sessionId}-${Date.now()}.json`,
      rowCount: (data.findings || []).length,
    };
  }
}

export interface AnalysisSessionExport {
  sessionId: string;
  traceId?: string;
  sceneType?: string;
  turnCount?: number;
  conclusion?: string;
  findings?: Finding[];
  plan?: AnalysisPlanV3;
  hypotheses?: Hypothesis[];
  notes?: AnalysisNote[];
  uncertaintyFlags?: UncertaintyFlag[];
}
