// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {StreamingUpdate} from '../../agent/types';
import type {VerificationIssue} from '../../agentv3/types';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import {localize} from '../../agentv3/outputLanguage';
import {
  sanitizeCodeAwareStructuredText,
  sanitizeCodeAwareStructuredTextWithReceipt,
  sanitizeCodeAwareText,
  withOwnerCodeAwareProjection,
} from './codeAwareOutputRegistry';
import {projectPrivateDataEnvelope} from './privateAnalysisProjection';
import {validateDataEnvelope} from '../../types/dataContract';
import {isPlainObject} from '../../utils/llmJson';
import {formatToolCallNarration, formatToolResultNarration, readPrivateToolResultNarrationReceipt} from '../../agentv3/toolNarration';
import {sanitizeCandidateProtocolDiagnostic} from '../canonicalAnalysisResult';
import {projectSceneTimelineForOwner} from '../../agent/scene/sceneTimelineProjection';
import type {SceneTimelineView} from '../../types/sceneTimeline';
import {isClosedCode} from '../../utils/closedCode';

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
  // Carries only the run id and a segment counter.
  answer_segment_reset: 'deterministic',
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
  scene_timeline_updated: 'suppress',
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
  return isClosedCode(fallback) ? fallback : undefined;
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

function privateDegradation(
  language: OutputLanguage,
  sourceType: StreamingUpdate['type'],
  sourceContent?: StreamingUpdate['content'],
): StreamingUpdate['content'] | undefined {
  const degradedFallback = privateDegradedFallback(sourceType, sourceContent);
  const degradedIssueType = privateDegradedIssueType(sourceType, sourceContent);
  if (!degradedFallback && !degradedIssueType) return undefined;
  return {
    phase: sourceType,
    message: localize(
      language,
      '部分分析检查未通过，详细状态将在最终结果中保留。',
      'Some analysis checks did not pass; their status will be retained in the final result.',
    ),
    privateModelTextSuppressed: true,
    sourceEventType: sourceType,
    ...(degradedFallback ? {degradedFallback} : {}),
    ...(degradedIssueType ? {degradedIssueType} : {}),
  };
}

function privateExecutionUpdate(update: StreamingUpdate, language: OutputLanguage): StreamingUpdate | null {
  const content = update.content && typeof update.content === 'object' && !Array.isArray(update.content)
    ? update.content as Record<string, unknown> : {};
  if (update.type === 'progress' && content.phase === 'candidate_protocol') {
    const diagnostic = sanitizeCandidateProtocolDiagnostic(content.candidateProtocolDiagnostic);
    return diagnostic ? {...update, content: {
      phase: 'candidate_protocol', candidateProtocolDiagnostic: diagnostic,
    }} : null;
  }
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  const callNarration = formatToolCallNarration(toolName, undefined, language, {privateContext: true});
  const safeToolName = callNarration ? toolName.trim().replace(/^mcp__smartperfetto__|^smartperfetto__/, '') : undefined;
  if (update.type === 'tool_call' || update.type === 'agent_task_dispatched') {
    return callNarration ? {...update, type: 'tool_call', content: {toolName: safeToolName, message: callNarration}} : null;
  }
  if (update.type === 'agent_response') {
    // Reconstruct from outcome fields; never trust an incoming narration string,
    // private-safe flag, model prose, or a truncated payload as a finding.
    const receipt = readPrivateToolResultNarrationReceipt(content.privateToolResultReceipt, toolName, language);
    const resultNarration = receipt?.message ?? formatToolResultNarration({
      toolName, result: content.result, isError: content.isError === true,
      language, privateContext: true,
    });
    return resultNarration
      ? {...update, content: {...(safeToolName ? {toolName: safeToolName} : {}), resultNarration,
          isError: receipt?.isError ?? content.isError === true}}
      : null;
  }
  if (update.type === 'plan_phase_updated' && content.origin === 'auto') {
    const messages: Record<string, [string, string]> = {
      in_progress: ['开始验证下一个分析阶段', 'Start verifying the next analysis phase'],
      completed: ['当前分析阶段已完成', 'The current analysis phase is complete'],
      pending: ['当前分析阶段仍需补充证据', 'The current analysis phase needs more evidence'],
      skipped: ['已跳过当前分析阶段', 'The current analysis phase was skipped'],
    };
    const status = typeof content.status === 'string' ? content.status : '';
    const message = Object.prototype.hasOwnProperty.call(messages, status) ? messages[status] : undefined;
    return message ? {...update, type: 'progress', content: {message: localize(language, ...message)}} : null;
  }
  const degraded = privateDegradation(language, update.type, update.content);
  return degraded ? {...update, type: 'progress', content: degraded} : null;
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
): StreamingUpdate | null {
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
    return null;
  }
  if (policy === 'answer') {
    return {
      ...update,
      content: {suppressed: true},
    };
  }
  if (policy === 'suppress') {
    return privateExecutionUpdate(update, language);
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
  return null;
}


/**
 * A tool result's transported payload stays out of the process view; the owner
 * reads its outcome narration. Source and knowledge results are projected to
 * hashes before the runtime narrates them, so for those only the private
 * outcome receipt can say what came back.
 */
function ownerToolResultContent(content: StreamingUpdate['content'], language: OutputLanguage): StreamingUpdate['content'] {
  if (!isPlainObject(content)) return content;
  const {result: _payload, privateToolResultReceipt, ...rest} = content;
  const toolName = typeof rest.toolName === 'string' ? rest.toolName : '';
  const resultNarration = typeof rest.resultNarration === 'string' && rest.resultNarration
    ? rest.resultNarration
    : readPrivateToolResultNarrationReceipt(privateToolResultReceipt, toolName, language)?.message;
  return {...rest, ...(resultNarration ? {resultNarration} : {})};
}

/**
 * Authenticated owner process view: the updates a run without private context
 * shows, under the owner guard, with tool results narrated rather than carried.
 */
export function projectOwnerCodeAwareStreamingUpdate(
  sessionId: string,
  update: StreamingUpdate,
  sourceAware: boolean,
  language: OutputLanguage,
): StreamingUpdate | null {
  if (!sourceAware) return update;
  return withOwnerCodeAwareProjection(() => {
    if (update.type === 'scene_timeline_updated') {
      // The shared scene tool emits only a committed, bounded display view. Guard
      // segments separately; a whole-object cap must not silently erase later scenes.
      const value = update.content as SceneTimelineView;
      if (value?.sessionId !== sessionId || !Array.isArray(value.segments) || !Array.isArray(value.unresolved) ||
          !Array.isArray(value.diagnostics)) return null;
      return {...update, content: projectSceneTimelineForOwner(value)};
    }
    if (update.type === 'data') return projectCodeAwareStreamingUpdate(sessionId, update, true, language);
    if (update.type === 'answer_token' && isPlainObject(update.content) && typeof update.content.token === 'string') {
      // A draft token the owner guard had to change is reported structurally
      // (no update), never as a placeholder string in display text.
      const receipt = sanitizeCodeAwareStructuredTextWithReceipt(sessionId, update.content.token);
      if (receipt.disposition !== 'preserved') return null;
      const {token: _token, ...rest} = update.content;
      return {...update, content: {...sanitizeCodeAwareStructuredText(sessionId, rest), token: receipt.text}};
    }
    return {...update, content: sanitizeCodeAwareStructuredText(sessionId,
      update.type === 'agent_response' ? ownerToolResultContent(update.content, language) : update.content)};
  });
}
