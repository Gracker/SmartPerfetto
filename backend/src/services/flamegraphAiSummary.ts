// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { type SDKMessage, type SDKResultSuccess, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv, hasClaudeCredentials, loadClaudeConfig } from '../agentv3/claudeConfig';
import { redactObjectForLLM } from '../utils/llmPrivacy';
import type { FlamegraphAiSummary, FlamegraphAnalysis } from './flamegraphTypes';

function pct(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSuccessfulResultMessage(message: SDKMessage): message is SDKResultSuccess {
  return message.type === 'result' && message.subtype === 'success';
}

export function buildDeterministicFlamegraphSummary(analysis: FlamegraphAnalysis): string {
  if (!analysis.available || analysis.filteredSampleCount === 0) {
    return [
      '这份 trace 里没有可用于火焰图的 CPU 调用栈采样，暂时不能判断热点函数。',
      analysis.warnings.length > 0 ? `补充信息：${analysis.warnings.slice(0, 3).join('；')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const topSelf = analysis.topFunctions.slice(0, 5);
  const topCumulative = analysis.topCumulativeFunctions.slice(0, 5);
  const topCategory = analysis.categoryBreakdown.find((item) => item.selfCount > 0);
  const hotPath = analysis.hotPaths[0];
  const topThread = analysis.threadBreakdown[0];
  const lines = [
    `这次火焰图共命中 ${analysis.filteredSampleCount} 个 CPU 采样，需要分开看“自占热点”和“累计调用链热点”。`,
  ];

  if (topSelf.length > 0) {
    lines.push(
      `自占最高的函数是：${topSelf.map((item) => `${item.name}（${item.categoryLabel}，自占 ${item.selfCount}，约 ${pct(item.selfPercentage)}）`).join('、')}。这些更接近“CPU 真正烧在函数自己身上”的位置。`
    );
  }
  if (topCumulative.length > 0) {
    lines.push(
      `累计最高的调用链节点是：${topCumulative.map((item) => `${item.name}（累计 ${item.sampleCount}，约 ${pct(item.cumulativePercentage)}）`).join('、')}。这些更适合用来往下展开追最热路径。`
    );
  }
  if (topCategory) {
    lines.push(
      `按归类看，${topCategory.label} 的自占采样最突出，占 ${pct(topCategory.percentage)}，可以先判断这是业务代码、Framework、Native 还是系统侧开销。`
    );
  }
  if (hotPath) {
    lines.push(`最热路径大致是：${hotPath.compressedFrames.join(' -> ')}，占 ${pct(hotPath.percentage)}。`);
  }
  if (topThread) {
    lines.push(
      `线程维度上，${topThread.processName}/${topThread.threadName} 最突出，占 ${pct(topThread.percentage)}。`
    );
  }
  lines.push(
    '建议优先从最高自占函数判断“谁在直接耗 CPU”，再从最高累计节点和最热路径判断“是谁把这条热路径调起来的”。如果热点落在业务代码，重点查循环、锁、IO、序列化或重复计算；如果落在 Framework/Native/Kernel，就向上追业务入口。'
  );

  if (analysis.warnings.length > 0) {
    lines.push(`注意：${analysis.warnings.slice(0, 3).join('；')}`);
  }

  return lines.join('\n');
}

function compactAnalysisForLLM(analysis: FlamegraphAnalysis): unknown {
  return {
    available: analysis.available,
    sampleCount: analysis.sampleCount,
    filteredSampleCount: analysis.filteredSampleCount,
    source: analysis.source,
    analyzer: analysis.analyzer,
    topFunctions: analysis.topFunctions.slice(0, 15),
    topCumulativeFunctions: analysis.topCumulativeFunctions.slice(0, 15),
    categoryBreakdown: analysis.categoryBreakdown.slice(0, 8),
    hotPaths: analysis.hotPaths.slice(0, 8).map((path) => ({
      ...path,
      frames: path.frames.slice(-12),
      compressedFrames: path.compressedFrames,
    })),
    threadBreakdown: analysis.threadBreakdown.slice(0, 10),
    warnings: analysis.warnings.slice(0, 10),
  };
}

export async function summarizeFlamegraphWithAi(
  analysis: FlamegraphAnalysis,
  question?: string
): Promise<FlamegraphAiSummary> {
  const fallback = buildDeterministicFlamegraphSummary(analysis);
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
    '你是 Android 性能分析专家，请基于下面的 Perfetto CPU 火焰图统计做中文解释。',
    '要求：',
    '1. 明确区分 self_count（函数自身耗 CPU）和 cumulative_count（调用链累计热度），不要混为一谈。',
    '2. 不要编造 trace 中没有的数据；如果证据不足，直接说证据不足。',
    '3. 输出结构：结论、证据、下一步排查建议。',
    '4. 结合 category/categoryLabel 判断热点更像业务代码、Android Framework、ART/JIT、Native、图形渲染、Kernel 还是未知符号。',
    '5. 重点解释“为什么这个火焰图值得关注”，而不是只复述数字。',
    question ? `用户问题：${question}` : '',
    `火焰图统计 JSON：${JSON.stringify(redacted.value)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const timeoutMs = Number.parseInt(process.env.FLAMEGRAPH_AI_TIMEOUT_MS || '60000', 10);
  const stream = sdkQuery({
    prompt,
    options: {
      model: config.model,
      maxTurns: 1,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: createSdkEnv(),
      stderr: (data: string) => {
        console.warn(`[FlamegraphAI] SDK stderr: ${data.trimEnd()}`);
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
      warnings: [`AI 总结失败，已返回规则兜底总结：${errorMessage(error)}`],
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
      warnings: [timedOut ? 'AI 总结超时，已返回规则兜底总结。' : 'AI 没有返回有效内容，已返回规则兜底总结。'],
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
