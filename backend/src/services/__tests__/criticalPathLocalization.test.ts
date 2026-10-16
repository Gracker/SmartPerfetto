// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {renderCriticalPathAnalysis} from '../criticalPathLocalization';
import {anomalyText, hintText, hypothesisText, moduleText, noteText, reasonText, recommendationText, warningText} from '../criticalPathText';
import {CRITICAL_PATH_ANOMALY_IDS, CRITICAL_PATH_HINT_CODES, CRITICAL_PATH_HYPOTHESIS_IDS, CRITICAL_PATH_MODULE_IDS, CRITICAL_PATH_NOTE_CODES, CRITICAL_PATH_RECOMMENDATION_IDS, CRITICAL_PATH_WARNING_CODES, type CriticalPathAnalysis} from '../../types/criticalPathContract';

const HAN = /\p{Script=Han}/u;

function fixture(): CriticalPathAnalysis {
  return renderCriticalPathAnalysis({
    available: true,
    task: {threadStateId: 1, utid: 2, startTs: 3, dur: 50_000_000, durationMs: 50, state: 'S',
      processName: 'app', threadName: 'main'},
    totalMs: 50,
    blockingMs: 40,
    selfMs: 10,
    externalBlockingPercentage: 80,
    wakeupChain: [{
      startTs: 3, dur: 40_000_000, startOffsetMs: 0, durationMs: 40, utid: 7, threadName: 'OkHttp Dispatch',
      processName: 'com.demo', state: 'S', slices: ['stable_slice_name'],
      moduleIds: ['network_receive_candidate', 'worker_handoff'], modules: [],
      reasonItems: [{kind: 'state', state: 'S'}, {kind: 'wake_class', waitClass: 'network_receive_candidate'},
        {kind: 'slice', name: 'stable_slice_name'}],
      reasons: [],
      wakeSourceClass: 'network_receive_candidate',
    }],
    moduleBreakdown: [{moduleId: 'io_filesystem', module: '', durationMs: 40, percentage: 80, segmentCount: 1,
      examples: ['stable.example']}],
    anomalies: [
      {id: 'io_candidate', severity: 'warning', title: '', detail: '', evidence: [],
        evidenceItems: [{kind: 'text', text: 'stable_evidence_id'}, {kind: 'duration', ms: 40}]},
      {id: 'cpu_contention', severity: 'info', params: {ms: 7.25}, title: '', detail: '', evidence: [],
        evidenceItems: [{kind: 'text', text: 'CPU 3: com.demo / RenderThread'}]},
    ],
    summary: '',
    recommendationIds: ['inspect_io'],
    recommendations: [],
    warningCodes: [{code: 'display_cut', params: {total: 180, shown: 160}}],
    warnings: [],
    rawRows: 1,
    truncated: true,
    longestSegment: {processName: 'com.demo', threadName: 'OkHttp Dispatch', durationMs: 40,
      moduleIds: ['network_receive_candidate']},
    directWaker: {threadStateId: null, utid: 5, tid: 0, threadName: 'swapper/0', processName: null, state: null,
      cpu: null, irqContext: true, kind: 'irq', hintCodes: ['irq_wakeup', 'swapper_wakeup'], hints: []},
  }, 'zh-CN');
}

describe('critical-path text catalog', () => {
  it('renders every id in both languages, and English without Chinese', () => {
    const rendered: Array<[string, string]> = [
      ...CRITICAL_PATH_MODULE_IDS.map((id): [string, string] => [moduleText(id, 'zh-CN'), moduleText(id, 'en')]),
      ...CRITICAL_PATH_ANOMALY_IDS.flatMap((id): Array<[string, string]> => {
        const params = {ms: 1, percent: 2, process: 'p', thread: 't'};
        const zh = anomalyText(id, params, 'zh-CN');
        const en = anomalyText(id, params, 'en');
        return [[zh.title, en.title], [zh.detail, en.detail]];
      }),
      ...CRITICAL_PATH_RECOMMENDATION_IDS.map((id): [string, string] => [recommendationText(id, 'zh-CN'), recommendationText(id, 'en')]),
      ...CRITICAL_PATH_WARNING_CODES.map((code): [string, string] =>
        [warningText({code, params: {message: 'm'}}, 'zh-CN'), warningText({code, params: {message: 'm'}}, 'en')]),
      ...CRITICAL_PATH_HINT_CODES.map((code): [string, string] => [hintText(code, 'zh-CN'), hintText(code, 'en')]),
      ...CRITICAL_PATH_HYPOTHESIS_IDS.map((id): [string, string] =>
        [hypothesisText(id, {utid: 1}, 'zh-CN'), hypothesisText(id, {utid: 1}, 'en')]),
      ...CRITICAL_PATH_NOTE_CODES.map((code): [string, string] => [noteText({code}, 'zh-CN'), noteText({code}, 'en')]),
    ];
    for (const [zh, en] of rendered) {
      expect(zh.trim()).not.toBe('');
      expect(en.trim()).not.toBe('');
      expect(en).not.toMatch(HAN);
    }
  });

  it('translates the wake-class reason instead of leaving the class identifier', () => {
    const reason = {kind: 'wake_class', waitClass: 'network_receive_candidate'} as const;
    expect(reasonText(reason, 'zh-CN')).toBe('唤醒来源：网络收包候选');
    expect(reasonText(reason, 'en')).toBe('wake: network-receive candidate');
  });
});

describe('criticalPathLocalization', () => {
  it('renders every display field from ids and keeps trace data verbatim', () => {
    const analysis = fixture();
    const raw = structuredClone(analysis);

    const en = renderCriticalPathAnalysis(analysis, 'en');

    expect(en.summary).not.toMatch(HAN);
    expect(en.moduleBreakdown[0].module).toBe('I/O / File system');
    expect(en.wakeupChain[0].modules).toEqual(['Network-receive wait candidate', 'Worker hand-off wait']);
    expect(en.wakeupChain[0].reasons).toEqual(['Sleeping', 'wake: network-receive candidate', 'stable_slice_name']);
    expect(en.anomalies.map((anomaly) => anomaly.title)).toEqual([
      'The wait chain contains an I/O or page-cache candidate',
      'Scheduling or CPU contention is indicated',
    ]);
    expect(en.anomalies[1].detail).toContain('7.25 ms');
    expect(en.anomalies[0].evidence).toEqual(['stable_evidence_id', '40.00 ms']);
    expect(en.anomalies[1].evidence).toEqual(['CPU 3: com.demo / RenderThread']);
    for (const text of [...en.anomalies.flatMap((a) => [a.title, a.detail]), ...en.recommendations, ...en.warnings]) {
      expect(text).not.toMatch(HAN);
    }
    expect(en.warnings).toEqual([
      'The critical path has 180 chain segments; only the first 160 are shown. Blocking time, module shares and the counterfactual cover the full chain.',
    ]);
    expect(en.directWaker?.hints).toEqual([
      'woken in IRQ context (irq_context=1 on the wakeup row)',
      'woken by idle/swapper — no upstream wait chain to chase',
    ]);
    // Data stays data.
    expect(en.wakeupChain[0].slices).toEqual(['stable_slice_name']);
    expect(en.wakeupChain[0].wakeSourceClass).toBe('network_receive_candidate');
    expect(analysis).toEqual(raw);
  });

  it('renders Chinese for the engine result and is idempotent across languages', () => {
    const zh = fixture();

    expect(zh.wakeupChain[0].reasons).toEqual(['睡眠', '唤醒来源：网络收包候选', 'stable_slice_name']);
    expect(zh.warnings[0]).toBe('critical path 共 180 个链路段，仅展示前 160 个；阻塞时长、模块占比与反事实估计按完整链路计算。');
    expect(zh.summary).toContain('最长可归因段是 com.demo / OkHttp Dispatch，持续 40.00 ms，关联 网络收包等待候选。');
    expect(zh.summary).toContain('直接唤醒来源：Interrupt。');
    const en = renderCriticalPathAnalysis(zh, 'en');
    expect(renderCriticalPathAnalysis(en, 'en')).toEqual(en);
    expect(renderCriticalPathAnalysis(en, 'zh-CN')).toEqual(zh);
  });

  it('renders hypothesis statements and notes from their parameters', () => {
    const analysis = fixture();
    analysis.quantification = {
      counterfactual: null,
      frameImpacts: [],
      warnings: [],
      hypotheses: [{
        id: 'h-io-wait', params: {utid: 42, start: 1, end: 2, durMs: 6, eventDurMs: 9}, statement: '',
        strength: 'strong', verificationSql: 'SELECT 1;', noteCodes: [{code: 'io_wait_confirmed'}], notes: [],
      }],
    };

    const en = renderCriticalPathAnalysis(analysis, 'en').quantification!.hypotheses[0];
    const zh = renderCriticalPathAnalysis(analysis, 'zh-CN').quantification!.hypotheses[0];

    expect(en.statement).toContain('Thread utid=42 spends 6 ms of its critical-path segment [1, 2)');
    expect(en.notes).toEqual(['io_wait flag confirmed']);
    expect(zh.statement).toContain('线程 utid=42 在关键路径段 [1, 2) 中有 6 ms');
    expect(zh.notes).toEqual(['已确认 io_wait 标记']);
    expect(zh.verificationSql).toBe('SELECT 1;');
  });
});
