// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Deterministic, provider-free rendering of a critical-path analysis.
//
// This lives apart from `criticalPathAiSummary.ts` on purpose: that module
// imports the Claude Agent SDK at module scope for `summarizeCriticalPathWithAi`,
// so anything importing it pays for an SDK load and an implicit provider
// dependency. The MCP `analyze_wait_chain` tool needs only this rule summary and
// must never reach a provider, so the pure function lives here and the old
// module re-exports it for its existing route consumer.

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {pathLine, renderCriticalPathAnalysis} from './criticalPathLocalization';
import type {CriticalPathAnalysis} from '../types/criticalPathContract';

export function buildDeterministicCriticalPathSummary(
  analysis: CriticalPathAnalysis,
  outputLanguage: OutputLanguage = 'zh-CN',
): string {
  // Every label is rendered from the analysis' ids, so an analysis that was
  // already projected into another language renders the same way.
  const view = renderCriticalPathAnalysis(analysis, outputLanguage);
  const l = (zh: string, en: string): string => localize(outputLanguage, zh, en);
  const listSeparator = l('、', ', ');
  const counterfactual = view.quantification?.counterfactual;
  const lines = [
    view.summary,
    '',
    l(
      '事实来源：Perfetto sched.thread_executing_span_with_slice / _critical_path_stack。',
      'Evidence source: Perfetto sched.thread_executing_span_with_slice / _critical_path_stack.',
    ),
    l(
      `选中 task：${view.task.processName ?? '-'} / ${view.task.threadName ?? '-'}，${view.totalMs.toFixed(2)} ms。`,
      `Selected task: ${view.task.processName ?? '-'} / ${view.task.threadName ?? '-'}, ${view.totalMs.toFixed(2)} ms.`,
    ),
    pathLine(view, outputLanguage),
  ];

  if (view.moduleBreakdown.length > 0) {
    const modules = view.moduleBreakdown
      .slice(0, 4)
      .map((item) => `${item.module} ${item.durationMs.toFixed(2)} ms`)
      .join(listSeparator);
    lines.push(l(`主要模块：${modules}。`, `Primary modules: ${modules}.`));
  }
  const waker = view.directWaker;
  if (waker?.kind && waker.kind !== 'unknown') {
    const name = waker.threadName ? ` (${waker.threadName})` : '';
    lines.push(l(
      `直接唤醒来源：${waker.kind}${name}${waker.irqContext ? '，IRQ 上下文' : ''}。`,
      `Direct waker: ${waker.kind}${name}${waker.irqContext ? ', IRQ context' : ''}.`,
    ));
  }
  if (counterfactual) {
    lines.push(l(
      `反事实最好情况：消除最长可归因段（${counterfactual.longestSegmentDurMs.toFixed(2)} ms）后，` +
        `任务时长最好可降至 ${counterfactual.bestCaseDurationMs.toFixed(2)} ms，即至多节省 ` +
        `${counterfactual.maxSavingMs.toFixed(2)} ms；其他等待可能成为新瓶颈，实际节省可能更少。`,
      `Counterfactual best case: removing the longest attributable segment ` +
        `(${counterfactual.longestSegmentDurMs.toFixed(2)} ms) leaves a best-case task duration of ` +
        `${counterfactual.bestCaseDurationMs.toFixed(2)} ms, a saving of at most ` +
        `${counterfactual.maxSavingMs.toFixed(2)} ms. ` +
        'Another wait may become the bottleneck, so the real saving can be smaller.',
    ));
  }
  if (view.anomalies.length > 0) {
    const titles = view.anomalies.slice(0, 3).map((item) => item.title).join(l('；', '; '));
    lines.push(l(`规则判断：${titles}。`, `Rule findings: ${titles}.`));
  }
  if (view.recommendations.length > 0) {
    lines.push(l(
      `建议：${view.recommendations.slice(0, 2).join('；')}`,
      `Recommendations: ${view.recommendations.slice(0, 2).join(' ')}`,
    ));
  }

  return lines.join('\n');
}
