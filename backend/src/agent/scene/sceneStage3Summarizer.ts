// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * sceneStage3Summarizer — generates the cross-scene narrative summary that
 * lands on SceneReport.summary.
 *
 * Implementation note: a single non-streaming Haiku call. We deliberately
 * do not use the runtime's retry-wrapped sdkQuery: Stage 3 is best-effort,
 * a transient API error should fall through to summary=null rather than
 * delay the rest of the pipeline. The same SDK options as
 * claudeVerifier.ts:782 are used so this Haiku call is interchangeable
 * with the verification call from a quota / behaviour perspective.
 *
 * Returns null on any error so the caller can persist a partial report
 * without aborting the pipeline.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv, loadClaudeConfig } from '../../agentv3/claudeConfig';
import {
  DisplayedScene,
  SceneAnalysisJob,
} from './types';

export interface Stage3SummaryInput {
  scenes: DisplayedScene[];
  jobs: SceneAnalysisJob[];
}

const HAIKU_TIMEOUT_MS = 60_000;

/**
 * Generate a Chinese narrative summary of a scene story run.
 * Returns null on any failure (Haiku error / timeout / empty response).
 */
export async function runStage3Summary(
  input: Stage3SummaryInput,
): Promise<string | null> {
  if (input.scenes.length === 0) return null;

  const prompt = buildPrompt(input);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HAIKU_TIMEOUT_MS);

  try {
    const stream = sdkQuery({
      prompt,
      options: {
        model: loadClaudeConfig().lightModel,
        maxTurns: 1,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        env: createSdkEnv(),
        stderr: (data: string) => {
          console.warn(`[SceneStage3Summarizer] SDK stderr: ${data.trimEnd()}`);
        },
      },
    });

    let result = '';
    for await (const msg of stream) {
      if (ac.signal.aborted) break;
      if ((msg as any).type === 'result' && (msg as any).subtype === 'success') {
        result = (msg as any).result || '';
      }
    }

    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    console.warn(
      '[SceneStage3Summarizer] Haiku summary failed (graceful degradation):',
      (err as Error)?.message ?? err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(input: Stage3SummaryInput): string {
  const sceneLines = input.scenes
    .slice(0, 30)
    .map((s, i) => formatSceneLine(s, i));

  const analysisLines = input.jobs
    .filter((j) => j.state === 'completed' && j.result)
    .slice(0, 10)
    .map((j) => formatAnalysisLine(j));

  const failedCount = input.jobs.filter((j) => j.state === 'failed').length;

  return [
    '你是一个还原用户手机操作过程的助手。请根据下面按时间排列的场景列表,',
    '用第三人称视角写一段 200 字以内的中文叙述,像讲故事一样还原用户从头到尾在手机上做了什么。',
    '',
    '要求:',
    '- 从用户视角描述,比如"用户在桌面停留了片刻,然后点击图标启动了某应用"',
    '- 按时间顺序串联场景,交代因果关系(点击→启动→进入应用→操作→返回)',
    '- 自然地融入性能观感,例如"启动较慢,用户等待了约1.3秒"、"滑动流畅无卡顿"',
    '- 用应用名的可读部分(如 launch.aosp.heavy 而非完整包名)让叙述简洁',
    '- 不要罗列数据表格,不要加 markdown 标题/列表/代码块,只输出连贯叙述',
    '',
    `## 操作时间线 (共 ${input.scenes.length} 个场景):`,
    ...sceneLines,
    '',
    analysisLines.length > 0 ? '## 深度分析发现的性能问题:' : '',
    ...analysisLines,
    failedCount > 0 ? `(${failedCount} 个场景分析失败)` : '',
  ]
    .filter((l) => l !== undefined && l !== '')
    .join('\n');
}

function formatSceneLine(scene: DisplayedScene, index: number): string {
  const sev = sevLabel(scene.severity);
  const app = shortAppName(scene.processName ?? 'unknown');
  const durStr = scene.durationMs >= 1000
    ? `${(scene.durationMs / 1000).toFixed(1)}s`
    : `${Math.round(scene.durationMs)}ms`;
  return `${index + 1}. ${sev} [${scene.sceneType}] ${app} (${durStr})`;
}

/** Extract readable app name: com.example.launch.aosp.heavy → launch.aosp.heavy */
function shortAppName(processName: string): string {
  return processName
    .replace(/^com\.(android\.|miui\.|example\.)?/, '')
    .replace(/^org\./, '');
}

function formatAnalysisLine(job: SceneAnalysisJob): string {
  const result = job.result;
  if (!result) return '';
  const summary = summarizeDisplayResults(result.displayResults);
  return `- ${job.interval.skillId} (job ${job.jobId}): ${summary}`;
}

function summarizeDisplayResults(displayResults: unknown[]): string {
  if (!Array.isArray(displayResults) || displayResults.length === 0) {
    return '无数据';
  }
  const titles = displayResults
    .map((dr: any) => dr?.title || dr?.stepId)
    .filter(Boolean)
    .slice(0, 5);
  return titles.length > 0
    ? `${displayResults.length} 个步骤 (${titles.join(', ')})`
    : `${displayResults.length} 个步骤`;
}

function sevLabel(severity: DisplayedScene['severity']): string {
  switch (severity) {
    case 'bad': return '🔴';
    case 'warning': return '🟡';
    case 'good': return '🟢';
    default: return '⚪';
  }
}
