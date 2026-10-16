// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Stage1 scene reconstruction verifier.
 *
 * The deterministic pass always runs and checks the reconstructed scene graph
 * itself. The LLM pass is optional and best-effort: it receives only a compact
 * evidence packet and never mutates scenes. This keeps Smart preview cheap and
 * reproducible while still giving us a hook for ambiguous vendor traces.
 */

import { claudeSdkQuery as sdkQuery } from '../../agentRuntime/engines/claude/claudeSdkQuery';
import { sceneStoryConfig } from '../../config';
import {createSdkEnv, loadClaudeConfig} from '../../agentv3/claudeConfig';
import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import {isolatedClaudeOneShotOptions} from '../../services/oneShotModelCall';
import type {
  DisplayedScene,
  SceneReconstructionVerification,
} from './types';

export interface Stage1VerifierInput {
  scenes: DisplayedScene[];
  traceDurationSec: number;
  traceBounds?: {startTs: string; endTs: string};
  inputCoverage?: Record<string, unknown>;
  enableLlm?: boolean;
}

export async function runSceneStage1Verifier(
  input: Stage1VerifierInput,
): Promise<SceneReconstructionVerification> {
  const deterministic = runDeterministicVerification(input);
  const shouldAskLlm =
    input.enableLlm === true &&
    sceneStoryConfig.llmVerify &&
    shouldRunLlmVerifier(deterministic);

  if (!shouldAskLlm) {
    return {
      ...deterministic,
      llm: {
        status: input.enableLlm === true && sceneStoryConfig.llmVerify ? 'not_needed' : 'skipped',
        summary: input.enableLlm === true && sceneStoryConfig.llmVerify
          ? '确定性复核未发现需要模型二次判断的高风险歧义。'
          : 'LLM 复核未启用；已完成确定性复核。',
      },
    };
  }

  const llm = await runLlmVerifier(input.scenes, deterministic);
  const status = llm.status === 'needs_review' || deterministic.status === 'needs_review'
    ? 'needs_review'
    : llm.status === 'failed' ? 'failed' : deterministic.status;
  return {
    ...deterministic,
    status,
    verifier: 'deterministic+llm',
    summary: deterministic.summary,
    llm,
  };
}

function runDeterministicVerification(input: Stage1VerifierInput): SceneReconstructionVerification {
  const {scenes, traceDurationSec, inputCoverage} = input;
  const issues: SceneReconstructionVerification['issues'] = [];
  const lowConfidenceSceneIds: string[] = [];
  const conflictSceneIds: string[] = [];
  const ids = new Set<string>();
  const allIds = new Set(scenes.map(scene => scene.id));
  const boundsStart = exactNs(input.traceBounds?.startTs);
  const boundsEnd = exactNs(input.traceBounds?.endTs);

  if (input.traceBounds && (boundsStart === null || boundsEnd === null || boundsEnd < boundsStart)) {
    issues.push({severity: 'bad', type: 'invalid_trace_bounds', message: 'Trace bounds are invalid.'});
  }

  for (const scene of scenes) {
    const start = exactNs(scene.startTs);
    const end = exactNs(scene.endTs);
    if (start === null || end === null || end < start || !Number.isFinite(scene.durationMs) || scene.durationMs < 0) {
      issues.push({severity: 'bad', sceneId: scene.id, type: 'invalid_timing', message: 'Scene time range is invalid.'});
    } else if (boundsStart !== null && boundsEnd !== null && (start < boundsStart || end > boundsEnd)) {
      issues.push({severity: 'bad', sceneId: scene.id, type: 'outside_trace_bounds', message: 'Scene extends outside the trace bounds.'});
    }
    if (ids.has(scene.id)) {
      issues.push({severity: 'bad', sceneId: scene.id, type: 'duplicate_scene_id', message: 'Scene identifier is not unique.'});
    }
    ids.add(scene.id);
    if (scene.parentSceneId && (scene.parentSceneId === scene.id || !allIds.has(scene.parentSceneId))) {
      issues.push({severity: 'warning', sceneId: scene.id, type: 'missing_parent_scene', message: 'Scene parent is missing or refers to itself.'});
    }
    const confidence = typeof scene.confidenceScore === 'number' ? scene.confidenceScore : 0;
    if (scene.confidenceScore !== undefined && (!Number.isFinite(confidence) || confidence < 0.65)) {
      lowConfidenceSceneIds.push(scene.id);
      issues.push({
        severity: 'warning',
        sceneId: scene.id,
        type: 'low_confidence',
        message: `${scene.sceneType} confidence ${confidence.toFixed(2)} is below Smart preview threshold.`,
      });
    }
    if ((scene.conflicts?.length ?? 0) > 0) {
      conflictSceneIds.push(scene.id);
      for (const conflict of scene.conflicts ?? []) {
        issues.push({
          severity: conflict.severity === 'bad' ? 'bad' : 'warning',
          sceneId: scene.id,
          type: conflict.type,
          message: conflict.message,
        });
      }
    }
    if (scene.sceneType === 'scroll_start' && !scene.parentSceneId) {
      issues.push({
        severity: 'warning',
        sceneId: scene.id,
        type: 'orphan_scroll_marker',
        message: 'scroll_start marker was not linked to an active scroll scene.',
      });
    }
    if (scene.sceneType === 'inertial_scroll' && !scene.parentSceneId) {
      issues.push({
        severity: 'info',
        sceneId: scene.id,
        type: 'unlinked_inertial_scroll',
        message: 'inertial_scroll was not linked to an active scroll scene.',
      });
    }
  }

  for (const sceneId of idleActivityConflicts(scenes)) {
    issues.push({severity: 'bad', sceneId, type: 'idle_overlaps_activity',
      message: 'Idle overlaps an observed input or launch interval.'});
  }
  if (inputCoverage) {
    if (Number(inputCoverage.missing_action_count) > 0 || Number(inputCoverage.missing_timestamp_count) > 0) {
      issues.push({severity: 'warning', type: 'input_semantics_missing',
        message: 'Some observed input events lack action or timestamp information.'});
    }
    if (Number(inputCoverage.output_truncated) > 0) {
      issues.push({severity: 'warning', type: 'input_output_truncated',
        message: 'Input extraction exceeded its output budget.'});
    }
    if (inputCoverage.source_status !== 'observed') {
      issues.push({severity: 'warning', type: 'input_coverage_partial',
        message: 'Input capture completeness is not established; gaps do not prove inactivity.'});
    }
  }

  if (scenes.length === 0 && traceDurationSec > 0) {
    issues.push({
      severity: 'warning',
      type: 'empty_timeline',
      message: 'No user-visible scenes were reconstructed from a non-empty trace.',
    });
  }

  const actionCount = scenes.filter(scene => scene.analysisEligible !== false && scene.sceneRole !== 'marker' && scene.sceneRole !== 'context').length;
  if (scenes.length > 0 && actionCount === 0) {
    issues.push({
      severity: 'warning',
      type: 'no_deep_dive_candidates',
      message: 'Timeline has scenes, but none are eligible for Smart deep dive.',
    });
  }

  const badIssueCount = issues.filter(issue => issue.severity === 'bad').length;
  const warningIssueCount = issues.filter(issue => issue.severity === 'warning').length;
  const status = badIssueCount > 0 || warningIssueCount > 0 ? 'needs_review' : 'passed';
  const summary = status === 'passed'
    ? `场景结构检查通过：${scenes.length} 个场景；原始证据与全程覆盖尚未核验。`
    : `场景结构检查发现 ${warningIssueCount} 个待核查项、${badIssueCount} 个冲突；原始证据尚未核验。`;

  return {
    status,
    scope: 'structure',
    evidenceStatus: 'not_checked',
    verifier: 'deterministic',
    summary,
    checkedSceneCount: scenes.length,
    lowConfidenceSceneIds,
    conflictSceneIds,
    issues,
  };
}

function exactNs(value: string | undefined): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= 9_223_372_036_854_775_807n ? parsed : null;
}

function idleActivityConflicts(scenes: DisplayedScene[]): string[] {
  const ranges = scenes.filter(scene =>
    (scene.sourceStepId === 'user_gestures' && scene.sceneType !== 'input_unknown') ||
    scene.sourceStepId === 'app_launches',
  ).flatMap(scene => {
    const start = exactNs(scene.startTs);
    const end = exactNs(scene.endTs);
    return start !== null && end !== null && end > start ? [{start, end}] : [];
  }).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      if (range.end > previous.end) previous.end = range.end;
    } else merged.push({...range});
  }
  return scenes.filter(scene => scene.sceneType === 'idle').flatMap(scene => {
    const start = exactNs(scene.startTs);
    const end = exactNs(scene.endTs);
    if (start === null || end === null || end <= start) return [];
    let left = 0;
    let right = merged.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (merged[mid].end <= start) left = mid + 1;
      else right = mid;
    }
    return left < merged.length && merged[left].start < end ? [scene.id] : [];
  });
}

function shouldRunLlmVerifier(result: SceneReconstructionVerification): boolean {
  if (result.status === 'failed') return false;
  if (result.issues.some(issue => issue.severity === 'bad')) return true;
  if (result.lowConfidenceSceneIds.length >= 2) return true;
  if (result.conflictSceneIds.length > 0) return true;
  if (result.issues.some(issue => issue.type === 'empty_timeline' || issue.type === 'no_deep_dive_candidates')) return true;
  return false;
}

async function runLlmVerifier(
  scenes: DisplayedScene[],
  deterministic: SceneReconstructionVerification,
): Promise<NonNullable<SceneReconstructionVerification['llm']>> {
  const prompt = buildVerifierPrompt(scenes, deterministic);
  if (!prompt) {
    return {
      status: 'skipped',
      summary: 'LLM 复核模板未注册；已保留确定性复核结果。',
    };
  }
  let stream: ReturnType<typeof sdkQuery> | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { stream?.close(); } catch { /* ignore */ }
  }, sceneStoryConfig.llmVerifyTimeoutMs);

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
          console.warn(`[SceneStage1Verifier] SDK stderr: ${data.trimEnd()}`);
        },
      }),
    });

    let raw = '';
    for await (const msg of stream) {
      if (timedOut) break;
      if ((msg as any).type === 'result' && (msg as any).subtype === 'success') {
        raw = (msg as any).result || '';
      }
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return { status: timedOut ? 'failed' : 'skipped', error: timedOut ? 'LLM verifier timed out' : 'LLM verifier returned empty output' };
    }
    const parsed = parseVerifierJson(trimmed);
    return {
      status: parsed.status,
      summary: parsed.summary,
      raw: trimmed,
    };
  } catch (error: any) {
    return {
      status: 'failed',
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
    try { stream?.close(); } catch { /* ignore */ }
  }
}

function buildVerifierPrompt(
  scenes: DisplayedScene[],
  deterministic: SceneReconstructionVerification,
): string | undefined {
  const template = loadPromptTemplate('scene-reconstruction-verifier');
  if (!template) return undefined;

  const sceneLines = scenes.slice(0, 80).map((scene, index) => {
    const children = scene.childSceneIds?.length ? ` children=${scene.childSceneIds.join(',')}` : '';
    const parent = scene.parentSceneId ? ` parent=${scene.parentSceneId}` : '';
    const conflicts = scene.conflicts?.length ? ` conflicts=${scene.conflicts.map(c => c.type).join(',')}` : '';
    return [
      `${index + 1}. id=${scene.id}`,
      `type=${scene.sceneType}`,
      `role=${scene.sceneRole ?? 'action'}`,
      `eligible=${scene.analysisEligible !== false}`,
      `confidence=${scene.confidenceScore ?? 'unknown'}`,
      `range=${scene.startTs}-${scene.endTs}`,
      `durMs=${scene.durationMs}`,
      `app=${scene.processName ?? 'unknown'}`,
      `source=${scene.sourceStepId}`,
      `${parent}${children}${conflicts}`,
    ].join(' ');
  });

  const issueLines = deterministic.issues.slice(0, 30).map(issue =>
    `- ${issue.severity} ${issue.type}${issue.sceneId ? ` scene=${issue.sceneId}` : ''}: ${issue.message}`,
  );

  return renderTemplate(template, {
    deterministicSummary: deterministic.summary,
    deterministicIssues: issueLines.join('\n') || '- none',
    scenes: sceneLines.join('\n') || '- none',
  });
}

export function parseVerifierJson(raw: string): { status: 'passed' | 'needs_review' | 'failed'; summary: string } {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).some(key => key !== 'status' && key !== 'summary') ||
      (parsed.status !== 'passed' && parsed.status !== 'needs_review') ||
      typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('Invalid verifier response');
    return {status: parsed.status, summary: parsed.summary.trim()};
  } catch {
    return {status: 'failed', summary: 'LLM 复核响应不符合约定，未获得有效复核结果。'};
  }
}
