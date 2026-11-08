// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {resolveAnalysisInvestigationRequirements} from '../analysisInvestigationRequirements';
import type {INVESTIGATION_EVIDENCE_STATUSES, InvestigationRequirementCounts,
  InvestigationRequirementStatus} from './investigationReceipt';
import {assessLedgerAcquisition} from '../../services/finalInvestigationContractGate';
import type {InvestigationEvidenceSnapshot} from '../../services/evidence/investigationEvidenceLedger';
import type {ReadonlyStrategyRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {
  AnalysisInvestigationRequirement,
  ResolvedAnalysisInvestigationRequirements,
} from '../../types/analysisInvestigation';
import type {InvestigationLedgerAcquisitionRow} from '../../types/analysisInvestigationAssessment';

const MAX_VIEW_REQUIREMENTS = 64;

/** What the run could read of its ledger. `unavailable`/`failed` observe nothing, not absence. */
type InvestigationEvidenceRead =
  | {status: 'read'; snapshot: InvestigationEvidenceSnapshot}
  | {status: Exclude<typeof INVESTIGATION_EVIDENCE_STATUSES[number], 'read'>};

interface InvestigationBudgetReading {
  providerTurnsUsed: number;
  providerTurnLimit: number;
  totalTurnLimit: number;
  startedAtMs: number;
  deadlineMs: number;
}

/**
 * A bounded, secret-free projection of one run's investigation state from
 * its existing owners: typed intent, pinned contract, producer ledger and the
 * runtime's turn budget. It owns no evidence and writes nothing.
 */
export interface InvestigationViewV1 {
  schemaVersion: 'investigation_view@1';
  runId: string;
  attempt: number;
  target: Pick<AnalysisTurnIntent, 'status' | 'sceneId' | 'scope' | 'deliverable' | 'evidenceAccess' | 'taskKind'>;
  requirements: {
    contract: ResolvedAnalysisInvestigationRequirements['status'];
    reason?: string;
    items: ReadonlyArray<{id: string; required: boolean; status: InvestigationRequirementStatus}>;
    /** Requirements beyond the view's item bound; their statuses are still counted. */
    omittedCount: number;
    counts: InvestigationRequirementCounts;
  };
  evidence: {status: InvestigationEvidenceRead['status']; recordCount: number; complete: boolean};
  budget: {providerTurnsUsed: number; providerTurnLimit: number; totalTurnLimit: number;
    elapsedMs: number; remainingMs: number};
}

const acquired = (row: InvestigationLedgerAcquisitionRow) => row.status === 'observed' || row.status === 'partial';

/** The finalizer's own acquisition owner decides; this view only names its outcomes. */
function requirementStatuses(requirements: readonly AnalysisInvestigationRequirement[],
  ledger: InvestigationEvidenceSnapshot | undefined): InvestigationRequirementStatus[] {
  const rows = assessLedgerAcquisition(requirements, ledger);
  // Unknown applicability (a semantic condition, or an evidence gate not yet observed)
  // does not hide acquisition: those rows are assessed again, together, without the condition.
  const undecided = ledger ? rows.flatMap((row, index) =>
    row.status === 'unknown' && requirements[index].condition ? [index] : []) : [];
  const unconditioned = new Map(assessLedgerAcquisition(
    undecided.map(index => ({...requirements[index], condition: undefined})), ledger)
    .map((row, position) => [undecided[position], row] as const));
  return rows.map((row, index): InvestigationRequirementStatus => {
    switch (row.status) {
      case 'not_declared': return 'unknown_no_producer';
      case 'not_applicable': return 'not_applicable';
      case 'observed': case 'partial': return 'observed';
      case 'evidence_absent': return 'not_observed';
    }
    const reassessed = unconditioned.get(index);
    return reassessed && acquired(reassessed) ? 'observed' : 'not_observed';
  });
}

/** Pure: identical inputs give an identical view. */
function deriveInvestigationView(input: {
  runId: string;
  attempt: number;
  intent: AnalysisTurnIntent;
  requirements: ResolvedAnalysisInvestigationRequirements;
  evidence: InvestigationEvidenceRead;
  budget: InvestigationBudgetReading;
  nowMs: number;
}): InvestigationViewV1 {
  const {intent, requirements, budget} = input;
  const ledger = input.evidence.status === 'read' ? input.evidence.snapshot : undefined;
  const counts: InvestigationRequirementCounts = {observed: 0, notObserved: 0, unknownNoProducer: 0, notApplicable: 0};
  const key = {observed: 'observed', not_observed: 'notObserved', unknown_no_producer: 'unknownNoProducer',
    not_applicable: 'notApplicable'} as const;
  // Only a resolved contract carries requirements; a not_applicable one says so as a whole.
  const resolved = requirements.status === 'resolved' ? requirements.requirements : [];
  const items: Array<InvestigationViewV1['requirements']['items'][number]> = [];
  requirementStatuses(resolved, ledger).forEach((status, index) => {
    counts[key[status]]++;
    if (items.length < MAX_VIEW_REQUIREMENTS) items.push({id: resolved[index].id, required: resolved[index].required, status});
  });
  return {
    schemaVersion: 'investigation_view@1', runId: input.runId, attempt: input.attempt,
    target: {status: intent.status, sceneId: intent.sceneId, scope: intent.scope, deliverable: intent.deliverable,
      evidenceAccess: intent.evidenceAccess, taskKind: intent.taskKind},
    requirements: {contract: requirements.status, ...(requirements.reason ? {reason: requirements.reason} : {}),
      items, omittedCount: resolved.length - items.length, counts},
    evidence: {status: input.evidence.status, recordCount: ledger?.records.length ?? 0, complete: ledger?.complete ?? false},
    budget: {providerTurnsUsed: budget.providerTurnsUsed, providerTurnLimit: budget.providerTurnLimit,
      totalTurnLimit: budget.totalTurnLimit, elapsedMs: Math.max(0, input.nowMs - budget.startedAtMs),
      remainingMs: Math.max(0, budget.deadlineMs - input.nowMs)},
  };
}

export interface InvestigationViewSource {
  /** The current view; throws when an owner read throws. Its owner (the run's adapter) ends its use. */
  derive(attempt: number): InvestigationViewV1;
}

/**
 * One run's view source. The pinned contract resolves once; the ledger and
 * budget are read on each derive. It holds no state beyond this run.
 */
export function createInvestigationViewSource(input: {
  runId: string;
  intent: AnalysisTurnIntent;
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  readEvidence(): InvestigationEvidenceSnapshot | undefined;
  readBudget(): InvestigationBudgetReading;
  now?: () => number;
}): InvestigationViewSource {
  const requirements = resolveAnalysisInvestigationRequirements({intent: input.intent, strategyRegistry: input.strategyRegistry});
  const now = input.now ?? Date.now;
  return {
    derive(attempt) {
      let evidence: InvestigationEvidenceRead;
      try {
        const snapshot = input.readEvidence();
        evidence = snapshot ? {status: 'read', snapshot} : {status: 'unavailable'};
      } catch {
        evidence = {status: 'failed'};
      }
      return deriveInvestigationView({runId: input.runId, attempt, intent: input.intent, requirements, evidence,
        budget: input.readBudget(), nowMs: now()});
    },
  };
}
