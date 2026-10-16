// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {REPORT_LAYOUT_FIX_CSS, REPORT_LAYOUT_FIX_MARKER} from './reportLayoutAssets';

// Reports keep an opaque origin and cannot make network requests. Downloads
// require a separate sandbox capability; they do not grant same-origin access.
export const REPORT_DOCUMENT_CSP = [
  'sandbox allow-scripts allow-downloads',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const REPORT_DOCUMENT_SCRIPT_MARKER = 'smartperfetto-report-document-v1';
export const REPORT_DOCUMENT_SCRIPT = String.raw`
/* smartperfetto-report-document-v1 */
(function() {
  var english = document.documentElement.lang.toLowerCase().indexOf('en') === 0;
  function text(zh, en) { return english ? en : zh; }
  var comparison = document.querySelector('main[data-comparison-id]');
  if (comparison) comparison.classList.add('comparison-report');
  if (/^SmartPerfetto (Batch Trace Run|批量轨迹分析)/.test(document.title)) document.body.classList.add('batch-report');
  // Historical tables and Markdown tables also need their own scroll surface.
  document.querySelectorAll('table').forEach(function(table) {
    if (table.closest('.table-container')) return;
    var container = document.createElement('div');
    container.className = 'table-container';
    table.parentNode.insertBefore(container, table);
    container.appendChild(table);
  });
  window.saveSmartPerfettoReport = function() {
    var status = document.getElementById('report-save-status');
    var name = document.body.getAttribute('data-report-filename') || 'SmartPerfetto-report.html';
    var link = document.createElement('a');
    var snapshot = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    var url = URL.createObjectURL(new Blob([snapshot], {type: 'text/html;charset=utf-8'}));
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Keep the object URL alive until the browser has consumed the download.
    setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
    if (status) status.textContent = text('已交给浏览器保存：', 'Sent to browser for saving: ') + name;
  };
  // Older templates did not expose a save control. Saved snapshots already
  // contain this control, so reopening them must not add a duplicate.
  if (!document.querySelector('button[onclick*="saveSmartPerfettoReport"]')) {
    var actions = document.createElement('div');
    actions.className = 'report-actions';
    var save = document.createElement('button');
    save.type = 'button';
    save.textContent = text('保存 HTML 报告', 'Save HTML Report');
    save.setAttribute('onclick', 'saveSmartPerfettoReport()');
    var status = document.createElement('span');
    status.id = 'report-save-status';
    status.setAttribute('role', 'status');
    actions.appendChild(save);
    actions.appendChild(status);
    (document.querySelector('.header') || document.body).appendChild(actions);
  }
  window.copySql = function(button, event) {
    if (event) event.stopPropagation();
    var sql = button.getAttribute('data-sql') || '';
    var label = button.textContent;
    function result(ok) {
      button.textContent = ok ? text('已复制', 'Copied') : text('请手动选择复制', 'Select text to copy');
      setTimeout(function() { button.textContent = label; }, 2000);
    }
    function fallback() {
      var input = document.createElement('textarea');
      input.value = sql;
      input.style.cssText = 'position:fixed;left:-10000px;top:0';
      document.body.appendChild(input);
      input.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      input.remove();
      result(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(sql).then(function() { result(true); }, fallback);
    } else fallback();
  };
  document.querySelectorAll('.copy-btn:not([onclick])').forEach(function(button) {
    button.addEventListener('click', function(event) { window.copySql(button, event); });
  });
  window.toggleTableRows = function(button) {
    var container = button.closest('.table-container');
    if (!container) return;
    var table = container.querySelector('table');
    if (!table) return;
    var rows = table.querySelectorAll(':scope > tbody > .hidden-row');
    if (!rows.length) return;
    var expand = rows[0].style.display === 'none';
    rows.forEach(function(row) { row.style.display = expand ? 'table-row' : 'none'; });
    (button.querySelector('span') || button).textContent = expand
      ? text('▲ 收起更多', '▲ Collapse rows')
      : text('▼ 显示更多 ', '▼ Show ') + rows.length + text(' 条记录', ' more rows');
  };
  var printDetails = [];
  window.addEventListener('beforeprint', function() {
    if (printDetails.length) return;
    document.querySelectorAll('details:not([open])').forEach(function(detail) {
      printDetails.push(detail);
      detail.open = true;
    });
  });
  window.addEventListener('afterprint', function() {
    printDetails.forEach(function(detail) { detail.open = false; });
    printDetails = [];
  });
})();
`;

export const REPORT_DOCUMENT_NO_SCRIPT = `<noscript><style>
.hidden-row, .details-row { display: table-row !important; }
.hidden-card, .deep-frame-content, .deep-session-content, .collapsible-content, .sql-content { display: block !important; }
.sql-block.collapsed pre { display: block !important; }
.timeline-item.timeline-hidden { display: grid !important; }
.report-actions, .table-rows-more, .timeline-toolbar, .copy-btn, .expand-btn { display: none !important; }
</style></noscript>`;

/** Upgrade presentation only; never recover missing facts from rendered text. */
export function upgradeReportDocumentHtml(html: string): string {
  if (!html || !(/class=["'][^"']*\b(?:container|report-card|metrics-grid|summary-box|comparison-report|batch-report)\b/.test(html)
    || /data-comparison-id=/.test(html) || /<title>SmartPerfetto (?:Batch Trace Run|批量轨迹分析)/.test(html))) return html;
  let upgraded = html;
  if (!(upgraded.match(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi) || []).some(style => style.includes(REPORT_LAYOUT_FIX_MARKER))) {
    const styleEnd = /<\/style\s*>/i;
    const headEnd = /<\/head\s*>/i;
    if (styleEnd.test(upgraded)) {
      upgraded = upgraded.replace(styleEnd, `${REPORT_LAYOUT_FIX_CSS}\n</style>`);
    } else if (headEnd.test(upgraded)) {
      upgraded = upgraded.replace(headEnd, `<style>${REPORT_LAYOUT_FIX_CSS}</style>\n</head>`);
    } else {
      upgraded = `<style>${REPORT_LAYOUT_FIX_CSS}</style>\n${upgraded}`;
    }
  }
  if (!(upgraded.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) || []).some(script => script.includes(REPORT_DOCUMENT_SCRIPT_MARKER))) {
    // Known old snapshots had a fetch-based save handler which their CSP blocks.
    upgraded = upgraded.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, script => script
      .replace(
        /async function saveSmartPerfettoReport\(\) \{[\s\S]*?\n\s*\}\n\s*function toggleTableRows/,
        'function toggleTableRows',
      )
      // This known listener also calls clipboard directly and throws in the
      // sandbox before a manual-copy fallback can be offered.
      .replace(
        /\/\/ Legacy copy button handler for backward compatibility[\s\S]*?(?=\/\/ 检测表格是否可滚动)/,
        '',
      ));
    const assets = `<script>${REPORT_DOCUMENT_SCRIPT}</script>${REPORT_DOCUMENT_NO_SCRIPT}`;
    upgraded = /<\/body\s*>/i.test(upgraded)
      ? upgraded.replace(/<\/body\s*>/i, `${assets}\n</body>`)
      : `${upgraded}\n${assets}`;
  }
  return upgraded;
}

export function withReportDocumentFilename(html: string, filename: string): string {
  const escaped = filename.replace(/[&<>"']/g, character =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]!));
  return html.replace(/<body\b([^>]*)>/i, (_body, attributes: string) =>
    `<body${attributes.replace(/\sdata-report-filename\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')} data-report-filename="${escaped}">`);
}
