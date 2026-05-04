// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { type SDKMessage, type SDKResultSuccess, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv, hasClaudeCredentials, loadClaudeConfig } from '../agentv3/claudeConfig';
import { redactObjectForLLM } from '../utils/llmPrivacy';
import type { CriticalPathAnalysis } from './criticalPathAnalyzer';

export interface CriticalPathAiSummary {
  generated: boolean;
  model?: string;
  summary: string;
  warnings: string[];
  redactionApplied?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSuccessfulResultMessage(message: SDKMessage): message is SDKResultSuccess {
  return message.type === 'result' && message.subtype === 'success';
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
  if (analysis.anomalies.length > 0) {
    lines.push(`规则判断：${analysis.anomalies.slice(0, 3).map((item) => item.title).join('；')}。`);
  }
  if (analysis.recommendations.length > 0) {
    lines.push(`建议：${analysis.recommendations.slice(0, 2).join('；')}`);
  }

  return lines.filter((line) => line !== undefined).join('\n');
}

function compactAnalysisForLLM(analysis: CriticalPathAnalysis): unknown {
  return {
    available: analysis.available,
    task: analysis.task,
    totalMs: analysis.totalMs,
    blockingMs: analysis.blockingMs,
    selfMs: analysis.selfMs,
    externalBlockingPercentage: analysis.externalBlockingPercentage,
    wakeupChain: analysis.wakeupChain.slice(0, 24).map((segment) => ({
      startOffsetMs: segment.startOffsetMs,
      durationMs: segment.durationMs,
      processName: segment.processName,
      threadName: segment.threadName,
      state: segment.state,
      blockedFunction: segment.blockedFunction,
      ioWait: segment.ioWait,
      cpu: segment.cpu,
      slices: segment.slices.slice(0, 6),
      modules: segment.modules,
      reasons: segment.reasons.slice(0, 6),
    })),
    moduleBreakdown: analysis.moduleBreakdown.slice(0, 10),
    ruleAnomalies: analysis.anomalies.slice(0, 10),
    ruleRecommendations: analysis.recommendations.slice(0, 8),
    warnings: analysis.warnings.slice(0, 10),
    rawRows: analysis.rawRows,
    truncated: analysis.truncated,
  };
}

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
  const redacted = redactObjectForLLM(compactAnalysisForLLM(analysis));
  const prompt = [
    '你是 Android Perfetto 调度与渲染性能分析专家，请基于下面的 Critical Path 结构化事实做中文诊断。',
    '要求：',
    '1. 严格区分“Perfetto/SQL 事实”“基于事实的推断”“证据不足”。不要编造 trace 中没有的数据。',
    '2. 重点回答：唤醒链是否异常？异常与哪些线程、进程、模块、调度状态相关？最值得继续追哪里？',
    '3. 如果只是规则命中但证据薄弱，要明确说“证据不足以定性为根因”。',
    '4. 不要只复述数字，要解释这些数字对用户体验的影响，例如单帧预算、外部等待占比、Binder/IO/锁/调度竞争等。',
    '5. 输出结构固定为：结论、事实证据、推断与风险、下一步排查。',
    '6. Insight 内容必须使用中文。',
    question ? `用户问题：${question}` : '',
    `Critical Path JSON：${JSON.stringify(redacted.value)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

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
        /* ignore */
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
      /* ignore */
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
