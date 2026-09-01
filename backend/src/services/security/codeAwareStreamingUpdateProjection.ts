// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {StreamingUpdate} from '../../agent/types';
import type {VerificationIssue} from '../../agentv3/types';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import {localize} from '../../agentv3/outputLanguage';
import {sanitizeCodeAwareText} from './codeAwareOutputRegistry';
import {projectPrivateDataEnvelope} from './privateAnalysisProjection';
import {validateDataEnvelope} from '../../types/dataContract';

type PrivateEventPolicy =
  | 'deterministic'
  | 'suppress'
  | 'answer'
  | 'conclusion'
  | 'source_supplement'
  | 'error';

const PRIVATE_EVENT_POLICIES: Record<StreamingUpdate['type'], PrivateEventPolicy> = {
  data: 'deterministic',
  scene_detected: 'deterministic',
  track_data: 'deterministic',
  architecture_detected: 'deterministic',
  answer_token: 'answer',
  conclusion: 'conclusion',
  error: 'error',
  thought: 'suppress',
  worker_thought: 'suppress',
  tool_call: 'suppress',
  finding: 'suppress',
  progress: 'suppress',
  skill_layered_result: 'suppress',
  skill_data: 'suppress',
  conversation_step: 'suppress',
  hypothesis_generated: 'suppress',
  agent_task_dispatched: 'suppress',
  agent_dialogue: 'suppress',
  agent_response: 'suppress',
  round_start: 'suppress',
  synthesis_complete: 'suppress',
  strategy_decision: 'suppress',
  degraded: 'suppress',
  stage_transition: 'suppress',
  circuit_breaker: 'suppress',
  strategy_selected: 'suppress',
  strategy_fallback: 'suppress',
  sql_generated: 'suppress',
  sql_validation_failed: 'suppress',
  focus_updated: 'suppress',
  incremental_scope: 'suppress',
  sub_agent_started: 'suppress',
  sub_agent_completed: 'suppress',
  plan_submitted: 'suppress',
  plan_phase_updated: 'suppress',
  plan_revised: 'suppress',
  scene_story_detected: 'suppress',
  scene_story_selection_ready: 'suppress',
  scene_story_queued: 'suppress',
  scene_story_started: 'suppress',
  scene_story_retrying: 'suppress',
  scene_story_completed: 'suppress',
  scene_story_failed: 'suppress',
  scene_story_cancelled: 'suppress',
  scene_story_dropped: 'suppress',
  scene_story_report_ready: 'suppress',
  scene_story_smart_eta_refined: 'suppress',
  analysis_source_enrichment_started: 'deterministic',
  analysis_source_enrichment_completed: 'source_supplement',
  analysis_source_enrichment_failed: 'deterministic',
  analysis_source_enrichment_cancelled: 'deterministic',
};

function privateDegradedFallback(
  sourceType: StreamingUpdate['type'],
  content: StreamingUpdate['content'],
): string | undefined {
  if (sourceType !== 'degraded' || !content || typeof content !== 'object' || Array.isArray(content)) {
    return undefined;
  }
  const fallback = (content as Record<string, unknown>).fallback;
  return typeof fallback === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(fallback)
    ? fallback
    : undefined;
}

const PRIVATE_SAFE_VERIFICATION_ISSUE_TYPES = new Set<VerificationIssue['type']>([
  'missing_evidence',
  'too_many_criticals',
  'known_misdiagnosis',
  'severity_mismatch',
  'missing_check',
  'plan_deviation',
  'missing_reasoning',
  'unresolved_hypothesis',
  'truncation',
]);

function privateDegradedIssueType(
  sourceType: StreamingUpdate['type'],
  content: StreamingUpdate['content'],
): VerificationIssue['type'] | undefined {
  if (sourceType !== 'degraded' || !content || typeof content !== 'object' || Array.isArray(content)) {
    return undefined;
  }
  const issueType = (content as Record<string, unknown>).verificationIssueType;
  return typeof issueType === 'string' &&
    PRIVATE_SAFE_VERIFICATION_ISSUE_TYPES.has(issueType as VerificationIssue['type'])
    ? issueType as VerificationIssue['type']
    : undefined;
}

function privateProgress(
  language: OutputLanguage,
  sourceType: StreamingUpdate['type'],
  sourceContent?: StreamingUpdate['content'],
): StreamingUpdate['content'] {
  const degradedFallback = privateDegradedFallback(sourceType, sourceContent);
  const degradedIssueType = privateDegradedIssueType(sourceType, sourceContent);
  return {
    phase: sourceType,
    message: localize(
      language,
      '正在基于已授权的源码与知识源分析；中间模型内容已按隐私策略隐藏。',
      'Analyzing authorized source and knowledge context; intermediate model content is hidden by the privacy policy.',
    ),
    privateModelTextSuppressed: true,
    sourceEventType: sourceType,
    ...(degradedFallback ? {degradedFallback} : {}),
    ...(degradedIssueType ? {degradedIssueType} : {}),
  };
}

/**
 * Last application-boundary defense before runtime events reach logs, SSE,
 * replay buffers, or CLI renderers. Provider prose is intentionally suppressed
 * for source-aware sessions; the verified final result is projected separately.
 */
export function projectCodeAwareStreamingUpdate(
  sessionId: string,
  update: StreamingUpdate,
  sourceAware: boolean,
  language: OutputLanguage,
): StreamingUpdate {
  if (!sourceAware) return update;

  const policy = PRIVATE_EVENT_POLICIES[update.type] ?? 'suppress';
  if (policy === 'deterministic') {
    if (update.type !== 'data') return update;
    const envelopes = Array.isArray(update.content) ? update.content : [update.content];
    if (envelopes.every(envelope => validateDataEnvelope(envelope).length === 0)) {
      const projected = envelopes.map(envelope => projectPrivateDataEnvelope(sessionId, envelope));
      return {
        ...update,
        content: Array.isArray(update.content) ? projected : projected[0],
      };
    }
    return {...update, type: 'progress', content: privateProgress(language, update.type)};
  }
  if (policy === 'answer') {
    return {
      ...update,
      content: {suppressed: true},
    };
  }
  if (policy === 'suppress') {
    return {
      ...update,
      type: 'progress',
      content: privateProgress(language, update.type, update.content),
    };
  }
  if (policy === 'error') {
    return {
      ...update,
      content: {
        phase: 'error',
        message: localize(
          language,
          '分析过程中发生错误；详细模型或工具文本已按隐私策略隐藏。',
          'An analysis error occurred; detailed model or tool text is hidden by the privacy policy.',
        ),
        privateModelTextSuppressed: true,
      },
    };
  }
  if (policy === 'conclusion') {
    const content = update.content && typeof update.content === 'object'
      ? update.content as Record<string, unknown>
      : {};
    const conclusion = typeof content.conclusion === 'string'
      ? sanitizeCodeAwareText(sessionId, content.conclusion)
      : undefined;
    return {
      ...update,
      content: {
        ...(conclusion !== undefined ? {conclusion} : {}),
        ...(typeof content.success === 'boolean' ? {success: content.success} : {}),
        ...(typeof content.partial === 'boolean' ? {partial: content.partial} : {}),
        ...(typeof content.confidence === 'number' && Number.isFinite(content.confidence)
          ? {confidence: content.confidence}
          : {}),
      },
    };
  }
  if (policy === 'source_supplement') {
    const content = update.content && typeof update.content === 'object'
      ? update.content as Record<string, unknown>
      : {};
    const metrics = content.metrics && typeof content.metrics === 'object'
      ? content.metrics as Record<string, unknown>
      : {};
    const safeMetric = (key: string): number | undefined => {
      const value = metrics[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    };
    const searchCalls = safeMetric('searchCalls');
    const readCalls = safeMetric('readCalls');
    const durationMs = safeMetric('durationMs');
    return {
      ...update,
      content: {
        ...(typeof content.message === 'string'
          ? {message: sanitizeCodeAwareText(sessionId, content.message)}
          : {}),
        metrics: {
          ...(searchCalls !== undefined ? {searchCalls} : {}),
          ...(readCalls !== undefined ? {readCalls} : {}),
          ...(durationMs !== undefined ? {durationMs} : {}),
        },
      },
    };
  }
  return {...update, type: 'progress', content: privateProgress(language, update.type)};
}
