// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ResolvedAnalysisInvestigationRequirements} from '../../types/analysisInvestigation';
import type {InvestigationTurnDecisionV1} from './investigationTurnDecision';
import type {InvestigationViewV1} from './investigationView';

// Closed value lists owned by the investigation view; telemetry imports them.
// Each Record must name exactly its source union, so a source change fails to compile.
const CONTRACT_STATUSES: Record<ResolvedAnalysisInvestigationRequirements['status'], true> =
  {resolved: true, not_applicable: true, not_checked: true};
export const INVESTIGATION_CONTRACT_STATUSES =
  Object.keys(CONTRACT_STATUSES) as ReadonlyArray<ResolvedAnalysisInvestigationRequirements['status']>;
export const INVESTIGATION_EVIDENCE_STATUSES = ['read', 'unavailable', 'failed'] as const;
/** Why the native Agent dispatched a provider request; the Pi model-call purposes derive from it. */
export const AGENT_REQUEST_PURPOSES = ['answer_turn', 'continuation'] as const;
/** `progress`: a contract progress message rode this request; see `InvestigationRequestObservationV1.progress`. */
export const INVESTIGATION_DECISIONS = ['no_change', 'progress'] as const;

/**
 * - `observed`: the ledger holds an observed record of a declared metric.
 * - `not_observed`: the requirement declares metrics and none is observed yet.
 * - `unknown_no_producer`: no declared metric, so acquisition is undeterminable.
 * - `not_applicable`: the contract's own evidence condition, evaluated on
 *   producer records, excludes it. Never model prose.
 */
export type InvestigationRequirementStatus = 'observed' | 'not_observed' | 'unknown_no_producer' | 'not_applicable';

export interface InvestigationRequirementCounts {
  observed: number;
  notObserved: number;
  unknownNoProducer: number;
  notApplicable: number;
}

/** The view-derived part of one request receipt: counts and closed values only. */
export interface InvestigationRequestObservationV1 {
  requirements: {contract: ResolvedAnalysisInvestigationRequirements['status']} & InvestigationRequirementCounts;
  evidence: typeof INVESTIGATION_EVIDENCE_STATUSES[number];
  turns: {used: number; limit: number; total: number};
  elapsedMs: number;
  remainingMs: number;
  decision: typeof INVESTIGATION_DECISIONS[number];
  /** Present exactly when `decision` is `progress`: the messages and the requirement ids they named. */
  progress?: {messages: number; requirementIds: string[]};
}

function decisionFacts(decision: InvestigationTurnDecisionV1):
  Pick<InvestigationRequestObservationV1, 'decision' | 'progress'> {
  // A decision kind the receipt cannot name is never recorded as no change.
  if (decision.tools.kind !== 'unchanged' || decision.foldPlan.kind !== 'none' ||
      decision.executionPurpose.kind !== 'unchanged') throw new Error('investigation_decision_unrecordable');
  if (decision.progressMessages.length === 0) return {decision: 'no_change'};
  const requirementIds = decision.progressMessages.flatMap(message =>
    message.requirements.map(requirement => requirement.id));
  return {decision: 'progress', progress: {messages: decision.progressMessages.length, requirementIds}};
}

/** Pure: the receipt facts of one view and the decision derived from it. */
export function projectInvestigationReceipt(view: InvestigationViewV1,
  decision: InvestigationTurnDecisionV1): InvestigationRequestObservationV1 {
  const {budget} = view;
  return {requirements: {contract: view.requirements.contract, ...view.requirements.counts},
    evidence: view.evidence.status,
    turns: {used: budget.providerTurnsUsed, limit: budget.providerTurnLimit, total: budget.totalTurnLimit},
    elapsedMs: Math.round(budget.elapsedMs), remainingMs: Math.round(budget.remainingMs),
    ...decisionFacts(decision)};
}
