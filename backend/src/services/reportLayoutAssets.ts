// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const REPORT_LAYOUT_FIX_MARKER = 'smartperfetto-report-layout-fix-v2';

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
  font-size: 14px;
  line-height: 1.5;
}
.summary-box > strong {
  font-size: 14px;
  line-height: 1.5;
}
.summary-box .metrics-grid {
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.summary-box .metric-card {
  min-height: 0;
  padding: 10px 12px;
  align-items: flex-start;
  text-align: left;
}
.summary-box .metric-card .metric-label {
  margin-bottom: 3px;
  font-size: 12px;
  line-height: 1.4;
}
.summary-box .metric-card .metric-value {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
@media (max-width: 640px) {
  .metrics-grid { grid-template-columns: 1fr; }
  .timeline-toolbar { align-items: flex-start; flex-direction: column; }
  .timeline-item { grid-template-columns: 1fr; gap: 6px; align-items: start; }
  .envelope-technical-grid { grid-template-columns: 1fr; }
}
`;
