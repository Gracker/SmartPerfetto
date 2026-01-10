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
import { OrchestratorResult, Finding, Diagnostic, ExpertResult, MasterOrchestratorResult, StageResult } from '../agent/types';

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

export interface AgentReportData {
  traceId: string;
  query: string;
  result: OrchestratorResult;
  timestamp: number;
}

export interface MasterAgentReportData {
  traceId: string;
  query: string;
  result: MasterOrchestratorResult;
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
      line-height: 1.5;
      color: #333;
      background: #f5f7fa;
      padding: 15px;
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
      padding: 20px;
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
      padding: 20px;
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
      padding: 15px;
      border-radius: 8px;
      border-left: 4px solid #667eea;
      margin-bottom: 15px;
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
      padding: 15px;
      border-radius: 8px;
      border-left: 4px solid #3b82f6;
      line-height: 1.6;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .metric-card {
      background: #f8f9fa;
      padding: 15px;
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

    .sql-block.collapsed .sql-content {
      display: none;
    }

    .sql-block .sql-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
      cursor: pointer;
      user-select: none;
    }

    .sql-block .sql-header .toggle-icon {
      margin-right: 8px;
      transition: transform 0.2s ease;
      font-size: 12px;
      color: #888;
    }

    .sql-block.collapsed .sql-header .toggle-icon {
      transform: rotate(-90deg);
    }

    .sql-block .sql-header .title {
      color: #4ec9b0;
      font-weight: 600;
      flex: 1;
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

    .sql-content {
      margin-top: 10px;
    }

    .query-result {
      margin-top: 15px;
      border: 1px solid #eaeaea;
      border-radius: 8px;
      overflow: hidden;
    }

    .query-result.collapsed .query-body {
      display: none;
    }

    .query-result-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      background: #f8f9fa;
      border-bottom: 1px solid #eaeaea;
      cursor: pointer;
      user-select: none;
    }

    .query-result-header:hover {
      background: #f0f1f3;
    }

    .query-result-header .toggle-icon {
      margin-right: 8px;
      transition: transform 0.2s ease;
      font-size: 14px;
      color: #666;
    }

    .query-result.collapsed .query-result-header .toggle-icon {
      transform: rotate(-90deg);
    }

    .query-result-header h3 {
      flex: 1;
      font-size: 16px;
      font-weight: 600;
      color: #2c3e50;
      margin: 0;
    }

    .query-result-header .meta {
      font-size: 14px;
      color: #666;
      font-weight: normal;
    }

    .query-body {
      padding: 15px;
      background: #fafafa;
    }

    .table-container {
      border-radius: 8px;
      border: 1px solid #eaeaea;
      overflow-x: auto;
      overflow-y: hidden;
      position: relative;
    }

    /* 水平滚动条样式 */
    .table-container::-webkit-scrollbar {
      height: 8px;
    }

    .table-container::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb {
      background: #c1c1c1;
      border-radius: 4px;
    }

    .table-container::-webkit-scrollbar-thumb:hover {
      background: #a1a1a1;
    }

    /* 表格右侧渐变提示（表示可滚动） */
    .table-container.scrollable::after {
      content: '';
      position: absolute;
      right: 0;
      top: 0;
      bottom: 8px;
      width: 30px;
      background: linear-gradient(to right, transparent, rgba(255,255,255,0.9));
      pointer-events: none;
      opacity: 1;
      transition: opacity 0.3s;
    }

    .table-container.scrolled-right::after {
      opacity: 0;
    }

    .table-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 15px;
      background: #f0f1f3;
      border-bottom: 1px solid #eaeaea;
      cursor: pointer;
      user-select: none;
    }

    .table-header:hover {
      background: #e9ecef;
    }

    .table-header .toggle-icon {
      margin-right: 6px;
      transition: transform 0.2s ease;
      font-size: 12px;
      color: #666;
    }

    .table-header .table-title {
      font-size: 14px;
      font-weight: 600;
      color: #495057;
    }

    .table-header .row-count {
      font-size: 13px;
      color: #666;
    }

    .table-wrapper {
      max-height: 300px;
      overflow-y: auto;
      overflow-x: auto;
      transition: max-height 0.3s ease;
    }

    .table-wrapper.collapsed {
      max-height: 0;
      overflow: hidden;
    }

    .table-wrapper::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    .table-wrapper::-webkit-scrollbar-thumb {
      background: #d1d5db;
      border-radius: 3px;
    }

    .table-rows-more {
      padding: 12px 15px;
      background: #fffbeb;
      border-top: 1px solid #eaeaea;
      text-align: center;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
      color: #f59e0b;
      font-weight: 500;
    }

    .table-rows-more:hover {
      background: #fef3c7;
    }

    .table-rows-more .toggle-text {
      margin-left: 4px;
    }

    table {
      width: auto;
      min-width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      table-layout: auto;
    }

    table thead {
      background: #2d2d2d;
      color: #9cdcfe;
    }

    table th,
    table td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid #eaeaea;
      white-space: nowrap;
    }

    table th {
      font-weight: 600;
      white-space: nowrap;
      position: sticky;
      top: 0;
      z-index: 1;
      background: #2d2d2d;
    }

    table td {
      word-break: break-word;
    }

    /* Row number column */
    table th:first-child,
    table td:first-child {
      min-width: 40px;
      max-width: 50px;
      width: 40px;
      text-align: center;
    }

    /* Text columns need more width */
    table td.col-text {
      min-width: 120px;
      max-width: 400px;
      white-space: normal;
    }

    /* Number columns should be compact */
    table td.col-number {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    table tbody tr:hover {
      background: #f8f9fa;
    }

    table tbody tr:last-child td {
      border-bottom: none;
    }

    .diagnostic {
      padding: 10px 15px;
      border-radius: 8px;
      margin-bottom: 10px;
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
      padding: 15px;
      margin-bottom: 15px;
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
    // Toggle query result section (默认展开)
    function toggleQueryResult(header) {
      const queryResult = header.parentElement;
      queryResult.classList.toggle('collapsed');
    }

    // Toggle SQL block (默认折叠)
    function toggleSqlBlock(event, sqlBlock) {
      event.stopPropagation();
      sqlBlock.classList.toggle('collapsed');
    }

    // Copy SQL functionality
    function copySql(btn) {
      const sql = btn.getAttribute('data-sql');
      navigator.clipboard.writeText(sql).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '已复制!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });
    }

    // Toggle table rows (show/hide more)
    function toggleTableRows(btn, hiddenCount) {
      const tableContainer = btn.parentElement;
      const table = tableContainer.querySelector('table');
      const hiddenRows = table.querySelectorAll('.hidden-row');

      if (hiddenRows.length > 0) {
        const isHidden = hiddenRows[0].style.display === 'none';

        hiddenRows.forEach(row => {
          row.style.display = isHidden ? '' : 'none';
        });

        const span = btn.querySelector('span');
        if (isHidden) {
          span.innerHTML = '▲ 收起更多';
        } else {
          span.innerHTML = '▼ 显示更多 ' + hiddenCount + ' 条记录';
        }
      }
    }

    // Toggle expandable row details (for iterator results)
    function toggleExpandableRow(rowId) {
      const detailsRow = document.getElementById(rowId + '_details');
      const btn = document.querySelector('[onclick="toggleExpandableRow(\\'' + rowId + '\\')"]');

      if (detailsRow) {
        const isHidden = detailsRow.style.display === 'none';
        detailsRow.style.display = isHidden ? 'table-row' : 'none';

        if (btn) {
          const icon = btn.querySelector('.expand-icon');
          if (icon) {
            icon.textContent = isHidden ? '▲' : '▼';
          }
          btn.innerHTML = isHidden
            ? '<span class="expand-icon">▲</span> 收起'
            : '<span class="expand-icon">▼</span> 展开';
        }
      }
    }

    // Expand/collapse all rows in a section
    function toggleAllExpandableRows(sectionId, expand) {
      const section = document.getElementById(sectionId);
      if (!section) return;

      const detailRows = section.querySelectorAll('.detail-row');
      const buttons = section.querySelectorAll('.expand-btn');

      detailRows.forEach(row => {
        row.style.display = expand ? 'table-row' : 'none';
      });

      buttons.forEach(btn => {
        btn.innerHTML = expand
          ? '<span class="expand-icon">▲</span> 收起'
          : '<span class="expand-icon">▼</span> 展开';
      });
    }

    // Legacy copy button handler for backward compatibility
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const sql = this.getAttribute('data-sql');
        if (sql) {
          navigator.clipboard.writeText(sql).then(() => {
            const originalText = this.textContent;
            this.textContent = '已复制!';
            setTimeout(() => {
              this.textContent = originalText;
            }, 2000);
          });
        }
      });
    });

    // 检测表格是否可滚动，添加滚动提示
    function initTableScroll() {
      document.querySelectorAll('.table-container').forEach(container => {
        const table = container.querySelector('table');
        if (!table) return;

        // 检查是否需要滚动
        function checkScrollable() {
          if (container.scrollWidth > container.clientWidth) {
            container.classList.add('scrollable');
          } else {
            container.classList.remove('scrollable');
          }
        }

        // 检查是否滚动到最右边
        function checkScrollPosition() {
          const scrollRight = container.scrollWidth - container.clientWidth - container.scrollLeft;
          if (scrollRight <= 5) {
            container.classList.add('scrolled-right');
          } else {
            container.classList.remove('scrolled-right');
          }
        }

        // 初始化
        checkScrollable();
        checkScrollPosition();

        // 监听滚动事件
        container.addEventListener('scroll', checkScrollPosition);

        // 监听窗口大小变化
        window.addEventListener('resize', () => {
          checkScrollable();
          checkScrollPosition();
        });
      });
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initTableScroll);
    } else {
      initTableScroll();
    }

    // L4 滑动区间折叠功能
    function toggleL4Session(sessionId) {
      const content = document.getElementById(sessionId + '_content');
      const header = content.previousElementSibling;
      const icon = header.querySelector('.session-toggle-icon');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '▼';
      } else {
        content.style.display = 'none';
        icon.textContent = '▶';
      }
    }

    // L4 单帧折叠功能
    function toggleL4Frame(frameId) {
      const content = document.getElementById(frameId + '_content');
      const header = content.previousElementSibling;
      const icon = header.querySelector('.frame-toggle-icon');
      const hint = header.querySelector('span[style*="color: #94a3b8"]');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '▼';
        if (hint) hint.textContent = '点击收起';
      } else {
        content.style.display = 'none';
        icon.textContent = '▶';
        if (hint) hint.textContent = '点击展开详情';
      }
    }

    // L4 展开/折叠某个session下所有帧
    function toggleAllFramesInL4Session(sessionId) {
      const sessionContent = document.getElementById(sessionId + '_content');
      if (!sessionContent) return;
      const frameContents = sessionContent.querySelectorAll('.l4-frame-content');
      const allCollapsed = Array.from(frameContents).every(f => f.style.display === 'none');
      
      frameContents.forEach(content => {
        const header = content.previousElementSibling;
        const icon = header.querySelector('.frame-toggle-icon');
        const hint = header.querySelector('span[style*="color: #94a3b8"]');
        if (allCollapsed) {
          content.style.display = 'block';
          if (icon) icon.textContent = '▼';
          if (hint) hint.textContent = '点击收起';
        } else {
          content.style.display = 'none';
          if (icon) icon.textContent = '▶';
          if (hint) hint.textContent = '点击展开详情';
        }
      });
    }
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

    //优先处理分层结果（L1/L2/L3/L4）
    if (skillResult.layeredResult) {
      html += this.generateLayeredResultSection(skillResult.layeredResult);
    }

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

    // Sections (仅在没有 layeredResult 时渲染)
    if (!skillResult.layeredResult && skillResult.sections) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 16px;">详细分析数据</h3>`;

      for (const [sectionId, sectionData] of Object.entries(skillResult.sections)) {
        const data = sectionData as any;

        // Handle for_each results (array) - 这是旧格式，保留兼容性
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
        // Handle new format with expandableData (iterator results)
        else if (data?.expandableData && Array.isArray(data.expandableData)) {
          html += this.generateExpandableSection(sectionId, data);
        }
        // Handle regular step results
        else if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
          const columns = data.columns || Object.keys(data.data[0]);
          html += `
            <div class="skill-section">
              <div class="section-header">
                <h3>${data.title || sectionId}</h3>
                <span class="count">${data.data.length} 条记录</span>
              </div>
              ${data.sql ? `
                <div class="sql-block collapsed" onclick="toggleSqlBlock(event, this)">
                  <div class="sql-header">
                    <span class="toggle-icon">▼</span>
                    <span class="title">SQL 查询</span>
                    <button class="copy-btn" data-sql="${this.escapeHtml(data.sql)}" onclick="event.stopPropagation(); copySql(this)">复制 SQL</button>
                  </div>
                  <div class="sql-content">
                    <pre>${this.escapeHtml(data.sql)}</pre>
                  </div>
                </div>
              ` : ''}
              ${this.generateTable(columns, data.data)}
            </div>
          `;
        }
        // Handle text format
        else if (data?.format === 'text' && data?.data?.[0]?.text) {
          html += `
            <div class="skill-section">
              <div class="section-header">
                <h3>${data.title || sectionId}</h3>
              </div>
              <div class="answer-box">
                ${this.formatAnswer(data.data[0].text)}
              </div>
            </div>
          `;
        }
      }
    }

    html += `</div>`;
    return html;
  }

  /**
   * Generate expandable section for iterator results
   * 生成可展开的迭代器结果区块，包含主表格和每行的详细数据
   */
  private generateExpandableSection(sectionId: string, data: any): string {
    const title = data.title || sectionId;
    const expandableData = data.expandableData as Array<{
      item: Record<string, any>;
      result: {
        success: boolean;
        sections?: Record<string, any>;
        error?: string;
      };
    }>;

    // 生成唯一的 section ID 用于 JavaScript 操作
    const sectionUniqueId = `expandable_${sectionId}_${Date.now()}`;

    let html = `
      <div class="skill-section expandable-section" id="${sectionUniqueId}">
        <div class="section-header">
          <h3>${title}</h3>
          <span class="count">${expandableData.length} 条记录</span>
        </div>
    `;

    // 显示汇总报告（如果存在）
    if (data.summary) {
      html += `
        <div class="summary-box" style="margin-bottom: 20px; padding: 15px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
          <strong>${this.escapeHtml(data.summary.title || '汇总')}</strong><br>
          ${this.formatAnswer(data.summary.content || '')}
        </div>
      `;
    }

    // 生成主表格（使用 data.columns 和 data.data）
    if (data.columns && data.data && data.data.length > 0) {
      // Filter out absolute timestamp columns when relative timestamp columns exist
      const absoluteTimestampCols = new Set<string>();
      const filteredColumns = data.columns.filter((col: string) => {
        if (col.endsWith('_ts') && col !== 'perfetto_start' && col !== 'perfetto_end') {
          const relCol = col + '_rel';
          if (data.columns.includes(relCol)) {
            absoluteTimestampCols.add(col);
            return false;  // Skip absolute timestamp column
          }
        }
        return true;
      });

      // Detect constant columns (like process_name, layer_name)
      const constantColumns: Record<string, any> = {};
      const variableColumns: string[] = [];

      for (const col of filteredColumns) {
        const firstValue = data.data[0][col];
        const isConstant = data.data.every((row: any) => row[col] === firstValue);

        if (isConstant && firstValue !== undefined && firstValue !== null) {
          constantColumns[col] = firstValue;
        } else {
          variableColumns.push(col);
        }
      }

      // Build the constant column info for the table header
      const constantColumnLabels = Object.entries(constantColumns)
        .filter(([col]) => col === 'process_name' || col === 'layer_name' || col === 'Process Name' || col === 'Layer Name')
        .map(([col, value]) => `<span style="color: #666; font-size: 12px; margin-left: 8px;">${this.escapeHtml(col)}: <strong>${this.escapeHtml(String(value))}</strong></span>`)
        .join('');

      // 主表格但行可点击展开
      html += `
        <div class="table-container expandable-table">
          ${constantColumnLabels ? `
            <div class="table-header-info" style="padding: 8px 12px; background: #f8f9fa; border-bottom: 1px solid #eaeaea; font-size: 13px;">
              ${constantColumnLabels}
            </div>
          ` : ''}
          <table>
            <thead>
              <tr>
                ${variableColumns.map((col: string) => `<th>${this.escapeHtml(col)}</th>`).join('')}
                <th style="width: 80px;">详情</th>
              </tr>
            </thead>
            <tbody>
      `;

      data.data.forEach((row: any, idx: number) => {
        const hasDetails = expandableData[idx]?.result?.sections &&
                          Object.keys(expandableData[idx].result.sections || {}).length > 0;
        const rowId = `${sectionUniqueId}_row_${idx}`;

        html += `
              <tr class="expandable-row" data-row-id="${rowId}" ${hasDetails ? 'style="cursor: pointer;"' : ''}>
                ${variableColumns.map((col: string) => {
                  const value = Array.isArray(row) ? row[data.columns.indexOf(col)] : row[col];
                  return `<td>${this.formatCellValue(value)}</td>`;
                }).join('')}
                <td>
                  ${hasDetails ? `
                    <button class="expand-btn" onclick="toggleExpandableRow('${rowId}')" style="background: #667eea; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                      <span class="expand-icon">▼</span> 展开
                    </button>
                  ` : '<span style="color: #999;">-</span>'}
                </td>
              </tr>
        `;

        // 添加隐藏的详情行
        if (hasDetails) {
          html += `
              <tr class="detail-row" id="${rowId}_details" style="display: none;">
                <td colspan="${variableColumns.length + 1}" style="padding: 0; background: #fafafa;">
                  ${this.generateDetailContent(expandableData[idx])}
                </td>
              </tr>
          `;
        }
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    }

    html += `</div>`;
    return html;
  }

  /**
   * Generate detail content for a single expandable row
   * 生成单行展开后的详细内容
   */
  private generateDetailContent(itemData: {
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }): string {
    const { item, result } = itemData;

    let html = `<div class="detail-content" style="padding: 15px; border-left: 4px solid #667eea;">`;

    // 显示原始项信息
    html += `
      <div style="margin-bottom: 10px; padding: 8px; background: #f8f9fa; border-radius: 6px;">
        <strong style="color: #666;">原始数据：</strong>
        <code style="font-size: 12px; color: #333;">${this.escapeHtml(JSON.stringify(item, null, 2).substring(0, 500))}</code>
      </div>
    `;

    if (!result.success) {
      html += `
        <div class="diagnostic critical">
          <div class="severity">❌ 分析失败</div>
          <div>${this.escapeHtml(result.error || '未知错误')}</div>
        </div>
      `;
    } else if (result.sections) {
      // 遍历所有 sections 生成表格
      for (const [subSectionId, subSectionData] of Object.entries(result.sections)) {
        const subData = subSectionData as any;
        const subTitle = subData.title || subSectionId;

        if (subData.data && Array.isArray(subData.data) && subData.data.length > 0) {
          const columns = subData.columns || Object.keys(subData.data[0]);
          html += `
            <div style="margin-bottom: 10px;">
              <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #2c3e50;">
                ${this.escapeHtml(subTitle)}
                <span style="font-weight: normal; color: #666; margin-left: 8px;">(${subData.data.length} 条)</span>
              </h4>
              ${this.generateTable(columns, subData.data)}
            </div>
          `;
        } else if (subData.diagnostics && Array.isArray(subData.diagnostics)) {
          // 显示诊断结果
          html += `
            <div style="margin-bottom: 10px;">
              <h4 style="font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #2c3e50;">
                ${this.escapeHtml(subTitle)}
              </h4>
              ${subData.diagnostics.map((diag: any) => `
                <div class="diagnostic ${diag.severity || 'info'}" style="margin-bottom: 6px;">
                  <div class="severity">${this.getSeverityLabel(diag.severity || 'info')}</div>
                  <div>${this.escapeHtml(diag.message || diag.diagnosis || '')}</div>
                  ${diag.suggestions ? `
                    <ul class="suggestions">
                      ${diag.suggestions.map((s: string) => `<li>${this.escapeHtml(s)}</li>`).join('')}
                    </ul>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          `;
        }
      }
    }

    html += `</div>`;
    return html;
  }

  /**
   * Generate query result section with collapsible support
   */
  private generateQueryResultSection(result: CollectedResult, stepNumber: number): string {
    // 如果 insight 是 section title，将其作为主标题显示
    const displayTitle = result.insight && result.insight !== result.sql
      ? result.insight
      : `查询 #${stepNumber}`;

    return `
      <div class="query-result">
        <div class="query-result-header" onclick="toggleQueryResult(this)">
          <span class="toggle-icon">▼</span>
          <h3>${this.escapeHtml(displayTitle)}</h3>
          <span class="meta">${result.result.rowCount} 行 · ${result.result.durationMs}ms</span>
        </div>

        <div class="query-body">
          <!-- SQL Block (默认折叠) -->
          <div class="sql-block collapsed" onclick="toggleSqlBlock(event, this)">
            <div class="sql-header">
              <span class="toggle-icon">▼</span>
              <span class="title">SQL 查询</span>
              <button class="copy-btn" data-sql="${this.escapeHtml(result.sql)}" onclick="event.stopPropagation(); copySql(this)">复制 SQL</button>
            </div>
            <div class="sql-content">
              <pre>${this.escapeHtml(result.sql)}</pre>
            </div>
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
      </div>
    `;
  }

  /**
   * Generate HTML table from data (with collapsible rows for large tables)
   */
  private generateTable(columns: string[], rows: any[]): string {
    if (!rows || rows.length === 0) {
      return '<div class="empty-state">无数据</div>';
    }

    const totalRows = rows.length;
    const defaultVisibleRows = 10;
    const hasMore = totalRows > defaultVisibleRows;

    // Filter out absolute timestamp columns when relative timestamp columns exist
    // This makes the report more readable by showing relative times instead of raw nanoseconds
    const absoluteTimestampCols = new Set<string>();
    const relativeTimestampCols = new Set<string>();

    for (const col of columns) {
      if (col.endsWith('_ts') && col !== 'perfetto_start' && col !== 'perfetto_end') {
        const relCol = col + '_rel';
        if (columns.includes(relCol)) {
          absoluteTimestampCols.add(col);
          relativeTimestampCols.add(relCol);
        }
      }
    }

    // Filter out absolute timestamp columns that have relative counterparts
    const filteredColumns = columns.filter(col => !absoluteTimestampCols.has(col));

    // Detect columns with constant values (like process_name, layer_name)
    // These should be moved to the table header instead of repeating in every row
    // BUT: Only do this for tables with multiple rows - single row tables should show all columns
    const constantColumns: Record<string, any> = {};
    const variableColumns: string[] = [];

    // For single-row tables, show all columns (no point in hiding "constant" columns)
    if (rows.length === 1) {
      variableColumns.push(...filteredColumns);
    } else {
      for (const col of filteredColumns) {
        const firstValue = rows[0][col];
        const isConstant = rows.every(row => row[col] === firstValue);

        if (isConstant && firstValue !== undefined && firstValue !== null) {
          constantColumns[col] = firstValue;
        } else {
          variableColumns.push(col);
        }
      }
    }

    // Always render all rows, but hide extra rows via CSS class
    const visibleRows = rows.slice(0, defaultVisibleRows);
    const hiddenRows = hasMore ? rows.slice(defaultVisibleRows) : [];

    // Build the constant column info for the table header
    const constantColumnLabels = Object.entries(constantColumns)
      .filter(([col]) => col === 'process_name' || col === 'layer_name' || col === 'Process Name' || col === 'Layer Name')
      .map(([col, value]) => `<span style="color: #666; font-size: 12px; margin-left: 8px;">${this.escapeHtml(col)}: <strong>${this.escapeHtml(String(value))}</strong></span>`)
      .join('');

    return `
      <div class="table-container">
        ${constantColumnLabels ? `
          <div class="table-header-info" style="padding: 8px 12px; background: #f8f9fa; border-bottom: 1px solid #eaeaea; font-size: 13px;">
            ${constantColumnLabels}
          </div>
        ` : ''}
        <table>
          <thead>
            <tr>
              <th>#</th>
              ${variableColumns.map(col => `<th>${this.escapeHtml(col)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${visibleRows.map((row, idx) => `
              <tr>
                <td style="color: #666; font-weight: 500;">${idx + 1}</td>
                ${variableColumns.map(col => `<td class="${this.getCellClass(row[col])}">${this.formatCellValue(row[col])}</td>`).join('')}
              </tr>
            `).join('')}
            ${hiddenRows.map((row, idx) => `
              <tr class="hidden-row" style="display: none;">
                <td style="color: #666; font-weight: 500;">${defaultVisibleRows + idx + 1}</td>
                ${variableColumns.map(col => `<td class="${this.getCellClass(row[col])}">${this.formatCellValue(row[col])}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${hasMore ? `
          <div class="table-rows-more" onclick="toggleTableRows(this, ${totalRows - defaultVisibleRows})">
            <span>▼ 显示更多 ${totalRows - defaultVisibleRows} 条记录</span>
          </div>
        ` : ''}
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
      const formatted = value.toLocaleString('zh-CN');
      console.log(`[formatCellValue] Number: ${value} -> ${formatted}`);
      return formatted;
    }
    if (typeof value === 'boolean') {
      return value ? '<span style="color: #10b981;">✓</span>' : '<span style="color: #ef4444;">✗</span>';
    }
    const str = String(value);
    console.log(`[formatCellValue] String: "${str}" (length=${str.length})`);
    if (str.length > 200) {
      return `<span title="${this.escapeHtml(str)}">${this.escapeHtml(str.substring(0, 200))}...</span>`;
    }
    return this.escapeHtml(str);
  }

  private getCellClass(value: any): string {
    if (typeof value === 'number') {
      return 'col-number';
    }
    if (typeof value === 'string' && value.length > 20) {
      return 'col-text';
    }
    return '';
  }

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
   * Generate layered result section (L1/L2/L3/L4)
   * 生成分层结果区块，支持 L1/L2/L3/L4 各层展示
   */
  private generateLayeredResultSection(layeredResult: any): string {
    let html = '';

    const { layers, metadata } = layeredResult;

    // 添加元数据信息
    if (metadata) {
      html += `
        <div style="margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 8px; font-size: 14px; color: #666;">
          <strong>Skill:</strong> ${this.escapeHtml(metadata.skillName || 'Unknown')}
          ${metadata.version ? `<span style="margin-left: 15px;"><strong>版本:</strong> ${metadata.version}</span>` : ''}
          ${metadata.executedAt ? `<span style="margin-left: 15px;"><strong>执行时间:</strong> ${new Date(metadata.executedAt).toLocaleString('zh-CN')}</span>` : ''}
        </div>
      `;
    }

    // L1 - 概览层
    if (layers.L1 && Object.keys(layers.L1).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">📊 L1 - 概览层</h3>`;
      html += this.generateLayerContent(layers.L1, 'L1');
    }

    // L2 - 区间层
    if (layers.L2 && Object.keys(layers.L2).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">📋 L2 - 区间层</h3>`;
      html += this.generateLayerContent(layers.L2, 'L2');
    }

    // L3 - 区间详情层
    if (layers.L3 && Object.keys(layers.L3).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">🔍 L3 - 区间详情层</h3>`;
      html += this.generateLayerContent(layers.L3, 'L3');
    }

    // L4 - 帧分析层
    if (layers.L4 && Object.keys(layers.L4).length > 0) {
      html += `<h3 style="margin: 30px 0 15px; font-size: 18px; color: #2c3e50;">🎯 L4 - 帧分析层</h3>`;
      html += this.generateLayerContent(layers.L4, 'L4');
    }

    return html;
  }

  /**
   * Generate content for a specific layer
   */
  private generateLayerContent(layerData: any, layerType: string): string {
    let html = '';

    // L1 和 L2 是平铺结构：Record<string, StepResult>
    if (layerType === 'L1' || layerType === 'L2') {
      for (const [stepId, stepResult] of Object.entries(layerData)) {
        const result = stepResult as any;
        html += this.renderStepResult(stepId, result);
      }
    }
    // L3 是嵌套结构：Record<string, Record<string, StepResult>>
    else if (layerType === 'L3') {
      for (const [sessionId, sessionSteps] of Object.entries(layerData)) {
        html += `
          <div style="margin-bottom: 20px;">
            <h4 style="font-size: 15px; font-weight: 600; margin-bottom: 10px; color: #34495e;">
              📁 ${this.escapeHtml(sessionId)}
            </h4>
        `;
        for (const [stepId, stepResult] of Object.entries(sessionSteps as Record<string, any>)) {
          const result = stepResult as any;
          html += this.renderStepResult(stepId, result);
        }
        html += `</div>`;
      }
    }
    // L4 是嵌套结构：Record<string, Record<string, StepResult>>
    else if (layerType === 'L4') {
      // 获取L2数据以显示区间信息
      let sessionIndex = 0;
      for (const [sessionId, frames] of Object.entries(layerData)) {
        sessionIndex++;
        const frameEntries = Object.entries(frames as Record<string, any>);
        const frameCount = frameEntries.length;
        const sessionNum = sessionId.replace('session_', '');

        html += `
          <div class="l4-session-container" style="margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div class="l4-session-header" style="padding: 12px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="toggleL4Session('${sessionId}')">
              <div>
                <span class="session-toggle-icon" style="margin-right: 8px;">▼</span>
                <strong>滑动区间 ${sessionNum}</strong>
                <span style="margin-left: 12px; opacity: 0.9;">${frameCount} 个掉帧</span>
              </div>
              <button onclick="event.stopPropagation(); toggleAllFramesInL4Session('${sessionId}')" style="padding: 4px 12px; background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; cursor: pointer; font-size: 12px;">
                全部展开
              </button>
            </div>
            <div class="l4-session-content" id="${sessionId}_content" style="padding: 12px;">
        `;

        frameEntries.forEach(([frameId, stepResult], idx) => {
          const result = stepResult as any;
          const frameTitle = result.display?.title || frameId;
          const uniqueFrameId = `${sessionId}_${frameId}`;

          html += `
              <div class="l4-frame-item" style="margin-bottom: 8px; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;">
                <div class="l4-frame-header" style="padding: 10px 12px; background: #f8fafc; cursor: pointer; display: flex; justify-content: space-between; align-items: center;" onclick="toggleL4Frame('${uniqueFrameId}')">
                  <div>
                    <span class="frame-toggle-icon" style="margin-right: 8px; color: #64748b;">▶</span>
                    <span style="font-weight: 500; color: #334155;">${this.escapeHtml(frameTitle)}</span>
                  </div>
                  <span style="font-size: 12px; color: #94a3b8;">点击展开详情</span>
                </div>
                <div class="l4-frame-content" id="${uniqueFrameId}_content" style="display: none; padding: 12px; background: white;">
                  ${this.renderL4FrameAnalysis(result.data)}
                </div>
              </div>
          `;
        });

        html += `
            </div>
          </div>
        `;
      }
    }

    return html;
  }

  /**
   * Render a single step result from layered output
   */
  private renderStepResult(stepId: string, stepResult: any): string {
    if (!stepResult || !stepResult.data) {
      console.log(`[renderStepResult] ${stepId}: No data available`);
      return '';
    }

    console.log(`[renderStepResult] ${stepId}: data type=${typeof stepResult.data}, isArray=${Array.isArray(stepResult.data)}, length=${stepResult.data?.length || 'N/A'}`);

    let html = `
      <div class="skill-section" style="margin-bottom: 15px;">
        <div class="section-header">
          <h3>${this.escapeHtml(stepResult.display?.title || stepId)}</h3>
          ${Array.isArray(stepResult.data) ? `<span class="count">${stepResult.data.length} 条记录</span>` : ''}
          ${stepResult.success === false ? `<span class="error-badge" style="margin-left: 10px; padding: 2px 8px; background: #ef4444; color: white; border-radius: 4px; font-size: 12px;">失败</span>` : ''}
        </div>
    `;

    // 显示错误信息（如果有）
    if (stepResult.error) {
      console.log(`[renderStepResult] ${stepId}: Step failed with error:`, stepResult.error);
      html += `
        <div style="padding: 12px; background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; margin-bottom: 10px;">
          <div style="font-weight: 600; color: #dc2626; margin-bottom: 4px;">错误信息:</div>
          <div style="font-family: monospace; font-size: 13px; color: #991b1b; white-space: pre-wrap;">${this.escapeHtml(String(stepResult.error))}</div>
        </div>
      `;
    }

    // 处理 displayResults 格式（来自 L4 iterator 结果）
    if (Array.isArray(stepResult.data) && stepResult.data.length > 0) {
      const firstItem = stepResult.data[0];

      console.log(`[renderStepResult] ${stepId}: First item:`, JSON.stringify({
        keys: Object.keys(firstItem || {}),
        hasStepId: !!firstItem?.stepId,
        hasTitle: !!firstItem?.title,
        sample: firstItem
      }, null, 2));

      // 如果是 displayResults 格式，渲染为子区块
      if (firstItem.stepId || firstItem.title) {
        console.log(`[renderStepResult] ${stepId}: Using displayResult format (has stepId or title)`);
        for (const displayResult of stepResult.data) {
          html += this.renderDisplayResult(displayResult);
        }
      }
      // 如果是普通数据数组，渲染为表格
      else {
        const columns = Object.keys(firstItem);
        console.log(`[renderStepResult] ${stepId}: Using table format, columns:`, columns);
        html += this.generateTable(columns, stepResult.data);
      }
    }
    // 处理空数组（失败的 SQL 查询或无结果）
    else if (Array.isArray(stepResult.data)) {
      console.log(`[renderStepResult] ${stepId}: Empty array, showing 'No data' message`);
      const message = stepResult.error ? '查询失败' : '无数据';
      html += `<div class="empty-state" style="padding: 20px; background: #f8f9fa; border-radius: 8px; color: #666;">${message}</div>`;
    }
    // 处理文本格式
    else if (stepResult.data?.text) {
      console.log(`[renderStepResult] ${stepId}: Using text format`);
      html += `
        <div class="answer-box">
          ${this.formatAnswer(stepResult.data.text)}
        </div>
      `;
    }
    // 处理 L4 帧分析格式 (transformed data with diagnosis_summary and full_analysis)
    else if (stepResult.data?.diagnosis_summary !== undefined || stepResult.data?.full_analysis) {
      console.log(`[renderStepResult] ${stepId}: Using L4 frame analysis format`);
      html += this.renderL4FrameAnalysis(stepResult.data);
    }
    else {
      console.log(`[renderStepResult] ${stepId}: Unknown format, data:`, typeof stepResult.data, stepResult.data);
    }

    html += `</div>`;
    return html;
  }

  /**
   * Render a single displayResult from layered output
   */
  private renderDisplayResult(displayResult: any): string {
    console.log(`[renderDisplayResult] displayResult:`, JSON.stringify({
      hasStepId: !!displayResult.stepId,
      hasTitle: !!displayResult.title,
      hasData: !!displayResult.data,
      dataType: typeof displayResult.data,
      dataIsArray: Array.isArray(displayResult.data),
      dataHasRows: !!displayResult.data?.rows,
      dataHasText: !!displayResult.data?.text,
      dataKeys: displayResult.data ? Object.keys(displayResult.data) : [],
    }, null, 2));

    let html = `
      <div style="margin: 10px 0; padding: 12px; background: #fafbfc; border-radius: 6px; border-left: 3px solid #3498db;">
        <h5 style="margin: 0 0 8px 0; font-size: 14px; color: #2c3e50;">
          ${this.escapeHtml(displayResult.title || displayResult.stepId || '详情')}
        </h5>
    `;

    if (displayResult.data) {
      // 如果有 rows，渲染为表格
      if (displayResult.data.rows && Array.isArray(displayResult.data.rows)) {
        const columns = displayResult.data.columns || [];
        const tableData = this.rowsToObjects(columns, displayResult.data.rows);
        html += this.generateTable(columns, tableData);
      }
      // 如果有 text，渲染为文本
      else if (displayResult.data.text) {
        html += `<div style="font-size: 13px; line-height: 1.6;">${this.formatAnswer(displayResult.data.text)}</div>`;
      }
      else {
        console.log(`[renderDisplayResult] No matching format for data:`, typeof displayResult.data, displayResult.data);
      }
    }
    else {
      console.log(`[renderDisplayResult] No data in displayResult`);
    }

    html += `</div>`;
    return html;
  }

  private renderL4FrameAnalysis(data: { diagnosis_summary?: string; full_analysis?: any }): string {
    const diagnosis = data.diagnosis_summary || '暂无诊断';
    const analysis = data.full_analysis || {};
    const quadrants = analysis.quadrants || {};
    const binderCalls = analysis.binder_calls || [];
    const cpuFreq = analysis.cpu_frequency || {};
    const mainSlices = analysis.main_thread_slices || [];
    const renderSlices = analysis.render_thread_slices || [];
    const freqTimeline = analysis.cpu_freq_timeline || [];
    const lockContentions = analysis.lock_contentions || [];

    let html = '';

    html += `
      <div style="padding: 12px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px; margin-bottom: 12px;">
        <div style="font-weight: 600; color: #92400e; margin-bottom: 4px;">诊断结论</div>
        <div style="color: #78350f;">${this.escapeHtml(diagnosis)}</div>
      </div>
    `;

    if (quadrants.main_thread || quadrants.render_thread) {
      html += `<div style="margin-bottom: 16px;">`;
      
      if (quadrants.main_thread) {
        const mt = quadrants.main_thread;
        const runningPct = ((mt.q1 || 0) + (mt.q2 || 0)).toFixed(1);
        const waitingPct = ((mt.q3 || 0) + (mt.q4 || 0)).toFixed(1);
        html += `
          <div style="margin-bottom: 12px;">
            <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">
              主线程状态分布 
              <span style="font-weight: 400; font-size: 12px; color: #64748b;">(运行 ${runningPct}% | 等待 ${waitingPct}%)</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Running (运行中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #dcfce7; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #166534;">${mt.q1?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #166534;">大核</div>
                  </div>
                  <div style="padding: 12px 8px; background: #dbeafe; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${mt.q2?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #1e40af;">小核</div>
                  </div>
                </div>
              </div>
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Waiting (等待中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #fef9c3; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #854d0e;">${mt.q3?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #854d0e;">Runnable</div>
                  </div>
                  <div style="padding: 12px 8px; background: #f3e8ff; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #6b21a8;">${mt.q4?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #6b21a8;">Sleeping</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
      }

      if (quadrants.render_thread) {
        const rt = quadrants.render_thread;
        const runningPct = ((rt.q1 || 0) + (rt.q2 || 0)).toFixed(1);
        const waitingPct = ((rt.q3 || 0) + (rt.q4 || 0)).toFixed(1);
        html += `
          <div style="margin-bottom: 12px;">
            <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">
              RenderThread 状态分布
              <span style="font-weight: 400; font-size: 12px; color: #64748b;">(运行 ${runningPct}% | 等待 ${waitingPct}%)</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Running (运行中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #dcfce7; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #166534;">${rt.q1?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #166534;">大核</div>
                  </div>
                  <div style="padding: 12px 8px; background: #dbeafe; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #1e40af;">${rt.q2?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #1e40af;">小核</div>
                  </div>
                </div>
              </div>
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="padding: 6px 10px; background: #f1f5f9; font-size: 12px; font-weight: 600; color: #475569; text-align: center; border-bottom: 1px solid #e2e8f0;">Waiting (等待中)</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #e2e8f0;">
                  <div style="padding: 12px 8px; background: #fef9c3; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #854d0e;">${rt.q3?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #854d0e;">Runnable</div>
                  </div>
                  <div style="padding: 12px 8px; background: #f3e8ff; text-align: center;">
                    <div style="font-size: 20px; font-weight: 700; color: #6b21a8;">${rt.q4?.toFixed(1) || 0}%</div>
                    <div style="font-size: 11px; color: #6b21a8;">Sleeping</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
      }
      
      html += `</div>`;
    }

    if (binderCalls.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">Binder 调用</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">目标进程</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">调用次数</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">总耗时</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">最大耗时</th>
              </tr>
            </thead>
            <tbody>
              ${binderCalls.map((b: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(b.server_process || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${b.call_count || 0}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(b.total_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(b.max_ms || 0).toFixed(2)} ms</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (cpuFreq.big_avg_mhz || cpuFreq.little_avg_mhz) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">CPU 频率</div>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
            <div style="padding: 10px; background: #fee2e2; border-radius: 6px; text-align: center;">
              <div style="font-size: 18px; font-weight: 700; color: #991b1b;">${cpuFreq.big_avg_mhz || 0} MHz</div>
              <div style="font-size: 12px; color: #991b1b;">大核平均频率</div>
            </div>
            <div style="padding: 10px; background: #e0e7ff; border-radius: 6px; text-align: center;">
              <div style="font-size: 18px; font-weight: 700; color: #3730a3;">${cpuFreq.little_avg_mhz || 0} MHz</div>
              <div style="font-size: 12px; color: #3730a3;">小核平均频率</div>
            </div>
          </div>
        </div>
      `;
    }

    if (mainSlices.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">主线程耗时操作</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">操作名称</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">总耗时</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">次数</th>
              </tr>
            </thead>
            <tbody>
              ${mainSlices.slice(0, 5).map((s: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(s.name || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(s.total_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${s.count || 1}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (renderSlices.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">RenderThread 耗时操作</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">操作名称</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">总耗时</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">次数</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">最大耗时</th>
              </tr>
            </thead>
            <tbody>
              ${renderSlices.slice(0, 5).map((s: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(s.name || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(s.total_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${s.count || 1}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(s.max_ms || 0).toFixed(2)} ms</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    if (freqTimeline.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">
            CPU 频率变化
            <span style="font-weight: 400; font-size: 12px; color: #64748b;">(${freqTimeline.length} 次变化)</span>
          </div>
          <div style="font-size: 12px; line-height: 1.6; background: #f8fafc; padding: 10px; border-radius: 6px; max-height: 150px; overflow-y: auto;">
            ${freqTimeline.slice(0, 20).map((f: any) => {
              const changeIcon = f.change_direction === 'up' ? '↑' : (f.change_direction === 'down' ? '↓' : '→');
              const changeColor = f.change_direction === 'up' ? '#16a34a' : (f.change_direction === 'down' ? '#dc2626' : '#64748b');
              const coreColor = f.core_type === 'big' ? '#991b1b' : '#3730a3';
              return `
                <div style="margin-bottom: 4px;">
                  <span style="color: #64748b;">+${(f.relative_ms || 0).toFixed(1)}ms</span>
                  <span style="margin-left: 8px; color: ${coreColor}; font-weight: 500;">C${f.cpu}</span>
                  <span style="color: ${changeColor}; margin-left: 4px;">${changeIcon}</span>
                  <span style="margin-left: 4px;">${f.prev_freq_mhz || f.freq_mhz}→${f.freq_mhz} MHz</span>
                </div>
              `;
            }).join('')}
            ${freqTimeline.length > 20 ? `<div style="color: #64748b; font-style: italic;">... 还有 ${freqTimeline.length - 20} 次变化</div>` : ''}
          </div>
        </div>
      `;
    }

    if (lockContentions.length > 0) {
      html += `
        <div style="margin-bottom: 12px;">
          <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #2c3e50;">锁竞争</div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead style="background: #f1f5f9;">
              <tr>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">阻塞方法</th>
                <th style="padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0;">持锁线程</th>
                <th style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">等待时间</th>
                <th style="padding: 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">主线程</th>
              </tr>
            </thead>
            <tbody>
              ${lockContentions.slice(0, 5).map((l: any) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px;">${this.escapeHtml(l.blocking_method || '')}</td>
                  <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${this.escapeHtml(l.blocking_thread_name || '')}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #e2e8f0;">${(l.wait_ms || 0).toFixed(2)} ms</td>
                  <td style="padding: 8px; text-align: center; border-bottom: 1px solid #e2e8f0;">${l.main_blocked ? '⚠️' : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    return html;
  }

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

  generateAgentHTML(data: AgentReportData): string {
    const { traceId, query, result, timestamp } = data;
    const { intent, plan, expertResults, synthesizedAnswer, confidence, executionTimeMs, trace } = result;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto Agent 分析报告 - ${new Date(timestamp).toLocaleString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.5; color: #333; background: #f5f7fa; padding: 15px;
    }
    .container {
      max-width: 1200px; margin: 0 auto; background: white;
      border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white; padding: 20px;
    }
    .header h1 { font-size: 28px; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 14px; }
    .header .meta span { margin-right: 20px; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 12px;
      font-size: 12px; font-weight: 600;
    }
    .badge-agent { background: rgba(255,255,255,0.2); }
    .section { padding: 20px; border-bottom: 1px solid #eaeaea; }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #2c3e50;
      display: flex; align-items: center;
    }
    .section-title::before {
      content: ''; width: 4px; height: 20px; background: #10b981;
      margin-right: 12px; border-radius: 2px;
    }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; }
    .metric-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #10b981; }
    .metric-card .label { font-size: 14px; color: #666; margin-top: 5px; }
    .intent-box {
      background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;
    }
    .intent-box .goal { font-size: 18px; font-weight: 600; color: #166534; margin-bottom: 8px; }
    .intent-box .aspects { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .aspect-tag {
      background: #dcfce7; color: #166534; padding: 4px 10px;
      border-radius: 4px; font-size: 13px;
    }
    .answer-box {
      background: #f0f9ff; padding: 20px; border-radius: 8px;
      border-left: 4px solid #3b82f6; line-height: 1.8;
    }
    .plan-task {
      padding: 12px 15px; margin-bottom: 10px; background: #fafafa;
      border-radius: 8px; border-left: 4px solid #6366f1;
    }
    .plan-task .task-header { display: flex; justify-content: space-between; align-items: center; }
    .plan-task .expert { font-weight: 600; color: #4f46e5; }
    .plan-task .objective { color: #666; margin-top: 5px; }
    .finding {
      padding: 12px 15px; margin-bottom: 10px; border-radius: 8px; border-left: 4px solid;
    }
    .finding.critical { background: #fef2f2; border-color: #ef4444; }
    .finding.warning { background: #fffbeb; border-color: #f59e0b; }
    .finding.info { background: #eff6ff; border-color: #3b82f6; }
    .finding .title { font-weight: 600; margin-bottom: 5px; }
    .finding.critical .title { color: #dc2626; }
    .finding.warning .title { color: #d97706; }
    .finding.info .title { color: #2563eb; }
    .diagnostic {
      padding: 10px 15px; margin-bottom: 8px; background: #f8f9fa;
      border-radius: 6px; display: flex; align-items: flex-start; gap: 10px;
    }
    .diagnostic .status { font-size: 16px; }
    .diagnostic .message { flex: 1; }
    .suggestions { margin-top: 8px; padding-left: 20px; }
    .suggestions li { margin-bottom: 4px; color: #666; }
    .expert-section {
      margin-bottom: 20px; border: 1px solid #e5e7eb;
      border-radius: 8px; overflow: hidden;
    }
    .expert-header {
      padding: 12px 16px; background: #f3f4f6;
      display: flex; justify-content: space-between; align-items: center;
    }
    .expert-header .name { font-weight: 600; color: #374151; }
    .expert-header .confidence {
      background: #dcfce7; color: #166534; padding: 2px 8px;
      border-radius: 4px; font-size: 12px;
    }
    .expert-body { padding: 16px; }
    .trace-section { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; }
    .trace-section pre { white-space: pre-wrap; font-size: 12px; }
    .collapsible { cursor: pointer; user-select: none; }
    .collapsible-content { display: none; }
    .collapsible-content.show { display: block; }
    .toggle-icon { margin-right: 8px; transition: transform 0.2s; }
    .footer {
      text-align: center; padding: 20px; color: #666;
      font-size: 14px; background: #f8f9fa;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 SmartPerfetto Agent 分析报告</h1>
      <div class="meta">
        <span class="badge badge-agent">Agent Mode</span>
        <span>📅 ${new Date(timestamp).toLocaleString('zh-CN')}</span>
        <span>📁 Trace ID: ${traceId}</span>
        <span>⏱️ ${(executionTimeMs / 1000).toFixed(2)}s</span>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">分析概览</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${(confidence * 100).toFixed(0)}%</div>
          <div class="label">置信度</div>
        </div>
        <div class="metric-card">
          <div class="value">${expertResults.length}</div>
          <div class="label">专家参与</div>
        </div>
        <div class="metric-card">
          <div class="value">${trace.totalLLMCalls}</div>
          <div class="label">LLM 调用</div>
        </div>
        <div class="metric-card">
          <div class="value">${(executionTimeMs / 1000).toFixed(1)}s</div>
          <div class="label">总耗时</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">用户查询与意图</h2>
      <div class="intent-box">
        <div class="goal">🎯 ${this.escapeHtml(intent.primaryGoal)}</div>
        <div style="margin-top: 8px; color: #666;">
          <strong>原始查询：</strong>${this.escapeHtml(query)}
        </div>
        <div class="aspects">
          ${intent.aspects.map(a => `<span class="aspect-tag">${this.escapeHtml(a)}</span>`).join('')}
        </div>
        <div style="margin-top: 10px; font-size: 13px; color: #666;">
          <span>输出类型: <strong>${intent.expectedOutputType}</strong></span>
          <span style="margin-left: 15px;">复杂度: <strong>${intent.complexity}</strong></span>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">分析计划</h2>
      ${plan.tasks.map((task, idx) => `
        <div class="plan-task">
          <div class="task-header">
            <span class="expert">📋 Task ${idx + 1}: ${this.escapeHtml(task.expertAgent)}</span>
            <span style="color: #666; font-size: 13px;">优先级: ${task.priority}</span>
          </div>
          <div class="objective">${this.escapeHtml(task.objective)}</div>
        </div>
      `).join('')}
      <div style="margin-top: 10px; font-size: 13px; color: #666;">
        预估时长: ${plan.estimatedDuration}ms | 可并行: ${plan.parallelizable ? '是' : '否'}
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">分析结论</h2>
      <div class="answer-box">
        ${this.formatAnswer(synthesizedAnswer)}
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">专家分析结果</h2>
      ${expertResults.map(expert => this.renderExpertResult(expert)).join('')}
    </div>

    <div class="section">
      <h2 class="section-title collapsible" onclick="toggleSection('trace-details')">
        <span class="toggle-icon">▶</span> 执行追踪 (调试信息)
      </h2>
      <div id="trace-details" class="collapsible-content">
        <div class="trace-section">
          <pre>${this.escapeHtml(JSON.stringify(trace, null, 2))}</pre>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>由 SmartPerfetto Agent 架构生成</p>
      <p style="margin-top: 5px; font-size: 12px;">Powered by Expert Agents + LLM Orchestration</p>
    </div>
  </div>

  <script>
    function toggleSection(id) {
      const content = document.getElementById(id);
      const icon = content.previousElementSibling.querySelector('.toggle-icon');
      if (content.classList.contains('show')) {
        content.classList.remove('show');
        icon.textContent = '▶';
      } else {
        content.classList.add('show');
        icon.textContent = '▼';
      }
    }
  </script>
</body>
</html>`;
  }

  private renderExpertResult(expert: ExpertResult): string {
    return `
      <div class="expert-section">
        <div class="expert-header">
          <span class="name">🔬 ${this.escapeHtml(expert.agentName)}</span>
          <span class="confidence">${(expert.confidence * 100).toFixed(0)}% 置信度</span>
        </div>
        <div class="expert-body">
          ${expert.findings.length > 0 ? `
            <h4 style="margin-bottom: 10px; color: #374151;">发现 (${expert.findings.length})</h4>
            ${expert.findings.map((f: Finding) => this.renderFinding(f)).join('')}
          ` : ''}
          
          ${expert.diagnostics.length > 0 ? `
            <h4 style="margin: 15px 0 10px; color: #374151;">诊断 (${expert.diagnostics.length})</h4>
            ${expert.diagnostics.map((d: Diagnostic) => this.renderDiagnostic(d)).join('')}
          ` : ''}
          
          ${expert.suggestions.length > 0 ? `
            <h4 style="margin: 15px 0 10px; color: #374151;">建议</h4>
            <ul style="padding-left: 20px;">
              ${expert.suggestions.map((s: string) => `<li style="margin-bottom: 5px;">${this.escapeHtml(s)}</li>`).join('')}
            </ul>
          ` : ''}
          
          <div style="margin-top: 10px; font-size: 12px; color: #9ca3af;">
            耗时: ${expert.executionTimeMs}ms
          </div>
        </div>
      </div>
    `;
  }

  private renderFinding(finding: Finding): string {
    return `
      <div class="finding ${finding.severity}">
        <div class="title">${this.escapeHtml(finding.title)}</div>
        <div>${this.escapeHtml(finding.description)}</div>
        ${finding.evidence.length > 0 ? `
          <div style="margin-top: 8px; font-size: 12px; color: #666;">
            证据: ${finding.evidence.length} 项
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderDiagnostic(diagnostic: Diagnostic): string {
    return `
      <div class="diagnostic">
        <span class="status">${diagnostic.matched ? '✅' : '❌'}</span>
        <div class="message">
          <div>${this.escapeHtml(diagnostic.message)}</div>
          ${diagnostic.suggestions.length > 0 ? `
            <ul class="suggestions">
              ${diagnostic.suggestions.map(s => `<li>${this.escapeHtml(s)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Generate HTML report from MasterOrchestratorResult (new architecture)
   */
  generateMasterAgentHTML(data: MasterAgentReportData): string {
    const { traceId, query, result, timestamp } = data;
    const { intent, plan, stageResults, synthesizedAnswer, confidence, totalDuration, evaluation, modelUsage } = result;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmartPerfetto Agent 分析报告 - ${new Date(timestamp).toLocaleString('zh-CN')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.5; color: #333; background: #f5f7fa; padding: 15px;
    }
    .container {
      max-width: 1200px; margin: 0 auto; background: white;
      border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white; padding: 20px;
    }
    .header h1 { font-size: 28px; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 14px; }
    .header .meta span { margin-right: 20px; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 12px;
      font-size: 12px; font-weight: 600;
    }
    .badge-agent { background: rgba(255,255,255,0.2); }
    .section { padding: 20px; border-bottom: 1px solid #eaeaea; }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 20px; font-weight: 600; margin-bottom: 20px; color: #2c3e50;
      display: flex; align-items: center;
    }
    .section-title::before {
      content: ''; width: 4px; height: 20px; background: #10b981;
      margin-right: 12px; border-radius: 2px;
    }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; }
    .metric-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #10b981; }
    .metric-card .label { font-size: 14px; color: #666; margin-top: 5px; }
    .intent-box {
      background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;
    }
    .intent-box .goal { font-size: 18px; font-weight: 600; color: #166534; margin-bottom: 8px; }
    .answer-box {
      background: #f8f9fa; padding: 20px; border-radius: 8px;
      white-space: pre-wrap; font-size: 15px; line-height: 1.8;
    }
    .stage-section { margin-bottom: 20px; }
    .stage-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 15px; background: #f3f4f6; border-radius: 8px 8px 0 0;
      font-weight: 600;
    }
    .stage-body { padding: 15px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
    .finding { margin-bottom: 10px; padding: 10px; border-radius: 6px; border-left: 3px solid; }
    .finding.critical { background: #fef2f2; border-color: #dc2626; }
    .finding.high { background: #fff7ed; border-color: #ea580c; }
    .finding.medium { background: #fefce8; border-color: #ca8a04; }
    .finding.low { background: #f0fdf4; border-color: #16a34a; }
    .finding.info { background: #eff6ff; border-color: #2563eb; }
    .finding .title { font-weight: 600; margin-bottom: 5px; }
    .evaluation-box { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
    .eval-item { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .eval-item .score { font-size: 32px; font-weight: 700; }
    .eval-item .label { font-size: 13px; color: #666; }
    .footer { padding: 20px; text-align: center; color: #999; font-size: 13px; background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🤖 SmartPerfetto Agent 分析报告</h1>
      <div class="meta">
        <span>📁 Trace ID: ${this.escapeHtml(traceId)}</span>
        <span>⏱️ ${new Date(timestamp).toLocaleString('zh-CN')}</span>
        <span class="badge badge-agent">Master Orchestrator</span>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">执行概览</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${(totalDuration / 1000).toFixed(1)}s</div>
          <div class="label">总耗时</div>
        </div>
        <div class="metric-card">
          <div class="value">${(confidence * 100).toFixed(0)}%</div>
          <div class="label">置信度</div>
        </div>
        <div class="metric-card">
          <div class="value">${stageResults?.length || 0}</div>
          <div class="label">执行阶段</div>
        </div>
        <div class="metric-card">
          <div class="value">${evaluation?.passed ? '✅' : '❌'}</div>
          <div class="label">评估通过</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">用户问题</h2>
      <div class="intent-box">
        <div class="goal">${this.escapeHtml(query)}</div>
        ${intent?.primaryGoal ? `<div style="margin-top: 8px; color: #166534;">${this.escapeHtml(intent.primaryGoal)}</div>` : ''}
      </div>
    </div>

    ${this.renderMethodologySection(intent, plan)}

    ${stageResults && stageResults.length > 0 ? this.renderReasoningTimeline(stageResults) : ''}

    <div class="section">
      <h2 class="section-title">分析结论</h2>
      <div class="answer-box">
        ${this.formatAnswer(synthesizedAnswer)}
      </div>
    </div>

    ${stageResults && stageResults.length > 0 ? `
    <div class="section">
      <h2 class="section-title">分析阶段详情</h2>
      ${stageResults.map((stage, idx) => this.renderStageResult(stage, idx)).join('')}
    </div>
    ` : ''}

    ${evaluation ? `
    <div class="section">
      <h2 class="section-title">质量评估</h2>
      <div class="evaluation-box">
        <div class="eval-item">
          <div class="score" style="color: ${evaluation.qualityScore >= 0.7 ? '#10b981' : '#ef4444'}">
            ${(evaluation.qualityScore * 100).toFixed(0)}%
          </div>
          <div class="label">质量分数</div>
        </div>
        <div class="eval-item">
          <div class="score" style="color: ${evaluation.completenessScore >= 0.8 ? '#10b981' : '#ef4444'}">
            ${(evaluation.completenessScore * 100).toFixed(0)}%
          </div>
          <div class="label">完整度</div>
        </div>
        <div class="eval-item">
          <div class="score">${evaluation.passed ? '✅' : '❌'}</div>
          <div class="label">评估结果</div>
        </div>
      </div>
      ${evaluation.feedback ? `
      <div style="margin-top: 15px; padding: 15px; background: #fef3c7; border-radius: 8px;">
        <strong>评估反馈:</strong>
        ${evaluation.feedback.improvementSuggestions?.length > 0 ? `
          <ul style="margin: 8px 0 0 16px;">
            ${evaluation.feedback.improvementSuggestions.map((s: string) => `<li>${this.escapeHtml(s)}</li>`).join('')}
          </ul>
        ` : ''}
      </div>
      ` : ''}
    </div>
    ` : ''}

    ${modelUsage ? `
    <div class="section">
      <h2 class="section-title">模型使用统计</h2>
      <div class="metrics">
        <div class="metric-card">
          <div class="value">${modelUsage.totalInputTokens.toLocaleString()}</div>
          <div class="label">输入 Tokens</div>
        </div>
        <div class="metric-card">
          <div class="value">${modelUsage.totalOutputTokens.toLocaleString()}</div>
          <div class="label">输出 Tokens</div>
        </div>
        <div class="metric-card">
          <div class="value">$${modelUsage.totalCost.toFixed(4)}</div>
          <div class="label">总成本</div>
        </div>
      </div>
    </div>
    ` : ''}

    <div class="footer">
      <p>由 SmartPerfetto Master Orchestrator 生成</p>
      <p style="margin-top: 5px; font-size: 12px;">Powered by Pipeline + Evaluator Architecture</p>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Render methodology section for beginners to understand the analysis approach
   */
  private renderMethodologySection(intent: any, plan: any): string {
    if (!intent && !plan) {
      return '';
    }

    const aspects = intent?.aspects || [];
    const complexity = plan?.complexity || intent?.complexity || 'medium';
    const complexityLabel = complexity === 'simple' ? '简单' :
                           complexity === 'medium' ? '中等' :
                           complexity === 'complex' ? '复杂' : '复杂';
    const complexityColor = complexity === 'simple' ? '#10b981' :
                           complexity === 'medium' ? '#f59e0b' : '#ef4444';

    return `
    <div class="section">
      <h2 class="section-title">📖 分析方法论</h2>
      <div style="display: grid; gap: 16px;">
        <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981;">
          <div style="font-weight: 600; color: #166534; margin-bottom: 8px;">🎯 分析目标</div>
          <div style="color: #166534;">${this.escapeHtml(intent?.primaryGoal || '性能分析')}</div>
          ${aspects.length > 0 ? `
            <ul style="margin-top: 8px; padding-left: 20px; color: #166534;">
              ${aspects.map((a: string) => `<li>${this.escapeHtml(a)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">
          <div style="background: #f8fafc; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: ${complexityColor};">${complexityLabel}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">分析复杂度</div>
          </div>
          ${plan?.stages ? `
          <div style="background: #f8fafc; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #3b82f6;">${plan.stages.length}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">分析阶段</div>
          </div>
          ` : ''}
          ${intent?.suggestedSkills?.length > 0 ? `
          <div style="background: #f8fafc; padding: 16px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #8b5cf6;">${intent.suggestedSkills.length}</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">分析技能</div>
          </div>
          ` : ''}
        </div>

        ${intent?.suggestedSkills?.length > 0 ? `
        <div style="background: #faf5ff; padding: 16px; border-radius: 8px;">
          <div style="font-weight: 600; color: #7c3aed; margin-bottom: 8px;">🛠️ 使用的分析技能</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            ${intent.suggestedSkills.map((skill: string) => `
              <span style="background: #ede9fe; color: #6d28d9; padding: 4px 12px; border-radius: 16px; font-size: 13px;">
                ${this.escapeHtml(skill)}
              </span>
            `).join('')}
          </div>
          <div style="margin-top: 12px; font-size: 12px; color: #8b5cf6; font-style: italic;">
            💡 这些技能是 AI 根据您的问题自动选择的，每个技能专门分析特定类型的性能数据
          </div>
        </div>
        ` : ''}
      </div>
    </div>
    `;
  }

  /**
   * Render AI reasoning timeline for beginners to understand the analysis flow
   */
  private renderReasoningTimeline(stageResults: StageResult[]): string {
    if (!stageResults || stageResults.length === 0) {
      return '';
    }

    // Calculate total duration
    const firstStart = Math.min(...stageResults.map(s => s.startTime));
    const lastEnd = Math.max(...stageResults.map(s => s.endTime));
    const totalDuration = lastEnd - firstStart;

    return `
    <div class="section">
      <h2 class="section-title">🧠 AI 推理过程</h2>
      <div style="padding: 8px 16px; background: #f0f9ff; border-radius: 8px; margin-bottom: 16px; font-size: 13px; color: #0369a1;">
        💡 <strong>学习要点:</strong> 以下时间线展示了 AI 是如何一步步分析您的问题的。每个阶段都有特定的目的，帮助您理解分析过程。
      </div>

      <div style="position: relative; padding-left: 32px;">
        <!-- Timeline line -->
        <div style="position: absolute; left: 12px; top: 0; bottom: 0; width: 2px; background: linear-gradient(180deg, #10b981 0%, #3b82f6 100%);"></div>

        ${stageResults.map((stage, idx) => {
          const duration = stage.endTime - stage.startTime;
          const findingsCount = stage.findings?.length || 0;
          const stageIcon = stage.stageId.includes('planner') ? '📋' :
                           stage.stageId.includes('worker') ? '⚙️' :
                           stage.stageId.includes('evaluator') ? '✅' :
                           stage.stageId.includes('synthesis') ? '📝' : '🔍';
          const stageExplanation = stage.stageId.includes('planner') ? '制定分析计划' :
                                  stage.stageId.includes('worker') ? '执行数据分析' :
                                  stage.stageId.includes('evaluator') ? '评估结果质量' :
                                  stage.stageId.includes('synthesis') ? '综合生成报告' : '分析处理';

          return `
          <div style="position: relative; margin-bottom: 20px;">
            <!-- Timeline dot -->
            <div style="position: absolute; left: -26px; top: 4px; width: 16px; height: 16px; border-radius: 50%; background: ${stage.success ? '#10b981' : '#ef4444'}; border: 3px solid white; box-shadow: 0 1px 3px rgba(0,0,0,0.2);"></div>

            <div style="background: ${stage.success ? '#f0fdf4' : '#fef2f2'}; border-radius: 8px; padding: 16px; border-left: 3px solid ${stage.success ? '#10b981' : '#ef4444'};">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="font-weight: 600; color: #1f2937;">
                  ${stageIcon} 步骤 ${idx + 1}: ${this.escapeHtml(stage.stageId)}
                </div>
                <div style="font-size: 12px; color: #6b7280;">
                  ${stage.success ? '✅' : '❌'} ${(duration / 1000).toFixed(1)}s
                </div>
              </div>

              <div style="font-size: 13px; color: #4b5563; margin-bottom: 8px;">
                ${stageExplanation}
              </div>

              ${findingsCount > 0 ? `
              <div style="font-size: 12px; color: #059669; background: #ecfdf5; padding: 8px 12px; border-radius: 4px; margin-top: 8px;">
                📊 发现 ${findingsCount} 条问题
              </div>
              ` : ''}

              ${stage.error ? `
              <div style="font-size: 12px; color: #dc2626; background: #fef2f2; padding: 8px 12px; border-radius: 4px; margin-top: 8px;">
                ⚠️ ${this.escapeHtml(stage.error)}
              </div>
              ` : ''}
            </div>
          </div>
          `;
        }).join('')}
      </div>

      <div style="margin-top: 16px; padding: 12px 16px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #64748b; text-align: center;">
        总耗时 ${(totalDuration / 1000).toFixed(1)} 秒 | 共 ${stageResults.length} 个分析阶段 | ${stageResults.filter(s => s.success).length}/${stageResults.length} 阶段成功
      </div>
    </div>
    `;
  }

  private renderStageResult(stage: StageResult, idx: number): string {
    const findings = stage.findings || [];
    return `
      <div class="stage-section">
        <div class="stage-header">
          <span>📋 阶段 ${idx + 1}: ${this.escapeHtml(stage.stageId)}</span>
          <span style="color: ${stage.success ? '#10b981' : '#ef4444'};">
            ${stage.success ? '✅ 成功' : '❌ 失败'}
          </span>
        </div>
        <div class="stage-body">
          ${findings.length > 0 ? `
            <div style="margin-bottom: 10px; font-weight: 600;">发现 (${findings.length})</div>
            ${findings.map((f: Finding) => this.renderFinding(f)).join('')}
          ` : '<div style="color: #666;">无发现</div>'}
          <div style="margin-top: 10px; font-size: 12px; color: #999;">
            耗时: ${((stage.endTime - stage.startTime) || 0).toFixed(0)}ms
          </div>
        </div>
      </div>
    `;
  }

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
      skillEngineResult: session.skillEngineResult,
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
