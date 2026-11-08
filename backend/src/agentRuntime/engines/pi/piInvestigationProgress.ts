// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AgentMessage, AgentOptions} from '@earendil-works/pi-agent-core';
import type {Message} from '@earendil-works/pi-ai';
import type {AnalysisTurnIntent} from '../../analysisTurnIntent';
import {resolveAnalysisInvestigationRequirements} from '../../analysisInvestigationRequirements';
import {
  buildInvestigationProgressCatalog,
  investigationAcquisitionStatuses,
  renderInvestigationProgress,
} from '../../investigation/investigationProgress';
import type {InvestigationRequirementStatus} from '../../investigation/investigationReceipt';
import type {InvestigationProgressMessageV1, InvestigationProgressState} from '../../investigation/investigationTurnDecision';
import {requirePromptSegment} from '../../../agentv3/strategyLoader';
import type {InvestigationEvidenceSnapshot} from '../../../services/evidence/investigationEvidenceLedger';
import type {ReadonlyStrategyRegistrySnapshot} from '../../../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {SkillDefinition} from '../../../services/skillEngine/types';
import {parseFlagValue} from '../../../utils/envFlag';

/** Contract progress messages and first-turn acquisition status; off unless set to a true value. */
export const INVESTIGATION_PROGRESS_ENV = 'SMARTPERFETTO_INVESTIGATION_PROGRESS';

export const PI_INVESTIGATION_PROGRESS_ROLE = 'smartperfettoInvestigationProgress';

/**
 * A product contract-status message in the Pi transcript. It is not model
 * output: narration, drafts, closeout and authorship read only `assistant`
 * messages, and the product history never reads the native transcript.
 */
export interface PiInvestigationProgressMessage {
  role: typeof PI_INVESTIGATION_PROGRESS_ROLE;
  progress: InvestigationProgressMessageV1;
  timestamp: number;
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    smartperfettoInvestigationProgress: PiInvestigationProgressMessage;
  }
}

/** One run's contract progress, prepared before its first request. */
export interface PiInvestigationProgressSetup extends Pick<InvestigationProgressState, 'catalog'> {
  /** Per-requirement status for the first request's prompt; absent when the ledger was unread. */
  acquisition?: ReadonlyMap<string, InvestigationRequirementStatus>;
  render(message: InvestigationProgressMessageV1): string;
}

/** Undefined when the feature is off: the run then keeps its exact pre-feature requests. */
export function preparePiInvestigationProgress(input: {
  env: Record<string, string | undefined>;
  intent: AnalysisTurnIntent;
  strategyRegistry: ReadonlyStrategyRegistrySnapshot;
  /** The Skills this run's `invoke_skill` executes. */
  skills: readonly SkillDefinition[];
  invokeSkillExposed: boolean;
  readEvidence(): InvestigationEvidenceSnapshot | undefined;
}): PiInvestigationProgressSetup | undefined {
  if (parseFlagValue(input.env[INVESTIGATION_PROGRESS_ENV]) !== true) return undefined;
  const template = requirePromptSegment('prompt-investigation-progress');
  const requirements = resolveAnalysisInvestigationRequirements({intent: input.intent, strategyRegistry: input.strategyRegistry});
  let ledger: InvestigationEvidenceSnapshot | undefined;
  try { ledger = input.readEvidence(); } catch { ledger = undefined; }
  const acquisition = investigationAcquisitionStatuses(requirements, ledger);
  return {
    catalog: buildInvestigationProgressCatalog({requirements, skills: input.skills, invokeSkillExposed: input.invokeSkillExposed}),
    ...(acquisition ? {acquisition} : {}),
    render: message => renderInvestigationProgress(template, message),
  };
}

export function piInvestigationProgressMessage(progress: InvestigationProgressMessageV1): PiInvestigationProgressMessage {
  return {role: PI_INVESTIGATION_PROGRESS_ROLE, progress, timestamp: Date.now()};
}

const LLM_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'toolResult']);

/**
 * Pi's default conversion drops custom roles. This one keeps every LLM message
 * as is and sends a progress message as a `user` message, never a later
 * `system` message, which would rewrite the cached prompt prefix. It never
 * throws: a message it cannot render is dropped.
 */
export function createPiInvestigationConvertToLlm(
  render: PiInvestigationProgressSetup['render'],
): NonNullable<AgentOptions['convertToLlm']> {
  return (messages: AgentMessage[]): Message[] => messages.flatMap((message): Message[] => {
    if (LLM_ROLES.has(message.role)) return [message as Message];
    if (message.role !== PI_INVESTIGATION_PROGRESS_ROLE) return [];
    try {
      return [{role: 'user', content: [{type: 'text', text: render(message.progress)}], timestamp: message.timestamp}];
    } catch {
      return [];
    }
  });
}
