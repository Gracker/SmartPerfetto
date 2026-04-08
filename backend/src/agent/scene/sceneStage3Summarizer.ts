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
import { createSdkEnv } from '../../agentv3/claudeConfig';
import {
  DisplayedScene,
  SceneAnalysisJob,
} from './types';

export interface Stage3SummaryInput {
  scenes: DisplayedScene[];
  jobs: SceneAnalysisJob[];
}

const HAIKU_MODEL = 'claude-haiku-4-5';
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
        model: HAIKU_MODEL,
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
    '你是 Android 性能分析助手。给定以下 Trace 中检测到的场景列表和已完成的深度分析结果,',
    '用 200 字以内的中文写一段整体叙述,概括这段 Trace 里发生了什么、有哪些值得关注的性能问题。',
    '不要逐项罗列,要有重点;不要复述数字,要解释含义。',
    '',
    `## 场景列表 (共 ${input.scenes.length} 个,显示前 ${sceneLines.length}):`,
    ...sceneLines,
    '',
    analysisLines.length > 0 ? '## 已完成的深度分析:' : '## 深度分析:无',
    ...analysisLines,
    '',
    failedCount > 0 ? `注意:${failedCount} 个场景的分析失败,可能影响完整性。` : '',
    '',
    '只输出叙述文字,不要加 markdown 标题、列表或代码块。',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

function formatSceneLine(scene: DisplayedScene, index: number): string {
  const sev = sevLabel(scene.severity);
  return `${index + 1}. ${sev} ${scene.label} [${scene.sceneType}] @ ${scene.processName ?? 'unknown'}`;
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
