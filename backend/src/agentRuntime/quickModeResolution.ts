// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AnalysisOptions,
  QuickRunRequestedMode,
} from '../agent/core/orchestratorTypes';
import type { Finding } from '../agent/types';
import { focusAppTimeRangeFromSelection } from '../agentv3/focusAppDetector';
import { buildComplexityClassifierInput } from '../agentv3/queryComplexityContext';
import {
  classifyQueryComplexityLocal,
  isAcknowledgementFollowupReason,
  queryMentionsProcessListFact,
  queryMentionsTraceIdentityFact,
  TRACE_FACT_LOOKUP_REASON,
  TRACE_IDENTITY_FACT_LOOKUP_REASON,
} from '../agentv3/queryComplexityClassifier';
import type { SceneType } from '../agentv3/sceneClassifier';
import {
  shouldBuildScopedQuickTraceFactEvidence,
  shouldBuildQuickTraceFactEvidence,
  shouldSkipFocusDetectionForQuickTraceFactEvidence,
} from './quickTraceFactEvidence';
import { shouldUseQuickFocusAppDirectAnswer } from './quickFocusAppDirectAnswer';
import { shouldUseQuickScrollingTriageDirectAnswer } from './quickScrollingTriageDirectAnswer';

type PriorTurn = {
  query?: string;
  intent?: { complexity?: string };
  findings?: Finding[];
};

export interface RuntimeQuickModeResolution {
  requestedMode: QuickRunRequestedMode;
  quickMode: boolean;
  localReason?: string;
  quickAcknowledgementDirectAnswer: boolean;
  quickFocusAppPreEvidence: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
  skipFocusDetection: boolean;
  skipTracePreflightDetection: boolean;
}

export interface RuntimeQuickPreEvidenceFlags {
  quickFocusAppPreEvidence: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
  skipFocusDetection: boolean;
  skipTracePreflightDetection: boolean;
}

function buildRuntimeQuickModeResolution(input: {
  requestedMode: QuickRunRequestedMode;
  quickMode: boolean;
  localReason?: string;
  quickAcknowledgementDirectAnswer?: boolean;
  quickFocusAppPreEvidence?: boolean;
  quickProcessIdentityPreEvidence?: boolean;
  quickTraceFactPreEvidence?: boolean;
  quickScrollingTriagePreEvidence?: boolean;
  skipFocusDetection?: boolean;
  skipTracePreflightDetection?: boolean;
}): RuntimeQuickModeResolution {
  const resolution: RuntimeQuickModeResolution = {
    requestedMode: input.requestedMode,
    quickMode: input.quickMode,
    quickAcknowledgementDirectAnswer: input.quickAcknowledgementDirectAnswer ?? false,
    quickFocusAppPreEvidence: input.quickFocusAppPreEvidence ?? false,
    quickProcessIdentityPreEvidence: input.quickProcessIdentityPreEvidence ?? false,
    quickTraceFactPreEvidence: input.quickTraceFactPreEvidence ?? false,
    quickScrollingTriagePreEvidence: input.quickScrollingTriagePreEvidence ?? false,
    skipFocusDetection: input.skipFocusDetection ?? false,
    skipTracePreflightDetection: input.skipTracePreflightDetection ?? false,
  };
  if (input.localReason !== undefined) {
    resolution.localReason = input.localReason;
  }
  return resolution;
}

export function shouldUseRuntimeQuickProcessIdentityPreEvidence(input: {
  query: string;
  selectionContext?: AnalysisOptions['selectionContext'];
  complexity?: string;
  reason?: string;
}): boolean {
  if (input.selectionContext) return false;
  if (queryMentionsProcessListFact(input.query)) return false;
  return Boolean(
    input.complexity === 'quick' &&
    (
      input.reason === TRACE_IDENTITY_FACT_LOOKUP_REASON ||
      queryMentionsTraceIdentityFact(input.query)
    ),
  );
}

export function shouldUseRuntimeQuickTraceFactPreEvidence(input: {
  query: string;
  selectionContext?: AnalysisOptions['selectionContext'];
  complexity?: string;
  reason?: string;
  quickProcessIdentityPreEvidence: boolean;
}): boolean {
  if (input.selectionContext) {
    return Boolean(
      focusAppTimeRangeFromSelection(input.selectionContext) &&
      input.complexity === 'quick' &&
      (
        input.reason === TRACE_FACT_LOOKUP_REASON ||
        input.quickProcessIdentityPreEvidence
      ) &&
      shouldBuildScopedQuickTraceFactEvidence(input.query),
    );
  }
  return Boolean(
    input.complexity === 'quick' &&
    (
      input.reason === TRACE_FACT_LOOKUP_REASON ||
      input.quickProcessIdentityPreEvidence
    ) &&
    shouldBuildQuickTraceFactEvidence(input.query),
  );
}

export function shouldUseRuntimeQuickScrollingTriagePreEvidence(input: {
  query: string;
  selectionContext?: AnalysisOptions['selectionContext'];
  directEvidenceEligibleQuickMode: boolean;
}): boolean {
  return Boolean(
    input.directEvidenceEligibleQuickMode &&
      shouldUseQuickScrollingTriageDirectAnswer({
        query: input.query,
        selectionContext: input.selectionContext,
      }),
  );
}

export function deriveRuntimeQuickPreEvidenceFlags(input: {
  query: string;
  selectionContext?: AnalysisOptions['selectionContext'];
  packageName?: AnalysisOptions['packageName'];
  hasReferenceTrace: boolean;
  directEvidenceEligibleQuickMode: boolean;
  complexity?: string;
  reason?: string;
}): RuntimeQuickPreEvidenceFlags {
  const quickProcessIdentityPreEvidence = input.directEvidenceEligibleQuickMode && shouldUseRuntimeQuickProcessIdentityPreEvidence({
    query: input.query,
    selectionContext: input.selectionContext,
    complexity: input.complexity,
    reason: input.reason,
  });
  const quickFocusAppPreEvidence = Boolean(
    input.directEvidenceEligibleQuickMode &&
      shouldUseQuickFocusAppDirectAnswer({
        query: input.query,
        selectionContext: input.selectionContext,
      }),
  );
  const quickScrollingTriagePreEvidence = shouldUseRuntimeQuickScrollingTriagePreEvidence({
    query: input.query,
    selectionContext: input.selectionContext,
    directEvidenceEligibleQuickMode: input.directEvidenceEligibleQuickMode,
  });
  const quickTraceFactPreEvidence = shouldUseRuntimeQuickTraceFactPreEvidence({
    query: input.query,
    selectionContext: input.selectionContext,
    complexity: input.complexity,
    reason: input.reason,
    quickProcessIdentityPreEvidence,
  });
  const skipTracePreflightDetection = shouldSkipTracePreflightDetection({
    query: input.query,
    selectionContext: input.selectionContext,
    hasReferenceTrace: input.hasReferenceTrace,
    quickTraceFactPreEvidence,
  });
  const skipFocusDetection = shouldSkipFocusDetection({
    packageName: input.packageName,
    hasReferenceTrace: input.hasReferenceTrace,
    selectionContext: input.selectionContext,
    quickFocusAppPreEvidence,
    quickProcessIdentityPreEvidence,
    quickTraceFactPreEvidence,
    quickScrollingTriagePreEvidence,
    skipTracePreflightDetection,
  });

  return {
    quickFocusAppPreEvidence,
    quickProcessIdentityPreEvidence,
    quickTraceFactPreEvidence,
    quickScrollingTriagePreEvidence,
    skipFocusDetection,
    skipTracePreflightDetection,
  };
}

export function resolveRuntimeQuickMode(input: {
  query: string;
  sceneType: SceneType;
  analysisMode?: AnalysisOptions['analysisMode'];
  conversationSurface?: boolean;
  selectionContext?: AnalysisOptions['selectionContext'];
  packageName?: AnalysisOptions['packageName'];
  hasReferenceTrace: boolean;
  previousTurns: PriorTurn[];
}): RuntimeQuickModeResolution {
  const requestedMode = input.analysisMode ?? 'auto';
  if (input.conversationSurface) {
    return buildRuntimeQuickModeResolution({
      requestedMode,
      quickMode: true,
      localReason: 'conversation surface uses on-demand evidence',
      quickAcknowledgementDirectAnswer: false,
      skipFocusDetection: true,
      skipTracePreflightDetection: true,
    });
  }
  if (requestedMode === 'full') {
    return buildRuntimeQuickModeResolution({
      requestedMode,
      quickMode: false,
    });
  }

  const localClassification = classifyQueryComplexityLocal(buildComplexityClassifierInput({
    query: input.query,
    sceneType: input.sceneType,
    selectionContext: input.selectionContext,
    hasReferenceTrace: input.hasReferenceTrace,
    previousTurns: input.previousTurns,
  }));
  const quickAcknowledgementDirectAnswer = Boolean(
    localClassification?.complexity === 'quick' &&
      isAcknowledgementFollowupReason(localClassification.reason),
  );
  const directEvidenceEligibleQuickMode = !input.hasReferenceTrace && (
    requestedMode === 'fast' || localClassification?.complexity === 'quick'
  );
  const flags = deriveRuntimeQuickPreEvidenceFlags({
    query: input.query,
    selectionContext: input.selectionContext,
    packageName: input.packageName,
    hasReferenceTrace: input.hasReferenceTrace,
    directEvidenceEligibleQuickMode,
    complexity: localClassification?.complexity,
    reason: localClassification?.reason,
  });

  if (requestedMode === 'fast') {
    return buildRuntimeQuickModeResolution({
      requestedMode,
      quickMode: true,
      localReason: localClassification?.reason,
      quickAcknowledgementDirectAnswer,
      ...flags,
    });
  }

  if (localClassification?.complexity !== 'quick') {
    return buildRuntimeQuickModeResolution({
      requestedMode,
      quickMode: false,
      localReason: localClassification?.reason,
    });
  }

  return buildRuntimeQuickModeResolution({
    requestedMode,
    quickMode: true,
    localReason: localClassification.reason,
    quickAcknowledgementDirectAnswer,
    ...flags,
  });
}

function shouldSkipTracePreflightDetection(input: {
  query: string;
  selectionContext?: AnalysisOptions['selectionContext'];
  hasReferenceTrace: boolean;
  quickTraceFactPreEvidence: boolean;
}): boolean {
  return !input.hasReferenceTrace
    && input.quickTraceFactPreEvidence
    && shouldSkipFocusDetectionForQuickTraceFactEvidence(input.query);
}

function shouldSkipFocusDetection(input: {
  packageName?: AnalysisOptions['packageName'];
  hasReferenceTrace: boolean;
  selectionContext?: AnalysisOptions['selectionContext'];
  quickFocusAppPreEvidence: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
  skipTracePreflightDetection: boolean;
}): boolean {
  if (input.quickFocusAppPreEvidence) return false;
  if (input.quickProcessIdentityPreEvidence && !input.packageName) return false;
  if (input.skipTracePreflightDetection) return true;
  return Boolean(
    input.packageName
    && !input.hasReferenceTrace
    && !input.selectionContext
    && (
      input.quickProcessIdentityPreEvidence ||
      input.quickTraceFactPreEvidence ||
      input.quickScrollingTriagePreEvidence
    ),
  );
}
