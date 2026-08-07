// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { upgradeLegacyReportHtml } from '../reportRoutes';

describe('upgradeLegacyReportHtml', () => {
  test('injects causal-map upgrader into legacy mermaid reports', () => {
    const legacy = `
      <html>
      <head><style>pre.mermaid { background: #f8f9fa; }</style></head>
      <body>
        <pre class="mermaid">graph TB
A[foo] --> B[bar]</pre>
        <script>
          if (typeof mermaid !== 'undefined') {
            document.querySelectorAll('pre.mermaid').forEach(function(el) {
              el.textContent = (el.textContent || '').replace(/<br\\s*\\/?>/gi, '\\n');
            });
            mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
            mermaid.run({ querySelector: 'pre.mermaid' });
          }
        </script>
      </body>
      </html>
    `;

    const upgraded = upgradeLegacyReportHtml(legacy);
    expect(upgraded).toContain('class="mermaid-wrapper"');
    expect(upgraded).toContain('className = \'causal-map\'');
    expect(upgraded).toContain('因果链流程图');
    expect(upgraded).toContain('查看原始 Mermaid 图');
    expect(upgraded).toContain('pre.mermaid[data-render-mode="mermaid"]');
    expect(upgraded).not.toContain("theme: 'default'");
  });

  test('injects summary metric layout styles into legacy agent reports', () => {
    const legacy = `
      <html>
      <head>
        <style>
          /* smartperfetto-report-layout-fix-v1 */
          .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; }
          .metric-card { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="metrics-grid" style="margin-top: 12px;">
          <div class="metric-card">
            <div class="metric-label">总帧数</div>
            <div class="metric-value">347</div>
          </div>
        </div>
      </body>
      </html>
    `;

    const upgraded = upgradeLegacyReportHtml(legacy);
    expect(upgraded).toContain('smartperfetto-report-layout-fix-v1');
    expect(upgraded).toContain('smartperfetto-report-layout-fix-v2');
    expect(upgraded.match(/smartperfetto-report-layout-fix-v2/g)).toHaveLength(1);
    expect(upgraded).toContain('.metrics-grid');
    expect(upgraded).toContain('grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))');
    const upgradedAgain = upgradeLegacyReportHtml(upgraded);
    expect(upgradedAgain).toBe(upgraded);
    expect(upgradedAgain.match(/smartperfetto-report-layout-fix-v2/g)).toHaveLength(1);
  });

  test('leaves already-upgraded reports unchanged', () => {
    const html = '<html><body><script>function parseMermaidFlowSource(source) {}</script><div class="causal-map"></div></body></html>';
    expect(upgradeLegacyReportHtml(html)).toBe(html);
  });
});
