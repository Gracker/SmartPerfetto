// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Analysis-process timeline projection.
 *
 * Turns runtime streaming events into the lines a reader sees while an
 * analysis runs. This lived inside `agentRoutes.ts`, where it had no tests and
 * no other consumer could reach it; the timeline is a product surface in its
 * own right (it also feeds the HTML report through `session.conversationSteps`)
 * so the decision of what each event says belongs in a service.
 *
 * The rule this module enforces: every line is a sentence a person can read.
 * An event that cannot be described that way produces no line at all, rather
 * than a truncated JSON dump.
 */

import { DataEnvelope } from '../../types/dataContract';
import { localize, type parseOutputLanguage } from '../../agentv3/outputLanguage';
import { formatToolCallNarration, looksLikeGenericToolMessage } from '../../agentv3/toolNarration';
import { formatPlanPhaseTransition, readPlanPhaseUpdateOrigin } from '../../agentv3/planPhaseEvents';
import type { StreamingUpdate } from '../../agent/types';

type OutputLanguage = ReturnType<typeof parseOutputLanguage>;

export type TimelineStepPhase = 'progress' | 'thinking' | 'tool' | 'result' | 'error';
export type TimelineStepRole = 'agent' | 'system';

export interface DerivedTimelineStep {
  phase: TimelineStepPhase;
  role: TimelineStepRole;
  text: string;
}

export function sanitizeConversationText(value: unknown, maxLen = 240): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function summarizeTimelineToolCall(content: Record<string, any>): string {
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  if (!toolName) return '';

  const generated = formatToolCallNarration(toolName, content.args);
  const message = sanitizeConversationText(content.message);
  if (!message || looksLikeGenericToolMessage(message)) {
    return generated;
  }

  return message;
}

function normalizeTimelineTraceSide(value: unknown): 'current' | 'reference' | undefined {
  return value === 'current' || value === 'reference' ? value : undefined;
}

function normalizeTimelinePaneSide(value: unknown): 'left' | 'right' | 'top' | 'bottom' | undefined {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom' ? value : undefined;
}

function timelineTraceRoleLabel(
  traceSide: 'current' | 'reference',
  language: ReturnType<typeof parseOutputLanguage>,
): string {
  return traceSide === 'reference'
    ? localize(language, '参考', 'reference')
    : localize(language, '当前', 'current');
}

function timelinePaneLabel(
  paneSide: 'left' | 'right' | 'top' | 'bottom',
  language: ReturnType<typeof parseOutputLanguage>,
): string {
  switch (paneSide) {
    case 'left':
      return localize(language, '左侧', 'left');
    case 'right':
      return localize(language, '右侧', 'right');
    case 'top':
      return localize(language, '上方', 'top');
    case 'bottom':
      return localize(language, '下方', 'bottom');
  }
}

function timelineTraceLocationLabel(
  envelope: Record<string, any>,
  language: ReturnType<typeof parseOutputLanguage>,
): string | undefined {
  const traceSide = normalizeTimelineTraceSide(
    envelope?.meta?.traceSide || envelope?.traceSide || envelope?.traceProvenance?.traceSide,
  );
  if (!traceSide) return undefined;

  const paneSide = normalizeTimelinePaneSide(
    envelope?.meta?.paneSide || envelope?.paneSide || envelope?.traceProvenance?.paneSide,
  );
  const roleLabel = timelineTraceRoleLabel(traceSide, language);
  return paneSide ? `${timelinePaneLabel(paneSide, language)}/${roleLabel}` : roleLabel;
}

/**
 * Timeline text for a completed tool call.
 *
 * `content.result` is deliberately NOT a fallback here. Runtimes put a
 * byte-truncated JSON dump in that field for transport, and rendering it made
 * a third of the timeline unreadable. `resultNarration` is the runtime-neutral
 * human sentence produced by `formatToolResultNarration` while the projected
 * result object was still intact; when it is absent the step carries no
 * information worth a line and the caller drops it.
 */
function summarizeTimelineResult(content: Record<string, any>): string {
  const candidates = [content.summary, content.message, content.resultNarration];

  for (const candidate of candidates) {
    const text = sanitizeConversationText(candidate);
    if (text) return text;
  }
  return '';
}

export function summarizeDataEnvelopeForTimeline(
  update: StreamingUpdate,
  language: ReturnType<typeof parseOutputLanguage>,
): string {
  const envelopes = (Array.isArray(update.content) ? update.content : [update.content]).filter(
    (entry) => entry && typeof entry === 'object',
  ) as Array<Record<string, any>>;
  if (envelopes.length === 0) return '';

  const allTitles = envelopes
    .map((env) => sanitizeConversationText(env?.display?.title || env?.meta?.stepId || env?.meta?.source))
    .filter(Boolean);
  const titles = allTitles.slice(0, 4);
  const omittedTitleCount = Math.max(0, allTitles.length - titles.length);
  const rows = envelopes
    .map((env) => {
      const data = env?.data;
      return Array.isArray(data?.rows) ? data.rows.length : undefined;
    })
    .filter((rowCount): rowCount is number => typeof rowCount === 'number');
  const rowCount = rows.reduce((sum, count) => sum + count, 0);
  const rowText = rows.length > 0
    ? localize(language, `，共 ${rowCount} 行`, `, ${rowCount} rows total`)
    : '';
  const traceLocations = [
    ...new Set(envelopes.map(env => timelineTraceLocationLabel(env, language)).filter((label): label is string => !!label)),
  ];
  const traceText = traceLocations.length > 0
    ? localize(language, `，Trace: ${traceLocations.join('/')}`, `, trace: ${traceLocations.join('/')}`)
    : '';
  const evidenceRefs = envelopes.map((env) => sanitizeConversationText(env?.meta?.evidenceRefId)).filter(Boolean);
  const evidenceText = evidenceRefs.length > 0
    ? localize(language, `，已登记 ${evidenceRefs.length} 个证据 ID`, `, ${evidenceRefs.length} evidence IDs recorded`)
    : '';
  const formats = [
    ...new Set(envelopes.map((env) => sanitizeConversationText(env?.display?.format, 24)).filter(Boolean)),
  ];
  const kindText =
    formats.length === 1
      ? (
          {
            table: localize(language, '数据表', 'tables'),
            summary: localize(language, '摘要数据', 'summaries'),
            metric: localize(language, '指标数据', 'metrics'),
            chart: localize(language, '图表数据', 'charts'),
            text: localize(language, '文本数据', 'text outputs'),
            timeline: localize(language, '时间线数据', 'timelines'),
          } as Record<string, string>
        )[formats[0]] || localize(language, '数据输出', 'data outputs')
      : localize(language, '数据输出', 'data outputs');
  const planPhases = [
    ...new Set(
      envelopes
        .map((env) => sanitizeConversationText(env?.meta?.planPhaseTitle || env?.meta?.planPhaseId, 80))
        .filter(Boolean),
    ),
  ];
  const phaseText = planPhases.length > 0
    ? localize(language, `，阶段: ${planPhases.slice(0, 2).join('/')}`, `, phase: ${planPhases.slice(0, 2).join('/')}`)
    : '';
  const phaseWarnings = [
    ...new Set(envelopes.map((env) => sanitizeConversationText(env?.meta?.planPhaseWarning, 120)).filter(Boolean)),
  ];
  const phaseWarningText = phaseWarnings.length > 0
    ? localize(language, `，阶段归因需核对: ${phaseWarnings.slice(0, 2).join('；')}`, `, phase attribution needs review: ${phaseWarnings.slice(0, 2).join('; ')}`)
    : '';
  const reasons = envelopes
    .map((env) => sanitizeConversationText(env?.meta?.producerReason || env?.meta?.toolNarration, 180))
    .filter(Boolean);
  const uniqueReasons = [...new Set(reasons)].slice(0, 3);
  const omittedReasonCount = Math.max(0, reasons.length - uniqueReasons.length);
  const reasonText =
    uniqueReasons.length > 0
      ? localize(
          language,
          `：${uniqueReasons.join('；')}${omittedReasonCount > 0 ? `；另有 ${omittedReasonCount} 条原因` : ''}`,
          `: ${uniqueReasons.join('; ')}${omittedReasonCount > 0 ? `; ${omittedReasonCount} more reasons` : ''}`,
        )
      : '';
  const titleText =
    titles.length > 0
      ? localize(
          language,
          `：${titles.join(' / ')}${omittedTitleCount > 0 ? ` / 另有 ${omittedTitleCount} 份` : ''}`,
          `: ${titles.join(' / ')}${omittedTitleCount > 0 ? ` / ${omittedTitleCount} more` : ''}`,
        )
      : '';
  const fallbackReason = localize(language, '，用于支撑后续诊断', ', supporting subsequent diagnosis');
  return localize(language, `收到 ${envelopes.length} 份`, `Received ${envelopes.length} `) +
    `${kindText}${titleText}${rowText}${traceText}${phaseText}${phaseWarningText}${evidenceText}${reasonText || fallbackReason}`;
}

/**
 * Decide what one runtime event says in the analysis process view.
 *
 * Returns `null` when the event has nothing a reader would want: either it is
 * not a timeline-worthy event type, or it is one whose text we cannot render
 * honestly. Silence is the correct output there — the previous fallback of
 * printing the raw tool payload made a third of the timeline unreadable.
 */
export function deriveTimelineStep(
  update: StreamingUpdate,
  language: OutputLanguage,
): DerivedTimelineStep | null {
  if (update.type === 'conversation_step') return null;

  const contentRecord =
    update.content && typeof update.content === 'object' && !Array.isArray(update.content)
      ? (update.content as Record<string, any>)
      : {};

  let phase: TimelineStepPhase = 'progress';
  let role: TimelineStepRole = 'agent';
  let text = '';

  switch (update.type) {
    case 'progress':
    case 'degraded':
    case 'stage_transition':
    case 'round_start':
    case 'strategy_decision':
    case 'synthesis_complete':
    case 'hypothesis_generated':
      // Producers mark progress events that only restate the tool call the
      // reader just saw. They still drive progress indicators; they just do
      // not earn their own timeline line.
      if (contentRecord.duplicatesToolCall === true) return null;
      phase = 'progress';
      role = 'system';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.fallback && localize(language, `降级处理: ${contentRecord.fallback}`, `Degraded handling: ${contentRecord.fallback}`)) ||
        sanitizeConversationText(contentRecord.reasoning) ||
        sanitizeConversationText(contentRecord.phase && localize(language, `阶段: ${contentRecord.phase}`, `Phase: ${contentRecord.phase}`));
      if (!text && update.type === 'hypothesis_generated' && Array.isArray(contentRecord.hypotheses)) {
        text = localize(language, `形成 ${contentRecord.hypotheses.length} 个待验证假设`, `Formed ${contentRecord.hypotheses.length} hypotheses to verify`);
      }
      break;
    case 'thought':
    case 'worker_thought':
      phase = 'thinking';
      role = update.type === 'worker_thought' ? 'system' : 'agent';
      text =
        sanitizeConversationText(contentRecord.thought) ||
        sanitizeConversationText(contentRecord.content) ||
        sanitizeConversationText(contentRecord.message);
      break;
    case 'tool_call':
    case 'agent_task_dispatched':
    case 'agent_dialogue':
      phase = 'tool';
      role = 'agent';
      text =
        summarizeTimelineToolCall(contentRecord) ||
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.taskTitle) ||
        sanitizeConversationText(contentRecord.toolName);
      break;
    case 'plan_phase_updated': {
      // Automatic transitions are the runtime's own inference about plan
      // progress and appear nowhere else in the stream. Model-driven ones are
      // already narrated by the `update_plan_phase` dispatch line, so taking
      // both would print every transition twice.
      if (readPlanPhaseUpdateOrigin(contentRecord.origin) !== 'auto') return null;
      const phaseId = sanitizeConversationText(contentRecord.phaseId, 64);
      if (!phaseId) return null;
      phase = 'progress';
      role = 'agent';
      text = formatPlanPhaseTransition(
        {
          phaseId,
          phaseName: sanitizeConversationText(contentRecord.phaseName, 80),
          status: sanitizeConversationText(contentRecord.status, 32),
          summary: sanitizeConversationText(contentRecord.summary),
        },
        language,
      );
      break;
    }
    case 'agent_response':
    case 'finding':
      // A failed tool call is not an ordinary result: keep it visible as an
      // error so the timeline shows what did not work, not only what did.
      phase = update.type === 'agent_response' && contentRecord.isError === true ? 'error' : 'result';
      role = 'agent';
      if (update.type === 'finding' && Array.isArray(contentRecord.findings)) {
        const firstFinding = contentRecord.findings.find((entry) => entry && typeof entry === 'object') as
          Record<string, any> | undefined;
        const firstTitle = sanitizeConversationText(firstFinding?.title || firstFinding?.description);
        text = firstTitle
          ? localize(
              language,
              `新增发现 ${contentRecord.findings.length} 条: ${firstTitle}`,
              `${contentRecord.findings.length} new findings: ${firstTitle}`,
            )
          : localize(
              language,
              `新增发现 ${contentRecord.findings.length} 条`,
              `${contentRecord.findings.length} new findings`,
            );
      } else {
        // No `工具调用完成 (#abc123)` fallback: an opaque task id tells the
        // reader nothing, and the dispatch line already named the call.
        text = summarizeTimelineResult(contentRecord);
      }
      break;
    case 'data': {
      phase = 'result';
      role = 'system';
      text = summarizeDataEnvelopeForTimeline(update, language);
      break;
    }
    case 'conclusion':
      phase = 'result';
      role = 'agent';
      text =
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.message) ||
        localize(language, '最终结论已生成', 'Final conclusion generated');
      break;
    case 'answer_token':
      if (contentRecord.done === true) {
        phase = 'result';
        role = 'agent';
        text = localize(language, '最终回答生成完成', 'Final answer generation completed');
      }
      break;
    case 'error':
      phase = 'error';
      role = 'system';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.error) ||
        localize(language, '分析过程中发生错误', 'An error occurred during analysis');
      break;
    default:
      return null;
  }

  if (!text) return null;

  return {phase, role, text};
}
