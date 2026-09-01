// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  ConversationEvidenceRef,
  ConversationRuntimeOutcome,
} from '../contracts/conversationContract';

export type PrimaryConversationSourceUse = 'dormant' | 'explicit';

export const CONVERSATION_SOURCE_ENRICHMENT_BUDGET = Object.freeze({
  maxSearchCalls: 1,
  maxReadCalls: 2,
  maxDurationMs: 6_000,
});

const EXPLICIT_SOURCE_INTENT = [
  /(?:源码|代码)(?:文件|路径|位置|实现|调用|逻辑|里|中|级)?/i,
  /(?:哪个|什么|具体)?(?:函数|方法|类)(?:实现|调用|处理|负责|在哪|位置|路径|调用链)?/i,
  /(?:调用链|代码路径|实现在哪|哪一行|定位到代码)/i,
  /\b(?:source\s+(?:code|file)|code\s+path|call\s+(?:graph|chain)|which\s+(?:function|method|class)|where\s+is\s+.+implemented|implementation)\b/i,
  /\b(?:(?:pasted|this|that|the)\s+)?source(?:\s+(?:line|snippet|tree|repository|repo))?\b/i,
  /\b[A-Za-z_$][\w$]*(?:::|#)[A-Za-z_$][\w$]*\b/,
  /\b[a-z][a-z0-9_$]*(?:[A-Z][A-Za-z0-9_$]*){2,}\b/,
];

const NARROW_CODE_ANCHOR = [
  /\b[A-Za-z_$][\w$]*(?:::{1}|#)[A-Za-z_$][\w$]*\b/,
  /\b(?:[a-z_][\w$]*\.)+[A-Z][\w$]*\.[a-z_$][\w$]*\b/,
  /(?:^|[\s`(])[^\s`]+\.(?:kt|kts|java|cc|cpp|cxx|c|h|hpp|hh|swift|m|mm|rs|go|py|ts|tsx|js|jsx|dart):L?\d+(?:-L?\d+)?(?:$|[\s`),])/i,
];

export function resolvePrimaryConversationSourceUse(input: {
  query: string;
  hasAuthorizedCodebase: boolean;
}): PrimaryConversationSourceUse {
  if (!input.hasAuthorizedCodebase) return 'dormant';
  return EXPLICIT_SOURCE_INTENT.some(pattern => pattern.test(input.query))
    ? 'explicit'
    : 'dormant';
}

function evidenceHasNarrowCodeAnchor(evidence: ConversationEvidenceRef[]): boolean {
  return evidence.some(item => NARROW_CODE_ANCHOR.some(pattern => pattern.test(item.label)));
}

export function shouldStartAutomaticSourceEnrichment(input: {
  hasAuthorizedCodebase: boolean;
  traceAttached: boolean;
  primarySourceUse: PrimaryConversationSourceUse;
  outcomeKind: ConversationRuntimeOutcome['kind'];
  evidence?: ConversationEvidenceRef[];
}): boolean {
  return input.hasAuthorizedCodebase &&
    input.traceAttached &&
    input.primarySourceUse === 'dormant' &&
    input.outcomeKind === 'answered' &&
    evidenceHasNarrowCodeAnchor(input.evidence ?? []);
}
