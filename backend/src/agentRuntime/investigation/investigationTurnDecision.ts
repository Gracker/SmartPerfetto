// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AGENT_REQUEST_PURPOSES} from './investigationReceipt';
import type {InvestigationViewV1} from './investigationView';

/** Contract progress caps: one requirement is named at most once per run. */
const INVESTIGATION_PROGRESS_LIMITS = Object.freeze({
  requirementsPerMessage: 3,
  messagesPerRun: 2,
  /** Turn 1 carries status in its prompt; turn 2 is still the model's own first follow-up. */
  firstRequestIndex: 3,
});

/**
 * One requirement a progress message names: its contract fields and the
 * registered producers `invoke_skill` can reach in this run. Registry
 * metadata only; it carries no evidence value, conclusion or obligation.
 */
export interface InvestigationProgressRequirementV1 {
  id: string;
  domain: string;
  description: string;
  /** The contract's applicability condition as written; it is not evaluated here. */
  condition?: string;
  evidenceMetrics: readonly string[];
  producerSkillIds: readonly string[];
}

/** Contract status for the next request: declared metrics with no observed record yet. */
export interface InvestigationProgressMessageV1 {
  schemaVersion: 'investigation_progress@1';
  requirements: readonly InvestigationProgressRequirementV1[];
}

/**
 * What the product changes about the next provider request. Each field is a
 * closed union so later decisions extend it without moving the adapter or the
 * receipt. Today only contract progress messages can differ from the request
 * the loop built; they are appended to that request and never add one.
 */
export interface InvestigationTurnDecisionV1 {
  schemaVersion: 'investigation_turn_decision@1';
  tools: {kind: 'unchanged'};
  progressMessages: readonly InvestigationProgressMessageV1[];
  foldPlan: {kind: 'none'};
  executionPurpose: {kind: 'unchanged'};
}

/** The decision of a request no product decision changed. */
export const INVESTIGATION_TURN_UNCHANGED: InvestigationTurnDecisionV1 = Object.freeze({
  schemaVersion: 'investigation_turn_decision@1',
  tools: Object.freeze({kind: 'unchanged'}),
  progressMessages: Object.freeze([]),
  foldPlan: Object.freeze({kind: 'none'}),
  executionPurpose: Object.freeze({kind: 'unchanged'}),
} as const);

/** One run's contract progress inputs; absent when the feature is off. */
export interface InvestigationProgressState {
  /** Requirements with at least one producer the run can invoke, by id; built once per run. */
  catalog: ReadonlyMap<string, InvestigationProgressRequirementV1>;
  /** Requirement ids an earlier message of this run already named. */
  named: ReadonlySet<string>;
  messagesSent: number;
}

export interface InvestigationTurnInput {
  view: InvestigationViewV1;
  /** The provider request this decision is for. */
  request: {index: number; purpose: typeof AGENT_REQUEST_PURPOSES[number]};
  progress?: InvestigationProgressState;
}

/** Whether a progress message could ride this request at all: the gates that need no view. */
export function progressGateOpen(request: InvestigationTurnInput['request'], progress: InvestigationProgressState): boolean {
  return progress.catalog.size > 0 && request.purpose === 'answer_turn' &&
    request.index >= INVESTIGATION_PROGRESS_LIMITS.firstRequestIndex &&
    progress.messagesSent < INVESTIGATION_PROGRESS_LIMITS.messagesPerRun;
}

/** Pure: the progress state after a decision's messages were sent. */
export function applyProgress(state: InvestigationProgressState,
  decision: InvestigationTurnDecisionV1): InvestigationProgressState {
  if (!decision.progressMessages.length) return state;
  return {...state, messagesSent: state.messagesSent + decision.progressMessages.length,
    named: new Set([...state.named,
      ...decision.progressMessages.flatMap(message => message.requirements.map(requirement => requirement.id))])};
}

/**
 * Requirements whose declared metrics have no observed record, that a
 * reachable producer could acquire, and that no earlier message named. Only
 * for an answer turn from `firstRequestIndex` on that may acquire new
 * evidence, while an acquisition turn remains after the next request.
 * The ledger must be readable: an unread one observes nothing, not absence.
 */
function progressRequirements({view, request, progress}: InvestigationTurnInput): InvestigationProgressRequirementV1[] {
  if (!progress || !progressGateOpen(request, progress) || view.target.evidenceAccess !== 'read_new' ||
      view.requirements.contract !== 'resolved' || view.evidence.status !== 'read') return [];
  const {providerTurnsUsed: used, providerTurnLimit: limit, remainingMs} = view.budget;
  if (used >= limit || remainingMs <= 0) return [];
  const candidates = view.requirements.items.filter(item =>
    item.status === 'not_observed' && progress.catalog.has(item.id) && !progress.named.has(item.id));
  // Required requirements first, each group in contract order.
  return [...candidates.filter(item => item.required), ...candidates.filter(item => !item.required)]
    .slice(0, INVESTIGATION_PROGRESS_LIMITS.requirementsPerMessage)
    .map(item => progress.catalog.get(item.id)!);
}

/** Pure: identical inputs give an identical decision. The caller applies it with `applyProgress`. */
export function decideInvestigationTurn(input: InvestigationTurnInput): InvestigationTurnDecisionV1 {
  const requirements = progressRequirements(input);
  if (!requirements.length) return INVESTIGATION_TURN_UNCHANGED;
  return Object.freeze({...INVESTIGATION_TURN_UNCHANGED, progressMessages: Object.freeze([Object.freeze({
    schemaVersion: 'investigation_progress@1' as const, requirements: Object.freeze(requirements)})])});
}
