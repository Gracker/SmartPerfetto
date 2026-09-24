// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate, stripPromptComments} from '../agentv3/strategyLoader';
import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {CriticalPathAiSummary, CriticalPathAnalysis, CriticalPathRole} from '../types/criticalPathContract';
import {redactObjectForLLM} from '../utils/llmPrivacy';
import type {AiCapabilityPolicyV1} from './aiCapabilityPolicy';
import {segmentPathRole} from './criticalPathAnalyzer';
import {renderCriticalPathAnalysis} from './criticalPathLocalization';
import {buildDeterministicCriticalPathSummary} from './criticalPathSummary';
import {runOneShotSummary} from './oneShotModelCall';
import type {ProviderScope} from './providerManager';

export interface CriticalPathAiSummaryOptions {
  /**
   * Provider Manager scope of the caller. The summary follows that scope's
   * active profile exactly like an Agent run, instead of raw process env.
   */
  providerScope?: ProviderScope;
  /** Caller cancellation, e.g. the HTTP client disconnecting. */
  signal?: AbortSignal;
  /** Defaults to the process-wide `SMARTPERFETTO_AI_ENABLED` policy. */
  aiPolicy?: AiCapabilityPolicyV1;
  /**
   * Whether the caller may start model work (`agent:run`). Reading a trace is
   * not enough to spend the workspace's provider; false returns the rule
   * summary without any model call.
   */
  aiPermitted?: boolean;
}

type CriticalPathCounterfactual = NonNullable<
  NonNullable<CriticalPathAnalysis['quantification']>['counterfactual']
>;

interface CounterfactualView {
  longestSegmentDurMs: number;
  /** Best-case task duration once the longest external segment is removed. */
  bestCaseDurationMs: number;
  /** The saving that removal can buy at most (a shorter path may take over). */
  maxSavingMs: number;
}

// The pick keeps the ns fields and the note out of the
// prompt: the model sees the best-case fields only.
function readCounterfactual(counterfactual: CriticalPathCounterfactual): CounterfactualView {
  const {longestSegmentDurMs, bestCaseDurationMs, maxSavingMs} = counterfactual;
  return {longestSegmentDurMs, bestCaseDurationMs, maxSavingMs};
}

// LLM input hard caps (Codex P1-6) — protect cost and avoid drowning the model
// in segment-level detail.
const HARD_CAPS = {
  segments: 16,
  childSegments: 4,
  binderTxnsPerSeg: 4,
  monitorPerSeg: 4,
  ioPerSeg: 4,
  gcPerSeg: 4,
  cpuPerSeg: 4,
  hypotheses: 3,
  warnings: 8,
  stringMaxLen: 200,
} as const;

function clampString<T>(value: T, max: number = HARD_CAPS.stringMaxLen): T {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return (value.slice(0, max - 1) + '…') as unknown as T;
}

// Codex P0-5: extend redaction beyond the generic API-key/path patterns to
// cover Android-specific PII surfaces — package names, binder methods,
// io paths, monitor methods, layer names.
function redactCriticalPathFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactCriticalPathFields(item));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      // Hypothesis text is built by the product from numeric-only
      // interpolation, and the prompt asks the model to reuse the SQL
      // verbatim; clamping it would cut the SQL mid-predicate.
      if (lk === 'statement' || lk === 'verificationsql' || lk === 'notes') {
        out[k] = v;
        continue;
      }
      // Hash-style obfuscation for sensitive identifiers (keep grouping but
      // not the literal value).
      if (
        lk === 'package_name' ||
        lk === 'packagename' ||
        lk === 'app_package' ||
        lk === 'method_name' ||
        lk === 'methodname' ||
        lk === 'short_blocking_method' ||
        lk === 'short_blocked_method' ||
        lk === 'blocking_method' ||
        lk === 'blocked_method' ||
        lk === 'interface' ||
        lk === 'interfacename' ||
        lk === 'aidl_name' ||
        lk === 'layer_name' ||
        lk === 'layername' ||
        lk === 'io_path' ||
        lk === 'iopath' ||
        lk === 'path' ||
        // The compact payload's own keys (binder and monitor methods).
        lk === 'method' ||
        lk === 'blockedmethod'
      ) {
        if (typeof v === 'string' && v.length > 0) {
          out[k] = `<${lk}_${Buffer.from(v).toString('base64').slice(0, 8)}>`;
          continue;
        }
      }
      out[k] = clampString(redactCriticalPathFields(v));
    }
    return out;
  }
  if (typeof value === 'string') {
    return clampString(value);
  }
  return value;
}

interface TrimmedSegment {
  startOffsetMs: number;
  durationMs: number;
  threadName: string | null | undefined;
  processName: string | null | undefined;
  state: string | null | undefined;
  pathRole: CriticalPathRole;
  wakeSourceClass: CriticalPathAnalysis['wakeupChain'][number]['wakeSourceClass'];
  blockedFunction: string | null | undefined;
  cpu: number | null | undefined;
  ioWait: boolean | null | undefined;
  modules: string[];
  reasons: string[];
  semantics?: unknown;
  children?: TrimmedSegment[];
}

function compactAnalysisForLLM(analysis: CriticalPathAnalysis): unknown {
  const trimSegment = (segment: CriticalPathAnalysis['wakeupChain'][number]): TrimmedSegment => ({
    startOffsetMs: segment.startOffsetMs,
    durationMs: segment.durationMs,
    threadName: segment.threadName,
    processName: segment.processName,
    state: segment.state,
    pathRole: segmentPathRole(segment),
    wakeSourceClass: segment.wakeSourceClass,
    blockedFunction: segment.blockedFunction,
    cpu: segment.cpu,
    ioWait: segment.ioWait,
    modules: segment.modules,
    reasons: segment.reasons.slice(0, 6),
    semantics: segment.semantics
      ? {
          binderTxns: segment.semantics.binderTxns.slice(0, HARD_CAPS.binderTxnsPerSeg).map((txn) => ({
            side: txn.side,
            isSync: txn.isSync,
            isMainThread: txn.isMainThread,
            method: txn.methodName,
            interface: txn.interfaceName,
            durMs: txn.durMs,
          })),
          monitorContention: segment.semantics.monitorContention.slice(0, HARD_CAPS.monitorPerSeg).map((mc) => ({
            method: mc.shortBlockingMethod,
            blockedMethod: mc.shortBlockedMethod,
            blockedThread: mc.blockedThreadName,
            blockingThread: mc.blockingThreadName,
            durMs: mc.durMs,
            isBlockedThreadMain: mc.isBlockedThreadMain,
          })),
          ioSignals: segment.semantics.ioSignals.slice(0, HARD_CAPS.ioPerSeg).map((io) => ({
            source: io.source,
            blockedFunction: io.blockedFunction,
            durMs: io.durMs,
          })),
          gcEvents: segment.semantics.gcEvents.slice(0, HARD_CAPS.gcPerSeg).map((gc) => ({
            type: gc.gcType,
            isMarkCompact: gc.isMarkCompact,
            reclaimedMb: gc.reclaimedMb,
            durMs: gc.durMs,
          })),
          cpuCompetition: segment.semantics.cpuCompetition.slice(0, HARD_CAPS.cpuPerSeg).map((cpu) => ({
            cpu: cpu.cpu,
            competingThread: cpu.competingThread,
            competingState: cpu.competingState,
            competingDurMs: cpu.competingDurMs,
            cpuMaxFreqKhz: cpu.cpuMaxFreqKhz,
          })),
        }
      : undefined,
    children: segment.children
      ? segment.children.slice(0, HARD_CAPS.childSegments).map((child) => trimSegment(child))
      : undefined,
  });

  return {
    available: analysis.available,
    task: analysis.task,
    totalMs: analysis.totalMs,
    blockingMs: analysis.blockingMs,
    selfMs: analysis.selfMs,
    externalBlockingPercentage: analysis.externalBlockingPercentage,
    attributableMs: analysis.attributableMs,
    attributablePercentage: analysis.attributablePercentage,
    eventWaitMs: analysis.eventWaitMs,
    eventWaitPercentage: analysis.eventWaitPercentage,
    rootWait: analysis.rootWait,
    longestEventWait: analysis.longestEventWait,
    wakeupChain: analysis.wakeupChain.slice(0, HARD_CAPS.segments).map((segment) => trimSegment(segment)),
    moduleBreakdown: analysis.moduleBreakdown.slice(0, 8),
    ruleAnomalies: analysis.anomalies.slice(0, 8),
    ruleRecommendations: analysis.recommendations.slice(0, 6),
    warnings: analysis.warnings.slice(0, HARD_CAPS.warnings),
    rawRows: analysis.rawRows,
    truncated: analysis.truncated,
    slices: analysis.slices?.slice(0, 6),
    directWaker: analysis.directWaker,
    quantification: analysis.quantification
      ? {
          counterfactual: analysis.quantification.counterfactual
            ? readCounterfactual(analysis.quantification.counterfactual)
            : null,
          frameImpacts: analysis.quantification.frameImpacts.slice(0, 4),
          hypotheses: analysis.quantification.hypotheses.slice(0, HARD_CAPS.hypotheses),
        }
      : undefined,
    semanticSources: analysis.semanticSources,
  };
}

function buildStructuredPrompt(
  analysis: CriticalPathAnalysis,
  question: string | undefined,
  outputLanguage: OutputLanguage,
): {prompt: string; redactionApplied: boolean} | undefined {
  const template = loadPromptTemplate(
    outputLanguage === 'en' ? 'prompt-critical-path-summary-en' : 'prompt-critical-path-summary-zh',
  );
  if (!template) return undefined;
  // The model reads the facts in the language it answers in.
  const compact = compactAnalysisForLLM(renderCriticalPathAnalysis(analysis, outputLanguage));
  const redacted = redactObjectForLLM(redactCriticalPathFields(compact));
  const prompt = renderTemplate(stripPromptComments(template), {
    factsJson: JSON.stringify(redacted.value).slice(0, 32_000),
    questionBlock: question
      ? localize(
          outputLanguage,
          `\n\n用户额外问题：${clampString(question, 500)}`,
          `\n\nAdditional user question: ${clampString(question, 500)}`,
        )
      : '',
  });
  return {prompt, redactionApplied: redacted.stats.applied};
}

/**
 * Optional model narrative over the deterministic analysis. Every path that
 * does not produce a model answer returns the deterministic summary with a
 * `fallbackReason` and a localized warning; this function never throws for
 * policy, permission, provider, or model failures.
 */
export async function summarizeCriticalPathWithAi(
  analysis: CriticalPathAnalysis,
  question?: string,
  outputLanguage: OutputLanguage = 'zh-CN',
  options: CriticalPathAiSummaryOptions = {},
): Promise<CriticalPathAiSummary> {
  return runOneShotSummary({
    feature: 'critical_path_ai_summary',
    label: {zh: '关键路径 AI 诊断', en: 'critical-path AI diagnosis'},
    logLabel: 'CriticalPathAI',
    outputLanguage,
    ruleSummary: () => buildDeterministicCriticalPathSummary(analysis, outputLanguage),
    buildPrompt: () => buildStructuredPrompt(analysis, question, outputLanguage),
    timeoutMs: Number.parseInt(process.env.CRITICAL_PATH_AI_TIMEOUT_MS || '60000', 10),
    aiPolicy: options.aiPolicy,
    aiPermitted: options.aiPermitted,
    signal: options.signal,
    providerScope: options.providerScope,
  });
}
