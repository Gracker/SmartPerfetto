// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import type {AnalysisConclusionEvidence} from '../../types/analysisDelivery';
import {MAX_EVIDENCE_READ_REFERENCES, type CapturedEvidenceRecord, type EvidenceReadResolution} from './evidenceReadView';
import type {EvidenceScalar} from './evidenceCapture';

const SKILL = 'scrolling_analysis';
const CADENCE = 'smoothness_basis';
const TOUCH = 'flutter_swap_touch_gaps';

const cadenceColumns = [
  'upid', 'process_name', 'layer_name', 'primary_layer', 'presentation_status', 'smoothness_rating',
  'start_ts', 'end_ts', 'layer_frames', 'layer_tagged_frames', 'layer_hybrid_frames',
  'layer_present_gap_count', 'layer_over_budget_gaps', 'cadence_gap_count',
  'cadence_gaps_over_1_5x_budget', 'cadence_gap_max_ns', 'budget_status',
];
const touchColumns = [
  'upid', 'process_name', 'utid', 'swap_count', 'complete_contacts', 'gap_class', 'max_gap_ns',
  'touch_over_budget_gaps', 'between_contact_gaps',
  'unresolved_touch_gaps', 'longest_touch_gap_ns', 'longest_unresolved_gap_ns',
];
const ratings = {
  excellent: ['优秀', 'Excellent'],
  good: ['良好', 'Good'],
  fair: ['一般', 'Fair'],
  poor: ['较差', 'Poor'],
  unrated: ['无法评级', 'Unavailable'],
} as const;

type Row = Readonly<Record<string, EvidenceScalar>>;
type ScopeRows = {record: CapturedEvidenceRecord; rows: Row[]};
type CadenceSummary = {gaps: string; tags: string; hybrid: string; maxPresentMs?: number};

function scrollingReportDiscrepancies(body: string, summary: CadenceSummary, language: OutputLanguage): string | undefined {
  const mismatches = new Set<string>();
  const ratioLabels = [
    [/超预算呈现间隔|呈现间隔超\s*1\.5\s*[×x]\s*预算|over-budget present(?:ation)? gaps|present gaps over\s*1\.5/i,
      summary.gaps, '超预算呈现间隔', 'over-budget present gaps'],
    [/FrameTimeline\s*(?:掉帧标签率|jank tag rate)|主图层标签(?:率|帧)/i,
      summary.tags, 'FrameTimeline 掉帧标签率', 'FrameTimeline jank tag rate'],
    [/Skill\s*感知掉帧率|主图层混合掉帧|(?:primary.layer|Skill) (?:perceived|hybrid) jank/i,
      summary.hybrid, '混合信号掉帧率', 'hybrid jank rate'],
  ] as const;
  let fence: string | undefined;
  for (const raw of body.split('\n')) {
    const marker = raw.trimStart().match(/^(?:`{3,}|~{3,})/)?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const line = raw.replace(/[*_`]/g, '');
    if (/单个|单段|(?:第[一二三四五六七八九十\d]+|该|此)\s*(?:次手势|段|个会话|个滑动区间)|每(?:段|个会话)|per.session|each session|(?:first|last|this|session\s+\d+)\s+(?:scroll\s+)?(?:session|segment)|全窗口|all.window/i.test(line)) continue;
    const maximum = line.match(/(?:最长|最大|最差)\s*呈现间隔\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*ms|(?:longest|max(?:imum)?)\s+present(?:ation)?\s+(?:gap|interval)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*ms/i)
      ?? line.match(/(?:呈现间隔|present(?:ation)? (?:gap|interval))[^|\n]*\bp50\s*\/\s*p95\s*\/\s*max\s*\|\s*\d+(?:\.\d+)?\s*(?:ms)?\s*\/\s*\d+(?:\.\d+)?\s*(?:ms)?\s*\/\s*(\d+(?:\.\d+)?)\s*ms/i);
    const reportedMaximum = maximum?.slice(1).find(Boolean);
    if (reportedMaximum && summary.maxPresentMs !== undefined) {
      const precision = reportedMaximum.split('.')[1]?.length ?? 0;
      if (Math.abs(Number(reportedMaximum) - summary.maxPresentMs) > 0.5 / 10 ** precision + 1e-9) {
        mismatches.add(localize(language, '最长呈现间隔', 'longest present gap'));
      }
    }
    for (const [label, expected, zh, en] of ratioLabels) {
      const match = line.match(label);
      if (!match || !/^\d+\/\d+ /.test(expected)) continue;
      const reported = line.slice(match.index! + match[0].length).match(/\b(\d+)\s*\/\s*(\d+)\b/);
      if (reported && `${reported[1]}/${reported[2]}` !== expected.split(' ')[0]) {
        mismatches.add(localize(language, zh, en));
      }
    }
  }
  if (!mismatches.size) return undefined;
  return localize(language,
    `**报告数值提示** · 正文中的${[...mismatches].join('、')}与上方主图层测量不一致，以测量为准。`,
    `**Report measurement check** · The report's ${[...mismatches].join(', ')} differ from the primary-layer measurements above. Use the measured values.`);
}

function count(value: EvidenceScalar | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function ratio(n: EvidenceScalar | undefined, d: EvidenceScalar | undefined, unavailable: string): string {
  const numerator = count(n);
  const denominator = count(d);
  if (numerator === undefined || !denominator || numerator > denominator) return unavailable;
  return `${numerator}/${denominator} (${(100 * numerator / denominator).toFixed(2)}%)`;
}

function valueLabel(value: EvidenceScalar | undefined): string {
  if (typeof value !== 'string') return '';
  // Scope names are trace data. Keep their original text as inline code.
  const plain = value.replace(/[`\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 256);
  return plain ? `\`${plain}\`` : '';
}

function timeBound(value: EvidenceScalar | undefined): bigint | undefined {
  if (typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)) return BigInt(value);
  const ns = count(value);
  return ns === undefined ? undefined : BigInt(ns);
}

function millis(value: EvidenceScalar | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${(value / 1e6).toFixed(2)} ms` : '';
}

function measurementRates(language: OutputLanguage, gaps: string, tags: string, hybrid: string): string[] {
  return [
    `- ${localize(language, '呈现间隔超 1.5× 预算', 'Present gaps over 1.5× budget')} ${gaps}`,
    `- ${localize(language, 'FrameTimeline 掉帧标签率', 'FrameTimeline jank tag rate')} ${tags}`,
    `- ${localize(language, 'Skill 感知掉帧率（混合信号）', 'Skill perceived jank rate (hybrid signal)')} ${hybrid}`,
  ];
}

function cadenceReadout(rows: Row[], touchUpids: ReadonlySet<EvidenceScalar>, language: OutputLanguage,
  summaries: Map<string, CadenceSummary>): string[] {
  const unavailable = localize(language, '不可用', 'Unavailable');
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const primaryLayer = row.primary_layer === 1 || row.primary_layer === true;
    const presentationProxy = row.primary_layer === null && row.presentation_status === 'unmeasured';
    if (!count(row.upid) || (!primaryLayer && !presentationProxy)) continue;
    const key = JSON.stringify([row.upid, row.layer_name]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const lines: string[] = [];
  for (const group of groups.values()) {
    const [row] = group;
    const totals = [
      'smoothness_rating', 'layer_frames', 'layer_tagged_frames', 'layer_hybrid_frames',
      'layer_present_gap_count', 'layer_over_budget_gaps',
    ];
    // Repeated layer totals describe the same population, including when the
    // captured Skill returns one row per constituent scrolling session.
    if (group.some(other => totals.some(column => other[column] !== row[column]))) continue;
    const starts = group.map(item => timeBound(item.start_ts));
    const ends = group.map(item => timeBound(item.end_ts));
    if (starts.some(value => value === undefined) || ends.some(value => value === undefined)) continue;
    const start = starts.reduce<bigint>((low, value) => value! < low ? value! : low, starts[0]!);
    const end = ends.reduce<bigint>((high, value) => value! > high ? value! : high, ends[0]!);
    if (end < start) continue;
    const ratingKey = typeof row.smoothness_rating === 'string' &&
      Object.prototype.hasOwnProperty.call(ratings, row.smoothness_rating)
      ? row.smoothness_rating as keyof typeof ratings : 'unrated';
    const [ratingZh, ratingEn] = ratings[ratingKey];
    const rating = localize(language, ratingZh, ratingEn);
    const frameScope = [valueLabel(row.process_name), valueLabel(row.layer_name)].filter(Boolean).join(' / ');
    lines.push(`**${localize(language, '呈现流畅度评级', 'Presentation cadence rating')}** ${rating} · ${frameScope} (UPID ${row.upid}, ${start}–${end} ns)`);
    const supportedBudget = group.every(item => item.budget_status === 'measured' || item.budget_status === 'derived_from_expected_frames');
    const gaps = supportedBudget ? ratio(row.layer_over_budget_gaps, row.layer_present_gap_count, unavailable) : unavailable;
    const tags = ratio(row.layer_tagged_frames, row.layer_frames, unavailable);
    const hybrid = ratio(row.layer_hybrid_frames, row.layer_frames, unavailable);
    lines.push(...measurementRates(language, gaps, tags, hybrid));
    if (row.presentation_status === 'unmeasured') {
      if (touchUpids.has(row.upid)) {
        lines.push(`- ${localize(language, '替代观测见按触摸时间归类的 Flutter 换帧间隔。', 'See the Flutter swap gaps classified by touch state for the proxy measurement.')}`);
      } else {
        const assumed = row.budget_status === 'assumed_default_no_trace_timing';
        const proxy = supportedBudget || assumed ? ratio(row.cadence_gaps_over_1_5x_budget, row.cadence_gap_count, unavailable) : unavailable;
        lines.push(`- ${localize(language, '替代观测 · doFrame 起点间隔超 1.5× 预算', 'Proxy · doFrame start gaps over 1.5× budget')} ${proxy}${assumed ? localize(language, '（假定预算）', ' (assumed budget)') : ''}`);
      }
    } else {
      const maxima = group.map(item => item.cadence_gap_max_ns)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
      const maxPresentNs = maxima.length ? Math.max(...maxima) : undefined;
      if (maxPresentNs !== undefined) lines.push(`- ${localize(language, '最长呈现间隔', 'Longest present gap')} ${millis(maxPresentNs)}`);
      const summary: CadenceSummary = {gaps, tags, hybrid,
        ...(maxPresentNs === undefined ? {} : {maxPresentMs: maxPresentNs / 1e6})};
      summaries.set(JSON.stringify([row.upid, row.layer_name, String(start), String(end), summary]), summary);
      lines.push('', localize(language,
        '评级采用呈现间隔超预算率。混合信号按帧计数，包含呈现间隔未超预算时的部分 Late Present。',
        'The rating uses the over-budget present gap rate. The hybrid signal counts frames, including some Late Present frames with on-budget gaps.'));
    }
    lines.push('');
  }
  return lines;
}

function touchReadout(rows: Row[], language: OutputLanguage): {lines: string[]; upids: Set<EvidenceScalar>} {
  const lines: string[] = [];
  const upids = new Set<EvidenceScalar>();
  const seen = new Set<number>();
  for (const row of rows) {
    const utid = count(row.utid);
    const during = count(row.touch_over_budget_gaps);
    const between = count(row.between_contact_gaps);
    const unknown = count(row.unresolved_touch_gaps);
    if (!utid || seen.has(utid) || during === undefined || between === undefined || unknown === undefined) continue;
    seen.add(utid);
    if (count(row.upid)) upids.add(row.upid);
    const longestTouch = millis(row.longest_touch_gap_ns);
    const longestUnknown = millis(row.longest_unresolved_gap_ns);
    const longestBetween = millis(rows.find(item => item.utid === utid &&
      item.gap_class === 'between_contacts_or_next_touch_onset')?.max_gap_ns);
    const swaps = count(row.swap_count);
    const contacts = count(row.complete_contacts);
    const samples = swaps === undefined || contacts === undefined ? '' : localize(language,
      ` · ${swaps} 次换帧，${contacts} 个已配对触摸`, ` · ${swaps} swaps, ${contacts} paired touches`);
    lines.push(
      `**${localize(language, 'Flutter 超预算换帧间隔归类', 'Flutter over-budget swap gaps by touch state')}** ${valueLabel(row.process_name)} (UTID ${utid})${samples}`,
      `- ${localize(language, '触摸期间超预算，计入卡顿', 'Over budget during touch, counted as jank')} ${during}${longestTouch ? ` · ${localize(language, '最长', 'max')} ${longestTouch}` : ''}`,
      `- ${localize(language, '手势之间或下一手势起始', 'Between contacts or at the next touch onset')} ${between}${longestBetween ? ` · ${localize(language, '最长', 'max')} ${longestBetween}` : ''}`,
      `- ${localize(language, '触摸状态未知，未计入触摸内卡顿', 'Unknown touch state, excluded from touch-time jank')} ${unknown}${longestUnknown ? ` · ${localize(language, '最长', 'max')} ${longestUnknown}` : ''}`,
      '',
    );
  }
  return {lines, upids};
}

function sourceRows(resolutions: readonly EvidenceReadResolution[]): ScopeRows[] {
  const groups = new Map<CapturedEvidenceRecord, ScopeRows>();
  for (const item of resolutions) {
    if (item.status !== 'resolved' || !item.row || !item.record.meta.evidenceRefId) continue;
    const key = item.record;
    const group = groups.get(key) ?? {record: item.record, rows: []};
    group.rows.push(item.row);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.rows.length === group.record.totalRowCount);
}

/** Produce the official measurement section from retained, scoped Skill captures. */
export async function buildScrollingConclusionEvidence(context: RuntimeFinalizationContext, language: OutputLanguage,
  signal: AbortSignal, reportBody?: string): Promise<AnalysisConclusionEvidence | undefined> {
  const {turnIntent: intent, strategyRegistry} = context;
  const records = context.currentSkillResults?.(SKILL, [CADENCE, TOUCH], signal) ?? [];
  const requests = [];
  for (const record of records) {
    const evidenceRefId = record.meta.evidenceRefId;
    if (!evidenceRefId || record.originRunId !== context.runId ||
        record.meta.traceSide !== 'current' || record.meta.traceId !== context.traceIdentity.currentTraceId ||
        record.meta.scopeProvenance?.invalid ||
        requests.length + record.totalRowCount > MAX_EVIDENCE_READ_REFERENCES) continue;
    const columns = record.meta.stepId === CADENCE ? cadenceColumns : touchColumns;
    for (let rowIndex = 0; rowIndex < record.totalRowCount; rowIndex++) {
      requests.push({key: `${record.storeId}:${record.generation}:${rowIndex}`,
        reference: {evidenceRefId, artifactId: record.meta.artifactId, rowIndex}, requiredColumns: columns});
    }
  }
  const resolved = requests.length ? await context.resolveReferences(requests, signal) : [];
  const captured = sourceRows(resolved);
  const evidenceRefIds: string[] = [];
  const cadenceSections = new Set<string>();
  const summaries = new Map<string, CadenceSummary>();
  const touchSections = new Set<string>();
  const touchUpidsByInvocation = new Map<string, Set<EvidenceScalar>>();
  for (const {record, rows} of captured.filter(item => item.record.meta.stepId === TOUCH)) {
    const {lines, upids} = touchReadout(rows, language);
    if (!lines.length) continue;
    touchSections.add(lines.join('\n').trim());
    evidenceRefIds.push(record.meta.evidenceRefId!);
    const callId = record.meta.sourceToolCallId;
    if (callId) touchUpidsByInvocation.set(callId, upids);
  }
  for (const {record, rows} of captured.filter(item => item.record.meta.stepId === CADENCE)) {
    const touchUpids = touchUpidsByInvocation.get(record.meta.sourceToolCallId ?? '') ?? new Set<EvidenceScalar>();
    const lines = cadenceReadout(rows, touchUpids, language, summaries);
    if (!lines.length) continue;
    cadenceSections.add(lines.join('\n').trim());
    evidenceRefIds.push(record.meta.evidenceRefId!);
  }
  if (!cadenceSections.size) {
    if (!touchSections.size && !(intent.status === 'resolved' && intent.taskKind === 'investigation' &&
        strategyRegistry.getStrategy(intent.sceneId)?.entrySkill?.id === SKILL)) return undefined;
    const unavailable = localize(language, '不可用', 'Unavailable');
    cadenceSections.add([
      localize(language, '**呈现流畅度无法评级** · 本轮没有可用的同范围流畅度读数。', '**Presentation cadence rating unavailable** · No same-scope readout is available in this run.'),
      ...measurementRates(language, unavailable, unavailable, unavailable),
    ].join('\n'));
  }
  // A generic report-wide claim is only comparable when it has one measured scope.
  const summary = !context.traceIdentity.referenceTraceId && intent.taskKind !== 'comparison' &&
    summaries.size === 1 ? summaries.values().next().value : undefined;
  const discrepancy = summary && reportBody ? scrollingReportDiscrepancies(reportBody, summary, language) : undefined;
  return {
    schemaVersion: 'scrolling_conclusion@1',
    markdown: `## ${localize(language, '滑动流畅度测量', 'Scrolling smoothness measurements')}\n\n${[...cadenceSections, ...touchSections, ...(discrepancy ? [discrepancy] : [])].join('\n\n')}`,
    evidenceRefIds: [...new Set(evidenceRefIds)],
  };
}
