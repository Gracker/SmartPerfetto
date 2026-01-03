/**
 * HTML Report Generator
 *
 * Generates detailed HTML reports for analysis results
 * Reports include:
 * - Full thinking process
 * - All SQL queries and results
 * - Detailed tables with expanded lists
 * - Diagnostic information
 * - Executable SQL for reproduction
 */

import {
  AnalysisSession,
  CollectedResult,
  QueryResult,
  AnalysisCompletedEvent,
} from '../types/analysis';

export interface ReportData {
  sessionId: string;
  traceId: string;
  question: string;
  answer: string;
  metrics: {
    totalDuration: number;
    iterationsCount: number;
    sqlQueriesCount: number;
  };
  collectedResults: CollectedResult[];
  skillEngineResult?: {
    skillId: string;
    skillName: string;
    sections: Record<string, any>;
    diagnostics: Array<{
      id: string;
      severity: string;
      message: string;
      suggestions?: string[];
    }>;
  };
  timestamp: number;
}

export class HTMLReportGenerator {
  /**
   * Generate HTML report from analysis data
   */
  generateHTML(data: ReportData): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto 分析报告 - ${new Date(data.timestamp).toLocaleString('zh-CN')}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f7fa;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
    }

    .header h1 {
      font-size: 28px;
      margin-bottom: 10px;
    }

    .header .meta {
      opacity: 0.9;
      font-size: 14px;
    }

    .header .meta span {
      margin-right: 20px;
    }

    .section {
      padding: 30px;
      border-bottom: 1px solid #eaeaea;
    }

    .section:last-child {
      border-bottom: none;
    }

    .section-title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 20px;
      color: #2c3e50;
      display: flex;
      align-items: center;
    }

    .section-title::before {
      content: '';
      width: 4px;
      height: 20px;
      background: #667eea;
      margin-right: 12px;
      border-radius: 2px;
    }

    .question-box {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      border-left: 4px solid #667eea;
      margin-bottom: 20px;
    }

    .question-box .label {
      font-size: 12px;
      color: #666;
      margin-bottom: 8px;
    }

    .question-box .content {
      font-size: 18px;
      font-weight: 500;
    }

    .answer-box {
      background: #f0f9ff;
      padding: 25px;
      border-radius: 8px;
      border-left: 4px solid #3b82f6;
      line-height: 1.8;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .metric-card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }

    .metric-card .value {
      font-size: 28px;
      font-weight: 700;
      color: #667eea;
    }

    .metric-card .label {
      font-size: 14px;
      color: #666;
      margin-top: 5px;
    }

    .sql-block {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 15px;
    }

    .sql-block .sql-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
    }

    .sql-block .sql-header .title {
      color: #4ec9b0;
      font-weight: 600;
    }

    .sql-block .sql-header .copy-btn {
      background: #0e639c;
      color: white;
      border: none;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .sql-block .sql-header .copy-btn:hover {
      background: #1177bb;
    }

    .query-result {
      margin-top: 15px;
    }

    .query-result .result-header {
      background: #2d2d2d;
      padding: 10px 15px;
      border-radius: 4px 4px 0 0;
      font-size: 13px;
      color: #9cdcfe;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }

    table thead {
      background: #2d2d2d;
      color: #9cdcfe;
    }

    table th,
    table td {
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #eaeaea;
    }

    table th {
      font-weight: 600;
      white-space: nowrap;
    }

    table tbody tr:hover {
      background: #f8f9fa;
    }

    table tbody tr:last-child td {
      border-bottom: none;
    }

    .diagnostic {
      padding: 15px 20px;
      border-radius: 8px;
      margin-bottom: 15px;
      border-left: 4px solid;
    }

    .diagnostic.critical {
      background: #fef2f2;
      border-color: #ef4444;
    }

    .diagnostic.warning {
      background: #fffbeb;
      border-color: #f59e0b;
    }

    .diagnostic.info {
      background: #eff6ff;
      border-color: #3b82f6;
    }

    .diagnostic .severity {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .diagnostic.critical .severity { color: #ef4444; }
    .diagnostic.warning .severity { color: #f59e0b; }
    .diagnostic.info .severity { color: #3b82f6; }

    .suggestions {
      margin-top: 10px;
      padding-left: 20px;
    }

    .suggestions li {
      margin-bottom: 5px;
      color: #666;
    }

    .skill-section {
      background: #fafafa;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }

    .skill-section .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .skill-section .section-header h3 {
      font-size: 16px;
      font-weight: 600;
      color: #2c3e50;
    }

    .skill-section .section-header .count {
      background: #667eea;
      color: white;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }

    .timeline {
      position: relative;
      padding-left: 30px;
    }

    .timeline-item {
      position: relative;
      padding-bottom: 25px;
    }

    .timeline-item::before {
      content: '';
      position: absolute;
      left: -30px;
      top: 5px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #667eea;
      border: 2px solid white;
      box-shadow: 0 0 0 2px #667eea;
    }

    .timeline-item::after {
      content: '';
      position: absolute;
      left: -26px;
      top: 20px;
      width: 2px;
      height: calc(100% - 10px);
      background: #eaeaea;
    }

    .timeline-item:last-child::after {
      display: none;
    }

    .timeline-item .step-number {
      font-size: 12px;
      color: #666;
      margin-bottom: 5px;
    }

    .timeline-item .content {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 8px;
    }

    .footer {
      text-align: center;
      padding: 20px;
      color: #666;
      font-size: 14px;
      background: #f8f9fa;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #666;
    }

    .empty-state .icon {
      font-size: 48px;
      margin-bottom: 15px;
    }

    @media print {
      body {
        background: white;
        padding: 0;
      }
      .container {
        box-shadow: none;
      }
      .sql-block {
        background: #f5f5f5;
        color: #333;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>📊 SmartPerfetto 性能分析报告</h1>
      <div class="meta">
        <span>📅 生成时间: ${new Date(data.timestamp).toLocaleString('zh-CN')}</span>
        <span>🆔 会话ID: ${data.sessionId}</span>
        <span>📁 Trace ID: ${data.traceId}</span>
      </div>
    </div>

    <!-- Metrics -->
    <div class="section">
      <h2 class="section-title">分析概览</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${data.metrics.totalDuration / 1000}s</div>
          <div class="label">总耗时</div>
        </div>
        <div class="metric-card">
          <div class="value">${data.metrics.iterationsCount}</div>
          <div class="label">分析轮次</div>
        </div>
        <div class="metric-card">
          <div class="value">${data.metrics.sqlQueriesCount}</div>
          <div class="label">SQL 查询数</div>
        </div>
      </div>
    </div>

    <!-- Question -->
    <div class="section">
      <h2 class="section-title">用户问题</h2>
      <div class="question-box">
        <div class="label">问题</div>
        <div class="content">${this.escapeHtml(data.question)}</div>
      </div>
    </div>

    <!-- Answer -->
    <div class="section">
      <h2 class="section-title">分析结论</h2>
      <div class="answer-box">
        ${this.formatAnswer(data.answer)}
      </div>
    </div>

    ${data.skillEngineResult ? this.generateSkillEngineSection(data.skillEngineResult) : ''}

    <!-- SQL Queries and Results -->
    <div class="section">
      <h2 class="section-title">查询详情</h2>
      ${data.collectedResults.length > 0
        ? data.collectedResults.map((result, index) =>
            this.generateQueryResultSection(result, index + 1)
          ).join('')
        : '<div class="empty-state"><div class="icon">📭</div><div>无查询结果</div></div>'
      }
    </div>

    <!-- Timeline -->
    <div class="section">
      <h2 class="section-title">执行时间线</h2>
      <div class="timeline">
        ${data.collectedResults.map((result, index) => `
          <div class="timeline-item">
            <div class="step-number">步骤 ${index + 1} · ${new Date(result.timestamp).toLocaleTimeString('zh-CN')}</div>
            <div class="content">
              <strong>查询:</strong> ${result.sql.substring(0, 100)}${result.sql.length > 100 ? '...' : ''}
              <br>
              <strong>结果:</strong> ${result.result.rowCount} 行 · ${result.result.durationMs}ms
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p>由 SmartPerfetto AI 分析引擎生成</p>
      <p style="margin-top: 5px; font-size: 12px;">Powered by Perfetto + DeepSeek</p>
    </div>
  </div>

  <script>
    // Copy SQL functionality
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const sql = this.getAttribute('data-sql');
        navigator.clipboard.writeText(sql).then(() => {
          this.textContent = '已复制!';
          setTimeout(() => {
            this.textContent = '复制 SQL';
          }, 2000);
        });
      });
    });
  </script>
</body>
</html>`;
  }

  /**
   * Generate skill engine specific section
   */
  private generateSkillEngineSection(skillResult: any): string {
    let html = `
    <!-- Skill Engine Results -->
    <div class="section">
      <h2 class="section-title">Skill Engine 分析结果</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${skillResult.skillName}</div>
          <div class="label">分析类型</div>
        </div>
        <div class="metric-card">
          <div class="value">${skillResult.executionTimeMs}ms</div>
          <div class="label">执行耗时</div>
        </div>
        ${skillResult.diagnostics?.length ? `
        <div class="metric-card">
          <div class="value">${skillResult.diagnostics.length}</div>
          <div class="label">诊断问题</div>
        </div>
        ` : ''}
      </div>
    `;

    // Diagnostics
    if (skillResult.diagnostics && skillResult.diagnostics.length > 0) {
      html += `
      <h3 style="margin: 20px 0 15px; font-size: 16px;">诊断结果</h3>
      ${skillResult.diagnostics.map((diag: any) => `
        <div class="diagnostic ${diag.severity}">
          <div class="severity">${this.getSeverityLabel(diag.severity)}</div>
          <div>${this.escapeHtml(diag.message)}</div>
          ${diag.suggestions ? `
            <ul class="suggestions">
              ${diag.suggestions.map((s: string) => `<li>${this.escapeHtml(s)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      `).join('')}
      `;
    }

    // Sections
    if (skillResult.sections) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 16px;">详细分析数据</h3>`;

      for (const [sectionId, sectionData] of Object.entries(skillResult.sections)) {
        const data = sectionData as any;

        // Handle for_each results (array)
        if (Array.isArray(data)) {
          const allRows: any[] = [];
          let columns: string[] = [];

          for (const itemResult of data) {
            if (itemResult?.data && Array.isArray(itemResult.data)) {
              if (columns.length === 0 && itemResult.data.length > 0) {
                columns = Object.keys(itemResult.data[0]);
              }
              allRows.push(...itemResult.data);
            }
          }

          if (allRows.length > 0) {
            html += `
              <div class="skill-section">
                <div class="section-header">
                  <h3>${sectionId}</h3>
                  <span class="count">${allRows.length} 条记录</span>
                </div>
                ${this.generateTable(columns, allRows)}
              </div>
            `;
          }
        }
        // Handle regular step results
        else if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
          const columns = Object.keys(data.data[0]);
          html += `
            <div class="skill-section">
              <div class="section-header">
                <h3>${data.title || sectionId}</h3>
                <span class="count">${data.data.length} 条记录</span>
              </div>
              ${data.sql ? `
                <div class="sql-block">
                  <div class="sql-header">
                    <span class="title">SQL 查询</span>
                    <button class="copy-btn" data-sql="${this.escapeHtml(data.sql)}">复制 SQL</button>
                  </div>
                  <pre>${this.escapeHtml(data.sql)}</pre>
                </div>
              ` : ''}
              ${this.generateTable(columns, data.data)}
            </div>
          `;
        }
      }
    }

    html += `</div>`;
    return html;
  }

  /**
   * Generate query result section
   */
  private generateQueryResultSection(result: CollectedResult, stepNumber: number): string {
    return `
      <div class="query-result" style="background: #fafafa; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
        <h3 style="font-size: 16px; margin-bottom: 15px; color: #2c3e50;">
          查询 #${stepNumber}
          <span style="float: right; font-weight: normal; font-size: 14px; color: #666;">
            ${result.result.rowCount} 行 · ${result.result.durationMs}ms
          </span>
        </h3>

        <div class="sql-block">
          <div class="sql-header">
            <span class="title">SQL 查询</span>
            <button class="copy-btn" data-sql="${this.escapeHtml(result.sql)}">复制 SQL</button>
          </div>
          <pre>${this.escapeHtml(result.sql)}</pre>
        </div>

        ${result.result.error ? `
          <div class="diagnostic critical">
            <div class="severity">ERROR</div>
            <div>${this.escapeHtml(result.result.error)}</div>
          </div>
        ` : result.result.rowCount > 0 ? `
          ${this.generateTable(result.result.columns, this.rowsToObjects(result.result.columns, result.result.rows))}
        ` : `
          <div class="empty-state" style="padding: 20px; background: #f8f9fa; border-radius: 8px;">
            查询返回空结果
          </div>
        `}

        ${result.insight ? `
          <div style="margin-top: 15px; padding: 15px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
            <strong>AI 分析:</strong><br>
            ${this.formatAnswer(result.insight)}
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Generate HTML table from data
   */
  private generateTable(columns: string[], rows: any[]): string {
    if (!rows || rows.length === 0) {
      return '<div class="empty-state">无数据</div>';
    }

    // For very large tables, show first 1000 rows
    const displayRows = rows.slice(0, 1000);
    const hasMore = rows.length > 1000;

    return `
      <div style="overflow-x: auto; border-radius: 8px; border: 1px solid #eaeaea;">
        <table>
          <thead>
            <tr>
              <th>#</th>
              ${columns.map(col => `<th>${this.escapeHtml(col)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${displayRows.map((row, idx) => `
              <tr>
                <td style="color: #666; font-weight: 500;">${idx + 1}</td>
                ${columns.map(col => `<td>${this.formatCellValue(row[col])}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${hasMore ? '<div style="padding: 15px; text-align: center; color: #666; background: #f8f9fa;">... 还有 ' + (rows.length - 1000) + ' 条记录 (表格限制显示 1000 条)</div>' : ''}
      </div>
    `;
  }

  /**
   * Format answer with markdown-like syntax
   */
  private formatAnswer(answer: string): string {
    if (!answer) return '';

    return answer
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Headers
      .replace(/^### (.*$)/gm, '<h4>$1</h4>')
      .replace(/^## (.*$)/gm, '<h3>$1</h3>')
      // Lists
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      .replace(/^(\d+)\. (.*$)/gm, '<li>$2</li>')
      // Line breaks
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }

  /**
   * Format cell value for display
   */
  private formatCellValue(value: any): string {
    if (value === null || value === undefined) {
      return '<span style="color: #999;">NULL</span>';
    }
    if (typeof value === 'number') {
      return value.toLocaleString('zh-CN');
    }
    if (typeof value === 'boolean') {
      return value ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #ef4444;">✗</span>';
    }
    const str = String(value);
    if (str.length > 200) {
      return `<span title="${this.escapeHtml(str)}">${this.escapeHtml(str.substring(0, 200))}...</span>`;
    }
    return this.escapeHtml(str);
  }

  /**
   * Get severity label in Chinese
   */
  private getSeverityLabel(severity: string): string {
    const labels: Record<string, string> = {
      'critical': '🔴 严重问题',
      'warning': '🟡 警告',
      'info': '🔵 信息',
      'error': '❌ 错误',
    };
    return labels[severity] || severity;
  }

  /**
   * Convert result rows to object array
   */
  private rowsToObjects(columns: string[], rows: any[][]): Record<string, any>[] {
    return rows.map(row => {
      const obj: Record<string, any> = {};
      columns.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Generate HTML from session
   */
  generateFromSession(session: AnalysisSession, answer: string): string {
    const data: ReportData = {
      sessionId: session.id,
      traceId: session.traceId,
      question: session.question,
      answer,
      metrics: {
        totalDuration: Date.now() - session.createdAt.getTime(),
        iterationsCount: session.currentIteration,
        sqlQueriesCount: session.collectedResults.length,
      },
      collectedResults: session.collectedResults,
      timestamp: Date.now(),
    };
    return this.generateHTML(data);
  }
}

// Singleton instance
let instance: HTMLReportGenerator | null = null;

export function getHTMLReportGenerator(): HTMLReportGenerator {
  if (!instance) {
    instance = new HTMLReportGenerator();
  }
  return instance;
}

export default HTMLReportGenerator;
