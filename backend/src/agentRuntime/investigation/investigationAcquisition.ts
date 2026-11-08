// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {resolveAnalysisInvestigationRequirements} from '../analysisInvestigationRequirements';
import type {InvestigationEvidenceSnapshot} from '../../services/evidence/investigationEvidenceLedger';
import type {ReadonlyStrategyRegistrySnapshot} from '../../services/selfEvolution/effectiveRuntimeRegistryContext';
import {parseFlagValue} from '../../utils/envFlag';
import type {InvestigationRequirementStatus} from './investigationReceipt';
import {investigationRequirementStatuses} from './investigationView';

/** First-turn requirement acquisition status; on unless set to a false value. */
const INVESTIGATION_ACQUISITION_STATUS_ENV = 'SMARTPERFETTO_INVESTIGATION_ACQUISITION_STATUS';

/**
 * Each requirement's producer-ledger status for the first request's prompt.
 * Undefined when the status is off, the contract is unresolved or the ledger
 * is unreadable: an unread ledger observes nothing, and the prompt then
 * renders the requirements without status. Reads the ledger only when needed.
 */
export function prepareInvestigationAcquisition(input: {
  env: Record<string, string | undefined>;
  intent: AnalysisTurnIntent;
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  readEvidence(): InvestigationEvidenceSnapshot | undefined;
}): ReadonlyMap<string, InvestigationRequirementStatus> | undefined {
  if (parseFlagValue(input.env[INVESTIGATION_ACQUISITION_STATUS_ENV]) === false) return undefined;
  const requirements = resolveAnalysisInvestigationRequirements({intent: input.intent, strategyRegistry: input.strategyRegistry});
  if (requirements.status !== 'resolved') return undefined;
  let ledger: InvestigationEvidenceSnapshot | undefined;
  try { ledger = input.readEvidence(); } catch { return undefined; }
  if (!ledger) return undefined;
  const statuses = investigationRequirementStatuses(requirements.requirements, ledger);
  return new Map(requirements.requirements.map((requirement, index) => [requirement.id, statuses[index]]));
}
