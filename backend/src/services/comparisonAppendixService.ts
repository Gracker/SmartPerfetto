// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { QueryResult } from './traceProcessorService';
import type {
  ComparisonReportSection,
  ComparisonSourceKind,
} from '../agentv3/sessionStateSnapshot';
import type {FinalResultComparisonIdentity} from './finalResultQualityGate';

export interface ComparisonAppendixQueryService {
  queryTrace(traceId: string, sql: string): Promise<QueryResult>;
}

export interface ComparisonAppendixInput {
  currentTraceId: string;
  referenceTraceId: string;
  title?: string;
  description?: string;
}

export interface ComparisonAppendix {
  markdown: string;
  html: string;
  limitations: string[];
  evidencePack: ComparisonEvidencePack;
}

export interface ComparisonEvidencePack {
  source: ComparisonSourceKind;
  currentTraceId: string;
  referenceTraceId: string;
  current: SideData;
  reference: SideData;
  metrics: {
    currentPackage?: string;
    referencePackage?: string;
    currentStartupType?: string;
    referenceStartupType?: string;
    currentDurationMs?: number | null;
    referenceDurationMs?: number | null;
    durationDeltaMs?: number | null;
  };
  limitations: string[];
}

export interface StartupRow {
  startup_id: number | null;
  package: string;
  startup_type: string;
  dur_ms: number | null;
}

export interface SideData {
  label: 'current' | 'reference';
  startup?: StartupRow;
  topSlices: Array<Record<string, unknown>>;
  threadStates: Array<Record<string, unknown>>;
  errors: string[];
}

function safeReportPackageName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f`]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function comparisonIdentityFromReportSection(
  section: ComparisonReportSection | undefined,
): FinalResultComparisonIdentity | undefined {
  if (section?.source !== 'raw_trace_pair') return undefined;
  const evidencePack = section.evidencePack;
  if (!evidencePack || typeof evidencePack !== 'object' || Array.isArray(evidencePack)) {
    return undefined;
  }
  const metrics = (evidencePack as {metrics?: unknown}).metrics;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return undefined;
  const metricRecord = metrics as Record<string, unknown>;
  const currentPackageName = safeReportPackageName(metricRecord.currentPackage);
  const referencePackageName = safeReportPackageName(metricRecord.referencePackage);
  if (!currentPackageName || !referencePackageName) return undefined;
  return {currentPackageName, referencePackageName};
}

export async function buildComparisonAppendix(
  service: ComparisonAppendixQueryService,
  input: ComparisonAppendixInput,
): Promise<ComparisonAppendix> {
  const [current, reference] = await Promise.all([
    collectSideData(service, 'current', input.currentTraceId),
    collectSideData(service, 'reference', input.referenceTraceId),
  ]);

  const title = input.title || 'SmartPerfetto 确定性对比附录';
  const limitations = collectLimitations(current, reference);
  const evidencePack: ComparisonEvidencePack = {
    source: 'raw_trace_pair',
    currentTraceId: input.currentTraceId,
    referenceTraceId: input.referenceTraceId,
    current,
    reference,
    metrics: buildMetrics(current, reference),
    limitations,
  };
  const markdown = renderMarkdown(current, reference, title, limitations);
  return {
    markdown,
    html: renderHtml(markdown, title, input.description),
    limitations,
    evidencePack,
  };
}

export async function buildRawTraceComparisonReportSection(
  service: ComparisonAppendixQueryService,
  input: ComparisonAppendixInput,
): Promise<ComparisonReportSection> {
  const appendix = await buildComparisonAppendix(service, input);
  return {
    source: 'raw_trace_pair',
    title: input.title || 'SmartPerfetto 确定性对比附录',
    markdown: appendix.markdown,
    html: appendix.html,
    limitations: appendix.limitations,
    evidencePack: appendix.evidencePack,
  };
}

async function collectSideData(
  service: ComparisonAppendixQueryService,
  label: 'current' | 'reference',
  traceId: string,
): Promise<SideData> {
  const side: SideData = { label, topSlices: [], threadStates: [], errors: [] };

  try {
    const result = await service.queryTrace(traceId, `
      select
        startup_id,
        package,
        startup_type,
        round(dur / 1e6, 2) as dur_ms
      from android_startups
      order by dur desc
      limit 1
    `);
    const row = rowToObject(result.columns, result.rows[0] || []);
    side.startup = {
      startup_id: toNumber(row.startup_id),
      package: String(row.package ?? ''),
      startup_type: String(row.startup_type ?? ''),
      dur_ms: toNumber(row.dur_ms),
    };
  } catch (err) {
    side.errors.push(`startup overview failed: ${(err as Error).message}`);
  }

  if (side.startup?.package) {
    try {
      const result = await service.queryTrace(traceId, `
        with st as (
          select ts, dur, package
          from android_startups
          order by dur desc
          limit 1
        ),
        proc as (
          select p.upid
          from process p, st
          where p.name = st.package
          limit 1
        )
        select
          s.name,
          round(sum(s.dur) / 1e6, 2) as total_ms,
          count(*) as count
        from slice s
        join thread_track tt on s.track_id = tt.id
        join thread t on tt.utid = t.utid
        where t.upid = (select upid from proc)
          and s.ts >= (select ts from st)
          and s.ts < (select ts + dur from st)
          and s.dur > 0
        group by s.name
        order by sum(s.dur) desc
        limit 10
      `);
      side.topSlices = rowsToObjects(result.columns, result.rows);
    } catch (err) {
      side.errors.push(`top slices failed: ${(err as Error).message}`);
    }

    try {
      const result = await service.queryTrace(traceId, `
        with st as (
          select ts, dur, package
          from android_startups
          order by dur desc
          limit 1
        ),
        main_thread as (
          select t.utid
          from thread t
          join process p on t.upid = p.upid,
          st
          where p.name = st.package
          order by case when t.name = p.name then 0 when t.name = 'main' then 1 else 2 end
          limit 1
        )
        select
          state,
          round(sum(dur) / 1e6, 2) as dur_ms,
          round(sum(dur) * 100.0 / (select dur from st), 1) as pct
        from thread_state
        where utid = (select utid from main_thread)
          and ts >= (select ts from st)
          and ts < (select ts + dur from st)
        group by state
        order by sum(dur) desc
      `);
      side.threadStates = rowsToObjects(result.columns, result.rows);
    } catch (err) {
      side.errors.push(`thread states failed: ${(err as Error).message}`);
    }
  }

  return side;
}

function renderMarkdown(
  current: SideData,
  reference: SideData,
  title: string,
  limitations: string[],
): string {
  const cur = current.startup;
  const ref = reference.startup;
  const delta = cur?.dur_ms != null && ref?.dur_ms != null
    ? round(cur.dur_ms - ref.dur_ms, 2)
    : null;

  const lines: string[] = [
    `## ${title}`,
    '',
    '### 指标对比矩阵',
    '',
    markdownTable(
      ['指标', 'Current', 'Reference', 'Delta'],
      [
        ['Package', cur?.package || '-', ref?.package || '-', '-'],
        ['Perfetto startup_type', cur?.startup_type || '-', ref?.startup_type || '-', '-'],
        ['dur_ms', formatNumber(cur?.dur_ms), formatNumber(ref?.dur_ms), formatSigned(delta)],
      ],
    ),
    '',
    '### Current 启动窗口 Top Slices',
    '',
    markdownTable(['name', 'total_ms', 'count'], current.topSlices.map(sliceRow)),
    '',
    '### Reference 启动窗口 Top Slices',
    '',
    markdownTable(['name', 'total_ms', 'count'], reference.topSlices.map(sliceRow)),
    '',
    '### 主线程状态对比',
    '',
    markdownTable(
      ['Trace', 'state', 'dur_ms', 'pct'],
      [
        ...current.threadStates.map((row) => stateRow('current', row)),
        ...reference.threadStates.map((row) => stateRow('reference', row)),
      ],
    ),
    '',
    '### 证据限制',
    '',
    ...limitations,
    '',
  ];
  return lines.join('\n');
}

function renderHtml(markdown: string, title: string, description?: string): string {
  const body = markdown
    .split('\n')
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('\n');
  return [
    '<section class="smartperfetto-comparison-appendix" style="margin:32px 0;padding:24px;border-top:1px solid #e5e7eb">',
    `<h2>${escapeHtml(title)}</h2>`,
    `<p>${escapeHtml(description || '由 SmartPerfetto 在同一 current/reference trace 上执行固定 SQL 生成，用来补充 LLM 报告主体。')}</p>`,
    `<pre style="white-space:pre-wrap;line-height:1.5">${escapeHtml(markdown)}</pre>`,
    '<details><summary>Line-rendered copy</summary>',
    body,
    '</details>',
    '</section>',
  ].join('\n');
}

function collectLimitations(current: SideData, reference: SideData): string[] {
  const errors = [
    ...current.errors.map((e) => `- current: ${e}`),
    ...reference.errors.map((e) => `- reference: ${e}`),
  ];
  const limits = errors.length ? errors : ['- 固定 SQL 附录生成未记录失败。'];
  limits.push('- `Perfetto startup_type` 直接来自 `android_startups.startup_type`，不是 SmartPerfetto 二次判定；如与用户指定 cold/warm 口径或 bindApplication/activityStart 信号冲突，需要在正文中单独列为证据限制。');
  return limits;
}

function buildMetrics(current: SideData, reference: SideData): ComparisonEvidencePack['metrics'] {
  const currentDurationMs = current.startup?.dur_ms;
  const referenceDurationMs = reference.startup?.dur_ms;
  return {
    currentPackage: current.startup?.package || undefined,
    referencePackage: reference.startup?.package || undefined,
    currentStartupType: current.startup?.startup_type || undefined,
    referenceStartupType: reference.startup?.startup_type || undefined,
    currentDurationMs,
    referenceDurationMs,
    durationDeltaMs: currentDurationMs != null && referenceDurationMs != null
      ? round(currentDurationMs - referenceDurationMs, 2)
      : null,
  };
}

function sliceRow(row: Record<string, unknown>): string[] {
  return [
    String(row.name ?? '-'),
    formatNumber(toNumber(row.total_ms)),
    formatNumber(toNumber(row.count)),
  ];
}

function stateRow(label: string, row: Record<string, unknown>): string[] {
  return [
    label,
    String(row.state ?? '-'),
    formatNumber(toNumber(row.dur_ms)),
    formatNumber(toNumber(row.pct)),
  ];
}

function markdownTable(headers: string[], rows: string[][]): string {
  const safeRows = rows.length ? rows : [headers.map(() => '-')];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n');
}

function rowsToObjects(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((row) => rowToObject(columns, row));
}

function rowToObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    out[column] = row[index];
  });
  return out;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? '-' : String(value);
}

function formatSigned(value: number | null): string {
  if (value == null) return '-';
  return value >= 0 ? `+${value}` : String(value);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
