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

export interface TimelineProjectionContext {
  comparisonActive?: boolean;
  currentTraceId?: string;
  referenceTraceId?: string;
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
    ? localize(language, '对比 Trace', 'comparison trace')
    : localize(language, '基线 Trace', 'baseline trace');
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
  context: TimelineProjectionContext,
): {traceSide: 'current' | 'reference'; paneSide?: string; label: string; roleLabel: string} | undefined {
  const provenance = envelope.meta?.traceProvenance ?? envelope.traceProvenance;
  let traceSide = normalizeTimelineTraceSide(envelope.meta?.traceSide)
    ?? normalizeTimelineTraceSide(envelope.traceSide)
    ?? normalizeTimelineTraceSide(provenance?.traceSide);
  if (!traceSide) {
    const traceId = envelope.meta?.traceId ?? envelope.traceId ?? provenance?.traceId;
    const current = typeof traceId === 'string' && traceId === context.currentTraceId;
    const reference = typeof traceId === 'string' && traceId === context.referenceTraceId;
    if (current !== reference) traceSide = current ? 'current' : 'reference';
  }
  if (!traceSide) return undefined;

  const paneSide = normalizeTimelinePaneSide(envelope.meta?.paneSide)
    ?? normalizeTimelinePaneSide(envelope.paneSide)
    ?? normalizeTimelinePaneSide(provenance?.paneSide);
  const roleLabel = timelineTraceRoleLabel(traceSide, language);
  return {traceSide, paneSide, label: paneSide ? `${timelinePaneLabel(paneSide, language)}/${roleLabel}` : roleLabel, roleLabel};
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

/**
 * One line for the evidence that just arrived.
 *
 * This used to concatenate eight facts — count, kind, titles, row totals, trace
 * side, plan phase, evidence-ID count, and the producer's reason. Most of those
 * answer the system's questions rather than the reader's. Row totals and
 * evidence-ID counts are bookkeeping; the plan phase is already a boundary line
 * of its own; and the producer's reason repeats the tool dispatch line directly
 * above it.
 *
 * What survives is what a reader uses: what arrived, and the caveats that
 * change how it should be read — which trace it came from when a comparison is
 * running, and any doubt about which phase it belongs to. The full provenance
 * stays in the report and the snapshot, which is where it is actually consulted.
 */
export function summarizeDataEnvelopeForTimeline(
  update: StreamingUpdate,
  language: ReturnType<typeof parseOutputLanguage>,
  context: TimelineProjectionContext = {},
): string {
  const envelopes = (Array.isArray(update.content) ? update.content : [update.content]).filter(
    entry => entry && typeof entry === 'object',
  ) as Array<Record<string, any>>;
  if (envelopes.length === 0) return '';

  const locations = envelopes.map(envelope => timelineTraceLocationLabel(envelope, language, context));
  const showLocations = context.comparisonActive === true
    || new Set(locations.map(location => location?.label).filter(Boolean)).size > 1;
  type SourceGroup = {label: string; titles: string[]};
  const groupTitles = (includePane: boolean) => {
    const groups = new Map<string, SourceGroup>();
    envelopes.forEach((envelope, index) => {
      const title = sanitizeConversationText(envelope.display?.title || envelope.meta?.stepId || envelope.meta?.source);
      if (!title) return;
      // Generated SQL titles only report transport size; the call and empty-result
      // narration already describe execution. Keep the underlying envelope intact.
      if (envelope.meta?.type === 'sql_result' && /^SQL (?:Query(?: Result)?|Summary) \(\d+ rows\)$/.test(title)) return;
      const source = locations[index];
      const label = showLocations
        ? (includePane ? source?.label : source?.roleLabel)
          ?? localize(language, 'Trace 来源未标注', 'unlabelled trace') : '';
      const key = !showLocations ? 'single' : source
        ? `${source.traceSide}:${includePane ? source.paneSide ?? '' : ''}` : 'unknown';
      const group = groups.get(key) ?? {label, titles: []};
      if (!group.titles.includes(title)) group.titles.push(title);
      groups.set(key, group);
    });
    return groups;
  };
  let groups = groupTitles(true);

  const phaseWarnings = [...new Set(envelopes
    .map(envelope => sanitizeConversationText(envelope.meta?.planPhaseWarning, 120)).filter(Boolean))];
  const warning = phaseWarnings.length > 0
    ? localize(language, `阶段归因需核对: ${phaseWarnings[0]}`, `Phase attribution needs review: ${phaseWarnings[0]}`) : '';
  if (groups.size === 0) return warning;

  // The stored timeline has a 240-character ceiling. Allocate title space
  // across sources before truncating, so a long first title cannot hide the
  // other trace. Complete provenance remains on the envelopes themselves.
  const limit = 240;
  const prefix = localize(language, '已获得 ', 'Received ');
  const separator = localize(language, '；', '; ');
  const headerSize = (sourceGroups: Map<string, SourceGroup>) => prefix.length
    + [...sourceGroups.values()].reduce((sum, group) => sum + (group.label ? group.label.length + 2 : 0), 0)
    + Math.max(0, sourceGroups.size - 1) * separator.length;
  // A replay batch can span several historical pane positions. If their
  // labels crowd out the evidence, retain trace roles in this short line;
  // every original pane remains available on its source envelope.
  if (headerSize(groups) + groups.size * 16 > limit) groups = groupTitles(false);
  const entries = [...groups.values()].map(({label, titles}) => ({
    label: label ? `${label}: ` : '',
    title: `${titles.slice(0, 4).join(' / ')}${titles.length > 4 ? ' …' : ''}`,
  }));
  const overhead = headerSize(groups);
  const warningBudget = Math.max(0, limit - overhead - entries.length * 16 - separator.length);
  const warningText = warning ? sanitizeConversationText(warning, warningBudget) : '';
  const titleBudget = Math.max(0, Math.floor((limit - overhead - (warningText ? warningText.length + separator.length : 0)) / entries.length));
  const truncate = (title: string) => title.length <= titleBudget ? title
    : titleBudget > 0 ? `${title.slice(0, Math.max(0, titleBudget - 1)).trimEnd()}…` : '';
  return prefix + entries.map(entry => entry.label + truncate(entry.title)).join(separator)
    + (warningText ? separator + warningText : '');
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
  context: TimelineProjectionContext = {},
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
      text = summarizeDataEnvelopeForTimeline(update, language, context);
      break;
    }
    case 'conclusion':
      phase = 'result';
      role = 'agent';
      // The conclusion event is deliberately withheld from clients until
      // deterministic evidence and claim verification have run — `analysis_completed`
      // is the terminal fact. Announcing "final conclusion generated" here
      // contradicted that, and said it even when the text was a provider error
      // that the run went on to report as incomplete.
      text =
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.message) ||
        localize(language, '结论已生成，正在核验证据', 'Conclusion drafted; verifying evidence');
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
