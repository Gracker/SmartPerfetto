// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AnalysisTerminationReason } from '../agent/core/orchestratorTypes';

export const SDK_MAX_TURNS_SUBTYPE = 'error_max_turns';
export const MAX_TURNS_TERMINATION_REASON: AnalysisTerminationReason = 'max_turns';

export type AnalysisModeLabel = 'fast' | 'full';

export function isSdkMaxTurnsSubtype(subtype: unknown): boolean {
  return subtype === SDK_MAX_TURNS_SUBTYPE;
}

export function buildMaxTurnsTerminationMessage(input: {
  mode: AnalysisModeLabel;
  turns?: number;
  maxTurns?: number;
}): string {
  const modeLabel = input.mode === 'fast' ? '快速模式' : '完整模式';
  const turns = formatPositiveInteger(input.turns);
  const maxTurns = formatPositiveInteger(input.maxTurns);
  const turnText = turns && maxTurns
    ? `（${turns}/${maxTurns} turns）`
    : turns
      ? `（${turns} turns）`
      : '';

  return `${modeLabel}达到轮次上限${turnText}，结果基于已收集证据生成，可能不完整。`;
}

export function prependPartialNotice(conclusion: string, message: string): string {
  const trimmed = conclusion.trim();
  if (!trimmed) return '';
  if (trimmed.includes('达到轮次上限') || trimmed.includes('可能不完整')) {
    return trimmed;
  }
  return `> 注意: ${message}\n\n${trimmed}`;
}

export function buildMaxTurnsFallbackConclusion(input: {
  mode: AnalysisModeLabel;
  turns?: number;
  maxTurns?: number;
}): string {
  const message = buildMaxTurnsTerminationMessage(input);
  const maxTurnsEnv = input.mode === 'fast' ? 'CLAUDE_QUICK_MAX_TURNS' : 'CLAUDE_MAX_TURNS';
  const modeHint = input.mode === 'fast'
    ? '如果这是复杂性能问题，建议切换到 full 模式重新分析。'
    : '如果该 trace 需要更深的多轮推理，可以提高完整模式轮次上限后重试。';

  return [
    '## 分析未完整完成',
    '',
    message,
    '',
    '## 当前状态',
    '',
    '- SDK 在输出完整结论前停止，本次没有拿到可确认的最终报告。',
    '- 已收集的中间工具结果仍会保留在会话和报告中。',
    '',
    '## 建议',
    '',
    `- ${modeHint}`,
    `- 如需保留当前模式，可通过 \`${maxTurnsEnv}\` 提高轮次上限。`,
  ].join('\n');
}

export function capPartialConfidence(confidence: number, hasFindings: boolean): number {
  const safeConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence))
    : 0;
  const cap = hasFindings ? 0.55 : 0.25;
  return Math.min(safeConfidence, cap);
}

function formatPositiveInteger(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return String(Math.floor(value));
}
