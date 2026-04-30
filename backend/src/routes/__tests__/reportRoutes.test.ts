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

  test('leaves already-upgraded reports unchanged', () => {
    const html = '<html><body><script>function parseMermaidFlowSource(source) {}</script><div class="causal-map"></div></body></html>';
    expect(upgradeLegacyReportHtml(html)).toBe(html);
  });
});
