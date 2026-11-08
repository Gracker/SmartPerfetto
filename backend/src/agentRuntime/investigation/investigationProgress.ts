// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {investigationMetricProducers} from '../../services/skillEngine/investigationProducerCatalog';
import {isInvocableSkill} from '../../agentv3/skillRunCore';
import {promptDataEnvelope} from '../../agentv3/strategyLoader';
import type {SkillDefinition} from '../../services/skillEngine/types';
import type {InvestigationEvidenceSnapshot} from '../../services/evidence/investigationEvidenceLedger';
import type {ResolvedAnalysisInvestigationRequirements} from '../../types/analysisInvestigation';
import type {InvestigationRequirementStatus} from './investigationReceipt';
import type {InvestigationProgressMessageV1, InvestigationProgressRequirementV1} from './investigationTurnDecision';
import {investigationRequirementStatuses} from './investigationView';

/** Producers listed per requirement; `list_skills(metricId=...)` pages the rest. */
const MAX_PRODUCERS_PER_REQUIREMENT = 4;

/**
 * Requirements that declare metrics and have at least one registered producer
 * `invoke_skill` can reach in this run: exposed in the request scope, present in
 * the run's pinned registry and not metadata-only. Static admission only; the
 * call itself still checks identity, prerequisites and authorization. Pure.
 */
export function buildInvestigationProgressCatalog(input: {
  requirements: ResolvedAnalysisInvestigationRequirements;
  skills: readonly SkillDefinition[];
  invokeSkillExposed: boolean;
}): ReadonlyMap<string, InvestigationProgressRequirementV1> {
  const catalog = new Map<string, InvestigationProgressRequirementV1>();
  if (!input.invokeSkillExposed || input.requirements.status !== 'resolved') return catalog;
  const producersByMetric = investigationMetricProducers(input.skills.filter(isInvocableSkill));
  for (const requirement of input.requirements.requirements) {
    const metrics = requirement.evidenceMetrics ?? [];
    const producers = [...new Set(metrics.flatMap(metricId => [...producersByMetric.get(metricId) ?? []]))].sort();
    if (!producers.length) continue;
    catalog.set(requirement.id, Object.freeze({id: requirement.id, domain: requirement.domain,
      description: requirement.description,
      ...(requirement.condition ? {condition: requirement.condition.description} : {}),
      evidenceMetrics: Object.freeze([...metrics]),
      producerSkillIds: Object.freeze(producers.slice(0, MAX_PRODUCERS_PER_REQUIREMENT))}));
  }
  return catalog;
}

/**
 * Each requirement's acquisition status from a readable ledger, for the first
 * request's prompt. An unread ledger observes nothing, so it yields no status.
 */
export function investigationAcquisitionStatuses(requirements: ResolvedAnalysisInvestigationRequirements,
  ledger: InvestigationEvidenceSnapshot | undefined): ReadonlyMap<string, InvestigationRequirementStatus> | undefined {
  if (!ledger || requirements.status !== 'resolved') return undefined;
  const statuses = investigationRequirementStatuses(requirements.requirements, ledger);
  return new Map(requirements.requirements.map((requirement, index) => [requirement.id, statuses[index]]));
}

/** The model-facing text of one message: the template, then its bounded data. Byte-stable. */
export function renderInvestigationProgress(template: string, message: InvestigationProgressMessageV1): string {
  return `${template}\n\n${promptDataEnvelope('investigation_progress', message)}`;
}
