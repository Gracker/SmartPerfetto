// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  outputLanguageDisplayName,
  parseOutputLanguage,
} from '../../agentv3/outputLanguage';
import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {sanitizePublicArtifactData} from '../security/publicArtifactSanitizer';
import type {ExternalIssueOpportunityV1} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';

const TEMPLATE_NAME = 'external-issue-triage';

export function buildExternalIssueTriagePrompt(input: {
  opportunity: ExternalIssueOpportunityV1;
  manifest: RunManifestV1;
}): string {
  const template = loadPromptTemplate(TEMPLATE_NAME);
  if (!template) {
    throw new Error(`${TEMPLATE_NAME} prompt template not found`);
  }
  const eligibleSkills = input.manifest.skills
    .filter(skill =>
      skill.origin === 'built_in' ||
      (skill.origin === 'external_pack' && skill.trustState === 'approved'))
    .map(skill => ({
      skillId: skill.skillId,
      origin: skill.origin,
      ...(skill.trustState ? {trustState: skill.trustState} : {}),
      errorCount: skill.errorCount,
      emptyResultCount: skill.emptyResultCount,
    }));
  const providerSafeSignals = input.opportunity.signals.map(signal => {
    const sanitized = sanitizePublicArtifactData({summary: signal.summary});
    if (!sanitized.ok) {
      throw new Error('External issue triage input failed public-data validation');
    }
    return {...signal, summary: sanitized.value.summary};
  });
  const providerSafeInput = {
    runId: input.opportunity.runId,
    signals: providerSafeSignals,
    eligibleSkills,
  };
  return renderTemplate(template, {
    output_language: outputLanguageDisplayName(
      parseOutputLanguage(input.manifest.outputLanguage),
    ),
    opportunity_json: JSON.stringify(providerSafeInput, null, 2),
  });
}

export const __testing = {TEMPLATE_NAME};
