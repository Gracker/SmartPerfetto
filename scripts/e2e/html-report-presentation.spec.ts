// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import {test, expect} from '../../perfetto/ui/node_modules/@playwright/test';
import {createServer, type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {HTMLReportGenerator} from '../../backend/dist/services/htmlReportGenerator';
import {REPORT_DOCUMENT_CSP, upgradeReportDocumentHtml, withReportDocumentFilename} from '../../backend/dist/services/reportDocumentAssets';
import {renderComparisonHtmlReport} from '../../backend/dist/services/comparisonHtmlReportService';
import {renderBatchTraceHtmlReport} from '../../backend/dist/services/batchTrace/batchTraceReportService';

// Generated test observations, never a model analysis/verification acceptance.
const rows = Array.from({length: 14}, (_, i) => ['00123', 'row_' + i, 6.944123456]);
const nested = Array.from({length: 14}, (_, i) => ({name: 'nested_' + i, values: ['a', 'TAIL_' + i]}));
const timestamp = 1714600000000;
const traceId = 'trace-' + 'long_label_'.repeat(40);
const payload = '<img src=x onerror="alert(1)">';
function documents(): Record<string, string> {
  const generator = new HTMLReportGenerator();
  const result = {sessionId: 'fixture-session', success: true, findings: [], hypotheses: [],
    conclusion: '# Complete conclusion\n\nFinal conclusion marker.\n\n```mermaid\ngraph LR\nA[Observed event] --> B[Recorded outcome]\n```',
    confidence: 0.8, rounds: 1, totalDurationMs: 10};
  const envelope = {meta: {type: 'sql_result', version: '2.0', source: 'execute_sql', timestamp,
    evidenceRefId: 'fixture-evidence', sourceToolCallId: 'fixture-tool'},
    display: {layer: 'overview', format: 'summary', title: 'Observed metrics'},
    data: {summary: {title: 'Observed metrics', content: '', metrics: [
      {label: 'client_ts.avg_' + 'x'.repeat(180), value: 12313109289175.518, severity: 'info'},
      {label: 'duration', value: 6.944123456, unit: 'ms', severity: 'warning'},
      {label: payload, value: '00123', severity: 'critical'},
    ]}}};
  const main = generator.generateAgentDrivenHTML({traceId, query: payload, timestamp,
    outputLanguage: 'en', result, hypotheses: [], dialogue: [],
    conversationTimeline: Array.from({length: 14}, (_, i) => ({ordinal: i + 1, eventId: 'event_' + i,
      phase: 'progress', role: 'agent', text: 'progress_' + i + (i === 13 ? ' ' + 'x'.repeat(300) + 'CONVERSATION_TAIL' : ''), timestamp})),
    dataEnvelopes: [envelope, {...envelope, display: {...envelope.display, format: 'metric'}},
      {meta: {...envelope.meta, evidenceRefId: 'table-fixture'},
        display: {layer: 'list', format: 'table', title: 'Complete rows'}, data: {columns: ['thread_id', 'label', 'value'], rows}},
      {meta: {...envelope.meta, evidenceRefId: 'nested-fixture'},
        display: {layer: 'list', format: 'table', title: 'Nested data'}, data: {columns: ['nested'], rows: [[nested]]}},
      {meta: {...envelope.meta, evidenceRefId: 'expandable-fixture'},
        display: {layer: 'list', format: 'table', title: 'Expandable details'}, data: {columns: ['id'], rows: [[1]],
          expandableData: [{result: {success: true, sections: {detail: {title: 'Detail', data: {text: 'EXPAND_DETAIL_TAIL'}}}}}]}},
    ],
  } as any);
  const basic = generator.generateHTML({sessionId: payload, traceId, question: payload, answer: 'Basic conclusion', timestamp,
    metrics: {totalDuration: 10, iterationsCount: 1, sqlQueriesCount: 1}, collectedResults: [{sql: payload, timestamp,
      result: {columns: ['thread_id', 'label', 'value'], rows, rowCount: rows.length, durationMs: 1}}],
    skillEngineResult: {skillName: payload, sections: {step: {title: payload, data: [{value: nested}]}}, diagnostics: []},
  } as any);
  const intent = {primaryGoal: payload, aspects: [], expectedOutputType: 'analysis', complexity: 'simple'};
  const agent = generator.generateAgentHTML({traceId, query: payload, timestamp, result: {intent,
    plan: {tasks: [], estimatedDuration: 1, parallelizable: false}, expertResults: [],
    synthesizedAnswer: 'Agent conclusion', confidence: 0.8, executionTimeMs: 1, trace: {events: nested, totalLLMCalls: 0}}} as any);
  const master = generator.generateMasterAgentHTML({traceId, query: payload, timestamp, result: {intent,
    plan: {tasks: [], stages: []}, stageResults: [{stageId: 'worker', success: true, findings: [], startTime: 1, endTime: 2,
      data: {overview: {duration: 6.944123456, error_rate: 0.25, observed: false},
        list: {records: rows.map((row, i) => ({id: row[0], name: row[1], value: row[2], ...Object.fromEntries(Array.from({length: 12}, (_, n) => ['field_' + n, i]))}))},
        deep: {records: [{title: 'Deep record', observations: nested}]}}, retryCount: 0}],
    synthesizedAnswer: 'Master conclusion', confidence: 0.8, totalDuration: 1, iterationCount: 1,
    evaluation: null, modelUsage: null}} as any);
  const legacy = upgradeReportDocumentHtml(`<html lang="en"><head><style>/* smartperfetto-report-layout-fix-v3 */</style></head><body><div class="container">
    <div class="summary-box"><div class="metrics-grid"><div class="metric-card"><div class="metric-label">duration</div><div class="metric-value" style="color:#10b981">6.944123456</div></div></div></div>
    <button onclick="saveSmartPerfettoReport()">Save HTML Report</button><span id="report-save-status"></span>
    <script>async function saveSmartPerfettoReport() { await fetch('/blocked/export'); }
    function toggleTableRows() {}</script></div></body></html>`);
  const cell = (snapshotId: string, value: number) => ({snapshotId, value});
  const comparison = renderComparisonHtmlReport({comparisonId: 'comparison-fixture', query: payload, result: {
    matrix: {inputSnapshots: [{snapshotId: 'base', title: traceId}, {snapshotId: 'candidate', title: 'Candidate'}],
      baselineSnapshotId: 'base', groups: [{group: 'Metrics', rowMetricKeys: ['test'], rowCount: 1, significantChangeCount: 1, defaultCollapsed: true}],
      rows: [{metricKey: 'test', label: 'Precise duration', group: 'Metrics', unit: 'ms', baseline: cell('base', 0.000123456),
        cells: [cell('base', 0.000123456), cell('candidate', 0.000234567)], deltas: []}]},
    conclusion: {verifiedFacts: [], inferences: [], recommendations: [], uncertainty: []}}} as any);
  const batch = renderBatchTraceHtmlReport({id: 'batch-fixture', status: 'completed', input: {skillId: 'fixture', traceInputs: [{traceId}]},
    perTrace: [{ordinal: 0, input: {traceId}, status: 'completed', metrics: [{label: 'Precise duration', value: 0.000123456, unit: 'ms'}],
      evidenceEnvelopeIds: ['BATCH_EVIDENCE_ANCHOR'], diagnostics: [], executionTimeMs: 0.000123456}],
    aggregate: {metrics: [{label: 'Precise duration', unit: 'ms', count: 1, missingCount: 0, min: 0.000123456,
      p50: 0.000123456, p90: 0.000123456, p95: 0.000123456, max: 0.000123456, mean: 0.000123456, outlierOrdinals: []}], limitations: []},
  } as any, 'en');
  return Object.fromEntries(Object.entries({main, basic, agent, master, legacy, comparison, batch}).map(([name, html]) =>
    [name, withReportDocumentFilename(html, '示例Trace-2024-05-02-SmartPerfetto.html')]));
}

let server: Server;
let base: string;
test.beforeAll(async () => {
  const pages = documents();
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html;charset=utf-8');
    response.setHeader('Content-Security-Policy', REPORT_DOCUMENT_CSP);
    response.end(pages[(request.url || '').slice(1)] || '<p>Not found</p>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as any).port;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

for (const name of ['main', 'basic', 'agent', 'master', 'legacy', 'comparison', 'batch']) {
  test(name + ' report renders under its real CSP at narrow and wide widths', async ({page}, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/' + name);
    await expect(page.locator('body')).not.toContainText('Not found');
    if (name === 'comparison' || name === 'batch') await expect(page.locator('h1')).toHaveCount(1);
    expect(await page.locator('img[onerror]').count()).toBe(0);
    for (const width of [1280, 600, 340]) {
      await page.setViewportSize({width, height: 900});
      const sizes = await page.evaluate(() => ({width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth}));
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
      if (name === 'basic') {
        const heading = await page.locator('.header h1').boundingBox();
        expect(heading?.width).toBeGreaterThan(width < 640 ? width * 0.7 : 150);
      }
      await page.screenshot({path: info.outputPath(name + '-' + width + '.png')});
      if (name === 'main') {
        await page.locator('.report-metric-table').first().screenshot({path: info.outputPath('metrics-' + width + '.png')});
      }
    }
    expect(errors).toEqual([]);
    if (name === 'basic') {
      await page.locator('.copy-btn').first().click();
      await expect(page.locator('.copy-btn').first()).toHaveText(/Copied|已复制|Select text to copy|请手动选择复制/);
      await page.locator('.table-rows-more').first().focus();
      await page.keyboard.press('Enter');
      await expect(page.getByText('row_13', {exact: true})).toBeVisible();
      expect(errors).toEqual([]);
    }
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', {name: /Save HTML Report|保存 HTML 报告/}).click();
    expect((await downloadEvent).suggestedFilename()).toBe('示例Trace-2024-05-02-SmartPerfetto.html');
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({media: 'print'});
    await expect(page.locator('.report-actions')).toBeHidden();
    expect(await page.locator('details:not([open])').count()).toBe(0);
    for (const row of await page.locator('.hidden-row').all()) await expect(row).toBeVisible();
    await page.pdf({path: info.outputPath(name + '-complete.pdf')});
  });
}

test('complete evidence rows, literal metrics, printing and sandboxed saving remain usable offline', async ({page}, info) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto(base + '/main');
  await expect(page.locator('.report-metric-table').first()).toContainText('6.944123456ms');
  await expect(page.locator('.report-metric-table').first()).toContainText('Warning');
  await expect(page.locator('.report-metric-table').first()).not.toContainText('🟢');
  await page.locator('.table-rows-more').first().click();
  await expect(page.getByText('row_13', {exact: true})).toBeVisible();
  await expect(page.getByText('TAIL_13', {exact: false}).last()).toBeVisible();
  await expect(page.locator('.causal-map').first()).toBeVisible();
  await page.locator('.expand-btn').first().click();
  await expect(page.getByText('EXPAND_DETAIL_TAIL', {exact: true})).toBeVisible();
  const initialOpen = await page.locator('details[open]').count();
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({media: 'print'});
  await expect(page.locator('.report-actions')).toBeHidden();
  expect(await page.locator('details:not([open])').count()).toBe(0);
  await page.pdf({path: info.outputPath('full-report.pdf')});
  await page.emulateMedia({media: 'screen'});
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  expect(await page.locator('details[open]').count()).toBe(initialOpen);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Save HTML Report'}).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('示例Trace-2024-05-02-SmartPerfetto.html');
  const saved = info.outputPath('saved-report.html');
  await download.saveAs(saved);
  const html = await readFile(saved, 'utf8');
  expect(html).toContain('row_13'); expect(html).toContain('TAIL_13');
  expect(requests.some(url => url.endsWith('/export'))).toBe(false);
  await page.context().setOffline(true);
  await page.goto('file://' + saved);
  await expect(page.locator('body')).toContainText('Final conclusion marker');
  await expect(page.locator('.report-metric-table').first()).toContainText('6.944123456ms');
  await expect(page.locator('.causal-map').first()).toBeVisible();
});

test('disabling scripts leaves captured rows readable', async ({browser}) => {
  const context = await browser.newContext({javaScriptEnabled: false, viewport: {width: 340, height: 900}});
  try {
    const page = await context.newPage();
    await page.goto(base + '/main');
    await expect(page.getByText('row_13', {exact: true})).toBeVisible();
    await expect(page.locator('.timeline-text').last()).toContainText('CONVERSATION_TAIL');
    await expect(page.locator('.timeline-text').last()).toBeVisible();
    await expect(page.locator('.table-rows-more').first()).toBeHidden();
    await expect(page.locator('.report-actions')).toBeHidden();
  } finally { await context.close(); }
});
