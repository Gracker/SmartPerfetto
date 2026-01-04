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
      min-width: 80px;
      max-width: 400px;
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

    /* 序号列固定宽度 */
    table th:first-child,
    table td:first-child {
      min-width: 50px;
      max-width: 60px;
      width: 50px;
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
    const constantColumns: Record<string, any> = {};
    const variableColumns: string[] = [];

    for (const col of filteredColumns) {
      const firstValue = rows[0][col];
      const isConstant = rows.every(row => row[col] === firstValue);

      if (isConstant && firstValue !== undefined && firstValue !== null) {
        constantColumns[col] = firstValue;
      } else {
        variableColumns.push(col);
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
                ${variableColumns.map(col => `<td>${this.formatCellValue(row[col])}</td>`).join('')}
              </tr>
            `).join('')}
            ${hiddenRows.map((row, idx) => `
              <tr class="hidden-row" style="display: none;">
                <td style="color: #666; font-weight: 500;">${defaultVisibleRows + idx + 1}</td>
                ${variableColumns.map(col => `<td>${this.formatCellValue(row[col])}</td>`).join('')}
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
