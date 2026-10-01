// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  NormalizedMetricSource,
  NormalizedMetricValue,
} from '../types/multiTraceComparison';

/**
 * Producer contracts for comparison metrics whose column name is shared by
 * Skills that measure different populations. A contracted metric is taken only
 * from the Skill steps named here, by envelope provenance (top-level skillId +
 * display stepId, plus the child step for an iterator's per-item sections),
 * never from a column name alone.
 */
interface MetricProducerAddress {
  skillId: string;
  stepId: string;
  /** Child step id inside an iterator envelope's `expandableData[i].result.sections`. */
  section?: string;
}

/** Metrics read only through a producer contract; every other standard metric is read by column name. */
export type ContractedMetricKey = 'cpu.big_core_pct';

export interface ComparisonMetricProducerContract {
  metricKey: ContractedMetricKey;
  /** Definition every admitted producer declares on its row. */
  definition: string;
  valueField: string;
  definitionField: string;
  /** Unrounded time on unclassified cores; admission requires exactly 0. */
  unknownTimeField: string;
  /** Number of threads merged into the row; admission requires exactly 1. */
  threadCountField: string;
  producers: readonly MetricProducerAddress[];
}

export const BIG_CORE_PCT_DEFINITION = 'main_thread_running:core_tier_group:prime+big+medium@3';

/**
 * `cpu.big_core_pct`: the big-group (prime+big+medium) share of one main
 * thread's Running time in the analysed window, with no time on unclassified
 * cores. Rollup contract: atomic/cpu_topology_view.skill.yaml.
 */
const BIG_CORE_PCT_CONTRACT: ComparisonMetricProducerContract = {
  metricKey: 'cpu.big_core_pct',
  definition: BIG_CORE_PCT_DEFINITION,
  valueField: 'big_core_pct',
  definitionField: 'big_core_pct_definition',
  unknownTimeField: 'unknown_core_ns',
  threadCountField: 'main_thread_count',
  producers: [
    {skillId: 'startup_detail', stepId: 'cpu_core_analysis'},
    {skillId: 'click_response_detail', stepId: 'cpu_core_analysis'},
    {skillId: 'startup_analysis', stepId: 'analyze_startups', section: 'cpu_core_analysis'},
    {skillId: 'click_response_analysis', stepId: 'analyze_slow_events', section: 'cpu_core_analysis'},
  ],
};

export const COMPARISON_METRIC_PRODUCER_CONTRACTS: readonly ComparisonMetricProducerContract[] = [
  BIG_CORE_PCT_CONTRACT,
];

export function producerContractFor(metricKey: string): ComparisonMetricProducerContract | undefined {
  return COMPARISON_METRIC_PRODUCER_CONTRACTS.find(contract => contract.metricKey === metricKey);
}

export function isAdmittedProducer(
  contract: ComparisonMetricProducerContract,
  address: Partial<MetricProducerAddress>,
): boolean {
  return contract.producers.some(producer =>
    producer.skillId === address.skillId &&
    producer.stepId === address.stepId &&
    producer.section === address.section);
}

type ProducerWithheldReason =
  | 'ambiguous_population'
  | 'definition_mismatch'
  | 'unknown_core_time'
  | 'unknown_core_time_unverified'
  | 'value_unavailable';

type ProducerCandidateDecision =
  | {admitted: true; value: number}
  | {admitted: false; reason: ProducerWithheldReason};

/**
 * Query results reach envelopes as JS numbers. Anything else, a formatted
 * placeholder such as '-' or a numeric string included, fails closed.
 */
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Admission of the rows one admitted producer unit returned. The first such
 * unit decides the metric: a refusal is final, never a cue to read the next.
 */
export function decideProducerCandidate(
  contract: ComparisonMetricProducerContract,
  rows: ReadonlyArray<Record<string, unknown>>,
): ProducerCandidateDecision {
  if (rows.length !== 1) return {admitted: false, reason: 'ambiguous_population'};
  const [row] = rows;
  if (row[contract.definitionField] !== contract.definition) {
    return {admitted: false, reason: 'definition_mismatch'};
  }
  if (finiteNumber(row[contract.threadCountField]) !== 1) {
    return {admitted: false, reason: 'ambiguous_population'};
  }
  const unknownTime = finiteNumber(row[contract.unknownTimeField]);
  if (unknownTime === undefined) return {admitted: false, reason: 'unknown_core_time_unverified'};
  if (unknownTime !== 0) return {admitted: false, reason: 'unknown_core_time'};
  const value = finiteNumber(row[contract.valueField]);
  return value === undefined
    ? {admitted: false, reason: 'value_unavailable'}
    : {admitted: true, value};
}

export const withheldMetricReason = (reason: ProducerWithheldReason): string => `producer_contract:${reason}`;

/** A stored value its producer contract refused: kept for its reason, never a number. */
export function isWithheldMetric(metric: NormalizedMetricValue): boolean {
  return metric.value === null && typeof metric.missingReason === 'string';
}

/**
 * How a stored value of a contracted metric may be compared. Only a value an
 * admitted producer declared under the current definition is comparable;
 * history is classified by its provenance so the comparison can say why it is
 * not.
 */
type ContractedMetricClass =
  | 'current'
  | 'legacy_admitted_producer'
  | 'outside_contract'
  | 'non_skill_source';

export function classifyContractedMetric(
  contract: ComparisonMetricProducerContract,
  source: NormalizedMetricSource,
): ContractedMetricClass {
  if (source.type !== 'skill') return 'non_skill_source';
  if (!isAdmittedProducer(contract, source)) return 'outside_contract';
  return source.metricDefinition === contract.definition ? 'current' : 'legacy_admitted_producer';
}
