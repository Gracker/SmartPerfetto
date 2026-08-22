// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { AgentRuntimeAnalysisResult, QuickRunReceipt } from '../agent/core/orchestratorTypes';
import type { ClaimVerificationResult } from '../types/claimVerification';
import type { ClaimSupportV1, EvidenceSupportLevel } from '../types/evidenceContract';
import type { IdentityResolutionV1 } from '../types/identityContract';
import type {CapabilityManifestAttributionV1} from '../types/capabilityManifest';
import {sanitizeStoredCapabilityManifestAttribution} from './capabilityManifest';
import type {
  AnalysisReceipt,
  AnalysisReceiptRuntime,
  AnalysisReceiptV1,
  AnalysisReceiptV2,
  DataEnvelope,
} from '../types/dataContract';
import {
  assessFinalReportContractApplicability,
  assessFinalReportContractCompleteness,
  type FinalReportContractCompletenessInput,
} from './finalReportContractGate';

type AnalysisReceiptMode = AnalysisReceipt['mode'];
type AnalysisReceiptResolvedMode = AnalysisReceipt['resolvedMode'];

export interface AnalysisSessionReceiptSource {
  sessionId: string;
  traceId: string;
  query?: string;
  analysisMode?: AnalysisReceiptMode;
  providerId?: string | null;
  dataEnvelopes?: DataEnvelope[];
  agentResponses?: Array<{ response?: unknown }>;
  conversationSteps?: unknown[];
}

export interface AnalysisReceiptFinalArtifacts {
  reportId?: string;
  reportUrl?: string;
  reportError?: string;
  resultSnapshotId?: string;
  generatedAt?: number;
}

export interface BuildAnalysisReceiptInput {
  runManifestId: string;
  session: AnalysisSessionReceiptSource;
  result: AgentRuntimeAnalysisResult;
  runId?: string;
  qualityArtifacts?: {
    claimSupport?: ClaimSupportV1[];
    claimVerificationResult?: ClaimVerificationResult;
    identityResolutions?: IdentityResolutionV1[];
  };
  quickRun?: QuickRunReceipt;
  finalArtifacts?: AnalysisReceiptFinalArtifacts;
  runtime?: AnalysisReceiptRuntime;
  providerId?: string | null;
  requestedMode?: AnalysisReceiptMode;
  resolvedMode?: AnalysisReceiptResolvedMode;
  sceneType?: FinalReportContractCompletenessInput['sceneType'];
  generatedAt?: number;
  cliTurnPath?: string;
  capabilityManifest?: CapabilityManifestAttributionV1;
}

export function buildAnalysisReceipt(input: BuildAnalysisReceiptInput): AnalysisReceiptV2 {
  const {
    runManifestId,
    ...bodyInput
  } = input;
  return {
    schemaVersion: 2,
    runManifestId,
    ...buildAnalysisReceiptBody(bodyInput),
  };
}

export function buildLegacyAnalysisReceipt(
  input: Omit<BuildAnalysisReceiptInput, 'runManifestId'>,
): AnalysisReceiptV1 {
  return {
    schemaVersion: 1,
    ...buildAnalysisReceiptBody(input),
  };
}

function buildAnalysisReceiptBody(
  input: Omit<BuildAnalysisReceiptInput, 'runManifestId'>,
): Omit<AnalysisReceiptV1, 'schemaVersion'> {
  const session = input.session;
  const result = input.result;
  const quickRun = input.quickRun ?? result.quickRun;
  const qualityArtifacts = input.qualityArtifacts ?? {};
  const claimSupport = qualityArtifacts.claimSupport ?? result.claimSupport ?? [];
  const claimVerificationResult =
    qualityArtifacts.claimVerificationResult ?? result.claimVerificationResult;
  const identityResolutions =
    qualityArtifacts.identityResolutions ?? result.identityResolutions ?? [];
  const finalArtifacts = input.finalArtifacts ?? {};
  const dataEnvelopes = Array.isArray(session.dataEnvelopes) ? session.dataEnvelopes : [];
  const evidenceRefs = collectEvidenceRefs({
    conclusion: result.conclusion,
    dataEnvelopes,
    claimSupport,
    claimVerificationResult,
  });
  const artifactIds = collectArtifactIds({
    claimSupport,
    finalArtifacts,
    agentResponses: session.agentResponses,
  });
  const claimAudit = buildClaimAudit(claimSupport, claimVerificationResult);
  const requestedMode = input.requestedMode ?? session.analysisMode ?? quickRun?.requestedMode ?? 'auto';
  const resolvedMode = input.resolvedMode ?? quickRun?.resolvedMode ?? 'full';
  const capabilityManifest = sanitizeStoredCapabilityManifestAttribution(
    input.capabilityManifest,
  );

  return {
    runId: input.runId || result.sessionId || session.sessionId,
    sessionId: session.sessionId,
    traceId: session.traceId,
    mode: requestedMode,
    resolvedMode,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    providerId: input.providerId !== undefined ? input.providerId : session.providerId ?? null,
    generatedAt: input.generatedAt ?? finalArtifacts.generatedAt ?? Date.now(),
    ...(capabilityManifest ? {capabilityManifest} : {}),
    traceEvidence: {
      sqlCount: countSqlEvidence(dataEnvelopes),
      skillCount: countSkillEvidence(dataEnvelopes),
      dataEnvelopeCount: dataEnvelopes.length,
      artifactCount: artifactIds.size,
      evidenceRefCount: evidenceRefs.size,
    },
    nonEvidenceContext: {
      frontendPrequeryCount: countFrontendPrequery(dataEnvelopes, quickRun),
      memoryHintCount: countMemoryHints(quickRun),
      conversationContextCount: countConversationContext(quickRun, session.conversationSteps),
      strategyHintCount: countStrategyHints(quickRun),
    },
    claimAudit,
    qualityGates: {
      finalReportContract: finalReportGate({
        result,
        session,
        quickRun,
        sceneType: input.sceneType,
      }),
      claimVerification: claimVerificationGate(claimVerificationResult),
      identityResolution: identityResolutionGate(identityResolutions),
    },
    outputs: {
      ...(finalArtifacts.reportId ? { reportId: finalArtifacts.reportId } : {}),
      ...(finalArtifacts.reportUrl ? { reportUrl: finalArtifacts.reportUrl } : {}),
      ...(finalArtifacts.resultSnapshotId ? { resultSnapshotId: finalArtifacts.resultSnapshotId } : {}),
      ...(input.cliTurnPath ? { cliTurnPath: input.cliTurnPath } : {}),
      ...(finalArtifacts.reportError ? { reportError: finalArtifacts.reportError } : {}),
    },
  };
}

function countSqlEvidence(dataEnvelopes: DataEnvelope[]): number {
  return dataEnvelopes.filter((env) => {
    const type = String(env.meta?.type || '');
    const source = String(env.meta?.source || '');
    return type === 'sql_result' || /^execute_sql/.test(source);
  }).length;
}

function countSkillEvidence(dataEnvelopes: DataEnvelope[]): number {
  const ids = new Set<string>();
  for (const env of dataEnvelopes) {
    if (env.meta?.skillId) {
      ids.add(env.meta.skillId);
    } else if (env.meta?.type === 'skill_result' && env.meta?.source) {
      ids.add(env.meta.source);
    }
  }
  return ids.size;
}

function collectEvidenceRefs(input: {
  conclusion?: string;
  dataEnvelopes: DataEnvelope[];
  claimSupport: ClaimSupportV1[];
  claimVerificationResult?: ClaimVerificationResult;
}): Set<string> {
  const refs = new Set<string>();
  for (const env of input.dataEnvelopes) {
    if (env.meta?.evidenceRefId) refs.add(env.meta.evidenceRefId);
    if (env.meta?.sourceToolCallId) refs.add(`tool:${env.meta.sourceToolCallId}`);
  }
  for (const support of input.claimSupport) {
    for (const anchor of support.anchors || []) {
      if (anchor.evidenceRefId) refs.add(anchor.evidenceRefId);
      if (anchor.context?.sourceToolCallId) refs.add(`tool:${anchor.context.sourceToolCallId}`);
    }
  }
  for (const claim of input.claimVerificationResult?.claimResults || []) {
    for (const ref of claim.referenceResults || []) {
      if (ref.evidenceRefId) refs.add(ref.evidenceRefId);
      if (ref.sourceToolCallId) refs.add(`tool:${ref.sourceToolCallId}`);
      if (ref.artifactId) refs.add(`artifact:${ref.artifactId}`);
    }
  }
  for (const ref of String(input.conclusion || '').match(/data:[^\s`),\]]+/g) || []) {
    refs.add(ref);
  }
  return refs;
}

function collectArtifactIds(input: {
  claimSupport: ClaimSupportV1[];
  finalArtifacts: AnalysisReceiptFinalArtifacts;
  agentResponses?: Array<{ response?: unknown }>;
}): Set<string> {
  const ids = new Set<string>();
  if (input.finalArtifacts.reportId) ids.add(`report:${input.finalArtifacts.reportId}`);
  if (input.finalArtifacts.resultSnapshotId) ids.add(`snapshot:${input.finalArtifacts.resultSnapshotId}`);
  for (const support of input.claimSupport) {
    for (const anchor of support.anchors || []) {
      const artifactId = anchor.context?.artifactId || anchor.context?.sourceArtifactId;
      if (artifactId) ids.add(artifactId);
    }
  }
  for (const response of input.agentResponses || []) {
    collectArtifactIdsFromUnknown(response.response, ids);
  }
  return ids;
}

function collectArtifactIdsFromUnknown(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIdsFromUnknown(item, ids);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['artifactId', 'sourceArtifactId', 'artifact_id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) ids.add(candidate.trim());
  }
}

function buildClaimAudit(
  claimSupport: ClaimSupportV1[],
  claimVerificationResult?: ClaimVerificationResult,
): AnalysisReceipt['claimAudit'] {
  if (claimVerificationResult) {
    const claimResults = claimVerificationResult.claimResults || [];
    if (claimResults.length === 0) {
      const totalClaims = claimVerificationResult.checkedClaimCount;
      const unsupportedClaims = claimVerificationResult.unsupportedClaimCount;
      return {
        totalClaims,
        verifiedClaims: Math.max(0, totalClaims - unsupportedClaims),
        unsupportedClaims,
        uncertainClaims: 0,
      };
    }
    return {
      totalClaims: claimResults.length,
      verifiedClaims: claimResults.filter(claim => claim.status === 'verified').length,
      unsupportedClaims: claimVerificationResult.unsupportedClaimCount,
      uncertainClaims: claimResults.filter(claim =>
        claim.status === 'partial' ||
        claim.status === 'inference' ||
        claim.status === 'not_checked').length,
    };
  }
  const byLevel = new Map<EvidenceSupportLevel, number>();
  for (const support of claimSupport) {
    byLevel.set(support.supportLevel, (byLevel.get(support.supportLevel) || 0) + 1);
  }
  return {
    totalClaims: claimSupport.length,
    verifiedClaims: byLevel.get('verified') || 0,
    unsupportedClaims: byLevel.get('unsupported') || 0,
    uncertainClaims: (byLevel.get('partial') || 0) + (byLevel.get('inference') || 0),
  };
}

function countFrontendPrequery(dataEnvelopes: DataEnvelope[], quickRun?: QuickRunReceipt): number {
  const refs = new Set<string>();
  for (const env of dataEnvelopes) {
    const ref = env.meta?.evidenceRefId || '';
    if (ref.startsWith('data:frontend_prequery:')) refs.add(ref);
  }
  return Math.max(refs.size, quickRun?.evidence.frontendPrequeryInjected || 0);
}

function countMemoryHints(quickRun?: QuickRunReceipt): number {
  const context = quickRun?.contextInjected;
  if (!context) return 0;
  return context.patternHints + context.negativePatternHints + context.caseBackgroundCases;
}

function countConversationContext(quickRun?: QuickRunReceipt, conversationSteps?: unknown[]): number {
  const context = quickRun?.contextInjected;
  return (context?.conversationTurns || 0) + (context?.recentSqlResults || 0) +
    (Array.isArray(conversationSteps) ? conversationSteps.length : 0);
}

function countStrategyHints(quickRun?: QuickRunReceipt): number {
  return quickRun?.contextInjected.sqlPitfallPairs || 0;
}

function finalReportGate(input: {
  result: AgentRuntimeAnalysisResult;
  session: AnalysisSessionReceiptSource;
  quickRun?: QuickRunReceipt;
  sceneType?: FinalReportContractCompletenessInput['sceneType'];
}): AnalysisReceipt['qualityGates']['finalReportContract'] {
  if (input.quickRun?.resolvedMode === 'quick') return 'not_applicable';
  const contractInput: FinalReportContractCompletenessInput = {
    conclusion: input.result.conclusion || '',
    query: input.session.query,
    sceneType: input.sceneType,
    contractSceneId: input.result.conclusionContract?.metadata?.sceneId,
    caseRecommendations: input.result.conclusionContract?.caseRecommendations,
  };
  if (!assessFinalReportContractApplicability(contractInput)) return 'not_applicable';
  return assessFinalReportContractCompleteness(contractInput) ? 'partial' : 'passed';
}

function claimVerificationGate(
  result?: ClaimVerificationResult,
): AnalysisReceipt['qualityGates']['claimVerification'] {
  if (!result || result.status === 'not_checked') return 'not_applicable';
  return result.status === 'passed' ? 'passed' : 'partial';
}

function identityResolutionGate(
  identities: IdentityResolutionV1[],
): AnalysisReceipt['qualityGates']['identityResolution'] {
  if (!identities.length) return 'not_applicable';
  return identities.every(identity => identity.status === 'verified' || identity.status === 'not_required')
    ? 'passed'
    : 'partial';
}
