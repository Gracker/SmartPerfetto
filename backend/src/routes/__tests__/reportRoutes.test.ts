// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import request from 'supertest';

import * as reportRoutes from '../reportRoutes';

const {upgradeLegacyReportHtml} = reportRoutes;

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
    expect(upgraded).toContain('/api/reports/assets/mermaid.min.js');
    expect(upgraded).toContain('smartperfetto-report-mermaid-v2');
    expect(upgraded).not.toContain('cdn.jsdelivr.net');
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
    expect(upgraded).toContain('smartperfetto-report-layout-fix-v3');
    expect(upgraded.match(/smartperfetto-report-layout-fix-v3/g)).toHaveLength(1);
    expect(upgraded).toContain('.metrics-grid');
    expect(upgraded).toContain('grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))');
    expect(upgraded).toContain('.summary-box > strong');
    expect(upgraded).toContain('font-size: 13px');
    expect(upgraded).toContain('.summary-box .metric-card .metric-label');
    expect(upgraded).toContain('font-size: 11px');
    const upgradedAgain = upgradeLegacyReportHtml(upgraded);
    expect(upgradedAgain).toBe(upgraded);
    expect(upgradedAgain.match(/smartperfetto-report-layout-fix-v3/g)).toHaveLength(1);
  });

  test('removes the Mermaid library gate from persisted causal-map reports', () => {
    const previouslyGatedScript = `
if (typeof mermaid !== 'undefined') {
  function decodeMermaidSource(text) {
    return String(text || '');
  }

  function parseMermaidFlowSource(source) {
    return source;
  }

  const mermaidTargets = Array.from(document.querySelectorAll('pre.mermaid'));
  if (mermaidTargets.length > 0) {
    mermaid.initialize({
      startOnLoad: false,
    });
  }
}
`.trim();
    const persisted = `
      <html>
      <body>
        <div class="mermaid-wrapper"><pre class="mermaid">graph TB
A[foo] --> B[bar]</pre></div>
        <script>${previouslyGatedScript}</script>
      </body>
      </html>
    `;

    const upgraded = upgradeLegacyReportHtml(persisted);
    expect(upgraded).toContain('(function() {\n  function decodeMermaidSource');
    expect(upgraded).toContain('if (typeof mermaid === \'undefined\')');
    expect(upgraded).not.toContain("if (typeof mermaid !== 'undefined') {\n  function decodeMermaidSource");
    expect(upgradeLegacyReportHtml(upgraded)).toBe(upgraded);
  });

  test('leaves already-upgraded reports unchanged', () => {
    const html = '<html><body><script>/* smartperfetto-report-mermaid-v2 */ function parseMermaidFlowSource(source) {}</script><div class="causal-map"></div></body></html>';
    expect(upgradeLegacyReportHtml(html)).toBe(html);
  });

  test('serves the shipped Mermaid runtime through the same-origin report route', async () => {
    expect((reportRoutes as any).REPORT_DOCUMENT_CSP).toContain("script-src 'self' 'unsafe-inline'");
    const app = express();
    app.use('/api/reports', reportRoutes.default);

    const response = await request(app).get('/api/reports/assets/mermaid.min.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.text.length).toBeGreaterThan(100_000);
    expect(response.text).toContain('mermaid');
  });
  test('preserves static-file byte range semantics for the Mermaid runtime route', async () => {
    const app = express();
    app.use('/api/reports', reportRoutes.default);

    const response = await request(app)
      .get('/api/reports/assets/mermaid.min.js')
      .set('Range', 'bytes=0-15');

    expect(response.status).toBe(206);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toMatch(/^bytes 0-15\/\d+$/);
    expect(response.text).toHaveLength(16);
  });
});
