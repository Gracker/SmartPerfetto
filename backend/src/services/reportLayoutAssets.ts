// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const REPORT_LAYOUT_FIX_MARKER = 'smartperfetto-report-layout-fix-v4';

export const REPORT_LAYOUT_FIX_CSS = `
/* ${REPORT_LAYOUT_FIX_MARKER} */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: stretch;
}
.metric-card {
  min-width: 0;
  min-height: 78px;
  border: 1px solid #edf0f3;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.metrics-grid .metric-card {
  align-items: flex-start;
  text-align: left;
  background: #fff;
  padding: 12px 14px;
}
.metric-card .metric-label {
  margin: 0 0 4px;
  color: #4b5563;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
}
.metric-card .metric-value {
  color: #111827;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  word-break: break-word;
}
.header .meta .badge {
  font-size: inherit;
  line-height: inherit;
}
.summary-box {
  font-size: 12px;
  line-height: 1.45;
  padding: 12px;
  border-left: 3px solid #94a3b8;
  background: #f8fafc;
}
.summary-box > strong {
  font-size: 13px;
  line-height: 1.4;
}
.summary-box .metrics-grid {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px;
}
.summary-box .metric-card {
  min-height: 0;
  padding: 8px 10px;
  align-items: flex-start;
  text-align: left;
}
.summary-box .metric-card .metric-label {
  margin-bottom: 3px;
  font-size: 11px;
  line-height: 1.35;
}
.summary-box .metric-card .metric-value {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
.metrics-grid .metric-card .value,
.metrics-grid .metric-card .metric-value,
.metrics .metric-card .value,
.metrics .metric-card .metric-value {
  color: #111827 !important;
  font-variant-numeric: tabular-nums;
}
.report-metric-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 14px;
  color: #111827;
}
.report-metric-table th, .report-metric-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #e2e8f0;
  overflow-wrap: anywhere;
  white-space: normal;
  vertical-align: top;
  text-align: left;
}
.report-metric-table th { background: #f1f5f9; }
.report-metric-table th:last-child, .report-metric-table td:last-child {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.container, .report-card, .section, .envelope-card, .envelope-body {
  min-width: 0;
  max-width: 100%;
}
.comparison-report, .batch-report { overflow-wrap: anywhere; }
.comparison-report pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.header, .header .meta, .answer-box, .chat-box, .envelope-meta, .property-value {
  overflow-wrap: anywhere;
}
.report-value-json, .answer-box pre, .chat-box pre, .trace-section pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 100%;
}
.table-container { max-width: 100%; overflow-x: auto; }
.table-container th, .table-container td { min-width: 7ch; }
.table-container th, .table-container td.numeric { white-space: nowrap; }
.table-rows-more { cursor: pointer; padding: 10px; }
.header { flex-wrap: wrap; gap: 12px; }
.header .report-actions { flex-basis: 100%; }
.report-actions button, button.table-rows-more {
  border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 12px;
  background: #f8fafc; color: #334155; font: inherit; cursor: pointer;
}
button.table-rows-more { width: 100%; }
.report-metric-table, .table-container table { font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  body { padding: 8px !important; }
  .batch-report { margin: 0; }
  .comparison-report { padding: 16px 8px; }
  .header { flex-direction: column; align-items: stretch; padding: 16px; }
  .header h1 { min-width: 0; width: 100%; }
  .header .meta { flex-direction: column; align-items: flex-start; gap: 8px; }
  .properties-grid { grid-template-columns: 1fr; }
  .metrics-grid { grid-template-columns: 1fr; }
  .timeline-toolbar { align-items: flex-start; flex-direction: column; }
  .timeline-item { grid-template-columns: 1fr; gap: 6px; align-items: start; }
  .envelope-technical-grid { grid-template-columns: 1fr; }
}
@media print {
  body { padding: 0 !important; background: white !important; }
  .container, .report-card { box-shadow: none !important; overflow: visible !important; }
  .metric-group { overflow: visible !important; }
  .report-actions, .table-rows-more, .timeline-toolbar, .copy-btn, .expand-btn { display: none !important; }
  .hidden-row, .details-row { display: table-row !important; }
  .hidden-card, .deep-frame-content, .deep-session-content, .collapsible-content, .sql-content { display: block !important; }
  .timeline-item.timeline-hidden { display: grid !important; }
  .sql-block.collapsed pre { display: block !important; }
  .timeline-list, .table-container, .collapsible-content {
    max-height: none !important; height: auto !important; overflow: visible !important;
  }
  pre, td, th { white-space: pre-wrap !important; overflow-wrap: anywhere; min-width: 0 !important; }
  .section-title, h3 { break-after: avoid; }
  tr { break-inside: avoid; }
}
`;
