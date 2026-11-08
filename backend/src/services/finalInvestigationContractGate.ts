// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisInvestigationCondition, AnalysisInvestigationRequirement} from '../types/analysisInvestigation';
import type {InvestigationLedgerAcquisitionRow} from '../types/analysisInvestigationAssessment';
import type {InvestigationEvidenceSnapshot} from './evidence/investigationEvidenceLedger';

/**
 * Resolve an `evidence` condition against the producer-bound ledger.
 *
 * Only `observed` records count: a `partial` or `unknown` capture cannot
 * establish that the mechanism is in play. Any qualifying record activates the
 * obligation, because the question is whether the mechanism appears at all,
 * not how often. An absent metric returns `null` — unknown, never "not in
 * play" — so a scene that never emitted the metric does not read as cleared.
 */
/** @internal Exported for its own unit tests; production reads it through the ledger applicability below. */
export function evaluateEvidenceCondition(
  condition: Extract<AnalysisInvestigationCondition, {kind: 'evidence'}>,
  ledger: InvestigationEvidenceSnapshot | undefined,
): {met: boolean | null; observed: number | null} {
  if (!ledger) return {met: null, observed: null};
  const values = ledger.records
    .filter(record => record.metricId === condition.metricId && record.status === 'observed')
    .map(record => (typeof record.value === 'number' ? record.value : Number(record.value)))
    .filter(value => Number.isFinite(value));
  if (!values.length) return {met: null, observed: null};
  const holds = (value: number): boolean => condition.operator === 'gt' ? value > condition.value
    : condition.operator === 'gte' ? value >= condition.value
    : condition.operator === 'lt' ? value < condition.value
    : value <= condition.value;
  const hit = values.find(holds);
  return {met: hit !== undefined, observed: hit ?? values[0]};
}

/** Requirement applicability decided from the ledger alone. */
function ledgerApplicability(requirement: AnalysisInvestigationRequirement,
  ledger: InvestigationEvidenceSnapshot | undefined): {applicability: 'applicable' | 'not_applicable' | 'unknown';
    condition?: InvestigationLedgerAcquisitionRow['condition']} {
  const condition = requirement.condition;
  if (!condition) return {applicability: 'applicable'};
  if (condition.kind !== 'evidence') return {applicability: 'unknown'};
  const {met, observed} = evaluateEvidenceCondition(condition, ledger);
  return {
    applicability: met === null ? 'unknown' : met ? 'applicable' : 'not_applicable',
    condition: {metricId: condition.metricId, operator: condition.operator, value: condition.value, observed, met},
  };
}

/**
 * Acquisition coverage read straight from the ledger.
 *
 * This deliberately answers one narrow question — did the run acquire the
 * evidence this requirement declares — and never whether the answer
 * interprets it correctly. It is a record-only display; the answer's
 * investigation coverage is not assessed.
 */
export function assessLedgerAcquisition(
  requirements: readonly AnalysisInvestigationRequirement[],
  ledger: InvestigationEvidenceSnapshot | undefined,
): readonly InvestigationLedgerAcquisitionRow[] {
  return requirements.map(requirement => {
    const {applicability, condition} = ledgerApplicability(requirement, ledger);
    const declaredMetrics = [...(requirement.evidenceMetrics ?? [])];
    const base = {requirementId: requirement.id, domain: requirement.domain, applicability,
      declaredMetrics, ...(condition ? {condition} : {})};
    if (!declaredMetrics.length) return {...base, status: 'not_declared' as const, observedMetrics: []};
    if (applicability !== 'applicable') {
      return {...base, status: applicability === 'unknown' ? 'unknown' as const : 'not_applicable' as const,
        observedMetrics: []};
    }
    if (!ledger) return {...base, status: 'unknown' as const, observedMetrics: []};
    const observedMetrics = declaredMetrics.filter(metric =>
      ledger.records.some(record => record.metricId === metric && record.status === 'observed'));
    const truncated = ledger.issues.includes('ledger_metric_budget_exhausted')
      || ledger.issues.includes('ledger_record_budget_exhausted');
    const status = !observedMetrics.length ? 'evidence_absent' as const
      : observedMetrics.length < declaredMetrics.length || truncated ? 'partial' as const
      : 'observed' as const;
    return {...base, status, observedMetrics};
  });
}
