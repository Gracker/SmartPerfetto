// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';

export type ConversationTraceContext =
  | {kind: 'none'}
  | {kind: 'attached'; traceId: string};

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Source-derived assistant text stays out of later dormant primary prompts. */
  sourceDerived?: boolean;
}

export interface ConversationEvidenceRef {
  id: string;
  label: string;
  source?: string;
}

export interface FullAnalysisHandoff {
  question: string;
  scope: string;
  assumptions: string[];
  evidence: ConversationEvidenceRef[];
}

interface ConversationOutcomeBase {
  message: string;
  evidence?: ConversationEvidenceRef[];
}

export type ConversationRuntimeOutcome =
  | (ConversationOutcomeBase & {kind: 'answered'})
  | (ConversationOutcomeBase & {
      kind: 'needs_user_input';
      question: string;
    })
  | (ConversationOutcomeBase & {
      kind: 'recommend_full';
      handoff: FullAnalysisHandoff;
    })
  | (ConversationOutcomeBase & {kind: 'cancelled'});

const CONTROL_MARKER_RE =
  /<!--\s*smartperfetto:conversation-control\s+(\{[\s\S]*\})\s*-->\s*$/;

const INTERNAL_TOOL_PROTOCOL_PATTERNS = [
  /DSML[^>]*(?:tools?_calling|tool_calls?|invoke)/i,
  /<\/?(?:tool_calls?|tool_use|function_calls?|invoke)(?:\s|>)/i,
];

export function containsInternalToolProtocol(text: string): boolean {
  return INTERNAL_TOOL_PROTOCOL_PATTERNS.some(pattern => pattern.test(text));
}

function normalizeEvidence(value: unknown): ConversationEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ConversationEvidenceRef[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!id || !label) return [];
    const source = typeof record.source === 'string' ? record.source.trim() : '';
    return [{id, label, ...(source ? {source} : {})}];
  });
}

function selectAuthoritativeEvidence(
  requestedValue: unknown,
  authoritativeEvidence: ConversationEvidenceRef[],
): ConversationEvidenceRef[] {
  const requestedEvidence = normalizeEvidence(requestedValue);
  if (requestedEvidence.length === 0) return authoritativeEvidence;

  const authoritativeById = new Map(
    authoritativeEvidence.map((item) => [item.id, item]),
  );
  const selectedIds = new Set<string>();
  const selectedEvidence = requestedEvidence.flatMap((item) => {
    const authoritative = authoritativeById.get(item.id);
    if (!authoritative || selectedIds.has(item.id)) return [];
    selectedIds.add(item.id);
    return [authoritative];
  });
  return selectedEvidence.length > 0 ? selectedEvidence : authoritativeEvidence;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function parseConversationResponse(
  raw: string,
  fallbackQuestion: string,
  evidence: ConversationEvidenceRef[] = [],
): ConversationRuntimeOutcome {
  const match = raw.match(CONTROL_MARKER_RE);
  if (!match) return {kind: 'answered', message: raw.trim(), evidence};

  const message = raw.slice(0, match.index).trim();
  let control: Record<string, unknown>;
  try {
    control = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return {kind: 'answered', message: raw.trim(), evidence};
  }

  if (control.kind === 'needs_user_input') {
    const question = typeof control.question === 'string'
      ? control.question.trim()
      : '';
    if (question) {
      return {
        kind: 'needs_user_input',
        message: message || question,
        question,
        evidence,
      };
    }
  }

  if (control.kind === 'recommend_full' && control.handoff && typeof control.handoff === 'object') {
    const handoff = control.handoff as Record<string, unknown>;
    const question = typeof handoff.question === 'string' && handoff.question.trim()
      ? handoff.question.trim()
      : fallbackQuestion;
    const scope = typeof handoff.scope === 'string' ? handoff.scope.trim() : '';
    if (scope) {
      return {
        kind: 'recommend_full',
        message,
        evidence,
        handoff: {
          question,
          scope,
          assumptions: normalizeStringArray(handoff.assumptions),
          evidence: selectAuthoritativeEvidence(handoff.evidence, evidence),
        },
      };
    }
  }

  return {kind: 'answered', message, evidence};
}

function formatHistory(history: ConversationMessage[]): string {
  if (history.length === 0) return '（这是本次对话的第一轮。）';
  return history.slice(-12).map((message) => (
    `${message.role === 'user' ? '用户' : '助手'}：${message.content}`
  )).join('\n\n');
}

export function buildConversationPrompt(input: {
  question: string;
  history: ConversationMessage[];
  traceContext: ConversationTraceContext;
}): string {
  const template = loadPromptTemplate('prompt-conversation');
  if (!template) throw new Error('Conversation prompt template is not configured');
  return renderTemplate(template, {
    question: input.question,
    historySection: formatHistory(input.history),
    traceContextNotice: input.traceContext.kind === 'attached'
      ? `当前已附加 Trace（ID: ${input.traceContext.traceId}）。只有来自该 Trace 或本轮工具结果的内容才能表述为 Trace 事实。`
      : '当前没有附加 Trace。可以讨论需求、Android 性能原理、分析方法和已授权源码，但必须明确说明没有 Trace 证据，且不要调用 Trace 工具。',
  });
}
