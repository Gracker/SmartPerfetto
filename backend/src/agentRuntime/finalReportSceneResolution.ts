// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  deriveConclusionSceneAspectsFromSkillIds,
  resolveConclusionScene,
} from '../agent/core/conclusionSceneTemplates';
import {
  expectedCallMatchesRecord,
  type AnalysisPlanV3,
} from '../agentv3/types';
import type { SceneType } from '../agentv3/sceneClassifier';
import { DEEP_REASON_LABEL } from '../utils/analysisNarrative';

export function resolveRuntimeFinalReportSceneType(input: {
  query: string;
  initialSceneType: SceneType;
  plan?: AnalysisPlanV3 | null;
}): SceneType {
  const skillIds = (input.plan?.toolCallLog ?? [])
    .filter(record => (
      expectedCallMatchesRecord({tool: 'invoke_skill'}, record) ||
      expectedCallMatchesRecord({tool: 'compare_skill'}, record)
    ))
    .map(record => record.skillId);
  const evidenceAspects = deriveConclusionSceneAspectsFromSkillIds(skillIds);
  if (evidenceAspects.length === 0) return input.initialSceneType;

  try {
    return resolveConclusionScene({
      intent: {
        primaryGoal: input.query,
        aspects: evidenceAspects,
        expectedOutputType: 'summary',
        complexity: 'simple',
        followUpType: 'initial',
      },
      findings: [],
      deepReasonLabel: DEEP_REASON_LABEL,
    }).selectedTemplate.id;
  } catch {
    return input.initialSceneType;
  }
}
