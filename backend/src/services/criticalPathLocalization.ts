// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Renders every display field of a critical-path analysis from the ids the
// engine recorded (see criticalPathText.ts). Rendering is idempotent — it
// never reads previously rendered text — so any analysis, raw or already
// projected, can be rendered into any output language.

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import {
  anomalyText,
  evidenceText,
  hintText,
  hypothesisText,
  moduleText,
  noteText,
  reasonText,
  recommendationText,
  stateText,
  waitClassText,
  warningText,
} from './criticalPathText';
import type {CriticalPathAnalysis, CriticalPathSegment} from '../types/criticalPathContract';

function renderSegment(segment: CriticalPathSegment, language: OutputLanguage): CriticalPathSegment {
  return {
    ...segment,
    modules: segment.moduleIds.map((id) => moduleText(id, language)),
    reasons: segment.reasonItems.map((reason) => reasonText(reason, language)),
    ...(segment.children ? {children: segment.children.map((child) => renderSegment(child, language))} : {}),
  };
}

/**
 * The headline: attributable time first, then what the chain covers. Path
 * coverage alone reads a peer's interrupt-ended sleep as cost; an analysis
 * without the attributable split keeps the coverage line it always had.
 */
export function pathLine(analysis: CriticalPathAnalysis, language: OutputLanguage): string {
  const coverage = analysis.blockingMs.toFixed(2);
  const coveragePct = analysis.externalBlockingPercentage.toFixed(2);
  if (analysis.attributableMs === undefined) {
    return localize(
      language,
      `critical path 外部链路累计 ${coverage} ms，占 ${coveragePct}%。`,
      `External critical path: ${coverage} ms (${coveragePct}%).`,
    );
  }
  const attributable = analysis.attributableMs.toFixed(2);
  const attributablePct = (analysis.attributablePercentage ?? 0).toFixed(2);
  const eventWait = (analysis.eventWaitMs ?? 0).toFixed(2);
  return localize(
    language,
    `可归因外部耗时 ${attributable} ms，占 ${attributablePct}%（其他线程运行、可运行与不可中断等待）；链路覆盖 ${coverage} ms（${coveragePct}%），其中链路末端的外部事件等待 ${eventWait} ms。`,
    `Attributable external time: ${attributable} ms (${attributablePct}%; other threads running, runnable or in uninterruptible wait). The chain covers ${coverage} ms (${coveragePct}%), of which ${eventWait} ms are chain-end waits for external events.`,
  );
}

function rootWaitLine(analysis: CriticalPathAnalysis, language: OutputLanguage): string | undefined {
  const rootWait = analysis.rootWait;
  if (!rootWait) return undefined;
  switch (rootWait.context) {
    case 'in_slice':
      return localize(
        language,
        `选中等待发生在 slice「${rootWait.enclosingSlice?.name ?? '-'}」内。`,
        `The selected wait happened inside the slice "${rootWait.enclosingSlice?.name ?? '-'}".`,
      );
    case 'between_slices':
      return localize(
        language,
        '选中等待不在任何 slice 内，前后都有 slice：更像线程空闲。',
        'The selected wait sits outside any slice, with slices before and after it: it reads as idle time.',
      );
    case 'no_slice_data':
      return localize(
        language,
        '该线程在选中等待一侧没有 slice，无法区分空闲与工作。',
        'The thread has no slices on one side of the selected wait, so idle time cannot be told from work.',
      );
  }
}

function summaryText(analysis: CriticalPathAnalysis, language: OutputLanguage): string {
  const {task} = analysis;
  const owner = (process: string | null | undefined, thread: string | null | undefined): string =>
    `${process ?? '-'} / ${thread ?? '-'}`;
  const listSeparator = localize(language, '、', ', ');
  const lines = [
    localize(
      language,
      `选中 task 位于 ${owner(task.processName, task.threadName)}，状态 ${stateText(task.state, language)}，持续 ${task.durationMs.toFixed(2)} ms。`,
      `Selected task: ${owner(task.processName, task.threadName)}, state ${stateText(task.state, language)}, duration ${task.durationMs.toFixed(2)} ms.`,
    ),
    pathLine(analysis, language),
  ];
  const rootWait = rootWaitLine(analysis, language);
  if (rootWait) lines.push(rootWait);
  const longest = analysis.longestSegment;
  if (longest) {
    const modules = longest.moduleIds.map((id) => moduleText(id, language)).join(listSeparator) ||
      moduleText('unclassified', language);
    lines.push(localize(
      language,
      `最长可归因段是 ${owner(longest.processName, longest.threadName)}，持续 ${longest.durationMs.toFixed(2)} ms，关联 ${modules}。`,
      `Longest attributable segment: ${owner(longest.processName, longest.threadName)}, ${longest.durationMs.toFixed(2)} ms, modules ${modules}.`,
    ));
  }
  const leaf = analysis.longestEventWait;
  if (leaf) {
    const wake = waitClassText(leaf.wakeSourceClass ?? 'unknown', language);
    lines.push(localize(
      language,
      `链路末端最长的外部事件等待是 ${owner(leaf.processName, leaf.threadName)}，${leaf.durationMs.toFixed(2)} ms，唤醒来源：${wake}。`,
      `Longest chain-end wait for an external event: ${owner(leaf.processName, leaf.threadName)}, ${leaf.durationMs.toFixed(2)} ms, wake: ${wake}.`,
    ));
  }
  const topModules = analysis.moduleBreakdown
    .slice(0, 3)
    .map((item) => `${moduleText(item.moduleId, language)} ${item.durationMs.toFixed(2)} ms`)
    .join(listSeparator);
  if (topModules) lines.push(localize(language, `主要关联模块：${topModules}。`, `Primary modules: ${topModules}.`));
  const highest =
    analysis.anomalies.find((item) => item.severity === 'critical') ??
    analysis.anomalies.find((item) => item.severity === 'warning');
  if (highest) {
    const {title, detail} = anomalyText(highest.id, highest.params, language);
    lines.push(localize(language, `异常判断：${title}。${detail}`, `Finding: ${title}. ${detail}`));
  }
  const waker = analysis.directWaker;
  if (waker && (waker.threadName || waker.irqContext)) {
    const source = waker.irqContext ? 'Interrupt' : owner(waker.processName, waker.threadName);
    lines.push(localize(language, `直接唤醒来源：${source}。`, `Direct waker: ${source}.`));
  }
  return lines.join('\n');
}

// One request renders the same result for the route, its rule summary and its
// prompt; each (analysis, language) pair is rendered once. Results are treated
// as immutable once the engine returns them.
const renderedByLanguage = new WeakMap<CriticalPathAnalysis, Map<OutputLanguage, CriticalPathAnalysis>>();

/** Every display field rendered in `language` from the analysis' ids. */
export function renderCriticalPathAnalysis(
  analysis: CriticalPathAnalysis,
  language: OutputLanguage,
): CriticalPathAnalysis {
  const cached = renderedByLanguage.get(analysis)?.get(language);
  if (cached) return cached;
  const rendered = renderUncached(analysis, language);
  const byLanguage = renderedByLanguage.get(analysis) ?? new Map<OutputLanguage, CriticalPathAnalysis>();
  byLanguage.set(language, rendered);
  renderedByLanguage.set(analysis, byLanguage);
  return rendered;
}

function renderUncached(analysis: CriticalPathAnalysis, language: OutputLanguage): CriticalPathAnalysis {
  const quantification = analysis.quantification;
  const rendered: CriticalPathAnalysis = {
    ...analysis,
    wakeupChain: analysis.wakeupChain.map((segment) => renderSegment(segment, language)),
    moduleBreakdown: analysis.moduleBreakdown.map((item) => ({...item, module: moduleText(item.moduleId, language)})),
    anomalies: analysis.anomalies.map((anomaly) => ({
      ...anomaly,
      ...anomalyText(anomaly.id, anomaly.params, language),
      evidence: anomaly.evidenceItems.map((item) => evidenceText(item, language)),
    })),
    recommendations: analysis.recommendationIds.map((id) => recommendationText(id, language)),
    warnings: analysis.warningCodes.map((warning) => warningText(warning, language)),
    ...(analysis.directWaker
      ? {directWaker: {...analysis.directWaker, hints: analysis.directWaker.hintCodes.map((code) => hintText(code, language))}}
      : {}),
    ...(quantification
      ? {
          quantification: {
            ...quantification,
            counterfactual: quantification.counterfactual
              ? {...quantification.counterfactual, note: noteText({code: quantification.counterfactual.noteCode}, language)}
              : null,
            hypotheses: quantification.hypotheses.map((hypothesis) => ({
              ...hypothesis,
              statement: hypothesisText(hypothesis.id, hypothesis.params, language),
              notes: hypothesis.noteCodes.map((note) => noteText(note, language)),
            })),
          },
        }
      : {}),
  };
  return {...rendered, summary: summaryText(rendered, language)};
}
