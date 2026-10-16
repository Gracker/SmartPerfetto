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

import { claudeSdkQuery as sdkQuery } from '../../agentRuntime/engines/claude/claudeSdkQuery';
import {createSdkEnv, loadClaudeConfig} from '../../agentv3/claudeConfig';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {isolatedClaudeOneShotOptions} from '../../services/oneShotModelCall';
import {
  DisplayedScene,
  SceneAnalysisJob,
} from './types';

export interface Stage3SummaryInput {
  scenes: DisplayedScene[];
  jobs: SceneAnalysisJob[];
}

export interface Stage3LocalizedSummaries {
  'zh-CN': string;
  en: string;
}

const HAIKU_TIMEOUT_MS = 60_000;
const MAX_STAGE3_JSON_BYTES = 8 * 1024;
const MAX_STAGE3_FIELD_BYTES = 4 * 1024;
const MAX_STAGE3_ZH_CODE_POINTS = 200;
const MAX_STAGE3_EN_WORDS = 140;

/**
 * Generate both locale projections in one call so a language-neutral cache
 * never reuses the first caller's narrative for another locale.
 * Returns null on any failure (Haiku error / timeout / empty response).
 */
export async function runStage3Summary(
  input: Stage3SummaryInput,
): Promise<Stage3LocalizedSummaries | null> {
  if (input.scenes.length === 0) return null;

  const prompt = buildStage3Prompt(input);
  if (!prompt) return null;

  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn(`[SceneStage3Summarizer] Summary timed out after ${HAIKU_TIMEOUT_MS / 1000}s`);
    try { stream?.close(); } catch { /* ignore */ }
  }, HAIKU_TIMEOUT_MS);

  try {
    const sdkEnv = createSdkEnv();
    stream = sdkQuery({
      prompt,
      // Trace-derived text is untrusted model input: the shared one-shot
      // isolation (no tools, MCP, settings, skills, plugins or transcript).
      options: isolatedClaudeOneShotOptions({
        model: loadClaudeConfig().lightModel,
        env: sdkEnv,
        stderr: (data: string) => {
          console.warn(`[SceneStage3Summarizer] SDK stderr: ${data.trimEnd()}`);
        },
      }),
    });

    let result = '';
    for await (const msg of stream) {
      if (timedOut) break;
      if ((msg as any).type === 'result' && (msg as any).subtype === 'success') {
        result = (msg as any).result || '';
      }
    }

    return parseStage3Summaries(result);
  } catch (err) {
    console.warn(
      '[SceneStage3Summarizer] Haiku summary failed (graceful degradation):',
      (err as Error)?.message ?? err,
    );
    return null;
  } finally {
    clearTimeout(timer);
    try { stream?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildStage3Prompt(input: Stage3SummaryInput): string | null {
  const template = loadPromptTemplate('prompt-scene-stage3-summary');
  if (!template) {
    console.warn('[SceneStage3Summarizer] Missing prompt-scene-stage3-summary template');
    return null;
  }
  const sceneLines = input.scenes
    .slice(0, 30)
    .map((s, i) => formatSceneLine(s, i));

  const analysisLines = input.jobs
    .filter((j) => j.state === 'completed' && j.result)
    .slice(0, 10)
    .map((j) => formatAnalysisLine(j));

  const failedCount = input.jobs.filter((j) => j.state === 'failed').length;

  return renderTemplate(template, {
    sceneCount: input.scenes.length,
    sceneLines: sceneLines.join('\n'),
    analysisLines: analysisLines.length > 0 ? analysisLines.join('\n') : 'none',
    failedCount,
  });
}

export function parseStage3Summaries(value: string): Stage3LocalizedSummaries | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const jsonText = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (Buffer.byteLength(jsonText, 'utf8') > MAX_STAGE3_JSON_BYTES) return null;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    if (
      keys.length !== 2 ||
      !Object.prototype.hasOwnProperty.call(parsed, 'zh-CN') ||
      !Object.prototype.hasOwnProperty.call(parsed, 'en')
    ) {
      return null;
    }
    const summaries = parsed as Partial<Stage3LocalizedSummaries>;
    const zh = typeof summaries['zh-CN'] === 'string' ? summaries['zh-CN'].trim() : '';
    const en = typeof summaries.en === 'string' ? summaries.en.trim() : '';
    if (!zh || !en) return null;
    if (
      Buffer.byteLength(zh, 'utf8') > MAX_STAGE3_FIELD_BYTES ||
      Buffer.byteLength(en, 'utf8') > MAX_STAGE3_FIELD_BYTES ||
      Array.from(zh).length > MAX_STAGE3_ZH_CODE_POINTS ||
      en.split(/\s+/u).length > MAX_STAGE3_EN_WORDS
    ) {
      return null;
    }
    return {'zh-CN': zh, en};
  } catch {
    return null;
  }
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
    return 'no_data';
  }
  const titles = displayResults
    .map((dr: any) => dr?.title || dr?.stepId)
    .filter(Boolean)
    .slice(0, 5);
  return titles.length > 0
    ? `${displayResults.length} steps (${titles.join(', ')})`
    : `${displayResults.length} steps`;
}

function sevLabel(severity: DisplayedScene['severity']): string {
  switch (severity) {
    case 'bad': return '🔴';
    case 'warning': return '🟡';
    case 'good': return '🟢';
    default: return '⚪';
  }
}
