// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { loadPromptTemplate, renderTemplate } from '../../agentv3/strategyLoader';
import type { CaseCandidate } from '../../types/caseEvolution';
import {
  executeStructuredReview,
  extractFirstJsonObject,
} from '../evolutionLifecycle/reviewExecution';
import {SCROLLING_V1_REASON_CODES} from '../caseDomainPacks';
import { CASE_EVOLUTION_ALLOWED_RELATION_KINDS } from './caseCandidateReviewValidator';

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TURNS = 8;
const TEMPLATE_NAME = 'case-candidate-review';

const DECISION_ENUM = 'promote | reject | needs_more_evidence';
export type CaseCandidateReviewExecutionResult =
  | {ok: true; review: Record<string, unknown>}
  | {ok: false; reason: 'sdk_timeout' | 'sdk_error' | 'sdk_invalid'; details: string};

export interface CaseCandidateReviewSdkOptions {
  model?: string;
  timeoutMs?: number;
}

export interface BuildCaseCandidateReviewPromptOptions {
  loadTemplate?: (name: string) => string | undefined;
  render?: (template: string, vars: Record<string, string | number | undefined>) => string;
}

export function buildCaseCandidateReviewPrompt(
  candidate: CaseCandidate,
  opts: BuildCaseCandidateReviewPromptOptions = {},
): string {
  const template = (opts.loadTemplate ?? loadPromptTemplate)(TEMPLATE_NAME);
  if (!template) {
    throw new Error(`${TEMPLATE_NAME} prompt template not found`);
  }
  return (opts.render ?? renderTemplate)(template, {
    candidate_json: JSON.stringify(candidate, null, 2),
    allowed_decisions: DECISION_ENUM,
    allowed_reason_codes: SCROLLING_V1_REASON_CODES.join(', '),
    allowed_relation_kinds: CASE_EVOLUTION_ALLOWED_RELATION_KINDS.join(' | '),
  });
}

export async function executeCaseCandidateReviewViaSdk(
  candidate: CaseCandidate,
  opts: CaseCandidateReviewSdkOptions = {},
): Promise<CaseCandidateReviewExecutionResult> {
  let prompt: string;
  try {
    prompt = buildCaseCandidateReviewPrompt(candidate);
  } catch (err) {
    return {ok: false, reason: 'sdk_invalid', details: errorMessage(err)};
  }

  const result = await executeStructuredReview({
    prompt,
    logPrefix: 'CaseCandidateReviewAgentSdk',
    defaultModel: DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTurns: MAX_TURNS,
    model: opts.model,
  });
  return result.ok
    ? {ok: true, review: result.value}
    : result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = {
  extractJsonObject: extractFirstJsonObject,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MODEL,
  MAX_TURNS,
  TEMPLATE_NAME,
};
