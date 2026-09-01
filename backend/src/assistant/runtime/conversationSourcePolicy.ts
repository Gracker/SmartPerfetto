// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  ConversationEvidenceRef,
  ConversationRuntimeOutcome,
} from '../contracts/conversationContract';
import {
  loadAnalysisSourceActivationPolicy,
  resolveAnalysisSourceActivation,
} from '../../services/codebase/analysisSourceActivationPolicy';

export type PrimaryConversationSourceUse = 'dormant' | 'explicit';

export const CONVERSATION_SOURCE_ENRICHMENT_BUDGET = Object.freeze({
  ...loadAnalysisSourceActivationPolicy().boundedExplicit,
});

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
  return resolveAnalysisSourceActivation({
    query: input.query,
    analysisMode: 'fast',
    hasAuthorizedCodebase: true,
  }) === 'bounded_explicit'
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
