// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {type SDKMessage, type SDKResultSuccess, query as sdkQuery} from '@anthropic-ai/claude-agent-sdk';
import {createSdkEnv, hasClaudeCredentials, loadClaudeConfig} from '../agentv3/claudeConfig';
import {redactObjectForLLM} from '../utils/llmPrivacy';
import type {CriticalPathAnalysis} from './criticalPathAnalyzer';

export interface CriticalPathAiSummary {
  generated: boolean;
  model?: string;
  summary: string;
  warnings: string[];
  redactionApplied?: boolean;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSuccessfulResultMessage(message: SDKMessage): message is SDKResultSuccess {
  return message.type === 'result' && message.subtype === 'success';
}

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
        lk === 'path'
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

export function buildDeterministicCriticalPathSummary(analysis: CriticalPathAnalysis): string {
  const lines = [
    analysis.summary,
    '',
    '事实来源：Perfetto sched.thread_executing_span_with_slice / _critical_path_stack。',
    `选中 task：${analysis.task.processName ?? '-'} / ${analysis.task.threadName ?? '-'}，${analysis.totalMs.toFixed(2)} ms。`,
    `外部 critical path：${analysis.blockingMs.toFixed(2)} ms，占 ${analysis.externalBlockingPercentage.toFixed(2)}%。`,
  ];

  if (analysis.moduleBreakdown.length > 0) {
    lines.push(
      `主要模块：${analysis.moduleBreakdown
        .slice(0, 4)
        .map((item) => `${item.module} ${item.durationMs.toFixed(2)} ms`)
        .join('、')}。`
    );
  }
  if (analysis.directWaker?.kind && analysis.directWaker.kind !== 'unknown') {
    lines.push(
      `直接唤醒来源：${analysis.directWaker.kind}${
        analysis.directWaker.threadName ? ` (${analysis.directWaker.threadName})` : ''
      }${analysis.directWaker.irqContext ? '，IRQ 上下文' : ''}。`
    );
  }
  if (analysis.quantification?.counterfactual) {
    lines.push(
      `反事实上界：消除最长外部段（${analysis.quantification.counterfactual.longestSegmentDurMs.toFixed(2)} ms）后任务时长上界 ${analysis.quantification.counterfactual.upperBoundMs.toFixed(2)} ms（仅上界估算，可能因次长段成为新瓶颈而无法达到）。`
    );
  }
  if (analysis.anomalies.length > 0) {
    lines.push(`规则判断：${analysis.anomalies.slice(0, 3).map((item) => item.title).join('；')}。`);
  }
  if (analysis.recommendations.length > 0) {
    lines.push(`建议：${analysis.recommendations.slice(0, 2).join('；')}`);
  }

  return lines.filter((line) => line !== undefined).join('\n');
}

interface TrimmedSegment {
  startOffsetMs: number;
  durationMs: number;
  threadName: string | null | undefined;
  processName: string | null | undefined;
  state: string | null | undefined;
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
    blockedFunction: segment.blockedFunction,
    cpu: segment.cpu,
    ioWait: segment.ioWait,
    modules: segment.modules,
    reasons: segment.reasons.slice(0, 6),
    semantics: segment.semantics
      ? {
          sources: segment.semantics.sources,
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
          counterfactual: analysis.quantification.counterfactual,
          frameImpacts: analysis.quantification.frameImpacts.slice(0, 4),
          hypotheses: analysis.quantification.hypotheses.slice(0, HARD_CAPS.hypotheses),
        }
      : undefined,
    semanticSources: analysis.semanticSources,
  };
}

const STRUCTURED_PROMPT_TEMPLATE = `你是 Android Perfetto 调度与渲染性能分析专家。下面是一份针对选中 task 的结构化 critical path 分析事实（已脱敏）。请严格按照以下 5 段输出，每段一个段落，无前置废话。

# 1. 等什么 [evidence_strength]
基于 L1 task state（S/D/R/Running）和 L3 语义信号（binder/monitor/io/gc/cpu_competition）说明这一段在等什么类型的资源。如果信号矛盾或薄弱，标【弱证据】或【证据不足】。

# 2. 谁唤醒 / 为什么 [evidence_strength]
基于 directWaker（kind=irq/swapper/thread）+ wakeupChain 上的递归子链（children）说明：直接唤醒来自哪里，以及该唤醒方在被唤醒前自己当时在做什么。如果是 IRQ/swapper 终止，明确说明无更上游链路可追。

# 3. 链路语义 [evidence_strength]
基于 semantics.binderTxns / monitorContention / ioSignals / gcEvents / cpuCompetition 给出**具体**的语义事件（method 名已 base64 脱敏，请按 ID 引用），并说明每条事件如何叠加形成总等待。

# 4. 量化影响 [evidence_strength]
基于 quantification.counterfactual + frameImpacts：消除最长段的反事实上界、是否覆盖某帧 deadline。**明确表述 counterfactual 是上界而非确定预测**。

# 5. 可证伪假设 + SQL [evidence_strength]
基于 quantification.hypotheses 列出最多 3 条假设，每条用一句话陈述 + 注明 strength + 给出 verificationSql（直接复用，不要改字符串）。

规则：
- 每段必须以【强证据】/【弱证据】/【证据不足】开头标注 evidence_strength。
- 禁止编造未在 JSON 中出现的数据。
- 禁止把 base64 脱敏标记还原为可读名字（如 <method_name_xxxx>），保持原样引用。
- 全文中文，专业语气，每段 ≤ 4 句话。

事实 JSON：
{{JSON}}
{{QUESTION_BLOCK}}`;

export async function summarizeCriticalPathWithAi(
  analysis: CriticalPathAnalysis,
  question?: string
): Promise<CriticalPathAiSummary> {
  const fallback = buildDeterministicCriticalPathSummary(analysis);
  if (!hasClaudeCredentials()) {
    return {
      generated: false,
      summary: fallback,
      warnings: ['AI 模型未配置，已返回规则兜底总结。'],
    };
  }

  const config = loadClaudeConfig();
  const compact = compactAnalysisForLLM(analysis);
  const customRedacted = redactCriticalPathFields(compact);
  const redacted = redactObjectForLLM(customRedacted);

  const prompt = STRUCTURED_PROMPT_TEMPLATE.replace(
    '{{JSON}}',
    JSON.stringify(redacted.value).slice(0, 32_000)
  ).replace('{{QUESTION_BLOCK}}', question ? `\n\n用户额外问题：${clampString(question, 500)}` : '');

  const timeoutMs = Number.parseInt(process.env.CRITICAL_PATH_AI_TIMEOUT_MS || '60000', 10);
  const stream = sdkQuery({
    prompt,
    options: {
      model: config.model,
      maxTurns: 1,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: createSdkEnv(),
      stderr: (data: string) => {
        console.warn(`[CriticalPathAI] SDK stderr: ${data.trimEnd()}`);
      },
    },
  });

  let result = '';
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      try {
        stream.close();
      } catch {
        // ignore
      }
    },
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000
  );

  try {
    for await (const message of stream) {
      if (timedOut) break;
      if (isSuccessfulResultMessage(message)) {
        result = message.result || '';
      }
    }
  } catch (error: unknown) {
    return {
      generated: false,
      model: config.model,
      summary: fallback,
      warnings: [`AI 诊断失败，已返回规则兜底总结：${errorMessage(error)}`],
      redactionApplied: redacted.stats.applied,
    };
  } finally {
    clearTimeout(timer);
    try {
      stream.close();
    } catch {
      // ignore
    }
  }

  if (timedOut || !result.trim()) {
    return {
      generated: false,
      model: config.model,
      summary: fallback,
      warnings: [timedOut ? 'AI 诊断超时，已返回规则兜底总结。' : 'AI 没有返回有效内容，已返回规则兜底总结。'],
      redactionApplied: redacted.stats.applied,
    };
  }

  return {
    generated: true,
    model: config.model,
    summary: result.trim(),
    warnings: [],
    redactionApplied: redacted.stats.applied,
  };
}

// Exported for tests.
export const __INTERNAL__ = {
  redactCriticalPathFields,
  HARD_CAPS,
  STRUCTURED_PROMPT_TEMPLATE,
};
